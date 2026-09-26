-- Adds two narrow, single-feature roles to public.user_role:
--   qbg_user   - can use ONLY the QBG hub (Pipeline/Modifier/Ingestion/Tagging)
--   video_user - can use ONLY the Video Solution tool
-- Paired with new "use_qbg" / "use_video_solution" permissions in
-- src/lib/auth/permissions.ts (see ROLE_PERMISSIONS there for what each role
-- actually grants — this migration only adds the enum values so
-- public.user_profiles.role can hold them).
--
-- ADD VALUE must not be used in the same transaction it's referenced in, so
-- this file contains only the two ALTER TYPE statements (nothing else touches
-- these values here) — same constraint the qc_reviewer migration called out.

alter type public.user_role add value if not exists 'qbg_user';
alter type public.user_role add value if not exists 'video_user';
