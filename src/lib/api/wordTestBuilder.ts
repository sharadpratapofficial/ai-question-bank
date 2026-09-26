/**
 * Server-side .docx test-paper generator.
 *
 * Given a list of question rows whose `source_docx` payload was captured by
 * the Word ingestion pipeline, this module stitches their raw OOXML paragraphs
 * + media binaries into a fresh .docx, ready for download.
 *
 * Why raw OOXML (not the `docx` typed library):
 *   The source equations are WMF / OLE images and the source diagrams are
 *   PNG/JPEG, all referenced by relationship IDs inside arbitrary <w:p> blocks.
 *   The typed `docx` lib's Paragraph/Run API can't represent those at all,
 *   so we'd have to invent equivalents and lose fidelity. By concatenating the
 *   original XML chunks verbatim and renumbering relationship IDs, the
 *   equations and diagrams come through byte-exact.
 *
 * Layout: questions are grouped by subject. Each question is immediately
 * followed by its answer-key line and (if available) its solution paragraphs.
 * Questions are renumbered 1, 2, 3 … in the output, matching the input order
 * within each subject group.
 */

import JSZip from "jszip";
import type { Question, QuestionStatus } from "@/types";
import { resolveAnswerKey } from "@/types";
import type { DocxMediaRef, DocxQuestionPayload } from "@/types/extraction";

// Loose Supabase client type (storage access is all we need).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

const STORAGE_BUCKET = "docx-media";

const SUBJECT_ORDER = ["Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"];

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

// --------- public entry point ---------------------------------------------

export interface WordTestBuilderQuestion {
    question_id: string;
    subject: string;
    answer_key: number | number[] | null;
    /** Used to recover the answer when answer_key is null (derived from isCorrect). */
    options?: { text: string | null; isCorrect: boolean | null }[] | null;
    question_type: string;
    source_docx: DocxQuestionPayload | null | undefined;
}

export interface WordTestBuildInput {
    /** Questions to include in the test. Must already have source_docx populated. */
    questions: WordTestBuilderQuestion[];
    title?: string;
    subtitle?: string;
    supabase: SupabaseLike;
}

export interface WordTestBuildResult {
    /** Final .docx buffer ready to send back as a download. */
    buffer: Buffer;
    /** Count of questions actually included (skips rows missing source_docx). */
    includedCount: number;
    /** Count of source rows skipped because they had no source_docx. */
    skippedCount: number;
    /** Non-fatal warnings (missing media, etc.). */
    warnings: string[];
}

export async function buildWordTest(input: WordTestBuildInput): Promise<WordTestBuildResult> {
    const warnings: string[] = [];

    // 1) Filter + group by subject.
    const usable = input.questions.filter((q) => q.source_docx);
    const skipped = input.questions.length - usable.length;
    const bySubject = new Map<string, typeof usable>();
    for (const q of usable) {
        const subj = q.subject || "Other";
        if (!bySubject.has(subj)) bySubject.set(subj, []);
        bySubject.get(subj)!.push(q);
    }
    const orderedSubjects = [
        ...SUBJECT_ORDER.filter((s) => bySubject.has(s)),
        ...Array.from(bySubject.keys()).filter((s) => !SUBJECT_ORDER.includes(s)),
    ];

    // 2) Build the body, renumbering rIds + question markers as we go.
    const ctx = new BuildContext(input.supabase);
    const bodyChunks: string[] = [];

    bodyChunks.push(makeTitleParagraph(input.title || "Test Paper"));
    if (input.subtitle) bodyChunks.push(makeSubtitleParagraph(input.subtitle));

    let runningQ = 0;
    for (let s = 0; s < orderedSubjects.length; s++) {
        const subject = orderedSubjects[s];
        bodyChunks.push(makeSectionBanner(ROMAN[s] || String(s + 1), subject));

        for (const q of bySubject.get(subject)!) {
            runningQ++;
            const sd = q.source_docx!;

            // Question body — use a per-question key so VML / OLE shape IDs
            // can't collide with the same IDs from another question. Solutions
            // get their own key so question-shape and solution-shape rewrites
            // never alias either.
            const qKey = `q${runningQ}`;
            const solKey = `q${runningQ}s`;

            const qParagraphs = await ctx.processParagraphs(sd.ooxml_paragraphs, sd.media_refs, "image", warnings);
            const renumbered = renumberFirstMarker(qParagraphs, runningQ)
                .map((p) => rewriteShapeIds(p, qKey))
                .map(sanitiseParagraph)
                .filter((p) => {
                    if (!isParagraphBalanced(p)) {
                        warnings.push(`Q${runningQ}: dropped a paragraph with unbalanced <w:p> tags (older ingest format).`);
                        return false;
                    }
                    return true;
                });
            for (const p of renumbered) bodyChunks.push(p);

            // Answer key line — resolve from options when answer_key is null.
            bodyChunks.push(makeAnswerKeyParagraph(resolveAnswerKey(q)));

            // Solution paragraphs (if matched)
            if (sd.solution_ooxml_paragraphs && sd.solution_ooxml_paragraphs.length > 0) {
                bodyChunks.push(makeSolutionLabelParagraph());
                const solParas = await ctx.processParagraphs(
                    sd.solution_ooxml_paragraphs,
                    sd.solution_media_refs ?? [],
                    "image",
                    warnings
                );
                const solRenumbered = stripLeadingMarker(solParas)
                    .map((p) => rewriteShapeIds(p, solKey))
                    .map(sanitiseParagraph)
                    .filter((p) => {
                        if (!isParagraphBalanced(p)) {
                            warnings.push(`Q${runningQ} solution: dropped a paragraph with unbalanced <w:p> tags (older ingest format).`);
                            return false;
                        }
                        return true;
                    });
                for (const p of solRenumbered) bodyChunks.push(p);
            }
        }
    }

    // 3) Compose the final document.xml + relationships + Content Types.
    //    Final scrub: any r:id / r:embed / r:link that points to an rId we
    //    haven't issued gets its value blanked. Orphan refs are typically
    //    hyperlinks the ingester didn't capture; left as-is they crash Mac Word.
    const validRIds = new Set<string>(ctx.allValidRIds());
    const stitched = bodyChunks.map((c) => stripOrphanRefs(c, validRIds)).join("");
    const documentXml = wrapDocumentBody(stitched);
    const relsXml = ctx.buildDocumentRelsXml();
    const contentTypesXml = ctx.buildContentTypesXml();

    // 4) Pack into a zip.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypesXml);
    zip.folder("_rels")!.file(".rels", PACKAGE_RELS_XML);
    const word = zip.folder("word")!;
    word.file("document.xml", documentXml);
    word.file("styles.xml", MIN_STYLES_XML);
    word.file("settings.xml", MIN_SETTINGS_XML);
    word.file("webSettings.xml", MIN_WEB_SETTINGS_XML);
    word.file("fontTable.xml", MIN_FONT_TABLE_XML);
    word.file("numbering.xml", MIN_NUMBERING_XML);
    word.file("footnotes.xml", MIN_FOOTNOTES_XML);
    word.file("endnotes.xml", MIN_ENDNOTES_XML);
    word.folder("theme")!.file("theme1.xml", MIN_THEME1_XML);
    word.folder("_rels")!.file("document.xml.rels", relsXml);

    // Write media binaries.
    for (const [outputPath, bytes] of ctx.outputMediaBinaries) {
        const folder = outputPath.startsWith("media/") ? "media" : "embeddings";
        const filename = outputPath.split("/").pop()!;
        word.folder(folder)!.file(filename, bytes);
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
        buffer,
        includedCount: runningQ,
        skippedCount: skipped,
        warnings,
    };
}

// --------- build context (manages rIds + media binaries) ------------------

class BuildContext {
    private supabase: SupabaseLike;
    private nextRId = 100; // Start high to keep distance from the reserved skeleton rels (rId1..rId8).
    /** Output rId → media file path inside the new docx. */
    private rIdToTarget = new Map<string, { target: string; contentType: string; relType: string }>();
    /** Output filename → file bytes. */
    public outputMediaBinaries = new Map<string, Buffer>();
    /** Deduped: source storage_path → output target path. */
    private storagePathToOutput = new Map<string, string>();
    /** Track next image/oleObject index for naming. */
    private nextImageIdx = 1;
    private nextOleIdx = 1;

    constructor(supabase: SupabaseLike) {
        this.supabase = supabase;
        // Reserve a low rId range for the skeleton parts. Each must be unique and
        // resolvable from word/_rels/document.xml.rels or Word for Mac will crash.
        const officeDoc = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        this.rIdToTarget.set("rId1", { target: "styles.xml",      contentType: "", relType: `${officeDoc}/styles` });
        this.rIdToTarget.set("rId2", { target: "settings.xml",    contentType: "", relType: `${officeDoc}/settings` });
        this.rIdToTarget.set("rId3", { target: "webSettings.xml", contentType: "", relType: `${officeDoc}/webSettings` });
        this.rIdToTarget.set("rId4", { target: "fontTable.xml",   contentType: "", relType: `${officeDoc}/fontTable` });
        this.rIdToTarget.set("rId5", { target: "numbering.xml",   contentType: "", relType: `${officeDoc}/numbering` });
        this.rIdToTarget.set("rId6", { target: "footnotes.xml",   contentType: "", relType: `${officeDoc}/footnotes` });
        this.rIdToTarget.set("rId7", { target: "endnotes.xml",    contentType: "", relType: `${officeDoc}/endnotes` });
        this.rIdToTarget.set("rId8", { target: "theme/theme1.xml", contentType: "", relType: `${officeDoc}/theme` });
    }

    /** Walk paragraph XML, rewrite r:embed / r:id / r:link references to new
     *  rIds, download the referenced media from Supabase Storage, register
     *  the new rels. Returns the paragraphs (mutated). */
    async processParagraphs(
        paragraphs: string[],
        mediaRefs: DocxMediaRef[],
        _hint: "image" | "ole",
        warnings: string[]
    ): Promise<string[]> {
        // Build a per-question old-rId → new-rId map. Each question's source
        // had its own rId space, so we map each old rId to a freshly-assigned
        // global rId. Two questions referencing the same media (by storage
        // path) deduplicate to the same output file.
        const oldToNew = new Map<string, string>();
        for (const m of mediaRefs) {
            const newRId = await this.registerMedia(m, warnings);
            if (newRId) oldToNew.set(m.rId, newRId);
        }

        // Rewrite the XML chunks.
        return paragraphs.map((xml) =>
            xml.replace(/\b(r:embed|r:id|r:link)="(rId\d+)"/g, (full, attr, rid) => {
                const next = oldToNew.get(rid);
                return next ? `${attr}="${next}"` : full;
            })
        );
    }

    /** Download a media binary from Storage and register a new rId pointing
     *  to it inside the output docx. Returns the new rId. */
    private async registerMedia(m: DocxMediaRef, warnings: string[]): Promise<string | null> {
        // Have we already pulled this binary in for an earlier question?
        let outputTarget = this.storagePathToOutput.get(m.storage_path);
        if (!outputTarget) {
            const { data, error } = await this.supabase.storage.from(STORAGE_BUCKET).download(m.storage_path);
            if (error || !data) {
                warnings.push(`Could not download media from Storage (${m.storage_path}): ${error?.message ?? "no data"}`);
                return null;
            }
            const arrayBuffer = await data.arrayBuffer();
            const bytes = Buffer.from(arrayBuffer);
            const ext = m.original_target.split(".").pop()?.toLowerCase() || "bin";
            if (m.kind === "ole" || m.mime.includes("oleObject")) {
                outputTarget = `embeddings/oleObject${this.nextOleIdx++}.${ext}`;
            } else {
                outputTarget = `media/image${this.nextImageIdx++}.${ext}`;
            }
            this.outputMediaBinaries.set(outputTarget, bytes);
            this.storagePathToOutput.set(m.storage_path, outputTarget);
        }

        const newRId = `rId${this.nextRId++}`;
        const relType =
            m.kind === "ole" || m.mime.includes("oleObject")
                ? "http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject"
                : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
        this.rIdToTarget.set(newRId, { target: outputTarget, contentType: m.mime, relType });
        return newRId;
    }

    /** Every rId that exists in document.xml.rels. Used by the orphan-ref
     *  scrubber to blank any reference that doesn't resolve. */
    allValidRIds(): string[] {
        return Array.from(this.rIdToTarget.keys());
    }

    /** word/_rels/document.xml.rels XML. */
    buildDocumentRelsXml(): string {
        const entries: string[] = [];
        for (const [rid, info] of this.rIdToTarget) {
            entries.push(
                `<Relationship Id="${rid}" Type="${info.relType}" Target="${info.target}"${info.relType.endsWith("/oleObject") ? ' TargetMode="Internal"' : ""}/>`
            );
        }
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join("")}</Relationships>`;
    }

    /** [Content_Types].xml — registers every part Word needs to find. */
    buildContentTypesXml(): string {
        const wpml = "application/vnd.openxmlformats-officedocument.wordprocessingml";
        const defaults: string[] = [
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
            `<Default Extension="xml" ContentType="application/xml"/>`,
        ];
        const seenExts = new Set<string>(["rels", "xml"]);
        for (const target of this.outputMediaBinaries.keys()) {
            const ext = target.split(".").pop()?.toLowerCase() || "bin";
            if (seenExts.has(ext)) continue;
            seenExts.add(ext);
            defaults.push(`<Default Extension="${ext}" ContentType="${mimeForExt(ext)}"/>`);
        }
        const overrides: string[] = [
            `<Override PartName="/word/document.xml" ContentType="${wpml}.document.main+xml"/>`,
            `<Override PartName="/word/styles.xml" ContentType="${wpml}.styles+xml"/>`,
            `<Override PartName="/word/settings.xml" ContentType="${wpml}.settings+xml"/>`,
            `<Override PartName="/word/webSettings.xml" ContentType="${wpml}.webSettings+xml"/>`,
            `<Override PartName="/word/fontTable.xml" ContentType="${wpml}.fontTable+xml"/>`,
            `<Override PartName="/word/numbering.xml" ContentType="${wpml}.numbering+xml"/>`,
            `<Override PartName="/word/footnotes.xml" ContentType="${wpml}.footnotes+xml"/>`,
            `<Override PartName="/word/endnotes.xml" ContentType="${wpml}.endnotes+xml"/>`,
            `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
        ];
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join("")}${overrides.join("")}</Types>`;
    }
}

function mimeForExt(ext: string): string {
    switch (ext) {
        case "wmf": return "image/x-wmf";
        case "emf": return "image/x-emf";
        case "png": return "image/png";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "gif": return "image/gif";
        case "svg": return "image/svg+xml";
        case "bin": return "application/vnd.openxmlformats-officedocument.oleObject";
        default: return "application/octet-stream";
    }
}

// --------- XML helpers -----------------------------------------------------

/** Replace the first numeric marker "<num>." inside the first <w:t> run of the
 *  first paragraph with the new question number. Leaves the rest of the
 *  paragraph (including any inline images, math, formatting) untouched. */
function renumberFirstMarker(paragraphs: string[], newNumber: number): string[] {
    if (paragraphs.length === 0) return paragraphs;
    let first = paragraphs[0];
    // Find the first <w:t ...>...</w:t> in the paragraph and surgery the
    // leading "<digits>." away, replacing with the new number.
    const m = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/.exec(first);
    if (m) {
        const before = first.slice(0, m.index);
        const after = first.slice(m.index + m[0].length);
        const replaced = m[2].replace(/^\s*\d{1,3}\.\s*/, `${newNumber}. `);
        const attrs = m[1] || ' xml:space="preserve"';
        first = `${before}<w:t${attrs}>${replaced}</w:t>${after}`;
    }
    return [first, ...paragraphs.slice(1)];
}

/** Rewrite VML shape IDs + OLE object IDs to be unique per question.
 *
 *  Each source .docx independently numbered its inline shapes starting at
 *  `_x0000_i1025`, `_x0000_t75`, etc. When we stitch many questions into one
 *  output document, these IDs collide — and Word for Mac crashes when two
 *  shapes share an ID because it confuses which `<v:shape>` an `<o:OLEObject>`
 *  is paired with. The crash surfaces as "You can't put drawing objects into
 *  a text box…" because the misattributed shape ends up inside the wrong
 *  parent container.
 *
 *  We prefix every `_x0000_*` and ObjectID with a per-question key, keeping
 *  pairings intact within a single question.
 */
function rewriteShapeIds(xml: string, qKey: string): string {
    return xml
        .replace(/(\bid=")_x0000_([a-zA-Z0-9_]+)"/g, `$1_qbg_${qKey}_$2"`)
        .replace(/(\bShapeID=")_x0000_([a-zA-Z0-9_]+)"/g, `$1_qbg_${qKey}_$2"`)
        .replace(/(\btype="#)_x0000_([a-zA-Z0-9_]+)"/g, `$1_qbg_${qKey}_$2"`)
        .replace(/(\bObjectID=")_(\d+)"/g, `$1_qbg_${qKey}_$2"`);
}

/** Defensive: count `<w:p>` opens vs closes in a chunk. If they don't match,
 *  the chunk is malformed (e.g. an old ingest that didn't handle nested
 *  textbox paragraphs). Returning false means: drop this paragraph rather
 *  than insert malformed XML that crashes Word for Mac. */
function isParagraphBalanced(xml: string): boolean {
    // Match <w:p ...> or <w:p> opens, but not <w:p/> self-closing or
    // unrelated tags like <w:pPr> / <w:pStyle> / <w:pgSz>.
    const opens = (xml.match(/<w:p(?:\s[^>/]*)?>/g) || []).length;
    const closes = (xml.match(/<\/w:p>/g) || []).length;
    return opens === closes;
}

/** Sanitise a paragraph chunk before stitching: remove section properties
 *  (which carry header/footer references that point to skeleton parts we
 *  don't have), unresolved hyperlinks, footnote / endnote / comment
 *  references. Without this, Word for Mac crashes when parsing references
 *  that go nowhere. */
function sanitiseParagraph(xml: string): string {
    let out = xml;
    // 1) Section properties — we apply our own <w:sectPr> at the body end.
    out = out.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "");
    // 2) Header / footer references that survived a sectPr strip elsewhere.
    out = out.replace(/<w:headerReference\b[^/]*\/>/g, "");
    out = out.replace(/<w:footerReference\b[^/]*\/>/g, "");
    // 3) Footnote / endnote references — point to footnotes.xml IDs the source
    //    had; even with our skeleton file present those specific IDs don't exist.
    out = out.replace(/<w:footnoteReference\b[^/]*\/>/g, "");
    out = out.replace(/<w:endnoteReference\b[^/]*\/>/g, "");
    // 4) Comment range starts/ends — point to a comments.xml we don't ship.
    out = out.replace(/<w:commentRangeStart\b[^/]*\/>/g, "");
    out = out.replace(/<w:commentRangeEnd\b[^/]*\/>/g, "");
    out = out.replace(/<w:commentReference\b[^/]*\/>/g, "");
    // 5) Custom XML markers — referenced from a customXml/ part we don't ship.
    out = out.replace(/<w:customXmlInsRangeStart\b[^/]*\/>/g, "");
    out = out.replace(/<w:customXmlInsRangeEnd\b[^/]*\/>/g, "");
    // 6) Hyperlinks: the source's hyperlinks point to rels we never captured
    //    (the ingester only kept image/OLE/chart rels). Word for Mac crashes
    //    on orphan r:id references inside <w:hyperlink>. Unwrap the link —
    //    keep the visible runs inside, drop the wrapper. Done via a simple
    //    replace; <w:hyperlink> is never nested in real docx files.
    out = out.replace(/<w:hyperlink\b[^>]*>([\s\S]*?)<\/w:hyperlink>/g, "$1");
    return out;
}

/** Final defensive scrub: after rIds have been rewritten, any reference still
 *  pointing to an rId we haven't issued is a broken pointer. Replace the
 *  attribute value with an empty string — Word ignores `r:id=""` gracefully
 *  instead of crashing on a dangling target. */
function stripOrphanRefs(xml: string, validRIds: Set<string>): string {
    return xml.replace(/\b(r:embed|r:id|r:link)="(rId\d+)"/g, (full, attr, rid) => {
        return validRIds.has(rid) ? full : `${attr}=""`;
    });
}

/** Strip the leading "<digits>." marker from the first text run — used for
 *  solution paragraphs where we don't want a stray "47." appearing before the
 *  worked solution since we've already labelled it "Solution:". */
function stripLeadingMarker(paragraphs: string[]): string[] {
    if (paragraphs.length === 0) return paragraphs;
    let first = paragraphs[0];
    const m = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/.exec(first);
    if (m) {
        const before = first.slice(0, m.index);
        const after = first.slice(m.index + m[0].length);
        const replaced = m[2].replace(/^\s*\d{1,3}\.\s*/, "");
        const attrs = m[1] || ' xml:space="preserve"';
        first = `${before}<w:t${attrs}>${replaced}</w:t>${after}`;
    }
    return [first, ...paragraphs.slice(1)];
}

function makeTitleParagraph(text: string): string {
    return `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function makeSubtitleParagraph(text: string): string {
    return `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="24"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function makeSectionBanner(roman: string, subject: string): string {
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>SECTION-${roman} (${escapeXml(subject.toUpperCase())})</w:t></w:r></w:p>`;
}

function makeAnswerKeyParagraph(values: number[]): string {
    const key = values.length > 0 ? values.join(", ") : "—";
    return `<w:p><w:pPr><w:spacing w:before="60"/><w:rPr><w:b/><w:color w:val="2563EB"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:color w:val="2563EB"/></w:rPr><w:t xml:space="preserve">Answer: </w:t></w:r><w:r><w:rPr><w:color w:val="2563EB"/></w:rPr><w:t>${escapeXml(key)}</w:t></w:r></w:p>`;
}

function makeSolutionLabelParagraph(): string {
    return `<w:p><w:pPr><w:spacing w:before="60" w:after="60"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Solution:</w:t></w:r></w:p>`;
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** Wrap a body of <w:p> chunks in the standard document envelope, including
 *  all namespaces that AITS-style source files use. Omitting any of these
 *  causes Word to silently drop equations / drawings / VML / mc fallbacks. */
function wrapDocumentBody(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 wp14 wne wps wpg">
  <w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

// --------- minimal package skeleton ----------------------------------------

const PACKAGE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdPackage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const MIN_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

const MIN_SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

const MIN_WEB_SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const MIN_FONT_TABLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="Symbol"><w:panose1 w:val="05050102010706020507"/><w:charset w:val="02"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="Cambria Math"><w:panose1 w:val="02040503050406030204"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="Arial"><w:panose1 w:val="020B0604020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>
</w:fonts>`;

const MIN_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const MIN_FOOTNOTES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
</w:footnotes>`;

const MIN_ENDNOTES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
</w:endnotes>`;

/** Minimal Office Open XML theme. Word for Mac is unusually strict about
 *  needing a valid theme to resolve theme-coloured / theme-fonted runs. */
const MIN_THEME1_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="5B9BD5"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="4472C4"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light" panose="020F0302020204030204"/>
        <a:ea typeface=""/><a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri" panose="020F0502020204030204"/>
        <a:ea typeface=""/><a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;

// --------- adapter for the QC workflow (export for satisfy/Tsc) -----------

export type _QuestionStatusType = QuestionStatus;
