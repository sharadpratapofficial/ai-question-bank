/**
 * POST /api/ai-tools/video-solution/slides
 *
 * Two input modes:
 *   multipart/form-data — one PDF or Word (.docx/.doc) file under
 *     "question_pdf". Shells out to slides_cli.py, which dispatches on the
 *     file extension: .pdf goes through the PyMuPDF column-crop pipeline,
 *     .docx/.doc through the LibreOffice-backed docx pipeline.
 *   application/json — { qbg_ids: string } (comma/newline-separated QBG
 *     unique_ids). Fetches the questions from QBG (qbg_source.py) and
 *     builds a synthetic question-paper docx, then reuses the same
 *     docx pipeline.
 *
 * Response: application/vnd.openxmlformats-officedocument.presentationml.presentation
 *           Content-Disposition: attachment; filename="<base>.pptx"
 *           X-Question-Count, X-Missing-Ids, X-Skipped-Unsupported (JSON) headers
 *
 * Synchronous and quick (~5-10 s for a 25-question paper).
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys, parseQbgProviderConfig } from "@/lib/userApiKeys";
import { generateSlides, type QbgCreds } from "@/lib/api/videoSolution";

export const maxDuration = 120;
export const runtime = "nodejs";

async function resolveQbgCreds(request: NextRequest): Promise<QbgCreds | undefined> {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        const keys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
        return parseQbgProviderConfig(keys.qbg);
    }
    const isDev = request.cookies.get("qbg_dev_auth")?.value === "1";
    if (isDev) {
        const rawQbg = request.headers.get("x-dev-qbg")?.trim();
        if (rawQbg) return parseQbgProviderConfig(rawQbg);
    }
    return undefined;
}

function jsonReport(headers: Headers, out: { questionCount: number; missingIds?: string[]; skippedUnsupported?: { qbgId: string; reason: string }[] }) {
    headers.set("X-Question-Count", String(out.questionCount));
    if (out.missingIds?.length) headers.set("X-Missing-Ids", JSON.stringify(out.missingIds));
    if (out.skippedUnsupported?.length) headers.set("X-Skipped-Unsupported", JSON.stringify(out.skippedUnsupported));
}

export async function POST(request: NextRequest) {
    const forbid = await checkAnyPermission(["use_video_solution", "use_qbg"]);
    if (forbid) return forbid;

    const isJson = (request.headers.get("content-type") || "").includes("application/json");

    if (isJson) {
        const body = (await request.json().catch(() => null)) as { qbg_ids?: string } | null;
        const qbgIds = (body?.qbg_ids || "")
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (qbgIds.length === 0) {
            return NextResponse.json(
                { success: false, error: "qbg_ids is required (at least one QBG unique_id)." },
                { status: 400 }
            );
        }
        const qbgCreds = await resolveQbgCreds(request);
        if (!(qbgCreds && qbgCreds.token && qbgCreds.user && qbgCreds.userId)) {
            return NextResponse.json(
                { success: false, error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API." },
                { status: 400 }
            );
        }

        try {
            const out = await generateSlides({ source: "qbg", qbgIds, qbgCreds });
            const headers = new Headers({
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "Content-Disposition": `attachment; filename="${out.pptxName}"`,
            });
            jsonReport(headers, out);
            return new NextResponse(out.pptxBuffer as unknown as ArrayBuffer, { status: 200, headers });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return NextResponse.json(
                { success: false, error: `Slides generation failed: ${msg}` },
                { status: 500 }
            );
        }
    }

    const form = await request.formData().catch(() => null);
    if (!form) {
        return NextResponse.json(
            { success: false, error: "Expected multipart/form-data or application/json." },
            { status: 400 }
        );
    }
    const file = form.get("question_pdf");
    if (!(file instanceof File)) {
        return NextResponse.json(
            { success: false, error: "Field 'question_pdf' is required." },
            { status: 400 }
        );
    }
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".pdf") && !lowerName.endsWith(".docx") && !lowerName.endsWith(".doc")) {
        return NextResponse.json(
            { success: false, error: "Only .pdf, .docx, or .doc files are accepted." },
            { status: 400 }
        );
    }
    if (file.size > 50 * 1024 * 1024) {
        return NextResponse.json(
            { success: false, error: "File too large (max 50 MB)." },
            { status: 413 }
        );
    }

    try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const out = await generateSlides({
            source: "pdf",
            questionPdfBuffer: buffer,
            questionPdfName: file.name,
        });
        const headers = new Headers({
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "Content-Disposition": `attachment; filename="${out.pptxName}"`,
        });
        jsonReport(headers, out);
        return new NextResponse(out.pptxBuffer as unknown as ArrayBuffer, { status: 200, headers });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { success: false, error: `Slides generation failed: ${msg}` },
            { status: 500 }
        );
    }
}
