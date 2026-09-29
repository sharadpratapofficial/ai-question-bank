#!/usr/bin/env node
/**
 * Runs the whole local recovery pipeline in order. No network, no database.
 *
 *   node scripts/data/recovery/run_all.mjs
 *
 * Requires the source workbooks in the repository root (see sources.mjs) and
 * `npm install` (uses the existing xlsx / jszip dependencies only).
 *
 * Optional sources (the pipeline runs without them; see docs/data_recovery/SOURCE_INTAKE.md):
 *   QBG export     QBG_data*.csv (repo root), data/raw/qbg/*.{csv,json,jsonl}, or $QBG_EXPORT_FILE
 *   documents      data/raw/documents/*  (matched to referenced documents by name / Drive id)
 *   RankUp         data/raw/rankup/*
 */
import { runInventory } from "./01_inventory.mjs";
import { runProfile } from "./02_profile.mjs";
import { runStage } from "./03_stage.mjs";
import { runQbgExport } from "./03b_qbg_export.mjs";
import { runDocxExtract } from "./04_docx_extract.mjs";
import { runBuild } from "./05_build.mjs";
import { runRankup } from "./06_rankup.mjs";
import { runIdentifiers } from "./07_identifiers.mjs";
import { runValidate } from "./08_validate.mjs";
import { runLineage } from "./09_lineage.mjs";
import { runCoverage } from "./10_coverage.mjs";

const steps = [
    ["01 inventory", runInventory],
    ["02 profile", runProfile],
    ["03 stage", runStage],
    ["03b qbg export", runQbgExport],
    ["04 docx extract", runDocxExtract],
    ["05 build", runBuild],
    ["06 rankup", runRankup],
    ["07 identifiers", runIdentifiers],
    ["08 validate", runValidate],
    ["09 lineage", runLineage],
    ["10 coverage", runCoverage],
];
let exit = 0;
for (const [name, fn] of steps) {
    const t = Date.now();
    const r = await fn();
    const note = name === "08 validate" ? ` - ${r.passed}/${r.total} checks passed, ${r.errors} errors, ${r.warnings} warnings`
        : name === "03b qbg export" ? ` - QBG export status = ${r.status}${r.files.length ? ` (${r.rows_total} rows)` : ""}`
        : name === "06 rankup" ? ` - RankUp status = ${r.presence}`
        : name === "10 coverage" ? ` - ${r.with_question_text}/${r.known_qbg_ids} QBG ids with question text; ${r.requires_external_source} need an external source`
        : "";
    if (name === "08 validate" && r.errors) exit = 1;
    console.log(`[${name}] done in ${((Date.now() - t) / 1000).toFixed(1)}s${note}`);
}
process.exit(exit);
