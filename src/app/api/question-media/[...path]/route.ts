/**
 * GET /api/question-media/newbank/<question_id>/<file name>
 *
 * The stable URL that question HTML uses for new-bank images. Checks the caller
 * (the qbg_questions read permissions), then redirects to a signed URL that
 * expires after a few minutes. The bucket is private; no public URL exists.
 * Rules: src/lib/questionMedia/core.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { readQuestionMedia } from "@/lib/questionMedia/core";
import { questionMediaStore, toNextResponse } from "@/lib/questionMedia/store";

export const dynamic = "force-dynamic";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
) {
    try {
        const { path } = await params;
        const ctx = await getCurrentUserWithRole();
        return toNextResponse(await readQuestionMedia(ctx, (path || []).join("/"), questionMediaStore(ctx)));
    } catch (error) {
        console.error("GET /api/question-media failed:", error);
        return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
    }
}
