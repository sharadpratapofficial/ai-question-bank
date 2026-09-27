# Checkpoint 04: source staging and docx content recovery

**Status:** complete.

## Staging (`node scripts/data/recovery/03_stage.mjs`)

Outputs in `data/staging/`:
- `autocuration_rows.jsonl`: 34,168 rows. Every field is kept as `{raw_value, normalized_value, rule, confidence, status}`, alongside the raw row and its hyperlinks.
- `test_occurrences.jsonl`: 33,882 id-cell records.
  - JRTS 567, RTS 1,692, AITS 8,399 plus 43 invalid-id positions, Copy of AITS 8,442 (all `MIRROR_OF_AITS`).
  - PYQs 10,227, Onepass 2,130 tabular + 1,480 block, Full length 558 block.
  - Every id-shaped cell in the workbook is accounted for (0 unclaimed after the safety-net scan).
- `taxonomy_observations.jsonl`: 52,818 distinct (level, id, name, source) observations from the tagging CSV, the AutoCuration `tagging`/class-map sheets, AutoCuration row codes and AITS columns N–U.
- `curated_tests.jsonl`: 116 rows from AutoCuration `output`. E-mail addresses are not copied.

Findings:
- The 43 AITS positions whose QBG id cell reads `Paper-02`, plus one reading `QUE ERROR` (15-12-2024, Q071), are real question positions with taxonomy but no id.
- AITS test instances: 62.

## Docx recovery (`node scripts/data/recovery/04_docx_extract.mjs`)

AITS Test-03 (12th JEE Main, 15-12-2024) → `data/extracted/docx_questions.jsonl`:
- 75/75 questions (25 Physics, 25 Chemistry, 25 Maths), 75 answer-key entries and 75 solutions.
- The answer key agrees with each solution's own answer line in 75/75 cases.
- 75/75 carry a PYQ citation, e.g. `[25 Feb, 2021 (Shift-I)]`.
- Equations are MathType OLE objects: 92 on the question side and 238 on the solution side. They are **not converted**, because MT6.dll is not installed and no equation is guessed. Each one is a placeholder `<span class="unconverted-equation" data-ole-object=… data-preview=…>`.
- 406 media files were copied to `data/extracted/docx_media/` (330 WMF, 69 EMF, 5 PNG, 2 JPEG). WMF/EMF files do not render in browsers.
- 54/75 questions are NEEDS_REVIEW. Q59 has only 2 of 4 options parsed. Q18 and Q75 contain MT Extra / Wingdings symbols with no published mapping, which are kept as placeholders.

**Not linked to QBG ids.** The AITS sheet's 15-12-2024 Arjuna test also has 75 positions, but they are class-11 chapters, while this document is a 12th paper. A position match would have attached the wrong content, so no mapping was applied. The records are `origin_type = IMPORTED_EXTERNAL`, `qbg_link_status = NO_QBG_MATCH`.

The other two docx files (the modifier sample and the Batch Test export) are app fixtures. They are registered but not extracted.

## Next

Canonical build: ID master, cross-match, occurrences, source-document registry, conflicts, duplicates and classification (checkpoints 05–07).
