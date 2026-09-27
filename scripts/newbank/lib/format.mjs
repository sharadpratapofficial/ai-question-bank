/**
 * Canonical input format for NEW question-bank records and its mapping onto
 * public.qbg_questions. Spec: docs/NEW_QUESTION_BANK_FORMAT.md.
 *
 * Pure functions only (no I/O) so every rule is unit-testable.
 *
 * Rules that matter:
 *   - Nothing is invented. A missing required field rejects the record; a missing
 *     optional field is stored as NULL (never defaulted, e.g. difficulty is never
 *     set to 'Medium' on the importer's behalf).
 *   - Normalisation is limited to deterministic spelling fixes of controlled
 *     vocabulary ('mathematics' -> 'Maths', 'B' -> 2). HTML is stored as given.
 *   - question_id is uuidv5(source_key) so re-running an import is idempotent.
 */
import crypto from "node:crypto";

export const IMPORTER_ID = "newbank-v1";
/** Namespace for NEW-bank ids. Distinct from the recovery pipeline's namespace. */
export const NEWBANK_UUID_NAMESPACE = "3b8e5d0a-6c2f-4e71-9a44-7f0d2c1b8e63";

export function uuidv5(name, namespace = NEWBANK_UUID_NAMESPACE) {
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const hash = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(String(name), "utf8")])).digest();
    const b = Buffer.from(hash.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const questionIdFor = (sourceKey) => uuidv5(`newbank:${sourceKey}`);

// ---------------------------------------------------------------------------
// Vocabulary (exact strings the app compares against - src/lib/constants.ts,
// src/types/index.ts). question_type matching in the app is case-sensitive.
// ---------------------------------------------------------------------------

/** kind: option = answer is 1-based option number(s); value = numeric answer; parent = passage. */
export const QUESTION_TYPES = {
    "Single_Choice(SCQ)": { kind: "option", many: false },
    "Multi_Choice(MCQ)": { kind: "option", many: true },
    "Assertion_Reason(AR)": { kind: "option", many: false },
    "Matching_List(ML)": { kind: "option", many: false },
    "Integer": { kind: "value", integer: true },
    "Single_Digit_Integer": { kind: "value", integer: true, min: 0, max: 9 },
    "Numerical": { kind: "value", integer: false },
    "Composite": { kind: "parent" },
    "Passage_Numerical": { kind: "parent" },
};

const typeKey = (s) => String(s).toLowerCase().replace(/[\s()_\-/]+/g, "");
const TYPE_ALIASES = new Map();
for (const t of Object.keys(QUESTION_TYPES)) TYPE_ALIASES.set(typeKey(t), t);
for (const [aliases, t] of [
    [["scq", "singlechoice", "singlecorrect"], "Single_Choice(SCQ)"],
    [["msq", "multichoice", "multiplechoicemcq", "multiselect", "multiplecorrect"], "Multi_Choice(MCQ)"],
    [["ar", "assertionreason"], "Assertion_Reason(AR)"],
    [["ml", "matchinglist", "matchthefollowing", "matchthecolumn", "listmatch"], "Matching_List(ML)"],
    [["integer", "int", "integertype"], "Integer"],
    [["singledigitinteger", "singledigit"], "Single_Digit_Integer"],
    [["numerical", "numeric", "nat", "numericalvalue", "decimal"], "Numerical"],
    [["composite", "comprehension", "passage", "paragraph"], "Composite"],
    [["passagenumerical"], "Passage_Numerical"],
]) for (const a of aliases) TYPE_ALIASES.set(a, t);

/**
 * In JEE/NEET usage "MCQ" / "Multiple Choice" often means single-correct 4-option questions,
 * while the app's Multi_Choice(MCQ) means multi-correct. Never guess: the per-source
 * adapter must map these explicitly.
 */
const AMBIGUOUS_TYPES = new Set(["mcq", "multiplechoice", "multiplechoicequestion"]);
export const isAmbiguousQuestionType = (raw) => typeof raw === "string" && AMBIGUOUS_TYPES.has(typeKey(raw));

export function canonicalQuestionType(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    if (QUESTION_TYPES[raw]) return raw;
    return TYPE_ALIASES.get(typeKey(raw)) ?? null;
}

const SUBJECTS = ["Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"];
const SUBJECT_ALIASES = new Map([...SUBJECTS.map((s) => [s.toLowerCase(), s]), ["mathematics", "Maths"], ["math", "Maths"]]);
const DIFFICULTIES = new Map([["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]]);
const CLASS_LEVELS = new Map([["11", "11"], ["class 11", "11"], ["xi", "11"], ["12", "12"], ["class 12", "12"], ["xii", "12"]]);
const EXAMS = new Map([["jee mains", "JEE Mains"], ["jee main", "JEE Mains"], ["jee advanced", "JEE Advanced"], ["jee adv", "JEE Advanced"], ["neet", "NEET"], ["bitsat", "BITSAT"]]);
export const STATUSES = ["verification_pending", "verified", "double_verified", "uat_passed", "rejected"];

/** Every field the canonical input may contain. Anything else rejects the record (catches typos). */
export const INPUT_FIELDS = [
    "source_key", "source", "legacy_qbg_id", "question_type", "question_text", "options", "answer",
    "solution_text", "subject", "chapter", "topic", "subtopic", "difficulty", "exam", "class_level",
    "status", "parent_source_key", "child_order", "provenance",
];

const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,199}$/;
const LEGACY_QBG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const MAX_OPTIONS = 10;

// ---------------------------------------------------------------------------
// HTML safety. Text fields are rendered with dangerouslySetInnerHTML
// (src/components/ui/MathContent.tsx), so imported HTML must not carry script.
// ---------------------------------------------------------------------------
const UNSAFE_HTML = [
    [/<\s*script\b/i, "<script> tag"],
    [/<\s*(iframe|object|embed|form|link|meta|base)\b/i, "disallowed tag (iframe/object/embed/form/link/meta/base)"],
    // inside a tag only, so text such as "one = 1" is not mistaken for a handler
    [/<[a-z][^>]*\son[a-z]+\s*=/i, "inline event handler (on...=)"],
    [/<[a-z][^>]*\s(href|src)\s*=\s*["']?\s*javascript:/i, "javascript: URL"],
];
// \ssrc (not \bsrc) so data-src= is not read as the image source
const IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

function checkHtml(field, html, errors, warnings, stats, mediaEnabled) {
    for (const [re, what] of UNSAFE_HTML) if (re.test(html)) errors.push(`${field}: contains ${what}`);
    const tags = html.match(IMG_TAG_RE) || [];
    let withSrc = 0;
    for (const m of html.matchAll(IMG_SRC_RE)) {
        withSrc++;
        const src = (m[2] ?? m[3] ?? m[4] ?? "").trim();
        if (/^media:/i.test(src)) {
            // resolved (read + validated locally) by the media resolver; see lib/media.mjs
            stats.images++;
            if (!mediaEnabled) errors.push(`${field}: ${src.slice(0, 80)} needs the importer's media support (--media-dir)`);
        } else if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(src)) {
            stats.images++;
            if (src.length * 0.75 > MAX_DATA_URL_BYTES) warnings.push(`${field}: embedded image larger than 2 MB`);
        } else if (/^https:\/\//i.test(src)) {
            stats.images++;
            warnings.push(`${field}: image hosted externally (${src.slice(0, 80)}) - it must stay reachable`);
        } else {
            errors.push(`${field}: image src is not embeddable (${src.slice(0, 80) || "empty"}); use media:<file> with --media-dir (preferred), a data:image/...;base64 URL, or an https URL`);
        }
    }
    if (tags.length > withSrc) errors.push(`${field}: <img> without src`);
}

/** Replace each <img src> for which resolveSrc(field, src) returns a new value; everything else is untouched. */
function rewriteImageSrcs(field, html, resolveSrc) {
    return html.replace(IMG_SRC_RE, (whole, token, dq, sq, bare) => {
        const next = resolveSrc(field, (dq ?? sq ?? bare ?? "").trim());
        return next === null ? whole : whole.slice(0, whole.length - token.length) + `"${next}"`;
    });
}

// ---------------------------------------------------------------------------

const isStr = (v) => typeof v === "string";
const clean = (v) => (isStr(v) ? v.trim() : v);
const present = (v) => v !== undefined && v !== null && !(isStr(v) && v.trim() === "");

/** Plain text used for duplicate detection only (never stored). */
export function fingerprintText(html) {
    return String(html ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/** Hash of the content columns of a qbg_questions row (same function for input rows and DB rows). */
export function contentHash(row) {
    const opts = Array.isArray(row.options) ? row.options.map((o) => [o?.text ?? null, o?.isCorrect ?? null]) : row.options ?? null;
    const payload = [
        row.question_type ?? null, row.question_text ?? null, opts, row.answer_key ?? null, row.solution_text ?? null,
        row.subject ?? null, row.chapter ?? null, row.topic ?? null, row.subtopic ?? null, row.source ?? null,
        row.difficutly_level ?? null, row.class_level ?? null, row.exam ?? null, row.parent_question_id ?? null, row.qbg_id ?? null,
        row.child_order ?? null,
    ];
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseOptionAnswer(v) {
    if (Number.isInteger(v)) return v;
    if (isStr(v)) {
        const s = v.trim();
        if (/^[A-Ja-j]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 64;
        if (/^\d+$/.test(s)) return Number(s);
    }
    return NaN;
}

/**
 * Validate one canonical input record and map it to a qbg_questions row.
 * ctx: { sourceFile, sourceSha256, recordNumber }
 * Returns { ok, errors[], warnings[], row, meta } - row is null when !ok.
 */
export function mapRecord(rec, ctx = {}) {
    const errors = [], warnings = [], stats = { images: 0 };
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        return { ok: false, errors: ["record is not a JSON object"], warnings, row: null, meta: {} };
    }
    for (const k of Object.keys(rec)) if (!INPUT_FIELDS.includes(k)) errors.push(`unknown field "${k}"`);

    const sourceKey = clean(rec.source_key);
    if (!present(sourceKey)) errors.push("missing required field source_key");
    else if (!isStr(sourceKey) || !SOURCE_KEY_RE.test(sourceKey)) errors.push("source_key must be 1-200 chars of [A-Za-z0-9._:-/], starting alphanumeric");

    const reqText = (f) => {
        const v = clean(rec[f]);
        if (!present(v)) { errors.push(`missing required field ${f}`); return null; }
        if (!isStr(v)) { errors.push(`${f} must be a string`); return null; }
        return v;
    };
    const optText = (f) => {
        const v = clean(rec[f]);
        if (!present(v)) return null;
        if (!isStr(v)) { errors.push(`${f} must be a string`); return null; }
        return v;
    };

    const source = reqText("source");
    const questionText = reqText("question_text");
    const chapter = reqText("chapter");
    const topic = optText("topic");
    const subtopic = optText("subtopic");
    const solutionText = optText("solution_text");

    let questionType = null;
    if (!present(rec.question_type)) errors.push("missing required field question_type");
    else {
        questionType = canonicalQuestionType(rec.question_type);
        if (!questionType && isAmbiguousQuestionType(rec.question_type)) errors.push(`ambiguous question_type "${rec.question_type}": use Single_Choice(SCQ) for single-correct or Multi_Choice(MCQ) / MSQ for multi-correct`);
        else if (!questionType) errors.push(`unsupported question_type "${rec.question_type}"`);
        else if (questionType !== rec.question_type) warnings.push(`question_type "${rec.question_type}" normalised to "${questionType}"`);
    }
    const spec = questionType ? QUESTION_TYPES[questionType] : null;

    let subject = null;
    if (!present(rec.subject)) errors.push("missing required field subject");
    else if (!isStr(rec.subject) || !(subject = SUBJECT_ALIASES.get(rec.subject.trim().toLowerCase()) ?? null)) {
        errors.push(`unknown subject "${rec.subject}" (expected one of ${SUBJECTS.join(", ")})`);
    }

    let difficulty = null;
    if (present(rec.difficulty)) {
        difficulty = isStr(rec.difficulty) ? DIFFICULTIES.get(rec.difficulty.trim().toLowerCase()) ?? null : null;
        if (!difficulty) errors.push(`difficulty "${rec.difficulty}" is not Easy/Medium/Hard`);
    }

    let classLevel = null;
    if (present(rec.class_level)) {
        classLevel = CLASS_LEVELS.get(String(rec.class_level).trim().toLowerCase()) ?? null;
        if (!classLevel) errors.push(`class_level "${rec.class_level}" is not 11 or 12`);
    }

    let exam = null;
    if (present(rec.exam)) {
        const list = Array.isArray(rec.exam) ? rec.exam : [rec.exam];
        exam = [];
        for (const e of list) {
            if (!isStr(e) || !e.trim()) { errors.push("exam entries must be non-empty strings"); continue; }
            const known = EXAMS.get(e.trim().toLowerCase());
            if (!known) warnings.push(`exam "${e.trim()}" is not a known exam label; stored as given`);
            const v = known ?? e.trim();
            if (!exam.includes(v)) exam.push(v);
        }
        if (!exam.length) exam = null;
    }

    let status = "verification_pending";
    if (present(rec.status)) {
        if (!STATUSES.includes(rec.status)) errors.push(`status "${rec.status}" is not one of ${STATUSES.join(", ")}`);
        else status = rec.status;
    }

    let legacyQbgId = null;
    if (present(rec.legacy_qbg_id)) {
        legacyQbgId = String(rec.legacy_qbg_id).trim();
        if (!LEGACY_QBG_ID_RE.test(legacyQbgId)) errors.push("legacy_qbg_id must be 1-64 chars of [A-Za-z0-9_-]");
    }

    if (present(rec.provenance) && (typeof rec.provenance !== "object" || Array.isArray(rec.provenance))) {
        errors.push("provenance must be a JSON object");
    }

    // Parent / child structure
    const parentSourceKey = clean(rec.parent_source_key);
    let childOrder = null;
    if (present(parentSourceKey)) {
        if (!isStr(parentSourceKey) || !SOURCE_KEY_RE.test(parentSourceKey)) errors.push("parent_source_key is malformed");
        if (parentSourceKey === sourceKey) errors.push("parent_source_key equals source_key");
        if (spec?.kind === "parent") errors.push("a passage parent cannot itself have a parent (no nesting)");
        if (!Number.isInteger(rec.child_order) || rec.child_order < 1) errors.push("child_order (integer >= 1) is required for child questions");
        else childOrder = rec.child_order;
    } else if (present(rec.child_order)) {
        errors.push("child_order is only allowed together with parent_source_key");
    }

    // Options + answer, by type
    let options = [];
    let answerKey = null;
    const answerAsGiven = rec.answer === undefined ? null : rec.answer;
    if (spec?.kind === "option") {
        if (!Array.isArray(rec.options)) errors.push("options must be an array of HTML strings for this question_type");
        else if (rec.options.length < 2 || rec.options.length > MAX_OPTIONS) errors.push(`options must have 2-${MAX_OPTIONS} entries (got ${rec.options.length})`);
        else if (rec.options.some((o) => !isStr(o) || !o.trim())) errors.push("every option must be a non-empty HTML string (an empty option would shift A/B/C/D labels)");
        const n = Array.isArray(rec.options) ? rec.options.length : 0;
        if (!present(rec.answer) || (Array.isArray(rec.answer) && rec.answer.length === 0)) errors.push("missing required field answer");
        else {
            const raw = Array.isArray(rec.answer) ? rec.answer : [rec.answer];
            const idx = raw.map(parseOptionAnswer);
            if (idx.some((i) => !Number.isInteger(i))) errors.push(`answer ${JSON.stringify(rec.answer)} must be 1-based option numbers or letters A-J`);
            else if (idx.some((i) => i < 1 || i > n)) errors.push(`answer ${JSON.stringify(rec.answer)} is outside options 1..${n}`);
            else if (new Set(idx).size !== idx.length) errors.push("answer repeats an option");
            else if (!spec.many && idx.length !== 1) errors.push(`${questionType} needs exactly one correct option (got ${idx.length})`);
            else answerKey = [...idx].sort((a, b) => a - b);
        }
        if (!errors.length) {
            options = rec.options.map((t, i) => ({ text: t.trim(), isCorrect: answerKey.includes(i + 1) }));
        }
    } else if (spec?.kind === "value") {
        if (Array.isArray(rec.options) ? rec.options.length : present(rec.options)) errors.push(`${questionType} must not have options`);
        if (!present(rec.answer)) errors.push("missing required field answer");
        else {
            const s = typeof rec.answer === "number" ? String(rec.answer) : isStr(rec.answer) ? rec.answer.trim() : "";
            if (!NUMERIC_RE.test(s) || !Number.isFinite(Number(s))) errors.push(`answer ${JSON.stringify(rec.answer)} is not a single number (ranges/tolerances are not supported by the app)`);
            else {
                const v = Number(s);
                if (spec.integer && !Number.isInteger(v)) errors.push(`${questionType} answer must be an integer (got ${s})`);
                else if (spec.min !== undefined && (v < spec.min || v > spec.max)) errors.push(`${questionType} answer must be ${spec.min}-${spec.max}`);
                else answerKey = v;
            }
        }
    } else if (spec?.kind === "parent") {
        if (Array.isArray(rec.options) ? rec.options.length : present(rec.options)) errors.push("a passage parent must not have options");
        if (present(rec.answer)) errors.push("a passage parent must not have an answer (answers belong to its child questions)");
    }

    const mediaEnabled = typeof ctx.resolveMedia === "function";
    for (const [f, v] of [["question_text", questionText], ["solution_text", solutionText]]) if (v) checkHtml(f, v, errors, warnings, stats, mediaEnabled);
    if (Array.isArray(rec.options)) rec.options.forEach((o, i) => isStr(o) && checkHtml(`options[${i}]`, o, errors, warnings, stats, mediaEnabled));
    if (!solutionText && spec && spec.kind !== "parent") warnings.push("no solution_text");

    // Images -> question-media paths. Deterministic (path = question id + name + content hash),
    // so the rewritten HTML and the content hash are the same on every run.
    const media = [];
    const uploads = new Map(); // storage_path -> upload job (deduplicated within the question)
    let questionTextOut = questionText, solutionTextOut = solutionText;
    if (!errors.length && mediaEnabled) {
        const qid = questionIdFor(sourceKey);
        let inline = 0;
        const resolveSrc = (field, src) => {
            const r = ctx.resolveMedia(src, { questionId: qid, field, inlineIndex: /^data:/i.test(src) ? ++inline : 0 });
            if (r.kind === "error") { errors.push(r.error); return null; }
            if (r.kind !== "media") return null;
            media.push(r.record);
            uploads.set(r.upload.storage_path, r.upload);
            return r.src;
        };
        questionTextOut = rewriteImageSrcs("question_text", questionText, resolveSrc);
        if (solutionText) solutionTextOut = rewriteImageSrcs("solution_text", solutionText, resolveSrc);
        if (spec?.kind === "option") options = options.map((o, i) => ({ ...o, text: rewriteImageSrcs(`options[${i}]`, o.text, resolveSrc) }));
    }

    if (errors.length) return { ok: false, errors, warnings, row: null, meta: { source_key: isStr(sourceKey) ? sourceKey : null } };

    const questionId = questionIdFor(sourceKey);
    const row = {
        question_id: questionId,
        // App convention (every writer in src/) is qbg_id = question_id; a genuinely known
        // legacy QBG id takes its place. The detail page displays it; the API forbids editing it.
        qbg_id: legacyQbgId ?? questionId,
        question_text: questionTextOut,
        options,
        answer_key: answerKey,
        solution_text: solutionTextOut,
        question_type: questionType,
        subject,
        chapter,
        topic,
        subtopic,
        source,
        difficutly_level: difficulty, // real column name keeps the historical misspelling
        class_level: classLevel,
        exam,
        parent_question_id: present(parentSourceKey) ? questionIdFor(parentSourceKey) : null,
        // column added by scripts/sql/003_new_question_bank_support.sql (G2)
        child_order: childOrder,
        status,
        source_docx: null,
    };
    const hash = contentHash(row);
    row.raw_data = [{
        // Everything lives under one key so it never collides with legacy QBG raw_data
        // keys (verification_status, solutions, ...) that app code and 001_post_import_backfills.sql read.
        _newbank: {
            importer: IMPORTER_ID,
            source_key: sourceKey,
            legacy_qbg_id: legacyQbgId,
            parent_source_key: present(parentSourceKey) ? parentSourceKey : null,
            child_order: childOrder,
            answer_as_given: answerAsGiven,
            content_hash: hash,
            source_file: ctx.sourceFile ?? null,
            source_file_sha256: ctx.sourceSha256 ?? null,
            record_number: ctx.recordNumber ?? null,
            provenance: present(rec.provenance) ? rec.provenance : null,
            // one entry per image reference: where it came from and where it is stored
            media,
        },
    }];
    return {
        ok: true, errors, warnings, row,
        meta: {
            source_key: sourceKey, kind: spec.kind, parent_source_key: present(parentSourceKey) ? parentSourceKey : null,
            child_order: childOrder, legacy_qbg_id: legacyQbgId, images: stats.images, content_hash: hash,
            media: [...uploads.values()],
            fingerprint: fingerprintText(questionText) + "\u0000" + options.map((o) => fingerprintText(o.text)).join("\u0001"),
        },
    };
}
