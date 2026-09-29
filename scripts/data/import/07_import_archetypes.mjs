#!/usr/bin/env node
// Dry run by default: node scripts/data/import/07_import_archetypes.mjs [--apply --confirm-project=<ref>] [--resume] [--batch-size=N] [--limit=N]
// See scripts/data/import/lib/importer.mjs for the safety rules and lib/specs.mjs for the mapping.
import { main } from "./lib/importer.mjs";
import { SPECS } from "./lib/specs.mjs";

await main(SPECS["07_import_archetypes"]);
