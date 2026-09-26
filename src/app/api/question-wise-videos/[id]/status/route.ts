/**
 * GET /api/question-wise-videos/[id]/status
 *
 * Row snapshot for a job: status, accumulated log, video duration, and the
 * boundary list — with each question's thumbnail resolved to a short-lived
 * signed URL (once detection has uploaded it) so the review UI can render it
 * directly from Storage.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ARTIFACT_BUCKET = "question-video-artifacts";

interface QuestionRow {
    index: number;
    startSec: number;
    endSec: number;
    thumbPath?: string;
}

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const { id } = await params;
    const supabase = await createClient();
    const { data: row, error } = await supabase
        .from("question_video_jobs")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error || !row) {
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    }

    const questions: QuestionRow[] = Array.isArray(row.questions) ? row.questions : [];
    const withThumbs = await Promise.all(
        questions.map(async (q) => {
            if (!q.thumbPath) return { ...q, thumbUrl: null };
            const { data: signed } = await supabase.storage
                .from(ARTIFACT_BUCKET)
                .createSignedUrl(q.thumbPath, 60 * 60);
            return { ...q, thumbUrl: signed?.signedUrl || null };
        })
    );

    return NextResponse.json({
        success: true,
        jobId: row.id,
        sourceUrl: row.source_url,
        wantClips: row.want_clips,
        status: row.status,
        log: row.log || "",
        error: row.error,
        videoDurationSec: row.video_duration_sec,
        questions: withThumbs,
        cropResult: row.crop_result,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
