/**
 * Shared client-side poll loop for the QBG async-job routes (qbg-modification,
 * qbg-tagging — both start a background job and expose GET ?jobId=... returning
 * {state:"running"|"done"|"error", progress?}). Extracted from the identical
 * poll loops duplicated in QbgModifierPanel.tsx and QbgTaggingPanel.tsx so the
 * QBG Pipeline panel can chain 2-3 of these in a row without re-copying the
 * sleep→GET→branch logic a third time.
 *
 * Not a React hook — it takes trackAsyncJob/forgetAsyncJob as plain function
 * params so callers just pass through what useAIJobQueue() already gave them.
 *
 * IMPORTANT: trackAsyncJob is OPTIONAL and the QBG Pipeline panel deliberately
 * does not pass it. The job routes this polls (qbg-modification, qbg-tagging)
 * delete their in-memory job the moment ANY caller reads its terminal state —
 * a one-shot read, not idempotent. AIJobQueueContext runs its own background
 * poller (every 4s, from localStorage, survives navigation) against every
 * tracked job's pollUrl; if a caller here ALSO registers via trackAsyncJob,
 * that background poller races this function's own poll loop for the same
 * URL, and whichever wins deletes the job — the loser gets a 404 with no way
 * to recover the payload. The standalone panels (QbgModifierPanel.tsx etc.)
 * tolerate that race because they treat a 404 as "already done, check
 * history" and don't need the inline payload. This pipeline DOES need it (to
 * chain Modify's new ids into Tag/QC), so its calls skip trackAsyncJob
 * entirely, making this function the only poller and the race impossible.
 */
import type { ProgressEvent } from "@/components/qbg/QbgProgressLog";

export interface AsyncJobStartResponse {
    success?: boolean;
    jobId?: string;
    error?: string;
}

export interface AsyncJobPollResponse<T> {
    success?: boolean;
    error?: string;
    state?: "running" | "done" | "error";
    progress?: ProgressEvent[];
}

export interface PollQbgJobOptions<T> {
    /** POST endpoint that starts the job, e.g. "/api/ai-tools/qbg-tagging". */
    startUrl: string;
    startBody: Record<string, unknown>;
    startHeaders?: Record<string, string>;
    /** Builds the GET poll URL from the jobId returned by the start call. */
    buildPollUrl: (jobId: string) => string;
    /** Registers with the cross-navigation async job tracker (floating
     *  notifier + survives page navigation). Omit this (and forgetAsyncJob)
     *  when the caller needs a reliable read of the terminal payload itself —
     *  see the file-level doc comment for why the two don't mix safely. */
    trackAsyncJob?: (job: { jobId: string; kind: string; label: string; pollUrl: string; startedAt: string }) => void;
    forgetAsyncJob?: (jobId: string) => void;
    kind: string;
    label: string;
    onProgress?: (progress: ProgressEvent[]) => void;
    /** Status line for things worth telling the user mid-wait (e.g. that the run
     *  overran the live poll and is being recovered from the task store). */
    onNote?: (message: string) => void;
    /** Safety cap; defaults to 20 minutes, matching the existing panels. */
    timeoutMs?: number;
    /** Poll interval; defaults to 2500ms, matching the existing panels. */
    intervalMs?: number;
    /**
     * Recover a finished job's result from the DB task store when the in-memory
     * job can no longer be read here.
     *
     * The background job writes its result to qbg_tasks under the SAME id it
     * returns as jobId, and it keeps running regardless of whether anyone is
     * still polling. So a client-side timeout or a 404 does NOT mean the work
     * was lost — a 35-question reframe that took 21m51s against a 20m client
     * deadline had already reframed all 34 questions AND pushed them to QBG by
     * the time the panel gave up and reported failure (2026-09-03 bug report).
     *
     * Set false only for a job type that isn't recorded in qbg_tasks.
     */
    recoverFromTaskStore?: boolean;
}

/** How long to keep waiting on the DB record after the live poll gives up. */
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 5000;

interface TaskRecord {
    success?: boolean;
    task?: { status?: string; error?: string | null; data?: Record<string, unknown> };
}

/**
 * Read the job's row from the task store. Returns its payload once the task is
 * finished, null while it is still running, and throws if it genuinely failed.
 */
async function readTask(jobId: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`/api/ai-tools/qbg-tasks?id=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as TaskRecord;
    const task = json?.task;
    if (!json?.success || !task) return null;
    if (task.status === "failed") throw new Error(task.error || "The job failed.");
    if (task.status === "done") return task.data || {};
    return null; // still running
}

/**
 * Wait for the DB record to reach a terminal state, and hand back its payload.
 * This is what turns "your run timed out, tokens wasted" into "your run took a
 * bit longer than expected, here are the questions".
 */
async function recoverFromTask<T>(jobId: string, label: string, onNote?: (msg: string) => void): Promise<T> {
    onNote?.(
        `"${label}" is taking longer than the live poll allows — it is still running on the ` +
            `server. Waiting for it to finish and recovering the result…`
    );
    const deadline = Date.now() + RECOVERY_WINDOW_MS;
    for (;;) {
        try {
            const data = await readTask(jobId);
            if (data) return data as T;
        } catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        if (Date.now() > deadline) {
            throw new Error(
                `"${label}" is still running after a long wait. Nothing is lost — it keeps going ` +
                    `on the server and its result will appear in the history list below when it ` +
                    `finishes; open it from there to push or tag the questions.`
            );
        }
        await new Promise((r) => setTimeout(r, RECOVERY_INTERVAL_MS));
    }
}

/**
 * Starts a QBG async job and polls it to completion. Resolves with the final
 * job payload, or throws on failure/timeout. See the file-level comment for
 * why trackAsyncJob is optional and, for chained callers, should stay unset.
 */
export async function pollQbgJob<T extends Record<string, unknown>>(
    opts: PollQbgJobOptions<T>
): Promise<T> {
    const {
        startUrl,
        startBody,
        startHeaders,
        buildPollUrl,
        trackAsyncJob,
        forgetAsyncJob,
        kind,
        label,
        onProgress,
        timeoutMs = 20 * 60 * 1000,
        intervalMs = 2500,
        recoverFromTaskStore = true,
        onNote,
    } = opts;

    const res = await fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(startHeaders || {}) },
        body: JSON.stringify(startBody),
    });
    const start = (await res.json()) as AsyncJobStartResponse;
    if (!res.ok || !start.success || !start.jobId) {
        throw new Error(start.error || `Request failed (${res.status}).`);
    }

    const jobId = start.jobId;
    const pollUrl = buildPollUrl(jobId);
    trackAsyncJob?.({ jobId, kind, label, pollUrl, startedAt: new Date().toISOString() });

    const deadline = Date.now() + timeoutMs;
    // A single dropped connection (WiFi blip, the tunnel briefly reconnecting)
    // shouldn't abort a run that's otherwise fine — only give up after several
    // consecutive failures in a row, not the first one.
    const MAX_CONSECUTIVE_POLL_ERRORS = 5;
    let consecutiveErrors = 0;
    for (;;) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (Date.now() > deadline) {
            forgetAsyncJob?.(jobId);
            // The job is still running server-side — never report failure while
            // paid-for work is in flight. Switch to the durable DB record.
            if (recoverFromTaskStore) return recoverFromTask<T>(jobId, label, onNote);
            throw new Error(`Timed out waiting for "${label}" to finish.`);
        }
        let pollRes: Response;
        try {
            pollRes = await fetch(pollUrl, { cache: "no-store" });
        } catch (networkErr) {
            consecutiveErrors += 1;
            if (consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS) {
                forgetAsyncJob?.(jobId);
                if (recoverFromTaskStore) return recoverFromTask<T>(jobId, label, onNote);
                const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
                throw new Error(`Lost connection while waiting for "${label}" (${detail}).`);
            }
            continue;
        }
        consecutiveErrors = 0;
        if (pollRes.status === 404) {
            forgetAsyncJob?.(jobId);
            // The in-memory job is one-shot: another poller may have consumed it,
            // or the server restarted. The task row outlives both.
            if (recoverFromTaskStore) return recoverFromTask<T>(jobId, label, onNote);
            throw new Error(
                trackAsyncJob
                    ? `"${label}" finished in the background before its result could be read here. Check its history entry.`
                    : `"${label}" job not found (may have expired). Please try again.`
            );
        }
        const data = (await pollRes.json()) as AsyncJobPollResponse<T> & T;
        if (data.state === "running") {
            if (Array.isArray(data.progress) && onProgress) onProgress(data.progress);
            continue;
        }
        if (!pollRes.ok || data.success === false || data.state === "error") {
            forgetAsyncJob?.(jobId);
            throw new Error(data.error || `"${label}" failed.`);
        }
        forgetAsyncJob?.(jobId);
        return data as unknown as T;
    }
}
