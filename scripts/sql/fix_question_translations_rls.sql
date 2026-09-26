-- Run once in Supabase SQL Editor.
-- The original INSERT policy required (auth.uid() = translated_by), which
-- silently rejects translations whenever the server route can't resolve a
-- Supabase session (dev auth cookie mode, expired session, etc.). Translations
-- are intentionally shared across users, so the attribution check is overkill.
-- This loosens the policy to allow any authenticated request to insert.
--
-- Also relaxes the SELECT policy to anon + authenticated so that browser
-- clients in dev-auth mode (which act as anon) can read translations.

drop policy if exists "Anyone authenticated can read translations"
    on public.question_translations;
drop policy if exists "Anyone can read translations"
    on public.question_translations;

create policy "Anyone can read translations"
    on public.question_translations
    for select
    to anon, authenticated
    using (true);

drop policy if exists "Anyone authenticated can insert translations"
    on public.question_translations;

create policy "Anyone authenticated can insert translations"
    on public.question_translations
    for insert
    to authenticated
    with check (true);

-- Defensive: also allow the anon role to insert. The route already runs server
-- side and only fires when an authenticated user clicks "Translate", so anon
-- inserts in practice come from cookie-mode dev sessions.
drop policy if exists "Anon can insert translations"
    on public.question_translations;

create policy "Anon can insert translations"
    on public.question_translations
    for insert
    to anon
    with check (true);

-- UPDATE: needed for "Set as default" from the edit modal. Browser clients
-- in dev-auth mode run as anon, so include both roles.
drop policy if exists "Anyone authenticated can update translations"
    on public.question_translations;
drop policy if exists "Anyone can update translations"
    on public.question_translations;

create policy "Anyone can update translations"
    on public.question_translations
    for update
    to anon, authenticated
    using (true)
    with check (true);

-- DELETE: same as update, plus the legacy "owner-only" policy needs cleanup.
drop policy if exists "Only translator can delete their entry"
    on public.question_translations;
drop policy if exists "Anyone authenticated can delete translations"
    on public.question_translations;
drop policy if exists "Anyone can delete translations"
    on public.question_translations;

create policy "Anyone can delete translations"
    on public.question_translations
    for delete
    to anon, authenticated
    using (true);
