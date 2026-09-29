# Inference log

Every decision that rests on inference rather than on a stated fact. **Inferred history is never presented as fact.**
Date for all entries: 2026-09-27. "Reversible" means the choice can be undone by changing a rule and re-running `run_all.mjs`; no source is altered.

---

### INFER-QBG-001: replacement `qbg_id` is TEXT
- **Source:** both workbooks; `create_qbg_question_pool.sql`; `qbg.py`
- **Observed:** every external QBG id is 25 lowercase base-36 characters, not a UUID. The pool table stores the same value as `text`.
- **Inference:** `qbg_questions.qbg_id` stays `text`.
- **Reason:** compatibility with both legacy QBG ids and the UUID strings current writers store.
- **Confidence:** HIGH for compatibility; UNKNOWN for the historical type.
- **Impact:** allows both id styles. **Reversible:** yes.

### INFER-QBG-002: workbook "QBG IDs" are QBG `unique_id` values
- **Source:** AutoCuration `link`; Important IDs PYQ hyperlinks; `qbg.py get_bulk_questions(uniqueIds)`
- **Observed:** 14,186 AutoCuration rows have a `qbg-admin…/question-details?question=<id>` link equal to the row's id (0 mismatches). 2,578/2,578 PYQ id cells hyperlink to the same QBG page.
- **Inference:** these ids are what the QBG API calls `unique_id`, so bodies are retrievable by them with authorisation.
- **Confidence:** HIGH. **Impact:** defines where missing content lives. **Reversible:** n/a.

### INFER-QBG-003: question ids and taxonomy ids share a shape but not a space
- **Observed:** subject/chapter/topic/subtopic/class ids use the same 25-char format. 0 values occur as both a question id and a taxonomy id.
- **Inference:** meaning is decided by column context, never by shape.
- **Confidence:** HIGH. **Impact:** prevents taxonomy ids being counted as questions. **Reversible:** n/a.

### INFER-QBG-004: rows without a QBG id are separate candidates
- **Observed:** 17,385 AutoCuration rows (Brahmastra, Main Booklet, JEE Advanced, Real Test, AITS-NoVideo) have no id, only a Drive document plus `Row_Number` and taxonomy.
- **Inference:** these are curated booklet questions **not ingested** into QBG. Each row is its own candidate (`acrow:<row>`), `origin_type = IMPORTED_EXTERNAL`.
- **Confidence:** MEDIUM. **Impact:** 17,385 records that never merge with QBG ids.
- **Reversible:** yes (the identity rule is in `05_build.mjs`).

### INFER-QBG-005: `Row_Number` is the question's position in its document
- **Observed:** for AITS-sourced rows, `Row_Number` equals the AITS sheet's question number.
- **Inference:** document + `Row_Number` locates a question (`C_QUESTION_LINKED`).
- **Confidence:** MEDIUM. **Impact:** 18,904 records are classified C. **Reversible:** yes.

### INFER-QBG-006: AutoCuration `class` column is overloaded
- **Observed:** it holds "11"/"12" for some batches and solution-PDF names or Drive URLs for others (e.g. AITS rows: `AITS_Test-01_…_Solution.pdf`).
- **Inference:** only 9–12 values are class levels. Others are kept as `class_column_document_ref`.
- **Confidence:** HIGH. **Reversible:** yes.

### INFER-QBG-007: topic/subtopic columns are swapped in some rows
- **Observed:** 1,820 rows have an id in `topic` and a name in `topic_code`; 190 rows do the same for subtopic.
- **Inference:** the values are swapped back and the swap is flagged per row.
- **Confidence:** HIGH (the id resolves to a taxonomy node). **Reversible:** yes.

### INFER-QBG-008: "Copy of AITS" mirrors AITS
- **Observed:** all 8,442 id rows match AITS row by row. The only difference is the blank `Q. Type` in the copy.
- **Inference:** mirror rows are not counted as usage.
- **Confidence:** HIGH. **Reversible:** yes.

### INFER-QBG-009: test instances in JRTS / RTS / Onepass are inferred from numbering resets
- **Observed:** these sheets have no test number or date. Numbering restarts at the start of each test.
- **Inference:** a new test starts where the question number fails to increase or the context changes.
- **Confidence:** MEDIUM. **Impact:** "same position, different ids" checks run only on determinate instances. **Reversible:** yes.

### INFER-QBG-010: an id repeated at consecutive positions of one test is likely a passage parent
- **Observed:** 140 of 141 within-test repeats are consecutive (98 AITS, 36 PYQ-Advanced where the type is COMP, 6 JRTS).
- **Inference:** a comprehension/passage parent id was entered for each child.
- **Confidence:** LOW–MEDIUM. **Impact:** review queue only; nothing is merged or re-parented. **Reversible:** yes.

### INFER-QBG-011: AITS column K "Comp" holds comprehension-parent candidates
- **Observed:** 4 non-empty cells with ids.
- **Inference:** they may be `parent_question_id` values. **Not applied**; they are listed in `parent_child_conflicts.csv`.
- **Confidence:** LOW. **Reversible:** yes.

### INFER-QBG-012: the AITS Test-03 docx is NOT the 15-12-2024 AITS test in the sheet
- **Observed:** the sheet's 15-12-2024 Arjuna JEE Main test has 75 positions with class-11 chapters (Center of Mass, Structure of Atom, Sets…). The docx is a "12th JEE Main" paper whose "Topics Covered" and Q1 are class-12.
- **Inference:** same date, different paper, so no position mapping. The 75 docx questions stay unlinked.
- **Confidence:** HIGH. **Impact:** prevents contaminating 75 QBG ids with the wrong content. **Reversible:** yes.

### INFER-QBG-013: docx PYQ citations resolve only to candidate sets
- **Observed:** every solution ends with e.g. `[25 Feb, 2021 (Shift-I)]`. The PYQs sheet lists 30 QBG ids per paper and subject.
- **Inference:** the question is **one of** those 30. No single id is chosen.
- **Confidence:** LOW for any specific id. **Reversible:** yes.

### INFER-NORM-001: vocabulary
- **Choices:**
  - "Maths" (QBG taxonomy's own subject name) for Mathematics and its typos
  - "JEE Main" / "JEE Advanced" / "NEET" for exams
  - Easy/Medium/Hard, from QBG codes 1/2/3 as in the app's `DIFFICULTY_MAP`
  - "Difficult" → Hard (MEDIUM)
  - app `QuestionType` strings; `Numerial` → Numerical; `Int` → Integer; `Para*` → COMP / Passage_Numerical (MEDIUM)
- **Confidence:** HIGH as conventions, not historical. Originals are always kept. **Reversible:** yes.

### INFER-NORM-002: answers
- **Choices:**
  - Option answers are 1-based index arrays (`[1]` for SCQ, per `src/types/index.ts`)
  - letters A–H map to 1–8
  - decimal numerical answers stay **strings** ("64.00" is not rounded to 64)
  - a lone number on a COMP/unknown-type question is UNRESOLVED, because it could be an option or a value
- **Confidence:** HIGH. **Reversible:** yes.

### INFER-NORM-003: taxonomy display name comes from the id
- **Observed:** the same taxonomy id appears with different spellings across sources (1,637 ids).
- **Inference:** the display name is taken from the tagging CSV, which is QBG's own taxonomy export, then the AutoCuration tagging sheet, and so on. This is a documented precedence for **labels of one id**, not a choice between conflicting facts. Name-only variants are LOW conflicts.
- **Confidence:** MEDIUM. **Reversible:** yes (`TAX_NAME_PRECEDENCE`).

### INFER-ID-001: `question_id` is minted
- **Inference:** `question_id = uuidv5(record_key)` gives stable ids across runs and idempotent imports. These are **new** ids, not recovered historical `question_id`s.
- **Confidence:** HIGH (determinism). **Reversible:** yes (the namespace is in `lib/common.mjs`).

### INFER-DOC-001: document roles
- **Rule:**
  - file-name suffix `_Q/_Ques/_Questions` → QUESTION_PAPER, and `_Sol/_Solution` → SOLUTION (HIGH)
  - column semantics give MEDIUM confidence
  - AutoCuration `link` on id-less rows → QUESTION_DOCUMENT_INFERRED (LOW)
- **Reversible:** yes.

### INFER-DOC-002: equations are not converted
- **Observed:** all equations are MathType OLE (`Equation.DSMT4`). The app's converter needs MT6.dll, which is not installed.
- **Inference:** keep placeholders that reference the OLE object and its WMF preview. Never decode MTEF heuristically.
- **Confidence:** HIGH. **Reversible:** yes (re-run where MathType exists).

### INFER-RK-001: RankUp roles are never invented
- **Rule:** in a supplied RankUp bank, only an explicit anchor column marks `anchor_pyq_ids`. Other PYQ ids found in a row are `secondary_pyq_ids`, with `role_basis` recorded. `QBGFileId` is kept separate and never treated as `qbg_id`.
- **Confidence:** HIGH. **Reversible:** yes.

### INFER-BRIEF-001: a brief example id does not exist
- **Observed:** `m17hp8zu9zycqk5ripht6kf9ew` occurs nowhere. JRTS row 2 has `m17hp8zu9zyc74xcrxpwia4kt`, and AutoCuration row 2 has `y2yail3zjxcqk5ripht6kf9ew`.
- **Inference:** the brief's value is a splice of the two; it is not treated as real.
- **Confidence:** HIGH.
