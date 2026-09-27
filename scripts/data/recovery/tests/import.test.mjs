import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runImport, MemoryTarget } from "../../import/lib/importer.mjs";
import { mapQuestionRow, validateQuestionRow } from "../../import/lib/specs.mjs";
import { uuidv5 } from "../lib/common.mjs";

process.env.IMPORT_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "impwork-"));

function fixture(n) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
    const f = path.join(dir, "in.jsonl");
    fs.writeFileSync(f, Array.from({ length: n }, (_, i) => JSON.stringify({ id: `k${i}`, v: i, ok: i % 5 !== 0 })).join("\n") + "\n");
    return { name: `test_${path.basename(dir)}`, table: "t", key: "id", input: f, select: (r) => (r.ok ? { include: true } : { include: false, reason: "not ok" }), map: (r) => ({ id: r.id, v: r.v }) };
}

test("dry run never touches a target and reports a plan", async () => {
    const spec = fixture(10);
    const plan = await runImport(spec, ["--dry-run"]);
    assert.equal(plan.mode, "DRY_RUN");
    assert.equal(plan.written, 0);
    assert.equal(plan.rows_to_write, 8);
    assert.deepEqual(plan.skipped, { "not ok": 2 });
});

test("apply without confirmation is refused", async () => {
    const spec = fixture(3);
    await assert.rejects(() => runImport(spec, ["--apply"]), /confirm-project/);
});

test("import is idempotent (re-running yields the same target state)", async () => {
    const spec = fixture(23);
    const target = new MemoryTarget();
    await runImport(spec, ["--apply", "--batch-size=5"], target);
    const first = JSON.stringify([...target.tables.get("t")]);
    await runImport(spec, ["--apply", "--batch-size=5"], target);
    assert.equal(JSON.stringify([...target.tables.get("t")]), first);
    assert.equal(await target.count("t"), 18);
});

test("import resumes after the last committed batch", async () => {
    const spec = fixture(30);
    let calls = 0;
    const flaky = new MemoryTarget();
    const orig = flaky.upsert.bind(flaky);
    flaky.upsert = async (...a) => { calls++; if (calls === 3) throw new Error("network blip"); return orig(...a); };
    await assert.rejects(() => runImport(spec, ["--apply", "--batch-size=5"], flaky), /blip/);
    assert.equal(await flaky.count("t"), 10); // 2 batches committed
    const resumed = await runImport(spec, ["--apply", "--batch-size=5", "--resume"], flaky);
    assert.equal(resumed.started_at_batch, 2);
    assert.equal(await flaky.count("t"), 24);
});

test("missing (proposed) table aborts before writing", async () => {
    const spec = { ...fixture(3), proposedTable: true };
    const target = new MemoryTarget(new Set(["other"]));
    await assert.rejects(() => runImport(spec, ["--apply"], target), /does not exist/);
    assert.equal(target.calls, 0);
});

test("duplicate keys abort before writing", async () => {
    const spec = fixture(4);
    spec.map = () => ({ id: "same", v: 1 });
    const target = new MemoryTarget();
    await assert.rejects(() => runImport(spec, ["--apply"], target), /duplicate/);
    assert.equal(target.calls, 0);
});

test("qbg_questions mapping keeps the app contract", () => {
    const rec = { question_id: uuidv5("docx:x#Q1"), record_key: "docx:x#Q1", qbg_id: null, origin_type: "IMPORTED_EXTERNAL", question_text: "<p>q</p>", options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }, { text: "d", isCorrect: false }], answer_key: [2], solution_text: "s", question_type: "Single_Choice(SCQ)", subject: "Physics", difficulty_level: "Medium", exam: ["JEE Main"], recovery_class: "A_FULL", confidence: {}, import_readiness: "READY_WITH_REVIEW", conflict_ids: [], duplicate_group_ids: [], provenance: {} };
    const row = mapQuestionRow(rec);
    assert.equal(row.difficutly_level, "Medium");
    assert.ok(!("difficulty_level" in row));
    assert.ok(Array.isArray(row.raw_data) && row.raw_data[0]._recovery.record_key === "docx:x#Q1");
    assert.equal(row.status, "verification_pending");
    assert.deepEqual(validateQuestionRow(row), []);
    assert.ok(validateQuestionRow({ ...row, answer_key: 3 }).some((e) => /index array/.test(e)));
    assert.ok(validateQuestionRow({ ...row, question_type: "Numerical", answer_key: [2] }).some((e) => /value-type/.test(e)));
    assert.ok(validateQuestionRow({ ...row, question_text: null }).some((e) => /metadata-only/.test(e)));
});
