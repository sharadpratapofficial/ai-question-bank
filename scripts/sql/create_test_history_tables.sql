-- Run this once in Supabase SQL Editor.
-- Creates batch master + finalized test history tables used by Test Builder.

create table if not exists public.qbg_batches (
    id bigint generated always as identity primary key,
    name text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.qbg_generated_tests (
    id uuid primary key default gen_random_uuid(),
    batch_id bigint references public.qbg_batches(id) on delete set null,
    batch_name text not null,
    test_number integer not null default 1,
    exam_preset text not null,
    test_date date null,
    total_questions integer not null default 0,
    status text not null default 'FINALIZED',
    output_config jsonb null,
    generation_config jsonb null,
    created_at timestamptz not null default now()
);

create table if not exists public.qbg_generated_test_questions (
    id bigint generated always as identity primary key,
    generated_test_id uuid not null references public.qbg_generated_tests(id) on delete cascade,
    question_id text not null,
    question_order integer not null,
    paper text null,
    subject text null,
    question_type text null,
    created_at timestamptz not null default now(),
    unique (generated_test_id, question_id)
);

create index if not exists idx_qbg_batches_name
    on public.qbg_batches(name);

create index if not exists idx_qbg_generated_tests_batch_name
    on public.qbg_generated_tests(batch_name);

create index if not exists idx_qbg_generated_tests_created_at
    on public.qbg_generated_tests(created_at desc);

create index if not exists idx_qbg_generated_tests_status
    on public.qbg_generated_tests(status);

create index if not exists idx_qbg_generated_test_questions_test_id
    on public.qbg_generated_test_questions(generated_test_id);

create index if not exists idx_qbg_generated_test_questions_question_id
    on public.qbg_generated_test_questions(question_id);

create index if not exists idx_qbg_generated_test_questions_order
    on public.qbg_generated_test_questions(generated_test_id, question_order);
