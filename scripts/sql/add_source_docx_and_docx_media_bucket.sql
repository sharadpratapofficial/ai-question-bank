-- Per-question raw-OOXML payload (only set for questions ingested from .docx).
-- Holds the paragraphs + media references needed to reproduce the question
-- inside a Word output later.
ALTER TABLE public.qbg_questions
    ADD COLUMN IF NOT EXISTS source_docx jsonb;

-- Private Storage bucket for docx media binaries (WMF, JPEG, PNG, OLE).
INSERT INTO storage.buckets (id, name, public)
VALUES ('docx-media', 'docx-media', false)
ON CONFLICT (id) DO NOTHING;

-- Permissive RLS (API gates the writes via checkPermission).
DROP POLICY IF EXISTS docx_media_select ON storage.objects;
DROP POLICY IF EXISTS docx_media_insert ON storage.objects;
DROP POLICY IF EXISTS docx_media_update ON storage.objects;
DROP POLICY IF EXISTS docx_media_delete ON storage.objects;

CREATE POLICY docx_media_select ON storage.objects FOR SELECT
    USING (bucket_id = 'docx-media');
CREATE POLICY docx_media_insert ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'docx-media');
CREATE POLICY docx_media_update ON storage.objects FOR UPDATE
    USING (bucket_id = 'docx-media') WITH CHECK (bucket_id = 'docx-media');
CREATE POLICY docx_media_delete ON storage.objects FOR DELETE
    USING (bucket_id = 'docx-media');
