-- Run this once in Supabase SQL Editor.
-- Creates persistent AI tool report history scoped to the signed-in user.

create table if not exists public.ai_reports (
    id uuid primary key default gen_random_uuid(),
    user_id uuid null references auth.users(id) on delete cascade,
    report_type text not null check (report_type in ('qc', 'solution', 'modification', 'repeat_check', 'extraction', 'translate')),
    file_name text not null default '',
    provider text not null default '',
    model_id text not null default '',
    report_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.ai_reports
    add column if not exists user_id uuid null references auth.users(id) on delete cascade;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'ai_reports_report_type_check'
          and conrelid = 'public.ai_reports'::regclass
    ) then
        alter table public.ai_reports
            add constraint ai_reports_report_type_check
            check (report_type in ('qc', 'solution', 'modification', 'repeat_check', 'extraction', 'translate'));
    end if;
end $$;

alter table public.ai_reports
    enable row level security;

drop policy if exists "Users can view their own AI reports." on public.ai_reports;
drop policy if exists "Users can insert their own AI reports." on public.ai_reports;
drop policy if exists "Users can delete their own AI reports." on public.ai_reports;

create policy "Users can view their own AI reports."
    on public.ai_reports
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

create policy "Users can insert their own AI reports."
    on public.ai_reports
    for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

create policy "Users can delete their own AI reports."
    on public.ai_reports
    for delete
    to authenticated
    using ((select auth.uid()) = user_id);

create index if not exists idx_ai_reports_user_created_at
    on public.ai_reports(user_id, created_at desc);

create index if not exists idx_ai_reports_user_type_created_at
    on public.ai_reports(user_id, report_type, created_at desc);
