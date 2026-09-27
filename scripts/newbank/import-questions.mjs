#!/usr/bin/env node
/**
 * NEW question-bank importer -> public.qbg_questions.
 * Input format: docs/NEW_QUESTION_BANK_FORMAT.md (canonical .jsonl or .json).
 *
 *   node scripts/newbank/import-questions.mjs --input=<file>              offline dry run (default)
 *        [--limit=N] [--only=KEY1,KEY2]                                   trial selection (whole passage groups)
 *        [--check-db --confirm-project=<ref>]                            dry run + read-only DB lookups
 *        [--apply --confirm-project=<ref> (--limit=N | --only=... | --all)]
 *        [--update-existing] [--as-user=<auth user uuid>] [--batch-size=100]
 *
 * SAFETY
 *   - Dry run by default. Without --check-db/--apply the database is never contacted.
 *   - --apply needs --confirm-project equal to BOTH the project ref in SUPABASE_URL and the
 *     new-bank project ref below, plus an explicit scope (--limit, --only or --all).
 *   - Existing rows are never overwritten by default (see lib/plan.mjs classify()).
 *   - Credentials come only from the environment: run with
 *       node --env-file=.env.local scripts/newbank/import-questions.mjs ...
 *     (SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL; SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY).
 *
 * OUTPUT (data/ is git-ignored): data/newbank/runs/<timestamp>_<mode>/
 *   plan.json      counts, selection, every decision        rejected.json  every rejected record + reasons
 *   preview.md     full content of the selected questions   result.json    apply counts + read-back check
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseInput, buildPlan, selectUnits, classify, applyDecisions } from "./lib/plan.mjs";
import { supabaseTarget, projectRefFromUrl } from "./lib/target.mjs";

const NEWBANK_PROJECT_REF = "ljkpcqllqdamdatesbfe";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_CAP = 50;

function parseArgs(argv) {
    const a = { input: null, apply: false, dryRun: false, checkDb: false, all: false, updateExisting: false, limit: null, only: null, confirmProject: null, asUser: null, batchSize: 100 };
    for (const x of argv) {
        const [k, v] = x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x, null];
        if (k === "--input") a.input = v;
        else if (k === "--apply") a.apply = true;
        else if (k === "--dry-run") a.dryRun = true;
        else if (k === "--check-db") a.checkDb = true;
        else if (k === "--all") a.all = true;
        else if (k === "--update-existing") a.updateExisting = true;
        else if (k === "--limit") { a.limit = Number(v); if (!Number.isInteger(a.limit) || a.limit < 1) throw new Error("--limit must be a positive integer"); }
        else if (k === "--only") a.only = (v || "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (k === "--confirm-project") a.confirmProject = v;
        else if (k === "--as-user") a.asUser = v;
        else if (k === "--batch-size") a.batchSize = Math.max(1, Number(v) || 100);
        else if (!k.startsWith("--") && !a.input) a.input = x;
        else throw new Error(`unknown argument ${x}`);
    }
    if (!a.input) throw new Error("--input=<file.jsonl|file.json> is required");
    if (a.dryRun) a.apply = false; // --dry-run always wins, whatever the flag order
    if (a.asUser && !UUID_RE.test(a.asUser)) throw new Error("--as-user must be an auth user uuid");
    if (a.apply && !a.limit && !a.only?.length && !a.all) throw new Error("--apply needs an explicit scope: --limit=N, --only=KEYS or --all");
    return a;
}

function connectConfig(args) {
    if (!args.confirmProject) throw new Error("database access needs --confirm-project=<project-ref>");
    if (args.confirmProject !== NEWBANK_PROJECT_REF) throw new Error(`--confirm-project=${args.confirmProject} is not the new question-bank project (${NEWBANK_PROJECT_REF})`);
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set; run with node --env-file=.env.local");
    const ref = projectRefFromUrl(url);
    if (ref !== args.confirmProject) throw new Error(`--confirm-project=${args.confirmProject} does not match the project in SUPABASE_URL (${ref ?? "unrecognised URL"})`);
    return { url, key };
}

function previewMarkdown(units, decisions) {
    const lines = ["# Import preview", "", `${units.flat().length} question row(s) in ${units.length} unit(s).`, ""];
    for (const u of units.slice(0, PREVIEW_CAP)) {
        for (const v of u) {
            const r = v.row, m = r.raw_data[0]._newbank, d = decisions?.get(r.question_id);
            lines.push(`## ${m.source_key}${m.parent_source_key ? `  (child ${m.child_order} of ${m.parent_source_key})` : ""}`, "");
            lines.push(`- question_id: \`${r.question_id}\`  qbg_id: \`${r.qbg_id}\`${d ? `  -> **${d.action}**${d.reason ? ` (${d.reason})` : ""}` : ""}`);
            lines.push(`- ${r.question_type} | ${r.subject} > ${r.chapter} > ${r.topic ?? "-"} > ${r.subtopic ?? "-"}`);
            lines.push(`- difficulty ${r.difficutly_level ?? "-"} | class ${r.class_level ?? "-"} | exam ${r.exam?.join(", ") ?? "-"} | source ${r.source} | status ${r.status}`);
            lines.push("", "**Question**", "", "```html", r.question_text, "```");
            r.options.forEach((o, i) => lines.push(`- ${String.fromCharCode(65 + i)}${o.isCorrect ? " ✔" : ""}: \`${o.text.replace(/`/g, "'")}\``));
            if (r.answer_key !== null) lines.push("", `**answer_key**: \`${JSON.stringify(r.answer_key)}\` (as given: \`${JSON.stringify(m.answer_as_given)}\`)`);
            lines.push("", "**Solution**", "", r.solution_text ? ["```html", r.solution_text, "```"].join("\n") : "_none_", "");
        }
    }
    if (units.length > PREVIEW_CAP) lines.push(`… ${units.length - PREVIEW_CAP} more unit(s) not shown; see plan.json.`);
    return lines.join("\n") + "\n";
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const inputPath = path.resolve(args.input);
    const buf = fs.readFileSync(inputPath);
    const sourceSha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const sourceFile = path.basename(inputPath);

    const plan = buildPlan(parseInput(buf.toString("utf8"), inputPath), { sourceFile, sourceSha256 });
    const units = selectUnits(plan.units, { only: args.only, limit: args.limit });
    const mode = args.apply ? "apply" : args.checkDb ? "check-db" : "dry-run";

    let decisions = null, target = null;
    if (args.apply || args.checkDb) {
        target = await supabaseTarget(connectConfig(args));
        if (args.asUser && !(await target.userExists(args.asUser))) throw new Error(`--as-user ${args.asUser} has no user_profiles row`);
        decisions = await classify(units, target, { updateExisting: args.updateExisting });
    }

    const runsRoot = process.env.NEWBANK_RUNS_DIR || path.join(REPO_ROOT, "data", "newbank", "runs");
    const runDir = path.join(runsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}_${mode}`);
    fs.mkdirSync(runDir, { recursive: true });
    const tally = (pred) => { const t = {}; for (const d of decisions?.values() ?? []) if (pred(d)) { const k = d.reason ? `${d.action}: ${d.reason}` : d.action; t[k] = (t[k] || 0) + 1; } return t; };
    const planOut = {
        mode, input_file: sourceFile, input_sha256: sourceSha256, project: args.checkDb || args.apply ? args.confirmProject : null,
        ...plan.stats,
        selection: { limit: args.limit, only: args.only, units: units.length, rows: units.flat().length },
        decisions: decisions ? tally(() => true) : "database not checked (offline dry run)",
        possible_content_duplicates: plan.possibleDuplicates,
        warnings: plan.warnings,
        selected: units.flat().map((v) => ({ source_key: v.meta.source_key, question_id: v.row.question_id, question_type: v.row.question_type, decision: decisions?.get(v.row.question_id)?.action ?? null, reason: decisions?.get(v.row.question_id)?.reason ?? null })),
    };
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(planOut, null, 2) + "\n");
    fs.writeFileSync(path.join(runDir, "rejected.json"), JSON.stringify(plan.rejected, null, 2) + "\n");
    fs.writeFileSync(path.join(runDir, "preview.md"), previewMarkdown(units, decisions));

    const rel = path.relative(REPO_ROOT, runDir).replace(/\\/g, "/");
    console.log(`[newbank] ${mode.toUpperCase()}  input ${sourceFile} (sha256 ${sourceSha256.slice(0, 12)}…)`);
    console.log(`  records ${plan.stats.records_read} | valid ${plan.stats.valid} | rejected ${plan.stats.rejected} | units ${plan.stats.units}`);
    console.log(`  selected ${units.length} unit(s) = ${units.flat().length} row(s)${args.limit ? ` (--limit=${args.limit})` : ""}${args.only ? ` (--only ${args.only.length} key(s))` : ""}`);
    if (plan.possibleDuplicates.length) console.log(`  possible content duplicates: ${plan.possibleDuplicates.length} group(s) (reported, not rejected)`);
    if (decisions) for (const [k, n] of Object.entries(planOut.decisions)) console.log(`  ${k}: ${n}`);
    else console.log("  database not contacted");

    if (args.apply) {
        const log = (ev) => fs.appendFileSync(path.join(runDir, "apply.log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
        const result = await applyDecisions(decisions, target, { asUser: args.asUser, batchSize: args.batchSize, log });
        const counts = { inserted: result.inserted, updated: result.updated, skipped: tally((d) => d.action === "skip"), rejected_in_file: plan.stats.rejected, rejected_against_db: [...decisions.values()].filter((d) => d.action === "reject").length, failed: result.failed.length };
        fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ counts, failed: result.failed, read_back: result.read_back }, null, 2) + "\n");
        console.log(`  inserted ${counts.inserted} | updated ${counts.updated} | failed ${counts.failed} | read-back ok ${result.read_back.ok}/${result.read_back.checked}`);
        if (result.failed.length || result.read_back.mismatches.length) { console.log(`  PROBLEMS - see ${rel}/result.json`); process.exitCode = 2; }
    }
    console.log(`  report: ${rel}/`);
}

main().catch((e) => { console.error(`[newbank] ${e.message}`); process.exit(1); });
