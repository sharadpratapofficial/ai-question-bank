-- Stores every PDF extraction the user runs, so they can navigate away while it
-- finishes and come back later to review + save the questions into qbg_questions.

CREATE TYPE public.extraction_report_status AS ENUM (
    'queued', 'processing', 'completed', 'failed', 'saved', 'discarded'
);

CREATE TABLE IF NOT EXISTS public.pdf_extraction_reports (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    user_email            text,
    source_name           text NOT NULL,
    mode                  text NOT NULL CHECK (mode IN ('single','dual')),
    provider              text NOT NULL,
    model_id              text,
    questions_pdf_name    text,
    questions_pdf_size    integer,
    solutions_pdf_name    text,
    solutions_pdf_size    integer,
    status                public.extraction_report_status NOT NULL DEFAULT 'queued',
    pdf_type              text,
    total_pages           integer,
    warnings              jsonb,
    error                 text,
    extracted_questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
    saved_question_ids    jsonb,
    saved_at              timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_per_user_created ON public.pdf_extraction_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_per_status ON public.pdf_extraction_reports(status);

CREATE OR REPLACE FUNCTION public.fn_pdf_extraction_reports_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_per_touch_updated_at ON public.pdf_extraction_reports;
CREATE TRIGGER trg_per_touch_updated_at
BEFORE UPDATE ON public.pdf_extraction_reports
FOR EACH ROW EXECUTE FUNCTION public.fn_pdf_extraction_reports_touch_updated_at();

ALTER TABLE public.pdf_extraction_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_select ON public.pdf_extraction_reports;
DROP POLICY IF EXISTS per_insert ON public.pdf_extraction_reports;
DROP POLICY IF EXISTS per_update ON public.pdf_extraction_reports;
DROP POLICY IF EXISTS per_delete ON public.pdf_extraction_reports;
CREATE POLICY per_select ON public.pdf_extraction_reports FOR SELECT USING (true);
CREATE POLICY per_insert ON public.pdf_extraction_reports FOR INSERT WITH CHECK (true);
CREATE POLICY per_update ON public.pdf_extraction_reports FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY per_delete ON public.pdf_extraction_reports FOR DELETE USING (true);
