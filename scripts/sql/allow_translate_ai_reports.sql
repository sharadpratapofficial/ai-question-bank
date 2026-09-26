-- Allows AI Translate reports to be stored in ai_reports.

ALTER TABLE public.ai_reports
    DROP CONSTRAINT IF EXISTS ai_reports_report_type_check;

ALTER TABLE public.ai_reports
    ADD CONSTRAINT ai_reports_report_type_check
    CHECK (report_type IN ('qc', 'solution', 'modification', 'repeat_check', 'extraction', 'translate'));
