/**
 * POST /api/questions/[id]/status
 *
 * Transition a question between QC workflow statuses. Enforces both:
 *   1. The legal state-machine transitions
 *   2. The Permission required for that specific transition (per role)
 *
 * Body: { to_status: QuestionStatus, note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { getCurrentUserWithRole, forbiddenResponse, ForbiddenError } from "@/lib/auth/serverAuth";
import {
    hasPermission,
    type Permission,
} from "@/lib/auth/permissions";
import type { QuestionStatus } from "@/types";
import { ALL_QUESTION_STATUSES } from "@/types";

const TABLE = "qbg_questions";
const TRANSITIONS_TABLE = "question_status_transitions";

// Permission required for each (from -> to) transition.
function permissionForTransition(
    from: QuestionStatus,
    to: QuestionStatus
): Permission | null {
    if (to === "rejected") return "reject_question";
    if (from === "verification_pending" && to === "verified") return "verify_qc1";
    if (from === "verified" && to === "double_verified") return "verify_qc2";
    if (from === "double_verified" && to === "uat_passed") return "verify_uat";
    if (from === "rejected" && to === "verification_pending") return "submit_for_verification";
    return null; // illegal
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const ctx = await getCurrentUserWithRole();
        if (!ctx.isAuthenticated) {
            throw new ForbiddenError("view_questions");
        }

        const { id } = await params;
        if (!id?.trim()) {
            return NextResponse.json(
                { success: false, error: "Question id is required." },
                { status: 400 }
            );
        }

        let body: { to_status?: string; note?: string };
        try {
            body = (await request.json()) as { to_status?: string; note?: string };
        } catch {
            return NextResponse.json(
                { success: false, error: "Invalid JSON payload." },
                { status: 400 }
            );
        }

        const toStatus = body.to_status as QuestionStatus | undefined;
        if (!toStatus || !(ALL_QUESTION_STATUSES as string[]).includes(toStatus)) {
            return NextResponse.json(
                { success: false, error: `Invalid to_status. Allowed: ${ALL_QUESTION_STATUSES.join(", ")}` },
                { status: 400 }
            );
        }

        const note = typeof body.note === "string" ? body.note.trim() || null : null;

        const supabase = await createServerClient();

        // Read current row to determine fromStatus.
        const { data: current, error: readErr } = await supabase
            .from(TABLE)
            .select("question_id, status")
            .eq("question_id", id)
            .maybeSingle();

        if (readErr) {
            return NextResponse.json(
                { success: false, error: `Failed to load question: ${readErr.message}` },
                { status: 500 }
            );
        }
        if (!current) {
            return NextResponse.json(
                { success: false, error: "Question not found." },
                { status: 404 }
            );
        }

        const fromStatus = current.status as QuestionStatus;

        if (fromStatus === toStatus) {
            return NextResponse.json(
                { success: false, error: `Question is already in '${toStatus}'.` },
                { status: 400 }
            );
        }

        const requiredPerm = permissionForTransition(fromStatus, toStatus);
        if (!requiredPerm) {
            return NextResponse.json(
                {
                    success: false,
                    error: `Illegal transition: ${fromStatus} -> ${toStatus}.`,
                },
                { status: 400 }
            );
        }

        if (!ctx.permissions.includes(requiredPerm)) {
            throw new ForbiddenError(requiredPerm);
        }

        // Update the question row. The snapshot trigger fires too, so the edit
        // history will also reflect the status change with the editor stamped.
        const now = new Date().toISOString();
        const { error: updateErr } = await supabase
            .from(TABLE)
            .update({
                status: toStatus,
                last_modified_by: ctx.userId,
                last_modified_at: now,
            })
            .eq("question_id", id);

        if (updateErr) {
            return NextResponse.json(
                { success: false, error: `Failed to update status: ${updateErr.message}` },
                { status: 500 }
            );
        }

        // Insert the transition log row. Snapshot the actor identity so it
        // survives user deletion.
        const { data: transition, error: insertErr } = await supabase
            .from(TRANSITIONS_TABLE)
            .insert({
                question_id: id,
                from_status: fromStatus,
                to_status: toStatus,
                actor_user_id: ctx.userId,
                actor_email: ctx.email,
                actor_display_name: null,
                actor_role: ctx.role,
                note,
            })
            .select("*")
            .maybeSingle();

        if (insertErr) {
            // Status was updated but log failed — log + surface; don't roll back
            // the status change because the audit gap is recoverable but reverting
            // the user's QC action would be confusing.
            console.error("status transition logged failure:", insertErr);
        }

        return NextResponse.json({
            success: true,
            from_status: fromStatus,
            to_status: toStatus,
            transition,
        });
    } catch (err) {
        const f = forbiddenResponse(err);
        if (f) return f;
        return NextResponse.json(
            {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 }
        );
    }
}
