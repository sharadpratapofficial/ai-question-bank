#!/usr/bin/env node
/**
 * Programmatic answers from the canonical dataset (local files only).
 *
 *   node scripts/data/recovery/query.mjs <qbg_id | record_key | question_id> [--json]
 *       where did it come from, what content exists, where was it used, answer/solution,
 *       confidence, conflicts, can it be imported
 *   node scripts/data/recovery/query.mjs --test <text>
 *       which questions were used in tests whose family/name/instance contains <text> (e.g. JRTS)
 *   node scripts/data/recovery/query.mjs --rankup <rankup_question_id>
 *       which PYQs / concepts / archetypes produced it, trap/fusion, QC results
 */
import path from "node:path";
import { CANONICAL_DIR, streamJsonl, readJson } from "./lib/common.mjs";
import { collectLineage, renderLineage } from "./lib/lineage.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");

if (args[0] === "--test") {
    const needle = String(args[1] || "").toLowerCase();
    const tests = new Map();
    for await (const o of streamJsonl(path.join(CANONICAL_DIR, "qbg_test_occurrences.jsonl"))) {
        if (!o.counts_as_usage) continue;
        const hay = `${o.test_family} ${o.test_name} ${o.test_instance_key}`.toLowerCase();
        if (!hay.includes(needle)) continue;
        if (!tests.has(o.test_instance_key)) tests.set(o.test_instance_key, new Set());
        tests.get(o.test_instance_key).add(o.qbg_id);
    }
    const ids = new Set([...tests.values()].flatMap((s) => [...s]));
    if (json) console.log(JSON.stringify({ tests: Object.fromEntries([...tests].map(([k, s]) => [k, [...s]])), unique_qbg_ids: ids.size }, null, 1));
    else {
        console.log(`${tests.size} test instance(s) match "${args[1]}", ${ids.size} unique QBG ids`);
        for (const [k, s] of [...tests].slice(0, 25)) console.log(`  ${k}: ${s.size} ids`);
        if (tests.size > 25) console.log(`  … ${tests.size - 25} more (use --json)`);
    }
} else if (args[0] === "--rankup") {
    const status = readJson(path.join(CANONICAL_DIR, "rankup_status.json"));
    const id = args[1];
    const q = [], prov = [], qc = [];
    for await (const r of streamJsonl(path.join(CANONICAL_DIR, "rankup_questions.jsonl"))) if (!id || r.rankup_question_id === id) q.push(r);
    for await (const r of streamJsonl(path.join(CANONICAL_DIR, "rankup_provenance.jsonl"))) if (!id || r.rankup_question_id === id) prov.push(r);
    for await (const r of streamJsonl(path.join(CANONICAL_DIR, "rankup_qc.jsonl"))) if (!id || r.rankup_question_id === id) qc.push(r);
    if (!q.length) {
        console.log(`RankUp status: ${status.status}. ${status.status === "UNAVAILABLE" ? `No RankUp files in ${status.drop_dir}/ - see docs/data_recovery/RANKUP_INGESTION_SPEC.md.` : `No generated question with id ${id}.`}`);
        process.exit(status.status === "UNAVAILABLE" ? 0 : 1);
    }
    const out = q.map((r) => ({ rankup_question_id: r.rankup_question_id, fusion: r.fusion, trap: r.trap, qbg_file_id: r.qbg_file_id, provenance: prov.filter((p) => p.rankup_question_id === r.rankup_question_id), qc: qc.filter((c) => c.rankup_question_id === r.rankup_question_id) }));
    console.log(JSON.stringify(out, null, 1));
} else if (args[0]) {
    const key = args[0];
    const res = await collectLineage([key, `qbg:${key}`]);
    if (!res.size) { console.error(`No canonical record for ${key}`); process.exit(1); }
    for (const l of res.values()) console.log(json ? JSON.stringify(l, null, 1) : renderLineage(l));
} else {
    console.log("usage: query.mjs <qbg_id|record_key|question_id> [--json] | --test <text> | --rankup [id]");
}
