-- Question lifecycle: status enum, audit columns, transition log, edit-history snapshot table + trigger.
-- Apply order:
--   1. ALTER TYPE public.user_role ADD VALUE 'qc_reviewer'   <-- must run on its own (autocommit)
--   2. Apply the rest of this file as a single migration.

-- 0) The qc_reviewer role addition (run separately, not inside a transaction):
--    ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'qc_reviewer';

-- 1) Status enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_status') THEN
        CREATE TYPE public.question_status AS ENUM (
            'verification_pending', 'verified', 'double_verified', 'uat_passed', 'rejected'
        );
    END IF;
END $$;

-- 2) Add identity + status columns to qbg_questions
ALTER TABLE public.qbg_questions
    ADD COLUMN IF NOT EXISTS status public.question_status NOT NULL DEFAULT 'verification_pending',
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_modified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_modified_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_qbg_questions_status ON public.qbg_questions(status);

-- 3) Backfill existing rows from raw_data.verification_status
UPDATE public.qbg_questions
SET status = CASE
    WHEN (raw_data->0->>'verification_status')::int = 1 THEN 'verified'::public.question_status
    ELSE 'verification_pending'::public.question_status
END
WHERE created_by IS NULL;

-- 4) Status transition log (immutable)
CREATE TABLE IF NOT EXISTS public.question_status_transitions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id         uuid NOT NULL REFERENCES public.qbg_questions(question_id) ON DELETE CASCADE,
    from_status         public.question_status,
    to_status           public.question_status NOT NULL,
    actor_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_email         text,
    actor_display_name  text,
    actor_role          public.user_role,
    note                text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qst_question_id ON public.question_status_transitions(question_id, created_at DESC);

-- 5) Full-snapshot edit history (immutable)
CREATE TABLE IF NOT EXISTS public.question_edit_history (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id         uuid NOT NULL REFERENCES public.qbg_questions(question_id) ON DELETE CASCADE,
    editor_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    editor_email        text,
    editor_display_name text,
    editor_role         public.user_role,
    change_type         text NOT NULL CHECK (change_type IN ('create','update','restore')),
    snapshot            jsonb NOT NULL,
    changed_fields      text[],
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qeh_question_id ON public.question_edit_history(question_id, created_at DESC);

-- 6) Trigger function: capture a snapshot on every INSERT/UPDATE.
-- auth.uid() pulls the user from the JWT when called through PostgREST.
-- API routes that want to mark the change as a 'restore' can set the session GUC:
--   SET LOCAL app.snapshot_change_type = 'restore';
CREATE OR REPLACE FUNCTION public.fn_capture_question_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid     uuid := auth.uid();
    v_profile public.user_profiles%ROWTYPE;
    v_changed text[];
    v_op      text;
BEGIN
    IF v_uid IS NOT NULL THEN
        SELECT * INTO v_profile FROM public.user_profiles WHERE user_id = v_uid;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_op := 'create';
    ELSE
        v_op := 'update';
        SELECT array_agg(key) INTO v_changed
        FROM jsonb_each(to_jsonb(NEW)) AS j(key, val)
        WHERE to_jsonb(NEW)->key IS DISTINCT FROM to_jsonb(OLD)->key;
    END IF;

    BEGIN
        IF current_setting('app.snapshot_change_type', true) IN ('restore') THEN
            v_op := current_setting('app.snapshot_change_type', true);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    INSERT INTO public.question_edit_history (
        question_id, editor_user_id, editor_email, editor_display_name, editor_role,
        change_type, snapshot, changed_fields
    ) VALUES (
        NEW.question_id,
        v_uid,
        v_profile.email,
        v_profile.display_name,
        v_profile.role,
        v_op,
        to_jsonb(NEW),
        v_changed
    );

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_qbg_questions_snapshot ON public.qbg_questions;
CREATE TRIGGER trg_qbg_questions_snapshot
AFTER INSERT OR UPDATE ON public.qbg_questions
FOR EACH ROW EXECUTE FUNCTION public.fn_capture_question_snapshot();

-- 7) Permissive RLS (gating happens in API routes)
ALTER TABLE public.question_status_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_edit_history       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qst_select ON public.question_status_transitions;
DROP POLICY IF EXISTS qst_insert ON public.question_status_transitions;
DROP POLICY IF EXISTS qeh_select ON public.question_edit_history;
DROP POLICY IF EXISTS qeh_insert ON public.question_edit_history;

CREATE POLICY qst_select ON public.question_status_transitions FOR SELECT USING (true);
CREATE POLICY qst_insert ON public.question_status_transitions FOR INSERT WITH CHECK (true);
CREATE POLICY qeh_select ON public.question_edit_history       FOR SELECT USING (true);
CREATE POLICY qeh_insert ON public.question_edit_history       FOR INSERT WITH CHECK (true);
