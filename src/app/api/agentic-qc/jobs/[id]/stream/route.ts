/**
 * GET /api/agentic-qc/jobs/[id]/stream
 *
 * Server-Sent Events stream for a single job. On connect we immediately
 * replay the full job state (so the UI can render the dashboard from
 * scratch even mid-run), then forward live events as the executor publishes
 * them. The stream closes when the job reaches a terminal status, OR when
 * the client disconnects.
 *
 * The executor writes to disk on every state change, so a client can:
 *   - close this stream (e.g. navigate away)
 *   - reopen it later
 *   - and get the full current state + any subsequent events
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import { getJobFresh, subscribe, toClientView } from "@/lib/agenticQC/jobStore";
import { runJob } from "@/lib/agenticQC/executor";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — plan max; client reconnects to resume longer runs

/**
 * Jobs currently being driven by THIS serverless instance. Vercel can't run
 * detached background work, so the executor runs inside this live SSE
 * connection (where its in-process events reach the subscriber below). This
 * guard prevents a second connection on the same instance from starting a
 * duplicate run; if the 300s window ends, the browser's EventSource auto-
 * reconnects and a fresh invocation resumes the remaining questions.
 */
const activeRuns = new Set<string>();

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user)
        return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });

    const { id: jobId } = await params;
    const job = await getJobFresh(user.id, jobId);
    if (!job)
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (data: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                } catch {
                    // Stream closed by client — swallow.
                }
            };

            // ── Initial snapshot ───────────────────────────────────────
            send({ type: "snapshot", job: toClientView(job) });

            // If the job already terminated, replay events then close.
            const terminal =
                job.status === "done" ||
                job.status === "failed" ||
                job.status === "cancelled";
            if (terminal) {
                for (const ev of job.events) send(ev);
                send({ type: "stream_end", final: true });
                controller.close();
                return;
            }

            // Replay any events that may have accumulated between creation
            // and now (rare race but harmless to repeat — client is idempotent).
            for (const ev of job.events) send(ev);

            // ── Live subscription ──────────────────────────────────────
            const unsubscribe = subscribe(jobId, (ev) => {
                send(ev);
                // Close the stream when the job hits a terminal state.
                if (
                    ev.type === "complete" ||
                    ev.type === "fatal_error" ||
                    ev.type === "cancelled"
                ) {
                    // Push one final "stream_end" so the client knows it's done.
                    send({ type: "stream_end", final: true });
                    unsubscribe();
                    try {
                        controller.close();
                    } catch {
                        // already closed
                    }
                }
            });

            // ── Drive the executor in-process ───────────────────────────
            // On Vercel there's no detached background work: the old
            // "fire-and-forget from POST" was frozen the moment POST
            // responded, so jobs never progressed. We run the executor HERE,
            // inside the live connection, so its events reach the subscriber
            // above. runJob is resumable (skips finished questions), so when
            // this 300s window ends and the browser auto-reconnects, a fresh
            // invocation continues the remaining work.
            if (
                (job.status === "queued" ||
                    job.status === "running" ||
                    job.status === "cancelling") &&
                !activeRuns.has(jobId)
            ) {
                activeRuns.add(jobId);
                const apiKeys = sanitizeUserApiKeys(
                    user.user_metadata?.api_keys
                ) as unknown as Record<string, string>;
                const ei = job.execInput;
                void runJob({
                    userId: user.id,
                    jobId,
                    apiKeys,
                    parsedQuestions: ei?.parsedQuestions,
                    files: ei?.files,
                    inputMode: job.inputMode,
                    examType: job.examType,
                    customQuestionTypeSequence: job.customQuestionTypeSequence,
                    subjects: job.subjects,
                    syllabus: job.syllabus,
                    qcAgents: job.qcAgents,
                    aggregator: job.aggregator,
                })
                    .catch((err) => {
                        console.error("[agentic-qc] stream-driven runJob threw", err);
                    })
                    .finally(() => {
                        activeRuns.delete(jobId);
                    });
            }

            // Heartbeat every 25s to keep proxies from killing the connection.
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(`:heartbeat\n\n`));
                } catch {
                    clearInterval(heartbeat);
                    unsubscribe();
                }
            }, 25000);
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
        },
    });
}
