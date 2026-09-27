# QBG + RankUp data recovery

This is a local, read-only, reproducible pipeline. It turns the handed-over workbooks and documents into an auditable canonical dataset. No database, network or remote API is used.

## Run

```powershell
npm install                                    # existing deps only (xlsx, jszip)
node scripts/data/recovery/run_all.mjs         # ~50 s: inventory -> profile -> stage -> docx -> build -> rankup -> identifiers -> validate -> lineage
node --test "scripts/data/recovery/tests/*.test.mjs"   # 30 unit tests
node scripts/data/import/10_validate_import.mjs        # dry-run every import plan (no DB)
```

Inputs are read in place and never modified:
- `AutoCuration_Lovee (1).xlsx`
- `Important IDs REplica (1).xlsx`
- `python/qbg_modification/tagging_data/qbg_tagging_table.csv`
- `AITS_Test-03_*.docx`
- optionally `data/raw/rankup/*`

## Ask questions

```powershell
node scripts/data/recovery/query.mjs qheknip5dh112gdhm6zewqm8j   # full lineage of a QBG id (also record_key or question_id)
node scripts/data/recovery/query.mjs --test JRTS                 # which questions were used in JRTS tests
node scripts/data/recovery/query.mjs --rankup [id]               # RankUp provenance / QC (UNAVAILABLE today)
```

## Documents

| Document | Purpose |
|---|---|
| [FINAL_RECOVERY_REPORT.md](FINAL_RECOVERY_REPORT.md) | the final report (start here) |
| [DATA_RECOVERY_REPORT.md](DATA_RECOVERY_REPORT.md) | questions A–K: what exists, what is missing, what can be imported |
| [CANONICAL_DATA_MODEL.md](CANONICAL_DATA_MODEL.md) | entities, record shapes, recovery classes |
| [SCHEMA_GAP_ANALYSIS.md](SCHEMA_GAP_ANALYSIS.md) | canonical model vs `000_rebuild_schema.sql`, proposed (unapplied) tables |
| [DATA_DICTIONARY.md](DATA_DICTIONARY.md) | every field: source, meaning, type, normalisation, verified/inferred |
| [INFERENCE_LOG.md](INFERENCE_LOG.md) | every inference with its confidence and reversibility |
| [IDENTIFIER_FORENSICS.md](IDENTIFIER_FORENSICS.md) | all identifier systems and how they relate |
| [qbg_overlap_summary.md](qbg_overlap_summary.md) | AutoCuration vs Important IDs cross-match |
| [RANKUP_INGESTION_SPEC.md](RANKUP_INGESTION_SPEC.md) | how to supply the missing RankUp files |
| [VALIDATION_REPORT.md](VALIDATION_REPORT.md) | automated checks (regenerated each run) |
| [LINEAGE_SAMPLE.md](LINEAGE_SAMPLE.md) | 100 stratified human-readable lineages |
| [file_inventory.md](file_inventory.md) / [source_profiles/](source_profiles/) | inventory + column profiles |
| [checkpoints/](checkpoints/) | phase checkpoints for safe resumption |

## Code

| Path | Stage |
|---|---|
| `scripts/data/recovery/lib/{common,ids,normalize,canonical,lineage}.mjs` | IO, id classification, normalisers, classification/conflict logic, lineage |
| `01_inventory` … `09_lineage`, `run_all`, `query` | pipeline stages |
| `scripts/data/import/01…10` + `lib/{importer,specs}.mjs` | dry-run-first, idempotent, resumable, batched importers |

## Outputs (`data/`, git-ignored, regenerable)

- `staging/`: row-level normalised sources
- `extracted/`: docx questions + media
- `canonical/`: import-ready datasets
- `reports/`: statistics, validation, fingerprints
- `review/`: human-review queues
- `import_plans/`, `import_logs/`, `import_state/`: importer work files
