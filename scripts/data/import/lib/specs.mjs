/**
 * Import specifications: source file -> target table, key, selection, mapping, validation.
 * Only `qbg_questions` exists in scripts/sql/000_rebuild_schema.sql; every other target is a
 * PROPOSED table (docs/data_recovery/SCHEMA_GAP_ANALYSIS.md) and apply mode aborts if it is absent.
 */
import path from "node:path";
import { CANONICAL_DIR } from "./importer.mjs";

const C = (f) => path.join(CANONICAL_DIR, f);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPTION_TYPES = new Set(["Single_Choice(SCQ)", "Multi_Choice(MCQ)", "Assertion_Reason(AR)", "Matching_List(ML)"]);

/** Columns the application reads/writes on qbg_questions (docs/SCHEMA_REBUILD_AUDIT.md §3). */
export const QBG_QUESTIONS_COLUMNS = ["question_id", "qbg_id", "question_text", "options", "answer_key", "solution_text", "question_type", "subject", "chapter", "topic", "subtopic", "source", "difficutly_level", "parent_question_id", "raw_data", "exam", "class_level", "status", "source_docx"];

export function mapQuestionRow(r) {
    return {
        question_id: r.question_id,
        qbg_id: r.qbg_id ?? null,
        question_text: r.question_text ?? null,
        options: r.options ?? [],
        answer_key: r.answer_key ?? null,
        solution_text: r.solution_text ?? null,
        question_type: r.question_type ?? null,
        subject: r.subject ?? null,
        chapter: r.chapter ?? null,
        topic: r.topic ?? null,
        subtopic: r.subtopic ?? null,
        source: r.source ?? null,
        difficutly_level: r.difficulty_level ?? null, // real column name keeps the historical misspelling
        parent_question_id: r.parent_question_id ?? null,
        raw_data: [{
            unique_id: r.qbg_id ?? null,
            _recovery: {
                record_key: r.record_key, origin_type: r.origin_type, recovery_class: r.recovery_class, confidence: r.confidence,
                import_readiness: r.import_readiness, conflict_ids: r.conflict_ids, duplicate_group_ids: r.duplicate_group_ids,
                provenance: r.provenance, pyq_reference: r.pyq_reference ?? null, extraction_issues: r.extraction_issues ?? [],
            },
        }],
        exam: r.exam?.length ? r.exam : null,
        class_level: r.class_level ?? null,
        status: "verification_pending",
        source_docx: null,
    };
}

export function validateQuestionRow(row) {
    const e = [];
    for (const k of Object.keys(row)) if (!QBG_QUESTIONS_COLUMNS.includes(k)) e.push(`unknown column ${k}`);
    if (!UUID.test(row.question_id || "")) e.push("question_id not a uuid");
    if (!Array.isArray(row.options)) e.push("options must be an array");
    if (!Array.isArray(row.raw_data) || !row.raw_data.length) e.push("raw_data must be a non-empty array (app reads raw_data->0)");
    if (row.exam !== null && !Array.isArray(row.exam)) e.push("exam must be text[]");
    if (OPTION_TYPES.has(row.question_type)) {
        if (row.answer_key !== null && !Array.isArray(row.answer_key)) e.push("option-type answer must be an index array");
        if (Array.isArray(row.answer_key) && row.answer_key.some((i) => i < 1 || i > row.options.length)) e.push("answer index outside options");
    } else if (Array.isArray(row.answer_key)) e.push("value-type answer must not be an index array");
    if (!row.question_text) e.push("question_text empty (metadata-only rows are not imported into the operational table)");
    return e;
}

const ready = (r, args) => {
    if (r.import_readiness === "READY") return { include: true };
    if (r.import_readiness === "READY_WITH_REVIEW" && args.flags.has("include-review")) {
        if (r.origin_type !== "ORIGINAL_QBG" && !args.flags.has("include-external")) return { include: false, reason: "external origin (needs --include-external)" };
        return { include: true };
    }
    return { include: false, reason: r.import_readiness };
};

export const SPECS = {
    "01_import_source_documents": { name: "01_import_source_documents", table: "qbg_source_documents", key: "document_id", proposedTable: true, input: C("source_documents.jsonl"), map: (r) => ({ ...r }), validate: (r) => (r.document_id ? [] : ["document_id missing"]) },
    "02_import_qbg_metadata": { name: "02_import_qbg_metadata", table: "qbg_question_metadata", key: "question_id", proposedTable: true, input: C("qbg_question_metadata.jsonl"), map: (r) => ({ question_id: r.question_id, record_key: r.record_key, qbg_id: r.qbg_id, fields: r.fields, topic_swapped_rows: r.topic_swapped_rows, subtopic_swapped_rows: r.subtopic_swapped_rows, class_column_document_refs: r.class_column_document_refs }), validate: (r) => (UUID.test(r.question_id) ? [] : ["question_id not uuid"]) },
    "03_import_qbg_questions": { name: "03_import_qbg_questions", table: "qbg_questions", key: "question_id", proposedTable: false, input: [C("qbg_questions.jsonl"), C("source_document_questions.jsonl")], select: ready, map: mapQuestionRow, validate: validateQuestionRow },
    "04_import_test_occurrences": { name: "04_import_test_occurrences", table: "qbg_question_test_occurrences", key: "occurrence_id", proposedTable: true, input: C("qbg_test_occurrences.jsonl"), select: (r) => (r.structure === "MIRROR_OF_AITS" ? { include: false, reason: "mirror sheet row" } : { include: true }), map: (r) => ({ ...r }), validate: (r) => (r.occurrence_id ? [] : ["occurrence_id missing"]) },
    "05_import_pyq_register": { name: "05_import_pyq_register", table: "pyq_register", key: "pyq_id", proposedTable: true, input: C("pyq_register.jsonl"), map: (r) => ({ ...r }), validate: (r) => (r.pyq_id ? [] : ["pyq_id missing"]) },
    "06_import_concepts": { name: "06_import_concepts", table: "concept_register", key: "concept_id", proposedTable: true, input: C("concept_register.jsonl"), map: (r) => ({ ...r }), validate: (r) => (r.concept_id ? [] : ["concept_id missing"]) },
    "07_import_archetypes": { name: "07_import_archetypes", table: "archetype_register", key: "archetype_id", proposedTable: true, input: C("archetype_register.jsonl"), map: (r) => ({ ...r }), validate: (r) => (r.archetype_id ? [] : ["archetype_id missing"]) },
    "08_import_rankup_generated": { name: "08_import_rankup_generated", table: "rankup_generated_questions", key: "rankup_question_id", proposedTable: true, input: C("rankup_questions.jsonl"), map: (r) => ({ ...r }), validate: (r) => [!r.rankup_question_id && "id missing", !r.answer_raw && "answer missing", !r.solution_text && "solution missing", !r.difficulty && "difficulty missing"].filter(Boolean) },
    "09_import_provenance": { name: "09_import_provenance", table: "qbg_question_provenance_edges", key: "edge_id", proposedTable: true, input: C("provenance_edges.jsonl"), map: (r) => ({ edge_id: `${r.from}|${r.relation}|${r.to}`, ...r }), validate: (r) => (r.from && r.to ? [] : ["edge endpoint missing"]) },
};
