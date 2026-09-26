-- Private Storage bucket for AI Video Solution artifacts (rendered ZIPs of
-- MP4s, generated PPTX decks). Layout: <user_id>/<job_id>/<filename>.
--
-- The API layer (Next.js routes) gates ALL writes via checkPermission, so
-- the policies below are intentionally permissive on the bucket id only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-video-artifacts', 'ai-video-artifacts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS ai_video_artifacts_select ON storage.objects;
DROP POLICY IF EXISTS ai_video_artifacts_insert ON storage.objects;
DROP POLICY IF EXISTS ai_video_artifacts_update ON storage.objects;
DROP POLICY IF EXISTS ai_video_artifacts_delete ON storage.objects;

CREATE POLICY ai_video_artifacts_select ON storage.objects FOR SELECT
    USING (bucket_id = 'ai-video-artifacts');
CREATE POLICY ai_video_artifacts_insert ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'ai-video-artifacts');
CREATE POLICY ai_video_artifacts_update ON storage.objects FOR UPDATE
    USING (bucket_id = 'ai-video-artifacts') WITH CHECK (bucket_id = 'ai-video-artifacts');
CREATE POLICY ai_video_artifacts_delete ON storage.objects FOR DELETE
    USING (bucket_id = 'ai-video-artifacts');
