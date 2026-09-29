// The historical recovery import must refuse the new operational question-bank project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runImport, parseArgs, assertNotProtectedProject, PROTECTED_PROJECT_REFS } from "../../import/lib/importer.mjs";

const NEWBANK = "ljkpcqllqdamdatesbfe";
process.env.IMPORT_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "impwork-guard-"));

function spec() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-guard-"));
    const f = path.join(dir, "in.jsonl");
    fs.writeFileSync(f, JSON.stringify({ id: "k1" }) + "\n");
    return { name: `guard_${path.basename(dir)}`, table: "qbg_questions", key: "id", input: f, map: (r) => r };
}

/** Run with a temporary environment; restores it afterwards. */
async function withEnv(env, fn) {
    const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RECOVERY_IMPORT_PROTECTED_OVERRIDE"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    try { return await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("the new question-bank project is protected", () => {
    assert.ok(PROTECTED_PROJECT_REFS.includes(NEWBANK));
    assert.ok(Object.isFrozen(PROTECTED_PROJECT_REFS));
});

test("--apply into the new question-bank project is refused before any connection", async () => {
    await withEnv({ SUPABASE_URL: `https://${NEWBANK}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "fake" }, async () => {
        const origFetch = globalThis.fetch;
        let fetched = false;
        globalThis.fetch = () => { fetched = true; throw new Error("network"); };
        try {
            await assert.rejects(runImport(spec(), ["--apply", `--confirm-project=${NEWBANK}`]), /Refusing to import recovery data into protected project/);
        } finally { globalThis.fetch = origFetch; }
        assert.equal(fetched, false);
    });
});

test("a one-sided override (flag only, or env only) is refused", async () => {
    await withEnv({ SUPABASE_URL: `https://${NEWBANK}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "fake" }, async () => {
        await assert.rejects(runImport(spec(), ["--apply", `--confirm-project=${NEWBANK}`, `--override-protected-project=${NEWBANK}`]), /protected project/);
    });
    await withEnv({ SUPABASE_URL: `https://${NEWBANK}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "fake", RECOVERY_IMPORT_PROTECTED_OVERRIDE: NEWBANK }, async () => {
        await assert.rejects(runImport(spec(), ["--apply", `--confirm-project=${NEWBANK}`]), /protected project/);
    });
});

test("the override must name the exact ref in both places", () => {
    const args = (v) => parseArgs(["--apply", `--override-protected-project=${v}`]);
    assert.throws(() => assertNotProtectedProject([NEWBANK], args("other"), { RECOVERY_IMPORT_PROTECTED_OVERRIDE: NEWBANK }), /protected project/);
    assert.throws(() => assertNotProtectedProject([NEWBANK], args(NEWBANK), { RECOVERY_IMPORT_PROTECTED_OVERRIDE: "yes" }), /protected project/);
    assert.doesNotThrow(() => assertNotProtectedProject([NEWBANK], args(NEWBANK), { RECOVERY_IMPORT_PROTECTED_OVERRIDE: NEWBANK }));
});

test("the guard also fires when only SUPABASE_URL points at the protected project", () => {
    // confirm-project names another ref, but the URL really targets the new bank
    assert.throws(() => assertNotProtectedProject(["someotherprojectref", NEWBANK], parseArgs(["--apply"]), {}), /protected project/);
});

test("other projects and dry runs are unaffected", async () => {
    assert.doesNotThrow(() => assertNotProtectedProject(["abcdefghijklmnopqrst"], parseArgs(["--apply"]), {}));
    await withEnv({ SUPABASE_URL: `https://${NEWBANK}.supabase.co` }, async () => {
        const plan = await runImport(spec(), []); // dry run: never connects, so no guard needed
        assert.equal(plan.mode, "DRY_RUN");
        assert.equal(plan.written, 0);
    });
});
