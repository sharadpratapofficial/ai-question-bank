/**
 * GET    /api/agentic-qc/jobs/[id]    → full job snapshot (per-question rows + events)
 * DELETE /api/agentic-qc/jobs/[id]    → delete a saved job
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getJobFresh, deleteJob, toClientView } from "@/lib/agenticQC/jobStore";

export const runtime = "nodejs";

async function authUserId(): Promise<string | null> {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    return user?.id || null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    const userId = await authUserId();
    if (!userId)
        return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    const { id } = await params;
    // Use the fresh reader: this route is a different module instance from the
    // SSE stream where the executor runs, so a cache-first read would freeze on
    // an early snapshot and never reflect live progress / the final status.
    const job = await getJobFresh(userId, id);
    if (!job)
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    return NextResponse.json({ success: true, job: toClientView(job) });
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    const userId = await authUserId();
    if (!userId)
        return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    const { id } = await params;
    const ok = await deleteJob(userId, id);
    if (!ok)
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    return NextResponse.json({ success: true });
}
