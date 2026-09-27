/**
 * Pure QC logic: conflict analysis, duplicate categorisation, parent-child
 * relationship evidence and per-id coverage. No IO, so it is unit-tested.
 *
 * Nothing here resolves a conflict. Every conflict stays UNRESOLVED; the analysis
 * explains WHY it is open and, where an independent deterministic source exists,
 * records it as an `evidence_suggestion` for a reviewer - never as the value.
 */
import { VALUE_TYPES } from "./normalize.mjs";

const sourcesOf = (c) => (c.values || []).map((v) => (v.sources ? v.sources.map((s) => s.source) : [v.source]).filter(Boolean));
/** "important_ids.Onepass Test Series.Class" and "autocuration.question_type" -> column family (drop "->taxonomy" suffixes). */
const column = (s) => String(s).replace(/->taxonomy$/, "").replace(/\(swapped\)$/, "");

export const CONFLICT_CATEGORIES = {
    NAME_VARIANT_SAME_TAXONOMY_ID: "Names differ only as spellings of one agreed taxonomy id; the id's tagging-table name is used.",
    VALUE_TYPE_GRANULARITY: "All candidates are numeric-answer types (Integer / Numerical / Single_Digit_Integer); the app treats them alike, but which label the question carries is not provable.",
    CURRENT_VS_ORIGINAL_CURATION_FIELD: "AutoCuration's current `question_type` disagrees with its own `question_type_original`; this records an edit, but not which label is right.",
    SAME_COLUMN_DIFFERENT_OCCURRENCES: "Every candidate comes from the same sheet column on different rows (e.g. one question used in two tests). The column may describe the test, not the question.",
    LABEL_VS_TAXONOMY_ID: "A row's text label disagrees with the name of the taxonomy id in the same row.",
    DUPLICATE_WORKBOOK_ROWS_DISAGREE: "The QBG id appears on several AutoCuration rows whose values differ.",
    OPTION_VS_VALUE_TYPE: "One source says an option-type question, another a numeric-answer type: the answer format itself is in doubt.",
    SAME_TEST_POSITION_DIFFERENT_IDS: "One test position lists different QBG ids (see duplicate analysis: SAME_POSITION_ANOMALY).",
    QBG_EXPORT_DISAGREES: "The QBG export disagrees with the workbooks.",
    EXPORT_DUPLICATE_ROWS_DIFFER: "The QBG export has several rows for this unique_id with different content.",
    ANSWER_SOURCES_DISAGREE: "Answer sources disagree.",
    ID_VS_LINK: "The id cell and the id embedded in the row's QBG link differ.",
    CROSS_SOURCE_DISAGREEMENT: "Different sources disagree and no structural explanation applies.",
};

const WHY_OPEN = "No deterministic evidence identifies the correct value; the canonical field stays null until a reviewer decides.";

/**
 * ctx: { chapterClassById: Map(chapter_id -> Set(class)), canonicalChapterId }
 * Returns { category, explanation, auto_resolution, why_open, evidence_suggestion }.
 */
export function analyzeConflict(c, ctx = {}) {
    const srcs = sourcesOf(c);
    const flat = srcs.flat();
    const cols = new Set(flat.map(column));
    const values = (c.values || []).map((v) => v.value ?? v.raw);
    let category = "CROSS_SOURCE_DISAGREEMENT";
    let suggestion = null;

    if (c.conflict_type === "SAME_TEST_POSITION_DIFFERENT_IDS") category = "SAME_TEST_POSITION_DIFFERENT_IDS";
    else if (c.conflict_type === "EXPORT_DUPLICATE_ROWS_DIFFER") category = "EXPORT_DUPLICATE_ROWS_DIFFER";
    else if (c.conflict_type === "QBG_ID_VS_LINK_ID") category = "ID_VS_LINK";
    else if (/_NAME_VARIANT$/.test(c.conflict_type || "")) category = "NAME_VARIANT_SAME_TAXONOMY_ID";
    else if (flat.some((s) => s.startsWith("qbg_export.")) && flat.some((s) => !s.startsWith("qbg_export."))) category = "QBG_EXPORT_DISAGREES";
    else if (c.field === "answer") category = "ANSWER_SOURCES_DISAGREE";
    else if (c.field === "question_type" && values.every((v) => VALUE_TYPES.has(v))) {
        category = cols.size === 2 && cols.has("autocuration.question_type") && cols.has("autocuration.question_type_original") ? "CURRENT_VS_ORIGINAL_CURATION_FIELD" : "VALUE_TYPE_GRANULARITY";
    } else if (c.field === "question_type" && c.severity === "HIGH" && values.some((v) => VALUE_TYPES.has(v))) category = "OPTION_VS_VALUE_TYPE";
    else if (c.field === "question_type" && cols.size === 2 && cols.has("autocuration.question_type") && cols.has("autocuration.question_type_original")) category = "CURRENT_VS_ORIGINAL_CURATION_FIELD";
    else if (srcs.length > 1 && srcs.every((s) => s.length) && cols.size === 1) category = [...cols][0].startsWith("autocuration.") ? "DUPLICATE_WORKBOOK_ROWS_DISAGREE" : "SAME_COLUMN_DIFFERENT_OCCURRENCES";
    else if (["subject", "chapter", "topic", "subtopic"].includes(c.field) && flat.some((s) => s.endsWith("->taxonomy")) && sameLocations(c)) category = "LABEL_VS_TAXONOMY_ID";

    // Independent evidence (never applied): the tagging table's class for the agreed chapter id.
    if (c.field === "class_level" && ctx.canonicalChapterId && ctx.chapterClassById?.has(ctx.canonicalChapterId)) {
        const classes = [...ctx.chapterClassById.get(ctx.canonicalChapterId)];
        if (classes.length === 1 && values.map(String).includes(classes[0])) {
            suggestion = { value: classes[0], basis: `tagging table maps chapter_id ${ctx.canonicalChapterId} to class ${classes[0]}`, strength: "SUPPORTING (taxonomy class of the chapter, not a statement about this question)" };
        }
    }
    return {
        category,
        explanation: CONFLICT_CATEGORIES[category],
        auto_resolution: "NOT_APPLIED",
        why_open: category === "NAME_VARIANT_SAME_TAXONOMY_ID" ? "Display-name variant only; the taxonomy id is agreed." : WHY_OPEN,
        evidence_suggestion: suggestion,
    };
}

/** True when every candidate's sources were read at one shared location (same workbook row / cell). */
function sameLocations(c) {
    const locs = (c.values || []).map((v) => new Set((v.sources || []).map((s) => s.location)));
    if (locs.length < 2) return false;
    return [...locs[0]].some((l) => locs.slice(1).every((s) => s.has(l)));
}

// ------------------------------------------------------------------ duplicates
export const DUPLICATE_CATEGORIES = {
    REPEATED_ID_ACROSS_WORKBOOK_ROWS: "One QBG id listed on several AutoCuration rows: the same question curated more than once, not two questions.",
    PASSAGE_PARENT_REUSE_INFERRED: "One QBG id at consecutive positions of one test: consistent with a comprehension/passage parent id entered for each child. INFERRED from the position pattern; not verified.",
    REPEATED_ID_IN_TEST_UNEXPLAINED: "One QBG id at non-consecutive positions of one test: reuse inside a test, or a data-entry error.",
    SAME_POSITION_ANOMALY: "One document/test position is mapped to more than one record; nothing is merged.",
    DUPLICATE_QUESTION_TEXT: "Two extracted question bodies are identical or near-identical text.",
};

/**
 * d: a duplicate group; evidence: { typesById: Map(qbg_id -> [question types seen]) }.
 * Returns { category, same_question_record, relationship_status, evidence }.
 */
export function categorizeDuplicate(d, evidence = {}) {
    const t = d.duplicate_type;
    if (t === "EXACT_ID_MULTIPLE_WORKBOOK_ROWS") return { category: "REPEATED_ID_ACROSS_WORKBOOK_ROWS", same_question_record: true, relationship_status: "VERIFIED (identical id)", evidence: [] };
    if (t === "SAME_ID_TWICE_IN_ONE_TEST") {
        const consecutive = /consecutive positions/.test(d.detail || "");
        if (!consecutive) return { category: "REPEATED_ID_IN_TEST_UNEXPLAINED", same_question_record: true, relationship_status: "UNEXPLAINED", evidence: [] };
        const id = String(d.members?.[0] || "").replace(/^qbg:/, "");
        const types = evidence.typesById?.get(id) || [];
        const passageTyped = types.some((x) => x === "Comprehension(COMP)" || x === "Passage_Numerical");
        return {
            category: "PASSAGE_PARENT_REUSE_INFERRED",
            same_question_record: true,
            relationship_status: "INFERRED",
            evidence: ["consecutive positions in one test", passageTyped ? `question type recorded as ${types.join("/")} (supports the inference)` : `question type recorded as ${types.join("/") || "unknown"} (no passage type recorded; position pattern only)`],
        };
    }
    if (t === "SAME_SOURCE_POSITION" || t === "SAME_SOURCE_POSITION_DIFFERENT_QBG_IDS") return { category: "SAME_POSITION_ANOMALY", same_question_record: false, relationship_status: "UNRESOLVED", evidence: [d.detail || ""] };
    if (/^(EXACT_TEXT|NEAR_TEXT)/.test(t)) return { category: "DUPLICATE_QUESTION_TEXT", same_question_record: false, relationship_status: t === "EXACT_TEXT" ? "VERIFIED (identical normalised text)" : "INFERRED (text similarity)", evidence: [`similarity ${d.similarity ?? 1}`] };
    return { category: "UNCATEGORISED", same_question_record: null, relationship_status: "UNRESOLVED", evidence: [] };
}

// ------------------------------------------------------------------ parent/child
/**
 * Relationship candidates. parent_question_id is NEVER set from these:
 * every row is INFERRED (or an ANOMALY) until confirmed against the source.
 */
export function parentChildRelationships({ compCandidates = [], passageGroups = [] }) {
    const out = [];
    for (const p of compCandidates) {
        const self = p.qbg_id && p.parent_candidate === p.qbg_id;
        out.push({
            child_qbg_id: p.qbg_id,
            parent_candidate: p.parent_candidate,
            basis: "Important IDs AITS column K ('Comp')",
            relationship_status: self ? "ANOMALY (parent candidate equals the question itself)" : "INFERRED",
            parent_known_as_record: p.parent_known_as_record,
            confidence: "LOW",
            action: self ? "Check the Comp cell: a question cannot be its own parent." : "Confirm what 'Comp' records; parent_question_id stays null until confirmed.",
        });
    }
    for (const g of passageGroups) {
        out.push({
            child_qbg_id: null,
            parent_candidate: g.qbg_id,
            basis: `same id at consecutive positions ${g.positions} of ${g.test}`,
            relationship_status: "INFERRED (passage parent reused per child; child ids not recorded)",
            parent_known_as_record: true,
            confidence: "LOW",
            action: "Find the child question ids for these positions in the source paper or QBG.",
        });
    }
    return out;
}

// ------------------------------------------------------------------ coverage
/**
 * Per-QBG-id coverage flags from a canonical record (+ its documents' availability).
 * Everything is derived from recorded data; nothing is estimated.
 */
export function coverageFor(rec, { localDocIds = new Set() } = {}) {
    const has = (v) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim());
    const qDocs = rec.documents?.question_documents || [];
    const sDocs = rec.documents?.solution_documents || [];
    const question = has(rec.question_text);
    const options = Array.isArray(rec.options) && rec.options.length > 0;
    const answer = has(rec.answer_key) && !(Array.isArray(rec.answer_key) && !rec.answer_key.length);
    const solution = has(rec.solution_text);
    const metadata = !!(rec.subject || rec.chapter || rec.question_type || rec.difficulty_level);
    const localDoc = [...qDocs, ...sDocs].some((d) => localDocIds.has(d));
    const missing = [];
    if (!question) missing.push("question_text");
    if (!options && !(rec.question_type && VALUE_TYPES.has(rec.question_type))) missing.push("options");
    if (!answer) missing.push("answer");
    if (!solution) missing.push("solution");
    if (!rec.subject) missing.push("subject");
    if (!rec.chapter) missing.push("chapter");
    if (!rec.question_type) missing.push("question_type");
    const contentComplete = question && answer;
    return {
        qbg_id: rec.qbg_id,
        has_question_text: question,
        has_options: options,
        has_answer: answer,
        has_solution: solution,
        has_metadata: metadata,
        metadata_only: !question && !answer && !solution,
        has_question_document_ref: qDocs.length > 0,
        has_solution_document_ref: sDocs.length > 0,
        has_any_source_document_ref: qDocs.length + sDocs.length > 0,
        has_document_position: rec.recovery_class === "C_QUESTION_LINKED" && !question,
        has_test_usage: (rec.test_usage?.occurrence_count || 0) > 0,
        has_conflicts: (rec.conflict_ids || []).length > 0,
        has_blocking_conflict: rec.conflict_status === "BLOCKING",
        has_duplicate_issue: (rec.duplicate_group_ids || []).length > 0,
        content_source_status: rec.content_source?.status ?? "NOT_PRESENT",
        potentially_recoverable_locally: !contentComplete && localDoc,
        requires_external_source: !contentComplete && !localDoc,
        recovery_class: rec.recovery_class,
        import_readiness: rec.import_readiness,
        missing,
    };
}
