# RankUp ingestion specification (drop folder)

**Current status: UNAVAILABLE (`presence: NOT_PRESENT`).** None of the RankUp files are in this repository. RankUp is optional: `run_all.mjs` completes without it, creates no RankUp record, and reports `RankUp status = NOT_PRESENT`. See `data/canonical/rankup_status.json`.
The pipeline has **not** fabricated any RankUp record. Every RankUp dataset is present but empty.

## How to supply the files

1. Create `data/raw/rankup/`. It is read-only input: the pipeline never writes there.
2. Copy in, unchanged:

   | File | Expected content (per brief) | Parsed as |
   |---|---|---|
   | `PYQ_Register_SBC_ATM_PER_RDX.md` | 556 PYQs (Some Basic Concepts / Structure of Atom / Periodicity / Redox) | markdown tables; rows whose id cell starts `PYQ-` |
   | `EC_PYQ_Register.md` | 213 PYQs (Electrochemistry) | same |
   | any other `*PYQ*Register*.md` | more PYQ registers | same |
   | `Textbook_Concept_Register.md` | 331 concepts `TC-XXX-###` | rows whose id cell starts `TC-` |
   | `Problem_Archetype_Register.md` | 124 archetypes `PA-XXX-###` | rows whose id cell starts `PA-` |
   | `Reference_Library_Book_Cards.md`, `Book_Concept_Guide.md`, `Chemistry_Source_Library.md`, `Extensive_Source_Compilation.md` | 27 book cards etc. | `## <title>` sections with `- **Key:** value` lines (file name must contain book/library/source) |
   | `rankup_chem_bank.csv` | generated questions | CSV; columns matched by name (below) |

3. Run `node scripts/data/recovery/run_all.mjs`, or `node scripts/data/recovery/06_rankup.mjs` followed by `08_validate.mjs`.
4. Check the results with `node scripts/data/recovery/query.mjs --rankup [<rankup_question_id>]`.

## Column matching for `rankup_chem_bank.csv`

Names are compared lower-case with punctuation stripped:

- `id` / `rankup_question_id` / `question_id` / `rq_id`
- `question`, `options`, `answer`, `solution`, `difficulty`, `ideal_time`
- `chapter`, `topic`, `subtopic`, `question_type`, `fusion_type`, `trap` / `trap_code` / `trap_lever`
- `source PDF ID`, `source solution PDF ID`, `QBGFileId`
- `anchor_pyq` / `pyq1` / `anchor`

Columns whose header looks like a QC check are kept as QC result rows: `V1`…`V10`, blind, recompute, fusion audit, trap audit, uniqueness, originality, WAA, ideal time, language, depth.

## Rules the parser enforces

- `QBGFileId` is stored as `qbg_file_id`, with semantics **UNKNOWN**. It is never used as `qbg_id` (a validator check enforces this). Until evidence shows what it identifies, it stays a separate identifier system.
- PYQ **roles are never invented.** Only an explicit anchor column fills `anchor_pyq_ids`. Every other `PYQ-…` id found in the row goes to `secondary_pyq_ids`, with `role_basis = "ids found in row; roles not stated"`.
- `TC-…` and `PA-…` ids anywhere in the row become concept/archetype links.
- A generated question is `origin_type = RANKUP_GENERATED`. It is never written into `qbg_questions`, and never into the QBG record of a question it references.
- A PYQ register row is `PYQ_SOURCE`. It is linked to a QBG question only if a row carries a QBG id (none is expected), and even then only as a relationship.
- Book cards carry `usage_rule = "concepts/techniques only; never copy problems or wording"`.

## Validation once data exists (`08_validate.mjs`)

Every generated question must have:
- an anchor or referenced PYQ
- a difficulty, an answer and a solution
- a fusion type (WARN if missing)

`QBGFileId` must never be promoted to `qbg_id`.

## QC model carried in `rankup_status.json`

- **V1–V10:**
  - V1 blind re-solve
  - V2 numerical recompute
  - V3 fusion audit
  - V4 trap audit
  - V5 uniqueness
  - V6 originality
  - V7 wrong-answer analysis
  - V8 ideal time
  - V9 language/formula/unit
  - V10 depth
- **Trap sweep C1–C8** (from the jee-chemistry-engine skill):
  - C1 missing structure
  - C2 ambiguous conditions
  - C3 scope violation
  - C4 n-factor ambiguity
  - C5 unit/sig-fig mismatch
  - C6 arguably-correct distractor
  - C7 numeric inconsistency
  - C8 duplicate concept

## Answering the RankUp success question

"Which PYQs, concepts and archetypes produced it, what trap/fusion was used, and which QC checks passed?" is answered by `query.mjs --rankup <id>`. It prints `fusion`, `trap`, the provenance edges and the QC rows. Today it prints the UNAVAILABLE status.
