/**
 * Pure logic for the canonical build: value comparison, conflict severity,
 * recovery classification, import readiness and near-duplicate detection.
 * Kept free of IO so it can be unit-tested.
 */
import { taxonomyCompareKey, OPTION_TYPES, VALUE_TYPES } from "./normalize.mjs";

export const RECOVERY_CLASSES = {
    A_FULL: "Question text, options (option types), answer and solution are all present and fully extracted (no unconverted placeholders); subject + question type known; source provenance recorded.",
    B_CONTENT_WITHOUT_SOLUTION: "Question text, options (option types) and answer fully extracted; the solution is missing or only partially extracted.",
    C_QUESTION_LINKED: "No usable local question body, but a specific pointer to the content exists: a source document plus a position in it (or the body was located but only partially extracted, e.g. unconverted equations).",
    D_METADATA_PLUS_ANSWER: "No question body; taxonomy/test metadata plus an answer from a workbook.",
    E_METADATA_ONLY: "No question body and no answer; identity plus taxonomy and/or test-usage metadata only.",
    F_CONFLICT: "At least one HIGH-severity conflict (answer, subject, option-vs-value question type, SCQ-vs-MCQ, id/link mismatch) blocks use until reviewed.",
    G_DUPLICATE: "Record is a non-canonical member of a confirmed duplicate group (another record is the canonical candidate).",
    H_UNRESOLVED: "Identity could not be established (no valid id and no document position) or no usable metadata at all.",
};

/** Compare key per field kind; values equal under the key are treated as agreeing. */
export function compareKey(field, value) {
    if (value === null || value === undefined) return null;
    if (["chapter", "topic", "subtopic", "source"].includes(field)) return taxonomyCompareKey(value);
    return JSON.stringify(value);
}

/**
 * observations: [{ source, location, raw, value }]. Returns
 *   { status: "NONE"|"SINGLE"|"AGREE"|"CONFLICT", value, candidates }
 * No winner is ever picked on CONFLICT: value is null and all candidates are kept.
 */
export function compareValues(field, observations) {
    const obs = observations.filter((o) => o.value !== null && o.value !== undefined);
    if (!obs.length) return { status: "NONE", value: null, candidates: [] };
    const groups = new Map();
    for (const o of obs) {
        const k = compareKey(field, o.value);
        if (!groups.has(k)) groups.set(k, { value: o.value, sources: [] });
        groups.get(k).sources.push({ source: o.source, location: o.location, raw: o.raw });
    }
    const candidates = [...groups.values()];
    if (candidates.length === 1) return { status: obs.length === 1 ? "SINGLE" : "AGREE", value: candidates[0].value, candidates };
    return { status: "CONFLICT", value: null, candidates };
}

const typeFamily = (t) => (OPTION_TYPES.has(t) ? "OPTION" : VALUE_TYPES.has(t) ? "VALUE" : t === "Comprehension(COMP)" ? "COMP" : "OTHER");

/** Severity of a disagreement between candidate values of a field. */
export function conflictSeverity(field, values) {
    if (["answer", "subject", "qbg_id_link", "parent_question_id"].includes(field)) return "HIGH";
    if (field === "question_type") {
        const fams = new Set(values.map(typeFamily));
        if (fams.has("OPTION") && fams.has("VALUE")) return "HIGH";
        if (values.includes("Single_Choice(SCQ)") && values.includes("Multi_Choice(MCQ)")) return "HIGH";
        if (fams.has("COMP") || fams.has("OTHER")) return "MEDIUM";
        return "LOW"; // e.g. SCQ vs Assertion_Reason, Integer vs Numerical
    }
    if (["chapter", "topic", "subtopic", "difficulty", "source", "chapter_id", "topic_id", "subtopic_id"].includes(field)) return "MEDIUM";
    return "LOW";
}

const has = (v) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && !v.length);

/**
 * rec needs: identity_confidence, question_text, question_complete, options_ok,
 * question_type, answer_key, solution_text, solution_complete, subject,
 * has_document_position, has_taxonomy, has_test_usage, high_conflicts, duplicate_of.
 */
export function classifyRecovery(rec) {
    const reasons = [];
    if (rec.duplicate_of) return { recovery_class: "G_DUPLICATE", reasons: [`duplicate of ${rec.duplicate_of}`] };
    if (rec.high_conflicts > 0) return { recovery_class: "F_CONFLICT", reasons: [`${rec.high_conflicts} HIGH-severity conflict(s)`] };
    const identityOk = rec.identity_confidence === "HIGH" || rec.identity_confidence === "MEDIUM";
    const optionType = OPTION_TYPES.has(rec.question_type);
    const coreMeta = has(rec.subject) && has(rec.question_type);
    const questionOk = has(rec.question_text) && rec.question_complete && (!optionType || rec.options_ok);
    if (identityOk && questionOk && has(rec.answer_key) && coreMeta) {
        if (has(rec.solution_text) && rec.solution_complete) return { recovery_class: "A_FULL", reasons };
        return { recovery_class: "B_CONTENT_WITHOUT_SOLUTION", reasons: [has(rec.solution_text) ? "solution partially extracted" : "no solution"] };
    }
    if (!identityOk && !rec.has_taxonomy && !rec.has_test_usage) return { recovery_class: "H_UNRESOLVED", reasons: ["no reliable identity and no metadata"] };
    if (has(rec.question_text)) {
        reasons.push(!rec.question_complete ? "question body only partially extracted" : !has(rec.answer_key) ? "no answer" : "options incomplete or core metadata missing");
        return { recovery_class: "C_QUESTION_LINKED", reasons };
    }
    if (has(rec.answer_key)) return { recovery_class: "D_METADATA_PLUS_ANSWER", reasons: ["no question body"] };
    if (rec.has_document_position) return { recovery_class: "C_QUESTION_LINKED", reasons: ["no body; source document + position known"] };
    if (!identityOk) return { recovery_class: "H_UNRESOLVED", reasons: ["identity LOW/UNKNOWN"] };
    if (rec.has_taxonomy || rec.has_test_usage) return { recovery_class: "E_METADATA_ONLY", reasons: ["no body, no answer"] };
    return { recovery_class: "H_UNRESOLVED", reasons: ["no usable metadata"] };
}

/**
 * READY: may be imported automatically (content present, HIGH/MEDIUM confidences, no open conflicts, QBG-linked).
 * READY_WITH_REVIEW: importable content but something needs a human decision first.
 * NOT_READY: no question body, or blocked.
 */
export function importReadiness(rec, cls) {
    const reasons = [];
    const okConf = (c) => c === "HIGH" || c === "MEDIUM";
    if (!["A_FULL", "B_CONTENT_WITHOUT_SOLUTION"].includes(cls)) return { import_readiness: "NOT_READY", reasons: [`class ${cls}`] };
    if (!okConf(rec.identity_confidence)) reasons.push("identity confidence below MEDIUM");
    if (!okConf(rec.content_confidence)) reasons.push("content confidence below MEDIUM");
    if (rec.open_conflicts > 0) reasons.push(`${rec.open_conflicts} open conflict(s)`);
    if (rec.origin_type !== "ORIGINAL_QBG") reasons.push(`origin_type ${rec.origin_type} (not a QBG question)`);
    if (!has(rec.chapter)) reasons.push("chapter unknown");
    if (cls === "B_CONTENT_WITHOUT_SOLUTION") reasons.push("solution incomplete");
    return { import_readiness: reasons.length ? "READY_WITH_REVIEW" : "READY", reasons };
}

// ---------------------------------------------------------------- near duplicates
export function shingles(key, n = 3) {
    const toks = String(key).split(" ").filter(Boolean);
    const out = new Set();
    if (toks.length < n) { if (toks.length) out.add(toks.join(" ")); return out; }
    for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
    return out;
}
export function jaccard(a, b) {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
}

/**
 * items: [{ id, key, block }] with key = dedupeKey(text).
 * Exact duplicates share a key; near duplicates are compared only within the
 * same block (never O(n^2) over the whole set).
 * Returns [{ a, b, type: EXACT_TEXT|NEAR_TEXT_PROBABLE|NEAR_TEXT_POSSIBLE, similarity }].
 */
export function findTextDuplicates(items, { probable = 0.9, possible = 0.75 } = {}) {
    const pairs = [];
    const byKey = new Map();
    for (const it of items) {
        if (!it.key) continue;
        if (!byKey.has(it.key)) byKey.set(it.key, []);
        byKey.get(it.key).push(it);
    }
    for (const grp of byKey.values()) for (let i = 1; i < grp.length; i++) pairs.push({ a: grp[0].id, b: grp[i].id, type: "EXACT_TEXT", similarity: 1 });
    const blocks = new Map();
    for (const [key, grp] of byKey) {
        const b = grp[0].block ?? "_";
        if (!blocks.has(b)) blocks.set(b, []);
        blocks.get(b).push({ id: grp[0].id, sh: shingles(key), len: key.length });
    }
    for (const list of blocks.values()) {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const x = list[i], y = list[j];
            if (Math.min(x.len, y.len) / Math.max(x.len, y.len) < possible) continue; // length prefilter
            const s = jaccard(x.sh, y.sh);
            if (s >= probable) pairs.push({ a: x.id, b: y.id, type: "NEAR_TEXT_PROBABLE", similarity: Math.round(s * 1000) / 1000 });
            else if (s >= possible) pairs.push({ a: x.id, b: y.id, type: "NEAR_TEXT_POSSIBLE", similarity: Math.round(s * 1000) / 1000 });
        }
    }
    return pairs;
}

/**
 * raw_data for qbg_questions must stay an ARRAY whose element 0 looks like a QBG
 * payload (the app and 001_post_import_backfills.sql read raw_data->0). The
 * recovery provenance therefore lives under raw_data[0]._recovery.
 */
export function buildRawData(qbgId, provenance) {
    return [{ unique_id: qbgId ?? null, _recovery: provenance }];
}
