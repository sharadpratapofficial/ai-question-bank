/**
 * Identifier classification. Each identifier system is kept separate: two
 * values are only ever treated as the same object when they come from the same
 * system AND are byte-identical (after trimming surrounding whitespace, which
 * is recorded, never silent).
 */

/** QBG platform ids: 25 lowercase base-36 chars (question unique_ids AND taxonomy ids share this shape). */
export const QBG_CUID25_RE = /^[a-z0-9]{25}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DRIVE_URL_RE = /drive\.google\.com|docs\.google\.com/i;
export const PYQ_ID_RE = /^PYQ[-_ ]?[A-Z0-9-]+$/i;
export const TC_ID_RE = /^TC-[A-Z]{2,5}-\d{2,4}$/;
export const PA_ID_RE = /^PA-[A-Z]{2,5}-\d{2,4}$/;
export const RQ_ID_RE = /^RQ-[A-Z0-9-]+$/i;
export const QNUM_RE = /^Q?\s*0*(\d{1,4})$/i;

/** Extract a Google Drive file id from a Drive/Docs URL; null when the URL has no recognisable id. */
export function extractDriveId(url) {
    if (typeof url !== "string") return null;
    const m = url.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
}

/**
 * Classify one raw value. Returns a coarse format label; this says what the
 * value LOOKS like, not what it IS. Field-level meaning is decided by the
 * forensics stage using column context.
 */
export function classifyValue(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return Number.isInteger(v) ? "INTEGER" : "DECIMAL";
    if (typeof v === "boolean") return "BOOLEAN";
    const s = String(v).trim();
    if (!s) return "EMPTY";
    if (QBG_CUID25_RE.test(s)) return "QBG_CUID25";
    if (UUID_RE.test(s)) return "UUID";
    if (/^https?:\/\//i.test(s)) return DRIVE_URL_RE.test(s) ? (extractDriveId(s) ? "DRIVE_URL" : "GOOGLE_URL_NO_ID") : "URL";
    if (TC_ID_RE.test(s)) return "TC_ID";
    if (PA_ID_RE.test(s)) return "PA_ID";
    if (RQ_ID_RE.test(s)) return "RQ_ID";
    if (/^PYQ[-_]/i.test(s)) return "PYQ_ID";
    if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(s)) return "FILE_NAME";
    if (/^Q\d{1,4}$/i.test(s)) return "QUESTION_NUMBER";
    if (/^-?\d+$/.test(s)) return "INTEGER_STRING";
    if (/^-?\d*\.\d+$/.test(s)) return "DECIMAL_STRING";
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) return "EMAIL";
    if (/^[a-z0-9]{20,30}$/.test(s)) return "LOWER_ALNUM_20_30";
    return "TEXT";
}

/**
 * Normalise a candidate QBG id. Trims whitespace only. Never lower-cases or
 * otherwise rewrites: a value that is not already a well-formed id is reported
 * as invalid, with the reason, and is NOT used as an identity key.
 */
export function normalizeQbgId(raw) {
    if (raw === null || raw === undefined) return { value: null, valid: false, reason: "NULL" };
    const original = String(raw);
    const trimmed = original.trim();
    if (!trimmed) return { value: null, valid: false, reason: "EMPTY" };
    if (QBG_CUID25_RE.test(trimmed)) {
        return { value: trimmed, valid: true, reason: trimmed === original ? null : "TRIMMED_WHITESPACE" };
    }
    if (QBG_CUID25_RE.test(trimmed.toLowerCase())) return { value: trimmed, valid: false, reason: "UPPERCASE_CHARS" };
    return { value: trimmed, valid: false, reason: `BAD_FORMAT(len=${trimmed.length})` };
}

/** Normalise a question number cell ("Q038", 38, "38") to an integer; null when it is not a question number. */
export function normalizeQuestionNumber(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : null;
    const m = String(raw).trim().match(QNUM_RE);
    return m ? Number(m[1]) : null;
}
