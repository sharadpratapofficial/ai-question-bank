/**
 * Value normalisers. Every function returns a NormResult:
 *
 *   { raw_value, normalized_value, normalization_rule, confidence, status }
 *
 *   confidence: "high" | "medium" | "low"
 *   status:     "OK"           normalised (possibly unchanged)
 *               "EMPTY"        raw value absent
 *               "UNRESOLVED"   could not be normalised safely; normalized_value is null
 *                              and the record belongs in a review queue
 *
 * The raw value is always carried through untouched. Nothing here guesses:
 * when a value is ambiguous the result is UNRESOLVED, never a best guess.
 * Vocabulary choices (e.g. "Maths", "JEE Main") are INFERRED conventions,
 * documented in docs/data_recovery/INFERENCE_LOG.md.
 */
import { normalizeQbgId as idNorm, extractDriveId, QBG_CUID25_RE, UUID_RE } from "./ids.mjs";

const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const res = (raw, value, rule, confidence = "high", status = "OK") => ({ raw_value: raw ?? null, normalized_value: value, normalization_rule: rule, confidence, status });
const empty = (raw) => res(raw, null, "EMPTY", "high", "EMPTY");
const unresolved = (raw, rule) => res(raw, null, rule, "low", "UNRESOLVED");

/** Trim + collapse internal whitespace (incl. NBSP). The only rewrite applied to free text. */
export function cleanWhitespace(v) {
    if (blank(v)) return null;
    return String(v).replace(/[  -​　]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- question type
/** Canonical labels are the app's QuestionType strings (src/types/index.ts) plus QBG's COMP. */
const QTYPE_MAP = new Map(Object.entries({
    "single_choice(scq)": "Single_Choice(SCQ)", scq: "Single_Choice(SCQ)", "single correct": "Single_Choice(SCQ)",
    "multi_choice(mcq)": "Multi_Choice(MCQ)", mcq: "Multi_Choice(MCQ)",
    numerical: "Numerical", num: "Numerical", numerial: "Numerical",
    integer: "Integer", int: "Integer",
    "single digit": "Single_Digit_Integer", "single digit integer": "Single_Digit_Integer",
    "comprehension(comp)": "Comprehension(COMP)", comp: "Comprehension(COMP)",
    "matching_list(ml)": "Matching_List(ML)", list: "Matching_List(ML)",
    "assertion_reason(ar)": "Assertion_Reason(AR)",
}));
/** Passage sub-types seen in question_type_original ("Para", "Para-Num", "Para_Num1"...). */
const PASSAGE_RE = /^para(?:[-_ ]?(num))?[-_ ]?\d*$/i;

export function normalizeQuestionType(raw) {
    if (blank(raw)) return empty(raw);
    const s = cleanWhitespace(raw);
    const key = s.toLowerCase();
    if (QTYPE_MAP.has(key)) {
        const v = QTYPE_MAP.get(key);
        const rule = v === s ? "IDENTITY" : key === "numerial" ? "TYPO_NUMERIAL" : "ALIAS_TABLE";
        return res(raw, v, rule);
    }
    const m = s.match(PASSAGE_RE);
    if (m) return res(raw, m[1] ? "Passage_Numerical" : "Comprehension(COMP)", "PASSAGE_ALIAS", "medium");
    return unresolved(raw, "UNKNOWN_QUESTION_TYPE");
}

/** Types whose answer is an option index (1-based) rather than a value. */
export const OPTION_TYPES = new Set(["Single_Choice(SCQ)", "Multi_Choice(MCQ)", "Assertion_Reason(AR)", "Matching_List(ML)"]);
export const VALUE_TYPES = new Set(["Numerical", "Integer", "Single_Digit_Integer", "Passage_Numerical"]);

// ---------------------------------------------------------------- difficulty
const DIFF_BY_CODE = { 1: "Easy", 2: "Medium", 3: "Hard" };
export function normalizeDifficulty(raw) {
    if (blank(raw)) return empty(raw);
    const s = cleanWhitespace(raw);
    if (/^[123]$/.test(s)) return res(raw, DIFF_BY_CODE[s], "QBG_CODE_1_2_3");
    const k = s.toLowerCase();
    if (k === "easy") return res(raw, "Easy", s === "Easy" ? "IDENTITY" : "CASE");
    if (k === "medium" || k === "moderate") return res(raw, "Medium", s === "Medium" ? "IDENTITY" : k === "moderate" ? "ALIAS_MODERATE" : "CASE");
    if (k === "hard") return res(raw, "Hard", s === "Hard" ? "IDENTITY" : "CASE");
    if (k === "difficult") return res(raw, "Hard", "ALIAS_DIFFICULT", "medium");
    if (s === "0") return res(raw, null, "QBG_CODE_0_UNSET", "high", "EMPTY");
    return unresolved(raw, "UNKNOWN_DIFFICULTY");
}

// ---------------------------------------------------------------- subject
/** "Maths" is the name QBG's own taxonomy uses for subject id 19c8p297y48dy01537cxzinys. */
const SUBJECT_MAP = new Map(Object.entries({
    physics: "Physics", chemistry: "Chemistry", maths: "Maths", math: "Maths",
    mathematics: "Maths", mathethatics: "Maths", mathemathics: "Maths",
    biology: "Biology", botany: "Botany", zoology: "Zoology",
}));
export function normalizeSubject(raw) {
    if (blank(raw)) return empty(raw);
    const s = cleanWhitespace(raw);
    const v = SUBJECT_MAP.get(s.toLowerCase());
    if (!v) {
        if (s.toUpperCase() === "PCM") return unresolved(raw, "MULTI_SUBJECT_PCM");
        return unresolved(raw, "UNKNOWN_SUBJECT");
    }
    if (v === s) return res(raw, v, "IDENTITY");
    if (["mathethatics", "mathemathics"].includes(s.toLowerCase())) return res(raw, v, "TYPO_MATHEMATICS", "medium");
    return res(raw, v, s.toLowerCase() === v.toLowerCase() ? "CASE" : "ALIAS_MATHS");
}

// ---------------------------------------------------------------- class level
/**
 * QBG class level ("9".."12"). Anything else in a class column (AutoCuration's
 * `class` column also holds solution file names / Drive URLs for some batches)
 * is NOT a class; the caller keeps it as a document reference instead.
 */
export function normalizeClassLevel(raw) {
    if (blank(raw)) return empty(raw);
    const s = cleanWhitespace(raw);
    let m = s.match(/^(?:class\s*)?(9|10|11|12)(?:th)?$/i);
    if (m) return res(raw, m[1], s === m[1] ? "IDENTITY" : "STRIP_SUFFIX");
    const roman = { ix: "9", x: "10", xi: "11", xii: "12" }[s.toLowerCase()];
    if (roman) return res(raw, roman, "ROMAN_NUMERAL");
    if (/^12th\s*&\s*dropper$/i.test(s)) return res(raw, "12", "DROPPER_AS_12", "medium");
    return unresolved(raw, /\.(pdf|docx?)$/i.test(s) || /^https?:/i.test(s) ? "NOT_A_CLASS_DOCUMENT_REF" : "NOT_A_CLASS");
}

// ---------------------------------------------------------------- exam
/** Exam family + optional paper. Canonical family labels: "JEE Main", "JEE Advanced", "NEET". */
export function normalizeExam(raw) {
    if (blank(raw)) return empty(raw);
    const s = cleanWhitespace(raw);
    const k = s.toLowerCase();
    let paper = null;
    const pm = k.match(/(?:_|\s|^)p(?:aper)?\s*[-_ ]?([12])\b/);
    if (pm) paper = Number(pm[1]);
    if (/^(jee\s*)?mains?$/.test(k)) return res(raw, { exam: "JEE Main", paper }, "ALIAS_MAIN");
    if (/^(jee\s*)?adv(ance|anced)?\b/.test(k) || /^advance_p[12]$/.test(k)) return res(raw, { exam: "JEE Advanced", paper }, "ALIAS_ADVANCED");
    if (/^\d{4}_p[12]$/.test(k)) return res(raw, { exam: null, paper, year: Number(k.slice(0, 4)) }, "YEAR_PAPER_ONLY", "medium");
    if (/^neet/.test(k)) return res(raw, { exam: "NEET", paper }, "ALIAS_NEET");
    return unresolved(raw, "UNKNOWN_EXAM");
}

// ---------------------------------------------------------------- taxonomy names
/**
 * Chapter/topic/subtopic display names. Only whitespace is collapsed and a
 * single pair of wrapping [brackets] (Onepass sheet convention) is removed.
 * "-" is a placeholder meaning "no value", not a name.
 */
export function normalizeTaxonomyName(raw) {
    if (blank(raw)) return empty(raw);
    let s = cleanWhitespace(raw);
    const rules = [];
    if (s !== String(raw)) rules.push("WHITESPACE");
    if (/^-+$/.test(s)) return res(raw, null, "PLACEHOLDER_DASH", "high", "EMPTY");
    if (QBG_CUID25_RE.test(s)) return unresolved(raw, "ID_IN_NAME_COLUMN");
    const b = s.match(/^\[(.+)\]$/);
    if (b) { s = b[1].trim(); rules.push("STRIP_BRACKETS"); }
    return res(raw, s, rules.length ? rules.join("+") : "IDENTITY");
}

/** Key used only to compare two names for equality (never stored as a value). */
export function taxonomyCompareKey(name) {
    return name == null ? null : String(name).normalize("NFKC").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------- identifiers
export function normalizeQbgIdValue(raw) {
    const r = idNorm(raw);
    if (r.valid) return res(raw, r.value, r.reason || "IDENTITY");
    if (r.reason === "NULL" || r.reason === "EMPTY") return empty(raw);
    return unresolved(raw, `INVALID_QBG_ID:${r.reason}`);
}

/** parent_question_id: may be a QBG cuid or a UUID; historical type UNKNOWN, so both are accepted verbatim. */
export function normalizeParentId(raw) {
    if (blank(raw)) return empty(raw);
    const s = String(raw).trim();
    if (QBG_CUID25_RE.test(s)) return res(raw, s, "QBG_CUID25");
    if (UUID_RE.test(s)) return res(raw, s.toLowerCase(), s === s.toLowerCase() ? "UUID" : "UUID_LOWERCASE");
    return unresolved(raw, "UNKNOWN_PARENT_ID_FORMAT");
}

// ---------------------------------------------------------------- links
/**
 * Classify a link/URL. Returns normalized_value = { kind, id, url } where kind is
 * QBG_QUESTION_PAGE | DRIVE_FILE | DRIVE_FOLDER | GOOGLE_SHEET | GOOGLE_DOC | OTHER_URL.
 * Nothing is fetched.
 */
export function normalizeLink(raw) {
    if (blank(raw)) return empty(raw);
    let s = String(raw).trim().replace(/&amp;/g, "&");
    const rules = [];
    if (/^-https?:\/\//.test(s)) { s = s.slice(1); rules.push("STRIP_LEADING_DASH"); }
    if (!/^https?:\/\//i.test(s)) return unresolved(raw, "NOT_A_URL");
    let m = s.match(/^https?:\/\/(qbg-admin\.penpencil\.co|qbg\.physicswallah\.live)\/question-details\?question=([a-z0-9]{25})\b/);
    if (m) return res(raw, { kind: "QBG_QUESTION_PAGE", host: m[1], id: m[2], url: s }, ["QBG_PAGE", ...rules].join("+"));
    if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders\//.test(s)) {
        const f = s.match(/folders\/([A-Za-z0-9_-]+)/);
        return res(raw, { kind: "DRIVE_FOLDER", id: f ? f[1] : null, url: s }, ["DRIVE_FOLDER", ...rules].join("+"));
    }
    m = s.match(/docs\.google\.com\/(spreadsheets|document|presentation)\/d\/([A-Za-z0-9_-]+)/);
    if (m) return res(raw, { kind: m[1] === "spreadsheets" ? "GOOGLE_SHEET" : m[1] === "document" ? "GOOGLE_DOC" : "GOOGLE_SLIDES", id: m[2], url: s }, ["GOOGLE_DOCS", ...rules].join("+"));
    const d = /drive\.google\.com/.test(s) ? extractDriveId(s) : null;
    if (d) return res(raw, { kind: "DRIVE_FILE", id: d, url: `https://drive.google.com/file/d/${d}` }, ["DRIVE_FILE_ID", ...rules].join("+"));
    return res(raw, { kind: "OTHER_URL", id: null, url: s }, ["OTHER_URL", ...rules].join("+"), "medium");
}

// ---------------------------------------------------------------- answer key
/**
 * Normalise an answer to the app's answer_key shape:
 *   option types -> 1-based index array, e.g. [3] or [1,3]
 *   Integer      -> number (only when the raw has no decimal point)
 *   Numerical    -> number for bare integers, else the raw decimal string ("2.50" stays "2.50")
 * The question type must already be normalised. Option count defaults to 4.
 */
export function normalizeAnswer(raw, questionType, optionCount = 4) {
    if (blank(raw)) return { ...empty(raw), answer_kind: "UNKNOWN" };
    const s = typeof raw === "number" ? String(raw) : cleanWhitespace(raw);
    const isNumberRaw = typeof raw === "number";

    const parseIndexes = () => {
        const parts = s.split(/[,;/&\s]+|\band\b/i).filter(Boolean);
        const out = [];
        let rule = "OPTION_INDEX_LIST";
        for (const p of parts) {
            if (/^[1-9]\d?$/.test(p)) out.push(Number(p));
            else if (/^\(?[A-Ha-h]\)?$/.test(p)) { out.push(p.replace(/[()]/g, "").toUpperCase().charCodeAt(0) - 64); rule = "OPTION_LETTER_TO_INDEX"; }
            else if (/^\(\d\)$/.test(p)) out.push(Number(p.slice(1, -1)));
            else return null;
        }
        return out.length ? { out, rule } : null;
    };

    if (OPTION_TYPES.has(questionType)) {
        const p = parseIndexes();
        if (!p) return { ...unresolved(raw, "UNPARSEABLE_OPTION_ANSWER"), answer_kind: "UNKNOWN" };
        if (p.out.some((i) => i < 1 || i > optionCount)) return { ...unresolved(raw, "OPTION_INDEX_OUT_OF_RANGE"), answer_kind: "UNKNOWN" };
        if (new Set(p.out).size !== p.out.length) return { ...unresolved(raw, "DUPLICATE_OPTION_INDEX"), answer_kind: "UNKNOWN" };
        if (questionType !== "Multi_Choice(MCQ)" && p.out.length > 1) return { ...unresolved(raw, "MULTIPLE_ANSWERS_FOR_SINGLE_CORRECT_TYPE"), answer_kind: "UNKNOWN" };
        return { ...res(raw, p.out, p.rule), answer_kind: questionType === "Multi_Choice(MCQ)" ? "MCQ" : "SCQ" };
    }

    if (VALUE_TYPES.has(questionType)) {
        if (/^-?\d+$/.test(s)) return { ...res(raw, Number(s), "INTEGER_VALUE"), answer_kind: "INTEGER" };
        if (/^-?\d*\.\d+$/.test(s)) {
            if (questionType === "Integer" || questionType === "Single_Digit_Integer") {
                // "4.00" for an Integer type: the string is kept, flagged medium, never truncated.
                return { ...res(raw, s, "DECIMAL_FOR_INTEGER_TYPE_KEPT_AS_STRING", "medium"), answer_kind: "NUMERICAL_STRING" };
            }
            return { ...res(raw, s, isNumberRaw ? "EXCEL_NUMBER_AS_STRING" : "DECIMAL_STRING_KEPT"), answer_kind: "NUMERICAL_STRING" };
        }
        const range = s.match(/^(-?\d*\.?\d+)\s*(?:to|-|–)\s*(-?\d*\.?\d+)$/i);
        if (range) return { ...res(raw, { min: range[1], max: range[2] }, "NUMERIC_RANGE", "medium"), answer_kind: "NUMERICAL_RANGE" };
        return { ...unresolved(raw, "UNPARSEABLE_NUMERIC_ANSWER"), answer_kind: "UNKNOWN" };
    }

    // Comprehension or unknown type: a lone "3" could be option 3 or the value 3.
    return { ...unresolved(raw, `AMBIGUOUS_FOR_TYPE:${questionType || "NULL"}`), answer_kind: "UNKNOWN" };
}

// ---------------------------------------------------------------- options
/**
 * Options arrive either as real option texts (from a document) or as the
 * AutoCuration "Option Text" column, which only ever holds option LABELS
 * ("A~B~C~D") or UI placeholder text. Labels are never turned into options.
 */
export function normalizeOptions(raw, answerIndexes = null, questionType = null) {
    if (Array.isArray(raw)) {
        const texts = raw.map((t) => (t === null || t === undefined ? null : String(t)));
        if (!texts.length) return { ...empty(raw), options_status: "NO_OPTIONS" };
        if (texts.some((t) => t === null || !t.trim())) return { ...unresolved(raw, "EMPTY_OPTION_TEXT"), options_status: "INCOMPLETE" };
        const idx = Array.isArray(answerIndexes) ? new Set(answerIndexes) : null;
        const normalized = texts.map((text, i) => ({ text, isCorrect: idx ? idx.has(i + 1) : null }));
        return { ...res(raw, normalized, idx ? "TEXTS_WITH_ANSWER" : "TEXTS_WITHOUT_ANSWER", idx ? "high" : "medium"), options_status: "OPTION_TEXTS" };
    }
    if (blank(raw)) {
        if (questionType && VALUE_TYPES.has(questionType)) return { ...res(raw, [], "VALUE_TYPE_HAS_NO_OPTIONS"), options_status: "NOT_APPLICABLE" };
        return { ...empty(raw), options_status: "MISSING" };
    }
    const s = cleanWhitespace(raw);
    if (/^[A-Ha-h](\s*~\s*[A-Ha-h])+$/.test(s)) return { ...res(raw, null, "LABELS_ONLY_NOT_CONTENT"), options_status: "OPTION_LABELS_ONLY", option_labels: s.split("~").map((x) => x.trim()) };
    if (/select and submit/i.test(s)) return { ...res(raw, null, "UI_PLACEHOLDER_NOT_CONTENT"), options_status: "PLACEHOLDER_TEXT" };
    return { ...unresolved(raw, "UNRECOGNISED_OPTION_CELL"), options_status: "UNKNOWN" };
}

// ---------------------------------------------------------------- question / solution text
/** Light HTML-preserving cleanup for stored text: whitespace only. Markup, MathML and <img> are kept. */
export function normalizeRichText(raw) {
    if (blank(raw)) return empty(raw);
    const s = String(raw).replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return res(raw, s, s === raw ? "IDENTITY" : "WHITESPACE");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/**
 * Comparison key for duplicate detection ONLY (never stored as content):
 * strip tags, decode common entities, NFKC, lower-case, drop punctuation and
 * whitespace. MathML/equation markup is reduced to its text tokens.
 */
export function dedupeKey(text) {
    if (blank(text)) return null;
    const s = String(text)
        .replace(/<img[^>]*>/gi, " IMG ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
            if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
            return ENTITIES[e.toLowerCase()] ?? " ";
        })
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    return s || null;
}
