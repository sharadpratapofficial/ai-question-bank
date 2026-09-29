// Synthetic records only (source_key prefix TEST-); nothing here is question-bank content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRecord, canonicalQuestionType, questionIdFor, contentHash } from "../lib/format.mjs";
import { parseInput, buildPlan, selectUnits, classify, applyDecisions } from "../lib/plan.mjs";

const base = { source: "TEST source", subject: "Physics", chapter: "TEST chapter", question_text: "<p>TEST stem</p>" };
const scq = (k, extra = {}) => ({ ...base, source_key: k, question_type: "Single_Choice(SCQ)", options: ["a", "b", "c", "d"], answer: "B", solution_text: "<p>s</p>", ...extra });
const plan = (recs) => buildPlan(recs.map((value, i) => ({ recordNumber: i + 1, value })), { sourceFile: "t.jsonl", sourceSha256: "x" });

class MemTarget {
    constructor(rows = []) { this.rows = new Map(rows.map((r) => [r.question_id, structuredClone(r)])); this.writes = 0; }
    async fetchByIds(ids) { return new Map(ids.filter((i) => this.rows.has(i)).map((i) => [i, structuredClone(this.rows.get(i))])); }
    async fetchByQbgIds(q) { return [...this.rows.values()].filter((r) => q.includes(r.qbg_id)).map((r) => ({ question_id: r.question_id, qbg_id: r.qbg_id })); }
    async insert(rows) { this.writes++; for (const r of rows) { if (this.rows.has(r.question_id)) throw new Error("duplicate key"); this.rows.set(r.question_id, structuredClone(r)); } }
    async update(id, patch) { this.writes++; this.rows.set(id, { ...this.rows.get(id), ...structuredClone(patch) }); }
}

test("SCQ maps to {text,isCorrect} options and a 1-based answer array", () => {
    const r = mapRecord(scq("TEST-1"));
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual(r.row.answer_key, [2]);
    assert.deepEqual(r.row.options.map((o) => o.isCorrect), [false, true, false, false]);
    assert.equal(r.row.question_id, questionIdFor("TEST-1"));
    assert.equal(r.row.qbg_id, r.row.question_id);
    assert.equal(r.row.difficutly_level, null, "difficulty is never defaulted");
    assert.equal(r.row.raw_data[0]._newbank.source_key, "TEST-1");
    assert.equal(r.row.raw_data[0].verification_status, undefined);
});

test("MCQ answers are sorted, deduplicated, and letters or numbers are accepted", () => {
    const r = mapRecord(scq("TEST-2", { question_type: "MSQ", answer: ["D", 1] }));
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.row.question_type, "Multi_Choice(MCQ)");
    assert.deepEqual(r.row.answer_key, [1, 4]);
    assert.equal(mapRecord(scq("TEST-3", { question_type: "MSQ", answer: ["A", "A"] })).ok, false);
});

test("ambiguous 'MCQ' / 'Multiple Choice' labels are rejected, never guessed", () => {
    for (const t of ["MCQ", "Multiple Choice", "multiple choice question"]) {
        const r = mapRecord(scq("TEST-AMB", { question_type: t, answer: ["A"] }));
        assert.equal(r.ok, false, t);
        assert.ok(r.errors.some((e) => e.startsWith("ambiguous question_type")), t);
    }
    assert.equal(canonicalQuestionType("Multi_Choice(MCQ)"), "Multi_Choice(MCQ)");
});

test("SCQ-like types reject multiple answers and out-of-range answers", () => {
    assert.equal(mapRecord(scq("TEST-4", { answer: ["A", "B"] })).ok, false);
    assert.equal(mapRecord(scq("TEST-5", { answer: 5 })).ok, false);
    assert.equal(mapRecord(scq("TEST-6", { answer: 0 })).ok, false);
    assert.equal(mapRecord(scq("TEST-7", { question_type: "AR", answer: 1 })).row.question_type, "Assertion_Reason(AR)");
    assert.equal(mapRecord(scq("TEST-8", { question_type: "Matching_List(ML)", answer: "c" })).row.answer_key[0], 3);
});

test("numeric types store a plain number, with no options", () => {
    const i = mapRecord({ ...base, source_key: "TEST-9", question_type: "Integer", answer: "243" });
    assert.equal(i.ok, true, i.errors.join("; ")); assert.equal(i.row.answer_key, 243); assert.deepEqual(i.row.options, []);
    const n = mapRecord({ ...base, source_key: "TEST-10", question_type: "Numerical", answer: "2.50" });
    assert.equal(n.row.answer_key, 2.5); assert.equal(n.row.raw_data[0]._newbank.answer_as_given, "2.50");
    assert.equal(mapRecord({ ...base, source_key: "TEST-11", question_type: "Integer", answer: 2.5 }).ok, false);
    assert.equal(mapRecord({ ...base, source_key: "TEST-12", question_type: "Numerical", answer: "2.4-2.6" }).ok, false);
    assert.equal(mapRecord({ ...base, source_key: "TEST-13", question_type: "Single_Digit_Integer", answer: 12 }).ok, false);
    assert.equal(mapRecord({ ...base, source_key: "TEST-14", question_type: "Integer", answer: 3, options: ["x"] }).ok, false);
});

test("missing required fields, unknown fields and bad vocabulary are rejected, never filled in", () => {
    const r = mapRecord({ source_key: "TEST-15", question_type: "SCQ", options: ["a", "b"], answer: 1, solution: "typo" });
    assert.equal(r.ok, false);
    for (const f of ["source", "question_text", "subject", "chapter"]) assert.ok(r.errors.some((e) => e.includes(`missing required field ${f}`)), f);
    assert.ok(r.errors.some((e) => e.includes('unknown field "solution"')));
    assert.equal(mapRecord(scq("TEST-16", { difficulty: "Tough" })).ok, false);
    assert.equal(mapRecord(scq("TEST-17", { subject: "Astrology" })).ok, false);
    assert.equal(mapRecord(scq("TEST-18", { answer: undefined })).ok, false);
    assert.equal(mapRecord(scq("TEST-19", { options: ["a", "", "c", "d"] })).ok, false);
    assert.equal(canonicalQuestionType("Passage_SCQ"), null);
    assert.equal(canonicalQuestionType("Multiple_Choice(MCQ)"), "Multi_Choice(MCQ)");
});

test("vocabulary normalisation is deterministic", () => {
    const r = mapRecord(scq("TEST-20", { subject: "mathematics", difficulty: "hard", class_level: "XII", exam: ["JEE Main", "jee main", "Olympiad"] }));
    assert.equal(r.row.subject, "Maths"); assert.equal(r.row.difficutly_level, "Hard"); assert.equal(r.row.class_level, "12");
    assert.deepEqual(r.row.exam, ["JEE Mains", "Olympiad"]);
    assert.ok(r.warnings.some((w) => w.includes("Olympiad")));
});

test("unsafe HTML and unresolved images are rejected; data URLs are accepted", () => {
    assert.equal(mapRecord(scq("TEST-21", { question_text: "<p onclick='x()'>q</p>" })).ok, false);
    assert.equal(mapRecord(scq("TEST-22", { solution_text: "<script>alert(1)</script>" })).ok, false);
    assert.equal(mapRecord(scq("TEST-23", { question_text: '<img src="image1.png">' })).ok, false);
    assert.equal(mapRecord(scq("TEST-24", { question_text: '<img src="data:image/png;base64,iVBORw0KGgo=">' })).ok, true);
});

test("HTML checks have no false positives on ordinary maths text", () => {
    const r = mapRecord(scq("TEST-25", { question_text: "<p>If one = 1 and only = 2, then \\(x_{on} = 3\\)</p>" }));
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(mapRecord(scq("TEST-26", { question_text: '<p><a href=" javascript:x()">y</a></p>' })).ok, false);
    // data-src must not be taken as the image source
    assert.equal(mapRecord(scq("TEST-27", { question_text: '<img data-src="x.png" src="data:image/png;base64,iVBORw0KGgo=">' })).ok, true);
    assert.equal(mapRecord(scq("TEST-28", { question_text: '<img data-src="data:image/png;base64,AA" src="x.png">' })).ok, false);
});

test("duplicate source_key and duplicate legacy_qbg_id reject every occurrence", () => {
    const p = plan([scq("TEST-A"), scq("TEST-A"), scq("TEST-B", { legacy_qbg_id: "abc123" }), scq("TEST-C", { legacy_qbg_id: "abc123" }), scq("TEST-D")]);
    assert.deepEqual(p.units.map((u) => u[0].meta.source_key), ["TEST-D"]);
    assert.equal(p.stats.rejected, 4);
});

test("passage groups import whole, ordered by child_order, or not at all", () => {
    const parent = { ...base, source_key: "TEST-P", question_type: "Comprehension", question_text: "<p>passage</p>" };
    const kid = (k, o, extra = {}) => scq(k, { parent_source_key: "TEST-P", child_order: o, ...extra });
    const ok = plan([parent, kid("TEST-P2", 2), kid("TEST-P1", 1)]);
    assert.equal(ok.units.length, 1);
    assert.deepEqual(ok.units[0].map((v) => v.meta.source_key), ["TEST-P", "TEST-P1", "TEST-P2"]);
    assert.equal(ok.units[0][1].row.parent_question_id, ok.units[0][0].row.question_id);
    const broken = plan([parent, kid("TEST-P1", 1), kid("TEST-P2", 2, { answer: 9 })]);
    assert.equal(broken.units.length, 0, "one bad child rejects the whole group");
    assert.equal(plan([parent]).units.length, 0, "parent without children");
    assert.equal(plan([kid("TEST-P1", 1)]).units.length, 0, "orphan child");
    assert.equal(plan([parent, kid("TEST-P1", 1), kid("TEST-P2", 1)]).units.length, 0, "duplicate child_order");
    assert.equal(mapRecord({ ...parent, answer: 1 }).ok, false, "parent carries no answer");
});

test("possible content duplicates are reported, not rejected", () => {
    const p = plan([scq("TEST-E"), scq("TEST-F")]);
    assert.equal(p.units.length, 2);
    assert.deepEqual(p.possibleDuplicates, [["TEST-E", "TEST-F"]]);
});

test("--limit counts units and --only pulls in whole groups", () => {
    const parent = { ...base, source_key: "TEST-P", question_type: "Composite", question_text: "<p>passage</p>" };
    const p = plan([scq("TEST-G"), parent, scq("TEST-P1", { parent_source_key: "TEST-P", child_order: 1 }), scq("TEST-H")]);
    assert.equal(selectUnits(p.units, { limit: 2 }).flat().length, 3);
    assert.deepEqual(selectUnits(p.units, { only: ["TEST-P1"] }).flat().map((v) => v.meta.source_key), ["TEST-P", "TEST-P1"]);
    assert.throws(() => selectUnits(p.units, { only: ["NOPE"] }));
});

test("parseInput reports bad JSON lines as records instead of aborting", () => {
    const e = parseInput('{"a":1}\n{bad\n\n', "x.jsonl");
    assert.equal(e.length, 2); assert.ok(e[1].parseError);
});

test("classify + apply: insert, idempotent re-run, no silent overwrite, read-back", async () => {
    const t = new MemTarget();
    const p1 = plan([scq("TEST-I"), scq("TEST-J", { answer: "C" })]);
    const d1 = await classify(p1.units, t);
    assert.deepEqual([...d1.values()].map((d) => d.action), ["insert", "insert"]);
    const r1 = await applyDecisions(d1, t, { now: "2026-01-01T00:00:00Z" });
    assert.equal(r1.inserted, 2); assert.equal(r1.read_back.ok, 2);

    const again = await classify(p1.units, t);
    assert.deepEqual([...again.values()].map((d) => d.reason), ["unchanged", "unchanged"]);

    const p2 = plan([scq("TEST-I", { solution_text: "<p>new</p>" })]);
    assert.match((await classify(p2.units, t)).get(questionIdFor("TEST-I")).reason, /exists_source_changed/);
    const upd = await classify(p2.units, t, { updateExisting: true });
    assert.equal(upd.get(questionIdFor("TEST-I")).action, "update");

    // simulate an app edit + ai_metadata: must not be overwritten
    const id = questionIdFor("TEST-I"), row = t.rows.get(id);
    row.question_text = "<p>edited in app</p>"; row.raw_data[0].ai_metadata = { x: 1 };
    assert.match((await classify(p2.units, t, { updateExisting: true })).get(id).reason, /edited_in_app/);

    // reviewed rows are not overwritten either
    const idJ = questionIdFor("TEST-J"); t.rows.get(idJ).status = "verified";
    const p3 = plan([scq("TEST-J", { answer: "D" })]);
    assert.match((await classify(p3.units, t, { updateExisting: true })).get(idJ).reason, /already reviewed/);
});

test("update keeps app-added raw_data keys", async () => {
    const t = new MemTarget();
    await applyDecisions(await classify(plan([scq("TEST-K")]).units, t), t);
    t.rows.get(questionIdFor("TEST-K")).raw_data[0].ai_metadata = { verified: true };
    const d = await classify(plan([scq("TEST-K", { answer: "D" })]).units, t, { updateExisting: true });
    const r = await applyDecisions(d, t);
    assert.equal(r.updated, 1); assert.equal(r.read_back.ok, 1);
    const got = t.rows.get(questionIdFor("TEST-K"));
    assert.deepEqual(got.answer_key, [4]); assert.deepEqual(got.raw_data[0].ai_metadata, { verified: true });
});

test("a legacy_qbg_id already held by another row rejects the record and its group", async () => {
    const other = { ...mapRecord(scq("TEST-OTHER")).row, qbg_id: "legacy1" };
    const t = new MemTarget([other]);
    const d = await classify(plan([scq("TEST-L", { legacy_qbg_id: "legacy1" })]).units, t);
    assert.equal(d.get(questionIdFor("TEST-L")).action, "reject");
});

test("contentHash is stable across jsonb key order", () => {
    const r = mapRecord(scq("TEST-M")).row;
    const reordered = { ...r, options: r.options.map((o) => ({ isCorrect: o.isCorrect, text: o.text })) };
    assert.equal(contentHash(reordered), contentHash(r));
});
