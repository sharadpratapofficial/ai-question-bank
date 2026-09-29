-- =============================================================================
-- 003b_verify_child_order_only.sql   READ-ONLY. Changes nothing.
-- Run right after 003b_child_order_only.sql. Every row should say PASS.
-- Also confirms the live additive columns/bucket that 003b must not disturb.
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
           (select pg_get_constraintdef(oid) from pg_constraint where conname = 'qbg_questions_child_order_check'
            and conrelid = 'public.qbg_questions'::regclass)
    union all
    select 'unique (parent_question_id, child_order), deferrable',
           exists (select 1 from pg_constraint where conname = 'qbg_questions_parent_child_order_key'
                   and conrelid = 'public.qbg_questions'::regclass and contype = 'u' and condeferrable),
           null
    union all
    select 'no existing row has a child_order yet',
           not exists (select 1 from public.qbg_questions where child_order is not null),
           (select count(*)::text || ' row(s) in qbg_questions' from public.qbg_questions)
    union all
    select 'live additive columns still present (created_at, parent_question_uuid, numeric_answer_config)',
           (select count(*) from information_schema.columns
            where table_schema = 'public' and table_name = 'qbg_questions'
              and column_name in ('created_at', 'parent_question_uuid', 'numeric_answer_config')) = 3,
           null
    union all
    select 'importer columns all present',
           (select count(*) from information_schema.columns
            where table_schema = 'public' and table_name = 'qbg_questions'
              and column_name in ('question_id','qbg_id','question_text','options','answer_key','solution_text','question_type',
                                  'subject','chapter','topic','subtopic','source','difficutly_level','class_level','exam',
                                  'parent_question_id','child_order','raw_data','status','created_by','last_modified_by','last_modified_at')) = 22,
           null
    union all
    select 'question-media bucket still exists and is private',
           exists (select 1 from storage.buckets where id = 'question-media' and public = false),
           (select 'public=' || public || ' limit=' || coalesce(file_size_limit::text, 'none') || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), 'any')
            from storage.buckets where id = 'question-media')
    union all
    select 'question-media storage policies present (unchanged by 003b)',
           exists (select 1 from pg_policies where schemaname = 'storage' and (qual like '%question-media%' or with_check like '%question-media%')),
           (select string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, '/'), ', ')
            from pg_policies where schemaname = 'storage' and (qual like '%question-media%' or with_check like '%question-media%'))
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks
order by ok, check_name;

-- INFO (not a pass/fail): the live restore function body, to review before any
-- later change to it. 003 section 2 was NOT applied.
-- select pg_get_functiondef('public.admin_restore_question_version(uuid,text)'::regprocedure);
