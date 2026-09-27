// Importer image support: local resolution, dry-run safety, upload order, idempotent retry,
// no overwrite. Synthetic images in temp folders only; network blocked in CLI runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mapRecord, questionIdFor, contentHash } from "../lib/format.mjs";
import { buildPlan, classify, applyDecisions } from "../lib/plan.mjs";
import { createMediaResolver } from "../lib/media.mjs";
import { mediaFileName } from "../../../src/lib/questionMedia/core.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "import-questions.mjs");
const HOOKS = pathToFileURL(path.join(here, "support", "hooks.mjs")).href;
const REF = "ljkpcqllqdamdatesbfe";
const GOOD_ENV = { SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SECRET_KEY: "sb_secret_FAKE_FOR_TESTS" };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function mediaDir() {
    const dir = tmp("nb-media-");
    fs.mkdirSync(path.join(dir, "figs"));
    fs.writeFileSync(path.join(dir, "figs", "fig 1.png"), PNG);
    fs.writeFileSync(path.join(dir, "figs", "photo.jpg"), JPEG);
    fs.writeFileSync(path.join(dir, "figs", "vector.svg"), SVG);
    fs.writeFileSync(path.join(dir, "figs", "liar.jpg"), PNG); // extension says jpeg, content is png
    fs.writeFileSync(path.join(dir, "figs", "empty.png"), Buffer.alloc(0));
    fs.writeFileSync(path.join(dir, "figs", "huge.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    fs.writeFileSync(path.join(path.dirname(dir), `outside-${path.basename(dir)}.png`), PNG);
    return dir;
}
const base = { source: "SYNTHETIC", subject: "Physics", chapter: "SYN" };
const scq = (k, extra = {}) => ({ ...base, source_key: k, question_type: "SCQ", question_text: "<p>q</p>", options: ["a", "b", "c", "d"], answer: 1, solution_text: "<p>s</p>", ...extra });
const expectedPath = (key, name, bytes, ext) => `newbank/${questionIdFor(key)}/${mediaFileName(name, sha(bytes), ext)}`;

// ------------------------------------------------------------ mapping ---

test("media: refs become deterministic question-media paths with provenance", () => {
    const resolve = createMediaResolver({ mediaDir: mediaDir() });
    const rec = scq("SYN-IMG-1", { question_text: '<p>see <img alt="f" src="media:figs/fig 1.png"></p>' });
    const r = mapRecord(rec, { resolveMedia: resolve });
    assert.equal(r.ok, true, r.errors.join("; "));
    const p = expectedPath("SYN-IMG-1", "fig 1.png", PNG, "png");
    assert.equal(r.row.question_text, `<p>see <img alt="f" src="/api/question-media/${p}"></p>`);
    assert.deepEqual(r.row.raw_data[0]._newbank.media, [{ field: "question_text", source: "figs/fig 1.png", original_name: "fig 1.png", file_name: p.split("/")[2], storage_path: p, sha256: sha(PNG), bytes: PNG.length, mime: "image/png" }]);
    assert.equal(r.meta.media.length, 1);
    const again = mapRecord(rec, { resolveMedia: createMediaResolver({ mediaDir: mediaDir() }) });
    assert.equal(contentHash(again.row), contentHash(r.row), "same source -> same row on every run");
});

test("images in options and solutions are rewritten; one object per distinct image per question", () => {
    const resolve = createMediaResolver({ mediaDir: mediaDir() });
    const r = mapRecord(scq("SYN-IMG-2", {
        question_text: '<img src="media:figs/fig 1.png">',
        options: ['<img src="media:figs/fig 1.png">', '<img src="media:figs/photo.jpg">', "c", "d"],
        solution_text: "<p><img src='media:figs/photo.jpg'></p>",
    }), { resolveMedia: resolve });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.row.raw_data[0]._newbank.media.length, 4, "every reference is recorded");
    assert.equal(r.meta.media.length, 2, "but each object is uploaded once");
    assert.match(r.row.options[1].text, /src="\/api\/question-media\/newbank\/[0-9a-f-]{36}\/photo-[0-9a-f]{12}\.jpg"/);
    assert.match(r.row.solution_text, /<img src="\/api\/question-media\//);
    assert.ok(!JSON.stringify(r.row).includes("media:"), "no unresolved reference is stored");
});

test("unsafe, missing, wrong-type, empty and oversize images are rejected (locally)", () => {
    const dir = mediaDir();
    const resolve = createMediaResolver({ mediaDir: dir });
    const bad = {
        "media:../outside.png": /inside --media-dir/,
        [`media:../outside-${path.basename(dir)}.png`]: /inside --media-dir/,
        "media:/etc/passwd.png": /relative path/,
        "media:C:/Windows/x.png": /relative path/,
        "media:figs//fig 1.png": /relative path/,
        "media:figs/nope.png": /not found/,
        "media:figs/vector.svg": /Not a PNG, JPEG, GIF or WebP/,
        "media:figs/liar.jpg": /file name says jpeg but the content is png/,
        "media:figs/empty.png": /empty/,
        "media:figs/huge.png": /exceeds the 10 MB limit/,
        "media:figs": /not a file/,
    };
    for (const [src, why] of Object.entries(bad)) {
        const r = mapRecord(scq("SYN-BAD", { question_text: `<img src="${src}">` }), { resolveMedia: resolve });
        assert.equal(r.ok, false, src);
        assert.match(r.errors.join(" | "), why, src);
    }
    const noDir = mapRecord(scq("SYN-BAD", { question_text: '<img src="media:figs/fig 1.png">' }), { resolveMedia: createMediaResolver({}) });
    assert.match(noDir.errors.join(" | "), /needs --media-dir/);
    const noResolver = mapRecord(scq("SYN-BAD", { question_text: '<img src="media:figs/fig 1.png">' }));
    assert.match(noResolver.errors.join(" | "), /media support/);
});

test("inline data: images move to storage by default; --keep-inline-images keeps them", () => {
    const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
    const rec = scq("SYN-INLINE", { question_text: `<img src="${dataUrl}">` });
    const moved = mapRecord(rec, { resolveMedia: createMediaResolver({}) });
    assert.equal(moved.ok, true, moved.errors.join("; "));
    assert.equal(moved.row.question_text, `<img src="/api/question-media/${expectedPath("SYN-INLINE", "inline-1.png", PNG, "png")}">`);
    assert.equal(moved.row.raw_data[0]._newbank.media[0].source, "inline data URL #1");
    const kept = mapRecord(rec, { resolveMedia: createMediaResolver({ keepInline: true }) });
    assert.equal(kept.row.question_text, rec.question_text);
    assert.equal(kept.meta.media.length, 0);
    const svg = mapRecord(scq("SYN-SVG", { question_text: `<img src="data:image/svg+xml;base64,${SVG.toString("base64")}">` }), { resolveMedia: createMediaResolver({}) });
    assert.equal(svg.ok, false, "SVG is never stored");
});

// ------------------------------------------------------------- apply ---

class MemTarget {
    constructor() { this.rows = new Map(); this.objects = new Map(); this.log = []; }
    async fetchByIds(ids) { return new Map(ids.filter((i) => this.rows.has(i)).map((i) => [i, structuredClone(this.rows.get(i))])); }
    async fetchByQbgIds() { return []; }
    async insert(rows) { for (const r of rows) { this.log.push(`row:${r.raw_data[0]._newbank.source_key}`); this.rows.set(r.question_id, structuredClone(r)); } }
    async update(id, patch) { this.rows.set(id, { ...this.rows.get(id), ...structuredClone(patch) }); }
    async uploadMedia(p, bytes) { this.log.push(`media:${p.split("/")[2]}`); if (this.objects.has(p)) return "exists"; this.objects.set(p, Buffer.from(bytes)); return "uploaded"; }
    async downloadMedia(p) { return this.objects.get(p) ?? null; }
}
const planOf = (recs, dir) => buildPlan(recs.map((value, i) => ({ recordNumber: i + 1, value })), { resolveMedia: createMediaResolver({ mediaDir: dir }) });

test("apply uploads a question's images before writing the row, then verifies both", async () => {
    const dir = mediaDir(), t = new MemTarget();
    const p = planOf([scq("SYN-A1", { question_text: '<img src="media:figs/fig 1.png">' })], dir);
    const r = await applyDecisions(await classify(p.units, t), t);
    assert.deepEqual(t.log.map((x) => x.split(":")[0]), ["media", "row"]);
    assert.deepEqual([r.inserted, r.media.uploaded, r.read_back.ok, r.read_back.mismatches.length], [1, 1, 1, 0]);
});

test("a failed image holds back its whole passage group and never overwrites the existing object", async () => {
    const dir = mediaDir(), t = new MemTarget();
    const parent = { ...base, source_key: "SYN-P", question_type: "Comprehension", question_text: '<p>passage <img src="media:figs/fig 1.png"></p>' };
    const child = scq("SYN-P-1", { parent_source_key: "SYN-P", child_order: 1 });
    const standalone = scq("SYN-S", { question_text: '<img src="media:figs/photo.jpg">' });
    const p = planOf([parent, child, standalone], dir);
    const squatted = expectedPath("SYN-P", "figs/fig 1.png", PNG, "png");
    t.objects.set(squatted, Buffer.from("different bytes"));
    const r = await applyDecisions(await classify(p.units, t), t);
    assert.equal(r.media.failed, 1);
    assert.equal(t.rows.has(questionIdFor("SYN-P")), false, "parent not written");
    assert.equal(t.rows.has(questionIdFor("SYN-P-1")), false, "child not written either");
    assert.equal(t.rows.has(questionIdFor("SYN-S")), true, "other units proceed");
    assert.equal(t.objects.get(squatted).toString(), "different bytes", "existing object untouched");
    assert.deepEqual(r.failed.map((f) => f.stage), ["media", "media"]);
});

test("changed image content gets a new path; the old object stays", async () => {
    const dir = mediaDir(), t = new MemTarget();
    await applyDecisions(await classify(planOf([scq("SYN-C", { question_text: '<img src="media:figs/fig 1.png">' })], dir).units, t), t);
    fs.writeFileSync(path.join(dir, "figs", "fig 1.png"), Buffer.concat([PNG, Buffer.from([0])])); // new bytes, same name
    const d = await classify(planOf([scq("SYN-C", { question_text: '<img src="media:figs/fig 1.png">' })], dir).units, t, { updateExisting: true });
    const r = await applyDecisions(d, t);
    assert.deepEqual([r.updated, r.media.uploaded], [1, 1]);
    assert.equal(t.objects.size, 2, "old image kept (older versions of the question still reference it)");
});

// --------------------------------------------------------------- CLI ---

function run(args, { supabase = "forbid", env = {}, db } = {}) {
    const runs = tmp("nb-runs-");
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SUPABASE/i.test(k)));
    const p = spawnSync(process.execPath, ["--import", HOOKS, CLI, ...args], {
        encoding: "utf8",
        env: { ...baseEnv, NEWBANK_RUNS_DIR: runs, NEWBANK_TEST_SUPABASE: supabase, NEWBANK_FAKE_DB: db ?? path.join(runs, "no-db.json"), ...env },
    });
    const out = fs.readdirSync(runs).map((d) => path.join(runs, d)).find((d) => fs.statSync(d).isDirectory());
    const read = (f) => (out && fs.existsSync(path.join(out, f)) ? JSON.parse(fs.readFileSync(path.join(out, f), "utf8")) : null);
    return { code: p.status, stdout: p.stdout, stderr: p.stderr, plan: read("plan.json"), rejected: read("rejected.json"), result: read("result.json") };
}
const dbState = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});

function cliFixture() {
    const dir = mediaDir();
    const recs = [
        scq("SYN-M1", { question_text: '<p><img src="media:figs/fig 1.png"></p>' }),
        scq("SYN-M2", { question_text: "<p>two</p>", options: ['<img src="media:figs/photo.jpg">', "b", "c", "d"] }),
        scq("SYN-M3", { question_text: `<img src="data:image/png;base64,${PNG.toString("base64")}">` }),
        scq("SYN-M4", { question_text: "<p>no image</p>" }),
        scq("SYN-BAD-SVG", { question_text: '<img src="media:figs/vector.svg">' }),
        scq("SYN-BAD-HUGE", { question_text: '<img src="media:figs/huge.png">' }),
    ];
    const input = path.join(tmp("nb-in-"), "media.jsonl");
    fs.writeFileSync(input, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return { dir, input };
}
const APPLY = ["--apply", "--all", `--confirm-project=${REF}`];

test("CLI dry run: validates images locally, uploads nothing, never loads the client", () => {
    const { dir, input } = cliFixture();
    const r = run([`--input=${input}`, `--media-dir=${dir}`], { supabase: "forbid", env: GOOD_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /images: 3 object\(s\), \d+ bytes, validated locally \(nothing uploaded\)/);
    assert.equal(r.plan.media.objects, 3);
    assert.deepEqual(r.rejected.map((x) => x.source_key).sort(), ["SYN-BAD-HUGE", "SYN-BAD-SVG"]);
});

test("CLI --check-db with images performs zero storage writes", () => {
    const { dir, input } = cliFixture();
    const db = path.join(tmp("nb-db-"), "db.json");
    const r = run([`--input=${input}`, `--media-dir=${dir}`, "--check-db", `--confirm-project=${REF}`], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(dbState(db).storageWrites ?? 0, 0);
    assert.equal(Object.keys(dbState(db).storage?.["question-media"] ?? {}).length, 0);
});

test("CLI apply: uploads each image once, rows reference the route path; re-run uploads nothing", () => {
    const { dir, input } = cliFixture();
    const db = path.join(tmp("nb-db-"), "db.json");
    const r1 = run([`--input=${input}`, `--media-dir=${dir}`, ...APPLY], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r1.code, 0, r1.stderr);
    assert.deepEqual([r1.result.counts.inserted, r1.result.counts.media_uploaded, r1.result.counts.media_failed], [4, 3, 0]);
    assert.deepEqual([r1.result.read_back.ok, r1.result.read_back.checked], [4, 4]);
    const s = dbState(db);
    const objects = Object.keys(s.storage["question-media"]).sort();
    assert.deepEqual(objects, [
        expectedPath("SYN-M1", "figs/fig 1.png", PNG, "png"),
        expectedPath("SYN-M2", "figs/photo.jpg", JPEG, "jpeg"),
        expectedPath("SYN-M3", "inline-1.png", PNG, "png"),
    ].sort());
    const m1 = s.tables.qbg_questions.find((x) => x.raw_data[0]._newbank.source_key === "SYN-M1");
    assert.equal(m1.question_text, `<p><img src="/api/question-media/${expectedPath("SYN-M1", "figs/fig 1.png", PNG, "png")}"></p>`);
    assert.ok(!JSON.stringify(s.tables.qbg_questions).includes("supabase.co"), "no storage URL stored in question data");
    assert.ok(!JSON.stringify(s.tables.qbg_questions).includes("base64,"), "no inline image stored");

    const writes = s.storageWrites;
    const r2 = run([`--input=${input}`, `--media-dir=${dir}`, ...APPLY], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual([r2.result.counts.inserted, r2.result.counts.media_uploaded], [0, 0]);
    assert.equal(dbState(db).storageWrites, writes, "no storage write on a no-op re-run");
});

test("CLI retry after an interrupted run: images already present are reused, not re-uploaded", () => {
    const { dir, input } = cliFixture();
    const db = path.join(tmp("nb-db-"), "db.json");
    const p1 = expectedPath("SYN-M1", "figs/fig 1.png", PNG, "png");
    fs.writeFileSync(db, JSON.stringify({ tables: {}, storage: { "question-media": { [p1]: { data: PNG.toString("base64"), contentType: "image/png" } } }, storageWrites: 0 }));
    const r = run([`--input=${input}`, `--media-dir=${dir}`, ...APPLY], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.result.counts.media_already_present, r.result.counts.media_uploaded, r.result.counts.inserted], [1, 2, 4]);
});

test("CLI conflict: a different object at the path is never overwritten; that question is not written", () => {
    const { dir, input } = cliFixture();
    const db = path.join(tmp("nb-db-"), "db.json");
    const p1 = expectedPath("SYN-M1", "figs/fig 1.png", PNG, "png");
    const foreign = Buffer.from("foreign bytes").toString("base64");
    fs.writeFileSync(db, JSON.stringify({ tables: {}, storage: { "question-media": { [p1]: { data: foreign, contentType: "image/png" } } }, storageWrites: 0 }));
    const r = run([`--input=${input}`, `--media-dir=${dir}`, ...APPLY], { supabase: "fake", env: GOOD_ENV, db });
    assert.equal(r.code, 2, "problems are reported with exit code 2");
    assert.deepEqual([r.result.counts.media_failed, r.result.counts.inserted], [1, 3]);
    const s = dbState(db);
    assert.equal(s.storage["question-media"][p1].data, foreign, "existing object untouched");
    assert.equal(s.tables.qbg_questions.some((x) => x.raw_data[0]._newbank.source_key === "SYN-M1"), false);
});
