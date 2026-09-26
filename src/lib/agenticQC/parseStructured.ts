/**
 * Parser for structured paper uploads (CSV / XLSX / XLS / ODS) — the
 * alternative to PDF/Word file uploads for Agentic QC.
 *
 * The PW QBG export shape used in production has JSON-encoded columns:
 *   - content              → {"english": "<p>...</p>", "hindi": "...", ...}
 *   - bilingual_options    → {"english": [{"isCorrect": bool, "text": "<p>...</p>"}, ...]}
 *   - solutions            → [{"english": {"text": "<p>...</p>", "videoSolution": {...}}}]
 *   - bilingual_solutions  → {"english": {"text": "...", "videoSolution": {...}}}
 *   - answer               → raw answer string (used for numerical / integer Qs)
 *   - is_int_answer        → "TRUE" | "FALSE"
 *   - is_range_numerical   → "TRUE" | "FALSE"
 *   - examDetails          → [{"subject": {"english_name": "..."}, "chapter": {...}}]
 *
 * Per user requirements:
 *   - For SCQ questions, the correct answer comes from `bilingual_options`
 *     where `isCorrect === true` — NOT from the `answer` column (which is
 *     often blank for SCQs).
 *   - English-only — Hindi / regional language fields are ignored for QC.
 *   - Image references (diagrams) are extracted from question + option +
 *     solution HTML so the agents know which questions to flag visually.
 *
 * We use the `xlsx` library because the PW CSV has multi-line cells with
 * embedded HTML, commas, and nested JSON — a naive split-on-comma parser
 * would corrupt those. `xlsx` handles RFC-4180 quoting + multi-line cells.
 */
import * as XLSX from "xlsx";

// ─── Public types ──────────────────────────────────────────────────────

export interface ParsedQuestionOption {
    /** "A" / "B" / "C" / "D" / … */
    label: string;
    /** Plain-text option (HTML stripped). */
    text: string;
    /** Original HTML — kept for full-fidelity prompts. */
    html: string;
    isCorrect: boolean;
}

export interface ParsedQuestion {
    questionNumber: number;
    /** Plain-text question (HTML stripped, MathML simplified). */
    questionText: string;
    /** Original HTML of the question. */
    questionHtml: string;
    /** Empty array for numerical / integer questions. */
    options: ParsedQuestionOption[];
    /**
     * The expected answer, derived as follows:
     *   - SCQ / MCQ → list of correct option labels ("B", or ["A","C"])
     *   - Numerical / Integer → raw value from the `answer` column
     *   - Anything else → empty string
     */
    correctAnswer: string;
    questionType: "SCQ" | "MCQ" | "Numerical" | "Integer" | "Unknown";
    /** Plain-text solution. */
    solutionText: string;
    /** Original HTML of the solution. */
    solutionHtml: string;
    /** Inferred subject (Physics / Chemistry / Mathematics / …). */
    subject: string;
    /** Inferred chapter / topic name. */
    chapter: string;
    topic: string;
    /** Raw class / standard label from source (e.g. "Class 11", "12th"). */
    klass: string;
    /** Difficulty index from source (0-3 typically). */
    difficulty: number | null;
    /** True when the source row carries a non-empty video-solution URL
     *  (checked in bilingual_solutions / solutions). The URL itself is not
     *  needed for QC — only whether one was provided. */
    hasVideoSolution: boolean;
    /** Any image / diagram URLs found in question, options, or solution HTML.
     *  An agent prompt should include these as references and flag hasFigure. */
    imageUrls: string[];
    /** Optional source row id / slug for traceability back to QBG. */
    sourceId?: string;
}

export interface ParseStructuredResult {
    /** Successfully parsed questions, 1-indexed in the order they appeared in the sheet. */
    questions: ParsedQuestion[];
    /** Per-row issues — kept separately so the user sees which rows were skipped. */
    warnings: { rowIndex: number; message: string }[];
    /** Subjects inferred from the data (deduplicated). */
    subjects: string[];
    /** Column names that we recognised in the source header. */
    matchedColumns: Record<string, string>;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Lowercase + strip spaces/underscores so "Bilingual Options" → "bilingualoptions". */
function normHeader(s: string): string {
    return String(s || "").toLowerCase().replace(/[\s_]+/g, "");
}

/**
 * Map a normalised header to the canonical field name. Returns null if not a
 * recognised column. Supports the PW QBG export shape AND generic CSVs with
 * simpler column names ("question", "options", "answer", "solution").
 */
function canonicalField(headerNorm: string): string | null {
    const map: Record<string, string> = {
        // PW QBG canonical
        content: "content",
        bilingualoptions: "bilingual_options",
        solutions: "solutions",
        bilingualsolutions: "bilingual_solutions",
        answer: "answer",
        isintanswer: "is_int_answer",
        israngenumerical: "is_range_numerical",
        examdetails: "examDetails",
        // conceptTags column — PW QBG export column that embeds JSON with
        // chapter/topic english_name fields. Recognised under several spellings.
        concepttags: "concept_tags",
        concepttag: "concept_tags",
        tags: "concept_tags",
        difficulty: "difficulty",
        // QBG unique question id — the value used to deep-link the question in
        // the QBG admin panel. Recognised under several spellings (after
        // normalisation that strips spaces/underscores, e.g. "_id" -> "id").
        uniqueid: "unique_id",
        qbgid: "unique_id",
        questionid: "unique_id",
        id: "unique_id",
        slug: "slug",
        type: "type",
        // Generic fallback column names
        question: "content",
        questiontext: "content",
        questionbody: "content",
        body: "content",
        options: "bilingual_options",
        choices: "bilingual_options",
        solution: "solutions",
        explanation: "solutions",
        correctanswer: "answer",
        expectedanswer: "answer",
        providedanswer: "answer",
        subject: "subject_direct",
        chapter: "chapter_direct",
        topic: "topic_direct",
        class: "class_direct",
        standard: "class_direct",
        grade: "class_direct",
        hasfigure: "has_figure_direct",
        figure: "has_figure_direct",
        diagram: "has_figure_direct",
        // Individual-option columns ("optionA", "optionB", …)
        optiona: "option_a",
        optionb: "option_b",
        optionc: "option_c",
        optiond: "option_d",
        optione: "option_e",
        iscorrecta: "correct_a",
        iscorrectb: "correct_b",
        iscorrectc: "correct_c",
        iscorrectd: "correct_d",
    };
    return map[headerNorm] ?? null;
}

/**
 * Tolerant JSON parser — the PW CSV sometimes contains JSON with unescaped
 * inner double quotes or with single-quoted attributes (when copied from
 * spreadsheets). Try strict first; if that fails, try a couple of repairs.
 */
function safeJSONParse<T = unknown>(raw: unknown): T | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") {
        // Already an object (xlsx sometimes returns parsed JSON)
        return raw as T;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
    // Fast path
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        // Try replacing smart quotes
        try {
            const repaired = trimmed
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'");
            return JSON.parse(repaired) as T;
        } catch {
            return null;
        }
    }
}

/**
 * Strip HTML tags + MathML to plain readable text. Keeps the math expressions
 * roughly intact (we use a couple of substitutions for the most common MathML
 * structures so the AI agent can still read the question semantics).
 *
 * Does NOT decode every HTML entity — only the common ones the agent will
 * encounter. The agent receives plain text + an `htmlPreserved` field if it
 * needs more fidelity.
 */
export function htmlToText(html: string): string {
    if (!html) return "";
    let s = String(html);

    // MathML simplifications — replace fractions and sub/sup with readable form.
    // <mfrac><num>...</num><den>...</den></mfrac> → ((num)/(den))
    s = s.replace(
        /<mfrac[^>]*>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<\/mfrac>/gi,
        " (($1)/($2)) "
    );
    s = s.replace(/<msup[^>]*>([\s\S]*?)<\/msup>/gi, " $1 ");
    s = s.replace(/<msub[^>]*>([\s\S]*?)<\/msub>/gi, " $1 ");
    s = s.replace(/<msqrt[^>]*>([\s\S]*?)<\/msqrt>/gi, " sqrt($1) ");

    // Drop <math> wrapper tags but keep inner text.
    s = s.replace(/<math[^>]*>/gi, " ");
    s = s.replace(/<\/math>/gi, " ");

    // Block-level → newline
    s = s.replace(/<\/?(p|div|br|li|tr)[^>]*>/gi, "\n");
    s = s.replace(/<li[^>]*>/gi, "\n• ");

    // Strip every remaining tag
    s = s.replace(/<[^>]+>/g, "");

    // Common entities — the PW dataset uses a lot of these for math symbols.
    const namedEntities: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&times;": "×",
        "&divide;": "÷",
        "&minus;": "−",
        "&plus;": "+",
        "&deg;": "°",
        "&ndash;": "–",
        "&mdash;": "—",
        "&hellip;": "…",
        "&prime;": "′",
        "&Prime;": "″",
        // Greek lower
        "&alpha;": "α", "&beta;": "β", "&gamma;": "γ", "&delta;": "δ",
        "&epsilon;": "ε", "&zeta;": "ζ", "&eta;": "η", "&theta;": "θ",
        "&iota;": "ι", "&kappa;": "κ", "&lambda;": "λ", "&mu;": "μ",
        "&nu;": "ν", "&xi;": "ξ", "&pi;": "π", "&rho;": "ρ",
        "&sigma;": "σ", "&tau;": "τ", "&upsilon;": "υ", "&phi;": "φ",
        "&chi;": "χ", "&psi;": "ψ", "&omega;": "ω",
        "&micro;": "μ", // micro sign — used for μ in PW
        // Greek upper
        "&Alpha;": "Α", "&Beta;": "Β", "&Gamma;": "Γ", "&Delta;": "Δ",
        "&Epsilon;": "Ε", "&Zeta;": "Ζ", "&Eta;": "Η", "&Theta;": "Θ",
        "&Lambda;": "Λ", "&Mu;": "Μ", "&Nu;": "Ν", "&Xi;": "Ξ",
        "&Pi;": "Π", "&Rho;": "Ρ", "&Sigma;": "Σ", "&Tau;": "Τ",
        "&Phi;": "Φ", "&Omega;": "Ω",
        // Math / arrows
        "&rArr;": "⇒", "&lArr;": "⇐", "&hArr;": "⇔",
        "&rarr;": "→", "&larr;": "←", "&harr;": "↔",
        "&uarr;": "↑", "&darr;": "↓",
        "&infin;": "∞", "&radic;": "√", "&sum;": "∑", "&prod;": "∏",
        "&int;": "∫", "&part;": "∂", "&nabla;": "∇",
        "&plusmn;": "±", "&le;": "≤", "&ge;": "≥", "&ne;": "≠",
        "&asymp;": "≈", "&equiv;": "≡", "&prop;": "∝",
        "&isin;": "∈", "&notin;": "∉", "&cap;": "∩", "&cup;": "∪",
        "&sup2;": "²", "&sup3;": "³",
        "&there4;": "∴", "&because;": "∵",
        "&middot;": "·", "&sdot;": "⋅", "&bull;": "•",
        // Spaces
        "&thinsp;": " ", "&emsp;": " ", "&ensp;": " ",
        "&#39;": "'",
    };
    for (const [k, v] of Object.entries(namedEntities)) {
        s = s.split(k).join(v);
    }
    // Numeric entities — &#1234; and &#x1A2B;
    s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));

    // Collapse whitespace
    s = s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
    return s;
}

/** Find every <img src="..."> URL inside an HTML blob. */
function extractImageUrls(html: string): string[] {
    if (!html) return [];
    const urls: string[] = [];
    const re = /<img[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        urls.push(m[1]);
    }
    return urls;
}

/** Pluck the English variant from a multi-language JSON field. */
export function pickEnglish(raw: unknown): string {
    if (!raw) return "";
    if (typeof raw === "string") {
        // Sometimes a column is plain string (not JSON-wrapped).
        return raw;
    }
    if (typeof raw === "object" && raw !== null) {
        const obj = raw as Record<string, unknown>;
        // Try common english key spellings.
        for (const k of ["english", "English", "en", "eng"]) {
            const v = obj[k];
            if (typeof v === "string" && v.trim()) return v;
            if (v && typeof v === "object") return JSON.stringify(v);
        }
    }
    return "";
}

/** Best-effort: parse a "TRUE" / "FALSE" / true / false / 1 / 0 cell. */
function toBool(v: unknown): boolean {
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
}

// ─── Per-row extraction ─────────────────────────────────────────────────

interface RawRow {
    [key: string]: unknown; // keyed by canonical field name
}

/**
 * Parse the bilingual_options column into [{label, text, html, isCorrect}, ...]
 * Returns [] if the column isn't recognisable.
 *
 * Shape examples seen in PW data:
 *   {"english":[{"isCorrect":true,"text":"<p>−1</p>"}, ...]}
 *   {"english":[{"text":"...","isCorrect":false}, ...]}
 */
function parseOptions(rawOptionsCell: unknown): ParsedQuestionOption[] {
    const obj = safeJSONParse<unknown>(rawOptionsCell);
    if (!obj) return [];
    const englishArr = (() => {
        if (Array.isArray(obj)) return obj;
        if (typeof obj === "object" && obj !== null) {
            const o = obj as Record<string, unknown>;
            for (const k of ["english", "English", "en", "eng"]) {
                if (Array.isArray(o[k])) return o[k] as unknown[];
            }
        }
        return null;
    })();
    if (!englishArr || !Array.isArray(englishArr)) return [];

    return englishArr.map((opt, idx) => {
        const o = (opt && typeof opt === "object" ? opt : {}) as Record<string, unknown>;
        const html = String(o.text ?? o.html ?? "");
        return {
            label: String.fromCharCode(65 + idx), // 0 → "A"
            text: htmlToText(html),
            html,
            isCorrect: toBool(o.isCorrect ?? o.is_correct ?? o.correct),
        };
    });
}

/**
 * Parse the solutions column. Two shapes supported:
 *   - Array:  [{"english": {"text": "<p>...</p>", "videoSolution": {...}}}]
 *   - Object: {"english": {"text": "<p>...</p>", "videoSolution": {...}}}
 */
function parseSolution(rawSolutionsCell: unknown): string {
    const obj = safeJSONParse<unknown>(rawSolutionsCell);
    if (!obj) return typeof rawSolutionsCell === "string" ? rawSolutionsCell : "";

    const root: unknown = Array.isArray(obj) ? obj[0] : obj;
    if (!root || typeof root !== "object") return "";
    const r = root as Record<string, unknown>;

    // Try .english.text first, then .english, then root.text
    const engBlock = (r.english ?? r.English ?? r.en) as
        | Record<string, unknown>
        | string
        | undefined;
    if (typeof engBlock === "string") return engBlock;
    if (engBlock && typeof engBlock === "object") {
        const text = engBlock.text;
        if (typeof text === "string") return text;
    }
    const directText = r.text;
    return typeof directText === "string" ? directText : "";
}

/**
 * Parse the `conceptTags` column to extract chapter and topic english_name.
 *
 * The column stores a JSON array of tag objects. The relevant shapes seen in
 * PW exports are:
 *   [{"chapter":{"english_name":"Kinematics"},"topic":{"english_name":"Motion"}, ...}]
 *
 * The user-provided Google-Sheets regex equivalents are:
 *   chapter: `"chapter".*?"english_name":"([^"]+)"`
 *   topic:   `"topic":\{"english_name":"([^"]+)"`
 *
 * We try strict JSON first; if that fails (embedded quotes, etc.) we fall back
 * to regex scraping — the same technique used in parseExamDetails.
 */
function parseConceptTags(raw: unknown): { chapter: string; topic: string } {
    const fallback = { chapter: "", topic: "" };
    if (!raw) return fallback;
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!s || s === "null") return fallback;

    // ── Strict JSON attempt ───────────────────────────────────────────────
    try {
        const parsed = JSON.parse(s);
        const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr) {
            if (!item || typeof item !== "object") continue;
            const o = item as Record<string, unknown>;
            const pick = (key: string): string => {
                const v = o[key];
                if (!v || typeof v !== "object") return "";
                const inner = v as Record<string, unknown>;
                return String(inner.english_name ?? inner.name ?? "").trim();
            };
            const chapter = pick("chapter");
            const topic = pick("topic");
            if (chapter || topic) return { chapter, topic };
        }
    } catch {
        // fall through to regex
    }

    // ── Regex scraping (handles broken JSON with unescaped inner quotes) ──
    const chapterMatch = /"chapter"[\s\S]*?"english_name"\s*:\s*"([^"]+)"/.exec(s);
    // For topic, the user's formula uses `"topic":\{` to pin the start tightly,
    // avoiding false matches on nested "chapter" objects that also contain
    // "english_name". We mirror that specificity here.
    const topicMatch = /"topic"\s*:\s*\{\s*"english_name"\s*:\s*"([^"]+)"/.exec(s);
    const chapter = chapterMatch ? chapterMatch[1].trim() : "";
    const topic = topicMatch ? topicMatch[1].trim() : "";
    if (chapter || topic) return { chapter, topic };

    return fallback;
}

/**
 * Detect whether a solution cell carries a video-solution URL.
 *
 * Per requirement, we look at the raw `bilingual_solutions` (and `solutions`)
 * cell for a `videoSolution` block with a non-empty `url`. The PW shape is:
 *   {"english":{"text":"...","videoSolution":{"url":"https://.../master.mpd"}}}
 * and an absent video is represented as `"url":""`.
 *
 * We scan the raw string with a regex rather than relying on strict JSON
 * parsing because many PW cells contain embedded quotes that break JSON.parse.
 * Returns true only when at least one non-empty `"url": "<something>"` exists.
 */
function detectVideoSolution(...rawCells: unknown[]): boolean {
    for (const raw of rawCells) {
        if (raw === null || raw === undefined) continue;
        const s = typeof raw === "string" ? raw : JSON.stringify(raw);
        if (!s) continue;
        // Match `"url": "non-empty"` — allow whitespace, require ≥1 char that
        // isn't just an empty string. Anchor to a url-looking value so a stray
        // empty `"url":""` reads as "no video".
        if (/"url"\s*:\s*"(?!\s*")[^"]+"/.test(s)) return true;
    }
    return false;
}

/**
 * Pluck { subject, chapter, topic, klass } from examDetails JSON.
 * Shape: [{"class":{"english_name":"Class 11"},"subject":{"english_name":"Physics"},"chapter":{...},"topic":{...}}]
 */
function parseExamDetails(raw: unknown): {
    subject: string;
    chapter: string;
    topic: string;
    klass: string;
} {
    const fallback = { subject: "", chapter: "", topic: "", klass: "" };
    const obj = safeJSONParse<unknown>(raw);

    if (obj) {
        const first = Array.isArray(obj) ? obj[0] : obj;
        if (first && typeof first === "object") {
            const r = first as Record<string, unknown>;
            const pickName = (key: string): string => {
                const v = r[key];
                if (!v || typeof v !== "object") return "";
                const o = v as Record<string, unknown>;
                return String(o.english_name ?? o.name ?? "");
            };
            const result = {
                subject: pickName("subject"),
                chapter: pickName("chapter"),
                topic: pickName("topic"),
                klass: pickName("class"),
            };
            if (result.subject || result.chapter || result.topic || result.klass) return result;
        }
    }

    // JSON parse failed (the PW dataset has many cells where embedded
    // quotes break strict JSON). Fall back to regex scraping — we only need
    // the english_name strings.
    if (typeof raw === "string" && raw) {
        const scrape = (sectionKey: string): string => {
            // Match `"subject":{ ... "english_name":"Physics" ... }` non-greedy
            // (works because PW always wraps each sub-object in `{...}` once).
            const re = new RegExp(
                `"${sectionKey}"\\s*:\\s*\\{[^}]*?"english_name"\\s*:\\s*"([^"]+)"`
            );
            const m = re.exec(raw);
            return m ? m[1] : "";
        };
        return {
            subject: scrape("subject"),
            chapter: scrape("chapter"),
            topic: scrape("topic"),
            klass: scrape("class"),
        };
    }

    return fallback;
}

/**
 * Determine question type from the available signals. SCQ if exactly one
 * option is marked isCorrect, MCQ if more than one, Numerical if
 * is_range_numerical is true, Integer if is_int_answer is true.
 */
function inferQuestionType(args: {
    options: ParsedQuestionOption[];
    isIntAnswer: boolean;
    isRangeNumerical: boolean;
    rawType?: unknown;
}): ParsedQuestion["questionType"] {
    if (args.isRangeNumerical) return "Numerical";
    if (args.isIntAnswer) return "Integer";
    const correctCount = args.options.filter((o) => o.isCorrect).length;
    if (args.options.length > 0) {
        if (correctCount > 1) return "MCQ";
        if (correctCount >= 1) return "SCQ";
    }
    return "Unknown";
}

/**
 * Resolve the correct answer per user spec:
 *   - SCQ → letter (e.g. "B") of the option where isCorrect=true
 *   - MCQ → comma-joined letters ("A, C")
 *   - Numerical / Integer → raw `answer` column
 */
function resolveCorrectAnswer(
    options: ParsedQuestionOption[],
    questionType: ParsedQuestion["questionType"],
    rawAnswerCell: unknown
): string {
    if (questionType === "SCQ" || questionType === "MCQ") {
        const labels = options.filter((o) => o.isCorrect).map((o) => o.label);
        if (labels.length > 0) return labels.join(", ");
    }
    if (questionType === "Numerical" || questionType === "Integer") {
        if (rawAnswerCell !== null && rawAnswerCell !== undefined) {
            return String(rawAnswerCell).trim();
        }
    }
    // Fallback for "Unknown" — try anything we have.
    if (rawAnswerCell !== null && rawAnswerCell !== undefined) {
        const s = String(rawAnswerCell).trim();
        if (s) return s;
    }
    const labels = options.filter((o) => o.isCorrect).map((o) => o.label);
    return labels.join(", ");
}

// ─── Per-record parsing (reusable outside the CSV/XLSX path) ───────────

export interface ParsedRecordOutcome {
    /** Null when the record had no usable English question content. */
    question: ParsedQuestion | null;
    /** Present when `question` is null — why the record was skipped. */
    warning?: string;
}

/**
 * Parse ONE record already keyed by canonical field names — content,
 * bilingual_options, solutions, bilingual_solutions, answer, is_int_answer,
 * is_range_numerical, examDetails, concept_tags, subject_direct,
 * chapter_direct, topic_direct, class_direct, difficulty, unique_id, slug,
 * type, option_a…e, correct_a…e (see `canonicalField()` above for the full
 * header-name → canonical mapping).
 *
 * Extracted from `parseStructuredPaper()`'s per-row loop (behavior-preserving)
 * so the same parsing logic — notably the SCQ-answer-from-isCorrect-not-the-
 * answer-column rule and the question-type inference — can be reused directly
 * against `public.qbg_question_pool` rows (see qbgPoolAdapter.ts), whose
 * columns already use most of these canonical names. The CSV-specific
 * header-name normalisation (`canonicalField()`) is a separate, prior step
 * that only `parseStructuredPaper()` needs.
 */
export function parseStructuredRecord(record: RawRow, questionNumber: number): ParsedRecordOutcome {
    const get = (canonical: string): unknown => record[canonical];

    // 1. Question content
    const contentRaw = get("content");
    const questionHtml = pickEnglish(safeJSONParse(contentRaw) ?? contentRaw);
    if (!questionHtml || !questionHtml.trim()) {
        return { question: null, warning: "Row skipped: empty / missing English question content." };
    }
    const questionText = htmlToText(questionHtml);

    // 2. Options (bilingual_options OR individual optionA…D columns)
    let options: ParsedQuestionOption[] = parseOptions(get("bilingual_options"));
    if (options.length === 0) {
        // Fallback to optionA/B/C/D columns with isCorrectA/B/C/D flags.
        const letters = ["a", "b", "c", "d", "e"];
        const inline: ParsedQuestionOption[] = [];
        for (let i = 0; i < letters.length; i++) {
            const html = String(get(`option_${letters[i]}`) ?? "");
            if (!html.trim()) continue;
            inline.push({
                label: String.fromCharCode(65 + i),
                text: htmlToText(html),
                html,
                isCorrect: toBool(get(`correct_${letters[i]}`)),
            });
        }
        options = inline;
    }

    // 3. Solution
    const solutionHtmlPrimary = parseSolution(get("solutions"));
    const solutionHtmlSecondary = solutionHtmlPrimary
        ? ""
        : parseSolution(get("bilingual_solutions"));
    const solutionHtml = solutionHtmlPrimary || solutionHtmlSecondary;
    const solutionText = htmlToText(solutionHtml);
    // Video solution presence — checked on the raw cells (before HTML strip).
    const hasVideoSolution = detectVideoSolution(
        get("bilingual_solutions"),
        get("solutions")
    );

    // 4. Exam details — three sources, merged in priority order:
    //    (a) direct flat columns (subject / chapter / topic headers)
    //    (b) conceptTags column — JSON array with chapter/topic english_name
    //    (c) examDetails column — legacy PW JSON with subject/chapter/topic
    const examDetails = parseExamDetails(get("examDetails"));
    const conceptTagsData = parseConceptTags(get("concept_tags"));
    const subjectDirect = String(get("subject_direct") ?? "").trim();
    const chapterDirect = String(get("chapter_direct") ?? "").trim();
    const topicDirect = String(get("topic_direct") ?? "").trim();
    const classDirect = String(get("class_direct") ?? "").trim();
    const subject = subjectDirect || examDetails.subject;
    // conceptTags is preferred over examDetails for chapter/topic because
    // it is the dedicated tagging column and is more reliably populated.
    const chapter = chapterDirect || conceptTagsData.chapter || examDetails.chapter;
    const topic = topicDirect || conceptTagsData.topic || examDetails.topic;
    const klass = classDirect || examDetails.klass;

    // 5. Answer + question type
    const isIntAnswer = toBool(get("is_int_answer"));
    const isRangeNumerical = toBool(get("is_range_numerical"));
    const questionType = inferQuestionType({
        options,
        isIntAnswer,
        isRangeNumerical,
        rawType: get("type"),
    });
    const correctAnswer = resolveCorrectAnswer(options, questionType, get("answer"));

    // 6. Images / diagrams (from question + options + solution HTML)
    const imageUrls = Array.from(
        new Set([
            ...extractImageUrls(questionHtml),
            ...options.flatMap((o) => extractImageUrls(o.html)),
            ...extractImageUrls(solutionHtml),
        ])
    );
    // Also flag if the question text mentions "figure" / "diagram" / "graph"
    // — caller can decide what to do with that signal.
    // (We just include URL list; the agent prompt will set hasFigure=true.)

    // 7. Difficulty (numeric, sometimes blank)
    const diffRaw = get("difficulty");
    const diffNum =
        diffRaw === "" || diffRaw === null || diffRaw === undefined
            ? null
            : Number(diffRaw);
    const difficulty = Number.isFinite(diffNum) ? (diffNum as number) : null;

    // 8. Source id — the QBG unique id (preferred) used to deep-link the
    //    question in the report; fall back to the slug if no unique_id.
    const sourceId =
        (String(get("unique_id") ?? "").trim() ||
            String(get("slug") ?? "").trim()) ||
        undefined;

    return {
        question: {
            questionNumber,
            questionText,
            questionHtml,
            options,
            correctAnswer,
            questionType,
            solutionText,
            solutionHtml,
            subject,
            chapter,
            topic,
            klass,
            difficulty,
            hasVideoSolution,
            imageUrls,
            sourceId,
        },
    };
}

// ─── Main entry point ──────────────────────────────────────────────────

/**
 * Parse an uploaded CSV / XLSX / XLS / ODS file. Accepts either an ArrayBuffer
 * (from File.arrayBuffer()) or a Uint8Array.
 */
export async function parseStructuredPaper(
    fileData: ArrayBuffer | Uint8Array,
    fileName: string
): Promise<ParseStructuredResult> {
    // xlsx auto-detects format from content; type="array" works for all formats.
    const wb = XLSX.read(fileData, {
        type: "array",
        cellDates: false,
        cellNF: false,
        cellText: true,
    });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
        return {
            questions: [],
            warnings: [{ rowIndex: 0, message: `No sheets found in ${fileName}` }],
            subjects: [],
            matchedColumns: {},
        };
    }
    const sheet = wb.Sheets[sheetName];

    // Use raw=false so xlsx coerces numbers to formatted strings — keeps the
    // is_int_answer "TRUE"/"FALSE" cells readable.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: false,
    });

    if (rows.length === 0) {
        return {
            questions: [],
            warnings: [{ rowIndex: 0, message: "Sheet is empty." }],
            subjects: [],
            matchedColumns: {},
        };
    }

    // Build header → canonical map from the first row's keys.
    const headerKeys = Object.keys(rows[0]);
    const matchedColumns: Record<string, string> = {};
    const headerByCanonical: Record<string, string> = {};
    for (const h of headerKeys) {
        const norm = normHeader(h);
        const canonical = canonicalField(norm);
        if (canonical) {
            matchedColumns[h] = canonical;
            // Keep the FIRST header we see for each canonical (in case of dupes).
            if (!headerByCanonical[canonical]) headerByCanonical[canonical] = h;
        }
    }
    if (!headerByCanonical.content) {
        return {
            questions: [],
            warnings: [
                {
                    rowIndex: 0,
                    message:
                        "Required column for question content not found. " +
                        'Expected one of: "content", "question", "questionText", "body". ' +
                        `Sheet headers: ${headerKeys.slice(0, 12).join(", ")}${headerKeys.length > 12 ? ", …" : ""}`,
                },
            ],
            subjects: [],
            matchedColumns,
        };
    }

    // ─── Extract per row ────────────────────────────────────────────────
    const questions: ParsedQuestion[] = [];
    const warnings: { rowIndex: number; message: string }[] = [];
    const subjectSet = new Set<string>();

    rows.forEach((row, idx) => {
        const canonicalRecord: RawRow = {};
        for (const [canonical, header] of Object.entries(headerByCanonical)) {
            canonicalRecord[canonical] = row[header];
        }

        const outcome = parseStructuredRecord(canonicalRecord, questions.length + 1);
        if (!outcome.question) {
            warnings.push({ rowIndex: idx + 1, message: outcome.warning || "Row skipped." });
            return;
        }
        if (outcome.question.subject) subjectSet.add(outcome.question.subject);
        questions.push(outcome.question);
    });

    return {
        questions,
        warnings,
        subjects: Array.from(subjectSet),
        matchedColumns,
    };
}

/**
 * Build a plaintext "synthetic paper" that the QC agents can read in lieu
 * of a PDF. Format mirrors how a typical printed paper looks so existing
 * prompts work unchanged.
 */
export function buildSyntheticPaperText(questions: ParsedQuestion[]): string {
    const blocks: string[] = [];
    blocks.push(
        `# Question Paper (structured upload — ${questions.length} questions)`
    );
    blocks.push(
        "This paper was uploaded as a structured CSV / Excel file. " +
            "Each question below includes its English text, options, the provided " +
            "answer key, the provided solution, and a list of any image / diagram " +
            "URLs that appear in the source. The Hindi and other-language fields " +
            "from the source have been intentionally dropped — review the English " +
            "content only."
    );
    blocks.push("");

    for (const q of questions) {
        const lines: string[] = [];
        lines.push(`---`);
        lines.push(
            `Q${q.questionNumber}.${q.subject ? ` [${q.subject}${q.chapter ? " · " + q.chapter : ""}${q.topic ? " · " + q.topic : ""}]` : ""}`
        );
        lines.push(q.questionText || "(empty)");
        if (q.imageUrls.length > 0) {
            lines.push("");
            lines.push(
                `[Diagram references — this question contains figures the agent cannot directly see; flag hasFigure=true and note any reliance on the diagram]:`
            );
            for (const url of q.imageUrls) lines.push(`  • ${url}`);
        }
        if (q.options.length > 0) {
            lines.push("");
            lines.push("Options:");
            for (const o of q.options) {
                lines.push(`  ${o.label}) ${o.text}`);
            }
        }
        lines.push("");
        lines.push(`Question Type: ${q.questionType}`);
        lines.push(`Provided Answer Key: ${q.correctAnswer || "(none)"}`);
        if (q.solutionText) {
            lines.push("");
            lines.push("Provided Solution:");
            lines.push(q.solutionText);
        }
        blocks.push(lines.join("\n"));
    }
    return blocks.join("\n\n");
}
