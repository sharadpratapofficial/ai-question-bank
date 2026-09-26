-- Allows AI Repeat Check reports to be stored in ai_reports.

alter table public.ai_reports
    drop constraint if exists ai_reports_report_type_check;

alter table public.ai_reports
    add constraint ai_reports_report_type_check
    check (report_type in ('qc', 'solution', 'modification', 'repeat_check', 'extraction'));
