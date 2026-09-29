-- =============================================================================
-- 003b_child_order_only.sql
-- =============================================================================
-- The live project ljkpcqllqdamdatesbfe diverged from the 000 baseline that
-- 003_new_question_bank_support.sql assumes. Two additive migrations were
-- applied there directly (20260927201616 pre_import_hardening,
-- 20260927201809 numeric_answers_and_question_media), adding
-- qbg_questions.created_at / parent_question_uuid / numeric_answer_config and
-- the question-media bucket + policies. Their SQL is not in this repository.
--
-- This file is section 1 of 003 ONLY (child_order + its two constraints), the
-- piece the new-bank importer needs. Deliberately left out:
--   * 003 section 2 (create or replace admin_restore_question_version): it
--     would replace the live function with the 000-era body and silently drop
--     anything pre_import_hardening added (e.g. restoring parent_question_uuid
--     or numeric_answer_config). Re-do it only after reading the live body.
--   * 003 section 3 (question-media bucket + policies): the bucket and its
--     policies already exist live. 003 would overwrite the bucket's limits and
--     drop/recreate or duplicate policies whose live names are unknown here.
--
-- Additive, idempotent, never drops or rewrites data. The column is nullable
-- and starts NULL, so both constraints hold for every existing row.
-- =============================================================================

alter table public.qbg_questions
    add column if not exists child_order smallint;

do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'qbg_questions_child_order_check'
                     and conrelid = 'public.qbg_questions'::regclass) then
        alter table public.qbg_questions add constraint qbg_questions_child_order_check
            check (child_order is null or (child_order >= 1 and parent_question_id is not null));
    end if;
end $$;

do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'qbg_questions_parent_child_order_key'
                     and conrelid = 'public.qbg_questions'::regclass) then
        alter table public.qbg_questions add constraint qbg_questions_parent_child_order_key
            unique (parent_question_id, child_order) deferrable initially immediate;
    end if;
end $$;

-- PostgREST caches the schema; make the new column visible to the API now.
notify pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK (manual, not executed; only while no row has a child_order value):
-- alter table public.qbg_questions drop constraint if exists qbg_questions_parent_child_order_key;
-- alter table public.qbg_questions drop constraint if exists qbg_questions_child_order_check;
-- alter table public.qbg_questions drop column if exists child_order;
-- =============================================================================
