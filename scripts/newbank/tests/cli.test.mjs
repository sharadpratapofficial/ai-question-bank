// End-to-end CLI tests on synthetic fixtures. Network is blocked and @supabase/supabase-js
// is either forbidden or replaced by a file-backed fake (tests/support/), so nothing here
// can reach a real database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { questionIdFor } from "../lib/format.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "import-questions.mjs");
const HOOKS = pathToFileURL(path.join(here, "support", "hooks.mjs")).href;
const FIXTURE = path.join(here, "fixtures", "synthetic.jsonl");
const REF = "ljkpcqllqdamdatesbfe";
const GOOD_ENV = { SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SECRET_KEY: "sb_secret_FAKE_FOR_TESTS" };

function run(args, { supabase = "forbid", env = {}, db = null } = {}) {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "nb-runs-"));
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SUPABASE/i.test(k)));
    const p = spawnSync(process.execPath, ["--import", HOOKS, CLI, ...args], {
        encoding: "utf8",
        env: { ...base, NEWBANK_RUNS_DIR: runs, NEWBANK_TEST_SUPABASE: supabase, NEWBANK_FAKE_DB: db ?? path.join(runs, "no-db.json"), ...env },
    });
    const dirs = fs.readdirSync(runs).filter((d) => fs.statSync(path.join(runs, d)).isDirectory());
    const out = dirs.length ? path.join(runs, dirs[0]) : null;
    const read = (f) => (out && fs.existsSync(path.join(out, f)) ? JSON.parse(fs.readFileSync(path.join(out, f), "utf8")) : null);
    return { code: p.status, stdout: p.stdout, stderr: p.stderr, plan: read("plan.json"), rejected: read("rejected.json"), result: read("result.json") };
}
const newDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nb-db-")), "db.json");
const dbState = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { tables: {}, reads: 0, writes: 0 });
const rows = (f) => dbState(f).tables.qbg_questions ?? [];

test("dry run: validates the fixture and never loads the DB client, even with credentials set", () => {
    const r = run([`--input=${FIXTURE}`], { supabase: "forbid", env: GOOD_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /database not contacted/);
    assert.equal(r.plan.records_read, 19);
    assert.equal(r.plan.valid, 9);
    assert.equal(r.plan.rejected, 10);
    assert.equal(r.plan.units, 7);
    const why = Object.fromEntries(r.rejected.map((x) => [x.source_key ?? `line${x.record_number}`, x.errors.join(" | ")]));
    assert.match(why["SYN-BAD-NOANSWER"], /missing required field answer/);
    assert.match(why["SYN-BAD-NOCHAPTER"], /missing required field chapter/);
    assert.match(why["SYN-BAD-RANGE"], /outside options/);
    assert.match(why["line13"], /invalid JSON/);
    assert.match(why["SYN-DUP"], /duplicate source_key/);
    assert.equal(r.rejected.filter((x) => x.source_key === "SYN-DUP").length, 2);
    assert.match(why["SYN-BAD-IMG"], /not embeddable/);
    assert.match(why["SYN-BAD-TYPE"], /unsupported question_type/);
    assert.match(why["SYN-P2-C1"], /not a single number/);
    assert.match(why["SYN-P2"], /group incomplete/);
    const types = r.plan.selected.map((s) => s.question_type).sort();
    assert.deepEqual(types, ["Assertion_Reason(AR)", "Composite", "Integer", "Integer", "Matching_List(ML)", "Multi_Choice(MCQ)", "Numerical", "Single_Choice(SCQ)", "Single_Choice(SCQ)"]);
});

test("negative control: the forbid guard really catches a DB-client load", () => {
    const r = run([`--input=${FIXTURE}`, "--check-db", `--confirm-project=${REF}`], { supabase: "forbid", env: GOOD_ENV });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TEST GUARD: @supabase\/supabase-js was loaded/);
});

test("--check-db only reads", () => {
    const db = newDb();
    const r = run([`--input=${FIXTURE}`, "--check-db", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.plan.decisions.insert, 9);
    assert.ok(dbState(db).reads > 0);
    assert.equal(dbState(db).writes, 0);
});

test("--apply guards: scope, confirmation, project ref, credentials, --dry-run precedence", () => {
    const cases = [
        [["--apply", `--confirm-project=${REF}`], GOOD_ENV, /explicit scope/],
        [["--apply", "--all"], GOOD_ENV, /needs --confirm-project/],
        [["--apply", "--all", "--confirm-project=abcdefghijklmnopqrst"], GOOD_ENV, /not the new question-bank project/],
        [["--apply", "--all", `--confirm-project=${REF}`], { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "x" }, /does not match the project in SUPABASE_URL/],
        [["--apply", "--all", `--confirm-project=${REF}`], {}, /must be set/],
        [["--check-db"], GOOD_ENV, /needs --confirm-project/],
    ];
    for (const [args, env, msg] of cases) {
        const db = newDb();
        const r = run([`--input=${FIXTURE}`, ...args], { supabase: "fake", env, db });
        assert.equal(r.code, 1, `${args.join(" ")} should fail`);
        assert.match(r.stderr, msg);
        assert.equal(fs.existsSync(db), false, `${args.join(" ")} must not touch the DB`);
    }
    const r = run([`--input=${FIXTURE}`, "--apply", "--all", `--confirm-project=${REF}`, "--dry-run"], { supabase: "forbid", env: GOOD_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.plan.mode, "dry-run");
});

test("apply inserts the valid rows exactly; re-running creates no duplicates", () => {
    const db = newDb();
    const r1 = run([`--input=${FIXTURE}`, "--apply", "--all", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.result.counts.inserted, 9);
    assert.equal(r1.result.counts.rejected_in_file, 10);
    assert.deepEqual([r1.result.read_back.ok, r1.result.read_back.checked], [9, 9]);
    const t = rows(db);
    assert.equal(t.length, 9);
    const by = Object.fromEntries(t.map((x) => [x.raw_data[0]._newbank.source_key, x]));

    // stable ids + answer indexing
    for (const [k, x] of Object.entries(by)) assert.equal(x.question_id, questionIdFor(k));
    assert.deepEqual(by["SYN-SCQ-1"].answer_key, [2]);
    assert.deepEqual(by["SYN-SCQ-1"].options.map((o) => o.isCorrect), [false, true, false, false]);
    assert.deepEqual(by["SYN-MSQ-1"].answer_key, [1, 3]);
    assert.equal(by["SYN-NUM-1"].answer_key, 2.5);
    assert.equal(by["SYN-INT-1"].answer_key, 12);
    assert.deepEqual(by["SYN-AR-1"].answer_key, [1]);
    assert.deepEqual(by["SYN-ML-1"].answer_key, [1]);
    assert.equal(by["SYN-ML-1"].question_type, "Matching_List(ML)");
    assert.deepEqual(by["SYN-SCQ-1"].exam, ["JEE Mains"]);

    // nothing invented
    assert.equal(by["SYN-INT-1"].difficutly_level, null);
    assert.equal(by["SYN-INT-1"].solution_text, null);
    assert.equal(by["SYN-P1"].answer_key, null);

    // comprehension linkage
    assert.equal(by["SYN-P1-C1"].parent_question_id, by["SYN-P1"].question_id);
    assert.equal(by["SYN-P1-C2"].parent_question_id, by["SYN-P1"].question_id);
    assert.equal(by["SYN-P1-C1"].raw_data[0]._newbank.child_order, 1);
    assert.equal(by["SYN-P1-C1"].child_order, 1, "G2 column");
    assert.equal(by["SYN-P1-C2"].child_order, 2, "G2 column");
    assert.equal(by["SYN-SCQ-1"].child_order, null, "standalone questions have no position");
    assert.equal(by["SYN-P1"].child_order, null, "the passage parent has no position");

    const writesBefore = dbState(db).writes;
    const r2 = run([`--input=${FIXTURE}`, "--apply", "--all", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.result.counts.inserted, 0);
    assert.equal(r2.plan.decisions["skip: unchanged"], 9);
    assert.equal(rows(db).length, 9);
    assert.equal(dbState(db).writes, writesBefore, "a no-op re-run performs no writes");
});

test("--limit trial imports whole units only", () => {
    const db = newDb();
    const r = run([`--input=${FIXTURE}`, "--apply", "--limit=7", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.plan.selection.units, 7);
    assert.equal(r.plan.selection.rows, 9);
    const r2 = run([`--input=${FIXTURE}`, "--apply", "--only=SYN-P1-C2", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db: newDb() });
    assert.deepEqual(r2.plan.selected.map((s) => s.source_key), ["SYN-P1", "SYN-P1-C1", "SYN-P1-C2"]);
});

test("manually edited questions are never overwritten, even with --update-existing", () => {
    const db = newDb();
    run([`--input=${FIXTURE}`, "--apply", "--all", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    const s = dbState(db);
    const edited = s.tables.qbg_questions.find((x) => x.raw_data[0]._newbank.source_key === "SYN-SCQ-1");
    edited.question_text = "<p>edited by a reviewer in the app</p>";
    const reviewed = s.tables.qbg_questions.find((x) => x.raw_data[0]._newbank.source_key === "SYN-MSQ-1");
    reviewed.status = "verified";
    fs.writeFileSync(db, JSON.stringify(s));

    // the source changes all three questions
    const changed = fs.readFileSync(FIXTURE, "utf8").split("\n").map((l) => {
        if (!l.startsWith("{\"source_key\":\"SYN-")) return l;
        const o = JSON.parse(l);
        if (["SYN-SCQ-1", "SYN-MSQ-1", "SYN-NUM-1"].includes(o.source_key)) o.solution_text = "<p>SYNTHETIC revised solution.</p>";
        return JSON.stringify(o);
    }).join("\n");
    const f2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nb-in-")), "changed.jsonl");
    fs.writeFileSync(f2, changed);

    const plain = run([`--input=${f2}`, "--apply", "--all", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(plain.result.counts.updated, 0, "without --update-existing nothing is updated");

    const r = run([`--input=${f2}`, "--apply", "--all", "--update-existing", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.result.counts.updated, 1, "only the untouched, still-pending row is updated");
    const after = Object.fromEntries(rows(db).map((x) => [x.raw_data[0]._newbank.source_key, x]));
    assert.equal(after["SYN-SCQ-1"].question_text, "<p>edited by a reviewer in the app</p>");
    assert.equal(after["SYN-SCQ-1"].solution_text, "<p>SYNTHETIC solution.</p>");
    assert.equal(after["SYN-MSQ-1"].solution_text, "<p>SYNTHETIC solution.</p>");
    assert.equal(after["SYN-NUM-1"].solution_text, "<p>SYNTHETIC revised solution.</p>");
    assert.equal(rows(db).length, 9);
});
