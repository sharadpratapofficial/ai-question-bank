/**
 * Optional QBG bulk-export support (QBG_data.csv or an equivalent authorized
 * CSV / JSON / JSONL export). The export is NOT in the repository today; every
 * function here must behave correctly when it is absent (status NOT_PRESENT).
 *
 * Evidence for the formats accepted (verified from this repository, not assumed):
 *   - column names + header aliases: python/qbg_pool_import/import_pool.py
 *     (_COLUMNS, _HEADER_ALIASES) - the loader that consumed the historical export
 *   - payload shapes: python/qbg_modification/qbg.py build_payload() and
 *     _inspect_types.py:
 *       content            {"english": "<html>"}
 *       bilingual_options  {"english": [{"text": "<html>", "isCorrect": bool}, ...]}
 *       solutions          [{"english": {"text": "<html>", ...}}]
 *       bilingual_solutions {"english": {"text": "<html>", ...}}
 *       answer             {"english": "<value>"} - numerical types only; option
 *                          answers are carried by the isCorrect flags
 *       type               1 SCQ, 2 MCQ, 3 NUMERICAL, 7 ASSERTION_REASON,
 *                          9 MATCHING_LIST, 8 Comprehension, 5 Subjective
 *
 * Rules:
 *   - rows join on the normalised `unique_id` (trim only; must be a well-formed
 *     QBG id). Nothing else is used as the join key. A `QBGFileId` column, if one
 *     exists, is carried as an opaque value and never treated as a QBG id.
 *   - nothing is inferred: a field whose shape is not one of the verified shapes
 *     stays null with an issue code; the raw cell is kept.
 *   - duplicate rows for one unique_id: identical content -> one value;
 *     differing content -> no value (AMBIGUOUS) and a conflict.
 *   - no database access, no network.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeQbgId, QBG_CUID25_RE } from "./ids.mjs";
import {
    normalizeQuestionType, normalizeSubject, normalizeTaxonomyName, normalizeClassLevel,
    normalizeDifficulty, normalizeAnswer, normalizeRichText, cleanWhitespace, OPTION_TYPES, VALUE_TYPES,
} from "./normalize.mjs";

export const QBG_EXPORT_DROP_DIR = "data/raw/qbg";
/** Root-level names the historical loader and .gitignore use (/QBG_data*.csv). */
const ROOT_NAME_RE = /^QBG_data[^/\\]*\.csv$/i;
const DROP_EXT_RE = /\.(csv|json|jsonl)$/i;

/** QBG numeric type codes (python/qbg_modification/qbg.py TYPE_CODES / UNSUPPORTED_TYPE_CODES). */
export const QBG_TYPE_CODES = {
    1: "Single_Choice(SCQ)", 2: "Multi_Choice(MCQ)", 3: "Numerical",
    7: "Assertion_Reason(AR)", 9: "Matching_List(ML)", 8: "Comprehension(COMP)",
};

/** Extra spellings seen in QBG/app payloads that the workbook normaliser does not list. */
const EXTRA_QTYPE = new Map(Object.entries({
    "multiple_choice(mcq)": "Multi_Choice(MCQ)",
    "assertion_reason": "Assertion_Reason(AR)",
    "matching_list": "Matching_List(ML)",
    "numerical_value": "Numerical",
}));

/**
 * Canonical key <- accepted header spellings. Matching is case-insensitive on the
 * header after trimming. Mirrors import_pool.py (_COLUMNS + _HEADER_ALIASES) and
 * adds the app's own qbg_questions column names for backups of that table.
 */
const HEADER_ALIASES = {
    unique_id: ["unique_id"],
    qbg_id: ["qbg_id", "qbgid"],
    type: ["type"],
    question_type: ["question_type"],
    difficulty_level: ["difficulty_level", "difficulty_level000", "difficutly_level"],
    difficulty: ["difficulty"],
    source: ["Source", "source"],
    subject: ["subject"],
    chapter: ["chapter"],
    topic: ["topic"],
    subtopic: ["SubtopicName", "subtopic"],
    class_level: ["Class", "class", "class_level"],
    content: ["content"],
    bilingual_options: ["bilingual_options"],
    answer: ["answer"],
    solutions: ["solutions"],
    bilingual_solutions: ["bilingual_solutions"],
    parent_question_id: ["parent_question_id"],
    child_questions: ["child_questions"],
    verification_status: ["verification_status"],
    qc_status: ["QC_Status", "qc_status", "QC Status"],
    created_at: ["created_at"],
    updated_at: ["updated_at"],
    // app qbg_questions backups
    question_id: ["question_id"],
    question_text: ["question_text"],
    options: ["options"],
    answer_key: ["answer_key"],
    solution_text: ["solution_text"],
    // opaque, never an identity
    qbg_file_id: ["QBGFileId", "qbg_file_id", "qbgfileid"],
};
const ALIAS_TO_KEY = new Map();
for (const [key, names] of Object.entries(HEADER_ALIASES)) for (const n of names) ALIAS_TO_KEY.set(n.toLowerCase(), key);

/** Map a header row to canonical keys. Unknown headers are kept (reported, never used). */
export function mapHeaders(headers) {
    const keys = headers.map((h) => ALIAS_TO_KEY.get(String(h ?? "").trim().toLowerCase()) ?? null);
    const seen = new Map();
    const duplicates = [];
    keys.forEach((k, i) => { if (!k) return; if (seen.has(k)) duplicates.push(`${k} (${headers[seen.get(k)]} / ${headers[i]})`); else seen.set(k, i); });
    return {
        keys,
        recognised: [...seen.keys()].sort(),
        unrecognised: headers.filter((h, i) => !keys[i]).map((h) => String(h)),
        duplicate_columns: duplicates,
    };
}

// ------------------------------------------------------------------ file discovery
/**
 * Candidate export files, in a deterministic order:
 *   1. QBG_EXPORT_FILE (env), if set
 *   2. repository root files named QBG_data*.csv (historical location)
 *   3. data/raw/qbg/*.csv|*.json|*.jsonl
 */
export function findQbgExportFiles(repoRoot, env = process.env) {
    const out = [];
    const add = (p) => { const abs = path.resolve(repoRoot, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile() && !out.includes(abs)) out.push(abs); };
    if (env.QBG_EXPORT_FILE) add(env.QBG_EXPORT_FILE);
    if (fs.existsSync(repoRoot)) for (const f of fs.readdirSync(repoRoot).sort()) if (ROOT_NAME_RE.test(f)) add(f);
    const drop = path.join(repoRoot, QBG_EXPORT_DROP_DIR);
    if (fs.existsSync(drop)) for (const f of fs.readdirSync(drop).sort()) if (DROP_EXT_RE.test(f)) add(path.join(QBG_EXPORT_DROP_DIR, f));
    return out;
}

export function exportFormat(file) {
    const e = path.extname(file).toLowerCase();
    return e === ".csv" ? "CSV" : e === ".jsonl" ? "JSONL" : e === ".json" ? "JSON" : "UNKNOWN";
}

// ------------------------------------------------------------------ streaming readers
/**
 * RFC 4180 CSV over an async iterable of string chunks (quoted fields, embedded
 * newlines, "" escapes, CRLF). Yields one array of fields per record. Needed
 * because the historical export is ~190 MB.
 */
export async function* parseCsvChunks(chunks) {
    let row = [], field = "", inQuotes = false, pendingQuote = false, pendingCR = false, first = true;
    for await (let chunk of chunks) {
        if (first) { if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); first = false; }
        for (let i = 0; i < chunk.length; i++) {
            const c = chunk[i];
            if (pendingCR) { pendingCR = false; if (c === "\n") continue; }
            if (pendingQuote) {
                pendingQuote = false;
                if (c === '"') { field += '"'; continue; }
                inQuotes = false; // closing quote; fall through to handle c unquoted
            }
            if (inQuotes) {
                if (c === '"') pendingQuote = true; else field += c;
                continue;
            }
            if (c === '"') inQuotes = true;
            else if (c === ",") { row.push(field); field = ""; }
            else if (c === "\n" || c === "\r") { row.push(field); yield row; row = []; field = ""; if (c === "\r") pendingCR = true; }
            else field += c;
        }
    }
    if (pendingQuote) inQuotes = false;
    if (field !== "" || row.length) { row.push(field); yield row; }
}

async function* fileChunks(file) {
    for await (const c of fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })) yield c;
}

/** Yields { row_number, record } where record is keyed by the ORIGINAL header names. */
export async function* readExportRecords(file) {
    const fmt = exportFormat(file);
    if (fmt === "CSV") {
        let headers = null, n = 0;
        for await (const fields of parseCsvChunks(fileChunks(file))) {
            n++;
            if (!headers) { headers = fields.map((h) => String(h).trim()); yield { header: headers }; continue; }
            if (fields.length === 1 && fields[0] === "") continue; // blank line
            const record = {};
            headers.forEach((h, i) => { record[h] = fields[i] ?? ""; });
            if (fields.length !== headers.length) record.__field_count_mismatch = `${fields.length}/${headers.length}`;
            yield { row_number: n, record }; // row_number = physical CSV record number (header = 1)
        }
    } else if (fmt === "JSONL") {
        const { createInterface } = await import("node:readline");
        let n = 0, headerSent = false;
        for await (const line of createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity })) {
            n++;
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { yield { row_number: n, record: null, parse_error: "INVALID_JSON_LINE" }; continue; }
            if (!headerSent) { yield { header: Object.keys(obj) }; headerSent = true; }
            yield { row_number: n, record: obj };
        }
    } else if (fmt === "JSON") {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.questions) ? parsed.questions : null;
        if (!list) { yield { header: [], parse_error: "JSON_NOT_AN_ARRAY (expected [..], {data:[..]} or {questions:[..]})" }; return; }
        yield { header: [...new Set(list.flatMap((o) => (o && typeof o === "object" ? Object.keys(o) : [])))] };
        for (let i = 0; i < list.length; i++) yield { row_number: i + 1, record: list[i] }; // 1-based array index
    }
}

// ------------------------------------------------------------------ row normalisation
const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const ok = (r) => (r && r.status === "OK" ? r.normalized_value : null);

/** A cell that should hold JSON: objects pass through; strings are parsed; failures are reported. */
export function jsonCell(v) {
    if (isBlank(v)) return { value: null, status: "EMPTY" };
    if (typeof v === "object") return { value: v, status: "OK" };
    try { return { value: JSON.parse(String(v)), status: "OK" }; } catch { return { value: null, status: "INVALID_JSON" }; }
}

function qtypeFrom(text, code) {
    let fromText = null, fromCode = null;
    if (!isBlank(text)) {
        const s = cleanWhitespace(text);
        fromText = EXTRA_QTYPE.get(s.toLowerCase()) || ok(normalizeQuestionType(s));
    }
    if (!isBlank(code)) {
        const n = Number(String(code).trim());
        fromCode = Number.isInteger(n) ? QBG_TYPE_CODES[n] || null : null;
    }
    if (fromText && fromCode && fromText !== fromCode && !(VALUE_TYPES.has(fromText) && fromCode === "Numerical")) {
        return { value: null, issue: `QUESTION_TYPE_TEXT_VS_CODE(${fromText} vs type=${code})` };
    }
    const value = fromText || fromCode;
    const issue = value ? null : !isBlank(text) || !isBlank(code) ? `UNKNOWN_QUESTION_TYPE(${text ?? ""}|${code ?? ""})` : "NO_QUESTION_TYPE";
    return { value, issue, basis: fromText ? "question_type column" : fromCode ? "type code" : null };
}

const englishOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v.english : undefined);
const htmlText = (s) => (typeof s === "string" && s.trim() ? ok(normalizeRichText(s)) : null);

function optionsFromList(list) {
    if (!Array.isArray(list)) return null;
    return list.map((o) => ({
        text: o && typeof o === "object" ? (typeof o.text === "string" ? ok(normalizeRichText(o.text)) ?? "" : null) : typeof o === "string" ? o : null,
        isCorrect: o && typeof o === "object" && typeof o.isCorrect === "boolean" ? o.isCorrect : null,
    }));
}

/**
 * Normalise one export record into the fields the build consumes. Returns
 * { unique_id, qbg_id_column, schema, question_type, metadata, content, issues, content_hash, raw }.
 */
export function normalizeExportRecord(record, keysByHeader) {
    const get = (key) => {
        for (const [h, v] of Object.entries(record)) if (keysByHeader.get(h) === key && !isBlank(v)) return v;
        return null;
    };
    const issues = [];
    if (record.__field_count_mismatch) issues.push(`FIELD_COUNT_MISMATCH(${record.__field_count_mismatch})`);
    const schema = get("question_text") !== null || get("answer_key") !== null ? "APP_QBG_QUESTIONS" : "QBG_PLATFORM";

    // identity: unique_id for the platform export; qbg_id for an app-table backup
    const idRaw = schema === "QBG_PLATFORM" ? get("unique_id") : get("qbg_id");
    const id = normalizeQbgId(idRaw);
    if (!id.valid) issues.push(`INVALID_JOIN_ID(${schema === "QBG_PLATFORM" ? "unique_id" : "qbg_id"}:${id.reason})`);
    const qbgCol = schema === "QBG_PLATFORM" ? get("qbg_id") : null;
    const qbgColNorm = qbgCol === null ? null : normalizeQbgId(qbgCol);
    if (qbgColNorm?.valid && id.valid && qbgColNorm.value !== id.value) issues.push("QBG_ID_COLUMN_DIFFERS_FROM_UNIQUE_ID");

    const qt = qtypeFrom(get("question_type"), get("type"));
    if (qt.issue) issues.push(qt.issue);
    const qtype = qt.value;

    // ---- content
    let questionText = null, options = null, solutionText = null, answer = null, answerRule = null;
    if (schema === "QBG_PLATFORM") {
        const c = jsonCell(get("content"));
        if (c.status === "INVALID_JSON") issues.push("CONTENT_INVALID_JSON");
        const eng = englishOf(c.value);
        if (c.value && eng === undefined) issues.push(`CONTENT_NO_ENGLISH(keys:${Object.keys(c.value || {}).join("+")})`);
        questionText = htmlText(eng);

        const bo = jsonCell(get("bilingual_options"));
        if (bo.status === "INVALID_JSON") issues.push("OPTIONS_INVALID_JSON");
        options = optionsFromList(englishOf(bo.value));
        if (bo.value && englishOf(bo.value) !== undefined && !Array.isArray(englishOf(bo.value))) issues.push("OPTIONS_SHAPE_UNRECOGNISED");

        const sol = jsonCell(get("solutions"));
        const bsol = jsonCell(get("bilingual_solutions"));
        if (sol.status === "INVALID_JSON") issues.push("SOLUTIONS_INVALID_JSON");
        if (bsol.status === "INVALID_JSON") issues.push("BILINGUAL_SOLUTIONS_INVALID_JSON");
        const s1 = Array.isArray(sol.value) ? htmlText(englishOf(sol.value[0])?.text) : null;
        const s2 = htmlText(englishOf(bsol.value)?.text);
        if (s1 && s2 && s1 !== s2) issues.push("SOLUTIONS_VS_BILINGUAL_SOLUTIONS_DIFFER");
        else solutionText = s1 || s2;

        const a = jsonCell(get("answer"));
        if (a.status === "INVALID_JSON") issues.push("ANSWER_INVALID_JSON");
        if (qtype && OPTION_TYPES.has(qtype)) {
            if (options?.length) {
                if (options.some((o) => o.isCorrect === null)) issues.push("ISCORRECT_FLAG_MISSING");
                else {
                    const idx = options.map((o, i) => (o.isCorrect ? i + 1 : 0)).filter(Boolean);
                    if (!idx.length) issues.push("NO_CORRECT_OPTION_FLAGGED");
                    else if (qtype !== "Multi_Choice(MCQ)" && idx.length > 1) issues.push("MULTIPLE_CORRECT_FOR_SINGLE_TYPE");
                    else { answer = idx; answerRule = "bilingual_options.english[].isCorrect -> 1-based indexes"; }
                }
            }
        } else if (qtype && VALUE_TYPES.has(qtype)) {
            const v = englishOf(a.value);
            if (typeof v === "string" || typeof v === "number") {
                const n = normalizeAnswer(v, qtype);
                if (n.status === "OK") { answer = n.normalized_value; answerRule = `answer.english (${n.normalization_rule})`; }
                else issues.push(`ANSWER_VALUE_UNPARSEABLE(${n.normalization_rule})`);
            } else if (a.value !== null) issues.push("ANSWER_SHAPE_UNVERIFIED");
        }
    } else {
        questionText = htmlText(get("question_text"));
        const o = jsonCell(get("options"));
        if (o.status === "INVALID_JSON") issues.push("OPTIONS_INVALID_JSON");
        options = optionsFromList(o.value);
        solutionText = htmlText(get("solution_text"));
        const ak = jsonCell(get("answer_key"));
        const v = ak.status === "OK" ? ak.value : null;
        if (qtype && OPTION_TYPES.has(qtype)) {
            const arr = Array.isArray(v) ? v : Number.isInteger(v) ? [v] : null;
            if (arr && arr.every((i) => Number.isInteger(i) && i >= 1 && i <= Math.max(options?.length || 0, 4))) { answer = arr; answerRule = "answer_key (app shape)"; }
            else if (v !== null) issues.push("ANSWER_KEY_NOT_AN_INDEX_LIST");
        } else if (qtype && VALUE_TYPES.has(qtype) && (typeof v === "number" || typeof v === "string")) {
            const n = normalizeAnswer(v, qtype);
            if (n.status === "OK") { answer = n.normalized_value; answerRule = "answer_key (app shape)"; }
            else issues.push("ANSWER_KEY_UNPARSEABLE");
        }
    }

    const optionType = qtype && OPTION_TYPES.has(qtype);
    const optionsComplete = !optionType ? true : Array.isArray(options) && options.length === 4 && options.every((o) => typeof o.text === "string" && o.text.trim());
    if (optionType && Array.isArray(options) && !optionsComplete) issues.push(`OPTIONS_INCOMPLETE(${options.length})`);

    const metadata = {
        subject: ok(normalizeSubject(get("subject"))),
        chapter: ok(normalizeTaxonomyName(get("chapter"))),
        topic: ok(normalizeTaxonomyName(get("topic"))),
        subtopic: ok(normalizeTaxonomyName(get("subtopic"))),
        difficulty: ok(normalizeDifficulty(get("difficulty_level"))) ?? ok(normalizeDifficulty(get("difficulty"))),
        source: cleanWhitespace(get("source")),
        class_level: ok(normalizeClassLevel(get("class_level"))),
    };
    const content = {
        question_text: questionText,
        options: optionType ? (optionsComplete ? options : null) : VALUE_TYPES.has(qtype) ? [] : options,
        options_raw_count: Array.isArray(options) ? options.length : null,
        answer_key: answer,
        answer_rule: answerRule,
        solution_text: solutionText,
    };
    const content_hash = crypto.createHash("sha256").update(JSON.stringify([qtype, content.question_text, content.options, content.answer_key, content.solution_text])).digest("hex");
    return {
        schema,
        unique_id: id.valid ? id.value : null,
        unique_id_raw: idRaw,
        qbg_id_column: qbgCol,
        qbg_file_id: get("qbg_file_id"), // opaque; never an identity
        question_type: qtype,
        question_type_basis: qt.basis,
        parent_question_id_raw: get("parent_question_id"),
        has_child_questions: !isBlank(get("child_questions")) && get("child_questions") !== "[]" && get("child_questions") !== "null",
        metadata,
        content,
        issues,
        content_hash,
    };
}

/**
 * Group staged rows by unique_id.
 * Returns Map(unique_id -> { rows, status, chosen }) where status is
 *   SINGLE | DUPLICATE_ROWS_IDENTICAL | DUPLICATE_ROWS_DIFFER
 * and `chosen` is the row whose content is used (null when rows differ).
 */
export function indexExportRows(rows) {
    const byId = new Map();
    for (const r of rows) {
        if (!r.unique_id) continue;
        if (!byId.has(r.unique_id)) byId.set(r.unique_id, []);
        byId.get(r.unique_id).push(r);
    }
    const out = new Map();
    for (const [id, list] of byId) {
        list.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.row_number - b.row_number));
        const hashes = new Set(list.map((r) => r.content_hash));
        const status = list.length === 1 ? "SINGLE" : hashes.size === 1 ? "DUPLICATE_ROWS_IDENTICAL" : "DUPLICATE_ROWS_DIFFER";
        out.set(id, { rows: list, status, chosen: status === "DUPLICATE_ROWS_DIFFER" ? null : list[0] });
    }
    return out;
}

/** Set arithmetic between known QBG ids and export ids. */
export function matchExport(knownIds, index) {
    const matched = [], exportOnly = [];
    for (const id of index.keys()) (knownIds.has(id) ? matched : exportOnly).push(id);
    const missing = [...knownIds].filter((id) => !index.has(id));
    return { matched: matched.sort(), export_only: exportOnly.sort(), known_not_in_export: missing.sort() };
}

/** Is a value shaped like a QBG id? (Used only to reject QBGFileId misuse in tests/validation.) */
export const looksLikeQbgId = (v) => typeof v === "string" && QBG_CUID25_RE.test(v.trim());
