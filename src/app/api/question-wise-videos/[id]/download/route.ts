/**
 * GET /api/question-wise-videos/[id]/download
 *
 * Returns a short-lived signed URL for the finished job's artifact (clips
 * ZIP if want_clips was true, else just timestamps.csv), read from
 * crop_result.storagePath. ?format=json returns { signedUrl } instead of
 * redirecting, for a client-side "Download" button.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARTIFACT_BUCKET = "question-video-artifacts";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const { id } = await params;
    const supabase = await createClient();
    const { data: row, error } = await supabase
        .from("question_video_jobs")
        .select("id, status, crop_result")
        .eq("id", id)
        .maybeSingle();

    if (error || !row) {
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    }
    if (row.status !== "done") {
        return NextResponse.json(
            { success: false, error: `Job is not done yet (status: ${row.status}).` },
            { status: 400 }
        );
    }
    const cropResult = (row.crop_result || {}) as { storagePath?: string };
    if (!cropResult.storagePath) {
        return NextResponse.json({ success: false, error: "This job has no stored artifact." }, { status: 404 });
    }

    const { data: signed, error: signErr } = await supabase.storage
        .from(ARTIFACT_BUCKET)
        .createSignedUrl(cropResult.storagePath, 60 * 60);
    if (signErr || !signed?.signedUrl) {
        return NextResponse.json(
            { success: false, error: signErr?.message || "Failed to sign URL." },
            { status: 500 }
        );
    }

    const fileName = cropResult.storagePath.split("/").pop() || "question-wise-videos.zip";
    const wantJson = request.nextUrl.searchParams.get("format") === "json";
    if (wantJson) {
        return NextResponse.json({ success: true, signedUrl: signed.signedUrl, fileName });
    }
    return NextResponse.redirect(signed.signedUrl, { status: 302 });
}
