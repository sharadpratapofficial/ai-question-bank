/**
 * GET /api/ai-tools/video-solution/videos/[id]/download
 *
 * Streams the ZIP of MP4s produced by a completed video job back to the
 * browser. Returns 404 until the job's state is "done".
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { readJobZip } from "@/lib/api/videoSolution";

export const runtime = "nodejs";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkAnyPermission(["use_video_solution", "use_qbg"]);
    if (forbid) return forbid;

    const { id } = await params;
    const zip = await readJobZip(id);
    if (!zip) {
        return NextResponse.json(
            { success: false, error: "Job not ready or not found." },
            { status: 404 }
        );
    }
    return new NextResponse(zip.buffer as unknown as ArrayBuffer, {
        status: 200,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${zip.name}"`,
        },
    });
}
