/**
 * POST /api/question-wise-videos/[id]/confirm
 *
 * Body: { questions: [{ index, startSec, endSec }, ...] }
 *
 * Writes the caller's (possibly edited) boundary list onto the job row and
 * starts the crop phase. If the job's want_clips is false, this only
 * produces a downloadable timestamps.csv (no video re-encoding) — handled
 * inside startCropJob.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { startCropJob, type QuestionBoundary } from "@/lib/api/questionWiseVideos";

export const maxDuration = 60; // route returns immediately; cropping runs in background
export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { questions?: unknown } | null;
    if (!body || !Array.isArray(body.questions) || body.questions.length === 0) {
        return NextResponse.json(
            { success: false, error: "questions (non-empty array) is required." },
            { status: 400 }
        );
    }

    const questions: QuestionBoundary[] = [];
    for (const raw of body.questions) {
        const q = raw as Record<string, unknown>;
        const index = Number(q.index);
        const startSec = Number(q.startSec);
        const endSec = Number(q.endSec);
        if (!Number.isFinite(index) || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
            return NextResponse.json(
                { success: false, error: `Invalid question boundary: ${JSON.stringify(raw)}` },
                { status: 400 }
            );
        }
        questions.push({ index, startSec, endSec, thumbPath: typeof q.thumbPath === "string" ? q.thumbPath : undefined });
    }
    questions.sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < questions.length; i++) {
        // A question may end BEFORE the next one starts (the silent transition
        // gap is intentionally trimmed off), but it must never end AFTER the
        // next one starts — that would overlap the following question.
        if (questions[i - 1].endSec > questions[i].startSec) {
            return NextResponse.json(
                {
                    success: false,
                    error: `Boundary overlap between question ${questions[i - 1].index} and ${questions[i].index} — a question's end can't run past the next question's start.`,
                },
                { status: 400 }
            );
        }
    }

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
        // fall through
    }

    try {
        await startCropJob({ jobId: id, questions, userId, supabaseAccessToken });
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
