/**
 * GET /api/questions/[id]/history
 *
 * Returns the chronological history for a single question:
 *   - status_transitions: every workflow status change (with actor identity)
 *   - edit_history: full-row snapshots from every INSERT/UPDATE (with editor identity)
 *
 * Anyone with `view_questions` (every signed-in role) can read history.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";

const TRANSITIONS_TABLE = "question_status_transitions";
const HISTORY_TABLE = "question_edit_history";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("view_questions");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id?.trim()) {
        return NextResponse.json(
            { success: false, error: "Question id is required." },
            { status: 400 }
        );
    }

    const supabase = await createServerClient();

    const [{ data: transitions, error: tErr }, { data: edits, error: eErr }] =
        await Promise.all([
            supabase
                .from(TRANSITIONS_TABLE)
                .select("*")
                .eq("question_id", id)
                .order("created_at", { ascending: true }),
            supabase
                .from(HISTORY_TABLE)
                .select("*")
                .eq("question_id", id)
                .order("created_at", { ascending: true }),
        ]);

    if (tErr || eErr) {
        return NextResponse.json(
            {
                success: false,
                error: tErr?.message || eErr?.message || "Failed to load history.",
            },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        status_transitions: transitions ?? [],
        edit_history: edits ?? [],
    });
}
