-- =============================================================================
-- 000_rebuild_schema.sql
-- Replacement schema for a NEW Supabase project backing AI Question Bank.
-- =============================================================================
--
-- WHY THIS FILE EXISTS
--   The original Supabase project (vmyuutaxstndvfdvndko) no longer resolves.
--   The repository never contained a base `CREATE TABLE qbg_questions`; the 24
--   files in scripts/sql/ are incremental migrations that assume it exists.
--   This file consolidates those migrations and reconstructs the missing base
--   objects from the application's own code, so a fresh project can be brought
--   up in one pass.
--
-- THIS IS NOT THE HISTORICAL SCHEMA.
--   Every reconstructed object is labelled with one of:
--     VERIFIED  - stated by a SQL migration in scripts/sql/ or unambiguously
--                 required by application code
--     INFERRED  - chosen for compatibility with the application; not proven to
--                 match the original database
--     UNKNOWN   - the original value cannot be recovered from the repository
--   See docs/SCHEMA_REBUILD_AUDIT.md for the evidence behind each label.
--
-- SCOPE
--   Schema only. No users, no role seeds, no question data, no secrets.
--   Data backfills that only make sense after an import live in
--   001_post_import_backfills.sql.
--
-- PREREQUISITES
--   A Supabase project (provides the auth and storage schemas, auth.uid(), and
--   the anon / authenticated / service_role roles). Run as the `postgres` role,
--   e.g. from the SQL editor or `psql`. Review before running; nothing in the
--   repository executes this file.
--
-- IDEMPOTENCY
--   Safe to re-run: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--   DROP POLICY/TRIGGER IF EXISTS before CREATE, enum creation guarded by
--   DO blocks. Re-running does NOT alter the type of an existing column.
--   Nothing drops a table, column or row. The only DROP statements remove
--   policies, triggers and the obsolete admin_create_user_with_role function
--   before recreating the intended set.
--
-- ACCESS MODEL (section 15)
--   No anonymous access at all. Server routes use the secret key
--   (service_role) after their own permission check; signed-in users get only
--   narrow, permission-based policies where the app acts as the user.
--
-- RUN ORDER FOR A NEW PROJECT: see docs/SUPABASE_SETUP.md.
-- =============================================================================


-- =============================================================================
-- 1. EXTENSIONS
-- =============================================================================
-- gen_random_uuid() is core in PostgreSQL 13+. pgcrypto supplies crypt() /
-- gen_salt(), used only by admin_create_user_with_role (section 17). Supabase
-- installs it into the `extensions` schema already; this is a no-op there.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;


-- =============================================================================
-- 2. ENUMS
-- =============================================================================

-- user_role - VERIFIED values from create_user_profiles_table.sql,
-- add_question_status_and_history.sql (qc_reviewer, documented as a manual
-- step), add_qbg_video_roles.sql, add_qbg_video_combined_role.sql,
-- add_qwv_role.sql.
-- 'custom' - INFERRED: src/lib/auth/permissions.ts ALL_ROLES includes it and the
-- admin role route accepts any isValidRole() value, but no migration added it.
do $$
begin
    if not exists (
        select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typname = 'user_role' and n.nspname = 'public'
    ) then
        create type public.user_role as enum (
            'admin',
            'manager',
            'qc_reviewer',
            'data_entry',
            'ai_user',
            'qbg_user',
            'video_user',
            'qbg_video_user',
            'qwv_user',
            'custom',
            'viewer'
        );
    end if;
end $$;

-- On a database where user_role already exists with fewer values, bring it up
-- to date. None of these values is referenced later in this file, so this is
-- safe inside a single transaction (PG12+ restriction: a newly added value
-- cannot be *used* until the transaction commits).
alter type public.user_role add value if not exists 'qc_reviewer';
alter type public.user_role add value if not exists 'qbg_user';
alter type public.user_role add value if not exists 'video_user';
alter type public.user_role add value if not exists 'qbg_video_user';
alter type public.user_role add value if not exists 'qwv_user';
alter type public.user_role add value if not exists 'custom';

-- question_status - VERIFIED (add_question_status_and_history.sql).
do $$
begin
    if not exists (
        select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typname = 'question_status' and n.nspname = 'public'
    ) then
        create type public.question_status as enum (
            'verification_pending', 'verified', 'double_verified', 'uat_passed', 'rejected'
        );
    end if;
end $$;

-- question_video_job_status - VERIFIED (create_question_video_jobs_table.sql).
-- The original used a bare CREATE TYPE, which fails on re-run; guarded here.
do $$
begin
    if not exists (
        select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typname = 'question_video_job_status' and n.nspname = 'public'
    ) then
        create type public.question_video_job_status as enum (
            'queued', 'downloading', 'detecting', 'ready_for_review',
            'cropping', 'done', 'failed', 'discarded'
        );
    end if;
end $$;

-- extraction_report_status - VERIFIED (add_pdf_extraction_reports.sql).
-- Same bare-CREATE TYPE fix as above.
do $$
begin
    if not exists (
        select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typname = 'extraction_report_status' and n.nspname = 'public'
    ) then
        create type public.extraction_report_status as enum (
            'queued', 'processing', 'completed', 'failed', 'saved', 'discarded'
        );
    end if;
end $$;


-- =============================================================================
-- 3. USER PROFILES / RBAC
-- =============================================================================
-- VERIFIED: create_user_profiles_table.sql - with ONE deliberate change:
-- new accounts start as 'custom' (no permissions) instead of 'viewer'.
-- 'viewer' grants view_questions, so with the original default anyone who can
-- create an account (email sign-up on the landing page, or any Google account
-- before the allow-list check signs it out) could read the whole question bank
-- through the API. An admin assigns the real role in /admin/users.
-- To restore the original behaviour, change the body of
-- public.default_user_role() below to return 'viewer'.

-- plpgsql so the enum literal is resolved at insert time, not at DDL time
-- (a column DEFAULT 'custom' fails when 'custom' was ADDed in the same transaction).
create or replace function public.default_user_role()
returns public.user_role
language plpgsql
stable
as $$
begin
    return 'custom'::public.user_role;
end;
$$;

create table if not exists public.user_profiles (
    user_id      uuid primary key references auth.users(id) on delete cascade,
    email        text,
    role         public.user_role not null default public.default_user_role(),
    display_name text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- extra_permissions - INFERRED. Read by src/lib/auth/serverAuth.ts and the
-- auth callback, written by /api/admin/users/[id]/permissions as a string
-- array of Permission names. No migration created it. text[] round-trips as a
-- JS string[] through PostgREST, which is what sanitizePermissions() expects.
alter table public.user_profiles
    add column if not exists extra_permissions text[] not null default '{}';

create index if not exists idx_user_profiles_role  on public.user_profiles(role);
create index if not exists idx_user_profiles_email on public.user_profiles(lower(email));

create or replace function public.user_profiles_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_user_profiles_set_updated_at on public.user_profiles;
create trigger trg_user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.user_profiles_set_updated_at();

-- New auth user -> profile with the default role (see default_user_role()).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.user_profiles (user_id, email, role)
    values (new.id, new.email, public.default_user_role())
    on conflict (user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Profile rows for any auth users that already exist (a no-op on a fresh
-- project). This creates no users and assigns no elevated role.
insert into public.user_profiles (user_id, email, role)
select id, email, public.default_user_role()
from auth.users
on conflict (user_id) do nothing;

-- Role of the caller; SECURITY DEFINER so RLS predicates can call it without
-- recursing into user_profiles' own policies. VERIFIED.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
    select role
    from public.user_profiles
    where user_id = auth.uid()
    limit 1
$$;

-- Role -> permissions. MUST mirror ROLE_PERMISSIONS in src/lib/auth/permissions.ts;
-- scripts/sql/validate/validate_schema.mjs compares the two for every role and
-- fails on any drift. Used only by RLS / storage policies.
create or replace function public.role_permissions(p_role public.user_role)
returns text[]
language sql
immutable
set search_path = public
as $$
    select case p_role::text
        when 'admin' then array[
            'manage_users','create_batch','edit_metadata','manual_question_entry','upload_pdf',
            'use_circuit_designer','generate_tests','use_ai_tools','use_agentic_qc','use_per_question_ai',
            'use_qbg','use_video_solution','use_question_wise_videos','view_questions','view_analytics',
            'submit_for_verification','verify_qc1','verify_qc2','verify_uat','reject_question','restore_question_version']
        when 'manager' then array[
            'create_batch','edit_metadata','manual_question_entry','upload_pdf','generate_tests',
            'use_ai_tools','use_agentic_qc','use_per_question_ai','use_qbg','use_video_solution',
            'use_question_wise_videos','use_circuit_designer','view_questions','view_analytics','submit_for_verification']
        when 'qc_reviewer' then array['view_questions','edit_metadata','verify_qc1','verify_qc2','verify_uat','reject_question']
        when 'data_entry' then array['manual_question_entry','view_questions','submit_for_verification']
        when 'ai_user' then array[
            'use_ai_tools','use_agentic_qc','use_per_question_ai','use_qbg','use_video_solution',
            'use_question_wise_videos','use_circuit_designer','view_questions']
        when 'qbg_user' then array['use_qbg']
        when 'video_user' then array['use_video_solution']
        when 'qbg_video_user' then array['use_qbg','use_video_solution']
        when 'qwv_user' then array['use_question_wise_videos']
        when 'viewer' then array['view_questions']
        else array[]::text[]   -- 'custom' and anything unknown: nothing
    end
$$;

-- Does the calling user hold ANY of the given permissions (role grants plus the
-- admin-granted extra_permissions, as effectivePermissions() computes in TS)?
-- False for anonymous callers. SECURITY DEFINER so policies can read the
-- caller's profile regardless of user_profiles' own RLS.
create or replace function public.has_any_permission(p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select (public.role_permissions(up.role) || coalesce(up.extra_permissions, '{}')) && p_permissions
        from public.user_profiles up
        where up.user_id = auth.uid()
    ), false)
$$;

-- NOTE: the original file ended with
--   update user_profiles set role = 'admin' where email = '<owner email>';
-- That seed is intentionally NOT carried forward. Promote the first admin by
-- hand after they sign up:
--   update public.user_profiles set role = 'admin' where lower(email) = lower('<email>');


-- =============================================================================
-- 4. qbg_questions  (RECONSTRUCTED - no base migration exists)
-- =============================================================================
-- Field-level provenance:
--
--   question_id        uuid PK          type VERIFIED (FK targets in
--                                       add_question_status_and_history.sql and
--                                       create_question_translations_table.sql).
--                                       default gen_random_uuid() INFERRED; every
--                                       writer in src/ supplies a
--                                       crypto.randomUUID() value itself.
--   qbg_id             text             type INFERRED. Historical type UNKNOWN.
--                                       Current writers store the same UUID
--                                       string as question_id; QBG's own
--                                       external ids (qbg_question_pool.qbg_id,
--                                       e.g. '4ii5mxgv84bkvg16rv8akjy1j') are not
--                                       UUIDs. text accepts both. No UNIQUE
--                                       constraint: uniqueness was never
--                                       asserted anywhere in the repo.
--   question_text      text             VERIFIED (restore fn reads ->>; search
--                                       uses ilike).
--   options            jsonb            VERIFIED (restore fn assigns
--                                       snapshot->'options', a jsonb value).
--   answer_key         jsonb            VERIFIED (restore fn assigns
--                                       snapshot->'answer_key'; writers send
--                                       number, number[], string or null).
--   solution_text      text             VERIFIED.
--   question_type .. source             text, VERIFIED (restore fn ->>).
--   difficutly_level   text             VERIFIED - misspelling is the real
--                                       column name the app queries. Do not
--                                       rename.
--   class_level        text             VERIFIED (restore fn, migrate script).
--   subtopic           text             VERIFIED (restore fn, migrate script).
--   exam               text[]           VERIFIED (migrate-extract-raw-data.mjs
--                                       header, restore fn ARRAY(...), and
--                                       .overlaps() filter).
--   parent_question_id text             type INFERRED. Historical type UNKNOWN:
--                                       the restore fn casts to ::uuid (suggests
--                                       uuid), while the app types it as string,
--                                       /api/questions POST accepts any string,
--                                       and QBG's parent ids are non-UUID text.
--                                       text is the least restrictive choice.
--                                       No FK - see note below.
--   raw_data           jsonb            VERIFIED (restore fn; status backfill
--                                       reads raw_data->0).
--   source_docx        jsonb            VERIFIED
--                                       (add_source_docx_and_docx_media_bucket).
--   status, created_by, last_modified_by, last_modified_at
--                                       VERIFIED incl. NOT NULL + defaults
--                                       (add_question_status_and_history.sql).
--
-- Nullability: except where VERIFIED above, every column is nullable. The
-- repository never asserts NOT NULL for them, and a metadata-only import
-- (content not available) must be able to leave the body columns NULL.
-- Original nullability is UNKNOWN.
--
-- Defaults: only options defaults to '[]' (INFERRED; every writer sends an
-- array, possibly empty). difficutly_level has NO default on purpose: writers
-- supply 'Medium' themselves, and a column default would silently invent a
-- difficulty for imported rows that genuinely lack one.
--
-- parent_question_id has NO foreign key. Its historical type and whether it
-- ever held QBG external ids (non-UUID) are unknown. Add
--   foreign key (parent_question_id) references ... on delete set null
-- only after the imported data proves every value is a question_id.

create table if not exists public.qbg_questions (
    question_id        uuid primary key default gen_random_uuid(),
    qbg_id             text,
    question_text      text,
    options            jsonb default '[]'::jsonb,
    answer_key         jsonb,
    solution_text      text,
    question_type      text,
    subject            text,
    chapter            text,
    topic              text,
    subtopic           text,
    source             text,
    difficutly_level   text,
    class_level        text,
    exam               text[],
    parent_question_id text,
    raw_data           jsonb,
    source_docx        jsonb,
    status             public.question_status not null default 'verification_pending',
    created_by         uuid references auth.users(id) on delete set null,
    last_modified_by   uuid references auth.users(id) on delete set null,
    last_modified_at   timestamptz not null default now()
);

-- Indexes: one per column the list/filter path in src/lib/api/questions.ts
-- actually hits. question_id (pagination order + lookup) is covered by the PK.
-- Existing name kept from add_question_status_and_history.sql:
create index if not exists idx_qbg_questions_status
    on public.qbg_questions(status);
-- subject -> chapter -> topic cascade (subject, subject+chapter prefixes):
create index if not exists idx_qbg_questions_subject_chapter_topic
    on public.qbg_questions(subject, chapter, topic);
-- chapter alone: chapter filter without subject, and the admin chapter merge
-- (UPDATE ... WHERE chapter = $1):
create index if not exists idx_qbg_questions_chapter
    on public.qbg_questions(chapter);
create index if not exists idx_qbg_questions_question_type
    on public.qbg_questions(question_type);
create index if not exists idx_qbg_questions_difficutly_level
    on public.qbg_questions(difficutly_level);
create index if not exists idx_qbg_questions_source
    on public.qbg_questions(source);
create index if not exists idx_qbg_questions_class_level
    on public.qbg_questions(class_level);
-- fetchChildQuestions(): .eq('parent_question_id', ...)
create index if not exists idx_qbg_questions_parent_question_id
    on public.qbg_questions(parent_question_id)
    where parent_question_id is not null;
-- exam filter uses && (overlaps):
create index if not exists idx_qbg_questions_exam_gin
    on public.qbg_questions using gin (exam);
-- has_source_docx filter: .not('source_docx', 'is', null)
create index if not exists idx_qbg_questions_has_source_docx
    on public.qbg_questions(question_id)
    where source_docx is not null;
-- Deliberately not indexed: subtopic (always filtered together with topic),
-- qbg_id (no query in src/ filters on it), question_text search
-- (ilike '%..%' needs pg_trgm; add it if search becomes slow).


-- =============================================================================
-- 5. QUESTION HISTORY  (status transitions + edit snapshots)
-- =============================================================================
-- VERIFIED: add_question_status_and_history.sql.

create table if not exists public.question_status_transitions (
    id                  uuid primary key default gen_random_uuid(),
    question_id         uuid not null references public.qbg_questions(question_id) on delete cascade,
    from_status         public.question_status,
    to_status           public.question_status not null,
    actor_user_id       uuid references auth.users(id) on delete set null,
    actor_email         text,
    actor_display_name  text,
    actor_role          public.user_role,
    note                text,
    created_at          timestamptz not null default now()
);
create index if not exists idx_qst_question_id
    on public.question_status_transitions(question_id, created_at desc);

create table if not exists public.question_edit_history (
    id                  uuid primary key default gen_random_uuid(),
    question_id         uuid not null references public.qbg_questions(question_id) on delete cascade,
    editor_user_id      uuid references auth.users(id) on delete set null,
    editor_email        text,
    editor_display_name text,
    editor_role         public.user_role,
    change_type         text not null check (change_type in ('create', 'update', 'restore')),
    snapshot            jsonb not null,
    changed_fields      text[],
    created_at          timestamptz not null default now()
);
create index if not exists idx_qeh_question_id
    on public.question_edit_history(question_id, created_at desc);

-- Snapshot every INSERT/UPDATE of qbg_questions. VERIFIED; one change: editor
-- attribution falls back to the row's own audit columns when auth.uid() is null.
-- A caller can mark the change as a restore with
--   select set_config('app.snapshot_change_type', 'restore', true);
create or replace function public.fn_capture_question_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_uid     uuid := auth.uid();
    v_profile public.user_profiles%rowtype;
    v_changed text[];
    v_op      text;
begin
    -- Server routes that write with the secret-key client have no auth.uid();
    -- they stamp created_by / last_modified_by on the row instead. Use that,
    -- but only when THIS write set it, so a stale value is never attributed.
    if v_uid is null then
        if tg_op = 'INSERT' then
            v_uid := coalesce(new.last_modified_by, new.created_by);
        elsif new.last_modified_by is distinct from old.last_modified_by then
            v_uid := new.last_modified_by;
        end if;
    end if;
    if v_uid is not null then
        select * into v_profile from public.user_profiles where user_id = v_uid;
    end if;

    if tg_op = 'INSERT' then
        v_op := 'create';
    else
        v_op := 'update';
        select array_agg(key) into v_changed
        from jsonb_each(to_jsonb(new)) as j(key, val)
        where to_jsonb(new)->key is distinct from to_jsonb(old)->key;
    end if;

    begin
        if current_setting('app.snapshot_change_type', true) in ('restore') then
            v_op := current_setting('app.snapshot_change_type', true);
        end if;
    exception when others then
        null;
    end;

    insert into public.question_edit_history (
        question_id, editor_user_id, editor_email, editor_display_name, editor_role,
        change_type, snapshot, changed_fields
    ) values (
        new.question_id,
        v_uid,
        v_profile.email,
        v_profile.display_name,
        v_profile.role,
        v_op,
        to_jsonb(new),
        v_changed
    );

    return new;
end $$;

drop trigger if exists trg_qbg_questions_snapshot on public.qbg_questions;
create trigger trg_qbg_questions_snapshot
after insert or update on public.qbg_questions
for each row execute function public.fn_capture_question_snapshot();


-- =============================================================================
-- 6. QUESTION TRANSLATIONS
-- =============================================================================
-- VERIFIED: create_question_translations_table.sql; RLS as finally left by
-- fix_question_translations_rls.sql.

create table if not exists public.question_translations (
    id                uuid primary key default gen_random_uuid(),
    question_id       uuid not null references public.qbg_questions(question_id) on delete cascade,
    language          text not null,
    question_text     text not null,
    options           jsonb not null default '[]'::jsonb,
    solution_text     text,
    translation_notes text,
    is_default        boolean not null default false,
    provider          text,
    model_id          text,
    model_label       text,
    translated_by     uuid references auth.users(id) on delete set null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- One default per (question, language).
create unique index if not exists uniq_default_translation_per_lang
    on public.question_translations(question_id, language)
    where is_default = true;
create index if not exists idx_qt_question_language
    on public.question_translations(question_id, language);
create index if not exists idx_qt_language_default
    on public.question_translations(language)
    where is_default = true;
create index if not exists idx_qt_question_created
    on public.question_translations(question_id, created_at desc);

-- Newest insert becomes the default; promoting a row demotes its siblings.
create or replace function public.manage_translation_default()
returns trigger
language plpgsql
as $$
begin
    if (tg_op = 'INSERT') then
        update public.question_translations
            set is_default = false
            where question_id = new.question_id
              and language = new.language
              and id <> new.id
              and is_default = true;
        new.is_default := true;
        return new;
    elsif (tg_op = 'UPDATE') then
        if new.is_default = true and old.is_default = false then
            update public.question_translations
                set is_default = false
                where question_id = new.question_id
                  and language = new.language
                  and id <> new.id
                  and is_default = true;
        end if;
        new.updated_at := now();
        return new;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_manage_translation_default on public.question_translations;
create trigger trg_manage_translation_default
    before insert or update on public.question_translations
    for each row execute function public.manage_translation_default();


-- =============================================================================
-- 7. TEST GENERATION HISTORY
-- =============================================================================
-- VERIFIED: create_test_history_tables.sql, plus `language` from
-- create_question_translations_table.sql.

create table if not exists public.qbg_batches (
    id         bigint generated always as identity primary key,
    name       text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.qbg_generated_tests (
    id                uuid primary key default gen_random_uuid(),
    batch_id          bigint references public.qbg_batches(id) on delete set null,
    batch_name        text not null,
    test_number       integer not null default 1,
    exam_preset       text not null,
    test_date         date,
    total_questions   integer not null default 0,
    status            text not null default 'FINALIZED',
    output_config     jsonb,
    generation_config jsonb,
    created_at        timestamptz not null default now()
);

alter table public.qbg_generated_tests
    add column if not exists language text not null default 'english';

-- test_name - INFERRED. src/lib/api/testHistory.ts inserts `test_name`
-- (nullable string) but no migration created the column; without it every
-- test finalisation would fail with "column does not exist".
alter table public.qbg_generated_tests
    add column if not exists test_name text;

-- question_id is TEXT on purpose (VERIFIED). It is NOT a foreign key to
-- qbg_questions: the test builder can record ids that are not qbg_questions
-- rows. Do not change to uuid without auditing the generation code.
create table if not exists public.qbg_generated_test_questions (
    id                bigint generated always as identity primary key,
    generated_test_id uuid not null references public.qbg_generated_tests(id) on delete cascade,
    question_id       text not null,
    question_order    integer not null,
    paper             text,
    subject           text,
    question_type     text,
    created_at        timestamptz not null default now(),
    unique (generated_test_id, question_id)
);

create index if not exists idx_qbg_generated_tests_batch_name
    on public.qbg_generated_tests(batch_name);
create index if not exists idx_qbg_generated_tests_created_at
    on public.qbg_generated_tests(created_at desc);
create index if not exists idx_qbg_generated_tests_status
    on public.qbg_generated_tests(status);
create index if not exists idx_qbg_generated_tests_language
    on public.qbg_generated_tests(language);
create index if not exists idx_qbg_generated_test_questions_question_id
    on public.qbg_generated_test_questions(question_id);
create index if not exists idx_qbg_generated_test_questions_order
    on public.qbg_generated_test_questions(generated_test_id, question_order);
-- Dropped as redundant vs. the original file:
--   idx_qbg_batches_name                     duplicates the UNIQUE(name) index
--   idx_qbg_generated_test_questions_test_id duplicates the leading column of
--                                            UNIQUE(generated_test_id, question_id)


-- =============================================================================
-- 8. PDF / DOCX EXTRACTION REPORTS
-- =============================================================================
-- VERIFIED: add_pdf_extraction_reports.sql + add_document_type_to_extraction_reports.sql.

create table if not exists public.pdf_extraction_reports (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references auth.users(id) on delete set null,
    user_email          text,
    source_name         text not null,
    mode                text not null check (mode in ('single', 'dual')),
    provider            text not null,
    model_id            text,
    questions_pdf_name  text,
    questions_pdf_size  integer,
    solutions_pdf_name  text,
    solutions_pdf_size  integer,
    status              public.extraction_report_status not null default 'queued',
    pdf_type            text,
    total_pages         integer,
    warnings            jsonb,
    error               text,
    extracted_questions jsonb not null default '[]'::jsonb,
    saved_question_ids  jsonb,
    saved_at            timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

alter table public.pdf_extraction_reports
    add column if not exists document_type text not null default 'pdf'
    check (document_type in ('pdf', 'docx'));

create index if not exists idx_per_user_created
    on public.pdf_extraction_reports(user_id, created_at desc);
create index if not exists idx_per_status
    on public.pdf_extraction_reports(status);

create or replace function public.fn_pdf_extraction_reports_touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;

drop trigger if exists trg_per_touch_updated_at on public.pdf_extraction_reports;
create trigger trg_per_touch_updated_at
before update on public.pdf_extraction_reports
for each row execute function public.fn_pdf_extraction_reports_touch_updated_at();


-- =============================================================================
-- 9. AI REPORTS
-- =============================================================================
-- VERIFIED: create_ai_reports_table.sql (+ allow_* follow-ups).
--
-- COMPATIBILITY FIX - report_type CHECK.
--   The last migration allowed 6 values. The application writes 10:
--     qc, solution, modification, repeat_check, extraction, translate  (SQL)
--     video                     src/lib/api/videoSolution.ts insert, and the
--                               artifact route requires report_type = 'video'
--     qbg_ingestion             /api/ai-tools/qbg-ingestion persistReport()
--     qbg_modification          /api/ai-tools/qbg-modification persistReport()
--     qbg_tagging               /api/ai-tools/qbg-tagging persistReport()
--   The 10-value list below is exactly VALID_REPORT_TYPES in
--   src/app/api/ai-tools/reports/route.ts, the app's own allow-list. Widening
--   the CHECK was chosen over renaming report types in code because
--   (a) the reports API already accepts all 10, (b) relabelling 'video' rows
--   would break the artifact download route, and (c) qbg_* rows are filtered
--   by type in history views.

create table if not exists public.ai_reports (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    report_type text not null,
    file_name   text not null default '',
    provider    text not null default '',
    model_id    text not null default '',
    report_data jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
);

alter table public.ai_reports drop constraint if exists ai_reports_report_type_check;
alter table public.ai_reports
    add constraint ai_reports_report_type_check
    check (report_type in (
        'qc', 'solution', 'modification', 'repeat_check', 'extraction', 'translate',
        'video', 'qbg_ingestion', 'qbg_modification', 'qbg_tagging'
    ));

create index if not exists idx_ai_reports_user_created_at
    on public.ai_reports(user_id, created_at desc);
create index if not exists idx_ai_reports_user_type_created_at
    on public.ai_reports(user_id, report_type, created_at desc);


-- =============================================================================
-- 10. AGENTIC QC JOBS
-- =============================================================================
-- VERIFIED: add_agentic_qc_jobs.sql. `id` has no default on purpose: the job
-- store supplies randomUUID() and upserts on it. user_id is always a real
-- auth user id here (routes return 401 without a session).

create table if not exists public.agentic_qc_jobs (
    id         uuid primary key,
    user_id    uuid references auth.users(id) on delete cascade,
    label      text not null default '',
    status     text not null default 'queued',
    data       jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_aqj_user_created on public.agentic_qc_jobs(user_id, created_at desc);
create index if not exists idx_aqj_status       on public.agentic_qc_jobs(status);


-- =============================================================================
-- 11. QBG TASKS  (RECONSTRUCTED - no migration exists)
-- =============================================================================
-- INFERRED entirely from src/lib/api/qbgTaskStore.ts (QbgTaskRow + queries):
--   id        text  - createReframeJob() yields 18 hex chars; the pipeline
--                     panel sends crypto.randomUUID(). Both fit text; uuid would
--                     reject the hex ids.
--   user_id   text  - stores the literal 'dev' for dev-auth sessions, so it
--                     cannot be uuid or reference auth.users.
--   task_type text  - qbg_modification | qbg_ingestion | qbg_tagging |
--                     qbg_pipeline | qbg_push (validated in code; no CHECK here
--                     so a new task type is not blocked by the database).
--   status    text  - running | done | failed.
-- Access is only through gated API routes with the server-only service_role
-- client (user_id scoping in code). No anon/authenticated access (section 15).

create table if not exists public.qbg_tasks (
    id         text primary key,
    user_id    text,
    task_type  text not null,
    label      text not null default '',
    status     text not null default 'running',
    error      text,
    provider   text not null default '',
    model_id   text not null default '',
    data       jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- listTasks(): eq(user_id) + eq(task_type) + order(created_at desc)
create index if not exists idx_qbg_tasks_user_type_created
    on public.qbg_tasks(user_id, task_type, created_at desc);


-- =============================================================================
-- 12. QUESTION-WISE VIDEO JOBS
-- =============================================================================
-- VERIFIED: create_question_video_jobs_table.sql.

create table if not exists public.question_video_jobs (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid references auth.users(id) on delete set null,
    source_url         text not null,
    video_label        text,
    want_clips         boolean not null default true,
    status             public.question_video_job_status not null default 'queued',
    error              text,
    log                text,
    video_duration_sec numeric,
    questions          jsonb not null default '[]'::jsonb,
    crop_result        jsonb,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create index if not exists idx_qvj_per_user_created on public.question_video_jobs(user_id, created_at desc);
create index if not exists idx_qvj_per_status       on public.question_video_jobs(status);

create or replace function public.fn_question_video_jobs_touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;

drop trigger if exists trg_qvj_touch_updated_at on public.question_video_jobs;
create trigger trg_qvj_touch_updated_at
before update on public.question_video_jobs
for each row execute function public.fn_question_video_jobs_touch_updated_at();


-- =============================================================================
-- 13. QBG QUESTION POOL  (separate from qbg_questions)
-- =============================================================================
-- VERIFIED: create_qbg_question_pool.sql + add_pool_solution_flags.sql.
-- Populated by python/qbg_pool_import/import_pool.py (upsert on unique_id).
-- `used_in_exam` is app-owned and must survive re-imports.

create table if not exists public.qbg_question_pool (
    unique_id                 text primary key,
    qbg_id                    text,
    question_type             text,
    difficulty_level          text,
    difficulty                smallint,
    source                    text,
    subject                   text,
    chapter                   text,
    topic                     text,
    subtopic                  text,
    class_level               text,
    category_name             text,
    used_in_exam              text[] not null default '{}',
    has_video_solution        boolean not null default false,
    has_text_solution         boolean not null default false,
    verification_status       smallint,
    is_int_answer             boolean,
    is_range_numerical        boolean,
    exam_year                 text,
    qc_status                 text,
    content                   jsonb,
    bilingual_options         jsonb,
    solutions                 jsonb,
    bilingual_solutions       jsonb,
    answer                    jsonb,
    concept_tags              jsonb,
    readiness_tags            jsonb,
    x_category_tags           jsonb,
    languages                 jsonb,
    exam_details              jsonb,
    sources                   jsonb,
    child_questions           jsonb,
    link                      text,
    slug                      text,
    parent_question_id        text,
    organization_id           text,
    category_configuration_id text,
    row_hash                  text,
    source_created_at         timestamptz,
    source_updated_at         timestamptz,
    imported_at               timestamptz not null default now(),
    updated_at                timestamptz not null default now()
);

create index if not exists idx_pool_subject_chapter_topic on public.qbg_question_pool (subject, chapter, topic);
create index if not exists idx_pool_class                 on public.qbg_question_pool (class_level);
create index if not exists idx_pool_source                on public.qbg_question_pool (source);
create index if not exists idx_pool_category              on public.qbg_question_pool (category_name);
create index if not exists idx_pool_qtype                 on public.qbg_question_pool (question_type);
create index if not exists idx_pool_difficulty            on public.qbg_question_pool (difficulty);
create index if not exists idx_pool_qbg_id                on public.qbg_question_pool (qbg_id);
create index if not exists idx_pool_used_in_exam          on public.qbg_question_pool using gin (used_in_exam);
create index if not exists idx_pool_has_video_solution    on public.qbg_question_pool (has_video_solution);
create index if not exists idx_pool_has_text_solution     on public.qbg_question_pool (has_text_solution);

-- Filter-menu facets for /api/qbg/pipeline/filters. VERIFIED, unchanged.
create or replace function public.qbg_pool_filter_options()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'subjects', (
        select jsonb_agg(distinct subject order by subject)
        from public.qbg_question_pool where subject is not null
    ),
    'classLevels', (
        select jsonb_agg(distinct class_level order by class_level)
        from public.qbg_question_pool where class_level is not null
    ),
    'categories', (
        select jsonb_agg(distinct category_name order by category_name)
        from public.qbg_question_pool where category_name is not null
    ),
    'sources', (
        select jsonb_agg(distinct source order by source)
        from public.qbg_question_pool where source is not null
    ),
    'questionTypes', (
        select jsonb_agg(distinct question_type order by question_type)
        from public.qbg_question_pool where question_type is not null
    ),
    'chaptersBySubject', (
        select jsonb_object_agg(subject, chapters) from (
            select subject, jsonb_agg(distinct chapter order by chapter) as chapters
            from public.qbg_question_pool
            where subject is not null and chapter is not null
            group by subject
        ) t
    ),
    'chaptersBySubjectClass', (
        select jsonb_object_agg(class_level, by_subject) from (
            select class_level, jsonb_object_agg(subject, chapters) as by_subject from (
                select class_level, subject, jsonb_agg(distinct chapter order by chapter) as chapters
                from public.qbg_question_pool
                where class_level is not null and subject is not null and chapter is not null
                group by class_level, subject
            ) t
            group by class_level
        ) t2
    ),
    'topicsByChapter', (
        select jsonb_object_agg(chapter, topics) from (
            select chapter, jsonb_agg(distinct topic order by topic) as topics
            from public.qbg_question_pool
            where chapter is not null and topic is not null
            group by chapter
        ) t
    ),
    'subtopicsByTopic', (
        select jsonb_object_agg(topic, subtopics) from (
            select topic, jsonb_agg(distinct subtopic order by subtopic) as subtopics
            from public.qbg_question_pool
            where topic is not null and subtopic is not null
            group by topic
        ) t
    ),
    'batchNames', (
        select jsonb_agg(distinct b order by b)
        from public.qbg_question_pool, unnest(used_in_exam) as b
    )
  );
$$;


-- =============================================================================
-- 14. CHAPTER MERGE LOG  (RECONSTRUCTED - no migration exists)
-- =============================================================================
-- INFERRED from the insert in src/app/api/admin/chapters/route.ts. Append-only
-- audit of admin chapter-spelling merges across qbg_questions and
-- qbg_question_pool. merged_by is an email string, not a user id.

create table if not exists public.chapter_merge_log (
    id           bigint generated always as identity primary key,
    table_name   text not null,
    subject      text,
    from_chapter text not null,
    to_chapter   text not null,
    rows_changed integer not null default 0,
    merged_by    text,
    created_at   timestamptz not null default now()
);


-- =============================================================================
-- 15. ACCESS MODEL, GRANTS AND ROW LEVEL SECURITY
-- =============================================================================
-- There is NO anonymous access to any table, function or storage object.
--
-- Three ways the application reaches the database:
--   service_role  the server-only secret-key client (src/lib/supabase/admin.ts)
--                 used by API routes AFTER their checkPermission() gate and by
--                 background jobs. Bypasses RLS by design.
--   authenticated the signed-in user's own session (cookie or bearer token),
--                 used where the database must know the user: profile reads,
--                 owner-scoped rows (AI reports, extraction reports, video
--                 jobs, artifacts), question edits whose history must record
--                 the editor, the restore RPC, and the browser translation panel.
--                 Only the narrow policies below apply.
--   anon          nothing. No grants, no policies.
--
-- Permission checks in policies use public.has_any_permission(), which mirrors
-- src/lib/auth/permissions.ts (checked by scripts/sql/validate/validate_schema.mjs).
-- =============================================================================

-- Supabase's default privileges grant every new public table/function to anon
-- and authenticated. Start from nothing and grant explicitly.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
grant  all on all tables    in schema public to service_role;
grant  all on all sequences in schema public to service_role;
grant  execute on all functions in schema public to service_role;

-- Every table has RLS on (defence in depth: even a stray grant exposes no rows).
alter table public.user_profiles                 enable row level security;
alter table public.qbg_questions                 enable row level security;
alter table public.question_status_transitions   enable row level security;
alter table public.question_edit_history         enable row level security;
alter table public.question_translations         enable row level security;
alter table public.qbg_batches                   enable row level security;
alter table public.qbg_generated_tests           enable row level security;
alter table public.qbg_generated_test_questions  enable row level security;
alter table public.pdf_extraction_reports        enable row level security;
alter table public.ai_reports                    enable row level security;
alter table public.agentic_qc_jobs               enable row level security;
alter table public.qbg_tasks                     enable row level security;
alter table public.question_video_jobs           enable row level security;
alter table public.qbg_question_pool             enable row level security;
alter table public.chapter_merge_log             enable row level security;

-- Drop every policy on our tables first so a re-run (or a run over the old,
-- permissive policies) converges on exactly the set below.
do $$
declare p record;
begin
    for p in
        select schemaname, tablename, policyname from pg_policies
        where schemaname = 'public' and tablename in (
            'user_profiles','qbg_questions','question_status_transitions','question_edit_history',
            'question_translations','qbg_batches','qbg_generated_tests','qbg_generated_test_questions',
            'pdf_extraction_reports','ai_reports','agentic_qc_jobs','qbg_tasks','question_video_jobs',
            'qbg_question_pool','chapter_merge_log')
    loop
        execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    end loop;
end $$;

-- Functions the authenticated role may call from policies / RPC.
grant execute on function public.current_user_role()              to authenticated;
grant execute on function public.has_any_permission(text[])       to authenticated;
grant execute on function public.role_permissions(public.user_role) to authenticated;
grant execute on function public.default_user_role()              to authenticated;

-- ---- user_profiles ---------------------------------------------------------
-- Read: yourself, or everyone if you are an admin (serverAuth, admin UI).
-- Update: admins only, and only role / extra_permissions / display_name.
-- Insert comes from the SECURITY DEFINER auth trigger; delete cascades from auth.users.
grant select on public.user_profiles to authenticated;
grant update (role, extra_permissions, display_name) on public.user_profiles to authenticated;
create policy user_profiles_select_self_or_admin on public.user_profiles
    for select to authenticated
    using (user_id = auth.uid() or public.current_user_role() = 'admin');
create policy user_profiles_update_admin on public.user_profiles
    for update to authenticated
    using (public.current_user_role() = 'admin')
    with check (public.current_user_role() = 'admin');

-- ---- qbg_questions ---------------------------------------------------------
-- Session writes: /api/questions POST, /api/questions/[id] PATCH, the status
-- route and extraction save (all run as the user so edit history records them).
-- Bulk/background writes (ingestion, finalize, chapter merge) use service_role.
-- No DELETE for anyone but service_role.
grant select, insert, update on public.qbg_questions to authenticated;
create policy qbg_questions_select on public.qbg_questions
    for select to authenticated
    using (public.has_any_permission(array['view_questions','generate_tests','manual_question_entry','edit_metadata','upload_pdf']));
create policy qbg_questions_insert on public.qbg_questions
    for insert to authenticated
    with check (public.has_any_permission(array['manual_question_entry','upload_pdf']));
create policy qbg_questions_update on public.qbg_questions
    for update to authenticated
    using (public.has_any_permission(array['manual_question_entry','edit_metadata','submit_for_verification','verify_qc1','verify_qc2','verify_uat','reject_question']))
    with check (public.has_any_permission(array['manual_question_entry','edit_metadata','submit_for_verification','verify_qc1','verify_qc2','verify_uat','reject_question']));

-- ---- question history --------------------------------------------------------
-- Snapshots are written only by the SECURITY DEFINER trigger. Transitions are
-- inserted by the status route as the acting user, and only as themselves.
grant select on public.question_edit_history to authenticated;
grant select, insert on public.question_status_transitions to authenticated;
create policy qeh_select on public.question_edit_history
    for select to authenticated
    using (public.has_any_permission(array['view_questions','restore_question_version']));
create policy qst_select on public.question_status_transitions
    for select to authenticated
    using (public.has_any_permission(array['view_questions']));
create policy qst_insert on public.question_status_transitions
    for insert to authenticated
    with check (
        actor_user_id = auth.uid()
        and public.has_any_permission(array['submit_for_verification','verify_qc1','verify_qc2','verify_uat','reject_question'])
    );

-- ---- question_translations ---------------------------------------------------
-- Browser panel (edit modal, tests page) and /api/ai-tools/translate run as the
-- user. The BEFORE trigger that flips is_default updates sibling rows as the
-- same user, so update rights cover it.
grant select, insert, update, delete on public.question_translations to authenticated;
create policy qt_select on public.question_translations
    for select to authenticated
    using (public.has_any_permission(array['view_questions','generate_tests','use_ai_tools','use_per_question_ai','manual_question_entry']));
create policy qt_insert on public.question_translations
    for insert to authenticated
    with check (public.has_any_permission(array['use_ai_tools','use_per_question_ai']));
create policy qt_update on public.question_translations
    for update to authenticated
    using (public.has_any_permission(array['manual_question_entry','edit_metadata','use_ai_tools','use_per_question_ai']))
    with check (public.has_any_permission(array['manual_question_entry','edit_metadata','use_ai_tools','use_per_question_ai']));
create policy qt_delete on public.question_translations
    for delete to authenticated
    using (public.has_any_permission(array['manual_question_entry','edit_metadata','use_ai_tools','use_per_question_ai']));

-- ---- pdf_extraction_reports ----------------------------------------------------
-- Owner, or admin/manager (mirrors isAdminish in the extraction routes).
grant select, insert, update, delete on public.pdf_extraction_reports to authenticated;
create policy per_select on public.pdf_extraction_reports
    for select to authenticated
    using (user_id = auth.uid() or public.current_user_role() in ('admin', 'manager'));
create policy per_insert on public.pdf_extraction_reports
    for insert to authenticated
    with check (user_id = auth.uid() and public.has_any_permission(array['upload_pdf']));
create policy per_update on public.pdf_extraction_reports
    for update to authenticated
    using (user_id = auth.uid() or public.current_user_role() in ('admin', 'manager'))
    with check (user_id = auth.uid() or public.current_user_role() in ('admin', 'manager'));
create policy per_delete on public.pdf_extraction_reports
    for delete to authenticated
    using (user_id = auth.uid() or public.current_user_role() in ('admin', 'manager'));

-- ---- ai_reports: owner only (VERIFIED from the original migration) ---------------
grant select, insert, delete on public.ai_reports to authenticated;
create policy ai_reports_select_own on public.ai_reports
    for select to authenticated using (user_id = (select auth.uid()));
create policy ai_reports_insert_own on public.ai_reports
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy ai_reports_delete_own on public.ai_reports
    for delete to authenticated using (user_id = (select auth.uid()));

-- ---- question_video_jobs: owner only (worker writes with the user's token) -------
grant select, insert, update, delete on public.question_video_jobs to authenticated;
create policy qvj_select_own on public.question_video_jobs
    for select to authenticated using (user_id = auth.uid());
create policy qvj_insert_own on public.question_video_jobs
    for insert to authenticated with check (user_id = auth.uid() and public.has_any_permission(array['use_question_wise_videos']));
create policy qvj_update_own on public.question_video_jobs
    for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy qvj_delete_own on public.question_video_jobs
    for delete to authenticated using (user_id = auth.uid());

-- ---- server-only tables ------------------------------------------------------------
-- qbg_batches, qbg_generated_tests, qbg_generated_test_questions, agentic_qc_jobs,
-- qbg_tasks, qbg_question_pool, chapter_merge_log: reached only through gated API
-- routes with service_role. RLS on, no policies, no grants for anon/authenticated.
-- qbg_pool_filter_options() is likewise service_role-only (granted above).


-- =============================================================================
-- 16. STORAGE BUCKETS + POLICIES
-- =============================================================================
-- All three buckets are PRIVATE (no public URLs; downloads use short-lived
-- signed URLs created server-side). No policy admits anon.
--
--   question-video-artifacts  <user_id>/<job_id>/...  written with the user's token
--   ai-video-artifacts        <user_id>/<job_id>/...  written with the user's token
--   docx-media                <extractionId>/<scope>/<sha>.<ext>  written during DOCX
--                             extraction (user session), read when building Word tests
--
-- No per-bucket size limit is set: the project's global upload limit applies
-- (Dashboard -> Storage -> Settings; 50 MB on the Free plan). Video clip ZIPs
-- can exceed that - raise the global limit (paid plans) if uploads fail.

insert into storage.buckets (id, name, public)
values
    ('question-video-artifacts', 'question-video-artifacts', false),
    ('ai-video-artifacts',       'ai-video-artifacts',       false),
    ('docx-media',               'docx-media',               false)
on conflict (id) do update set public = false;

-- remove the earlier bucket-only (anon-writable) policies, then define the new set
do $$
declare p record;
begin
    for p in
        select policyname from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and (policyname like 'question_video_artifacts_%' or policyname like 'ai_video_artifacts_%' or policyname like 'docx_media_%')
    loop
        execute format('drop policy %I on storage.objects', p.policyname);
    end loop;
end $$;

-- per-user folders: the first path segment must be the caller's user id
create policy question_video_artifacts_own on storage.objects
    for all to authenticated
    using (bucket_id = 'question-video-artifacts' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'question-video-artifacts' and (storage.foldername(name))[1] = auth.uid()::text);

create policy ai_video_artifacts_own on storage.objects
    for all to authenticated
    using (bucket_id = 'ai-video-artifacts' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'ai-video-artifacts' and (storage.foldername(name))[1] = auth.uid()::text);

-- docx media is shared question content: readable by anyone who can see or
-- build with questions, writable by uploaders.
create policy docx_media_read on storage.objects
    for select to authenticated
    using (bucket_id = 'docx-media' and public.has_any_permission(array['upload_pdf','generate_tests','view_questions']));
create policy docx_media_write on storage.objects
    for insert to authenticated
    with check (bucket_id = 'docx-media' and public.has_any_permission(array['upload_pdf']));
create policy docx_media_update on storage.objects
    for update to authenticated
    using (bucket_id = 'docx-media' and public.has_any_permission(array['upload_pdf']))
    with check (bucket_id = 'docx-media' and public.has_any_permission(array['upload_pdf']));


-- =============================================================================
-- 17. ADMIN FUNCTIONS
-- =============================================================================

-- admin_create_user_with_role() is intentionally NOT created: it wrote
-- auth.users / auth.identities directly. /api/admin/users now uses Supabase
-- Auth's supported admin API (auth.admin.createUser) with the secret key.
drop function if exists public.admin_create_user_with_role(text, text, public.user_role, text);

-- --- admin_restore_question_version ---------------------------------------
-- VERIFIED behaviour (add_admin_restore_question_version.sql), with one change:
-- the original cast parent_question_id with ::uuid. The column is text here,
-- and QBG parent ids are not UUIDs, so the cast would reject valid snapshots.
-- The value is now assigned as text.
create or replace function public.admin_restore_question_version(
    p_history_id uuid,
    p_note       text default null
) returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
    v_caller_role public.user_role;
    v_uid         uuid := auth.uid();
    v_snapshot    jsonb;
    v_question_id uuid;
begin
    if v_uid is null then
        raise exception 'Not authenticated.' using errcode = '42501';
    end if;

    select role into v_caller_role from public.user_profiles where user_id = v_uid;
    if v_caller_role is distinct from 'admin' then
        raise exception 'Only admins can restore prior versions.' using errcode = '42501';
    end if;

    select snapshot, question_id into v_snapshot, v_question_id
    from public.question_edit_history
    where id = p_history_id;

    if v_snapshot is null then
        raise exception 'History entry not found.' using errcode = '02000';
    end if;

    perform set_config('app.snapshot_change_type', 'restore', true);

    update public.qbg_questions set
        question_text      = coalesce(v_snapshot->>'question_text', question_text),
        options            = coalesce(v_snapshot->'options', options),
        answer_key         = coalesce(v_snapshot->'answer_key', answer_key),
        solution_text      = coalesce(v_snapshot->>'solution_text', solution_text),
        question_type      = coalesce(v_snapshot->>'question_type', question_type),
        subject            = coalesce(v_snapshot->>'subject', subject),
        chapter            = coalesce(v_snapshot->>'chapter', chapter),
        topic              = coalesce(v_snapshot->>'topic', topic),
        subtopic           = v_snapshot->>'subtopic',
        source             = coalesce(v_snapshot->>'source', source),
        difficutly_level   = coalesce(v_snapshot->>'difficutly_level', difficutly_level),
        class_level        = v_snapshot->>'class_level',
        exam               = case
                                when v_snapshot ? 'exam' and jsonb_typeof(v_snapshot->'exam') = 'array'
                                then array(select jsonb_array_elements_text(v_snapshot->'exam'))
                                else exam
                             end,
        parent_question_id = v_snapshot->>'parent_question_id',
        raw_data           = v_snapshot->'raw_data',
        last_modified_by   = v_uid,
        last_modified_at   = now()
    where question_id = v_question_id;

    if p_note is not null and length(trim(p_note)) > 0 then
        update public.question_edit_history
        set changed_fields = coalesce(changed_fields, array[]::text[]) || array['__restore_note__:' || p_note]
        where question_id = v_question_id
          and created_at = (select max(created_at) from public.question_edit_history where question_id = v_question_id);
    end if;

    return v_question_id;
end $$;

-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- directly, so revoking from PUBLIC alone would leave anon able to call it.
revoke all on function public.admin_restore_question_version(uuid, text) from public;
revoke all on function public.admin_restore_question_version(uuid, text) from anon;
grant execute on function public.admin_restore_question_version(uuid, text) to authenticated;

-- =============================================================================
-- END
-- =============================================================================
