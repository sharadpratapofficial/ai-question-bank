# Fallback: standing up a fresh Supabase project

Prepared because the original backend (`vmyuutaxstndvfdvndko.supabase.co`) is
currently unreachable (DNS does not resolve — checked both from a local
machine and directly from a browser network call against the live
`aiquestionbank.netlify.app` bundle, which still references this same URL).
This doc is the "own database" fallback in case the original project/backup
can't be recovered. **Don't run any of this until that's confirmed dead** —
if the original data comes back, none of this is needed.

## 0. The one real gap: `qbg_questions` itself has no CREATE TABLE anywhere

Every file in `scripts/sql/` is an incremental migration — `ALTER TABLE
public.qbg_questions ADD COLUMN ...`, or `CREATE TABLE IF NOT EXISTS` for
some *other* table that references `qbg_questions(question_id)`. The
foundational table (the one holding the ~14,944 questions) was evidently
created by hand in the Supabase dashboard, or its own migration was lost —
either way, **it is not in this repo**.

What follows in §2 is a **best-effort reconstruction**, built from:
- `src/types/index.ts`'s `Question` interface, which is explicitly commented
  `// Updated to match actual Supabase schema (2026-02-15)` — the closest
  thing to ground truth this repo has.
- Every `ALTER TABLE public.qbg_questions ADD COLUMN ...` across the other
  migration files (which tells us columns added *after* the original create).
- The sibling `qbg_question_pool` table (fully specified in
  `create_qbg_question_pool.sql`), used as a naming/typing reference since
  it's a parallel dataset built by the same team.

Treat §2 as a starting point to adjust once real data is in hand (e.g. once
you have `Chem_Question_Bank.xlsx` rows to import, you'll see exactly which
columns actually need to exist and what NULL-ability they need).

## 1. Apply order for the tracked migrations

Supabase SQL Editor, run in this order (each file's own header notes any
sub-step ordering, called out below):

1. `create_user_profiles_table.sql` — base RBAC table + `user_role` enum.
   Everything else's `references auth.users` / `user_profiles` assumes this
   exists first.
2. **(after §2's reconstructed `qbg_questions` table is created)**
   `add_question_status_and_history.sql` — run the commented-out
   `ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'qc_reviewer';` on its
   own first (enum additions can't run inside the same transaction as their
   first use), *then* the rest of the file.
3. `add_qbg_video_roles.sql`, `add_qbg_video_combined_role.sql`,
   `add_qwv_role.sql` — more `user_role` enum values, same one-statement-alone
   rule applies to each.
4. `add_admin_create_user_function.sql`, `add_admin_restore_question_version.sql`
5. `create_test_history_tables.sql` — Test Builder history (`qbg_batches`,
   `qbg_generated_tests`).
6. `create_qbg_question_pool.sql`, `create_qbg_pool_filters_fn.sql`,
   `add_pool_solution_flags.sql`
7. `create_ai_reports_table.sql`, then `allow_repeat_check_ai_reports.sql`,
   `allow_translate_ai_reports.sql` (both just widen a CHECK constraint —
   order between them doesn't matter, both after the create).
8. `create_question_translations_table.sql`, then
   `backfill_question_translations.sql` (explicitly documented as
   "run once, after create"), then `fix_question_translations_rls.sql`.
9. `add_pdf_extraction_reports.sql`, then
   `add_document_type_to_extraction_reports.sql`.
10. `create_question_video_jobs_table.sql`
11. `add_agentic_qc_jobs.sql`
12. Storage buckets — `add_ai_video_artifacts_bucket.sql`,
    `add_question_video_artifacts_bucket.sql`,
    `add_source_docx_and_docx_media_bucket.sql` (any order, independent).

## 2. Reconstructed `qbg_questions` (best-effort — verify before trusting)

```sql
CREATE TABLE IF NOT EXISTS public.qbg_questions (
    question_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qbg_id               text UNIQUE,              -- external QBG system id
    question_text        text NOT NULL,             -- HTML, may contain MathML/<img>
    options              jsonb NOT NULL DEFAULT '[]'::jsonb, -- QuestionOption[]: {text, isCorrect}
    answer_key           jsonb,                    -- number | number[] (mixed: [1] SCQ, [1,3] MCQ, 243 Integer)
    solution_text        text,                     -- HTML, may contain MathML
    question_type        text,                     -- Single_Choice(SCQ) / Multi_Choice(MCQ) / Numerical / ...
    subject              text,
    chapter              text,
    topic                text,
    subtopic             text,
    source               text,
    difficutly_level     text,                     -- NB: typo preserved verbatim from the real column name
    parent_question_id   uuid REFERENCES public.qbg_questions(question_id) ON DELETE SET NULL,
    raw_data             jsonb,                    -- RawQuestionData[] — original QBG payload, source of truth
                                                    -- for exam/class_level/subtopic before the backfill migration
    exam                 text[],                    -- e.g. ["JEE Mains", "NEET"] — added by migrate-extract-raw-data.mjs
    class_level          text,                     -- "11" / "12" — added by migrate-extract-raw-data.mjs
    source_docx          jsonb,                    -- added by add_source_docx_and_docx_media_bucket.sql
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
    -- status / created_by / last_modified_by / last_modified_at are added
    -- separately by add_question_status_and_history.sql — don't add them
    -- here, let that migration do it (it also backfills + indexes them).
);

CREATE INDEX IF NOT EXISTS idx_qbg_questions_subject_chapter_topic
    ON public.qbg_questions (subject, chapter, topic);
CREATE INDEX IF NOT EXISTS idx_qbg_questions_qbg_id ON public.qbg_questions (qbg_id);
CREATE INDEX IF NOT EXISTS idx_qbg_questions_source ON public.qbg_questions (source);
CREATE INDEX IF NOT EXISTS idx_qbg_questions_difficulty ON public.qbg_questions (difficutly_level);

ALTER TABLE public.qbg_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY qbg_questions_select ON public.qbg_questions FOR SELECT USING (true);
CREATE POLICY qbg_questions_insert ON public.qbg_questions FOR INSERT WITH CHECK (true);
CREATE POLICY qbg_questions_update ON public.qbg_questions FOR UPDATE USING (true) WITH CHECK (true);
GRANT ALL ON public.qbg_questions TO anon, authenticated, service_role;
```

Uncertain points to sanity-check once you're actually seeding data:
- Whether `answer_key` is really `jsonb` in the live DB, or a Postgres
  array type — the TS type's `number | number[]` mixed shape strongly
  suggests JSONB (a real Postgres array can't mix scalar and array), but
  this is inferred, not confirmed.
- `question_type` / `difficutly_level` might be Postgres ENUMs rather than
  plain `text` in the real schema — the migrations never touch them, so
  there's no evidence either way. Plain `text` is the safe default (never
  rejects a value the app knows about) but loses the DB-level guarantee.
- Whether `options` is stored as `jsonb` (array of `{text, isCorrect}`) or a
  parallel-array design — `jsonb` matches `QuestionOption[]` directly.

## 3. Reseeding chemistry data once the schema exists

`Chem_Question_Bank.xlsx` (already built from `AutoCuration_Lovee.xlsx` +
`Important_IDs_REplica.xlsx`, 4,831 chemistry questions) maps to
`qbg_questions` roughly as:

| ChemBank column | qbg_questions column |
|---|---|
| qbg_id | qbg_id |
| chapter / topic / subtopic | chapter / topic / subtopic |
| class | class_level |
| difficulty_level | difficutly_level |
| question_type | question_type |
| source | source |
| answer | answer_key (needs reshaping: "2,4" style strings -> jsonb array) |
| option_text | options (needs reshaping: "A~B~C~D" style strings -> jsonb array of {text, isCorrect}) |
| question_file_link / solution_file_link | not native columns — either stash in raw_data, or add two text columns if you want them queryable |

`subject` isn't a column in ChemBank since it's 100% Chemistry already —
set it as a constant on insert.

This reshaping (answer_key, options) is real work, not a straight column
copy — flag if/when you want me to write the actual import script once a
Supabase project exists to point it at.
