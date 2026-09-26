/**
 * POST /api/agentic-qc/jobs/[id]/stop          → graceful cancel
 * POST /api/agentic-qc/jobs/[id]/stop?force=1  → force-mark as cancelled
 *
 * Graceful path: sets the cancellation flag + aborts all in-flight LLM
 * fetches via the per-job AbortController. Most stops settle within
 * milliseconds because every fetch is now sharing a single abort signal
 * AND has a per-call timeout cap of ~4 minutes.
 *
 * Force path: in addition to the above, immediately writes
 * status="cancelled" to disk and emits a cancelled event. This is the
 * escape-hatch for cases where the executor is somehow wedged (rare, but
 * the UI needs a way out). The executor may still be running in the
 * background; it'll notice the flag and unwind, but the user-facing state
 * is already "done — cancelled".
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import {
    requestCancel,
    updateJob,
    emitEvent,
    getJob,
    clearAbortController,
} from "@/lib/agenticQC/jobStore";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user)
        return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    const { id } = await params;
    const force = req.nextUrl.searchParams.get("force") === "1";

    const existing = await getJob(user.id, id);
    if (!existing)
        return NextResponse.json(
            { success: false, error: "Job not found." },
            { status: 404 }
        );

    // Always attempt the graceful path first (so in-flight fetches are aborted).
    await requestCancel(user.id, id);

    if (force) {
        // Slam the job into cancelled state regardless of executor progress.
        await updateJob(user.id, id, (j) => {
            if (j.status !== "done" && j.status !== "failed") {
                j.status = "cancelled";
                j.finishedAt = new Date().toISOString();
            }
        });
        await emitEvent(user.id, id, { type: "cancelled", forced: true });
        clearAbortController(id);
    }

    return NextResponse.json({ success: true, forced: force });
}
