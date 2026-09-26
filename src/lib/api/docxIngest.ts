/**
 * Server-side .docx ingester for the Word-upload pipeline.
 *
 * The job:
 *   1) Crack open the .docx zip with jszip.
 *   2) Walk word/document.xml, splitting paragraphs into "questions" wherever
 *      a paragraph starts with "1.", "2.", "3." …  (regex-first; if too few
 *      boundaries are found we ask the AI to identify them).
 *   3) For each question, gather every <w:p> XML chunk *verbatim* (we don't
 *      round-trip through an AST so equations, images and runs are byte-exact).
 *   4) Collect every relationship referenced by those paragraphs and upload
 *      the corresponding binary from word/media/ or word/embeddings/ to the
 *      docx-media Supabase Storage bucket. Deduplicated by SHA-256 inside the
 *      extraction so two paragraphs that reference the same image only upload
 *      it once.
 *   5) Extract a short plain-text snippet of the question for AI metadata
 *      tagging and for the questions-list preview column.
 *
 * The output is a list of objects matching DocxExtractedQuestion, which the
 * extraction-report save path can then commit into qbg_questions, copying the
 * `source_docx` blob into the new column.
 *
 * Browser rendering is intentionally NOT a goal — the OOXML lives on so it can
 * be stitched into output .docx test papers later.
 */
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import crypto from "node:crypto";
import type {
    DocxExtractedQuestion,
    DocxMediaRef,
    AIModelProvider,
} from "@/types/extraction";
import {
    detectDocxStructure,
    type DocxStructureBoundary,
    type ParagraphSnippet,
} from "./aiAdapters";

// Loose Supabase client type — both @supabase/supabase-js and @supabase/ssr
// satisfy the surface we use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

const STORAGE_BUCKET = "docx-media";
const DOCUMENT_XML = "word/document.xml";
const RELS_XML = "word/_rels/document.xml.rels";

/** Plain-text snippet length kept for the list preview + AI input. */
const SNIPPET_CHARS = 600;

/** Mime types we recognise on the relationship target. */
const MIME_BY_EXT: Record<string, string> = {
    wmf: "image/x-wmf",
    emf: "image/x-emf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bin: "application/vnd.openxmlformats-officedocument.oleObject",
};

export interface IngestParseResult {
    questions: DocxExtractedQuestion[];
    warnings: string[];
    /** Path inside the zip → storage_path. Useful for stitching solutions. */
    mediaUploadedCount: number;
    paragraphCount: number;
}

interface ParsedQuestion {
    qNumber: number;
    paragraphsXml: string[];
    referencedRIds: Set<string>;
    plainText: string;
    /** Subject inferred from the preceding section heading OR returned by the AI. */
    sectionSubject: string | null;
    /** Per-question metadata returned by the AI structure detector. Empty when
     *  detection fell back to regex; the downstream metadata tagger will fill
     *  these in. */
    aiMetadata?: {
        chapter?: string;
        topic?: string;
        subtopic?: string;
        questionType?: string;
        difficultyLevel?: string;
        classLevel?: string;
        exam?: string[];
        confidence?: number;
    };
}

/** Subject keywords, with longest first so MATHEMATICS wins over MATHS. */
const SECTION_SUBJECTS: Array<{ re: RegExp; subject: string }> = [
    { re: /\bMATHEMATICS\b/i, subject: "Maths" },
    { re: /\bCHEMISTRY\b/i,   subject: "Chemistry" },
    { re: /\bPHYSICS\b/i,     subject: "Physics" },
    { re: /\bBIOLOGY\b/i,     subject: "Biology" },
    { re: /\bBOTANY\b/i,      subject: "Botany" },
    { re: /\bZOOLOGY\b/i,     subject: "Zoology" },
    { re: /\bMATHS\b/i,       subject: "Maths" },
];

/** "SECTION-I (PHYSICS)", "Section II : Chemistry", etc. — the real banners
 *  that mark the start of each subject's question block in AITS-style papers.
 *  We prefer these over lone subject keywords because the document typically
 *  also lists subjects in a syllabus/TOC at the top, which would otherwise
 *  trigger false section switches. */
const SECTION_BANNER_RE = /\bSECTION\b/i;
function detectSectionBanner(plain: string): string | null {
    if (plain.length > 60) return null;
    if (!SECTION_BANNER_RE.test(plain)) return null;
    for (const { re, subject } of SECTION_SUBJECTS) {
        if (re.test(plain)) return subject;
    }
    return null;
}

/**
 * Top-level entry point. Pass a Buffer containing the .docx, an extraction id
 * (used to namespace media in Storage), an optional solutions Buffer, and a
 * Supabase client (cookie-aware, so Storage uploads can be RLS-scoped). The
 * returned questions still have empty metadata fields — caller runs the AI
 * tagger to fill them in.
 */
export async function ingestDocx(
    questionsBuffer: Buffer,
    extractionId: string,
    options: {
        solutionsBuffer?: Buffer | null;
        originalFileName: string;
        solutionsFileName?: string | null;
        supabase: SupabaseLike;
        /** When provided, the ingester asks the AI to identify question
         *  boundaries (skipping instructions / headers / footers) AND tag
         *  metadata in one call, instead of using brittle regex markers.
         *  If the AI call fails or returns nothing, we fall back to the
         *  regex-based splitter. */
        ai?: {
            provider: AIModelProvider;
            apiKey: string;
            modelId: string;
        };
    }
): Promise<IngestParseResult> {
    const warnings: string[] = [];

    // ── 1) Parse the questions docx ──────────────────────────────────────
    const qParsed = await parseDocxSource(questionsBuffer);
    const questions = await detectQuestions(
        qParsed,
        "questions",
        options.originalFileName,
        options.ai,
        warnings
    );
    if (questions.length < 3 && qParsed.paragraphSpans.length > 0) {
        warnings.push(
            `Only ${questions.length} questions detected — review the file or try a different AI provider.`
        );
    }
    // Quick gap audit so the user knows if any questions were missed.
    const numsBySection = new Map<string, number[]>();
    for (const q of questions) {
        const key = q.sectionSubject ?? "(no section)";
        const arr = numsBySection.get(key) ?? [];
        arr.push(q.qNumber);
        numsBySection.set(key, arr);
    }
    for (const [sec, nums] of numsBySection) {
        if (nums.length < 2) continue;
        const sorted = [...nums].sort((a, b) => a - b);
        const min = sorted[0], max = sorted[sorted.length - 1];
        const missing: number[] = [];
        for (let n = min; n <= max; n++) {
            if (!sorted.includes(n)) missing.push(n);
        }
        if (missing.length > 0) {
            warnings.push(`${sec}: missing question number(s) ${missing.join(", ")} — check the source file for formatting quirks.`);
        }
    }

    // ── 2) Parse solutions if given ───────────────────────────────────────
    // Match by (section_subject, qNumber). A solutions file with sections
    // Physics 1-25 and Chemistry 1-25 has two "Q1"s, so plain number-keying
    // would collapse them.
    let solutionsByKey: Map<string, ParsedQuestion> | null = null;
    let sParsed: ParsedDocxSource | null = null;
    if (options.solutionsBuffer) {
        sParsed = await parseDocxSource(options.solutionsBuffer);
        const sols = await detectQuestions(
            sParsed,
            "solutions",
            options.solutionsFileName || "Solutions.docx",
            options.ai,
            warnings
        );
        solutionsByKey = new Map(sols.map((s) => [`${s.sectionSubject ?? ""}|${s.qNumber}`, s]));
        if (sols.length > 0 && sols.length < questions.length) {
            warnings.push(
                `Solutions file produced ${sols.length} entries vs ${questions.length} questions — some may not have matched solutions.`
            );
        }
    }

    // ── 3) Upload all referenced media in one pass per docx ─────────────
    const qMediaMap = await uploadReferencedMedia({
        relsXml: qParsed.relsXml,
        zip: qParsed.zip,
        rIdsByQuestion: questions.map((q) => q.referencedRIds),
        supabase: options.supabase,
        extractionId,
        scope: "questions",
        warnings,
    });
    const sMediaMap = sParsed
        ? await uploadReferencedMedia({
              relsXml: sParsed.relsXml,
              zip: sParsed.zip,
              rIdsByQuestion: (solutionsByKey ? Array.from(solutionsByKey.values()) : []).map((s) => s.referencedRIds),
              supabase: options.supabase,
              extractionId,
              scope: "solutions",
              warnings,
          })
        : null;

    // ── 4) Assemble the output list ───────────────────────────────────────
    // Index questions globally so two sections that both restart at "1." don't
    // collide. The original (intra-section) number is preserved in
    // source_docx.original_q_number; questionNumber becomes the global index.
    const out: DocxExtractedQuestion[] = questions.map((q, globalIdx) => {
        const solution = solutionsByKey?.get(`${q.sectionSubject ?? ""}|${q.qNumber}`);
        const mediaRefs = collectMediaRefs(q.referencedRIds, qMediaMap);
        const solutionMediaRefs = solution
            ? collectMediaRefs(solution.referencedRIds, sMediaMap ?? new Map())
            : null;

        const meta = q.aiMetadata;
        return {
            questionNumber: globalIdx + 1,
            questionText: q.plainText.slice(0, SNIPPET_CHARS),
            questionLanguage: "English",
            options: [],
            answerKey: null,
            solutionText: solution ? solution.plainText.slice(0, SNIPPET_CHARS) : "",
            solutionLanguage: "English",
            // When the AI structure detector ran, metadata is already tagged.
            // Otherwise these fields get filled by the legacy metadata tagger
            // call inside /api/upload/extract-docx.
            questionType:
                (meta?.questionType || "Single_Choice(SCQ)") as DocxExtractedQuestion["questionType"],
            subject: q.sectionSubject ?? "",
            chapter: meta?.chapter ?? "",
            topic: meta?.topic ?? "",
            subtopic: meta?.subtopic ?? "",
            difficultyLevel:
                (meta?.difficultyLevel || "Medium") as DocxExtractedQuestion["difficultyLevel"],
            classLevel: meta?.classLevel ?? "",
            exam: meta?.exam ?? [],
            diagrams: [],
            confidence: meta?.confidence ?? 1,
            aiNotes: q.sectionSubject ? `section: ${q.sectionSubject}` : "",
            source_docx: {
                ooxml_paragraphs: q.paragraphsXml,
                media_refs: mediaRefs,
                original_q_number: q.qNumber,
                original_file_name: options.originalFileName,
                solution_ooxml_paragraphs: solution ? solution.paragraphsXml : null,
                solution_media_refs: solutionMediaRefs,
            },
        };
    });

    return {
        questions: out,
        warnings,
        mediaUploadedCount: qMediaMap.size + (sMediaMap ? sMediaMap.size : 0),
        paragraphCount: qParsed.paragraphSpans.length,
    };
}

// =====================================================================
//  Parsing helpers
// =====================================================================

interface ParsedDocxSource {
    zip: JSZip;
    documentXml: string;
    relsXml: string;
    /** [startIndex, endIndex) byte offsets into documentXml for each <w:p>. */
    paragraphSpans: Array<{ start: number; end: number; xml: string; plain: string }>;
}

async function parseDocxSource(buffer: Buffer): Promise<ParsedDocxSource> {
    const zip = await JSZip.loadAsync(buffer);
    const docFile = zip.file(DOCUMENT_XML);
    if (!docFile) throw new Error(`Word file is missing ${DOCUMENT_XML}.`);
    const documentXml = await docFile.async("string");
    const relsFile = zip.file(RELS_XML);
    const relsXml = relsFile ? await relsFile.async("string") : "";

    const paragraphSpans = locateParagraphSpans(documentXml);
    return { zip, documentXml, relsXml, paragraphSpans };
}

/** Find every top-level `<w:p ...>…</w:p>` in document order.
 *
 *  Critical: paragraphs can be nested when a `<w:txbxContent>` (textbox body)
 *  contains its own `<w:p>` elements. A naive `indexOf('</w:p>')` would close
 *  the outer paragraph at the inner `</w:p>`, producing malformed XML — and
 *  Word for Mac crashes on the result. We track depth so we only stop at the
 *  matching outer close tag.
 */
function locateParagraphSpans(xml: string): ParsedDocxSource["paragraphSpans"] {
    const out: ParsedDocxSource["paragraphSpans"] = [];
    let i = 0;
    while (i < xml.length) {
        const open = xml.indexOf("<w:p", i);
        if (open < 0) break;

        const openTagEnd = xml.indexOf(">", open);
        if (openTagEnd < 0) break;

        // Self-closing? skip.
        if (xml[openTagEnd - 1] === "/") {
            i = openTagEnd + 1;
            continue;
        }
        // Only true paragraph opens — guard against <w:pPr or <w:pStyle etc.
        const openTag = xml.slice(open, openTagEnd + 1);
        if (!/^<w:p[\s>/]/.test(openTag)) {
            i = openTagEnd + 1;
            continue;
        }

        // Depth-balanced scan for the matching </w:p>.
        const end = findMatchingParagraphClose(xml, openTagEnd + 1);
        if (end < 0) break;
        const chunk = xml.slice(open, end);
        out.push({ start: open, end, xml: chunk, plain: extractPlainText(chunk) });
        i = end;
    }
    return out;
}

/** Starting just after a `<w:p ...>` open tag, find the offset just past the
 *  matching `</w:p>` close, accounting for nested `<w:p>` paragraphs that
 *  live inside `<w:txbxContent>` (text-box bodies), `<w:tbl>` cells with
 *  paragraphs, and the like. Returns -1 if unbalanced.
 */
function findMatchingParagraphClose(xml: string, fromOffset: number): number {
    let depth = 1;
    let i = fromOffset;
    const closeLen = "</w:p>".length;
    while (i < xml.length) {
        const nextOpen = xml.indexOf("<w:p", i);
        const nextClose = xml.indexOf("</w:p>", i);
        if (nextClose < 0) return -1;
        // Verify nextOpen is a real <w:p> (not <w:pPr/<w:pStyle/<w:pgSz etc.)
        // and consider it only if it precedes nextClose.
        let realOpenAt = -1;
        if (nextOpen >= 0 && nextOpen < nextClose) {
            const tagEnd = xml.indexOf(">", nextOpen);
            if (tagEnd >= 0) {
                const tag = xml.slice(nextOpen, tagEnd + 1);
                const isSelfClose = xml[tagEnd - 1] === "/";
                if (!isSelfClose && /^<w:p[\s>/]/.test(tag)) {
                    realOpenAt = tagEnd + 1;
                }
            }
        }
        if (realOpenAt > 0) {
            depth++;
            i = realOpenAt;
        } else {
            depth--;
            if (depth === 0) return nextClose + closeLen;
            i = nextClose + closeLen;
        }
    }
    return -1;
}

/** Extract the visible text of a paragraph by concatenating <w:t> content,
 *  decoding XML entities. Used both for the snippet and for the boundary
 *  regex. */
function extractPlainText(paragraphXml: string): string {
    let out = "";
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(paragraphXml)) !== null) {
        out += decodeEntities(m[1]);
    }
    // Collapse internal whitespace.
    return out.replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

/**
 * Pick question boundaries — AI-driven when an API key is available,
 * regex-based otherwise. The AI gets a list of short paragraph snippets
 * (not the OOXML) and returns the index range of each real question + its
 * metadata; we then slice the original paragraph spans verbatim so equations
 * and diagrams are preserved byte-exact.
 */
async function detectQuestions(
    parsed: ParsedDocxSource,
    kind: "questions" | "solutions",
    sourceName: string,
    ai: { provider: AIModelProvider; apiKey: string; modelId: string } | undefined,
    warnings: string[]
): Promise<ParsedQuestion[]> {
    if (!ai) {
        return splitIntoQuestions(parsed.documentXml, parsed.paragraphSpans);
    }
    try {
        // Truncate each snippet to ~220 chars so the prompt stays tractable.
        const snippets: ParagraphSnippet[] = parsed.paragraphSpans.map((sp, idx) => ({
            idx,
            text: sp.plain.length > 220 ? sp.plain.slice(0, 217) + "…" : sp.plain,
        }));
        const ai_result = await detectDocxStructure(ai.provider, {
            snippets,
            kind,
            sourceName,
            apiKey: ai.apiKey,
            modelId: ai.modelId,
        });
        for (const w of ai_result.warnings) warnings.push(`AI(${kind}): ${w}`);
        if (ai_result.boundaries.length === 0) {
            warnings.push(`AI(${kind}): no boundaries returned — falling back to regex splitter.`);
            return splitIntoQuestions(parsed.documentXml, parsed.paragraphSpans);
        }
        return materialiseFromBoundaries(parsed.paragraphSpans, ai_result.boundaries, warnings, kind);
    } catch (err) {
        warnings.push(`AI(${kind}) failed (${err instanceof Error ? err.message : String(err)}) — falling back to regex splitter.`);
        return splitIntoQuestions(parsed.documentXml, parsed.paragraphSpans);
    }
}

/** Turn the AI's index-ranges into ParsedQuestion entries, sourcing the
 *  paragraph XML verbatim from the parsed document. */
function materialiseFromBoundaries(
    spans: ParsedDocxSource["paragraphSpans"],
    boundaries: DocxStructureBoundary[],
    warnings: string[],
    kind: "questions" | "solutions"
): ParsedQuestion[] {
    const out: ParsedQuestion[] = [];
    // Sort + de-overlap defensively.
    const sorted = [...boundaries].sort((a, b) => a.paragraph_start_idx - b.paragraph_start_idx);
    for (const b of sorted) {
        if (
            !Number.isFinite(b.paragraph_start_idx) ||
            !Number.isFinite(b.paragraph_end_idx) ||
            b.paragraph_start_idx < 0 ||
            b.paragraph_end_idx <= b.paragraph_start_idx ||
            b.paragraph_end_idx > spans.length
        ) {
            warnings.push(`AI(${kind}): rejected out-of-range boundary for q${b.q_number} (${b.paragraph_start_idx}..${b.paragraph_end_idx}).`);
            continue;
        }
        const slice = spans.slice(b.paragraph_start_idx, b.paragraph_end_idx);
        const referencedRIds = new Set<string>();
        let plain = "";
        const xmls: string[] = [];
        for (const s of slice) {
            xmls.push(s.xml);
            plain += (plain ? " " : "") + s.plain;
            collectRIds(s.xml).forEach((r) => referencedRIds.add(r));
        }
        out.push({
            qNumber: Number(b.q_number) || 0,
            paragraphsXml: xmls,
            referencedRIds,
            plainText: plain,
            sectionSubject: b.subject || null,
            aiMetadata: {
                chapter: b.chapter || "",
                topic: b.topic || "",
                subtopic: b.subtopic || "",
                questionType: b.questionType || "",
                difficultyLevel: b.difficultyLevel || "",
                classLevel: b.classLevel || "",
                exam: Array.isArray(b.exam) ? b.exam : [],
                confidence: typeof b.confidence === "number" ? b.confidence : undefined,
            },
        });
    }
    return out;
}

/** Split paragraphs into question slices.
 *
 *  Rules:
 *   - A paragraph whose plain text begins with `<digits>.` (e.g. "1.", "12.")
 *     starts a new question; following paragraphs are appended until the next
 *     marker.
 *   - Question collection only starts AFTER the first subject heading is seen
 *     ("(PHYSICS)", "MATHEMATICS", etc.). This skips the instruction page at
 *     the top of typical exam papers, which uses the same `N.` numbering.
 *   - Each question is tagged with the subject from the most recent section
 *     heading; the AI tagger uses this as a strong hint.
 *
 *  If no subject heading is ever found we fall back to collecting everything
 *  (some short worksheets won't have section banners).
 */
function splitIntoQuestions(
    _documentXml: string,
    spans: ParsedDocxSource["paragraphSpans"]
): ParsedQuestion[] {
    // Question marker — must be "<n>." followed by whitespace, a non-digit
    // character, or end of string. Without the `(?!\d)` guard, decimals like
    // "1.5 m/s" or "2.4 mol" appearing inside a solution would be mis-detected
    // as the start of a new question.
    const NUM_AT_START = /^\s*(\d{1,3})\.(?!\d)/;

    // Choose the right heading style. AITS-style papers have both a syllabus
    // TOC ("Physics:", "Chemistry:", "Mathematics:") near the top AND real
    // section banners ("SECTION-I (PHYSICS)") further down. We prefer the
    // banners — when present, they mark the actual question-block boundaries.
    let useBanner = false;
    for (const sp of spans) {
        if (detectSectionBanner(sp.plain)) {
            useBanner = true;
            break;
        }
    }
    const detector = useBanner ? detectSectionBanner : detectSection;

    let firstSectionIdx = -1;
    let firstSectionSubject: string | null = null;
    for (let i = 0; i < spans.length; i++) {
        const det = detector(spans[i].plain);
        if (det) {
            firstSectionIdx = i;
            firstSectionSubject = det;
            break;
        }
    }
    const startFrom = firstSectionIdx >= 0 ? firstSectionIdx + 1 : 0;

    const out: ParsedQuestion[] = [];
    let current: ParsedQuestion | null = null;
    // The first heading is consumed up-front so its subject is the starting
    // currentSubject. Without this, the very first question batch would be
    // mis-tagged with whatever heading appeared inside the body.
    let currentSubject: string | null = firstSectionSubject;
    /** Last question number seen anywhere in the document body. Question
     *  numbering may be continuous across subjects (e.g. Physics 1-25,
     *  Chemistry 26-50, Maths 51-75) OR per-subject (1-25, 1-25, 1-25). We
     *  accept any `next > lastNum`, plus we explicitly accept any `next` after
     *  a subject heading (the next subject may legitimately restart at 1). */
    let lastNum = 0;
    /** True for the first numbered paragraph after a section heading — that
     *  one is allowed to be < lastNum without ending collection. */
    let allowReset = false;
    /** Have we collected at least one real question yet? Until then, any
     *  numbered paragraph is considered a candidate (no regression check). */
    let started = false;

    /** Subjects we've already seen real questions for. A second heading for
     *  the same subject (typically a footer / decoration / page repeat) is
     *  ignored so it can't permit a spurious numbering reset. */
    const subjectsSeen = new Set<string>();

    for (let i = startFrom; i < spans.length; i++) {
        const sp = spans[i];
        const newSection = detector(sp.plain);
        if (newSection) {
            if (current) {
                out.push(current);
                current = null;
            }
            // Only treat this as a true subject switch if (a) the subject is
            // actually changing AND (b) we haven't already collected questions
            // for this subject (a re-appearance is a footer/decoration).
            if (newSection !== currentSubject && !subjectsSeen.has(newSection)) {
                currentSubject = newSection;
                allowReset = true;
            }
            continue;
        }

        const m = NUM_AT_START.exec(sp.plain);
        if (m) {
            const next = Number(m[1]);
            // Stop the moment numbering regresses, with one narrow exception:
            // immediately after a section heading the next number may be 1
            // (the next subject restarted its numbering). Anything else is a
            // trailing instructions block or footer noise — stop collecting.
            if (started && next <= lastNum) {
                const legitimateReset = allowReset && next === 1;
                if (!legitimateReset) {
                    if (current) {
                        out.push(current);
                        current = null;
                    }
                    break;
                }
            }
            if (current) out.push(current);
            current = {
                qNumber: next,
                paragraphsXml: [sp.xml],
                referencedRIds: collectRIds(sp.xml),
                plainText: sp.plain,
                sectionSubject: currentSubject,
            };
            lastNum = next;
            started = true;
            allowReset = false;
            if (currentSubject) subjectsSeen.add(currentSubject);
            continue;
        }
        if (current) {
            current.paragraphsXml.push(sp.xml);
            current.plainText += " " + sp.plain;
            collectRIds(sp.xml).forEach((id) => current!.referencedRIds.add(id));
        }
    }
    if (current) out.push(current);
    return out;
}

/** Detect a subject section heading. Matches when the plain text is short
 *  (so embedded mentions of "physics" inside a question don't count) and
 *  contains exactly one of the subject keywords. */
function detectSection(plain: string): string | null {
    if (plain.length > 40) return null;
    for (const { re, subject } of SECTION_SUBJECTS) {
        if (re.test(plain)) return subject;
    }
    return null;
}

/** All r:embed / r:id / r:link references inside an XML chunk. */
function collectRIds(xml: string): Set<string> {
    const out = new Set<string>();
    const re = /\b(?:r:embed|r:id|r:link)="(rId\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        out.add(m[1]);
    }
    return out;
}

// =====================================================================
//  Media upload to Supabase Storage
// =====================================================================

const RELS_PARSER = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: false,
});

interface RelsRow {
    Id: string;
    Type: string;
    Target: string;
}

function parseRels(relsXml: string): Map<string, RelsRow> {
    const map = new Map<string, RelsRow>();
    if (!relsXml) return map;
    const parsed = RELS_PARSER.parse(relsXml) as Record<string, unknown>;
    const root = (parsed.Relationships ?? parsed) as Record<string, unknown>;
    const rows = root.Relationship as Record<string, string> | Record<string, string>[] | undefined;
    if (!rows) return map;
    const list = Array.isArray(rows) ? rows : [rows];
    for (const r of list) {
        const id = r["@_Id"];
        const type = r["@_Type"];
        const target = r["@_Target"];
        if (id && target) map.set(id, { Id: id, Type: type ?? "", Target: target });
    }
    return map;
}

/** Resolve a relationship target (e.g. "media/image100.wmf") to its absolute
 *  path inside the .docx zip (e.g. "word/media/image100.wmf"). */
function resolveZipPath(target: string): string {
    // Relationship targets are relative to the rels file's parent dir,
    // which for word/_rels/document.xml.rels is word/.
    return target.startsWith("/") ? target.slice(1) : `word/${target}`;
}

function mimeFor(target: string, type: string): { mime: string; kind: "image" | "ole" } {
    if (type.endsWith("/oleObject")) return { mime: MIME_BY_EXT.bin, kind: "ole" };
    const dot = target.lastIndexOf(".");
    const ext = dot >= 0 ? target.slice(dot + 1).toLowerCase() : "bin";
    const mime = MIME_BY_EXT[ext] || "application/octet-stream";
    return { mime, kind: type.endsWith("/oleObject") ? "ole" : "image" };
}

/** Upload every referenced binary to Supabase Storage. Returns a map of
 *  rId → DocxMediaRef so the caller can stitch it into per-question media
 *  arrays. */
async function uploadReferencedMedia(args: {
    relsXml: string;
    zip: JSZip;
    rIdsByQuestion: Set<string>[];
    supabase: SupabaseLike;
    extractionId: string;
    scope: "questions" | "solutions";
    warnings: string[];
}): Promise<Map<string, DocxMediaRef>> {
    const rels = parseRels(args.relsXml);
    const allRIds = new Set<string>();
    for (const set of args.rIdsByQuestion) {
        for (const rid of set) allRIds.add(rid);
    }

    const out = new Map<string, DocxMediaRef>();
    // Dedupe identical binaries within an extraction by content hash.
    const hashToPath = new Map<string, { path: string; bytes: number; mime: string; kind: "image" | "ole" }>();

    for (const rid of allRIds) {
        const rel = rels.get(rid);
        if (!rel) continue;
        // We only care about image / oleObject / chart relationships. Others
        // (numbering, styles, headers …) aren't per-question content.
        if (
            !rel.Type.endsWith("/image") &&
            !rel.Type.endsWith("/oleObject") &&
            !rel.Type.endsWith("/chart") &&
            !rel.Type.endsWith("/diagramData")
        ) {
            continue;
        }
        const path = resolveZipPath(rel.Target);
        const file = args.zip.file(path);
        if (!file) {
            args.warnings.push(`Media file referenced but missing from zip: ${path}`);
            continue;
        }
        const bytes = await file.async("nodebuffer");
        const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
        const { mime, kind } = mimeFor(rel.Target, rel.Type);

        let storagePath = hashToPath.get(sha)?.path;
        if (!storagePath) {
            const ext = (rel.Target.split(".").pop() || "bin").toLowerCase();
            storagePath = `${args.extractionId}/${args.scope}/${sha}.${ext}`;
            const { error } = await args.supabase.storage
                .from(STORAGE_BUCKET)
                .upload(storagePath, bytes, {
                    contentType: mime,
                    upsert: true,
                });
            if (error) {
                args.warnings.push(`Storage upload failed for ${rel.Target}: ${error.message}`);
                continue;
            }
            hashToPath.set(sha, { path: storagePath, bytes: bytes.length, mime, kind });
        }

        out.set(rid, {
            rId: rid,
            original_target: rel.Target,
            mime,
            storage_path: storagePath,
            bytes: bytes.length,
            kind,
        });
    }

    return out;
}

function collectMediaRefs(
    rids: Set<string>,
    map: Map<string, DocxMediaRef>
): DocxMediaRef[] {
    const out: DocxMediaRef[] = [];
    for (const rid of rids) {
        const ref = map.get(rid);
        if (ref) out.push(ref);
    }
    return out;
}
