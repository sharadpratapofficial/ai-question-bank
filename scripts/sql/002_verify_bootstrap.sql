-- =============================================================================
-- 002_verify_bootstrap.sql   READ-ONLY. Changes nothing.
-- Run in the Supabase SQL editor right after 000_rebuild_schema.sql.
-- Every row should say PASS. Anything else: stop and investigate before
-- creating users or loading data.
-- =============================================================================
with
expected_tables(t) as (
    values ('user_profiles'),('qbg_questions'),('question_status_transitions'),('question_edit_history'),
           ('question_translations'),('qbg_batches'),('qbg_generated_tests'),('qbg_generated_test_questions'),
           ('pdf_extraction_reports'),('ai_reports'),('agentic_qc_jobs'),('qbg_tasks'),('question_video_jobs'),
           ('qbg_question_pool'),('chapter_merge_log')
),
checks(check_name, ok, detail) as (
    select '15 application tables exist',
           (select count(*) from expected_tables e join pg_tables p on p.schemaname = 'public' and p.tablename = e.t) = 15,
           (select string_agg(e.t, ', ') from expected_tables e where not exists (select 1 from pg_tables p where p.schemaname = 'public' and p.tablename = e.t))
    union all
    select 'RLS enabled on every public table',
           not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
           (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)
    union all
    select 'anon has no table privileges',
           not exists (select 1 from information_schema.role_table_grants where grantee in ('anon', 'PUBLIC') and table_schema = 'public'),
           (select string_agg(distinct table_name, ', ') from information_schema.role_table_grants where grantee in ('anon', 'PUBLIC') and table_schema = 'public')
    union all
    select 'anon cannot execute any public function',
           not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')),
           (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE'))
    union all
    select 'no policy targets anon/public (public + storage)',
           not exists (select 1 from pg_policies where schemaname in ('public', 'storage') and roles && array['anon', 'public']::name[]),
           (select string_agg(schemaname || '.' || tablename || ':' || policyname, ', ') from pg_policies where schemaname in ('public', 'storage') and roles && array['anon', 'public']::name[])
    union all
    select 'expected policy count (public 23, storage 5)',
           (select count(*) from pg_policies where schemaname = 'public') = 23
           and (select count(*) from pg_policies where schemaname = 'storage' and (policyname like 'question_video_artifacts_%' or policyname like 'ai_video_artifacts_%' or policyname like 'docx_media_%')) = 5,
           (select count(*) from pg_policies where schemaname = 'public')::text || ' public / ' ||
           (select count(*) from pg_policies where schemaname = 'storage' and (policyname like 'question_video_artifacts_%' or policyname like 'ai_video_artifacts_%' or policyname like 'docx_media_%'))::text || ' storage'
    union all
    select '3 private storage buckets',
           (select count(*) from storage.buckets where id in ('question-video-artifacts', 'ai-video-artifacts', 'docx-media') and public = false) = 3,
           (select string_agg(id || '=' || case when public then 'PUBLIC' else 'private' end, ', ') from storage.buckets where id in ('question-video-artifacts', 'ai-video-artifacts', 'docx-media'))
    union all
    select 'auth.users -> user_profiles trigger installed',
           exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relname = 'users' and t.tgname = 'trg_on_auth_user_created'),
           null
    union all
    select 'qbg_questions edit-history trigger installed',
           exists (select 1 from pg_trigger where tgname = 'trg_qbg_questions_snapshot'),
           null
    union all
    select 'new accounts default to the no-access role',
           public.default_user_role()::text = 'custom',
           public.default_user_role()::text
    union all
    select 'historical column name difficutly_level kept (app contract)',
           exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qbg_questions' and column_name = 'difficutly_level'),
           null
    union all
    select 'obsolete admin_create_user_with_role absent',
           not exists (select 1 from pg_proc where proname = 'admin_create_user_with_role'),
           null
    union all
    select 'database is still empty of questions (nothing imported yet)',
           (select count(*) from public.qbg_questions) = 0,
           (select count(*) from public.qbg_questions)::text || ' rows'
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks
order by ok, check_name;
