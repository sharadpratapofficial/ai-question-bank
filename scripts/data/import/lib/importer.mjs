/**
 * Shared import runner for scripts/data/import/NN_*.mjs.
 *
 * SAFETY
 *   - DRY RUN IS THE DEFAULT. Nothing is written anywhere except local plan/log files.
 *   - A real write needs ALL of: --apply, --confirm-project=<ref> matching the ref in
 *     SUPABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment,
 *     and the target table must already exist (the script never creates tables).
 *   - The recovery brief forbids importing into any remote database for now; the apply
 *     path exists so the scripts are complete, not to be run.
 *
 * PROPERTIES
 *   idempotent  every row is an upsert on a stable key (e.g. question_id = uuidv5(record_key))
 *   resumable   progress is stored in data/import_state/<script>.json together with the input
 *               file hash; --resume continues after the last committed batch only if the input
 *               is unchanged
 *   batched     --batch-size (default 500)
 *   logged      data/import_logs/<script>.jsonl (one line per batch / event)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const CANONICAL_DIR = path.join(REPO_ROOT, "data", "canonical");
/** Work files (plans, logs, resume state) go under data/ unless IMPORT_WORK_DIR overrides it (tests). */
const workDir = () => process.env.IMPORT_WORK_DIR || path.join(REPO_ROOT, "data");

export function parseArgs(argv) {
    const a = { apply: false, resume: false, batchSize: 500, limit: null, confirmProject: null, flags: new Set() };
    for (const x of argv) {
        if (x === "--apply") a.apply = true;
        else if (x === "--dry-run") a.apply = false;
        else if (x === "--resume") a.resume = true;
        else if (x.startsWith("--batch-size=")) a.batchSize = Math.max(1, Number(x.split("=")[1]) || 500);
        else if (x.startsWith("--limit=")) a.limit = Number(x.split("=")[1]) || null;
        else if (x.startsWith("--confirm-project=")) a.confirmProject = x.split("=")[1];
        else if (x.startsWith("--")) a.flags.add(x.slice(2));
    }
    return a;
}

export function readJsonlSync(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Records every upsert in memory (dry run and tests). */
export class MemoryTarget {
    constructor(existingTables = null) { this.tables = new Map(); this.existing = existingTables; this.calls = 0; }
    async tableExists(t) { return this.existing ? this.existing.has(t) : true; }
    async upsert(table, rows, key) {
        this.calls++;
        if (!this.tables.has(table)) this.tables.set(table, new Map());
        const m = this.tables.get(table);
        for (const r of rows) m.set(r[key], r);
    }
    async count(table) { return this.tables.get(table)?.size ?? 0; }
}

/** Supabase target (service role). Loaded lazily so dry runs never touch the network stack. */
async function supabaseTarget() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --apply");
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(url, key, { auth: { persistSession: false } });
    return {
        async tableExists(t) { const { error } = await db.from(t).select("*", { head: true, count: "exact" }).limit(1); return !error; },
        async upsert(table, rows, k) { const { error } = await db.from(table).upsert(rows, { onConflict: k, ignoreDuplicates: false }); if (error) throw new Error(`${table}: ${error.message}`); },
        async count(table) { const { count, error } = await db.from(table).select("*", { head: true, count: "exact" }); if (error) throw new Error(error.message); return count; },
    };
}

/**
 * spec: { name, table, key, input, select(rec)->{include:boolean, reason}, map(rec)->row, validate(row)->string[] , proposedTable:boolean }
 */
export async function runImport(spec, argv = process.argv.slice(2), injectedTarget = null) {
    const args = parseArgs(argv);
    const STATE_DIR = path.join(workDir(), "import_state"), LOG_DIR = path.join(workDir(), "import_logs"), PLAN_DIR = path.join(workDir(), "import_plans");
    for (const d of [STATE_DIR, LOG_DIR, PLAN_DIR]) fs.mkdirSync(d, { recursive: true });
    const logFile = path.join(LOG_DIR, `${spec.name}.jsonl`);
    const log = (ev) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), script: spec.name, ...ev }) + "\n");
    const inputs = [].concat(spec.input);
    const inputHash = sha(inputs.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : "")).join("\u0000"));
    const selected = [], skipped = new Map(), invalid = [];
    let recordsRead = 0;
    const each = function* () {
        for (const f of inputs) {
            if (!fs.existsSync(f)) continue;
            for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line) { recordsRead++; yield JSON.parse(line); }
        }
    };
    for (const r of each()) {
        const s = spec.select ? spec.select(r, args) : { include: true };
        if (!s.include) { skipped.set(s.reason, (skipped.get(s.reason) || 0) + 1); continue; }
        const row = spec.map(r);
        const errs = spec.validate ? spec.validate(row) : [];
        if (errs.length) { invalid.push({ key: row[spec.key], errors: errs }); continue; }
        selected.push(row);
    }
    const rows = args.limit ? selected.slice(0, args.limit) : selected;
    const keyCount = new Map();
    for (const r of rows) keyCount.set(r[spec.key], (keyCount.get(r[spec.key]) || 0) + 1);
    const duplicateKeys = [...keyCount].filter(([, n]) => n > 1).map(([k]) => k);
    const plan = {
        script: spec.name, table: spec.table, proposed_table: !!spec.proposedTable, key: spec.key,
        mode: args.apply ? "APPLY" : "DRY_RUN", input_files: inputs.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/")), input_hash: inputHash,
        records_read: recordsRead, rows_eligible: selected.length, rows_to_write: rows.length,
        skipped: Object.fromEntries(skipped), invalid: invalid.length, invalid_samples: invalid.slice(0, 5),
        duplicate_keys: duplicateKeys.length, duplicate_key_samples: duplicateKeys.slice(0, 5),
        batches: Math.ceil(rows.length / args.batchSize), batch_size: args.batchSize,
        sample_row: rows[0] ?? null,
    };
    fs.writeFileSync(path.join(PLAN_DIR, `${spec.name}.json`), JSON.stringify(plan, null, 2) + "\n");

    if (!args.apply && !injectedTarget) {
        log({ event: "dry_run", rows_to_write: rows.length, invalid: invalid.length });
        return { ...plan, written: 0 };
    }

    if (duplicateKeys.length) {
        log({ event: "abort", reason: `${duplicateKeys.length} duplicate keys` });
        throw new Error(`${duplicateKeys.length} duplicate ${spec.key} values in the input (e.g. ${duplicateKeys[0]}). Nothing written.`);
    }
    let target = injectedTarget;
    if (!target) {
        if (!args.confirmProject) throw new Error("--apply requires --confirm-project=<project-ref>");
        const ref = (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\./)?.[1];
        if (ref !== args.confirmProject) throw new Error(`--confirm-project=${args.confirmProject} does not match SUPABASE_URL project ref ${ref}`);
        target = await supabaseTarget();
    }
    if (!(await target.tableExists(spec.table))) {
        log({ event: "abort", reason: `table ${spec.table} does not exist` });
        throw new Error(`Target table ${spec.table} does not exist${spec.proposedTable ? " (it is a PROPOSED table; see docs/data_recovery/SCHEMA_GAP_ANALYSIS.md)" : ""}. Nothing written.`);
    }
    const stateFile = path.join(STATE_DIR, `${spec.name}.json`);
    let startBatch = 0;
    if (args.resume && fs.existsSync(stateFile)) {
        const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (st.input_hash === inputHash && st.batch_size === args.batchSize) startBatch = st.next_batch;
        else log({ event: "resume_ignored", reason: "input or batch size changed; restarting from batch 0 (safe: upserts are idempotent)" });
    }
    let written = 0;
    for (let b = startBatch; b * args.batchSize < rows.length; b++) {
        const batch = rows.slice(b * args.batchSize, (b + 1) * args.batchSize);
        await target.upsert(spec.table, batch, spec.key);
        written += batch.length;
        fs.writeFileSync(stateFile, JSON.stringify({ input_hash: inputHash, batch_size: args.batchSize, next_batch: b + 1, rows_total: rows.length }) + "\n");
        log({ event: "batch", batch: b, rows: batch.length });
    }
    log({ event: "done", written });
    return { ...plan, written, started_at_batch: startBatch };
}

export function printPlan(p) {
    console.log(`[${p.script}] ${p.mode} -> ${p.table}${p.proposed_table ? " (PROPOSED table, not in 000_rebuild_schema.sql)" : ""}`);
    console.log(`  read ${p.records_read}, eligible ${p.rows_eligible}, to write ${p.rows_to_write}, invalid ${p.invalid}, batches ${p.batches}`);
    if (Object.keys(p.skipped).length) console.log(`  skipped: ${Object.entries(p.skipped).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (p.invalid) console.log(`  invalid samples: ${JSON.stringify(p.invalid_samples).slice(0, 400)}`);
    console.log(`  ${p.mode === "DRY_RUN" ? "no database was contacted; plan at data/import_plans/" + p.script + ".json" : `written ${p.written}`}`);
}

export async function main(spec) {
    try {
        printPlan(await runImport(spec));
    } catch (e) {
        console.error(`[${spec.name}] ${e.message}`);
        process.exit(1);
    }
}
