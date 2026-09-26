"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertCircle,
    Ban,
    CheckCircle2,
    Clock,
    Eye,
    FileUp,
    Loader2,
    RefreshCw,
    StopCircle,
    Tags,
    X,
} from "lucide-react";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
    readDevApiKeysFromStorage,
    type SupportedApiProvider,
} from "@/lib/userApiKeys";
import {
    AI_PROVIDER_LABELS,
    AI_PROVIDER_MODELS,
    type AIModelProvider,
    type ModelOption,
} from "@/types/extraction";
import { useAIJobQueue } from "@/context/AIJobQueueContext";
import QbgProgressLog, { type ProgressEvent } from "@/components/qbg/QbgProgressLog";
import QbgTaskHistory from "@/components/qbg/QbgTaskHistory";

const PROVIDERS = Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[];
const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

/**
 * Category slices the bundled tagging table covers
 * (python/qbg_modification/tagging_data/qbg_tagging_table.csv).
 *
 * Kept in step with that file by qbg_tag_crawl.py, which crawls a category's
 * concept tree straight from QBG. NOT necessarily the same list as
 * QBG_CATEGORIES — a category can exist in QBG before its taxonomy is crawled
 * here, and tagging then fails until it is.
 *
 * Ordered widest-first: the trees are nested views of one global id space (Real
 * Test's chapters contain all of NEET-JEE's, which contain all of NEET's), so
 * the first entry is the safest stand-in when a question's own category has no
 * rows. Foundation is last — a largely separate tree (junior classes).
 */
const TAXONOMY_CATEGORIES = [
    "Real Test", "NEET-JEE", "RankUp Test Series", "Boards", "JEE", "NEET", "Foundation",
];

interface TagFields {
    class_id: string;
    subject_id: string;
    chapter_id: string;
    topic_id: string;
    subtopic_id: string;
    difficulty: number | string;
}
interface TagMeta {
    class_name?: string;
    subject_name?: string;
    chapter_name?: string;
    topic_name?: string;
    subtopic_name?: string;
    difficulty_name?: string;
    category?: string;
}
interface TagResultItem {
    qbg_id: string | null;
    ok: boolean;
    detail?: string;
    error?: string;
    tags?: TagFields;
    meta?: TagMeta;
}
interface ApiResult {
    success: boolean;
    error?: string;
    status?: "running" | "done" | "failed";
    mode?: "ai" | "csv";
    count?: number;
    tagged?: number;
    provider?: string | null;
    modelId?: string | null;
    results?: TagResultItem[];
}

interface ReportRow {
    id: string;
    file_name?: string;
    provider?: string;
    model_id?: string;
    created_at: string;
    report_data: ApiResult;
}

type QueueJobStatus = "queued" | "running" | "done" | "error" | "cancelled";
interface QueueJob {
    id: string;
    label: string;
    mode: "ai" | "csv";
    count: number;
    status: QueueJobStatus;
    progress: ProgressEvent[];
    result?: { mode: "ai" | "csv"; count: number; tagged: number; results: TagResultItem[] };
    error?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    queuePosition?: number;
}

function jobToApiResult(job: QueueJob): ApiResult | null {
    if (!job.result) return null;
    return {
        success: true,
        mode: job.result.mode,
        count: job.result.count,
        tagged: job.result.tagged,
        results: job.result.results,
    };
}

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};
const label: React.CSSProperties = { fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" };
const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.85rem",
    padding: "8px 10px",
    outline: "none",
};

const DIFF_LABEL: Record<string, string> = { "1": "Easy", "2": "Medium", "3": "Hard" };

const QUEUE_STATUS_META: Record<QueueJobStatus, { label: string; color: string }> = {
    queued: { label: "Queued", color: "var(--text-tertiary)" },
    running: { label: "Running", color: "var(--accent-primary)" },
    done: { label: "Done", color: "var(--accent-success)" },
    error: { label: "Failed", color: "var(--accent-danger)" },
    cancelled: { label: "Cancelled", color: "var(--text-tertiary)" },
};

function QueueJobRow({ job, onCancel, onView }: { job: QueueJob; onCancel: () => void; onView: () => void }) {
    const meta = QUEUE_STATUS_META[job.status];
    const canCancel = job.status === "queued" || job.status === "running";
    return (
        <div
            style={{
                ...card,
                padding: "10px 12px",
                display: "grid",
                gap: 8,
                borderColor: job.status === "running" ? "var(--accent-primary)" : "var(--border-primary)",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {job.status === "queued" && <Clock size={15} color={meta.color} />}
                {job.status === "running" && <Loader2 size={15} className="animate-spin" color={meta.color} />}
                {job.status === "done" && <CheckCircle2 size={15} color={meta.color} />}
                {job.status === "error" && <AlertCircle size={15} color={meta.color} />}
                {job.status === "cancelled" && <Ban size={15} color={meta.color} />}
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>{job.label}</span>
                <span style={{ fontSize: "0.7rem", fontWeight: 700, color: meta.color }}>
                    {meta.label}
                    {job.status === "queued" && job.queuePosition ? ` · position ${job.queuePosition}` : ""}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {canCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                border: "1px solid rgba(var(--accent-danger-rgb),0.4)",
                                borderRadius: 7,
                                background: "rgba(var(--accent-danger-rgb),0.08)",
                                color: "var(--accent-danger)",
                                fontSize: "0.72rem",
                                fontWeight: 600,
                                padding: "4px 10px",
                                cursor: "pointer",
                            }}
                        >
                            <StopCircle size={13} /> Stop
                        </button>
                    )}
                    {job.status === "done" && (
                        <button
                            type="button"
                            onClick={onView}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                border: "1px solid var(--border-primary)",
                                borderRadius: 7,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                fontSize: "0.72rem",
                                fontWeight: 600,
                                padding: "4px 10px",
                                cursor: "pointer",
                            }}
                        >
                            <Eye size={13} /> View
                        </button>
                    )}
                </span>
            </div>
            {job.status === "running" && job.progress.length > 0 && <QbgProgressLog progress={job.progress} />}
            {job.status === "error" && (
                <div style={{ fontSize: "0.76rem", color: "var(--accent-danger)" }}>{job.error || "Tagging failed."}</div>
            )}
            {job.status === "cancelled" && (
                <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>{job.error || "Cancelled."}</div>
            )}
        </div>
    );
}


/**
 * History listings omit the bulk payload (it made the list take tens of MB), so
 * opening a report fetches that task's full data first. Falls back to whatever
 * the list already had if the fetch fails, so a report still opens offline.
 */
async function fetchFullTaskData(id: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetch(`/api/ai-tools/qbg-tasks?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const json = (await res.json()) as { success?: boolean; task?: { data?: Record<string, unknown> } };
        if (!res.ok || !json.success || !json.task) return null;
        return json.task.data || {};
    } catch {
        return null;
    }
}

/** The subject the panel starts on. Empty selection means every subject. */
const DEFAULT_TAG_SUBJECT = "Physics";

export default function QbgTaggingPanel() {
    const [mode, setMode] = useState<"ai" | "csv">("ai");
    const [qbgIds, setQbgIds] = useState("");
    const [csvFile, setCsvFile] = useState<File | null>(null);

    // Which slice of the bundled tagging table the AI picks from. Blank = the
    // question's own QBG category, which is right until a category is newer than
    // the table (RankUp Test Series has no rows of its own).
    const [taxonomyCategory, setTaxonomyCategory] = useState<string>("");
    // Subjects the tagger may choose from. An empty set means "all"; the panel
    // opens on Physics alone (2026-09-05 request) because that is what these runs
    // are almost always for, and an unrestricted list is what lets a Physics
    // question end up under Maths when the two share a chapter name.
    const [taxonomy, setTaxonomy] = useState<{ categories: string[]; allSubjects: string[];
        subjectsByCategory: Record<string, string[]> } | null>(null);
    const [subjects, setSubjects] = useState<string[]>([DEFAULT_TAG_SUBJECT]);

    useEffect(() => {
        void (async () => {
            try {
                const res = await fetch("/api/ai-tools/qbg-tagging?taxonomy=1", { cache: "no-store" });
                const data = await res.json();
                if (data?.success) {
                    setTaxonomy({
                        categories: data.categories || [],
                        allSubjects: data.allSubjects || [],
                        subjectsByCategory: data.subjectsByCategory || {},
                    });
                }
            } catch {
                /* the pickers just fall back to "all" */
            }
        })();
    }, []);

    /** Subjects offered for the chosen taxonomy slice (all of them when Auto). */
    const subjectPool = useMemo(
        () => (taxonomyCategory && taxonomy?.subjectsByCategory[taxonomyCategory]) || taxonomy?.allSubjects || [],
        [taxonomy, taxonomyCategory]
    );

    // Keep the selection inside what the chosen taxonomy actually offers. This
    // matters most on the first load: the panel defaults to Physics before the
    // taxonomy has arrived, and a category with no Physics rows would otherwise
    // restrict the tagger to a subject that cannot match anything. Falling back
    // to an empty set means "all subjects", the safe end of the trade.
    useEffect(() => {
        if (subjectPool.length === 0) return;
        setSubjects((prev) => {
            const kept = prev.filter((s) => subjectPool.includes(s));
            if (kept.length === prev.length) return prev;
            return kept;
        });
    }, [subjectPool]);

    const [provider, setProvider] = useState<AIModelProvider>("gemini");
    const [modelId, setModelId] = useState<string>(AI_PROVIDER_MODELS.gemini[0]?.id || "");
    const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({ ...AI_PROVIDER_MODELS });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resultView, setResultView] = useState<{ source: "queue" | "history"; jobId?: string; data: ApiResult } | null>(null);
    const { trackAsyncJob, forgetAsyncJob, activeAsyncJobs } = useAIJobQueue();

    const providerRef = useRef(provider);
    useEffect(() => { providerRef.current = provider; }, [provider]);
    const modelReqRef = useRef(0);

    const currentModels = providerModels[provider] || AI_PROVIDER_MODELS[provider] || [];

    const onProviderChange = (p: AIModelProvider) => {
        setProvider(p);
        const list = providerModels[p] || AI_PROVIDER_MODELS[p] || [];
        setModelId(list[0]?.id || "");
        setModelLoadError(null);
    };

    const loadModels = useCallback(async (prov: AIModelProvider) => {
        const reqId = ++modelReqRef.current;
        setLoadingModels(true);
        setModelLoadError(null);
        try {
            const headers: Record<string, string> = {};
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                const cred = getProviderApiCredential(prov as SupportedApiProvider, devKeys[prov as SupportedApiProvider] || "");
                if (cred) headers["x-dev-api-key"] = cred;
            }
            const res = await fetch(`/api/ai-tools/models?provider=${prov}`, { headers, cache: "no-store" });
            const payload = (await res.json()) as { success?: boolean; models?: ModelOption[]; error?: string };
            if (!res.ok || !payload.success || !Array.isArray(payload.models) || payload.models.length === 0) {
                throw new Error(payload.error || "Could not load live models.");
            }
            if (modelReqRef.current !== reqId) return;
            const models = payload.models;
            setProviderModels((prev) => ({ ...prev, [prov]: models }));
            if (providerRef.current === prov) {
                setModelId((prev) => (models.some((m) => m.id === prev) ? prev : models[0]?.id || prev));
            }
        } catch (err) {
            if (modelReqRef.current !== reqId) return;
            setProviderModels((prev) => ({ ...prev, [prov]: AI_PROVIDER_MODELS[prov] || [] }));
            if (providerRef.current === prov) {
                setModelLoadError(
                    (err instanceof Error ? err.message : "Could not load live models.") + " Showing the built-in list."
                );
            }
        } finally {
            if (modelReqRef.current === reqId) setLoadingModels(false);
        }
    }, []);

    useEffect(() => {
        if (mode === "ai") void loadModels(provider);
    }, [mode, provider, loadModels]);

    // ---- history ----
    const [reports, setReports] = useState<ReportRow[]>([]);
    const [loadingReports, setLoadingReports] = useState(false);
    const loadReports = useCallback(async () => {
        setLoadingReports(true);
        try {
            // qbg_tasks-backed history: running + done + failed, session-free.
            const res = await fetch("/api/ai-tools/qbg-tasks?type=qbg_tagging", { cache: "no-store" });
            const data = (await res.json()) as {
                success?: boolean;
                tasks?: { id: string; label: string; status: string; error: string | null; provider: string; model_id: string; data: Record<string, unknown>; created_at: string }[];
            };
            if (res.ok && data.success) {
                setReports(
                    (data.tasks || []).map((t) => ({
                        id: t.id,
                        file_name: t.label,
                        provider: t.provider,
                        model_id: t.model_id,
                        created_at: t.created_at,
                        report_data: { success: true, ...(t.data as object), status: t.status, error: t.error ?? undefined } as ReportRow["report_data"],
                    }))
                );
            }
        } catch {
            /* best-effort */
        } finally {
            setLoadingReports(false);
        }
    }, []);
    useEffect(() => {
        void loadReports();
    }, [loadReports]);

    // When a background QBG task finishes (tracked-job count drops), refresh history.
    useEffect(() => {
        void loadReports();
    }, [activeAsyncJobs.length, loadReports]);

    // ---- queue (lets a second/third batch be submitted while one is running) ----
    const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);
    const prevStatusesRef = useRef<Record<string, QueueJobStatus>>({});

    const loadQueue = useCallback(async () => {
        try {
            const res = await fetch("/api/ai-tools/qbg-tagging?queue=1", { cache: "no-store" });
            const data = (await res.json()) as { success?: boolean; jobs?: QueueJob[] };
            if (res.ok && data.success) setQueueJobs(data.jobs || []);
        } catch {
            /* best-effort — next poll tick retries */
        }
    }, []);

    useEffect(() => {
        void loadQueue();
    }, [loadQueue]);

    // Poll while anything is queued or running; stop otherwise (re-armed by
    // handleRun's own loadQueue() call right after a new job is submitted).
    useEffect(() => {
        const hasActive = queueJobs.some((j) => j.status === "queued" || j.status === "running");
        if (!hasActive) return;
        const t = setInterval(() => void loadQueue(), 2500);
        return () => clearInterval(t);
    }, [queueJobs, loadQueue]);

    // React to status transitions: register/forget with the app-wide floating
    // tracker only while a job is genuinely "running" (a "queued" job hasn't
    // started yet, so there's nothing worth surfacing there); refresh history
    // once a job leaves the queue; auto-show a job's results the moment it's done.
    useEffect(() => {
        const prev = prevStatusesRef.current;
        let anyFinished = false;
        for (const job of queueJobs) {
            const before = prev[job.id];
            if (before !== "running" && job.status === "running") {
                trackAsyncJob({
                    jobId: job.id,
                    kind: "qbg_tagging",
                    label: job.label,
                    pollUrl: `/api/ai-tools/qbg-tagging?jobId=${encodeURIComponent(job.id)}`,
                    startedAt: new Date(job.startedAt || Date.now()).toISOString(),
                });
            }
            if (before === "running" && job.status !== "running") {
                forgetAsyncJob(job.id);
            }
            if (before !== undefined && before !== job.status && (job.status === "done" || job.status === "error" || job.status === "cancelled")) {
                anyFinished = true;
                if (job.status === "done") {
                    const data = jobToApiResult(job);
                    if (data) setResultView({ source: "queue", jobId: job.id, data });
                }
            }
        }
        const next: Record<string, QueueJobStatus> = {};
        queueJobs.forEach((j) => { next[j.id] = j.status; });
        prevStatusesRef.current = next;
        if (anyFinished) void loadReports();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [queueJobs, trackAsyncJob, forgetAsyncJob]);

    async function handleCancel(jobId: string) {
        try {
            await fetch(`/api/ai-tools/qbg-tagging?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
        } catch {
            /* ignore — queue poll will reflect the true state either way */
        }
        void loadQueue();
    }

    const viewReport = async (r: ReportRow) => {
        setError(null);
        setResultView({ source: "history", data: { ...r.report_data, success: true } });
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        const full = await fetchFullTaskData(r.id);
        if (full) setResultView({ source: "history", data: { ...r.report_data, ...full, success: true } });
    };
    const deleteReport = async (id: string) => {
        try {
            await fetch(`/api/ai-tools/qbg-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        } catch {
            /* ignore */
        }
        void loadReports();
    };

    async function handleRun() {
        setError(null);
        if (mode === "ai") {
            if (!qbgIds.trim()) {
                setError("Paste at least one QBG unique_id.");
                return;
            }
            if (!modelId.trim()) {
                setError("Please choose a model.");
                return;
            }
        } else if (!csvFile) {
            setError("Please choose a tagging CSV file.");
            return;
        }
        setSubmitting(true);
        try {
            let tagCsv: string | undefined;
            if (mode === "csv" && csvFile) tagCsv = await csvFile.text();

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                headers["x-dev-qbg"] = devKeys.qbg || "";
                if (mode === "ai") {
                    const cred = getProviderApiCredential(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
                    if (cred) headers["x-dev-api-key"] = cred;
                    const baseUrl = getProviderBaseUrl(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
                    if (baseUrl) headers["x-dev-base-url"] = baseUrl;
                }
            }

            const res = await fetch("/api/ai-tools/qbg-tagging", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    mode,
                    qbgIds: mode === "ai" ? qbgIds.trim() : undefined,
                    tagCsv,
                    provider: mode === "ai" ? provider : undefined,
                    modelId: mode === "ai" ? modelId.trim() : undefined,
                    taxonomyCategory: mode === "ai" ? taxonomyCategory : undefined,
                    subjects: mode === "ai" && subjects.length > 0 ? subjects : undefined,
                }),
            });
            const start = (await res.json()) as { success?: boolean; jobId?: string; position?: number; error?: string };
            if (!res.ok || !start.success || !start.jobId) {
                throw new Error(start.error || `Request failed (${res.status}).`);
            }
            // Submitted — clear the input so a next batch can be queued right away.
            // The queue poll (loadQueue below) picks up its live status; tracking
            // with the floating notifier and history refresh happen reactively
            // once it's observed as "running" (see the queueJobs effect above).
            if (mode === "ai") setQbgIds(""); else setCsvFile(null);
            void loadQueue();
            void loadReports();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    const diffName = (r: TagResultItem) =>
        r.meta?.difficulty_name || DIFF_LABEL[String(r.tags?.difficulty ?? "")] || String(r.tags?.difficulty ?? "");

    return (
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
            <p style={{ margin: "0 0 18px", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                Tag QBG questions with subject / chapter / topic / subtopic + difficulty. Paste QBG IDs and
                let AI pick the nearest tag from the crawled taxonomy, or upload a ready tagging CSV to write
                directly. Both modes <b>write straight to the live QBG software</b> (they update each question&rsquo;s tags).
            </p>

            <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
                {/* Step 1 — input */}
                <div style={card}>
                    <div style={{ ...label, marginBottom: 8 }}>1 · Choose the input</div>
                    <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)", marginBottom: 12 }}>
                        {(["ai", "csv"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                style={{
                                    border: "none",
                                    borderRadius: 8,
                                    padding: "7px 14px",
                                    fontSize: "0.8rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    background: mode === m ? "var(--accent-glow)" : "transparent",
                                    color: mode === m ? "var(--accent-primary-hover)" : "var(--text-tertiary)",
                                }}
                            >
                                {m === "ai" ? "Paste QBG IDs (AI matches tags)" : "Upload tagging CSV (direct)"}
                            </button>
                        ))}
                    </div>
                    {mode === "ai" ? (
                        <div>
                            <textarea
                                value={qbgIds}
                                onChange={(e) => setQbgIds(e.target.value)}
                                placeholder={"Paste QBG unique_ids, one per line\noe7d4wwomwwcuwoh7o7g0lajr\n424xrstyqv3cdda2wdungfb4m"}
                                style={{ ...input, minHeight: 96, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
                            />
                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 6 }}>
                                Each question is fetched, AI picks the nearest subject → chapter → topic → subtopic and a difficulty (1–3), then it&rsquo;s written to QBG.
                            </div>
                        </div>
                    ) : (
                        <label
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                border: "1px dashed var(--border-accent)",
                                borderRadius: 10,
                                padding: "16px 18px",
                                cursor: "pointer",
                                background: "var(--bg-tertiary)",
                            }}
                        >
                            <FileUp size={20} color="var(--accent-primary)" />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    {csvFile ? csvFile.name : "Choose a tagging CSV"}
                                </div>
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    Columns: qbg_id, subject_id, chapter_id, topic_id, sub_topic_id, difficulty_level, class_id (+ names). No AI — written as-is.
                                </div>
                            </div>
                            {csvFile && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setCsvFile(null);
                                    }}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)" }}
                                >
                                    <X size={16} />
                                </button>
                            )}
                            <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)} />
                        </label>
                    )}
                </div>

                {/* Step 2 — model (AI mode only) */}
                {mode === "ai" && (
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>2 · Choose the AI model</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Provider</span>
                                <select value={provider} onChange={(e) => onProviderChange(e.target.value as AIModelProvider)} style={input}>
                                    {PROVIDERS.map((p) => (
                                        <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>
                                    ))}
                                </select>
                            </label>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Model</span>
                                <div style={{ display: "flex", gap: 6 }}>
                                    <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ ...input, flex: 1 }}>
                                        {currentModels.length === 0 && <option value="">No models</option>}
                                        {currentModels.map((m) => (
                                            <option key={m.id} value={m.id}>{m.label || m.id}</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => void loadModels(provider)}
                                        disabled={loadingModels}
                                        title="Refresh models from the provider"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: 8,
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            padding: "0 10px",
                                            cursor: loadingModels ? "default" : "pointer",
                                            opacity: loadingModels ? 0.6 : 1,
                                            display: "grid",
                                            placeItems: "center",
                                        }}
                                    >
                                        <RefreshCw size={14} className={loadingModels ? "animate-spin" : ""} />
                                    </button>
                                </div>
                            </label>
                        </div>
                        {modelLoadError && (
                            <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{modelLoadError}</div>
                        )}

                        {/* Which slice of the tagging table the model chooses from.
                            Needed when a question's own QBG category is newer than the
                            bundled taxonomy (RankUp Test Series), which otherwise fails
                            with "no tagging rows for category …". */}
                        <label style={{ display: "grid", gap: 5, marginTop: 12 }}>
                            <span style={label}>Taxonomy to match against</span>
                            <select
                                value={taxonomyCategory}
                                onChange={(e) => setTaxonomyCategory(e.target.value)}
                                style={input}
                            >
                                <option value="">Auto — each question&rsquo;s own QBG category</option>
                                {(taxonomy?.categories.length ? taxonomy.categories : TAXONOMY_CATEGORIES).map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                ))}
                            </select>
                            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                Leave on Auto unless tagging fails with “no tagging rows for
                                category …”. A QBG category whose tree hasn&rsquo;t been crawled into the
                                bundled taxonomy yet — pick the closest tree here and the tags still
                                apply, because subject/chapter/topic ids are shared across categories.
                            </span>
                        </label>

                        {/* Subject narrowing. Chapter names repeat across subjects
                            ("Mathematical Tools and Vectors" exists under Physics AND
                            Maths), so a Physics question was being filed under Maths.
                            Restricting the shortlist decides it before the model sees
                            the list.

                            A tick means exactly what it looks like. An empty selection
                            used to be DRAWN as every chip ticked ("all subjects"), so
                            the button that produced it read "Reset to all" and left the
                            picker looking full — now the button unticks everything and
                            the picker shows nothing ticked (2026-09-05 request). No
                            subject ticked still means the tagger may use any of them;
                            the label says so. */}
                        {(() => {
                            const pool = subjectPool;
                            if (pool.length === 0) return null;
                            const chosen = new Set(subjects);
                            const none = chosen.size === 0;
                            return (
                                <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        <span style={label}>Subjects to tag under</span>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            {none ? "none ticked — every subject considered" : `${chosen.size} selected`}
                                        </span>
                                        {!none && (
                                            <button
                                                type="button"
                                                onClick={() => setSubjects([])}
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: 7,
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-secondary)",
                                                    fontSize: "0.72rem",
                                                    padding: "3px 9px",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Untick all
                                            </button>
                                        )}
                                    </div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                        {pool.map((s) => {
                                            const on = chosen.has(s);
                                            return (
                                                <label
                                                    key={s}
                                                    style={{
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: 6,
                                                        border: `1px solid ${on ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                        borderRadius: 999,
                                                        padding: "4px 11px",
                                                        fontSize: "0.78rem",
                                                        cursor: "pointer",
                                                        background: on ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                        color: on ? "var(--text-primary)" : "var(--text-tertiary)",
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={on}
                                                        onChange={(e) => {
                                                            const next = e.target.checked
                                                                ? [...new Set([...chosen, s])]
                                                                : [...chosen].filter((x) => x !== s);
                                                            setSubjects(next);
                                                        }}
                                                    />
                                                    {s}
                                                </label>
                                            );
                                        })}
                                    </div>
                                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        Physics is ticked to begin with. Tick more, or untick everything to let the
                                        tagger consider any subject. This matters when a chapter name exists under
                                        more than one subject — tagging a Physics paper with only Physics ticked,
                                        “Mathematical Tools and Vectors” can&rsquo;t be filed under Maths.
                                    </span>
                                </div>
                            );
                        })()}
                    </div>
                )}

                {/* Run */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {(() => {
                        const hasActive = queueJobs.some((j) => j.status === "queued" || j.status === "running");
                        const notReady = submitting || (mode === "ai" ? !qbgIds.trim() : !csvFile);
                        return (
                            <button
                                type="button"
                                onClick={handleRun}
                                disabled={notReady}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 8,
                                    border: "none",
                                    borderRadius: 12,
                                    padding: "12px 20px",
                                    background: notReady ? "var(--bg-hover)" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                                    color: "#fff",
                                    fontSize: "0.9rem",
                                    fontWeight: 700,
                                    cursor: notReady ? "default" : "pointer",
                                    opacity: notReady ? 0.7 : 1,
                                }}
                            >
                                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Tags size={16} />}
                                {submitting ? "Submitting…" : hasActive ? "Add to queue" : "Tag & write to QBG"}
                            </button>
                        );
                    })()}
                    {queueJobs.some((j) => j.status === "running") && (
                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                            You can submit another batch now — it&rsquo;ll queue and start automatically once the current one finishes.
                        </span>
                    )}
                </div>

                {/* Queue — live status for jobs waiting/running/just finished */}
                {queueJobs.length > 0 && (
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 10 }}>Queue</div>
                        <div style={{ display: "grid", gap: 8 }}>
                            {queueJobs.map((job) => (
                                <QueueJobRow
                                    key={job.id}
                                    job={job}
                                    onCancel={() => void handleCancel(job.id)}
                                    onView={() => setResultView({ source: "queue", jobId: job.id, data: jobToApiResult(job) || { success: false } })}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {error && (
                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "flex-start",
                            border: "1px solid rgba(var(--accent-danger-rgb),0.35)",
                            background: "rgba(var(--accent-danger-rgb),0.08)",
                            color: "var(--accent-danger)",
                            borderRadius: 10,
                            padding: "10px 12px",
                            fontSize: "0.82rem",
                        }}
                    >
                        <AlertCircle size={15} style={{ marginTop: 1, flexShrink: 0 }} />
                        <span>{error}</span>
                    </div>
                )}

                {/* Results */}
                {resultView?.data?.success && (
                    <div style={{ display: "grid", gap: 14 }}>
                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "center",
                                border: "1px solid rgba(var(--accent-success-rgb),0.35)",
                                background: "rgba(var(--accent-success-rgb),0.08)",
                                color: "var(--accent-success)",
                                borderRadius: 10,
                                padding: "10px 12px",
                                fontSize: "0.85rem",
                                fontWeight: 600,
                            }}
                        >
                            <CheckCircle2 size={16} />
                            Tagged {resultView.data.tagged} of {resultView.data.count} question(s) in QBG
                            {resultView.data.mode === "csv" ? " (from CSV)" : " (AI-matched)"}.
                        </div>

                        <div style={{ display: "grid", gap: 8 }}>
                            {(resultView.data.results || []).map((r, i) => (
                                <div key={i} style={{ ...card, padding: "12px 14px" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        {r.ok ? (
                                            <CheckCircle2 size={15} color="var(--accent-success)" />
                                        ) : (
                                            <AlertCircle size={15} color="var(--accent-danger)" />
                                        )}
                                        {r.qbg_id ? (
                                            <a
                                                href={QUESTION_URL + encodeURIComponent(r.qbg_id)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.78rem", color: "var(--accent-primary)" }}
                                            >
                                                {r.qbg_id}
                                            </a>
                                        ) : (
                                            <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>(no id)</span>
                                        )}
                                        {r.ok && r.meta?.difficulty_name && (
                                            <span
                                                style={{
                                                    fontSize: "0.66rem",
                                                    fontWeight: 700,
                                                    padding: "2px 8px",
                                                    borderRadius: 999,
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-secondary)",
                                                }}
                                            >
                                                {diffName(r)}
                                            </span>
                                        )}
                                    </div>
                                    {r.ok ? (
                                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: 6 }}>
                                            {[r.meta?.class_name && `Class ${r.meta.class_name}`, r.meta?.subject_name, r.meta?.chapter_name, r.meta?.topic_name, r.meta?.subtopic_name]
                                                .filter(Boolean)
                                                .join("  ›  ")}
                                        </div>
                                    ) : (
                                        <div style={{ fontSize: "0.8rem", color: "var(--accent-danger)", marginTop: 6 }}>
                                            {r.error || r.detail || "failed"}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Previous tasks — running + done + failed (bottom of page, like Agentic QC) */}
            <QbgTaskHistory
                reports={reports}
                activeLabels={[]}
                noun="tagging runs"
                loading={loadingReports}
                summary={(rd) =>
                    `${rd.mode === "csv" ? "CSV" : "AI"} · ${rd.tagged ?? "?"}/${rd.count ?? "?"} tagged`
                }
                onView={(r) => viewReport(r as ReportRow)}
                onDelete={(id) => void deleteReport(id)}
            />
        </div>
    );
}
