# QBG + RankUp data recovery

This is a local, read-only, reproducible pipeline. It turns the handed-over workbooks and documents into an auditable canonical dataset. No database, network or remote API is used.

## Current status

- **`QBG_data.csv` is not available.** The historical QBG question bodies (text, options, solutions) remain missing for all 38,033 known QBG ids.
- **The pipeline runs without it.** QBG export support is built and tested, but optional. Today stage 03b reports `QBG export status = NOT_PRESENT` and every QBG record keeps its metadata-only classification.
- **RankUp sources are not available** (`NOT_PRESENT`). This is optional too.
- **No missing content has been fabricated.** The only question bodies in the dataset are the 75 extracted from the local AITS Test-03 DOCX pair. None of them is linked to a QBG id.
- **What can still be done without the export:**
  - metadata QC, including conflict categorisation and duplicate analysis
  - lineage and coverage reporting
  - dry-run import plans
- **What stays blocked until an external source arrives:**
  - question bodies, options and solutions for QBG ids
  - resolving most answer and parent–child questions
  - any import of QBG question content

Where coverage stands, and which sources would help most: [SOURCE_RECOVERY_GAP_REPORT.md](SOURCE_RECOVERY_GAP_REPORT.md). How to supply a source later: [SOURCE_INTAKE.md](SOURCE_INTAKE.md).

## Run

```powershell
npm install                                    # existing deps only (xlsx, jszip)
node scripts/data/recovery/run_all.mjs         # ~50 s: inventory -> profile -> stage -> qbg export (optional) -> docx -> build -> rankup -> identifiers -> validate -> lineage -> coverage
node --test scripts/data/recovery/tests/normalize.test.mjs scripts/data/recovery/tests/pipeline.test.mjs scripts/data/recovery/tests/import.test.mjs scripts/data/recovery/tests/qbg_export.test.mjs scripts/data/recovery/tests/qc.test.mjs   # 47 unit tests (list the files: a directory/glob argument fails on Windows)
node scripts/data/import/10_validate_import.mjs        # dry-run every import plan (no DB)
```

Inputs are read in place and never modified:
- `AutoCuration_Lovee (1).xlsx`
- `Important IDs REplica (1).xlsx`
- `python/qbg_modification/tagging_data/qbg_tagging_table.csv`
- `AITS_Test-03_*.docx`
- optionally (none present today): a QBG export (`QBG_data*.csv` in the root or `data/raw/qbg/*`), `data/raw/documents/*`, `data/raw/rankup/*`. See [SOURCE_INTAKE.md](SOURCE_INTAKE.md)

## Ask questions

```powershell
node scripts/data/recovery/query.mjs qheknip5dh112gdhm6zewqm8j   # full lineage of a QBG id (also record_key or question_id): status matrix,
                                                                 # per-field provenance, conflicts (categorised), duplicates, what is still missing
node scripts/data/recovery/query.mjs --test JRTS                 # which questions were used in JRTS tests
node scripts/data/recovery/query.mjs --rankup [id]               # RankUp provenance / QC (UNAVAILABLE today)
```

## Documents

| Document | Purpose |
|---|---|
| [FINAL_RECOVERY_REPORT.md](FINAL_RECOVERY_REPORT.md) | the final report (start here) |
| [SOURCE_RECOVERY_GAP_REPORT.md](SOURCE_RECOVERY_GAP_REPORT.md) | coverage of the 38,033 QBG ids and the most promising future sources (regenerated each run) |
| [SOURCE_INTAKE.md](SOURCE_INTAKE.md) | where to place a QBG export, RankUp files, documents or backups; formats, validation, matching, provenance, conflicts |
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
| `scripts/data/recovery/lib/qbg_export.mjs` | optional QBG export: streaming CSV/JSON(L) reader, header aliases, row normalisation, unique_id matching |
| `scripts/data/recovery/lib/qc.mjs` | conflict analysis, duplicate categories, parent-child evidence, per-id coverage (pure) |
| `01_inventory` … `10_coverage` (incl. `03b_qbg_export`), `run_all`, `query` | pipeline stages |
| `scripts/data/import/01…10` + `lib/{importer,specs}.mjs` | dry-run-first, idempotent, resumable, batched importers |

## Outputs (`data/`, git-ignored, regenerable)

- `staging/`: row-level normalised sources
- `extracted/`: docx questions + media
- `canonical/`: import-ready datasets
- `reports/`: statistics, validation, fingerprints
- `review/`: human-review queues. New or reworked in this revision:
  - `parent_child_relationships.csv` (replaces `parent_child_conflicts.csv`)
  - `same_position_anomalies.csv`
  - `docx_equation_placeholders.csv`
  - `local_documents.csv`
  - `qbg_export_unmatched_ids.csv` and `qbg_export_row_issues.csv` (header-only while no export exists)
  - `category` / `why_open` columns on the conflict queues, `category` on duplicates, names and a category on taxonomy path issues
- `reports/qbg_id_coverage.csv`: one row per QBG id with availability flags and what is missing
- `import_plans/`, `import_logs/`, `import_state/`: importer work files
