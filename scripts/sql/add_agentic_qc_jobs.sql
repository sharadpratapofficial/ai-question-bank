-- Durable storage for Agentic QC runs. Previously jobs lived only on the local
-- filesystem (OS temp dir), which is ephemeral on Vercel — each serverless
-- invocation/deploy gets a fresh /tmp, so saved QC reports disappeared. The full
-- JobRecord snapshot is stored as jsonb in `data`; the executor write-behinds to
-- this table on every state change so reports survive across invocations.

CREATE TABLE IF NOT EXISTS public.agentic_qc_jobs (
    id          uuid PRIMARY KEY,
    user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    label       text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'queued',
    data        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aqj_user_created ON public.agentic_qc_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aqj_status ON public.agentic_qc_jobs(status);

ALTER TABLE public.agentic_qc_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aqj_select ON public.agentic_qc_jobs;
DROP POLICY IF EXISTS aqj_insert ON public.agentic_qc_jobs;
DROP POLICY IF EXISTS aqj_update ON public.agentic_qc_jobs;
DROP POLICY IF EXISTS aqj_delete ON public.agentic_qc_jobs;
CREATE POLICY aqj_select ON public.agentic_qc_jobs FOR SELECT USING (true);
CREATE POLICY aqj_insert ON public.agentic_qc_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY aqj_update ON public.agentic_qc_jobs FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY aqj_delete ON public.agentic_qc_jobs FOR DELETE USING (true);
