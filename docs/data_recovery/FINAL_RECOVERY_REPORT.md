# Final recovery report: QBG + RankUp question-bank data

Date 2026-09-27 · branch `fix/supabase-auth` · **no commit, no push**.
Scope: the repository folder only (per user instruction). **No remote service was contacted**: not QBG, not Google Drive, not Supabase (old or new).
Reproduce everything with `node scripts/data/recovery/run_all.mjs`. Detailed answers to questions A–K are in [DATA_RECOVERY_REPORT.md](DATA_RECOVERY_REPORT.md).

## Revision 2 (after commit f577b75): work possible without the QBG export

**`QBG_data.csv` is still not available, and neither are the RankUp files. Historical QBG question bodies remain missing. No missing content has been fabricated.** Sections 1–20 below describe the first pass. Where a figure changed, the change is noted here.

- **Optional QBG export support.** Stage `03b_qbg_export.mjs` and `lib/qbg_export.mjs`:
  - input: CSV (streamed), JSON or JSONL, joined on the normalised `unique_id`; `QBGFileId` is never used as an id
  - rules taken from `import_pool.py` and `qbg.py`, not assumed
  - differing duplicate rows yield no value
  - unmatched ids go to a review queue
  - status today: **`QBG export status = NOT_PRESENT`**; every QBG classification is unchanged
  - tested with synthetic fixtures; an end-to-end smoke run with synthetic rows was checked and then removed
- **Metadata QC.** Every conflict now carries an `analysis`: a category, why it is open, and any independent evidence. Nothing was auto-resolved. The 1,480 conflicts break down as:
  - 630 same column on different rows (e.g. one question used in a class-11 and a class-12 Onepass test)
  - 259 AutoCuration current vs original type
  - 181 numeric-type granularity (Integer / Numerical)
  - 155 cross-source
  - 117 option-vs-value type (the HIGH ones)
  - 63 same test position with different ids
  - 41 name variants
  - 18 duplicate workbook rows disagreeing
  - 15 label vs taxonomy id in the same row
  - 1 answer

  The tagging table's chapter → class mapping was checked as evidence for the class conflicts. It applies to 0 of them, because those records have no chapter id. Taxonomy path issues now carry names and a category. The CSV also no longer drops `chapter_id` on half the rows (a pre-existing column bug).
- **Duplicates** are categorised:
  - 47 same id on several workbook rows (the same question curated twice)
  - 140 passage-parent reuse, INFERRED from consecutive positions only
  - 1 unexplained repeat

  The 63 same-position anomalies are in `data/review/same_position_anomalies.csv`. `parent_child_relationships.csv` (replacing `parent_child_conflicts.csv`) lists 143 relationships, all INFERRED, with 1 ANOMALY (a question listed as its own parent). `parent_question_id` stays null (validated).
- **DOCX.** Q59's options (1) and (2) sat inside the stem paragraph. They are now split by an exact-layout rule, and Q59 has 4/4 options (options recovered: 59 → 60). All 330 MathType equations and 3 unmapped symbols are listed in `data/review/docx_equation_placeholders.csv`, with OLE part, SHA-256 and MTEF-stream check (330/330 carry MTEF, so MT6.dll alone would convert them). Still nothing is guessed.
- **Lineage.** `query.mjs <qbg_id>` prints:
  - a status matrix: question / options / answer / solution / metadata / documents / test usage / conflicts / duplicate status / content source, each with its source file and row or paragraph
  - a "Still missing" line
  - "[PARTIAL]" where equations are unconverted
- **Coverage and gaps.** Stage `10_coverage.mjs` writes `data/reports/qbg_id_coverage.csv` and [SOURCE_RECOVERY_GAP_REPORT.md](SOURCE_RECOVERY_GAP_REPORT.md). Of the 38,033 ids: 0 have question text, 678 an answer, 2,296 a document reference, 23,024 test usage; **38,033 need an external source**.
- **Intake.** [SOURCE_INTAKE.md](SOURCE_INTAKE.md) documents the drop folders `data/raw/{qbg,documents,rankup,other}/`. Documents are matched to the registry by exact file name or Drive id and registered, not extracted. Stage 01 now inventories `data/raw/` and streams large CSVs.
- **Validation** has 9 new checks (e.g. QBG content only from a matched export row, field-level provenance for every present field, `parent_question_id` null, metadata-only never import-ready). Current result: **41/43, 0 errors**, the same 2 data warnings. Tests: **47/47**.

## Success criterion

**"Given a QBG ID, where did it come from, what content can we recover, where was it used, what is its answer/solution, how confident are we, and can we safely import it?"**

Answered by `node scripts/data/recovery/query.mjs <qbg_id>`, in about 3 s, fully local. [LINEAGE_SAMPLE.md](LINEAGE_SAMPLE.md) shows 100 examples.

**"Which PYQs, concepts and archetypes produced a RankUp question, what trap/fusion, which QC checks passed?"**

`query.mjs --rankup <id>` and the model exist and are tested. They return **UNAVAILABLE** because the RankUp files are not in the repository.

## 1. Files discovered

| File | Category | Content (verified) |
|---|---|---|
| `AutoCuration_Lovee (1).xlsx` | QBG_METADATA | `data` 34,168 × 35 plus 9 other sheets (tagging, class map, curated-test output, config) |
| `Important IDs REplica (1).xlsx` | QBG_TEST_MAPPING | 9 sheets; 33,882 QBG-id cells |
| `python/qbg_modification/tagging_data/qbg_tagging_table.csv` | QBG_TAGGING | 39,616 taxonomy rows |
| `AITS_Test-03_12th_JEE_15-12-2024_Question.docx` / `_Solutions.docx` | SOURCE_DOCUMENT | 75-question 12th JEE Main paper; 95 / 238 MathType OLE objects |
| `qbg modifier sample file.docx`, `Batch_Test-word (2).docx` | SOURCE_DOCUMENT (app fixtures) | no QBG linkage |
| `scripts/sql/*.sql`, `docs/SCHEMA_REBUILD_AUDIT.md` | SCHEMA | reconstructed schema baseline |
| app code (`src/`, `python/`) | APPLICATION_CODE | 304 files inventoried with SHA-256 → `file_inventory.json` |

## 2. Files missing

`rankup_chem_bank.csv`, `PYQ_Register_SBC_ATM_PER_RDX.md`, `EC_PYQ_Register.md`, `Textbook_Concept_Register.md`, `Problem_Archetype_Register.md`, `Reference_Library_Book_Cards.md`, `Book_Concept_Guide.md`, `Chemistry_Source_Library.md`, `Extensive_Source_Compilation.md`.

The jee-chemistry-engine skill states that the RankUp registers "stay in that project" (a claude.ai project), not on disk. Also absent is the historical `QBG_data.csv` export that held question bodies.

## 3. Workbook statistics

| Sheet | Rows | QBG ids | Notes |
|---|---|---|---|
| AutoCuration `data` | 34,168 | 16,736 unique (16,783 rows) | 17,385 rows have no id; 14,186 QBG-page links, all matching; 724 rows with answer / source-question number; 1,820 + 190 rows with swapped topic/subtopic columns |
| II `AITS` | 8,442 | 7,686 | 43 positions with `Paper-02` instead of an id, 1 `QUE ERROR`; unlabeled cols N–W hold taxonomy + difficulty |
| II `Copy of AITS` | 8,442 | mirror | not counted |
| II `PYQs` | 9,705 + 522 | 10,189 | JEE Main (2021–25) + JEE Advanced tables; 2,578 hyperlinks all agree |
| II `RTS` / `JRTS` | 1,692 / 567 | 1,691 / 561 | no test number; tests inferred from numbering resets |
| II `Onepass Test Series` | 2,130 tabular + 1,480 block | 2,414 | |
| II `Full length JEE Main+Advanced` | 558 block | 558 | "Link" cells have no targets |
| II `RTS Hindi`, `Sheet8` | 17 / 2 | 0 | translation tracker / links |

Full column profiles are in `source_profiles/`.

## 4. Total QBG IDs

**38,033 unique QBG ids** (question `unique_id`s). There are 0 collisions with the 22,335 taxonomy ids, and 0 ids were altered by normalisation. The canonical dataset adds 17,385 id-less booklet rows and 75 docx questions, for 55,493 records in total.

## 5. Cross-match statistics

| | Value |
|---|---|
| AutoCuration ids / Important IDs ids / union | 16,736 / 23,024 / 38,033 |
| Intersection | 1,727 (7.5 % of II; 10.3 % of AC), of which 1,603 are AITS |
| AC-only / II-only | 15,009 / 21,297 |
| Ids in more than one test instance / test family | 1,553 / 74 |

The two workbooks are **complementary indexes of mostly different questions**, not two copies of one bank. See [qbg_overlap_summary.md](qbg_overlap_summary.md).

## 6. Recovered full questions

- **QBG ids: 0.**
- **21 `A_FULL`** docx questions (external origin, not QBG-linked).

## 7. Partial questions

| Group | Count |
|---|---|
| B (content without complete solution) | 19 docx |
| C (question located but incomplete, or document + position known) | 18,904: 1,504 QBG ids, 17,365 booklet rows, 35 docx with unconverted equations or incomplete options |
| D (metadata + answer) | 678 QBG ids |

## 8. Metadata-only questions

**35,707** QBG ids (E_METADATA_ONLY).

## 9. Unresolved questions

- **20** H_UNRESOLVED: id-less rows with no document position.
- **44** test positions without a valid id.

## 10. Conflicts

**1,480**, all UNRESOLVED:

| Severity | Count | Composition |
|---|---|---|
| HIGH | 144 | 117 option-vs-value type, 26 subject, 1 answer. These records are F_CONFLICT |
| MEDIUM | 515 | taxonomy 365, difficulty 62, same-position-different-ids 63, source 17, type 8 |
| LOW | 821 | |

Also: 1,637 taxonomy-name variants and 224 unknown taxonomy paths.

## 11. Duplicates

188 groups; nothing deleted.

- 47: one id on several AutoCuration rows (merged).
- 141: an id repeated inside one test. 140 are at consecutive positions, a likely comprehension-parent pattern (INFERRED).
- No text duplicates.

## 12. Source-document recovery results

- **8,836 documents registered:**
  - 58 question papers
  - 66 solutions
  - 329 inferred booklet documents
  - 8,225 video solutions
  - 37 folders
  - 119 Google Sheets
  - 4 local docx
- **All external documents are UNAVAILABLE_LOCALLY / NOT_ATTEMPTED.**
- **The local AITS Test-03 pair gave 75/75 questions, answer keys and solutions,** with the key and the solution line agreeing on 75/75. The paper is **not** the sheet's 15-12-2024 AITS test (that one is class 11, the docx is class 12), so it was deliberately not linked. Its PYQ citations narrow 52 questions to 30-id candidate sets (LOW).

## 13. Equation / OLE recovery limitations

- All docx equations are MathType OLE (`Equation.DSMT4`): 92 on the question side and 238 on the solution side.
- The app's deterministic converter (`python/qbg_modification/mtef.py`) needs **MathType's MT6.dll**, which is **not installed**.
- No equation was guessed or OCR-ed. Each is a `<span class="unconverted-equation" data-ole-object=… data-preview=…>` placeholder.
- 406 media files were copied out (330 WMF, 69 EMF, 7 PNG/JPEG). WMF/EMF do not render in browsers.
- 54/75 questions are NEEDS_REVIEW. 3 symbols (MT Extra / Wingdings) are unmapped.
- *Revision 2:* Q59's options are now 4/4 (options (1)–(2) were inside the stem paragraph). The placeholder queue is `data/review/docx_equation_placeholders.csv`.

## 14. RankUp material unavailable

- **0 records**, UNAVAILABLE: PYQ registers (brief: 556 + 213), 331 concepts, 124 archetypes, 27 books, the generated bank and QC.
- **Ready for ingestion:**
  - the model (fusion anchor/secondary PYQ, TC/PA links, trap, V1–V10 QC, C1–C8 trap sweep)
  - parsers and validators (tested with fixtures)
  - the `query.mjs --rankup` command

## 15. Canonical schema

Entities: sources, source_documents, qbg_questions (canonical), source_document_questions, qbg_id_master, qbg_question_metadata, qbg_test_occurrences, conflicts, duplicates, provenance_edges, taxonomy_nodes, identifier_registry, pyq_register, concept_register, archetype_register, reference_book_register, rankup_questions, rankup_provenance, rankup_qc.

Fields and record shapes are in [CANONICAL_DATA_MODEL.md](CANONICAL_DATA_MODEL.md) and [DATA_DICTIONARY.md](DATA_DICTIONARY.md). The comparison with the Supabase schema is in [SCHEMA_GAP_ANALYSIS.md](SCHEMA_GAP_ANALYSIS.md):
- `qbg_questions` needs **no change**; provenance goes in `raw_data[0]._recovery`.
- 4 core side tables are proposed and **not applied**: test occurrences, source documents, conflicts, duplicates.

## 16. Generated output files

- **`data/canonical/`:**
  - qbg_questions.jsonl, qbg_id_master.jsonl, qbg_question_metadata.jsonl, qbg_test_occurrences.jsonl
  - qbg_conflicts.jsonl, qbg_duplicates.jsonl
  - source_documents.jsonl, source_document_questions.jsonl, provenance_edges.jsonl
  - taxonomy_nodes.jsonl, identifier_registry.json, sources.json
  - pyq_register / concept_register / archetype_register / reference_book_register / rankup_questions / rankup_provenance / rankup_qc (.jsonl, empty) + rankup_status.json
- **`data/reports/`:** recovery_summary.{json,csv}, recovery_by_{subject,chapter,source,exam,test,question_type,difficulty,origin}.csv, qbg_overlap_report.csv, validation_report.json, output_hashes.json
- **`data/review/`:** missing_content, answer_conflicts, option_conflicts, metadata_conflicts, duplicate_candidates, broken_links, low_confidence_records, parent_child_relationships (was parent_child_conflicts), taxonomy_name_conflicts, taxonomy_path_issues, unresolved_records, same_position_anomalies, docx_equation_placeholders, local_documents, qbg_export_unmatched_ids, qbg_export_row_issues (.csv)
- **`data/staging/`, `data/extracted/`:** intermediates and docx media
- **`data/import_plans/`:** dry-run plans

`data/` is git-ignored via the new `data/.gitignore`. It is about 200 MB and regenerable.

## 17. Validation results (commands actually run)

| Command | Result |
|---|---|
| `node scripts/data/recovery/run_all.mjs` | exit 0; validation **32/34 pass, 0 errors**. The 2 warnings are data findings: 224 taxonomy paths, 44 invalid id cells |
| second `run_all.mjs` | canonical outputs **byte-identical** (determinism check PASS) |
| `node --test "scripts/data/recovery/tests/*.test.mjs"` | **30/30 pass** |
| `node scripts/data/import/10_validate_import.mjs` | **9/9 plans PASS**; 0 invalid rows, 0 duplicate keys; no DB contacted |
| `node scripts/data/import/03_import_qbg_questions.mjs --dry-run` | 0 eligible (NOT_READY 55,453; READY_WITH_REVIEW 40) |
| `npx tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `npm run build` | exit 0 |
| `npm run lint` | **exit 1**: `Invalid project directory provided, no such directory: …\lint`. This is pre-existing (`next lint` was removed in Next 16); not changed |
| `git diff --check` | **exit 2**: trailing whitespace at `src/app/page.tsx` lines 121, 134, 188, 196. That file's uncommitted change predates this work and was not touched. All new files are clean |

## 18. Remaining manual-review work

The queues in `data/review/`:

| Queue | Rows |
|---|---|
| metadata conflicts | 1,479 |
| taxonomy name variants | 1,637 |
| taxonomy paths | 224 |
| duplicate groups | 188 |
| broken links | 105 |
| low-confidence | 64 |
| answer items (1 conflict + 36 ambiguous COMP answers) | 37 |
| unresolved | 20 |
| parent candidates | 3 |
| option issue (docx Q59) | 1 |

Also for review:
- the 54 NEEDS_REVIEW docx questions
- the policy decision on whether the 40 READY_WITH_REVIEW docx questions belong in `qbg_questions` at all

## 19. Exact next steps

**For RankUp:**

1. Create `data/raw/rankup/` and copy the RankUp files in unchanged (names and formats in [RANKUP_INGESTION_SPEC.md](RANKUP_INGESTION_SPEC.md)).
2. Run `node scripts/data/recovery/run_all.mjs`, then `node scripts/data/recovery/query.mjs --rankup`.
3. Check `VALIDATION_REPORT.md` → the `rankup` group. Confirm what `QBGFileId` identifies before any linking.

**For QBG content (needs your authorisation; not done):**

4. Provide an authorized QBG export (`QBG_data.csv` or equivalent) in `data/raw/qbg/`. Format and handling: [SOURCE_INTAKE.md](SOURCE_INTAKE.md). Or authorise read-only `get-bulk-questions` calls for the ids in `data/review/missing_content.csv`. *Correction (revision 2):* this could supply question/options/solutions **only for the ids the export actually contains**. Every known id is a valid join key, but whether an export covers all 38,033 cannot be known until one is inspected. Rows also pass the checks in SOURCE_INTAKE.md first.
5. Optionally, grant access to the 58 question-paper and 66 solution Drive files, or install MathType on a machine to convert the docx equations.

**For Supabase (later, after review):**

6. Apply the proposed side tables to a new project, then run the importers with `--apply --confirm-project=<ref>`.

## 20. Git status

*(As of the first pass, before commit f577b75. It is not updated for revision 2.)*

```
 M src/app/api/admin/chapters/route.ts               (pre-existing, from the schema-rebuild work)
 M … 27 more src/ files                             (pre-existing; identical list to the session start)
?? "AutoCuration_Lovee (1).xlsx"                    (source, untouched)
?? "Important IDs REplica (1).xlsx"                 (source, untouched)
?? data/                                            (only data/.gitignore and data/README.md are trackable)
?? docs/SCHEMA_REBUILD_AUDIT.md, scripts/sql/000_rebuild_schema.sql, 001_post_import_backfills.sql, scripts/sql/validate/, src/lib/auth/devAuth.ts   (pre-existing)
?? docs/data_recovery/                              (new: this work)
?? scripts/data/                                    (new: this work)
git diff --stat: 28 files changed, 82 insertions(+), 64 deletions(-)   (all pre-existing; this work modified no tracked file)
```

**NO COMMIT. NO PUSH.** No source file was modified, deleted or overwritten.

## Confidence summary

| VERIFIED | INFERRED | UNKNOWN |
|---|---|---|
| id formats and counts; link/hyperlink id agreement; 0 id collisions; test-position mapping for AITS/PYQ/Full length; docx content and answer-key agreement; the docx is not the sheet's 15-12-2024 test; all counts in this report | TEXT `qbg_id`; `Row_Number` = position; JRTS/RTS/Onepass test segmentation; passage-parent pattern; "Comp" = parent; document roles from column semantics; vocabulary choices; docx class 12; id-less rows = never-ingested booklet questions | historical column types/uniqueness/RLS; question bodies for every QBG id; AITS column M; QBGFileId semantics; all RankUp content; occurrence languages |
