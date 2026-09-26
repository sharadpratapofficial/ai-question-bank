/**
 * GET /api/ai-tools/video-solution/artifact?report_id=<uuid>
 *
 * Returns a short-lived signed URL for the ZIP that was uploaded to
 * Storage when the matching ai_reports row was created. The client follows
 * the redirect (or fetches and reads the JSON) to download directly from
 * Supabase — saves us streaming hundreds of MB through Node.
 *
 * Auth: the current session must own the report (RLS enforces this since we
 * pass the user's bearer token to the Supabase client).
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VideoReportData {
    storagePath?: string;
    questionPdfName?: string;
}

export async function GET(request: NextRequest) {
    const forbid = await checkPermission("use_video_solution");
    if (forbid) return forbid;

    const reportId = request.nextUrl.searchParams.get("report_id");
    if (!reportId) {
        return NextResponse.json(
            { success: false, error: "report_id query param is required." },
            { status: 400 }
        );
    }

    const supabase = await createClient();
    const { data: row, error } = await supabase
        .from("ai_reports")
        .select("id, user_id, report_type, file_name, report_data")
        .eq("id", reportId)
        .maybeSingle();

    if (error || !row) {
        return NextResponse.json(
            { success: false, error: error?.message || "Report not found." },
            { status: 404 }
        );
    }
    if (row.report_type !== "video") {
        return NextResponse.json(
            { success: false, error: "Not a video report." },
            { status: 400 }
        );
    }

    const reportData = (row.report_data || {}) as VideoReportData;
    const storagePath = reportData.storagePath;
    if (!storagePath) {
        return NextResponse.json(
            { success: false, error: "This report has no stored artifact." },
            { status: 404 }
        );
    }

    const { data: signed, error: signErr } = await supabase.storage
        .from("ai-video-artifacts")
        .createSignedUrl(storagePath, 60 * 60); // 1 hour
    if (signErr || !signed?.signedUrl) {
        return NextResponse.json(
            { success: false, error: signErr?.message || "Failed to sign URL." },
            { status: 500 }
        );
    }

    const wantJson = request.nextUrl.searchParams.get("format") === "json";
    if (wantJson) {
        return NextResponse.json({
            success: true,
            signedUrl: signed.signedUrl,
            fileName: row.file_name || "videos.zip",
        });
    }
    return NextResponse.redirect(signed.signedUrl, { status: 302 });
}
