/**
 * GET    /api/upload/extract/reports/[id]
 * DELETE /api/upload/extract/reports/[id]    (soft delete via status='discarded')
 *
 * Owners + admins/managers can view & delete.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";

const TABLE = "pdf_extraction_reports";

async function loadReport(id: string) {
    const supabase = await createClient();
    const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("id", id)
        .maybeSingle();
    return { supabase, data, error };
}

function canAccess(report: { user_id: string | null }, ctx: { userId: string | null; role: string }): boolean {
    if (ctx.role === "admin" || ctx.role === "manager") return true;
    if (!ctx.userId) return false;
    return report.user_id === ctx.userId;
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const { data, error } = await loadReport(id);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });

    const ctx = await getCurrentUserWithRole();
    if (!canAccess(data, ctx)) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ success: true, report: data });
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const { supabase, data, error } = await loadReport(id);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });

    const ctx = await getCurrentUserWithRole();
    if (!canAccess(data, ctx)) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }
    if (data.status === "saved") {
        return NextResponse.json(
            { success: false, error: "Reports that have already been saved to the question bank cannot be discarded." },
            { status: 400 }
        );
    }

    const { error: updateErr } = await supabase
        .from(TABLE)
        .update({ status: "discarded" })
        .eq("id", id);

    if (updateErr) {
        return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
}
