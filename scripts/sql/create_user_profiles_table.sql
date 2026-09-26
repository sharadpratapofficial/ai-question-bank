-- =============================================================================
-- user_profiles + role-based access control (RBAC)
-- =============================================================================
-- Stores one row per Supabase auth user with a fixed role. The role drives
-- application permissions enforced in middleware, API routes, and UI.
--
-- Roles:
--   admin       - full access including user management
--   manager     - batches, metadata, full question CRUD, AI tools, tests, upload
--   data_entry  - only manually add/edit a single question + solution
--   ai_user     - view questions + use AI tools
--   viewer      - read-only
--
-- New users default to 'viewer'. An admin promotes them via /admin/users.
-- =============================================================================

-- 1. Enum -----------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_type where typname = 'user_role') then
        create type public.user_role as enum (
            'admin',
            'manager',
            'data_entry',
            'ai_user',
            'viewer'
        );
    end if;
end$$;

-- 2. Table ----------------------------------------------------------------
create table if not exists public.user_profiles (
    user_id      uuid primary key references auth.users(id) on delete cascade,
    email        text,
    role         public.user_role not null default 'viewer',
    display_name text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists idx_user_profiles_role on public.user_profiles(role);
create index if not exists idx_user_profiles_email on public.user_profiles(lower(email));

-- 3. updated_at trigger ---------------------------------------------------
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

-- 4. Auto-create profile when a new auth.users row appears ----------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.user_profiles (user_id, email, role)
    values (new.id, new.email, 'viewer')
    on conflict (user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- 5. Backfill profiles for any existing auth users -----------------------
insert into public.user_profiles (user_id, email, role)
select id, email, 'viewer'
from auth.users
on conflict (user_id) do nothing;

-- 6. SECURITY DEFINER helper: current user's role -------------------------
-- Used by RLS predicates so an admin can read all rows without recursion.
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

-- 7. RLS ------------------------------------------------------------------
alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_select_self_or_admin on public.user_profiles;
create policy user_profiles_select_self_or_admin
on public.user_profiles
for select
to anon, authenticated
using (
    auth.uid() = user_id
    or public.current_user_role() = 'admin'
);

-- Writes are restricted: the admin UI uses the service-role client, which
-- bypasses RLS. We deliberately do NOT grant UPDATE/INSERT/DELETE here.
-- (Anon role cannot write either.)

-- 8. Seed initial admin ---------------------------------------------------
-- Promote the owner of the project so they have admin access immediately.
update public.user_profiles
set role = 'admin'
where lower(email) = lower('mittallovee@gmail.com');
