-- Adds a discriminator column so the pdf_extraction_reports table can host both
-- PDF and DOCX extractions. The column names questions_pdf_name /
-- solutions_pdf_name now hold the file name regardless of type.

ALTER TABLE public.pdf_extraction_reports
    ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'pdf'
    CHECK (document_type IN ('pdf', 'docx'));
