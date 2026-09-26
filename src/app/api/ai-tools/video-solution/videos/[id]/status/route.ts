/**
 * GET /api/ai-tools/video-solution/videos/[id]/status
 *
 * Returns the current state, accumulated log, video count (when done), and
 * error (if any) for a video-rendering job started via POST .../videos.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { getJob } from "@/lib/api/videoSolution";

export const runtime = "nodejs";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkAnyPermission(["use_video_solution", "use_qbg"]);
    if (forbid) return forbid;

    const { id } = await params;
    const job = await getJob(id);
    if (!job) {
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    }
    return NextResponse.json({
        success: true,
        jobId: job.jobId,
        state: job.state,
        log: job.log,
        videoCount: job.videoCount ?? 0,
        error: job.error,
        questionPdfName: job.questionPdfName,
        solutionsPdfName: job.solutionsPdfName,
        qbgIds: job.qbgIds,
        missingIds: job.missingIds,
        skippedUnsupported: job.skippedUnsupported,
        createdAt: job.createdAt,
    });
}
