-- Adds a role that grants exactly BOTH QBG and Video Solution access (and
-- nothing else) — for a user who needs both features but not the rest of
-- AI Tools. See src/lib/auth/permissions.ts's ROLE_PERMISSIONS.qbg_video_user.
--
-- ADD VALUE must not be used in the same transaction it's referenced in, so
-- this file contains only the ALTER TYPE statement.

alter type public.user_role add value if not exists 'qbg_video_user';
