-- =============================================================================
-- 003_new_question_bank_support.sql
-- =============================================================================
-- Forward migration on top of 000_rebuild_schema.sql, which is already applied
-- to project ljkpcqllqdamdatesbfe. Run it once in the Supabase SQL editor.
-- It is idempotent (safe to re-run) and never drops or rewrites data.
--
--   1. G2  qbg_questions.child_order: explicit order of comprehension children
--   2. G2  admin_restore_question_version() also restores child_order
--   3. G5  private Storage bucket 'question-media' + policies
--
-- Rollback (manual; only while no data depends on it) is at the end of the file.
-- Docs: docs/NEW_QUESTION_BANK_FORMAT.md sections 9-10.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. child_order (G2)
-- -----------------------------------------------------------------------------
-- fetchChildQuestions() (src/lib/api/questions.ts) used to order children by
-- question_id (a UUID), which shows passage questions in effectively random
-- order. Children now carry an explicit 1-based position.
-- Existing rows are untouched: the column is nullable and starts NULL.

alter table public.qbg_questions
    add column if not exists child_order smallint;

-- Only child questions carry a position, and it starts at 1.
do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'qbg_questions_child_order_check'
                     and conrelid = 'public.qbg_questions'::regclass) then
        alter table public.qbg_questions add constraint qbg_questions_child_order_check
            check (child_order is null or (child_order >= 1 and parent_question_id is not null));
    end if;
end $$;

-- No two children of one parent share a position. NULLs never collide, so
-- standalone questions and children without a position are unaffected.
-- DEFERRABLE lets one transaction swap two positions. The backing unique index
-- also serves the .eq(parent_question_id).order(child_order) lookup.
do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'qbg_questions_parent_child_order_key'
                     and conrelid = 'public.qbg_questions'::regclass) then
        alter table public.qbg_questions add constraint qbg_questions_parent_child_order_key
            unique (parent_question_id, child_order) deferrable initially immediate;
    end if;
end $$;


-- -----------------------------------------------------------------------------
-- 2. admin_restore_question_version() restores child_order too (G2)
-- -----------------------------------------------------------------------------
-- Identical to the 000 definition except for the child_order line. Snapshots
-- taken before this migration have no child_order key and keep the current
-- value. The edit-history trigger snapshots to_jsonb(new), so it already
-- records child_order without any change.

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
        child_order        = case when v_snapshot ? 'child_order'
                                  then (v_snapshot->>'child_order')::smallint
                                  else child_order end,
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

-- create or replace keeps the existing grants; restated so this file is complete on its own.
revoke all on function public.admin_restore_question_version(uuid, text) from public, anon;
grant execute on function public.admin_restore_question_version(uuid, text) to authenticated;


-- -----------------------------------------------------------------------------
-- 3. question-media: private bucket for new-bank question images (G5)
-- -----------------------------------------------------------------------------
-- Object path (enforced below for session users):
--     newbank/<question_id>/<filename>
-- where <question_id> is an existing qbg_questions.question_id and <filename>
-- is [A-Za-z0-9][A-Za-z0-9._-]{0,127} ending in .png / .jpg / .jpeg / .gif / .webp.
--
-- Question records store only this storage path (inside an app route URL,
-- /api/question-media/<path>), never a public or signed URL. The route
-- authenticates the viewer and redirects to a short-lived signed URL.
--
-- Access, mirroring qbg_questions:
--   read    : the qbg_questions SELECT permissions
--   upload  : manual_question_entry / upload_pdf / edit_metadata (create or edit questions)
--   update  : nobody (objects are immutable; a corrected image gets a new filename,
--             and the question HTML edit is recorded in question_edit_history)
--   delete  : nobody but the server (secret key bypasses RLS)
--   anon    : nothing (no policy names anon; the bucket is not public)
-- SVG is deliberately not allowed: an SVG opened directly can run script.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-media', 'question-media', false, 10485760,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists question_media_read   on storage.objects;
drop policy if exists question_media_insert on storage.objects;

create policy question_media_read on storage.objects
    for select to authenticated
    using (
        bucket_id = 'question-media'
        and public.has_any_permission(array['view_questions','generate_tests','manual_question_entry','edit_metadata','upload_pdf'])
    );

create policy question_media_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'question-media'
        and public.has_any_permission(array['manual_question_entry','upload_pdf','edit_metadata'])
        and name ~ '^newbank/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
        and lower(name) ~ '\.(png|jpe?g|gif|webp)$'
        and exists (
            select 1 from public.qbg_questions q
            where q.question_id::text = split_part(name, '/', 2)
        )
    );


-- =============================================================================
-- ROLLBACK (manual, not executed). Reversible while nothing depends on it:
--   * child_order values would be lost - only acceptable before real data uses them;
--   * the bucket can be dropped only when it holds no objects.
--
-- drop policy if exists question_media_insert on storage.objects;
-- drop policy if exists question_media_read   on storage.objects;
-- delete from storage.buckets where id = 'question-media';   -- fails while objects exist
-- alter table public.qbg_questions drop constraint if exists qbg_questions_parent_child_order_key;
-- alter table public.qbg_questions drop constraint if exists qbg_questions_child_order_check;
-- alter table public.qbg_questions drop column if exists child_order;
-- then re-run section 17 (admin_restore_question_version) of 000_rebuild_schema.sql
-- =============================================================================
