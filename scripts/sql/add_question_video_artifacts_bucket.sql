-- Private Storage bucket for Question Wise Videos artifacts (per-question
-- review thumbnails, and the final clips ZIP + timestamps.csv).
-- Layout: <user_id>/<job_id>/<filename>.
--
-- The API layer (Next.js routes) gates ALL writes via checkPermission, so
-- the policies below are intentionally permissive on the bucket id only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('question-video-artifacts', 'question-video-artifacts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS question_video_artifacts_select ON storage.objects;
DROP POLICY IF EXISTS question_video_artifacts_insert ON storage.objects;
DROP POLICY IF EXISTS question_video_artifacts_update ON storage.objects;
DROP POLICY IF EXISTS question_video_artifacts_delete ON storage.objects;

CREATE POLICY question_video_artifacts_select ON storage.objects FOR SELECT
    USING (bucket_id = 'question-video-artifacts');
CREATE POLICY question_video_artifacts_insert ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'question-video-artifacts');
CREATE POLICY question_video_artifacts_update ON storage.objects FOR UPDATE
    USING (bucket_id = 'question-video-artifacts') WITH CHECK (bucket_id = 'question-video-artifacts');
CREATE POLICY question_video_artifacts_delete ON storage.objects FOR DELETE
    USING (bucket_id = 'question-video-artifacts');
