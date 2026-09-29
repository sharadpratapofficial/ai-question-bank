-- =============================================================================
-- supabase_shim.sql - LOCAL VALIDATION ONLY. Never run against Supabase.
-- =============================================================================
-- A minimal stand-in for the Supabase-managed objects 000_rebuild_schema.sql
-- depends on, so the migration can be exercised on a disposable local
-- PostgreSQL (validate_schema.mjs runs it on PGlite).
--
-- It is NOT a faithful copy of Supabase's auth/storage schemas. Only the
-- columns the migration touches are modelled; passing here does not prove the
-- auth.users / auth.identities inserts in admin_create_user_with_role() match
-- the real GoTrue schema.
-- =============================================================================

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin bypassrls;
    end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

create table if not exists auth.users (
    instance_id            uuid,
    id                     uuid primary key,
    aud                    text,
    role                   text,
    email                  text,
    encrypted_password     text,
    email_confirmed_at     timestamptz,
    created_at             timestamptz,
    updated_at             timestamptz,
    raw_app_meta_data      jsonb,
    raw_user_meta_data     jsonb,
    confirmation_token     text,
    recovery_token         text,
    email_change_token_new text,
    email_change           text
);

create table if not exists auth.identities (
    id              uuid primary key,
    user_id         uuid not null references auth.users(id) on delete cascade,
    provider        text not null,
    provider_id     text not null,
    identity_data   jsonb not null,
    last_sign_in_at timestamptz,
    created_at      timestamptz,
    updated_at      timestamptz
);

-- Same contract as Supabase's auth.uid(): the JWT `sub` claim, or NULL.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(
        coalesce(
            current_setting('request.jwt.claim.sub', true),
            current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
        ),
        ''
    )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table if not exists storage.buckets (
    id                 text primary key,
    name               text not null,
    public             boolean default false,
    file_size_limit    bigint,
    allowed_mime_types text[],
    created_at         timestamptz default now()
);

-- Same contract as Supabase's storage.foldername(): the path's folder segments.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

create table if not exists storage.objects (
    id         uuid primary key default gen_random_uuid(),
    bucket_id  text references storage.buckets(id),
    name       text,
    owner      uuid,
    created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
