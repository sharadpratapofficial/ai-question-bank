-- Run this once in Supabase SQL Editor.
-- Creates shared per-question translations and adds language to generated tests.

create table if not exists public.question_translations (
    id uuid primary key default gen_random_uuid(),
    question_id uuid not null references public.qbg_questions(question_id) on delete cascade,
    language text not null,
    question_text text not null,
    options jsonb not null default '[]'::jsonb,
    solution_text text null,
    translation_notes text null,
    is_default boolean not null default false,
    provider text null,
    model_id text null,
    model_label text null,
    translated_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Only one default per (question, language).
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

-- Trigger: every insert auto-becomes the default for its (question, language).
-- When a row is updated to is_default = true, all other rows for the same
-- (question, language) are flipped to false in a single statement.
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

alter table public.question_translations enable row level security;

drop policy if exists "Anyone authenticated can read translations" on public.question_translations;
drop policy if exists "Anyone authenticated can insert translations" on public.question_translations;
drop policy if exists "Anyone authenticated can update translations" on public.question_translations;
drop policy if exists "Only translator can delete their entry" on public.question_translations;

create policy "Anyone authenticated can read translations"
    on public.question_translations
    for select
    to authenticated
    using (true);

create policy "Anyone authenticated can insert translations"
    on public.question_translations
    for insert
    to authenticated
    with check (auth.uid() = translated_by);

create policy "Anyone authenticated can update translations"
    on public.question_translations
    for update
    to authenticated
    using (true)
    with check (true);

create policy "Only translator can delete their entry"
    on public.question_translations
    for delete
    to authenticated
    using (auth.uid() = translated_by);

-- Test language wiring.
alter table public.qbg_generated_tests
    add column if not exists language text not null default 'english';

create index if not exists idx_qbg_generated_tests_language
    on public.qbg_generated_tests(language);
