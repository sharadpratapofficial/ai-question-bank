/**
 * Supabase-persistent job store for Agentic QC runs.
 *
 * Design goals:
 *   - Survive serverless: on Vercel the local filesystem (OS temp dir) is
 *     ephemeral — each invocation/deploy gets a fresh /tmp — so jobs persisted
 *     to disk vanished and saved reports never showed up. The canonical
 *     snapshot now lives in the `agentic_qc_jobs` Supabase table, which
 *     survives across invocations and deploys.
 *   - Survive Next.js dev hot-reload and client navigation: the user can leave
 *     /agentic-qc, work elsewhere, come back, and pick up where the job is.
 *   - Persist forever (until the user explicitly deletes) so older reports can
 *     be re-downloaded later — even after a brand new QC run completes.
 *   - Per-user scoping: list / get / delete operate on the authenticated
 *     user's jobs only.
 *
 * Storage: one row per job in `public.agentic_qc_jobs`, with the full
 * JobRecord snapshot stored in the `data` jsonb column. The in-memory cache
 * below serves the executor's hot path within a single invocation; Supabase is
 * the source of truth across invocations.
 *
 * The executor lives in `executor.ts`; this file is only the store +
 * cancellation flag bookkeeping.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ModelTokenUsage, AgentTokenUsage } from "./pricing";

export type { ModelTokenUsage, AgentTokenUsage };
import type { PreparsedQuestion } from "./executor";
import type { FileInput } from "./llm";

// ─── Storage backend ───────────────────────────────────────────────────

const TABLE = "agentic_qc_jobs";

/**
 * A plain anon Supabase client with no cookie/session dependency. jobStore is
 * called both from request handlers and from the fire-and-forget background
 * executor (after the HTTP response has been sent), where `next/headers`
 * `cookies()` is unavailable. The table's RLS policies are permissive
 * (USING true) and we scope every query by `user_id` explicitly, matching the
 * rest of the app's data access.
 */
let _supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
    if (!_supabase) {
        _supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { auth: { persistSession: false, autoRefreshToken: false } }
        );
    }
    return _supabase;
}

// ─── Types ─────────────────────────────────────────────────────────────

export type JobStatus =
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "done"
    | "failed";

export interface AgentConfig {
    label: string; // "QC1" | "QC2" | "QC3" | "Aggregator"
    provider: string;
    modelId: string;
}

export interface PerAgentQuestionResult {
    label: string;
    provider: string;
    modelId: string;
    status: "pending" | "running" | "done" | "failed";
    answer: string | number | null;
    correctness: string;
    errorsFound: string[];
    solutionFeedback: string;
    hasFigure: boolean;
    questionType: string;
    error?: string;
    elapsedMs?: number;
    /** Chapter this agent judged the question to actually test. */
    detectedChapter?: string | null;
}

export interface AggregatorQuestionResult {
    status: "pending" | "running" | "done" | "failed" | "skipped";
    finalAnswer: string | number | null;
    confidence: "high" | "medium" | "low";
    agreementWithProvidedKey: boolean | null;
    needsManualReview: boolean;
    manualReviewReason: string | null;
    consolidatedErrors: string[];
    consolidatedSolutionFeedback: string;
    rationale: string;
    error?: string;
    elapsedMs?: number;
}

/**
 * One row of the live dashboard. Updated incrementally as agents and the
 * aggregator finish for this question.
 */
export interface JobQuestion {
    questionNumber: number;
    /** PW QBG unique id (from the CSV `unique_id` column) — present only for
     *  structured uploads. Used in the PDF detail to deep-link each question to
     *  the QBG admin question-details page. */
    qbgId?: string;
    questionSummary: string;
    questionText: string; // longer preview for UI
    providedAnswerKey: string | number | null;
    /** The chapter QC concluded the question ACTUALLY tests (agent consensus),
     *  which can differ from the tag it arrived with — that difference is how an
     *  out-of-syllabus question hides behind a correct-looking label. */
    detectedChapter?: string | null;
    questionType: string;
    hasFigure: boolean;
    imageUrls: string[];
    subject?: string;
    chapter?: string;
    topic?: string;
    /** Raw class / standard label (e.g. "Class 11", "12th") — structured input. */
    klass?: string;
    /** Source difficulty index (0-3 typically) — structured input only. */
    difficulty?: number | null;
    /** Whether the source row carried a video-solution URL. */
    hasVideoSolution?: boolean;
    /** MCQ options — present for structured input so the PDF can render
     *  them with the correct option highlighted. Empty for file/paper mode
     *  where the model only returned a summary. */
    options?: { label: string; text: string; isCorrect: boolean }[];
    /** Provided solution text (English only). Useful for the PDF detail
     *  block. Empty when not available. */
    solutionText?: string;
    agentResults: PerAgentQuestionResult[];
    aggregator: AggregatorQuestionResult;
}

export interface JobEvent {
    type: string;
    timestamp: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

/**
 * Everything the executor needs to (re)drive a run, persisted alongside the
 * job so the SSE stream route can resume execution after a serverless
 * invocation ends. API keys are NOT stored here — they're re-resolved
 * server-side from the authenticated user on every connection. This blob is
 * stripped from all client-facing responses via `toClientView`.
 */
export interface JobExecInput {
    parsedQuestions?: PreparsedQuestion[];
    files?: {
        questionFile: FileInput;
        answerKeyFile?: FileInput;
        solutionFile?: FileInput;
    };
}

export interface JobRecord {
    id: string;
    userId: string;
    label: string; // human-friendly title shown in jobs list
    status: JobStatus;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
    cancellationRequested?: boolean;

    /** Input metadata for the run. Files themselves are NOT stored on disk —
     *  they're consumed during execution and discarded. */
    inputMode: "combined" | "separate" | "structured";
    examType?: string;
    /** Optional user-provided test name — shown as a heading in the PDF. */
    testName?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    customQuestionTypeSequence?: string;
    qcAgents: AgentConfig[];
    aggregator: AgentConfig;
    /** Source file name (for display only) — null for structured mode. */
    sourceFileName?: string;

    /** Per-question live state. Empty until the first question is dispatched. */
    questions: JobQuestion[];

    /** Paper-level analysis written at the end of the run. */
    paperAnalysis: {
        patternAnalysis: string;
        syllabusAnalysis: string;
        overallSuggestions: string[];
    };

    /** Append-only event log for the live dashboard — also re-streamed when
     *  a client reconnects mid-run via /stream. Keep short events; large
     *  payloads belong in `questions`. */
    events: JobEvent[];

    /** Per-model token consumption across the whole run, keyed by
     *  `${provider}::${modelId}`. Drives the "Token usage & cost" panel in the
     *  final report. Populated incrementally as each LLM call returns. */
    tokenUsage?: Record<string, ModelTokenUsage>;

    /** Per-agent token consumption, keyed by agent label ("QC1" / "QC2" /
     *  "QC3" / "Aggregator"). Drives the per-agent tokens + ₹ table in the
     *  PDF "Models used" section. */
    tokenUsageByLabel?: Record<string, AgentTokenUsage>;

    /** Top-level fatal error if the whole job died. */
    fatalError?: string;

    /** Set when paper-level results came from a vote-based fallback rather
     *  than a real aggregator pass. */
    partial?: boolean;
    partialReason?: string;

    /** Execution inputs for resuming the run from the stream route. Never sent
     *  to the client (see `toClientView`). */
    execInput?: JobExecInput;
}

/**
 * Strip server-only execution inputs (parsed questions / base64 files) before
 * returning a job to the client. Keeps SSE snapshots and GET responses small
 * and avoids echoing uploaded file bytes back to the browser.
 */
export function toClientView(job: JobRecord): JobRecord {
    if (!job.execInput) return job;
    const clone = { ...job };
    delete clone.execInput;
    return clone;
}

// ─── In-memory caches ──────────────────────────────────────────────────

/**
 * In-process cache so the executor doesn't have to re-read JSON for every
 * state update. Keyed by jobId. The disk file is the source of truth across
 * server restarts.
 */
const memCache = new Map<string, JobRecord>();

/**
 * Per-job listener fan-out for SSE streams. Each entry is the SSE controller's
 * `send` callback. The executor publishes to every listener when state
 * changes; the /stream route adds/removes itself here.
 */
const listeners = new Map<string, Set<(event: JobEvent) => void>>();

/**
 * Per-job AbortController. The executor pulls one out via `getAbortSignal`
 * when it starts and threads `signal` into every `fetch()` call. When the
 * user clicks Stop, `requestCancel` calls `.abort()` and the in-flight LLM
 * calls bail out with AbortError — typically within milliseconds. Without
 * this, the executor would have to wait for each LLM call to naturally
 * complete (up to a minute per call) before noticing the cancel flag.
 */
const abortControllers = new Map<string, AbortController>();

export function getAbortSignal(jobId: string): AbortSignal {
    let c = abortControllers.get(jobId);
    if (!c) {
        c = new AbortController();
        abortControllers.set(jobId, c);
    }
    return c.signal;
}

function abortJob(jobId: string): void {
    const c = abortControllers.get(jobId);
    if (c) {
        try {
            c.abort();
        } catch {
            // ignore
        }
        // KEEP the aborted controller in the map so any subsequent
        // `getAbortSignal(jobId)` call returns the SAME (still-aborted)
        // signal. Previously we deleted it — meaning a worker spawning a new
        // LLM call moments after the user clicked Stop would get a fresh,
        // non-aborted signal and run to completion, defeating the whole
        // cancellation mechanism. Cleanup happens after the job terminates.
    }
}

/**
 * Called from runJob's `finally` to drop the AbortController once the job
 * has reached a terminal state. Safe to call on a job that was never
 * cancelled (no-op).
 */
export function clearAbortController(jobId: string): void {
    abortControllers.delete(jobId);
}

// ─── Public API ────────────────────────────────────────────────────────

/** Persist the job snapshot to Supabase (upsert by primary key `id`). */
async function persist(job: JobRecord): Promise<void> {
    const { error } = await db()
        .from(TABLE)
        .upsert(
            {
                id: job.id,
                user_id: job.userId,
                label: job.label,
                status: job.status,
                data: job,
                created_at: job.createdAt,
                updated_at: job.updatedAt,
            },
            { onConflict: "id" }
        );
    if (error) throw new Error(error.message);
}

/** persist() with a few retries — a single transient network blip on the final
 *  write must not leave the saved snapshot stuck mid-run. */
async function persistWithRetry(job: JobRecord, attempts = 3): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            await persist(job);
            return;
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
    }
    throw lastErr;
}

/**
 * Per-job write coalescing. The executor mutates the in-memory job object and
 * calls `schedulePersist` on EVERY change (per-agent, per-aggregator, per
 * event, per token tally) — 150+ times for a 50-question run. Firing all those
 * upserts un-awaited let them race: an older snapshot's write could land AFTER
 * a newer one and clobber it, leaving the DB stuck "running" forever even
 * though the run finished. That broke the live dashboard, the "done" status,
 * and Saved QC reports.
 *
 * This queue guarantees: at most ONE in-flight write per job, and after that
 * write finishes it re-persists if anything changed in the meantime — so the
 * DB always converges to the LATEST state and the final snapshot can never be
 * overwritten by a stale earlier one.
 */
interface PersistState {
    latest: JobRecord;
    inFlight: boolean;
    dirty: boolean;
}
const persistQueue = new Map<string, PersistState>();

function schedulePersist(job: JobRecord): void {
    let st = persistQueue.get(job.id);
    if (!st) {
        st = { latest: job, inFlight: false, dirty: false };
        persistQueue.set(job.id, st);
    }
    st.latest = job; // always the live mutated reference → newest state
    if (st.inFlight) {
        st.dirty = true;
        return;
    }
    void drainPersist(job.id);
}

async function drainPersist(jobId: string): Promise<void> {
    const st = persistQueue.get(jobId);
    if (!st || st.inFlight) return;
    st.inFlight = true;
    try {
        // Keep writing until no further changes arrived during the last write.
        // `dirty` is set by schedulePersist while a write is in flight.
        do {
            st.dirty = false;
            try {
                await persistWithRetry(st.latest);
            } catch (e) {
                console.error("[agenticQC.jobStore] persist failed after retries", e);
                // Leave dirty as-is; a later updateJob will reschedule. Avoid a
                // hot infinite loop by breaking out when nothing new is pending.
                if (!st.dirty) break;
            }
        } while (st.dirty);
    } finally {
        st.inFlight = false;
        // Once a job reaches a terminal state and is fully flushed, drop its
        // queue entry to avoid unbounded Map growth.
        const terminal =
            st.latest.status === "done" ||
            st.latest.status === "failed" ||
            st.latest.status === "cancelled";
        if (terminal && !st.dirty) persistQueue.delete(jobId);
    }
}

/** Create a new job and immediately persist + cache it. */
export async function createJob(
    init: Omit<JobRecord, "status" | "createdAt" | "updatedAt" | "questions" | "events" | "paperAnalysis"> & {
        questions?: JobQuestion[];
    }
): Promise<JobRecord> {
    const now = new Date().toISOString();
    const job: JobRecord = {
        ...init,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        questions: init.questions ?? [],
        paperAnalysis: { patternAnalysis: "", syllabusAnalysis: "", overallSuggestions: [] },
        events: [],
    };
    memCache.set(job.id, job);
    await persist(job);
    return job;
}

/**
 * Get a job snapshot. Reads from cache first; falls back to disk on miss
 * (typical after a server restart). Throws if the job does not belong to the
 * caller (userId mismatch) so the caller doesn't accidentally leak data.
 */
export async function getJob(userId: string, jobId: string): Promise<JobRecord | null> {
    const cached = memCache.get(jobId);
    if (cached) {
        return cached.userId === userId ? cached : null;
    }
    try {
        const { data, error } = await db()
            .from(TABLE)
            .select("data")
            .eq("id", jobId)
            .eq("user_id", userId)
            .maybeSingle();
        if (error || !data) return null;
        const job = (data as { data: JobRecord }).data;
        if (!job || job.userId !== userId) return null;
        memCache.set(jobId, job);
        return job;
    } catch {
        return null;
    }
}

/**
 * Fresh read for the API/read path (GET /jobs/[id], stream snapshot).
 *
 * `getJob` is cache-first because the executor mutates the same in-memory
 * object across hundreds of updates within ITS instance. But the executor
 * actually runs inside the SSE *stream* route's module instance, while
 * `GET /jobs/[id]` is a SEPARATE route instance with its own `memCache`. That
 * read instance would cache an early "all pending" snapshot and then
 * short-circuit on it forever — so the live dashboard (which refetches
 * /jobs/[id] on every event) froze and never reflected progress or the final
 * "done" state.
 *
 * This reader never trusts a stale local cache: it reads Supabase (which the
 * executor's coalescing queue keeps converged) and returns whichever of
 * {local cache, remote row} has the newer `updatedAt`. It deliberately does
 * NOT write `memCache`, so subsequent calls always re-read fresh. In the rare
 * case it runs in the executor's own instance, the live in-memory object wins
 * via the `updatedAt` comparison (zero lag); cross-instance, Supabase wins.
 */
export async function getJobFresh(userId: string, jobId: string): Promise<JobRecord | null> {
    let remote: JobRecord | null = null;
    try {
        const { data, error } = await db()
            .from(TABLE)
            .select("data")
            .eq("id", jobId)
            .eq("user_id", userId)
            .maybeSingle();
        if (!error && data) {
            const j = (data as { data: JobRecord }).data;
            if (j && j.userId === userId) remote = j;
        }
    } catch {
        // ignore — fall back to whatever is cached locally
    }
    const cached = memCache.get(jobId);
    const local = cached && cached.userId === userId ? cached : null;
    if (local && remote) {
        return (local.updatedAt || "") >= (remote.updatedAt || "") ? local : remote;
    }
    return remote || local;
}

/** List a user's jobs newest-first from Supabase. */
export async function listJobs(userId: string): Promise<JobRecord[]> {
    try {
        const { data, error } = await db()
            .from(TABLE)
            .select("data")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(200);
        if (error || !data) return [];
        const out: JobRecord[] = [];
        for (const row of data as { data: JobRecord }[]) {
            const job = row.data;
            if (job && job.userId === userId) out.push(job);
        }
        return out;
    } catch {
        return [];
    }
}

/** Delete a job snapshot. */
export async function deleteJob(userId: string, jobId: string): Promise<boolean> {
    const job = await getJob(userId, jobId);
    if (!job) return false;
    memCache.delete(jobId);
    listeners.delete(jobId);
    try {
        const { error } = await db()
            .from(TABLE)
            .delete()
            .eq("id", jobId)
            .eq("user_id", userId);
        return !error;
    } catch {
        return false;
    }
}

/**
 * Atomically update a job. The mutator receives the live cached object —
 * mutate it in place (don't return a new object). We persist + notify
 * listeners after the mutator finishes.
 */
export async function updateJob(
    userId: string,
    jobId: string,
    mutate: (j: JobRecord) => void
): Promise<JobRecord | null> {
    const job = await getJob(userId, jobId);
    if (!job) return null;
    mutate(job);
    job.updatedAt = new Date().toISOString();
    // Write-behind via the coalescing queue: keeps the hot path fast while
    // guaranteeing writes are serialized (no out-of-order clobbering) and the
    // DB always converges to the latest state.
    schedulePersist(job);
    return job;
}

/**
 * Await until the job's pending writes have flushed to Supabase. Call this when
 * correctness matters more than latency — e.g. right before returning a job
 * snapshot the client will treat as authoritative. No-op if nothing is queued.
 */
export async function flushPersist(jobId: string): Promise<void> {
    const st = persistQueue.get(jobId);
    if (!st) return;
    // Spin until the queue drains (bounded by the executor's write cadence).
    for (let i = 0; i < 100 && (st.inFlight || st.dirty); i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
}

/** Mark a job for cancellation. The executor checks this flag periodically. */
export async function requestCancel(userId: string, jobId: string): Promise<boolean> {
    const job = await getJob(userId, jobId);
    if (!job) return false;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
        return false; // already finished
    }
    await updateJob(userId, jobId, (j) => {
        j.cancellationRequested = true;
        if (j.status === "queued" || j.status === "running") {
            j.status = "cancelling";
        }
    });
    // Tear down the in-flight LLM calls right now — without this, the
    // executor would have to wait for each fetch() to complete before
    // noticing the cancel flag (up to ~60s per call).
    abortJob(jobId);
    publish(jobId, {
        type: "cancel_requested",
        timestamp: new Date().toISOString(),
    });
    return true;
}

/** True if the executor should bail out. */
export async function isCancelled(userId: string, jobId: string): Promise<boolean> {
    const job = await getJob(userId, jobId);
    return !!job?.cancellationRequested;
}

// ─── Event pub/sub for SSE clients ─────────────────────────────────────

/**
 * Append an event to the job's log AND publish to live listeners. Returns
 * the new event so the caller can chain (e.g. to log debug output).
 */
export async function emitEvent(
    userId: string,
    jobId: string,
    event: { type: string } & Record<string, unknown>
): Promise<JobEvent> {
    const full: JobEvent = { ...event, timestamp: new Date().toISOString() };
    await updateJob(userId, jobId, (j) => {
        j.events.push(full);
        // Cap event history at 1000 to keep snapshots manageable.
        if (j.events.length > 1000) j.events.splice(0, j.events.length - 1000);
    });
    publish(jobId, full);
    return full;
}

/**
 * Accumulate token usage for a model into the job's `tokenUsage` map. Called
 * after every LLM call (per-agent and aggregator). Keyed by provider+modelId so
 * the same model reused across agents rolls up into one row; the agent `label`
 * is tracked so the report can show which agents used each model.
 */
export async function addTokenUsage(
    userId: string,
    jobId: string,
    args: {
        provider: string;
        modelId: string;
        label: string;
        inputTokens: number;
        outputTokens: number;
    }
): Promise<void> {
    const { provider, modelId, label, inputTokens, outputTokens } = args;
    if (!inputTokens && !outputTokens) return;
    const key = `${provider}::${modelId}`;
    await updateJob(userId, jobId, (j) => {
        if (!j.tokenUsage) j.tokenUsage = {};
        const cur =
            j.tokenUsage[key] ||
            (j.tokenUsage[key] = {
                provider,
                modelId,
                labels: [],
                inputTokens: 0,
                outputTokens: 0,
                calls: 0,
            });
        cur.inputTokens += inputTokens;
        cur.outputTokens += outputTokens;
        cur.calls += 1;
        if (label && !cur.labels.includes(label)) cur.labels.push(label);

        // Per-agent rollup so the report can show tokens + ₹ for each agent
        // individually (even when two agents share the same model).
        if (label) {
            if (!j.tokenUsageByLabel) j.tokenUsageByLabel = {};
            const byLabel =
                j.tokenUsageByLabel[label] ||
                (j.tokenUsageByLabel[label] = {
                    provider,
                    modelId,
                    inputTokens: 0,
                    outputTokens: 0,
                    calls: 0,
                });
            byLabel.provider = provider;
            byLabel.modelId = modelId;
            byLabel.inputTokens += inputTokens;
            byLabel.outputTokens += outputTokens;
            byLabel.calls += 1;
        }
    });
}

/** Push an event to all SSE listeners for this job (no persistence). */
function publish(jobId: string, event: JobEvent): void {
    const set = listeners.get(jobId);
    if (!set) return;
    for (const fn of set) {
        try {
            fn(event);
        } catch (e) {
            console.error("[agenticQC.jobStore] listener threw", e);
        }
    }
}

/**
 * Subscribe to live events for a job. Returns an unsubscribe callback.
 * Callers should immediately replay `job.events` to the client before
 * subscribing so no events are missed.
 */
export function subscribe(jobId: string, fn: (event: JobEvent) => void): () => void {
    let set = listeners.get(jobId);
    if (!set) {
        set = new Set();
        listeners.set(jobId, set);
    }
    set.add(fn);
    return () => {
        set?.delete(fn);
        if (set && set.size === 0) listeners.delete(jobId);
    };
}
