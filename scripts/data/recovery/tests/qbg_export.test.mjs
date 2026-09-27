/**
 * QBG export support - tested with SYNTHETIC fixtures only. Every id below is a
 * made-up 25-character string and every text is an obvious placeholder; no
 * proprietary or real question content is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCsv, csvCell, readJsonl } from "../lib/common.mjs";
import {
    parseCsvChunks, mapHeaders, normalizeExportRecord, indexExportRows, matchExport, findQbgExportFiles, looksLikeQbgId,
} from "../lib/qbg_export.mjs";
import { runQbgExport } from "../03b_qbg_export.mjs";

// synthetic 25-char ids (lowercase base-36, like QBG unique_ids; not real ids)
const sid = (tag) => `synth${tag}`.padEnd(24, "x") + "1";
const A = sid("a"), B = sid("b"), C = sid("c"), D = sid("d"), FILEID = sid("fileid");

const opts = (correct, n = 4) => JSON.stringify({ english: Array.from({ length: n }, (_, i) => ({ text: `<p>SYNTHETIC OPTION ${i + 1}</p>`, isCorrect: correct.includes(i + 1) })) });
const sol = (t) => JSON.stringify([{ english: { text: `<p>${t}</p>`, otherSolution: "", videoSolution: { url: "", type: 1 } } }]);

const HEADER = ["unique_id", "qbg_id", "question_type", "type", "subject", "chapter", "topic", "SubtopicName", "Class", "difficulty_level", "Source", "content", "bilingual_options", "answer", "solutions", "QBGFileId", "some_unknown_col"];
const row = (o) => HEADER.map((h) => o[h] ?? "");
const ROWS = [
    row({ unique_id: A, qbg_id: A, question_type: "Single_Choice(SCQ)", type: "1", subject: "Physics", chapter: "Synthetic Chapter", Class: "11", difficulty_level: "Medium", Source: "SyntheticSource", content: JSON.stringify({ english: "<p>SYNTHETIC STEM A</p>" }), bilingual_options: opts([2]), answer: JSON.stringify({ english: null }), solutions: sol("SYNTHETIC SOLUTION A"), QBGFileId: FILEID }),
    // embedded comma, quotes and newline inside a JSON cell
    row({ unique_id: B, question_type: "Numerical", type: "3", subject: "Maths", content: JSON.stringify({ english: '<p>SYNTHETIC, "quoted"\nSTEM B</p>' }), bilingual_options: JSON.stringify({ english: [] }), answer: JSON.stringify({ english: "2.50" }), solutions: sol("SYNTHETIC SOLUTION B") }),
    row({ unique_id: A, qbg_id: A, question_type: "Single_Choice(SCQ)", type: "1", subject: "Physics", chapter: "Synthetic Chapter", Class: "11", difficulty_level: "Medium", Source: "SyntheticSource", content: JSON.stringify({ english: "<p>SYNTHETIC STEM A</p>" }), bilingual_options: opts([2]), answer: JSON.stringify({ english: null }), solutions: sol("SYNTHETIC SOLUTION A"), QBGFileId: FILEID }),
    row({ unique_id: C, question_type: "Single_Choice(SCQ)", content: JSON.stringify({ english: "<p>SYNTHETIC STEM C v1</p>" }), bilingual_options: opts([1]) }),
    row({ unique_id: C, question_type: "Single_Choice(SCQ)", content: JSON.stringify({ english: "<p>SYNTHETIC STEM C v2</p>" }), bilingual_options: opts([1]) }),
    row({ unique_id: "NOT-A-VALID-ID", content: JSON.stringify({ english: "<p>SYNTHETIC ORPHAN</p>" }) }),
    row({ unique_id: "", QBGFileId: FILEID, content: JSON.stringify({ english: "<p>SYNTHETIC ONLY FILE ID</p>" }) }),
];
const CSV = [HEADER, ...ROWS].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

async function collect(gen) { const out = []; for await (const x of gen) out.push(x); return out; }
async function* chunked(text, size) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const keysOf = (rec) => new Map(Object.keys(rec).map((h) => [h, mapHeaders([h]).keys[0]]).filter(([, k]) => k));
const rec = (i) => Object.fromEntries(HEADER.map((h, j) => [h, ROWS[i][j]]));

test("streaming CSV parser matches the in-memory parser for every chunk size", async () => {
    const expected = parseCsv(CSV).filter((r) => !(r.length === 1 && r[0] === ""));
    for (const size of [1, 2, 3, 7, 64, 1 << 20]) {
        const got = (await collect(parseCsvChunks(chunked(CSV, size)))).filter((r) => !(r.length === 1 && r[0] === ""));
        assert.deepEqual(got, expected, `chunk size ${size}`);
    }
    assert.equal(expected.length, ROWS.length + 1);
    assert.match(expected[2][11], /SYNTHETIC, \\"quoted\\"\\nSTEM B/); // JSON-escaped inside the cell, intact
});

test("header aliases follow import_pool.py; unknown columns are reported, never used", () => {
    const m = mapHeaders(["qbgid", "SubtopicName", "Class", "QC Status", "difficulty_level000", "QBGFileId", "mystery"]);
    assert.deepEqual(m.keys, ["qbg_id", "subtopic", "class_level", "qc_status", "difficulty_level", "qbg_file_id", null]);
    assert.deepEqual(m.unrecognised, ["mystery"]);
});

test("SCQ row: text, 4 options, answer from isCorrect flags, solution; QBGFileId kept opaque", () => {
    const n = normalizeExportRecord(rec(0), keysOf(rec(0)));
    assert.equal(n.schema, "QBG_PLATFORM");
    assert.equal(n.unique_id, A);
    assert.equal(n.question_type, "Single_Choice(SCQ)");
    assert.equal(n.content.question_text, "<p>SYNTHETIC STEM A</p>");
    assert.equal(n.content.options.length, 4);
    assert.deepEqual(n.content.answer_key, [2]);
    assert.equal(n.content.solution_text, "<p>SYNTHETIC SOLUTION A</p>");
    assert.equal(n.qbg_file_id, FILEID);
    assert.equal(n.metadata.subject, "Physics");
    assert.deepEqual(n.issues, []);
});

test("Numerical row: answer.english kept exactly ('2.50' stays a string), no options", () => {
    const n = normalizeExportRecord(rec(1), keysOf(rec(1)));
    assert.equal(n.question_type, "Numerical");
    assert.equal(n.content.answer_key, "2.50");
    assert.deepEqual(n.content.options, []);
    assert.equal(n.content.question_text, '<p>SYNTHETIC, "quoted"\nSTEM B</p>');
});

test("a QBGFileId is never used as the join key", () => {
    const n = normalizeExportRecord(rec(6), keysOf(rec(6)));
    assert.equal(n.unique_id, null);
    assert.ok(looksLikeQbgId(n.qbg_file_id));
    assert.ok(n.issues.some((i) => i.startsWith("INVALID_JOIN_ID")));
});

test("invalid unique_id -> no join, issue recorded, raw kept", () => {
    const n = normalizeExportRecord(rec(5), keysOf(rec(5)));
    assert.equal(n.unique_id, null);
    assert.equal(n.unique_id_raw, "NOT-A-VALID-ID");
});

test("nothing is guessed: unverified or incomplete shapes stay null with an issue", () => {
    const base = { unique_id: D, question_type: "Multi_Choice(MCQ)", content: JSON.stringify({ english: "<p>SYNTHETIC STEM D</p>" }) };
    const k = (r) => keysOf(r);
    // isCorrect missing on an option -> no answer
    let r = { ...base, bilingual_options: JSON.stringify({ english: [{ text: "x" }, { text: "y", isCorrect: true }, { text: "z", isCorrect: false }, { text: "w", isCorrect: false }] }) };
    let n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.answer_key, null);
    assert.ok(n.issues.includes("ISCORRECT_FLAG_MISSING"));
    // numeric answer as a bare scalar is not the verified {"english": ...} shape
    r = { unique_id: D, question_type: "Numerical", content: base.content, answer: "7" };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.answer_key, null);
    assert.ok(n.issues.includes("ANSWER_SHAPE_UNVERIFIED"));
    // two correct flags on a single-correct question
    r = { ...base, question_type: "Single_Choice(SCQ)", bilingual_options: opts([1, 3]) };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.answer_key, null);
    assert.ok(n.issues.includes("MULTIPLE_CORRECT_FOR_SINGLE_TYPE"));
    // three options for an option type -> options not exposed
    r = { ...base, bilingual_options: opts([1], 3) };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.options, null);
    assert.ok(n.issues.some((i) => i.startsWith("OPTIONS_INCOMPLETE")));
    // solutions vs bilingual_solutions differ -> no solution
    r = { ...base, bilingual_options: opts([1]), solutions: sol("SYNTHETIC S1"), bilingual_solutions: JSON.stringify({ english: { text: "<p>SYNTHETIC S2</p>" } }) };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.solution_text, null);
    assert.ok(n.issues.includes("SOLUTIONS_VS_BILINGUAL_SOLUTIONS_DIFFER"));
    // question_type text vs numeric type code disagree -> type unknown
    r = { unique_id: D, question_type: "Single_Choice(SCQ)", type: "2", content: base.content };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.question_type, null);
    // type code alone is accepted
    r = { unique_id: D, type: "3", content: base.content, answer: JSON.stringify({ english: "12" }) };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.question_type, "Numerical");
    assert.equal(n.content.answer_key, 12);
    // invalid JSON in a cell
    r = { unique_id: D, question_type: "Numerical", content: "{not json" };
    n = normalizeExportRecord(r, k(r));
    assert.equal(n.content.question_text, null);
    assert.ok(n.issues.includes("CONTENT_INVALID_JSON"));
});

test("app qbg_questions backup schema joins on qbg_id", () => {
    const r = { question_id: "00000000-0000-4000-8000-000000000000", qbg_id: A, question_text: "<p>SYNTHETIC APP STEM</p>", options: JSON.stringify([{ text: "a", isCorrect: false }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }, { text: "d", isCorrect: false }]), answer_key: "[2]", solution_text: "<p>SYNTHETIC APP SOL</p>", question_type: "Single_Choice(SCQ)" };
    const n = normalizeExportRecord(r, keysOf(r));
    assert.equal(n.schema, "APP_QBG_QUESTIONS");
    assert.equal(n.unique_id, A);
    assert.deepEqual(n.content.answer_key, [2]);
});

test("duplicate rows: identical content -> one value; differing -> ambiguous (no value)", () => {
    const staged = ROWS.map((_, i) => ({ file: "f.csv", row_number: i + 2, ...normalizeExportRecord(rec(i), keysOf(rec(i))) }));
    const idx = indexExportRows(staged);
    assert.equal(idx.get(A).status, "DUPLICATE_ROWS_IDENTICAL");
    assert.equal(idx.get(A).chosen.row_number, 2);
    assert.equal(idx.get(C).status, "DUPLICATE_ROWS_DIFFER");
    assert.equal(idx.get(C).chosen, null);
    assert.equal(idx.get(B).status, "SINGLE");
    assert.equal(idx.size, 3); // invalid ids never enter the index
    const m = matchExport(new Set([A, D]), idx);
    assert.deepEqual(m.matched, [A]);
    assert.deepEqual(m.known_not_in_export, [D]);
    assert.deepEqual(m.export_only, [B, C].sort());
});

test("stage 03b: absent export -> NOT_PRESENT and an empty staging file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbgexp-"));
    const s = await runQbgExport({ files: [], rowsFile: path.join(dir, "rows.jsonl"), statusFile: path.join(dir, "status.json"), repoRoot: dir });
    assert.equal(s.status, "NOT_PRESENT");
    assert.equal(fs.readFileSync(path.join(dir, "rows.jsonl"), "utf8"), "");
    assert.deepEqual(findQbgExportFiles(dir, {}), []);
});

test("stage 03b: CSV + JSONL exports staged with file, row number and hash; deterministic", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbgexp-"));
    fs.writeFileSync(path.join(dir, "QBG_data.csv"), CSV);
    fs.mkdirSync(path.join(dir, "data", "raw", "qbg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "raw", "qbg", "extra.jsonl"), JSON.stringify({ unique_id: D, question_type: "Numerical", content: { english: "<p>SYNTHETIC JSONL STEM</p>" }, answer: { english: "3" } }) + "\n");
    const files = findQbgExportFiles(dir, {});
    assert.deepEqual(files.map((f) => path.relative(dir, f).split(path.sep).join("/")), ["QBG_data.csv", "data/raw/qbg/extra.jsonl"]);
    const run = async (tag) => {
        const s = await runQbgExport({ files, rowsFile: path.join(dir, `rows${tag}.jsonl`), statusFile: path.join(dir, `status${tag}.json`), repoRoot: dir });
        return { s, rows: readJsonl(path.join(dir, `rows${tag}.jsonl`)), text: fs.readFileSync(path.join(dir, `rows${tag}.jsonl`), "utf8") };
    };
    const a = await run("1"), b = await run("2");
    assert.equal(a.s.status, "PRESENT");
    assert.equal(a.s.files[0].rows, ROWS.length);
    assert.equal(a.s.files[0].rows_invalid_id, 2);
    assert.equal(a.s.files[0].header.qbg_file_id_column_present, true);
    assert.deepEqual(a.s.files[0].header.unrecognised, ["some_unknown_col"]);
    assert.equal(a.rows[1].row_number, 3); // CSV record number (header = 1), preserved
    assert.equal(a.rows[1].file, "QBG_data.csv");
    assert.equal(a.rows.at(-1).unique_id, D);
    assert.equal(a.rows.at(-1).content.answer_key, 3);
    assert.equal(a.text, b.text, "re-running stages byte-identical rows");
    // env override is picked up first
    assert.equal(findQbgExportFiles(dir, { QBG_EXPORT_FILE: "data/raw/qbg/extra.jsonl" })[0], path.join(dir, "data", "raw", "qbg", "extra.jsonl"));
});
