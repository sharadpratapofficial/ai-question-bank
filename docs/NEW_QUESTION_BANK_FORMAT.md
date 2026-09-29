# New question bank: canonical format and importer

Status: design for Phase 1 and 2. **Nothing has been imported.**
Target: `public.qbg_questions` in Supabase project `ljkpcqllqdamdatesbfe`, with the schema from `scripts/sql/000_rebuild_schema.sql`.
Importer: `scripts/newbank/import-questions.mjs`. Tests: `node --test scripts/newbank/tests/newbank.test.mjs`.

The legacy recovery data, including the 38,033 metadata-only QBG records, is **not** imported by this path. New questions do not need an old QBG id.

Every rule below comes from how the app reads the table. Code references are given as `file:line`.

---

## 1. Two layers

| Layer | What it is | Who writes it |
|---|---|---|
| **Canonical input record** | One JSON object per question, in a `.jsonl` file (or a `.json` array). It uses readable field names (`answer`, `difficulty`, `source_key`). | A small per-source adapter that we write after inspecting your source file. |
| **Database row** | A `qbg_questions` row in exactly the shape the app renders. | Only the importer. It maps and validates every input record. |

The importer never guesses. A record that lacks a required value is **rejected** and listed with its reasons. A missing optional value is stored as `NULL`. For example, difficulty is never defaulted to `Medium`.

---

## 2. Field reference

In the "Req." column, **R** means required, **O** means optional, **C** means conditional, and "auto" means the importer or DB sets the value.

| Input field | DB column | PostgreSQL type | Req. | Accepted format | Example | Validation |
|---|---|---|---|---|---|---|
| `source_key` | `question_id` (derived) | `uuid` PK | **R** | Stable id of the question in *your* source: 1–200 chars `[A-Za-z0-9._:-/]`, starting alphanumeric | `RANKUP-PHY-000123` | Unique in the file. `question_id = uuidv5("newbank:"+source_key)`, so a re-import updates or skips the same row and never duplicates it. The key is kept in `raw_data[0]._newbank.source_key`. |
| `legacy_qbg_id` | `qbg_id` | `text` | O | A genuinely known old QBG id: 1–64 chars `[A-Za-z0-9_-]` | `4ii5mxgv84bkvg16rv8akjy1j` | Unique in the file and not already held by another row in the DB. **If absent, `qbg_id = question_id`**, matching every writer in `src/` (e.g. `api/questions/route.ts:99`). It is shown on the detail page, and the API refuses to edit it. |
| `question_type` | `question_type` | `text` | **R** | A canonical value (§3) or an alias | `Single_Choice(SCQ)` or `SCQ` | Aliases are normalised deterministically, and each normalisation is reported as a warning. Unknown types are rejected. |
| `question_text` | `question_text` | `text` | **R** | HTML. LaTeX is allowed inside `\( \)`, `\[ \]`, `$ $` or `$$ $$` (KaTeX, `MathContent.tsx:92-142`). MathML is allowed. | `<p>A ball of mass \(2\,kg\)…</p>` | Must be non-empty. See §5 for HTML safety and images. For a passage parent, this holds the passage. |
| `options` | `options` | `jsonb` (default `[]`) | C | Input: an **array of HTML strings** in display order | `["<p>2 m/s</p>","<p>4 m/s</p>","<p>6 m/s</p>","<p>8 m/s</p>"]` | Option types need 2–10 options, none empty (an empty one would shift the A/B/C/D labels). Numeric and passage types must have none. Stored as `[{text, isCorrect}]` (§4). |
| `answer` | `answer_key` | `jsonb` | C | Option types: 1-based number(s) or letter(s). Numeric types: one number. | `"B"`, `2`, `["A","C"]`, `243`, `"2.50"` | Required for every non-parent question and forbidden on a passage parent. See §4. The value as given is kept in `raw_data[0]._newbank.answer_as_given`. |
| `solution_text` | `solution_text` | `text` | O | HTML, same rules as `question_text` | `<p>Using \(v=u+at\)…</p>` | Optional. A missing solution is reported as a warning, never invented. |
| `subject` | `subject` | `text` | **R** | `Physics`, `Chemistry`, `Maths`, `Biology`, `Botany`, `Zoology` | `Physics` | Case-insensitive. `Mathematics` and `Math` become `Maths`. Anything else is rejected. |
| `chapter` | `chapter` | `text` | **R** | Free text | `Laws of Motion` | Must be non-empty. Test generation filters on subject and chapter, so a question without a chapter is unusable. |
| `topic` | `topic` | `text` | O | Free text | `Friction` | — |
| `subtopic` | `subtopic` | `text` | O | Free text | `Static friction on an incline` | — |
| `difficulty` | `difficutly_level` *(sic)* | `text` | O | `Easy`, `Medium` or `Hard` (case-insensitive) | `Medium` | Anything else is rejected. There is no default. The column name keeps the real DB misspelling. |
| `exam` | `exam` | `text[]` | O | A string or an array of strings | `["JEE Mains","JEE Advanced"]` | `JEE Main` becomes `JEE Mains` and `JEE Adv` becomes `JEE Advanced`; `NEET` and `BITSAT` are also known. Unknown labels are kept but reported as warnings. Duplicates are removed. |
| `class_level` | `class_level` | `text` | O | `11` or `12` (also accepts `Class 11`, `XI`, `XII`) | `"11"` | Stored as `"11"` or `"12"`, since `testAiGeneration.ts:407` rejects anything else. |
| `source` | `source` | `text` | **R** | Name of the source book, bank or author | `RankUp Physics Set 3` | Must be non-empty. It is shown as a filter in the app. |
| `status` | `status` | `question_status` enum | O | `verification_pending`, `verified`, `double_verified`, `uat_passed` or `rejected` | `verification_pending` | Default `verification_pending`. |
| `parent_source_key` | `parent_question_id` | `text` | C | The `source_key` of the passage parent **in the same file** | `RANKUP-PHY-P-0007` | Required for child questions. Stored as the parent's `question_id` UUID string (`api/questions/[id]/route.ts:33-49`). See §6. |
| `child_order` | `child_order` *(added by `003`, G2)* | `smallint` | C | Integer ≥ 1 | `2` | Required for children and unique within the group; the DB enforces ≥ 1, parent required, and unique per parent. Also kept in `raw_data[0]._newbank.child_order`. The importer needs `003` applied before `--check-db` / `--apply`. |
| `provenance` | inside `raw_data` | `jsonb` | O | A free JSON object describing where the question came from | `{"file":"Set3.docx","page":4,"author":"…"}` | Stored verbatim. |
| — | `raw_data` | `jsonb` | auto | `[{ "_newbank": {…} }]` | see §7 | Always a 1-element **array**, because the app reads `raw_data[0]` (`QuestionCard.tsx:162`). |
| — | `source_docx` | `jsonb` | auto | `null` | — | Holds DOCX-ingest OOXML only. See gap G6. |
| — | `created_by`, `last_modified_by` | `uuid` → `auth.users` | auto / O | Set from `--as-user=<uuid>`, otherwise `NULL` | — | The user must exist in `user_profiles`. The edit-history trigger attributes the insert to this user. |
| — | `last_modified_at` | `timestamptz` NOT NULL | auto | Import time | — | — |
| — | `created_at`, `updated_at` | *do not exist* | — | — | — | Gap G1. Creation time is recorded in `question_edit_history` (`change_type='create'`) and in `raw_data[0]._newbank.imported_at`. |

Unknown input fields reject the record. This means a typo such as `solution` for `solution_text` can never be silently dropped.

---

## 3. Supported question types

These are the exact strings the app compares against. The comparison is case-sensitive (`src/lib/constants.ts`, `src/types/index.ts:113-124`).

| Canonical `question_type` | Kind | Accepted input aliases | `options` | `answer` → `answer_key` |
|---|---|---|---|---|
| `Single_Choice(SCQ)` | option, 1 correct | `SCQ`, `Single Choice`, `Single Correct` | 2–10 HTML strings | `"B"` or `2` → `[2]` |
| `Multi_Choice(MCQ)` | option, ≥1 correct | `MSQ`, `Multiple_Choice(MCQ)`, `Multi Choice`, `Multi Select`, `Multiple Correct` | 2–10 | `["A","C"]` or `[1,3]` → `[1,3]` (sorted, no repeats) |
| `Assertion_Reason(AR)` | option, 1 correct | `AR`, `Assertion Reason` | The standard statements (usually 4), as given in the source | `[n]` |
| `Matching_List(ML)` | option, 1 correct | `ML`, `Matching List`, `Match the Following`, `Match the Column`, `List Match` | The coded combinations (usually 4), as given in the source | `[n]` |
| `Integer` | numeric | `Integer`, `Int`, `Integer Type` | none | integer → `243` (negative allowed) |
| `Single_Digit_Integer` | numeric | `Single Digit` | none | 0–9 → `7` |
| `Numerical` | numeric | `Numerical`, `Numeric`, `NAT`, `Numerical Value`, `Decimal` | none | number → `2.5` (the input `"2.50"` is kept in `answer_as_given`) |
| `Composite` | passage parent | `Comprehension`, `Passage`, `Paragraph` | none | must be absent |
| `Passage_Numerical` | passage parent | `Passage Numerical` | none | must be absent |

How each type is represented:
- **Assertion-Reason:** the app has no special structure for it (`constants.ts:44`). Put `Assertion (A): …` and `Reason (R): …` in `question_text`, and put the standard answer statements in `options` exactly as in the source.
- **Matching List:** the app has no special structure either. Put List-I and List-II in `question_text`, preferably as an HTML `<table>`, and put the coded combinations (`A-2, B-3, …`) in `options`.
- **Matrix-match with several correct cells per row** (JEE Advanced style) has **no representation** in the app. Such records are rejected unless the source frames them as a single-answer ML or as an MCQ.
- **Ambiguous, rejected on purpose:** `MCQ`, `Multiple Choice`, `Multiple Choice Question`. In JEE/NEET usage these often mean *single-correct* questions, while the app's `Multi_Choice(MCQ)` means *multi-correct*. The per-source adapter must map them explicitly once the source's meaning is confirmed.
- **Not accepted:** `Passage_SCQ` (not in the app's constants; it appears only in a JEE-Advanced pattern), `Unknown`, and anything not listed above.

---

## 4. Exact JSON of `options` and `answer_key`

`options` is an array of objects, `[{ "text": <HTML string>, "isCorrect": <boolean> }]` (`types/index.ts:7-10`).
- Letters are **not stored**. The app derives them from position: `String.fromCharCode(65 + i)` gives A, B, C, …
- The importer sets `isCorrect` from the answer, and also writes `answer_key`. The app highlights the correct option with `answerKey.includes(i + 1) || opt.isCorrect` (`QuestionCard.tsx:326`), so the two always agree.
- Numeric and passage types store `[]`.

`answer_key` (`types/index.ts:17`):

| Kind | JSON stored | Example |
|---|---|---|
| SCQ / AR / ML | array with one **1-based** option number | `[2]` |
| MCQ / MSQ | sorted array of 1-based option numbers | `[1, 3]` |
| Integer / Single_Digit_Integer | JSON number (integer) | `243` |
| Numerical | JSON number | `2.5` |
| Passage parent | `null` | `null` |

These are never stored in `answer_key`:
- letters (`"B"`): the app drops them as NaN (`types/index.ts:821-830`);
- numeric strings;
- ranges (`"2.4-2.6"`): no tolerance support, see gap G4;
- 0-based indices.

Example SCQ row:

```json
{
  "question_type": "Single_Choice(SCQ)",
  "options": [
    {"text": "<p>2 m/s</p>", "isCorrect": false},
    {"text": "<p>4 m/s</p>", "isCorrect": true},
    {"text": "<p>6 m/s</p>", "isCorrect": false},
    {"text": "<p>8 m/s</p>", "isCorrect": false}
  ],
  "answer_key": [2]
}
```

---

## 5. Content rules (HTML, maths, images)

- Text fields are rendered with `dangerouslySetInnerHTML` (`MathContent.tsx`). The importer therefore **rejects** `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<link>`, `<meta>`, `<base>`, `on…=` handlers and `javascript:` URLs.
- Maths should be written as LaTeX inside `\( … \)` or `\[ … \]`, which KaTeX renders. MathML is passed through unchanged.
- **Images** go to the private `question-media` bucket (rules: `src/lib/questionMedia/core.ts`; see §9, G5):
  - **`<img src="media:figs/q12.png">`** refers to a file under `--media-dir`. This is the preferred form.
  - **`<img src="data:image/...;base64,…">`** inline images are **moved to storage** as well (named `inline-1`, `inline-2`, …), unless `--keep-inline-images` is given.
  - **Validation happens locally, by content:** PNG, JPEG, GIF or WebP; not empty; at most 10 MB; the extension must match the content. SVG is refused. Paths must stay inside `--media-dir` (no `..` and no absolute paths).
  - **Deterministic object path:** `newbank/<question_id>/<source name>-<first 12 hex of SHA-256>.<ext>`. The same bytes always get the same path; changed bytes get a new one, so nothing is overwritten.
  - **The stored HTML** gets `src="/api/question-media/<path>"`: a stable app route, never a public or signed URL. `raw_data[0]._newbank.media` records each reference: `field`, `source`, `original_name`, `file_name`, `storage_path`, `sha256`, `bytes`, `mime`.
  - **`https://` URLs** are accepted with a warning. Relative paths without `media:`, and `<img>` without `src`, are **rejected**.

---

## 6. Comprehension / passage (parent–child)

```
parent  : question_type Composite (or Passage_Numerical), question_text = the passage,
          no options, no answer
children: any non-parent type, with parent_source_key = parent's source_key
          and child_order = 1, 2, 3 …
```

- A child's `parent_question_id` is the parent's `question_id` as a text UUID. The app finds children with `.eq("parent_question_id", id)` (`lib/api/questions.ts:140`).
- Test generation skips parents (`Composite`) and children (`parent_question_id IS NOT NULL`, `testGeneration.ts:334-346`). Passage sets are therefore browsable in the app but **not auto-picked into generated tests**. That is existing app behaviour.
- A group is all-or-nothing. If any child is rejected, the whole group is rejected. A parent with no children, an orphan child, or a repeated `child_order` also rejects the group. Nesting is not allowed.
- `--limit` and `--only` always keep a group together.

---

## 7. `raw_data` (provenance)

```json
[{
  "_newbank": {
    "importer": "newbank-v1",
    "source_key": "RANKUP-PHY-000123",
    "legacy_qbg_id": null,
    "parent_source_key": null,
    "child_order": null,
    "answer_as_given": "B",
    "content_hash": "<sha256 of the content columns at import>",
    "source_file": "rankup_physics.jsonl",
    "source_file_sha256": "<sha256 of the input file>",
    "record_number": 17,
    "provenance": { "...": "verbatim from input" },
    "imported_at": "2026-09-27T12:00:00.000Z"
  }
}]
```

- All importer data sits under one `_newbank` key. It never sets the legacy QBG keys (`verification_status`, `solutions`, …) that `001_post_import_backfills.sql` and the app read from `raw_data[0]`.
- The app later adds `raw_data[0].ai_metadata`. That is preserved on update.
- `content_hash` is how the importer tells whether a row was edited in the app after import.

---

## 8. Importer

`scripts/newbank/import-questions.mjs`, which is separate from the recovery importer in `scripts/data/import/`. That importer upserts and overwrites; this one never overwrites silently.

```bash
# 1. offline dry run (default; DB never contacted)
node scripts/newbank/import-questions.mjs --input=data/newbank/in/source.jsonl
node scripts/newbank/import-questions.mjs --input=... --limit=10            # trial selection
node scripts/newbank/import-questions.mjs --input=... --only=KEY1,KEY2      # exact trial set
node scripts/newbank/import-questions.mjs --input=... --media-dir=data/newbank/in/images   # resolve media:<file> images (still local only)

# 2. dry run with read-only DB checks (existing rows, legacy-id conflicts)
node --env-file=.env.local scripts/newbank/import-questions.mjs --input=... --only=... \
     --check-db --confirm-project=ljkpcqllqdamdatesbfe

# 3. apply (needs explicit scope: --limit, --only or --all)
node --env-file=.env.local scripts/newbank/import-questions.mjs --input=... --only=... \
     --apply --confirm-project=ljkpcqllqdamdatesbfe [--as-user=<auth uuid>]
```

| Property | How |
|---|---|
| Dry-run default | No DB client is even loaded unless `--check-db` or `--apply` is given. |
| Project lock | `--confirm-project` must equal both `ljkpcqllqdamdatesbfe` and the ref in `SUPABASE_URL`. |
| Explicit scope | `--apply` refuses to run without `--limit`, `--only` or `--all`, so a full-bank import can't happen by accident. |
| Validation | Every record is checked (§2–§6). Malformed records are rejected with reasons in `rejected.json`, and the rest proceed. |
| Deterministic / idempotent | `question_id = uuidv5(source_key)`. Re-running skips rows that are `unchanged`. |
| No silent overwrite | An existing row is updated only with `--update-existing`, **and** only if it is unchanged since import (content hash matches), **and** its status is still `verification_pending`. Otherwise it is skipped with a reason. |
| Resumable | Re-running after an interruption inserts only the rows that are missing. |
| Duplicates | A repeated `source_key` or `legacy_qbg_id` in the file rejects all occurrences. A `legacy_qbg_id` already in the DB rejects the record. Same text and options is reported as a *possible* duplicate but not rejected. |
| Counts | Console output and `plan.json` / `result.json` give read, valid, rejected, selected, insert/update/skip (with reasons), inserted, updated and failed counts. |
| Read-back | After apply, every written row is re-read and its content hash compared. A mismatch sets exit code 2. |
| Reports | `data/newbank/runs/<timestamp>_<mode>/`: `plan.json`, `rejected.json`, `preview.md` (full content of the selected questions), and `result.json` / `apply.log.jsonl`. `data/` is git-ignored. |

The DB client uses the secret key, which bypasses RLS. It is read only from the environment: `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, plus `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`.

---

## 9. Schema / app gaps

| # | Gap | Status |
|---|---|---|
| G1 | No `created_at` on `qbg_questions` | open, optional |
| G2 | No order for comprehension children | **done:** `scripts/sql/003_new_question_bank_support.sql` §1–2 (applied to the live project) + app/importer |
| G3 | `parent_question_id` has no foreign key | open, optional hardening |
| G4 | No numeric range/tolerance answers | open; only if the source needs it |
| G5 | No question-image workflow | **done:** `003` §3 bucket (applied) + `/api/question-media` read/upload routes + importer image upload |
| G6 | Word export ignores imported questions | open (app change) |
| G7 | App vocabulary drift | open (cleanup) |
| R1 | Recovery importer could write to the new-bank project | **fixed** in `scripts/data/import/lib/importer.mjs` |

### G1: no `created_at`
- **Current:** only `last_modified_at` exists. Creation time is available from the first `question_edit_history` row, or from `raw_data[0]._newbank.imported_at`.
- **Proposed:** `alter table public.qbg_questions add column if not exists created_at timestamptz not null default now();`
- **Blocks:** neither trial nor production.

### G2: child order
Covered by `003`; see §10.

### G3: no foreign key on `parent_question_id`
- **Current:** `parent_question_id` is `text`, while `question_id` is `uuid`, so there's no FK and orphan children are possible from other writers.
- **Proposed:** convert the column to `uuid`, add an FK `on delete restrict`, and add a cast in the restore function. This needs its own review of the app's string typing.
- **Blocks:** neither. The importer validates groups itself.

### G4: range answers
- **Current:** `answer_key` holds one number, and the app drops anything else.
- **Proposed**, only if needed: `{"min","max"}` in `answer_key` plus display code (about 4 files, no schema change).
- **Blocks:** production only if the source has range answers.

### G5: question images
- **Storage:** `003` creates the private bucket `question-media`:
  - 10 MB per file; png, jpeg, gif and webp only (no SVG, because an SVG opened directly can run script);
  - path `newbank/<question_id>/<filename>`.
- **Policies:**
  - read follows the `qbg_questions` SELECT permissions;
  - upload needs `manual_question_entry`, `upload_pdf` or `edit_metadata`, and only into an **existing** question's folder with a valid filename;
  - there is no update or delete policy, so objects are immutable to users;
  - no policy names anon.
- **Reference in the question record:** the question stores only the storage path, wrapped in an app route: `<img src="/api/question-media/newbank/<question_id>/<filename>">`. There are no public or signed URLs in the data, and no secret key in the browser.
- **Built.** All rules live in `src/lib/questionMedia/core.ts`, and a test keeps them identical to the `003` policies.
  1. **Read:** `GET /api/question-media/newbank/<question_id>/<file>`.
     - Returns 401 without a session, and 403 without a read permission.
     - Returns 400 for any path outside the policy's pattern, and 404 when the object is missing or not visible.
     - Otherwise it returns a **302 to a 5-minute signed URL** (`Cache-Control: private, max-age=240`).
  2. **Upload:** `POST /api/question-media`, multipart with `question_id` and `file`.
     - Needs `manual_question_entry`, `upload_pdf` or `edit_metadata`, and is refused **before** the body is read otherwise.
     - Validates the bytes (type, size, extension and declared MIME), and the question must exist.
     - Stores at the deterministic path with `upsert: false`, and returns `{ path, src, file_name, original_name, sha256, bytes, mime }`.
     - Same bytes again: `200 already_exists`. A different object at the path: `409`, never overwritten.
  3. **Clients:**
     - A real session uses the **user's own** Supabase client, so storage RLS applies on top of the route check.
     - Only the dev-auth bypass (never in production) uses the server-only client after the permission check.
     - Nothing in the browser holds a key.
  4. **Importer:** `--media-dir` / `--keep-inline-images`; see §5 and §8.
     - A dry run and `--check-db` validate locally and **upload nothing**.
     - With `--apply`, a question's images are uploaded **before** its row is written, and a failed image holds back its whole passage group.
     - An object already present is reused only if its SHA-256 matches, and never overwritten.
     - Read-back re-hashes every stored image.
- **Not yet:** there is no editor UI button that calls the upload route (the TinyMCE image hook is a later step), and the Word export still ignores these images (G6).
- `docx-media` is **not** used for the new bank.
- **Blocks:** trial only if the trial questions have images; production if the source has images.

### G6 / G7
- **G6:** `/api/tests/generate-word` uses only `source_docx`, so imported questions are skipped there.
- **G7:** `Multiple_Choice(MCQ)` is written by qbg-ingestion, and `Passage_SCQ` and the `===` numeric checks exist in the app. None of this affects this importer.

### R1: recovery-import guard (done)
- `scripts/data/import/lib/importer.mjs` refuses `ljkpcqllqdamdatesbfe` before any connection.
- The check covers both the `--confirm-project` value and the ref in `SUPABASE_URL`.
- The only override needs **both** `--override-protected-project=ljkpcqllqdamdatesbfe` **and** `RECOVERY_IMPORT_PROTECTED_OVERRIDE=ljkpcqllqdamdatesbfe`.
- Dry runs are unaffected.
- The new-bank importer's own guard is unchanged.

---

## 10. G2: child order for comprehension questions

**Current schema:** `qbg_questions` has `parent_question_id text` and no position column. `fetchChildQuestions()` returns children `order by question_id`. It is used for a parent's children and a child's siblings (`api/questions/[id]/route.ts:33-49`).

**Problem:** UUID order is effectively random, so a passage's Q2 can show before Q1. The position from the source had nowhere to live except `raw_data`, which the app never reads.

**Migration:** `scripts/sql/003_new_question_bank_support.sql` §1–2. It is idempotent and never drops or rewrites data.
- `child_order smallint`, nullable.
- A check: `child_order is null or (child_order >= 1 and parent_question_id is not null)`.
- `unique (parent_question_id, child_order) deferrable initially immediate`. NULLs never collide, and two positions can be swapped in one transaction.
- `admin_restore_question_version()` is recreated with one added line that restores `child_order` when the snapshot has it. The grants are unchanged.

**App change:**
- `src/lib/api/questions.ts` `fetchChildQuestions()`: `.order("child_order", { ascending: true, nullsFirst: false }).order("question_id")`.
- `src/types/index.ts`: `child_order?: number | null`.
- **Deploy order:** apply `003` **before** running this build against the project. Before `003`, the child query fails and a passage shows no children. The table is empty today, so nothing visible breaks in the meantime.
- `child_order` is deliberately **not** in the PATCH allowlist (`QUESTION_EDITABLE_FIELDS`). Only the importer sets it; reordering in the UI would be a later feature.

**Importer change:** writes the `child_order` column, includes it in the content hash, and reads it back. `--check-db` fails cleanly ("column child_order does not exist") if `003` isn't applied yet, before any write.

**Existing data:** none is affected. The column starts NULL, so standalone questions and any existing children keep their current behaviour (ordered by `question_id` as a tie-break).

**Reversible:** yes, with the manual rollback block at the end of `003`. Positions stored after that point would be lost, so roll back only before real comprehension data depends on it.

**Re-running `000`:** this puts back the pre-`003` restore function. `003_verify_new_question_bank_support.sql` detects that, and re-running `003` repairs it (the validator tests this sequence).
