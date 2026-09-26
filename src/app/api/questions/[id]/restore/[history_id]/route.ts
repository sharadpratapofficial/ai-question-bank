/**
 * POST /api/questions/[id]/restore/[history_id]
 *
 * Admin-only: roll a question back to the state captured in a question_edit_history
 * snapshot. Status, created_by are preserved; last_modified_* are stamped fresh.
 *
 * Delegates to the SECURITY DEFINER RPC admin_restore_question_version which both
 * enforces the admin check via auth.uid() and writes the new history row with
 * change_type='restore'.
 *
 * Body: { note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; history_id: string }> }
) {
    const forbid = await checkPermission("restore_question_version");
    if (forbid) return forbid;

    const { id, history_id } = await params;
    if (!id?.trim() || !history_id?.trim()) {
        return NextResponse.json(
            { success: false, error: "question id and history_id are required." },
            { status: 400 }
        );
    }

    let body: { note?: string };
    try {
        body = (await request.json().catch(() => ({}))) as { note?: string };
    } catch {
        body = {};
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    const supabase = await createServerClient();
    const { data, error } = await supabase.rpc("admin_restore_question_version", {
        p_history_id: history_id,
        p_note: note,
    });

    if (error) {
        const status =
            error.code === "42501" ? 403 :
            error.code === "02000" ? 404 :
            500;
        return NextResponse.json(
            { success: false, error: error.message || "Restore failed." },
            { status }
        );
    }

    return NextResponse.json({ success: true, question_id: data });
}
