import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeConflict, categorizeDuplicate, parentChildRelationships, coverageFor } from "../lib/qc.mjs";
import { splitInlineOptions } from "../04_docx_extract.mjs";

const src = (source, location = "row 1") => ({ source, location, raw: null });
const conflict = (field, severity, values, extra = {}) => ({ field, severity, conflict_type: `${field.toUpperCase()}_CONFLICT`, values: values.map(([value, sources]) => ({ value, sources: sources.map((s) => (typeof s === "string" ? src(s) : s)) })), ...extra });

test("conflict analysis explains, never resolves", () => {
    const cases = [
        [conflict("class_level", "LOW", [["11", ["important_ids.Onepass Test Series.Class"]], ["12", ["important_ids.Onepass Test Series.Class"]]]), "SAME_COLUMN_DIFFERENT_OCCURRENCES"],
        [conflict("question_type", "LOW", [["Integer", ["autocuration.question_type"]], ["Numerical", ["autocuration.question_type_original"]]]), "CURRENT_VS_ORIGINAL_CURATION_FIELD"],
        [conflict("question_type", "LOW", [["Integer", ["autocuration.question_type", "important_ids.AITS.Q.Type"]], ["Numerical", ["autocuration.question_type_original"]]]), "VALUE_TYPE_GRANULARITY"],
        [conflict("question_type", "HIGH", [["Integer", ["autocuration.question_type"]], ["Single_Choice(SCQ)", ["important_ids.AITS.Q.Type"]]]), "OPTION_VS_VALUE_TYPE"],
        [conflict("subject", "HIGH", [["Chemistry", [src("important_ids.AITS.Subject", "AITS!C5")]], ["Maths", [src("important_ids.AITS.subject_id->taxonomy", "AITS!C5")]]]), "LABEL_VS_TAXONOMY_ID"],
        [conflict("source", "MEDIUM", [["AIR", [src("autocuration.source", "row 118")]], ["AITS", [src("autocuration.source", "row 33919")]]]), "DUPLICATE_WORKBOOK_ROWS_DISAGREE"],
        [conflict("chapter", "MEDIUM", [["X", ["autocuration.chapter"]], ["Y", ["qbg_export.chapter"]]]), "QBG_EXPORT_DISAGREES"],
        [conflict("difficulty", "MEDIUM", [["Hard", ["autocuration.difficulty_level"]], ["Medium", ["important_ids.AITS.difficulty"]]]), "CROSS_SOURCE_DISAGREEMENT"],
        [{ ...conflict("chapter", "LOW", [["a", ["x"]], ["b", ["y"]]]), conflict_type: "CHAPTER_NAME_VARIANT" }, "NAME_VARIANT_SAME_TAXONOMY_ID"],
    ];
    for (const [c, want] of cases) {
        const a = analyzeConflict(c);
        assert.equal(a.category, want, JSON.stringify(c.values));
        assert.equal(a.auto_resolution, "NOT_APPLIED");
        assert.ok(a.explanation && a.why_open);
    }
});

test("evidence suggestion only when the tagging table gives exactly one matching class - and is never applied", () => {
    const c = conflict("class_level", "LOW", [["11", ["important_ids.Onepass Test Series.Class"]], ["12", ["important_ids.Onepass Test Series.Class"]]]);
    assert.equal(analyzeConflict(c, { chapterClassById: new Map([["ch1", new Set(["12"])]]), canonicalChapterId: "ch1" }).evidence_suggestion.value, "12");
    assert.equal(analyzeConflict(c, { chapterClassById: new Map([["ch1", new Set(["11", "12"])]]), canonicalChapterId: "ch1" }).evidence_suggestion, null);
    assert.equal(analyzeConflict(c, { chapterClassById: new Map([["ch1", new Set(["10"])]]), canonicalChapterId: "ch1" }).evidence_suggestion, null);
    assert.equal(analyzeConflict(c, { chapterClassById: new Map(), canonicalChapterId: null }).evidence_suggestion, null);
    assert.equal(c.resolution, undefined, "analysis does not touch the conflict itself");
});

test("duplicate categories separate id reuse, inferred passage parents and position anomalies", () => {
    const passage = { duplicate_type: "SAME_ID_TWICE_IN_ONE_TEST", members: ["qbg:p1"], detail: "T: positions Q014, Q015 (JRTS!H231, JRTS!H232); consecutive positions: possibly ..." };
    let d = categorizeDuplicate(passage, { typesById: new Map([["p1", ["Comprehension(COMP)"]]]) });
    assert.equal(d.category, "PASSAGE_PARENT_REUSE_INFERRED");
    assert.equal(d.relationship_status, "INFERRED");
    assert.match(d.evidence[1], /supports the inference/);
    d = categorizeDuplicate(passage, { typesById: new Map() });
    assert.match(d.evidence[1], /position pattern only/);
    assert.equal(categorizeDuplicate({ duplicate_type: "SAME_ID_TWICE_IN_ONE_TEST", members: ["qbg:x"], detail: "T: positions Q1, Q9 (..)" }).category, "REPEATED_ID_IN_TEST_UNEXPLAINED");
    assert.equal(categorizeDuplicate({ duplicate_type: "EXACT_ID_MULTIPLE_WORKBOOK_ROWS" }).category, "REPEATED_ID_ACROSS_WORKBOOK_ROWS");
    assert.equal(categorizeDuplicate({ duplicate_type: "SAME_SOURCE_POSITION_DIFFERENT_QBG_IDS" }).same_question_record, false);
    assert.equal(categorizeDuplicate({ duplicate_type: "EXACT_TEXT", similarity: 1 }).category, "DUPLICATE_QUESTION_TEXT");
});

test("parent-child: inferred only; a self-reference is an anomaly", () => {
    const r = parentChildRelationships({ compCandidates: [{ qbg_id: "a", parent_candidate: "a" }, { qbg_id: "b", parent_candidate: "c" }], passageGroups: [{ qbg_id: "p", positions: "Q1, Q2", test: "T" }] });
    assert.match(r[0].relationship_status, /^ANOMALY/);
    assert.equal(r[1].relationship_status, "INFERRED");
    assert.match(r[2].relationship_status, /^INFERRED/);
    assert.ok(r.every((x) => !/VERIFIED/.test(x.relationship_status)));
});

test("coverage flags come only from recorded data", () => {
    const meta = { qbg_id: "q", question_text: null, options: null, answer_key: null, solution_text: null, question_type: "Numerical", subject: "Physics", chapter: null, documents: { question_documents: ["gdrive:d1"], solution_documents: [] }, test_usage: { occurrence_count: 2 }, conflict_ids: [], duplicate_group_ids: [], recovery_class: "E_METADATA_ONLY", import_readiness: "NOT_READY" };
    let c = coverageFor(meta);
    assert.equal(c.metadata_only, true);
    assert.equal(c.requires_external_source, true);
    assert.equal(c.potentially_recoverable_locally, false);
    assert.ok(!c.missing.includes("options"), "value types need no options");
    assert.ok(c.missing.includes("chapter"));
    c = coverageFor(meta, { localDocIds: new Set(["gdrive:d1"]) });
    assert.equal(c.potentially_recoverable_locally, true);
    assert.equal(c.requires_external_source, false);
    c = coverageFor({ ...meta, question_text: "<p>x</p>", answer_key: 3, content_source: { status: "MATCHED" } });
    assert.equal(c.requires_external_source, false);
    assert.equal(c.content_source_status, "MATCHED");
});

test("docx: options that start inside a stem paragraph are split only on the exact option layout", () => {
    const T = (v) => ({ t: "text", v }), TAB = { t: "tab" }, OLE = { t: "ole" };
    const r = splitInlineOptions([T("the value of "), OLE, T("(1)"), TAB, T("237"), TAB, T("(2)"), TAB, T("-240")]);
    assert.equal(r.stem.length, 2);
    assert.deepEqual(r.options.map((o) => o.n), [1, 2]);
    assert.equal(splitInlineOptions([T("statement (1) holds"), TAB, T("and (2)")]), null, "'(1)' inside prose is not an option marker");
    assert.equal(splitInlineOptions([T("(1)"), TAB, T("only one option")]), null, "needs a following (2)");
});
