#!/usr/bin/env node
/**
 * Validate every import plan (dry run; no database):
 *   node scripts/data/import/10_validate_import.mjs
 * With --apply --confirm-project=<ref> it additionally compares expected row counts
 * with the target tables (read-only count queries).
 */
import { runImport, parseArgs } from "./lib/importer.mjs";
import { SPECS } from "./lib/specs.mjs";

const args = parseArgs(process.argv.slice(2));
let failed = 0;
for (const spec of Object.values(SPECS)) {
    const plan = await runImport(spec, ["--dry-run", ...[...args.flags].map((f) => `--${f}`)]);
    const problems = [];
    if (plan.invalid) problems.push(`${plan.invalid} invalid rows`);
    if (plan.duplicate_keys) problems.push(`${plan.duplicate_keys} duplicate keys`);
    if (problems.length) failed++;
    console.log(`${problems.length ? "FAIL" : "PASS"} ${spec.name}: ${plan.rows_to_write} rows -> ${spec.table}${spec.proposedTable ? " (proposed)" : ""}${problems.length ? " | " + problems.join(", ") : ""}${Object.keys(plan.skipped).length ? ` | skipped ${JSON.stringify(plan.skipped)}` : ""}`);
}
if (args.apply) {
    const ref = (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\./)?.[1];
    if (!args.confirmProject || ref !== args.confirmProject) { console.error("count reconciliation needs --confirm-project matching SUPABASE_URL"); process.exit(1); }
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    for (const spec of Object.values(SPECS)) {
        const { count, error } = await db.from(spec.table).select("*", { head: true, count: "exact" });
        console.log(`${spec.table}: ${error ? "unavailable (" + error.message + ")" : count + " rows"}`);
    }
}
process.exit(failed ? 1 : 0);
