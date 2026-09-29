-- =============================================================================
-- 003_verify_new_question_bank_support.sql   READ-ONLY. Changes nothing.
-- Run in the Supabase SQL editor right after 003_new_question_bank_support.sql
-- (and again after any re-run of 000_rebuild_schema.sql, which would restore the
-- pre-003 admin_restore_question_version; re-run 003 if that check fails).
-- Every row should say PASS.
-- =============================================================================
with
checks(check_name, ok, detail) as (
    select 'qbg_questions.child_order exists (smallint, nullable)',
           exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'qbg_questions' and column_name = 'child_order'
                     and data_type = 'smallint' and is_nullable = 'YES'),
           (select data_type || ' nullable=' || is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'qbg_questions' and column_name = 'child_order')
    union all
    select 'child_order check constraint (>= 1, only with a parent)',
           exists (select 1 from pg_constraint where conname = 'qbg_questions_child_order_check'
                   and conrelid = 'public.qbg_questions'::regclass and contype = 'c'),
           null
    union all
    select 'unique (parent_question_id, child_order), deferrable',
           exists (select 1 from pg_constraint where conname = 'qbg_questions_parent_child_order_key'
                   and conrelid = 'public.qbg_questions'::regclass and contype = 'u' and condeferrable),
           null
    union all
    select 'admin_restore_question_version restores child_order',
           exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'admin_restore_question_version'
                     and pg_get_functiondef(p.oid) like '%child_order%'),
           'if FAIL: 000 was re-run after 003 - re-run 003'
    union all
    select 'anon cannot execute admin_restore_question_version',
           not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname = 'admin_restore_question_version'
                         and has_function_privilege('anon', p.oid, 'EXECUTE')),
           null
    union all
    select 'question-media bucket is private, 10 MB, png/jpeg/gif/webp only',
           exists (select 1 from storage.buckets where id = 'question-media' and public = false
                   and file_size_limit = 10485760
                   and allowed_mime_types @> array['image/png','image/jpeg','image/gif','image/webp']
                   and array_length(allowed_mime_types, 1) = 4),
           (select 'public=' || public || ' limit=' || coalesce(file_size_limit::text, 'none') || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), 'any')
            from storage.buckets where id = 'question-media')
    union all
    select 'question-media policies: exactly read + insert, authenticated only',
           (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'question_media_%') = 2
           and exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'question_media_read'   and cmd = 'SELECT' and roles = array['authenticated']::name[])
           and exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'question_media_insert' and cmd = 'INSERT' and roles = array['authenticated']::name[]),
           (select string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, '/'), ', ') from pg_policies where schemaname = 'storage' and policyname like 'question_media_%')
    union all
    select 'no storage policy targets anon/public',
           not exists (select 1 from pg_policies where schemaname = 'storage' and roles && array['anon', 'public']::name[]),
           (select string_agg(policyname, ', ') from pg_policies where schemaname = 'storage' and roles && array['anon', 'public']::name[])
    union all
    select 'all 4 storage buckets are private',
           (select count(*) from storage.buckets
            where id in ('question-video-artifacts', 'ai-video-artifacts', 'docx-media', 'question-media') and public = false) = 4,
           (select string_agg(id || '=' || case when public then 'PUBLIC' else 'private' end, ', ') from storage.buckets)
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks
order by ok, check_name;
