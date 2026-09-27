#!/usr/bin/env node
/**
 * Runs the whole local recovery pipeline in order. No network, no database.
 *
 *   node scripts/data/recovery/run_all.mjs
 *
 * Requires the source workbooks in the repository root (see sources.mjs) and
 * `npm install` (uses the existing xlsx / jszip dependencies only).
 */
import { runInventory } from "./01_inventory.mjs";
import { runProfile } from "./02_profile.mjs";
import { runStage } from "./03_stage.mjs";
import { runDocxExtract } from "./04_docx_extract.mjs";
import { runBuild } from "./05_build.mjs";
import { runRankup } from "./06_rankup.mjs";
import { runIdentifiers } from "./07_identifiers.mjs";
import { runValidate } from "./08_validate.mjs";
import { runLineage } from "./09_lineage.mjs";

const steps = [
    ["01 inventory", runInventory],
    ["02 profile", runProfile],
    ["03 stage", runStage],
    ["04 docx extract", runDocxExtract],
    ["05 build", runBuild],
    ["06 rankup", runRankup],
    ["07 identifiers", runIdentifiers],
    ["08 validate", runValidate],
    ["09 lineage", runLineage],
];
let exit = 0;
for (const [name, fn] of steps) {
    const t = Date.now();
    const r = await fn();
    const note = name === "08 validate" ? ` - ${r.passed}/${r.total} checks passed, ${r.errors} errors, ${r.warnings} warnings` : "";
    if (name === "08 validate" && r.errors) exit = 1;
    console.log(`[${name}] done in ${((Date.now() - t) / 1000).toFixed(1)}s${note}`);
}
process.exit(exit);
