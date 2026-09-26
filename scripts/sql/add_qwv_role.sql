-- Adds a narrow, single-feature role to public.user_role:
--   qwv_user - can use ONLY the Question Wise Videos tool
-- Paired with a new "use_question_wise_videos" permission in
-- src/lib/auth/permissions.ts (see ROLE_PERMISSIONS there for what the role
-- actually grants — this migration only adds the enum value so
-- public.user_profiles.role can hold it).
--
-- ADD VALUE must not be used in the same transaction it's referenced in, so
-- this file contains only the ALTER TYPE statement (same constraint the
-- qbg_user/video_user migration called out).

alter type public.user_role add value if not exists 'qwv_user';
