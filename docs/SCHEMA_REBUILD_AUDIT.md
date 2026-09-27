# Supabase schema rebuild: audit and evidence

The original Supabase project (`vmyuutaxstndvfdvndko`) no longer resolves in DNS. This document records how the replacement schema in
[`scripts/sql/000_rebuild_schema.sql`](../scripts/sql/000_rebuild_schema.sql) was reconstructed, what each decision rests on, and what
is still unknown. **Nothing here has been run against any remote database.**

Labels used throughout:

| Label | Meaning |
|---|---|
| **VERIFIED** | Stated by a SQL migration in `scripts/sql/`, or unambiguously required by application code |
| **INFERRED** | Chosen for compatibility with the application; not proven to match the original database |
| **UNKNOWN** | The original value cannot be recovered from this repository |

> **Phase 2 update (fresh-project bootstrap).** Several statements below describe the first draft and are now superseded. The current setup and runbook is [SUPABASE_SETUP.md](SUPABASE_SETUP.md). Changes:
> - **No anonymous access anywhere.** The permissive anon policies (§3 "RLS", §7 items 1–4) are replaced by: server routes using the secret key after their permission check, and narrow, permission-based `authenticated` policies via `has_any_permission()`, which mirrors `permissions.ts` and is checked for drift by the validator.
> - **Storage:** the video buckets are per-user folders and docx-media is permission-based (§7 item 4 resolved).
> - **`admin_create_user_with_role` is removed;** `/api/admin/users` uses `auth.admin.createUser` (§7 item 5 resolved).
> - **New accounts default to the no-access role `custom`,** not `viewer`.
> - **Six read routes gained permission gates;** `/api/debug` is admin-only.
> - **Edit-history attribution** falls back to the row's audit columns for secret-key writes.
> - **Key names:** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` are accepted, and the legacy names still work.
>
> The table and column reconstruction in §2–§3 is unchanged.

Sources deliberately **not** used: `.next/`, `.next-dev/`, any compiled output, and the dead Supabase project.

---

## 1. Corrections to the implementation brief

The audit found several places where the brief did not match the repository:

| Brief said | Repository shows |
|---|---|
| 25 SQL migration files | **24** files (the brief's own list has 24) |
| `ON DELETE SETNULL` typo in a migration | **Not present** in any `.sql` file (checked by the validator). Every `ON DELETE` clause in the new file is valid and listed in §6 |
| `scripts/reseed_chem_question_bank.mjs` and `Chem_Question_Bank.xlsx` exist | **Neither is in the repository.** Only `python/qbg_modification/tagging_data/qbg_tagging_table.csv` exists |
| Google callback is `src/app/api/auth/callback/route.ts` | It is [`src/app/auth/callback/route.ts`](../src/app/auth/callback/route.ts) |
| Dev login bypass is gated behind `NODE_ENV !== "production"` | Only the **login form** was gated. `serverAuth.ts`, `proxy.ts`, `src/lib/ai/verification.ts` and 19 API routes honoured a forged `qbg_dev_auth=1` cookie in production, granting **admin**. Fixed (§4) |
| `ai_reports` only lacks `qbg_ingestion` | It also lacks `video`, `qbg_modification` and `qbg_tagging`, all written by the app |
| Role enum: 9 values | App uses **11**: `qc_reviewer` (documented as a manual step that was never in a file) and `custom` are missing from every enum migration |
| Tables to rebuild are the ones with migrations | Two tables the app uses have **no migration at all**: `qbg_tasks` and `chapter_merge_log`. Two columns are also missing: `qbg_generated_tests.test_name` and `user_profiles.extra_permissions` |

---

## 2. Evidence table

### Tables

| Table | Evidence | Confidence | Replacement decision |
|---|---|---|---|
| `qbg_questions` | No base migration. Shape reconstructed from `src/lib/api/questions.ts`, `src/types/index.ts`, all 7 writers (upload/save, extract save, qbg-ingestion, qbg-modification, tests/finalize, questions POST, testAiGeneration), `add_admin_restore_question_version.sql`, `add_question_status_and_history.sql`, `add_source_docx_and_docx_media_bucket.sql`, `scripts/migrate-extract-raw-data.mjs` | Mixed, see §3 | Rebuilt per §3 |
| `user_profiles` | `create_user_profiles_table.sql` | VERIFIED | Kept. Admin email seed **removed** |
| `user_profiles.extra_permissions` | Read in `serverAuth.ts` and the auth callback; written by `/api/admin/users/[id]/permissions` as a string array. No migration | INFERRED | `text[] not null default '{}'` |
| `question_status_transitions` | `add_question_status_and_history.sql` | VERIFIED | Unchanged |
| `question_edit_history` + snapshot trigger | `add_question_status_and_history.sql` | VERIFIED | Unchanged |
| `question_translations` | `create_question_translations_table.sql` + `fix_question_translations_rls.sql` (final RLS) | VERIFIED | Unchanged; converges old policy names on re-run |
| `qbg_batches`, `qbg_generated_tests`, `qbg_generated_test_questions` | `create_test_history_tables.sql`, `language` from translations migration | VERIFIED | Kept. `generated_test_questions.question_id` stays **text** with no FK. Two redundant indexes dropped (§5) |
| `qbg_generated_tests.test_name` | Inserted by `src/lib/api/testHistory.ts`; no migration | INFERRED | `text` nullable. Without it every test finalisation fails |
| `pdf_extraction_reports` | `add_pdf_extraction_reports.sql` + `add_document_type_to_extraction_reports.sql`. All columns used by the 5 extraction routes match | VERIFIED | Unchanged. Bare `CREATE TYPE` guarded for idempotency |
| `ai_reports` | `create_ai_reports_table.sql` + `allow_*` | VERIFIED table; CHECK widened | See §4 |
| `agentic_qc_jobs` | `add_agentic_qc_jobs.sql`; `jobStore.ts` always supplies a real auth user id | VERIFIED | Unchanged |
| `qbg_tasks` | `src/lib/api/qbgTaskStore.ts` (`QbgTaskRow`, queries); no migration | INFERRED | `id text` (ids are 18-char hex *or* UUID), `user_id text` (stores literal `'dev'`), permissive RLS as the store's header comment describes |
| `question_video_jobs` | `create_question_video_jobs_table.sql`; columns match all 5 routes | VERIFIED | Unchanged. Bare `CREATE TYPE` guarded |
| `qbg_question_pool` | `create_qbg_question_pool.sql` + `add_pool_solution_flags.sql`; matches `import_pool.py` and `POOL_SELECT_COLUMNS` | VERIFIED | Unchanged. **Separate from `qbg_questions`** |
| `chapter_merge_log` | Insert in `src/app/api/admin/chapters/route.ts`; no migration | INFERRED | Append-only log; insert-only policy |

### Enums, functions, storage

| Object | Evidence | Confidence | Decision |
|---|---|---|---|
| `user_role` | 5 base values + `qwv_user`, `qbg_user`, `video_user`, `qbg_video_user` from migrations; `qc_reviewer` from a comment; `custom` from `permissions.ts` `ALL_ROLES` | VERIFIED (9), INFERRED (`qc_reviewer`, `custom`) | 11 values; `ADD VALUE IF NOT EXISTS` upgrades an existing enum |
| `question_status`, `question_video_job_status`, `extraction_report_status` | Their migrations | VERIFIED | Unchanged, creation made idempotent |
| `current_user_role()`, `handle_new_auth_user()` + `auth.users` trigger | `create_user_profiles_table.sql` | VERIFIED | Unchanged |
| `fn_capture_question_snapshot()` | `add_question_status_and_history.sql` | VERIFIED | Unchanged |
| `manage_translation_default()` | translations migration | VERIFIED | Unchanged |
| `qbg_pool_filter_options()` | `create_qbg_pool_filters_fn.sql` | VERIFIED | Unchanged |
| `admin_restore_question_version()` | Its migration | VERIFIED | `::uuid` cast on `parent_question_id` removed (column is text) |
| `admin_create_user_with_role()` | Its migration; called by `/api/admin/users` POST | VERIFIED | Kept, flagged (§7) |
| Buckets `question-video-artifacts`, `ai-video-artifacts`, `docx-media` (private) + 12 bucket-scoped policies | 3 bucket migrations | VERIFIED | Unchanged |

---

## 3. `qbg_questions` field by field

| Column | Type | Null | Default | Label | Basis |
|---|---|---|---|---|---|
| `question_id` | uuid PK | no | `gen_random_uuid()` | type **VERIFIED**, default INFERRED | FK targets in two migrations; every writer supplies `crypto.randomUUID()` |
| `qbg_id` | text | yes | none | **INFERRED**; historical type **UNKNOWN** | Current writers store the same UUID string as `question_id`; QBG external ids (pool `qbg_id`, e.g. `4ii5mxgv84bkvg16rv8akjy1j`) are not UUIDs. No UNIQUE: never asserted anywhere |
| `question_text` | text | yes | none | VERIFIED type | restore fn `->>`, `ilike` search |
| `options` | jsonb | yes | `'[]'` | VERIFIED type, INFERRED default | restore fn assigns `snapshot->'options'` |
| `answer_key` | jsonb | yes | none | VERIFIED | restore fn assigns `snapshot->'answer_key'`; writers send number, number[], string, null |
| `solution_text`, `question_type`, `subject`, `chapter`, `topic`, `source` | text | yes | none | VERIFIED type | restore fn `->>` |
| `subtopic`, `class_level` | text | yes | none | VERIFIED | restore fn; migrate-extract script |
| `difficutly_level` | text | yes | **none** | VERIFIED (misspelling is the real name) | No default on purpose: writers supply `'Medium'`; a DB default would invent difficulty for imports |
| `exam` | text[] | yes | none | VERIFIED | migrate script header, restore fn `ARRAY(...)`, `.overlaps()` filter |
| `parent_question_id` | text | yes | none | **INFERRED**; historical type **UNKNOWN** | Restore fn cast `::uuid` (hints uuid), but the app types it `string`, `/api/questions` POST accepts any string, and QBG parent ids are non-UUID. **No FK** until imported data proves every value is a `question_id` |
| `raw_data` | jsonb | yes | none | VERIFIED | restore fn; status backfill reads `raw_data->0` |
| `source_docx` | jsonb | yes | none | VERIFIED | its migration |
| `status` | question_status | **no** | `'verification_pending'` | VERIFIED | status migration |
| `created_by`, `last_modified_by` | uuid → `auth.users` ON DELETE SET NULL | yes | none | VERIFIED | status migration |
| `last_modified_at` | timestamptz | **no** | `now()` | VERIFIED | status migration |

**Nullability.** Only the three VERIFIED NOT NULL columns are constrained. Original nullability of the rest is **UNKNOWN**, and a
metadata-only import (no question body available) must be able to leave body columns NULL.

**Not added:** `created_at` (not in the app contract; the history table records creation time), `unique_id` (see §4, chapters route).

**Indexes (10):** PK; `status` (original name kept); `(subject, chapter, topic)`; `chapter`; `question_type`; `difficutly_level`;
`source`; `class_level`; partial `parent_question_id`; GIN `exam`; partial `(question_id) where source_docx is not null`.
Not indexed, with reasons: `subtopic` (always filtered with `topic`), `qbg_id` (no query filters on it), `question_text`
(`ilike '%…%'` needs `pg_trgm`; add if search is slow).

**RLS (INFERRED; historical policies UNKNOWN):** anon + authenticated may SELECT/INSERT/UPDATE, because the app writes through
session-less anon clients (`questions.ts`, qbg-ingestion, qbg-modification, tests/finalize, admin/chapters). No DELETE: nothing in
`src/` deletes questions.

---

## 4. Compatibility fixes

### In the SQL

| # | Problem | Fix |
|---|---|---|
| 1 | `ai_reports` CHECK allowed 6 types; app writes 10 (`video`, `qbg_ingestion`, `qbg_modification`, `qbg_tagging` were rejected, so those history rows were silently lost) | CHECK widened to exactly `VALID_REPORT_TYPES` in `src/app/api/ai-tools/reports/route.ts`. Renaming types in code was rejected: the reports API already accepts all 10, the video artifact route requires `report_type = 'video'`, and history views filter by the qbg_* types |
| 2 | `user_role` lacked `qc_reviewer` and `custom` | Added |
| 3 | `qbg_tasks`, `chapter_merge_log` tables missing | Created (INFERRED) |
| 4 | `qbg_generated_tests.test_name`, `user_profiles.extra_permissions` missing | Added (INFERRED) |
| 5 | Restore fn cast `parent_question_id::uuid` | Assign as text |
| 6 | Bare `CREATE TYPE` in two migrations failed on re-run | Guarded |
| 7 | Status backfill overwrote reviewer decisions on re-run; `::int` cast could abort | Moved to `001_post_import_backfills.sql`, only promotes rows still at default whose raw value is `'1'` |
| 8 | Translation backfill duplicated rows on re-run; bad `translatedAt` aborted it | `NOT EXISTS` guard + guarded timestamp cast |
| 9 | Hard-coded admin email seed | Removed; promote the first admin by hand |
| 10 | Test-history tables had RLS disabled | RLS enabled with allow-all for anon/authenticated (same effective access, now explicit) |
| 11 | Admin functions executable by `anon` via Supabase default privileges | Explicit `revoke … from anon` |
| 12 | No explicit grants (relied on Supabase defaults for new tables) | Explicit per-table grants |

### In application code

| # | File(s) | Problem | Fix |
|---|---|---|---|
| A | new `src/lib/auth/devAuth.ts`; `src/lib/auth/serverAuth.ts`, `src/proxy.ts`, `src/lib/ai/verification.ts`, 19 API routes | Forged `qbg_dev_auth=1` = **admin in production** | Every server-side read goes through `hasDevAuthCookie()`, which returns false when `NODE_ENV === "production"` |
| B | `src/app/auth/callback/route.ts` | Set `qbg_dev_auth=1` after a real Google login | Now **clears** the dev cookie after `exchangeCodeForSession` succeeds |
| C | `src/app/api/admin/users/route.ts`, `…/[id]/role/route.ts`, `…/[id]/permissions/route.ts` | Read and updated `user_profiles` through a session-less anon client. Under the migration's own RLS, anon sees no rows and cannot update, so user management could not work. Opening anon UPDATE instead would let anyone make themselves admin | Routes use the caller's cookie session; new `user_profiles_update_admin` policy (admin-only) + column grant `(role, extra_permissions, display_name)` |
| D | `src/app/api/admin/chapters/route.ts` | `update(...).select("unique_id")` on `qbg_questions`, which has no `unique_id`, so chapter merges failed on that table | Selects each table's own key (`unique_id` for the pool, `question_id` for questions) |

Behaviour note for C: a dev-auth session has no Supabase user, so `/admin/users` lists nothing in dev-auth mode. Sign in as a real
admin to manage users.

The uncommitted change to `src/app/page.tsx` that was already in the working tree (stop setting the dev cookie on real sessions) was
left untouched.

---

## 5. Objects created by `000_rebuild_schema.sql`

- **Extensions:** `pgcrypto` (schema `extensions`)
- **Enums (4):** `user_role`, `question_status`, `question_video_job_status`, `extraction_report_status`
- **Tables (15):** `user_profiles`, `qbg_questions`, `question_status_transitions`, `question_edit_history`, `question_translations`,
  `qbg_batches`, `qbg_generated_tests`, `qbg_generated_test_questions`, `pdf_extraction_reports`, `ai_reports`, `agentic_qc_jobs`,
  `qbg_tasks`, `question_video_jobs`, `qbg_question_pool`, `chapter_merge_log`
- **Functions (10):** `user_profiles_set_updated_at`, `handle_new_auth_user`, `current_user_role`, `fn_capture_question_snapshot`,
  `manage_translation_default`, `fn_pdf_extraction_reports_touch_updated_at`, `fn_question_video_jobs_touch_updated_at`,
  `qbg_pool_filter_options`, `admin_restore_question_version`, `admin_create_user_with_role`
- **Triggers (6):** `trg_user_profiles_set_updated_at`, `trg_on_auth_user_created` (on `auth.users`), `trg_qbg_questions_snapshot`,
  `trg_manage_translation_default`, `trg_per_touch_updated_at`, `trg_qvj_touch_updated_at`
- **Indexes:** 60 in `public` including PKs/uniques (validator count). Removed as redundant vs. the originals:
  `idx_qbg_batches_name` (duplicates `UNIQUE(name)`), `idx_qbg_generated_test_questions_test_id` (leading column of
  `UNIQUE(generated_test_id, question_id)`)
- **Storage:** 3 private buckets, 12 policies on `storage.objects`
- **RLS:** enabled on all 15 tables; 41 policies in `public` (53 including storage)

---

## 6. Validation performed

All local. No remote database was contacted.

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `npm run build` | exit 0 (Next 16.1.6, Turbopack) |
| `npm run lint` | **fails before linting**: `next lint` was removed in Next 16 and the repo has no ESLint config. Pre-existing; not changed |
| `node scripts/sql/validate/validate_schema.mjs` (PGlite 0.5.8 = PostgreSQL 18.3 in-process, with `supabase_shim.sql`) | **43/43 checks passed** |
| `next start` (prod build, port 5055) + `curl` with forged `Cookie: qbg_dev_auth=1` | `/questions` → 307 to sign-in; `/api/admin/users` → 403; `/api/ai-tools/qbg-tasks` → 403 |
| `next dev` (port 5056) + `curl` with the same cookie | `/questions` → 200; `/api/admin/users` passes the permission gate (then fails reaching the dead Supabase host, as expected) |

Validator coverage: fresh apply, second apply (object counts identical), apply over the original 5-value `user_role`; no `SETNULL`;
no duplicate or prefix-redundant indexes; all 15 FK `ON DELETE` actions; RLS on every table; `qbg_questions` column types. Behaviour,
run as `anon`/`authenticated` with RLS active: ingestion inserts with all four `answer_key` shapes, metadata-only rows, every
`questions.ts` filter shape, child lookup by UUID and QBG-style parent ids, edit snapshots, status transitions with editor identity,
admin restore (and non-admin rejection), translation default flipping, test history with text ids, extraction report CHECKs and
`updated_at`, all 10 `ai_reports` types plus owner isolation, `qbg_tasks` with `'dev'`, QC job upsert, video job enum, pool
selection plus filter facets, chapter merge on both tables, profile RLS (no self-promotion, admin can update), admin user creation,
storage bucket scoping, FK cascades, and both backfills re-run idempotently.

**Not validated:** PostgREST request translation (the SQL mirrors the query shapes rather than running supabase-js);
`admin_create_user_with_role` against the **real** GoTrue `auth` schema (the shim models only the columns it writes); Supabase's
actual default privileges; storage behaviour through the Storage API.

To re-run: install `@electric-sql/pglite` outside the repo, set `PGLITE_DIR` to that folder, and run
`node scripts/sql/validate/validate_schema.mjs` (instructions in the script header).

---

## 7. Security hardening backlog (preserved, not fixed)

These reproduce existing behaviour so the app keeps working. Each is marked `[HARDEN]` in the SQL.

1. **`qbg_questions`**: anon can read, insert and update every question using the public anon key. Needs the app to write through
   authenticated sessions (or a server-only service-role client) first.
2. **`agentic_qc_jobs`, `qbg_tasks`, `question_video_jobs`, `pdf_extraction_reports`, `qbg_question_pool`**: allow-all
   policies; user scoping happens only in application code, so any anon-key holder can read other users' jobs.
3. **Question history, translations, test-history tables**: allow-all, including anon delete on translations.
4. **Storage**: bucket-only policies with no `TO` clause, so anon can read and write every object in all three buckets. Paths are not
   uniformly `<user_id>/…` (`docx-media` uses `<extractionId>/<scope>/<sha>.<ext>`; videos may use `anon/…`).
5. **`admin_create_user_with_role`**: writes `auth.users`/`auth.identities` directly. Supabase Auth owns those tables and changes them
   between versions. Replace with `supabase.auth.admin.createUser()` from the API route using a server-only
   `SUPABASE_SERVICE_ROLE_KEY`. Test the function against the new project before relying on it.
6. **Client-side dev-auth checks**: ~30 `document.cookie.includes("qbg_dev_auth=1")` checks in pages and components choose where API
   keys come from. They cannot grant server access any more (fix A), but they could be tidied to use `DEV_AUTH_ENABLED`.

---

## 8. Remaining blockers

1. **Question content is gone.** The ~28k-row `QBG_data.csv` export is not in the repository; the tagging CSV is taxonomy only. The
   replacement database starts empty. `Chem_Question_Bank.xlsx` and its reseed script mentioned in the brief are not in this
   repository either. Only authorised, licensed or public-domain content should be imported.
2. **UNKNOWN until the original data or an original schema dump turns up:** the historical types of `qbg_questions.qbg_id` and
   `parent_question_id`, original nullability and defaults of the body columns, whether `qbg_id` was unique, the original
   `qbg_questions` RLS policies and indexes, and the original `qbg_tasks` / `chapter_merge_log` definitions.
3. **Needs a real (new) Supabase project to confirm:** the migration runs in the SQL editor, the `auth.users` trigger is accepted,
   `admin_create_user_with_role` works against current GoTrue, and end-to-end app flows through PostgREST.
4. **First admin:** after the first real sign-up, run
   `update public.user_profiles set role = 'admin' where lower(email) = lower('<email>');`

## 9. Applying to a new project (when ready)

1. Create the project and put its URL and anon key in `.env.local`.
2. Run `000_rebuild_schema.sql` in the SQL editor.
3. Import data through a controlled script.
4. Run `001_post_import_backfills.sql`.
5. Promote the first admin (§8.4).
