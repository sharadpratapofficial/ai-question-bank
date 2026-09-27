/**
 * POST /api/question-media   (multipart/form-data: question_id, file)
 *
 * Stores one image for an existing question in the private question-media bucket
 * at newbank/<question_id>/<name>-<sha256 prefix>.<ext> and returns the path and
 * the src to put in the question HTML. Needs manual_question_entry, upload_pdf or
 * edit_metadata. Validates the bytes (PNG/JPEG/GIF/WebP, max 10 MB). Idempotent;
 * never overwrites. Rules: src/lib/questionMedia/core.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { denyMediaUpload, uploadQuestionMedia, QUESTION_MEDIA_MAX_BYTES } from "@/lib/questionMedia/core";
import { questionMediaStore, toNextResponse } from "@/lib/questionMedia/store";

export const dynamic = "force-dynamic";

/** Multipart overhead allowance on top of the file limit. */
const FORM_OVERHEAD_BYTES = 256 * 1024;

export async function POST(request: NextRequest) {
    try {
        const ctx = await getCurrentUserWithRole();
        // Refuse before reading the body.
        const denied = denyMediaUpload(ctx);
        if (denied) return toNextResponse(denied);
        const declaredLength = Number(request.headers.get("content-length") || 0);
        if (declaredLength > QUESTION_MEDIA_MAX_BYTES + FORM_OVERHEAD_BYTES) {
            return NextResponse.json({ success: false, error: "The file exceeds the 10 MB limit." }, { status: 413 });
        }

        let form: FormData;
        try {
            form = await request.formData();
        } catch {
            return NextResponse.json({ success: false, error: "Expected multipart/form-data with question_id and file." }, { status: 400 });
        }
        const file = form.get("file");
        const questionId = String(form.get("question_id") ?? "").trim();
        if (!(file instanceof File)) {
            return NextResponse.json({ success: false, error: "Missing file." }, { status: 400 });
        }
        if (file.size > QUESTION_MEDIA_MAX_BYTES) {
            return NextResponse.json({ success: false, error: "The file exceeds the 10 MB limit." }, { status: 413 });
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await uploadQuestionMedia(
            ctx,
            { questionId, originalName: file.name, bytes, declaredMime: file.type },
            questionMediaStore(ctx)
        );
        return toNextResponse(result);
    } catch (error) {
        console.error("POST /api/question-media failed:", error);
        return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
    }
}
