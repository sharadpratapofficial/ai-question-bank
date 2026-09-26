-- Stores every Question Wise Videos job (one row per submitted Drive link),
-- so the user can navigate away while detection/cropping runs and come back
-- later to review + confirm boundaries, or download the finished clips.

CREATE TYPE public.question_video_job_status AS ENUM (
    'queued', 'downloading', 'detecting', 'ready_for_review', 'cropping', 'done', 'failed', 'discarded'
);

CREATE TABLE IF NOT EXISTS public.question_video_jobs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    source_url         text NOT NULL,
    video_label        text,
    want_clips         boolean NOT NULL DEFAULT true,
    status             public.question_video_job_status NOT NULL DEFAULT 'queued',
    error              text,
    log                text,
    video_duration_sec numeric,
    questions          jsonb NOT NULL DEFAULT '[]'::jsonb,
    crop_result        jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qvj_per_user_created ON public.question_video_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qvj_per_status ON public.question_video_jobs(status);

CREATE OR REPLACE FUNCTION public.fn_question_video_jobs_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_qvj_touch_updated_at ON public.question_video_jobs;
CREATE TRIGGER trg_qvj_touch_updated_at
BEFORE UPDATE ON public.question_video_jobs
FOR EACH ROW EXECUTE FUNCTION public.fn_question_video_jobs_touch_updated_at();

ALTER TABLE public.question_video_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qvj_select ON public.question_video_jobs;
DROP POLICY IF EXISTS qvj_insert ON public.question_video_jobs;
DROP POLICY IF EXISTS qvj_update ON public.question_video_jobs;
DROP POLICY IF EXISTS qvj_delete ON public.question_video_jobs;
CREATE POLICY qvj_select ON public.question_video_jobs FOR SELECT USING (true);
CREATE POLICY qvj_insert ON public.question_video_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY qvj_update ON public.question_video_jobs FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY qvj_delete ON public.question_video_jobs FOR DELETE USING (true);
