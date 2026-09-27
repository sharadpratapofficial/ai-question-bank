# Fresh Supabase project: setup runbook

**Status: READY WITH CHANGES.** The changes are made locally (uncommitted) and validated against a local PostgreSQL (PGlite). They have **not** been run against the new project. Every step below that touches the project waits for your approval.

Files:
- `scripts/sql/000_rebuild_schema.sql`: the one-pass bootstrap (schema, triggers, RLS, storage)
- `scripts/sql/002_verify_bootstrap.sql`: read-only post-run check
- `scripts/sql/001_post_import_backfills.sql`: only after a real data import
- `scripts/sql/validate/`: local validator (46 checks, including `003`)

---

## 1. Initialization order

| Step | Where | Action | Undo |
|---|---|---|---|
| **0** | Dashboard → Authentication → Sign In / Providers | **Turn OFF "Allow new users to sign up"**. Users are created by an admin (`/admin/users`) or come through Google. Leave Email enabled so password sign-in works | toggle back |
| **1** | Dashboard → SQL Editor | Paste and run **`scripts/sql/000_rebuild_schema.sql`** (whole file, one run). Creates extensions, enums, 15 tables, indexes, triggers, the auth → profile trigger, RLS, grants, 3 private buckets and storage policies. Idempotent: safe to re-run | new project: delete and recreate it |
| **2** | SQL Editor | Run **`scripts/sql/002_verify_bootstrap.sql`**. Every row must say **PASS** | read-only |
| **2b** | SQL Editor *(separately approved; forward migration for the new question bank)* | Run **`scripts/sql/003_new_question_bank_support.sql`** (adds `qbg_questions.child_order` and the private `question-media` bucket), then **`scripts/sql/003_verify_new_question_bank_support.sql`**: every row must say **PASS**. If `000` is ever re-run, re-run `003` after it | manual rollback block at the end of `003` |
| **3** | Dashboard → Authentication → URL Configuration | Site URL = your app origin. Redirect URLs: `http://localhost:5001/auth/callback`, plus the production origin's `/auth/callback` | edit |
| **4** | Dashboard → Authentication → Providers → Google *(only if Google sign-in is used)* | Enable Google with an OAuth client from Google Cloud Console. Its authorized redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`. Set `QBG_ALLOWED_GOOGLE_EMAILS` in the app env | disable provider |
| **5** | `.env.local` (local, never committed) | Already present: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (a publishable key, accepted), `SUPABASE_SERVICE_ROLE_KEY` (a secret key, accepted). Optional rename: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (see §6) | — |
| **6** | Dashboard → Authentication → Users → *Add user* | Create **one** test account (email + password, auto-confirm). The trigger gives it the no-access role `custom` | delete user |
| **7** | SQL Editor | Promote it to admin: `update public.user_profiles set role = 'admin' where lower(email) = lower('<that email>');` (the only manual SQL write) | set role back |
| **8** | App (`npm run dev`, sign in with that **real** account, not the dev bypass) | Smoke test: `/admin/users` lists the user; create a second user with role `viewer` from the UI; add **one** test question at `/questions` → *Add*; edit it; open its history; change its status | delete the test question in the Table Editor |
| **9** | SQL Editor | Confirm the test question has an edit-history row with your user as editor: `select change_type, editor_email from question_edit_history order by created_at desc limit 5;` | read-only |
| **10** | later, separately approved | New question-bank import with `scripts/newbank/import-questions.mjs` (dry runs and a trial first; see `docs/NEW_QUESTION_BANK_FORMAT.md`). The historical recovery importer (`scripts/data/import/`) **refuses this project** | — |

**First action:** step 0 (a Dashboard toggle), then step 1: run `scripts/sql/000_rebuild_schema.sql` in the SQL Editor.

---

## 2. Tables created (15, all RLS-enabled)

| Table | Purpose | Key | Access |
|---|---|---|---|
| `user_profiles` | one row per auth user: `role` (enum), `extra_permissions text[]`, email, display name | `user_id` → `auth.users` (cascade) | self read; admin read/update (role, extra_permissions, display_name only) |
| `qbg_questions` | the question bank (app contract, incl. `difficutly_level`) | `question_id uuid` | read: view/generate/entry/edit/upload permissions. Insert: entry/upload. Update: entry/edit/QC permissions. **No delete** |
| `question_edit_history` | full snapshot per insert/update (trigger) | `id` → question (cascade) | read: view_questions / restore. Written only by the trigger |
| `question_status_transitions` | QC status log | `id` → question (cascade) | read: view_questions. Insert: QC permissions, **as yourself only** |
| `question_translations` | per-question translations, one default per language | `id` → question (cascade) | read: view/AI; insert: AI; update/delete: entry/edit/AI |
| `pdf_extraction_reports` | PDF/DOCX extraction jobs | `id` → user (set null) | owner, or admin/manager |
| `ai_reports` | AI tool history (10 report types) | `id` → user (cascade) | owner only |
| `question_video_jobs` | Question-wise video jobs | `id` → user (set null) | owner only; create needs use_question_wise_videos |
| `qbg_batches`, `qbg_generated_tests`, `qbg_generated_test_questions` | test builder history | identity / uuid | **server only** |
| `agentic_qc_jobs`, `qbg_tasks` | background job stores | uuid / text | **server only** |
| `qbg_question_pool` | QBG pipeline reference pool (separate from qbg_questions) | `unique_id` | **server only** |
| `chapter_merge_log` | admin chapter-merge audit | identity | **server only** |

"Server only" means that only the secret-key client in gated API routes can reach it. `authenticated` and `anon` have no grants and no policies. Column types, defaults, nullability, FKs and indexes are documented table by table in the SQL file and in `docs/SCHEMA_REBUILD_AUDIT.md` §3. The validator checks the `qbg_questions` column contract exactly.

---

## 3. Access model (RLS)

- **anon:**
  - no table grants, no function execute rights, and no policy in `public` or `storage`
  - the publishable key alone can read or write nothing
  - validated: 15 tables denied, 0 executable functions
- **service_role (secret key):**
  - used only via `src/lib/supabase/admin.ts`, from API routes after `checkPermission()`, and from background jobs
  - bypasses RLS by design; the route is the gate
  - six read routes that had **no** gate now have one: `GET /api/questions`, `/api/questions/[id]`, `/api/metadata`, `/api/batches`, `/api/tests/history`, `/api/tests/history/[id]`
  - `/api/debug` is now admin-only
- **authenticated:**
  - used where the database must know the user, via narrow policies built on `public.has_any_permission()`
  - that function mirrors `src/lib/auth/permissions.ts` (role grants + admin-granted `extra_permissions`); the validator fails if the two ever differ

Roles, as the app defines them:
- `admin`: everything
- `manager`: content, tests, AI tools, analytics; no user management, no QC verify
- `qc_reviewer`: view, edit metadata, verify QC1/QC2/UAT, reject
- `data_entry`: view, create, submit
- `ai_user`: view + AI/QBG/video tools
- `viewer`: view only
- `qbg_user`, `video_user`, `qbg_video_user`, `qwv_user`: single tools
- `custom`: nothing (the default for new accounts; see §5)

Edit history attribution: session writes record `auth.uid()`. Server-key writes record the `created_by` / `last_modified_by` the route sets **in that write**; a stale value is never attributed.

---

## 4. Storage

| Bucket | Public | Path | Policy |
|---|---|---|---|
| `question-video-artifacts` | **private** | `<user_id>/<job_id>/…` | a user reads/writes only their own `<user_id>/` folder |
| `ai-video-artifacts` | **private** | `<user_id>/<job_id>/…` | own folder only |
| `docx-media` | **private** | `<extractionId>/<scope>/<sha>.<ext>` | read: upload_pdf / generate_tests / view_questions; write: upload_pdf. No delete |
| `question-media` *(003)* | **private**, 10 MB, png/jpeg/gif/webp | `newbank/<question_id>/<filename>` | read: the `qbg_questions` SELECT permissions; upload: manual_question_entry / upload_pdf / edit_metadata, only to an existing question's folder; no update or delete (immutable) |

- **Downloads** use short-lived signed URLs created server-side.
- **Question diagrams** extracted from PDFs are embedded in `question_text` as data URLs (existing behaviour).
- **New-bank question images** belong in `question-media`. Question HTML stores only the storage path, behind an app route (`/api/question-media/<path>`, not built yet) that checks the session and redirects to a short-lived signed URL.
- **No bucket size limit is set:** the project's global limit applies (50 MB on the Free plan). Video ZIPs may exceed it.

---

## 5. Auth review

- **Users:** Supabase Auth (`auth.users`). Each gets a `public.user_profiles` row through the `trg_on_auth_user_created` trigger. The profile table is **required**: `serverAuth.ts`, the callback and every policy read `role` / `extra_permissions` from it.
- **New accounts start with no access** (`custom` role). This deliberately differs from the old migrations, which gave `viewer`. `viewer` can read the whole question bank, and anyone able to create an account (the landing page's sign-up form, or any Google account before the allow-list check) would have had it. An admin assigns the real role. To revert, change `public.default_user_role()` to return `'viewer'`.
- **User creation:**
  - `/api/admin/users` now uses Supabase Auth's admin API (`auth.admin.createUser`) with the secret key
  - the old SQL function that wrote `auth.users` / `auth.identities` directly is removed (it breaks when Supabase changes its auth schema)
- **Google sign-in:**
  - `src/app/auth/callback/route.ts` exchanges the code, then **signs out** any Google email not in `QBG_ALLOWED_GOOGLE_EMAILS`
  - a rejected account still gets an `auth.users` row (with no access); delete such rows periodically if that matters
  - the callback no longer sets the dev cookie
- **Dev login bypass** (`qbg_dev_auth` cookie):
  - honoured only when `NODE_ENV !== "production"`; verified in the previous phase, a forged cookie gets 403 on a production build
  - it is **not** a Supabase session, so features that act as the user (translations panel, extraction reports, video jobs, AI report history, question create/edit, status changes) are denied by RLS in dev-bypass mode
  - for local testing against the new project, **sign in with a real test user** (step 6)
- **Production readiness:** the auth code is appropriate for production once step 0 (sign-ups off) is done, with Google configured if used. There is no remaining path from the dev cookie, the publishable key or self sign-up to question data.

---

## 6. Environment variables

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | required |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server | preferred name for the `sb_publishable_…` key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | legacy name, still accepted (`src/lib/supabase/env.ts`). Your current `.env.local` uses it with an `sb_publishable_…` value, which is technically fine: the publishable key replaces the anon key as the client `apikey` |
| `SUPABASE_SECRET_KEY` | **server only** | preferred name for `sb_secret_…` |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | legacy name, still accepted (your current `.env.local`) |

**Verified on the production build** (`npm run build`):
- the secret key's value appears nowhere in `.next/`: 0 files, server output included, because it is read at runtime
- the secret-key module and the secret variable names appear in none of the browser bundle's 55 client files
- the publishable key appears in the browser bundle, as expected

`SUPABASE_URL` / `SUPABASE_KEY` in `.env.local` are used only by offline scripts; `SUPABASE_KEY` is no longer read by anything.

---

## 7. `difficutly_level` (historical misspelling)

**Options:**
- **A. Preserve (chosen for the bootstrap).** The app reads, filters and writes `difficutly_level` in 10+ places. The QBG export, the restore function and the recovery importer use it too. A rename now would break all of them at once, for no functional gain.
- **B. Rename in app and DB together.** A single coordinated change across code, SQL, recovery scripts and any imported data. Highest risk; no benefit until the rest is stable.
- **C. Support both, later.** This is the safest path to a clean name. Steps, each separately deployable and reversible:
  1. add `difficulty_level text generated always as (difficutly_level) stored` (read-only alias)
  2. move app **reads** to `difficulty_level`
  3. swap: make `difficulty_level` the real column and `difficutly_level` a view/generated alias, then move **writes**
  4. drop the alias once nothing references it

**Recommendation:** A now, C after the real data import is stable. No other misspelled column name was found among the columns the app queries.

---

## 8. What was validated, and what was not

**Validated locally:**
- `node scripts/sql/validate/validate_schema.mjs`: **39/39**. It covers:
  - fresh apply, re-apply, and apply over the old enum
  - anon denied everywhere
  - each role's allowed and denied operations on every user-facing table and bucket
  - the SQL role map equal to `permissions.ts`
  - edit-history attribution, the restore RPC, backfills
  - `002_verify_bootstrap.sql` all PASS
- `npx tsc --noEmit`: pass
- `npm run build`: pass, including the secret-key bundle check

**Not validated** (needs the real project, after your approval):
- the Supabase REST (PostgREST), Storage and Auth services themselves. The local run uses a minimal `auth`/`storage` stand-in, not Supabase's real schemas
- Google OAuth
- `auth.admin.createUser` against the live Auth service
- end-to-end app flows against the new project
