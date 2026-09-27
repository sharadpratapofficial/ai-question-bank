# Checkpoint 01–02: inventory and profiling

**Status:** complete. Re-run with `node scripts/data/recovery/01_inventory.mjs` and `node scripts/data/recovery/02_profile.mjs`.

## What was completed

- The inventory covers the repository folder only (per user instruction): 304 files, each with SHA-256 → `docs/data_recovery/file_inventory.{json,md}`.
- Column-level profiles → `docs/data_recovery/source_profiles/{autocuration,important_ids,tagging_csv}.{json,md}`.

## Key counts (non-empty data rows)

| Source | Sheet | Rows |
|---|---|---|
| AutoCuration_Lovee (1).xlsx | data | 34,168 (qbg_id present in 16,783; 16,736 unique) |
| | tagging | 4,474 taxonomy rows |
| Important IDs REplica (1).xlsx | AITS / Copy of AITS | 8,442 each |
| | PYQs | 9,705 (Main table) + 522 (Advanced table, cols K–Q) |
| | JRTS / RTS | 568 / 1,692 |
| | Onepass Test Series | 2,420 (tabular A–F, then 5-column side-by-side blocks) |
| | Full length JEE Main+Advanced | 94 (6-column side-by-side blocks) |
| | RTS Hindi | 17 (translation tracker; no QBG ids) |
| qbg_tagging_table.csv | — | 39,616 taxonomy rows |

## Findings that shape later phases

1. `link` holds a QBG admin URL `…/question-details?question=<id>` for 14,186 rows. The embedded id matches the row's `qbg_id` in every case (0 mismatches).
2. 17,385 AutoCuration rows have **no qbg_id**. Their sources are Brahmastra, Main Booklet, JEE Advanced, Real Test and AITS-NoVideo. Each has a Drive document link, a `Row_Number` and taxonomy codes, so these are document question positions that were never ingested into QBG.
3. Column misuse:
   - `class` holds solution-PDF names or Drive URLs for some batches.
   - `topic`/`topic_code` are swapped in 1,820 rows, and `subtopic`/`subtopic_code` in 190.
   - AutoCuration has two headers named `QuestionFileLink` (columns W and X).
4. Hyperlinks carry data. The `QuestionFileLink`/`SolutionFileLInk` file-name cells link to Drive file ids, and PYQ id cells link to QBG admin pages. The reader captures `cell.l.Target`.
5. The `Option Text` column only contains the labels `A~B~C~D` (440 rows) or UI placeholder text (5 rows). It contains no option content.
6. `Answer*` is present in only 724 rows, all of which have a qbg_id.
7. AITS unnamed columns M–W hold, in order: an unlabeled integer (M, 1–10), then subject id/name, chapter id/name, topic id/name, subtopic id/name, and difficulty code/name. This gives a second taxonomy source to cross-check.
8. The docx sources store equations as OLE MathType objects (95 in the question paper, 238 in the solutions), with no OMML.
9. RankUp files are all **MISSING** (see the inventory).

## Next

Normalisers (checkpoint 03).
