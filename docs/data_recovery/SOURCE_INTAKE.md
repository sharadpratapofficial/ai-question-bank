# Source intake: supplying recovery sources later

**Current state:**
- `QBG_data.csv` is **not available**, so the historical QBG question bodies (text, options, solutions) remain missing for all 38,033 known QBG ids.
- The original RankUp source files are **not available**.
- The recovery pipeline runs without both. Stage `03b` reports `QBG export status = NOT_PRESENT`, RankUp reports `NOT_PRESENT`, and every QBG record keeps its metadata-only classification.
- **No missing content has been created to fill the gap.**

This page covers every source the pipeline can accept later: where to put it, what it must look like, and what happens to it. None of these files is required today.

After adding any source, run:

```powershell
node scripts/data/recovery/run_all.mjs
node scripts/data/recovery/query.mjs <qbg_id>        # check one record
```

Then read `docs/data_recovery/SOURCE_RECOVERY_GAP_REPORT.md` and `VALIDATION_REPORT.md`. Nothing is imported into any database. The import scripts stay dry-run unless run with `--apply` and an explicit project confirmation, which is not part of this workflow.

Every drop folder below is under `data/`. That folder is git-ignored, so supplied files cannot be committed by accident. Files are read-only inputs: the pipeline never modifies, moves or deletes them.

---

## 1. QBG bulk export (`QBG_data.csv` or equivalent)

| | |
|---|---|
| **Where** | `data/raw/qbg/` (any `*.csv`, `*.json`, `*.jsonl`), **or** the historical location `QBG_data*.csv` in the repository root (already git-ignored), **or** any path via the `QBG_EXPORT_FILE` environment variable |
| **Code** | `scripts/data/recovery/03b_qbg_export.mjs`, `lib/qbg_export.mjs` |
| **Formats** | CSV (RFC 4180, UTF-8, header row; streamed, so a 190 MB file is fine), JSONL (one object per line), JSON (`[...]`, `{"data": [...]}` or `{"questions": [...]}`) |

**Accepted schemas.** Column names are matched case-insensitively. The aliases are those of `python/qbg_pool_import/import_pool.py`, the loader that consumed the historical export.

1. **QBG platform export**, as written by the QBG admin export and read by `import_pool.py`:
   - `unique_id`: **the join key**
   - `question_type` (text) and/or `type` (code: 1 SCQ, 2 MCQ, 3 Numerical, 7 Assertion-Reason, 9 Matching-List, 8 Comprehension)
   - `content`: `{"english": "<html>"}`
   - `bilingual_options`: `{"english": [{"text", "isCorrect"}, ...]}`
   - `solutions`: `[{"english": {"text": ...}}]` and/or `bilingual_solutions`: `{"english": {"text": ...}}`
   - `answer`: `{"english": "<value>"}`, used for numerical types only
   - metadata: `subject`, `chapter`, `topic`, `SubtopicName`, `Class`, `difficulty_level`, `Source`

   The payload shapes are verified from `python/qbg_modification/qbg.py` (`build_payload`) and `_inspect_types.py`.
2. **Backup of the app's own `qbg_questions` table**: `qbg_id` (the join key), `question_text`, `options`, `answer_key`, `solution_text`, `question_type`, …

**Validation (per row, recorded, never silently fixed).**
- **Join key:** the id must be a well-formed 25-character QBG id after trimming. Anything else gets `INVALID_JOIN_ID` and the row is not joined.
- **JSON cells:** a cell that doesn't parse gets `*_INVALID_JSON` and that field stays null.
- **Unverified shapes stay null** with an issue code. Nothing is inferred. Examples:
  - a bare answer scalar instead of `{"english": ...}`
  - options with a missing `isCorrect` flag
  - two correct flags on a single-correct question
  - fewer than four options on an option-type question
  - `solutions` and `bilingual_solutions` that disagree
  - a `question_type` text that contradicts the `type` code
- **Answers** come only from `isCorrect` flags (option types) or `answer.english` (numerical types). Numerical strings such as `"2.50"` are kept exactly.

**Matching.**
- Rows join to known QBG ids on the normalised `unique_id` only.
- A `QBGFileId` column, if present, is carried as an opaque value and is **never** used as a QBG id.
- **Export ids not in either workbook** go to `data/review/qbg_export_unmatched_ids.csv` and are kept out of the canonical set. Adding them is a policy decision.
- **Known ids missing from the export** keep their current classification. `content_source.status = NOT_IN_EXPORT`.

**Provenance.** Every recovered field records its export file, file SHA-256, row number and column in `content_provenance`. The row is also added to `provenance.source_rows`, and a `CONTENT_FROM_QBG_EXPORT` provenance edge is written.

**Conflicts.**
- **Duplicate rows for one `unique_id`:**
  - identical content: used once
  - different content: nothing is used (`AMBIGUOUS_DUPLICATE_ROWS`), plus a HIGH `EXPORT_DUPLICATE_ROWS_DIFFER` conflict
- **Export metadata** (type, subject, chapter, …) is compared with the workbooks like any other source. Disagreements become open conflicts (`QBG_EXPORT_DISAGREES`) and the canonical field stays null.
- **An export answer that contradicts a workbook answer** is a HIGH conflict. The record becomes `F_CONFLICT` and no answer is picked.
- **Row-level problems** are listed in `data/review/qbg_export_row_issues.csv`.

---

## 2. RankUp source files

| | |
|---|---|
| **Where** | `data/raw/rankup/` (top level only; subfolders are not read) |
| **Code** | `scripts/data/recovery/06_rankup.mjs` |
| **Formats** | the PYQ, concept and archetype registers (`*.md` tables), book cards (`*.md`), `rankup_chem_bank.csv` |

The full file list, column matching and rules are in [RANKUP_INGESTION_SPEC.md](RANKUP_INGESTION_SPEC.md). In summary:
- `QBGFileId` is never promoted to `qbg_id`.
- PYQ roles are never invented.
- Generated questions are never written into `qbg_questions`.

**Validation:** stage 08 `rankup` checks. **Status when absent:** `UNAVAILABLE` / `NOT_PRESENT`. The pipeline continues and no RankUp record is created.

---

## 3. Authorized source documents (DOCX / PDF)

| | |
|---|---|
| **Where** | `data/raw/documents/` |
| **Code** | `scripts/data/recovery/05_build.mjs` (`scanLocalDocuments`) |
| **Naming** | either the **exact file name** the workbooks record (e.g. `Test-19_Arjuna JEE AIR Advanced Test (2025)_Questions.pdf`), or the **Drive file id**: `<driveId>.pdf` or `<driveId>__anything.pdf` |

**Matching.** Each file is matched to the document registry (`data/canonical/source_documents.jsonl`, 8,836 referenced documents) by exact file name or Drive id. Nothing fuzzier is attempted. A matched document becomes `LOCAL_NOT_EXTRACTED` with its local path and SHA-256. Unmatched files are listed in `data/review/local_documents.csv`.

**Extraction.** A matched document is **registered, not extracted**. The only extractor today, stage 04, is specific to the AITS Test-03 DOCX layout, and applying it to other papers would be guessing. Records referencing a present document are counted as "potentially recoverable locally" in the gap report and flagged in `missing_content.csv` (`question_document_local`). Extracting a new paper family needs a layout-specific segmenter, written and tested against that paper. Attributing its questions to QBG ids also needs the recorded id→position mapping (1,504 ids have one today).

**Equations.** MathType OLE objects are preserved as placeholders, never guessed. `data/review/docx_equation_placeholders.csv` lists each one with its OLE part, SHA-256 and whether it carries the MTEF (`Equation Native`) stream. All 330 in the AITS Test-03 pair do. Converting them needs MathType's MT6.dll through `python/qbg_modification/mtef.py`.

**Which documents to get first:** see "Most promising future sources" in [SOURCE_RECOVERY_GAP_REPORT.md](SOURCE_RECOVERY_GAP_REPORT.md).

---

## 4. Other historical backups

| Backup | How to supply it |
|---|---|
| Dump of the old `qbg_questions` table (JSON/JSONL/CSV) | as a QBG export (section 1, schema 2): `data/raw/qbg/` |
| Export of `qbg_question_pool` | it has the platform columns: `data/raw/qbg/` (section 1, schema 1) |
| SQL dump (`.sql`) | not parsed. Restore it into a **local, disposable** Postgres and export the table to CSV/JSON first. Never restore into a shared or remote database |
| Anything else | place it under `data/raw/other/`. It is inventoried by stage 01 (path, size, SHA-256) but not interpreted until a parser is written for it |

The same rules apply to every source:
- ids join only within their own identifier system
- raw values are kept next to normalised ones
- disagreements become open conflicts
- a field that cannot be proven from the source stays null

---

## 5. After a new source is added: checklist

1. `node scripts/data/recovery/run_all.mjs`. Stage 03b and the coverage stage print the new status.
2. `VALIDATION_REPORT.md` must show **0 errors**. The determinism warning is expected on the first run after new input.
3. Review, in order:
   - `data/review/qbg_export_row_issues.csv`
   - `qbg_export_unmatched_ids.csv`
   - `answer_conflicts.csv`
   - `metadata_conflicts.csv` (`category` = `QBG_EXPORT_DISAGREES`)
   - `local_documents.csv`
4. `SOURCE_RECOVERY_GAP_REPORT.md` shows the new coverage.
5. `node scripts/data/import/10_validate_import.mjs` (dry run) shows what would be imported. Only records with recovered content can be `READY` / `READY_WITH_REVIEW`.
