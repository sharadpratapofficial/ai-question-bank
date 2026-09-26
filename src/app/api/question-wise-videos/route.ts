/**
 * POST /api/question-wise-videos
 *
 * Body: { driveUrls: string[], wantClips: boolean }
 *
 * Starts one independent detection job per Drive link (multiple links are
 * processed as separate videos, each producing its own Q1, Q2, ... boundary
 * list — not stitched together). Returns one entry per submitted URL so the
 * client can report a per-link error without losing the jobs that did start.
 *
 * GET /api/question-wise-videos
 *
 * Lists the caller's past jobs (newest first) for the history panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { startDetectionJob, looksLikeDriveUrl } from "@/lib/api/questionWiseVideos";

export const maxDuration = 60; // route returns immediately; detection runs in background
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const body = (await request.json().catch(() => null)) as {
        driveUrls?: unknown;
        wantClips?: unknown;
        accuracy?: unknown;
    } | null;
    if (!body || !Array.isArray(body.driveUrls) || body.driveUrls.length === 0) {
        return NextResponse.json(
            { success: false, error: "driveUrls (non-empty array) is required." },
            { status: 400 }
        );
    }
    const driveUrls = body.driveUrls
        .map((u) => (typeof u === "string" ? u.trim() : ""))
        .filter(Boolean);
    if (driveUrls.length === 0) {
        return NextResponse.json(
            { success: false, error: "driveUrls (non-empty array) is required." },
            { status: 400 }
        );
    }
    const wantClips = body.wantClips !== false; // default true
    const accuracy = body.accuracy === "high" ? "high" : "fast";

    let userId: string | undefined;
    let supabaseAccessToken: string | undefined;
    try {
        const supabase = await createClient();
        const [{ data: { user } }, { data: { session } }] = await Promise.all([
            supabase.auth.getUser(),
            supabase.auth.getSession(),
        ]);
        userId = user?.id;
        supabaseAccessToken = session?.access_token;
    } catch {
        // fall through — startDetectionJob will fail per-link below if truly unconfigured
    }

    const results: { url: string; jobId?: string; error?: string }[] = [];
    for (const url of driveUrls) {
        if (!looksLikeDriveUrl(url)) {
            results.push({ url, error: "Doesn't look like a Google Drive share link." });
            continue;
        }
        try {
            const { jobId } = await startDetectionJob({ driveUrl: url, wantClips, accuracy, userId, supabaseAccessToken });
            results.push({ url, jobId });
        } catch (err) {
            results.push({ url, error: err instanceof Error ? err.message : String(err) });
        }
    }

    const anySucceeded = results.some((r) => r.jobId);
    return NextResponse.json(
        { success: anySucceeded, jobs: results },
        { status: anySucceeded ? 200 : 400 }
    );
}

export async function GET() {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ success: true, jobs: [] });
    }

    const { data, error } = await supabase
        .from("question_video_jobs")
        .select("id, source_url, video_label, want_clips, status, error, video_duration_sec, questions, crop_result, created_at, updated_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

    if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const jobs = (data || []).map((row) => ({
        jobId: row.id,
        sourceUrl: row.source_url,
        videoLabel: row.video_label,
        wantClips: row.want_clips,
        status: row.status,
        error: row.error,
        videoDurationSec: row.video_duration_sec,
        questionCount: Array.isArray(row.questions) ? row.questions.length : 0,
        cropResult: row.crop_result,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));

    return NextResponse.json({ success: true, jobs });
}
