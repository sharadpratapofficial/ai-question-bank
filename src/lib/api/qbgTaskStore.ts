/**
 * Supabase-persistent task store for QBG feature runs (modifier / ingestion / tagging).
 *
 * Mirrors the Agentic QC jobStore pattern — the ONE history mechanism in this app that
 * reliably survives background execution: a plain anon Supabase client with no
 * cookie/session dependency, permissive RLS on the table, and every query scoped by
 * user_id explicitly in code. The previous QBG history wrote to `ai_reports`, which
 * needs an authenticated session token; the background job often had none ("Auth
 * session missing"), so completed/failed tasks silently never persisted — tasks
 * "disappeared" when the user navigated away.
 *
 * Lifecycle: createTask() at submit (status "running") → completeTask()/failTask()
 * when the background job ends. The row is the single source of truth for the
 * feature's "Previous tasks" list, so a task is visible from the moment it is
 * submitted, from any tab/browser, regardless of auth mode (dev-auth users get
 * user_id "dev").
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const TABLE = "qbg_tasks";

// "qbg_push" is a re-push of work a previous run already produced (see
// /api/ai-tools/qbg-push). It has no history tab of its own — the result is shown
// inline where it was started — but it is recorded so a push is auditable.
export type QbgTaskType =
    | "qbg_modification"
    | "qbg_ingestion"
    | "qbg_tagging"
    | "qbg_pipeline"
    | "qbg_push";
export type QbgTaskStatus = "running" | "done" | "failed";

export interface QbgTaskRow {
    id: string;
    user_id: string | null;
    task_type: QbgTaskType;
    label: string;
    status: QbgTaskStatus;
    error: string | null;
    provider: string;
    model_id: string;
    data: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

let _db: SupabaseClient | null = null;
function db(): SupabaseClient {
    if (!_db) {
        _db = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { auth: { persistSession: false, autoRefreshToken: false } }
        );
    }
    return _db;
}

/** Insert the task row at submit time (status "running"). Best-effort: history must
 *  never block the actual run — failures are logged, not thrown. */
export async function createTask(args: {
    id: string;
    userId: string | null;
    taskType: QbgTaskType;
    label: string;
    provider?: string;
    modelId?: string;
    /** Set when the caller will drive touchTask()/startHeartbeat() for this run.
     *  Recorded on the row itself (`data.hb`) because liveness is judged at read
     *  time, by listTasks, which has only the row to go on — see HEARTBEAT_MS. */
    heartbeat?: boolean;
}): Promise<void> {
    try {
        const { error } = await db().from(TABLE).insert({
            id: args.id,
            user_id: args.userId || "dev",
            task_type: args.taskType,
            label: args.label,
            status: "running",
            provider: args.provider || "",
            model_id: args.modelId || "",
            data: args.heartbeat ? { hb: true } : {},
        });
        if (error) console.error("[qbgTaskStore] createTask failed:", error.message);
    } catch (e) {
        console.error("[qbgTaskStore] createTask error:", e);
    }
}

async function setTask(id: string, patch: Record<string, unknown>): Promise<void> {
    try {
        const { error } = await db()
            .from(TABLE)
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", id);
        if (error) console.error("[qbgTaskStore] update failed:", error.message);
    } catch (e) {
        console.error("[qbgTaskStore] update error:", e);
    }
}

/** Patch `data` while a task is still "running" (e.g. the QBG Pipeline panel
 *  recording each stage's outcome as it completes, not just at the very end).
 *  Merges shallowly into the existing `data` object rather than replacing it. */
export async function updateTaskData(id: string, patch: Record<string, unknown>): Promise<void> {
    try {
        const { data: existing, error: readError } = await db()
            .from(TABLE)
            .select("data")
            .eq("id", id)
            .single();
        if (readError) {
            console.error("[qbgTaskStore] updateTaskData read failed:", readError.message);
            return;
        }
        const current = (existing as { data?: Record<string, unknown> } | null)?.data || {};
        await setTask(id, { data: { ...current, ...patch } });
    } catch (e) {
        console.error("[qbgTaskStore] updateTaskData error:", e);
    }
}

/** Mark done and store the report payload (keep it modest — no zip base64). */
export async function completeTask(id: string, data: Record<string, unknown>): Promise<void> {
    await setTask(id, { status: "done", data, error: null });
}

/** Mark failed with the error message so the task stays visible with its reason. */
export async function failTask(id: string, error: string): Promise<void> {
    await setTask(id, { status: "failed", error: error.slice(0, 2000) });
}

/**
 * Liveness.
 *
 * A run that dies without calling completeTask/failTask — the server restarted
 * or recompiled mid-job, or a client-orchestrated pipeline's browser was closed
 * — leaves its row claiming "running" with nothing left to correct it. The only
 * repair happens here, at read time, so the row itself has to carry enough
 * information to tell a live run from an abandoned one.
 *
 * A heartbeating run touches its row every HEARTBEAT_MS (see startHeartbeat),
 * which makes `updated_at` a liveness signal rather than mere bookkeeping: past
 * STALE_HEARTBEAT_MS with no touch, whatever was driving it is gone. That is a
 * couple of minutes instead of three hours, and it is honest — the previous
 * rule could not distinguish "still working" from "died 2 hours ago".
 *
 * Rows without `data.hb` — everything created before heartbeats existed, plus
 * any run whose heartbeat never started — keep the original conservative rule,
 * because for them a quiet `updated_at` means nothing.
 */
const HEARTBEAT_MS = 30 * 1000;
/** Six missed ticks: long enough to ride out a GC pause, an event-loop stall
 *  during a large LLM response, or a brief Supabase blip. */
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;
const STALE_RUNNING_MS = 3 * 60 * 60 * 1000;

/** Heartbeat write: bumps `updated_at` and nothing else. Deliberately not
 *  routed through updateTaskData — that does a read-modify-write on `data`,
 *  which every 30s would race the run's own stage patches and could drop one. */
export async function touchTask(id: string): Promise<void> {
    await setTask(id, {});
}

/**
 * Touch `id` every HEARTBEAT_MS until the returned function is called. Start it
 * when a background job begins and stop it in a `finally`, so the row stops
 * looking alive the moment the work does.
 *
 * The timer is unref'd where the runtime supports it: a heartbeat is not a
 * reason to hold the process open, and leaving it ref'd would keep a Node
 * server alive past the point it would otherwise exit.
 */
export function startHeartbeat(id: string, intervalMs: number = HEARTBEAT_MS): () => void {
    void touchTask(id);
    const timer = setInterval(() => void touchTask(id), intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}

/** List a user's tasks for one QBG feature, newest first. */

/**
 * Bulk payload kept out of history *listings*.
 *
 * A task's `data` holds the whole job result — every reframed question, the CSVs,
 * the QC report. Listing 50 modification tasks with all of that attached meant
 * shipping ~26 MB of JSON to the browser just to draw a list of filenames, which
 * got slower with every run. These keys are stripped from list responses and
 * fetched only when a specific report is opened (see getTask).
 *
 * Everything else — sourceName, counts, qbgResults, warnings, status — stays, so
 * the one-line summaries in the history list are unchanged.
 */
const HEAVY_DATA_KEYS = [
    "records",
    "modifiedCsv",
    "originalCsv",
    "originals",
    "results",
    "qc",
    "preview",
    "figures",
] as const;

function stripHeavyData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!data || typeof data !== "object") return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
        if ((HEAVY_DATA_KEYS as readonly string[]).includes(k)) continue;
        out[k] = v;
    }
    return out;
}

export async function listTasks(
    userId: string | null,
    taskType: QbgTaskType,
    limit = 50
): Promise<QbgTaskRow[]> {
    try {
        const { data, error } = await db()
            .from(TABLE)
            .select("*")
            .eq("user_id", userId || "dev")
            .eq("task_type", taskType)
            .order("created_at", { ascending: false })
            .limit(limit);
        if (error || !data) return [];
        const rows = data as QbgTaskRow[];
        const now = Date.now();
        for (const r of rows) {
            if (r.status === "running") {
                const heartbeats = (r.data as { hb?: boolean } | null)?.hb === true;
                const stale = heartbeats
                    ? Date.parse(r.updated_at) < now - STALE_HEARTBEAT_MS
                    : Date.parse(r.created_at) < now - STALE_RUNNING_MS;
                if (stale) {
                    r.status = "failed";
                    r.error = heartbeats
                        ? "interrupted — this run stopped reporting in (the server restarted, or the browser driving it was closed)"
                        : "interrupted — the server restarted while this task was running";
                    void setTask(r.id, { status: r.status, error: r.error });
                }
            }
            // The bulk payload is fetched on demand by getTask when a report is opened.
            r.data = stripHeavyData(r.data);
        }
        return rows;
    } catch {
        return [];
    }
}

/**
 * One task with its full `data`, for when a history entry is actually opened.
 * Scoped to the caller so a task id from another user returns nothing.
 */
export async function getTask(userId: string | null, id: string): Promise<QbgTaskRow | null> {
    try {
        const { data, error } = await db()
            .from(TABLE)
            .select("*")
            .eq("id", id)
            .eq("user_id", userId || "dev")
            .maybeSingle();
        if (error || !data) return null;
        return data as QbgTaskRow;
    } catch {
        return null;
    }
}

/** Delete one of the user's tasks. */
export async function deleteTask(userId: string | null, id: string): Promise<boolean> {
    try {
        const { error } = await db()
            .from(TABLE)
            .delete()
            .eq("id", id)
            .eq("user_id", userId || "dev");
        return !error;
    } catch {
        return false;
    }
}
