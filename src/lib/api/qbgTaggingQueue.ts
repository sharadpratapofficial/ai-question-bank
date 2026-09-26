/**
 * In-memory queue manager for the QBG Tagging feature.
 *
 * Lets a user submit a second (third, ...) tagging batch while an earlier one
 * is still running — it waits as "queued" and starts automatically the moment
 * the current job finishes. A "running" job can be cancelled (kills the
 * underlying Python process); a "queued" one can be cancelled too (it just
 * never started).
 *
 * Deliberately a SEPARATE store from qbgModification.ts's `__qbgModJobs` map
 * (shared today by QBG Modification and, until this feature, Tagging too) —
 * that map has no queueing/cancellation concept and is also used by an
 * unrelated feature, so bolting queue semantics onto it risked destabilizing
 * Modification. This module owns tagging's job lifecycle end-to-end, with
 * exactly one job running at a time.
 */
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ProgressEvent } from "./qbgModification";
import { runTagging, type TagArgs, type TagResult } from "./qbgTagging";

export type QueuedTagJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

interface QueuedTagJob {
    id: string;
    label: string;
    mode: "ai" | "csv";
    /** ids/rows requested, for display only. */
    count: number;
    status: QueuedTagJobStatus;
    /** Holds secrets (apiKey, qbgCreds) — NEVER sent to the client, see toPublic(). */
    args: TagArgs;
    progress: ProgressEvent[];
    result?: TagResult;
    error?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    onSettled?: (job: PublicTagJob) => void;
}

/** Client-safe projection — no `args` (secrets), no internal callback. */
export interface PublicTagJob {
    id: string;
    label: string;
    mode: "ai" | "csv";
    count: number;
    status: QueuedTagJobStatus;
    progress: ProgressEvent[];
    result?: TagResult;
    error?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    /** 1-based position among currently queued jobs; only set when status is "queued". */
    queuePosition?: number;
}

const g = globalThis as unknown as { __qbgTagQueue?: Map<string, QueuedTagJob> };
if (!g.__qbgTagQueue) g.__qbgTagQueue = new Map();
const jobs = g.__qbgTagQueue;

// Live ChildProcess handles, kept OUT of the job map so one can never end up
// serialized/returned to a client. Only populated while status === "running".
const g2 = globalThis as unknown as { __qbgTagChildren?: Map<string, ChildProcess> };
if (!g2.__qbgTagChildren) g2.__qbgTagChildren = new Map();
const children = g2.__qbgTagChildren;

// Finished jobs (done/error/cancelled) are pruned after this long so the
// queue doesn't grow forever, while still letting a user who glances away
// briefly see what just finished.
const FINISHED_RETENTION_MS = 15 * 60 * 1000;

function pruneOld(): void {
    const cutoff = Date.now() - FINISHED_RETENTION_MS;
    for (const [id, job] of jobs) {
        if (job.status !== "queued" && job.status !== "running" && (job.finishedAt || 0) < cutoff) {
            jobs.delete(id);
        }
    }
}

function toPublic(job: QueuedTagJob, queuePosition?: number): PublicTagJob {
    return {
        id: job.id,
        label: job.label,
        mode: job.mode,
        count: job.count,
        status: job.status,
        progress: job.progress,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        queuePosition,
    };
}

/** Kick off the next queued job, but only if nothing is currently running —
 *  this is what keeps the queue at exactly one active Python process. */
function pump(): void {
    for (const job of jobs.values()) {
        if (job.status === "running") return;
    }
    let next: QueuedTagJob | undefined;
    for (const job of jobs.values()) {
        if (job.status === "queued" && (!next || job.createdAt < next.createdAt)) next = job;
    }
    if (!next) return;

    const job = next;
    job.status = "running";
    job.startedAt = Date.now();

    runTagging({
        ...job.args,
        onProgress: (ev) => {
            job.progress.push(ev);
            if (job.progress.length > 300) job.progress.shift();
        },
        onChild: (child) => children.set(job.id, child),
    })
        .then((result) => {
            children.delete(job.id);
            if (job.status !== "running") return; // cancelled mid-flight — don't overwrite
            job.status = "done";
            job.result = result;
            job.finishedAt = Date.now();
            job.onSettled?.(toPublic(job));
        })
        .catch((err) => {
            children.delete(job.id);
            if (job.status !== "running") return; // cancelled mid-flight
            job.status = "error";
            job.error = err instanceof Error ? err.message : String(err);
            job.finishedAt = Date.now();
            job.onSettled?.(toPublic(job));
        })
        .finally(() => pump());
}

export interface EnqueueArgs {
    id?: string;
    label: string;
    mode: "ai" | "csv";
    count: number;
    args: TagArgs;
    /** Called exactly once, when the job leaves "running" (done/error), or
     *  immediately for a cancel that happens before/during the run. */
    onSettled?: (job: PublicTagJob) => void;
}

/** Add a tagging job to the queue. Starts immediately if nothing else is
 *  currently running; otherwise waits its turn. */
export function enqueueTagJob(a: EnqueueArgs): { jobId: string; position: number } {
    pruneOld();
    const id = a.id || randomBytes(9).toString("hex");
    const job: QueuedTagJob = {
        id,
        label: a.label,
        mode: a.mode,
        count: a.count,
        status: "queued",
        args: a.args,
        progress: [],
        createdAt: Date.now(),
        onSettled: a.onSettled,
    };
    jobs.set(job.id, job);
    pump();
    const mine = getQueueSnapshot().find((j) => j.id === id);
    return { jobId: id, position: mine?.queuePosition ?? 0 };
}

/** Single job lookup — non-destructive (never deletes on read), so multiple
 *  pollers (the panel's own loop + the app-wide floating tracker) can safely
 *  read the same job without racing to consume it. */
export function getJob(id: string): PublicTagJob | null {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === "queued") {
        return getQueueSnapshot().find((j) => j.id === id) || toPublic(job);
    }
    return toPublic(job);
}

/** Every job currently known (queued, running, or recently finished) —
 *  running first, then queued in start order, then finished newest-first. */
export function getQueueSnapshot(): PublicTagJob[] {
    pruneOld();
    const all = Array.from(jobs.values());
    const running = all.filter((j) => j.status === "running");
    const queued = all.filter((j) => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    const finished = all
        .filter((j) => j.status !== "queued" && j.status !== "running")
        .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const out: PublicTagJob[] = [];
    running.forEach((j) => out.push(toPublic(j)));
    queued.forEach((j, i) => out.push(toPublic(j, i + 1)));
    finished.forEach((j) => out.push(toPublic(j)));
    return out;
}

/** Cancel a job. Queued -> removed from the line (never started). Running ->
 *  its Python process is killed and the next queued job starts immediately. */
export function cancelTagJob(id: string): { ok: boolean; error?: string } {
    const job = jobs.get(id);
    if (!job) return { ok: false, error: "Job not found." };
    if (job.status === "queued") {
        job.status = "cancelled";
        job.error = "Cancelled before it started.";
        job.finishedAt = Date.now();
        job.onSettled?.(toPublic(job));
        return { ok: true };
    }
    if (job.status === "running") {
        const child = children.get(id);
        children.delete(id);
        // Flip status BEFORE kill()/pump() — kill() is async (the OS process
        // teardown happens later), but pump() only checks in-memory status, so
        // flipping first lets the next queued job start without waiting on it.
        job.status = "cancelled";
        job.error = "Cancelled by user.";
        job.finishedAt = Date.now();
        try {
            child?.kill();
        } catch {
            /* best-effort */
        }
        job.onSettled?.(toPublic(job));
        pump();
        return { ok: true };
    }
    return { ok: false, error: "This job has already finished." };
}
