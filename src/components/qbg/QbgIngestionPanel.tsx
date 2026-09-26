"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    Download,
    FileUp,
    Loader2,
    RefreshCw,
    Sparkles,
    Upload,
    Database,
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
import {
    DEFAULT_AI_MODEL,
    DEFAULT_AI_PROVIDER,
    DEFAULT_IMG_PROVIDER,
    IMG_DEFAULT_MODEL,
    IMG_FALLBACK_MODELS,
    IMG_PROVIDER_LABELS,
} from "@/lib/qbgAiDefaults";
import { useAIJobQueue } from "@/context/AIJobQueueContext";
import QbgProgressLog, { type ProgressEvent } from "@/components/qbg/QbgProgressLog";
import QbgPushedIds from "@/components/qbg/QbgPushedIds";
import QbgTaskHistory from "@/components/qbg/QbgTaskHistory";
import QbgPushToQbgPanel from "@/components/qbg/QbgPushToQbgPanel";
import { QBG_CATEGORIES } from "@/lib/qbgCategories";
import { checkQbgTokenBeforeRun } from "@/lib/qbgToken";
import { tagQbgIds, type TagIdsResult } from "@/lib/api/qbgTagIds";

const PROVIDERS = Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[];

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

interface QuestionMeta {
    num: number | null;
    type: "SCQ" | "MCQ" | "Numerical";
    answer: string | string[] | null;
    answer_source: string | null;
    solution_source: string | null;
    diagram_generated: boolean;
}
interface PreviewOption {
    isCorrect: boolean | null;
    text: string | null;
}
interface PreviewRecord {
    content: string;
    options: PreviewOption[];
    solution: string;
    meta: QuestionMeta | null;
}
interface ApiResult {
    success: boolean;
    error?: string;
    sourceName?: string;
    questionCount?: number;
    requestedCount?: number;
    records?: PreviewRecord[];
    meta?: QuestionMeta[];
    zipBase64?: string;
    zipName?: string;
    modifiedCsv?: string;
    injected?: { savedCount: number; questionIds: string[]; errors: { questionNumber: number; error: string }[] };
    qbgResults?: { num: number; unique_id: string | null; ok: boolean; error?: string }[];
    qbgError?: string;
    warnings?: string[];
    /** Learned-format id used to extract without the AI model (null = AI was used). */
    patternUsed?: string | null;
    /** Format id newly learned from this run (future uploads in it skip the AI). */
    patternLearned?: string | null;
}


interface ReportRow {
    id: string;
    file_name?: string;
    provider?: string;
    model_id?: string;
    created_at: string;
    report_data: ApiResult & { sourceName?: string; questionCount?: number; status?: "running" | "done" | "failed"; error?: string };
}

function downloadBlob(data: Blob, filename: string) {
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
    } catch {
        return false;
    }
}

function base64ToBlob(b64: string, mime: string): Blob {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

async function fileToBase64(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

const DOC_RE = /\.(docx?)$/i;
/** The question file may also be a structured HTML paper, which the sidecar
 *  parses directly — no AI model, so no tokens. */
const QUESTION_FILE_RE = /\.(docx?|html?|xhtml)$/i;
const HTML_RE = /\.(html?|xhtml)$/i;

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

const TYPE_BADGE: Record<string, { bg: string; fg: string }> = {
    SCQ: { bg: "var(--accent-glow)", fg: "var(--accent-primary-hover)" },
    MCQ: { bg: "rgba(var(--accent-warning-rgb),0.15)", fg: "var(--accent-warning)" },
    Numerical: { bg: "rgba(var(--accent-success-rgb),0.15)", fg: "var(--accent-success)" },
};

// Human labels for the "where did this come from" provenance chips.
const SOURCE_LABEL: Record<string, string> = {
    stated: "answer from paper",
    "answer-key": "answer from key",
    "ai-solved": "AI-solved",
    matched: "solution from paper",
    "ai-authored": "AI-authored solution",
};

function FileDrop({
    file,
    onPick,
    onClear,
    title,
    hint,
    accent,
    accept,
}: {
    file: File | null;
    onPick: (f: File | null) => void;
    onClear: () => void;
    title: string;
    hint: string;
    accent: boolean;
    /** File-picker filter; defaults to Word only (the solutions file). */
    accept?: string;
}) {
    return (
        <label
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                border: `1px dashed ${accent ? "var(--border-accent)" : "var(--border-primary)"}`,
                borderRadius: 10,
                padding: "14px 16px",
                cursor: "pointer",
                background: "var(--bg-tertiary)",
            }}
        >
            <FileUp size={18} color={accent ? "var(--accent-primary)" : "var(--text-tertiary)"} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.83rem", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {file ? file.name : title}
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>{hint}</div>
            </div>
            {file && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.preventDefault();
                        onClear();
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)" }}
                >
                    <X size={16} />
                </button>
            )}
            <input type="file" accept={accept || ".doc,.docx"} style={{ display: "none" }} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
        </label>
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

export default function QbgIngestionPanel() {
    const [questionFile, setQuestionFile] = useState<File | null>(null);
    const [solutionFile, setSolutionFile] = useState<File | null>(null);
    const [separateSolution, setSeparateSolution] = useState(false);

    const [provider, setProvider] = useState<AIModelProvider>(DEFAULT_AI_PROVIDER);
    const [modelId, setModelId] = useState<string>(DEFAULT_AI_MODEL);
    const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({ ...AI_PROVIDER_MODELS });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);

    const [solveMissing, setSolveMissing] = useState(true);
    const [authorMissing, setAuthorMissing] = useState(true);
    // TEMPORARY (RankUp Test Series, 2026-09-05). Their solution documents carry
    // Effective Approach / Physical and Consistency Checks / Wrong Answer Analysis
    // around the worked solution, and all of it has to reach QBG. Every other paper
    // wants today's behaviour, so this is off by default and self-contained enough
    // to delete once that series is ingested.
    const [richSolution, setRichSolution] = useState(false);
    // Off by default: an HTML paper is read structurally first, because that path
    // copies the document rather than re-writing it, and falls back to the AI by
    // itself when the layout does not match. See html_ingest.py.
    const [htmlAi, setHtmlAi] = useState(false);
    const [genDiagrams, setGenDiagrams] = useState(false);
    const [imgProvider, setImgProvider] = useState<"gemini" | "openai">(DEFAULT_IMG_PROVIDER);
    const [imgModel, setImgModel] = useState<string>(IMG_DEFAULT_MODEL.gemini);
    const [providerImgModels, setProviderImgModels] = useState<Record<string, { id: string; label: string }[]>>({
        ...IMG_FALLBACK_MODELS,
    });
    const [loadingImgModels, setLoadingImgModels] = useState(false);
    const [imgModelLoadError, setImgModelLoadError] = useState<string | null>(null);

    const [injectToDb, setInjectToDb] = useState(false);
    const [subject, setSubject] = useState("");
    const [chapter, setChapter] = useState("");
    const [dbSource, setDbSource] = useState("");
    const [pushToQbg, setPushToQbg] = useState(false);
    // Tag the ids the push mints, straight after it — the ingestion equivalent of
    // the pipeline's Modify → Tag chain.
    const [tagAfterPush, setTagAfterPush] = useState(false);
    const [tagging, setTagging] = useState(false);
    const [tagResult, setTagResult] = useState<TagIdsResult | null>(null);
    const [tagError, setTagError] = useState<string | null>(null);
    const [tagProgress, setTagProgress] = useState<ProgressEvent[]>([]);
    const [categoryName, setCategoryName] = useState<string>("JEE");

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ApiResult | null>(null);
    const [progress, setProgress] = useState<ProgressEvent[]>([]);
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
        void loadModels(provider);
    }, [provider, loadModels]);

    const imgProviderRef = useRef(imgProvider);
    useEffect(() => { imgProviderRef.current = imgProvider; }, [imgProvider]);
    const imgModelReqRef = useRef(0);

    const currentImgModels = providerImgModels[imgProvider] || IMG_FALLBACK_MODELS[imgProvider] || [];

    const loadImgModels = useCallback(async (prov: "gemini" | "openai") => {
        const reqId = ++imgModelReqRef.current;
        setLoadingImgModels(true);
        setImgModelLoadError(null);
        try {
            const headers: Record<string, string> = {};
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                const cred = getProviderApiCredential(prov as SupportedApiProvider, devKeys[prov as SupportedApiProvider] || "");
                if (cred) headers["x-dev-img-key"] = cred;
            }
            const res = await fetch(`/api/ai-tools/image-models?provider=${prov}`, { headers, cache: "no-store" });
            const payload = (await res.json()) as { success?: boolean; models?: { id: string; label: string }[]; error?: string };
            if (!res.ok || !payload.success || !Array.isArray(payload.models) || payload.models.length === 0) {
                throw new Error(payload.error || "Could not load live image models.");
            }
            if (imgModelReqRef.current !== reqId) return;
            const models = payload.models;
            setProviderImgModels((prev) => ({ ...prev, [prov]: models }));
            if (imgProviderRef.current === prov) {
                setImgModel((prev) => (models.some((m) => m.id === prev) ? prev : models[0]?.id || prev));
            }
        } catch (err) {
            if (imgModelReqRef.current !== reqId) return;
            setProviderImgModels((prev) => ({ ...prev, [prov]: IMG_FALLBACK_MODELS[prov] }));
            if (imgProviderRef.current === prov) {
                setImgModelLoadError(
                    (err instanceof Error ? err.message : "Could not load live image models.") + " Showing the built-in default."
                );
            }
        } finally {
            if (imgModelReqRef.current === reqId) setLoadingImgModels(false);
        }
    }, []);

    useEffect(() => {
        if (genDiagrams) void loadImgModels(imgProvider);
    }, [genDiagrams, imgProvider, loadImgModels]);

    // ---- Report history (persisted ingestions) ----
    const [reports, setReports] = useState<ReportRow[]>([]);
    const [loadingReports, setLoadingReports] = useState(false);

    const loadReports = useCallback(async () => {
        setLoadingReports(true);
        try {
            // qbg_tasks-backed history: running + done + failed, session-free.
            const res = await fetch("/api/ai-tools/qbg-tasks?type=qbg_ingestion", { cache: "no-store" });
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

    // Refresh history when a background QBG task finishes.
    useEffect(() => {
        void loadReports();
    }, [activeAsyncJobs.length, loadReports]);

    const viewReport = async (r: ReportRow) => {
        setError(null);
        setResult({ ...r.report_data, success: true });
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        const full = await fetchFullTaskData(r.id);
        if (full) setResult({ ...r.report_data, ...full, success: true });
    };

    const deleteReport = async (id: string) => {
        try {
            await fetch(`/api/ai-tools/qbg-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        } catch {
            /* ignore */
        }
        void loadReports();
    };

    /** QBG credentials header for dev-auth sessions (no cookie session). The
     *  post-hoc push needs only the QBG key, not the model key. */
    const qbgDevHeaders = useCallback((): Record<string, string> => {
        if (typeof document === "undefined" || !document.cookie.includes("qbg_dev_auth=1")) return {};
        return { "x-dev-qbg": readDevApiKeysFromStorage().qbg || "" };
    }, []);

    /** Dev-auth headers for a job that needs BOTH the model key and QBG creds. */
    const tagDevHeaders = useCallback((): Record<string, string> => {
        if (typeof document === "undefined" || !document.cookie.includes("qbg_dev_auth=1")) return {};
        const devKeys = readDevApiKeysFromStorage();
        const prov = provider as SupportedApiProvider;
        const out: Record<string, string> = { "x-dev-qbg": devKeys.qbg || "" };
        const cred = getProviderApiCredential(prov, devKeys[prov] || "");
        if (cred) out["x-dev-api-key"] = cred;
        const base = getProviderBaseUrl(prov, devKeys[prov] || "");
        if (base) out["x-dev-base-url"] = base;
        return out;
    }, [provider]);

    /**
     * Tag the questions the ingestion push just created, when the user asked for
     * it. Failures are surfaced on their own line rather than thrown: the
     * questions ARE in QBG by this point, and losing that result because tagging
     * hiccuped would be the worse outcome.
     */
    const maybeTagPushedIds = useCallback(
        async (data: ApiResult) => {
            if (!tagAfterPush) return;
            const ids = (data.qbgResults || [])
                .filter((r) => r.ok && r.unique_id)
                .map((r) => r.unique_id as string);
            if (ids.length === 0) return;
            setTagResult(null);
            setTagError(null);
            setTagProgress([]);
            setTagging(true);
            try {
                const res = await tagQbgIds({
                    ids,
                    provider,
                    modelId: modelId.trim(),
                    headers: tagDevHeaders(),
                    label: `Ingestion tag · ${ids.length} ID(s)`,
                    onProgress: setTagProgress,
                });
                setTagResult(res);
            } catch (err) {
                setTagError(err instanceof Error ? err.message : String(err));
            } finally {
                setTagging(false);
            }
        },
        [modelId, provider, tagAfterPush, tagDevHeaders]
    );

    async function handleGenerate() {
        setError(null);
        setResult(null);
        setProgress([]);
        setTagResult(null);
        setTagError(null);
        setTagProgress([]);
        if (!questionFile) {
            setError("Please choose a question file (.doc, .docx or .html).");
            return;
        }
        if (!QUESTION_FILE_RE.test(questionFile.name)) {
            setError("The question file must be a .doc, .docx or .html.");
            return;
        }
        if (separateSolution && solutionFile && !DOC_RE.test(solutionFile.name)) {
            setError("The solutions file must be a .doc or .docx.");
            return;
        }
        if (!modelId.trim()) {
            setError("Please choose a model.");
            return;
        }
        if (pushToQbg && !QBG_CATEGORIES[categoryName]) {
            setError("Pick a valid QBG category to push to.");
            return;
        }
        setLoading(true);
        try {
            // Before any AI call: an expired QBG token otherwise surfaces only at the
            // push, after every AI call in the run has already been paid for.
            if (pushToQbg) {
                const gate = await checkQbgTokenBeforeRun();
                if (!gate.proceed) {
                    setError(gate.error || "QBG token check failed.");
                    return;
                }
            }
            const questionFileBase64 = await fileToBase64(questionFile);
            const useSolution = separateSolution && solutionFile;
            const solutionFileBase64 = useSolution ? await fileToBase64(solutionFile!) : undefined;

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                const cred = getProviderApiCredential(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
                if (cred) headers["x-dev-api-key"] = cred;
                const baseUrl = getProviderBaseUrl(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
                if (baseUrl) headers["x-dev-base-url"] = baseUrl;
                if (pushToQbg) headers["x-dev-qbg"] = devKeys.qbg || "";
                if (genDiagrams) {
                    headers["x-dev-img-key"] = getProviderApiCredential(
                        imgProvider as SupportedApiProvider,
                        devKeys[imgProvider as SupportedApiProvider] || ""
                    );
                }
            }

            const res = await fetch("/api/ai-tools/qbg-ingestion", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    questionFileBase64,
                    questionFileName: questionFile.name,
                    solutionFileBase64,
                    solutionFileName: useSolution ? solutionFile!.name : undefined,
                    provider,
                    modelId: modelId.trim(),
                    solveMissing,
                    authorMissing,
                    richSolution,
                    htmlAi,
                    genDiagrams,
                    imgProvider: genDiagrams ? imgProvider : undefined,
                    imgModel: genDiagrams ? imgModel.trim() : undefined,
                    injectToDb,
                    pushToQbg,
                    category: pushToQbg ? QBG_CATEGORIES[categoryName] : undefined,
                    dbDefaults: injectToDb
                        ? {
                              subject: subject.trim() || undefined,
                              chapter: chapter.trim() || undefined,
                              source: dbSource.trim() || undefined,
                          }
                        : undefined,
                }),
            });
            const start = (await res.json()) as { success?: boolean; jobId?: string; error?: string };
            if (!res.ok || !start.success || !start.jobId) {
                throw new Error(start.error || `Request failed (${res.status}).`);
            }

            const jobId = start.jobId;
            trackAsyncJob({
                jobId,
                kind: "qbg_ingestion",
                label: `Ingestion · ${questionFile.name}`,
                pollUrl: `/api/ai-tools/qbg-ingestion?jobId=${encodeURIComponent(jobId)}`,
                startedAt: new Date().toISOString(),
            });
            const deadline = Date.now() + 20 * 60 * 1000;
            for (;;) {
                await new Promise((r) => setTimeout(r, 2500));
                if (Date.now() > deadline) {
                    throw new Error("Timed out waiting for ingestion to finish.");
                }
                const pollRes = await fetch(`/api/ai-tools/qbg-ingestion?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
                if (pollRes.status === 404) {
                    forgetAsyncJob(jobId);
                    void loadReports();
                    break;
                }
                const data = (await pollRes.json()) as ApiResult & { state?: string; progress?: ProgressEvent[] };
                if (data.state === "running") {
                    if (Array.isArray(data.progress)) setProgress(data.progress);
                    continue;
                }
                if (!pollRes.ok || data.success === false || data.state === "error") {
                    forgetAsyncJob(jobId);
                    throw new Error(data.error || "Ingestion failed.");
                }
                setResult(data);
                forgetAsyncJob(jobId);
                void loadReports();
                // Chain tagging onto the ids the push just minted. Deliberately
                // AFTER the result is on screen and the job is forgotten: a
                // tagging failure must never discard a successful ingestion.
                await maybeTagPushedIds(data);
                break;
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    const optionLetter = (i: number) => "ABCD"[i] || String(i + 1);
    const injected = result?.injected;
    const injectSummary = useMemo(() => {
        if (!injected) return null;
        const total = injected.savedCount + injected.errors.length;
        return `${injected.savedCount} of ${total} question(s) added to the question bank.`;
    }, [injected]);

    const answerDisplay = (m: QuestionMeta | null): string => {
        if (!m || m.answer == null) return "—";
        return Array.isArray(m.answer) ? m.answer.join(", ") : String(m.answer);
    };

    return (
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
            <p style={{ margin: "0 0 18px", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                Upload a question Word file (with the answer key + solutions, or a separate solutions file) —
                AI extracts each question, its correct answer, its type (SCQ / MCQ / Numerical) and a worked
                solution, filling any gap, then builds a review pack and (optionally) pushes straight to QBG.
            </p>

            <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
                {/* Step 1 — files */}
                <div style={card}>
                    <div style={{ ...label, marginBottom: 8 }}>1 · Upload the paper</div>
                    <FileDrop
                        file={questionFile}
                        onPick={setQuestionFile}
                        onClear={() => setQuestionFile(null)}
                        title="Choose the question file (.doc / .docx / .html)"
                        hint="May also contain the answer key and solutions. Word: any layout, read with AI. HTML in the QBG template: copied exactly, with no model at all."
                        accept=".doc,.docx,.html,.htm,.xhtml"
                        accent
                    />
                    {questionFile && HTML_RE.test(questionFile.name) && (
                        <div
                            style={{
                                marginTop: 8,
                                display: "flex",
                                gap: 8,
                                alignItems: "flex-start",
                                border: "1px solid rgba(var(--accent-success-rgb),0.35)",
                                background: "rgba(var(--accent-success-rgb),0.08)",
                                borderRadius: 9,
                                padding: "8px 10px",
                            }}
                        >
                            <Sparkles size={14} color="var(--accent-success)" style={{ marginTop: 2 }} />
                            <span style={{ display: "grid", gap: 6, fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                                <span>
                                    HTML paper — read <b>structurally first</b>, which copies your text exactly and keeps
                                    the paper&rsquo;s own MathML, at no model cost. If the layout doesn&rsquo;t match the
                                    template, the run falls back to the AI extractor by itself and says so. Solutions must
                                    be in this same file.
                                </span>
                                <label style={{ display: "flex", alignItems: "flex-start", gap: 7, cursor: "pointer" }}>
                                    <input
                                        type="checkbox"
                                        checked={htmlAi}
                                        onChange={(e) => setHtmlAi(e.target.checked)}
                                        style={{ marginTop: 2 }}
                                    />
                                    <span>
                                        <b>Use the AI extractor instead</b> — handles any layout, but it re-writes rather
                                        than copies: expect small wording changes, and occasionally a line the document
                                        never had. Tick this only when the structural read has failed on a file you know
                                        is fine.
                                    </span>
                                </label>
                            </span>
                        </div>
                    )}
                    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            checked={separateSolution}
                            onChange={(e) => {
                                setSeparateSolution(e.target.checked);
                                if (!e.target.checked) setSolutionFile(null);
                            }}
                        />
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            Solutions are in a separate Word file
                            {questionFile && HTML_RE.test(questionFile.name) ? " (not used for an HTML paper)" : ""}
                        </span>
                    </label>
                    {separateSolution && (
                        <div style={{ marginTop: 10 }}>
                            <FileDrop
                                file={solutionFile}
                                onPick={setSolutionFile}
                                onClear={() => setSolutionFile(null)}
                                title="Choose the solutions file (.doc / .docx)"
                                hint="Answer key + worked solutions. AI matches each solution to its question by content."
                                accent={false}
                            />
                        </div>
                    )}
                </div>

                {/* Step 2 — model */}
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
                    <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={solveMissing} onChange={(e) => setSolveMissing(e.target.checked)} />
                            <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                When a question has no answer in the file, let the AI solve it
                            </span>
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={authorMissing} onChange={(e) => setAuthorMissing(e.target.checked)} />
                            <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                When there is no solution in the file, let the AI write one
                            </span>
                        </label>

                        {/* TEMPORARY — RankUp Test Series. Delete this block (and the
                            richSolution state, the API field and --rich-solution) when
                            that series is done. */}
                        <label
                            style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 8,
                                cursor: "pointer",
                                border: "1px dashed var(--border-primary)",
                                borderRadius: 9,
                                padding: "8px 10px",
                                background: richSolution ? "var(--accent-glow)" : "transparent",
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={richSolution}
                                onChange={(e) => setRichSolution(e.target.checked)}
                                style={{ marginTop: 2 }}
                            />
                            <span style={{ display: "grid", gap: 3 }}>
                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    RankUp format — keep the full solution, not just the working
                                </span>
                                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    Keeps <b>Effective Approach</b> (Recognition Cue / Micro Concept / Macro Linkage /
                                    Fast Route), <b>Detailed Solution</b>, <b>Physical and Consistency Checks</b> and{" "}
                                    <b>Wrong Answer Analysis</b> — each under its own heading, in that order. Leave this
                                    off for ordinary papers: they keep the worked solution alone, exactly as now.
                                </span>
                                <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                    Learned file-format shortcuts are skipped while this is on, so a run costs a model
                                    call even for a format ingested before.
                                </span>
                            </span>
                        </label>
                    </div>
                    <div style={{ marginTop: 10, fontSize: "0.72rem", color: "var(--text-tertiary)", display: "flex", gap: 6, alignItems: "center" }}>
                        <Sparkles size={13} />
                        The provider key is read from your saved API keys (user icon → Manage API Keys).
                    </div>
                </div>

                {/* Diagrams — optional AI generation for described-but-missing figures */}
                <div style={card}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={genDiagrams} onChange={(e) => setGenDiagrams(e.target.checked)} />
                        <Sparkles size={15} color="var(--accent-primary)" />
                        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                            Draw a diagram with an image model when a question describes one but the file has no image
                        </span>
                    </label>
                    {genDiagrams && (
                        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                <label style={{ display: "grid", gap: 5 }}>
                                    <span style={label}>Image model provider</span>
                                    <select
                                        value={imgProvider}
                                        onChange={(e) => {
                                            const p = e.target.value as "gemini" | "openai";
                                            setImgProvider(p);
                                            const list = providerImgModels[p] || IMG_FALLBACK_MODELS[p] || [];
                                            setImgModel(list[0]?.id || IMG_DEFAULT_MODEL[p]);
                                            setImgModelLoadError(null);
                                        }}
                                        style={input}
                                    >
                                        {(Object.keys(IMG_PROVIDER_LABELS) as ("gemini" | "openai")[]).map((p) => (
                                            <option key={p} value={p}>{IMG_PROVIDER_LABELS[p]}</option>
                                        ))}
                                    </select>
                                </label>
                                <label style={{ display: "grid", gap: 5 }}>
                                    <span style={label}>Image model</span>
                                    <div style={{ display: "flex", gap: 6 }}>
                                        <select value={imgModel} onChange={(e) => setImgModel(e.target.value)} style={{ ...input, flex: 1 }}>
                                            {currentImgModels.length === 0 && <option value="">No models</option>}
                                            {currentImgModels.map((m) => (
                                                <option key={m.id} value={m.id}>{m.label || m.id}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={() => void loadImgModels(imgProvider)}
                                            disabled={loadingImgModels}
                                            title="Refresh image models from the provider"
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: 8,
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                padding: "0 10px",
                                                cursor: loadingImgModels ? "default" : "pointer",
                                                opacity: loadingImgModels ? 0.6 : 1,
                                                display: "grid",
                                                placeItems: "center",
                                            }}
                                        >
                                            <RefreshCw size={14} className={loadingImgModels ? "animate-spin" : ""} />
                                        </button>
                                    </div>
                                </label>
                            </div>
                            {imgModelLoadError && (
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{imgModelLoadError}</div>
                            )}
                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                Experimental. A fresh figure is drawn from the question&rsquo;s own description using your saved{" "}
                                {imgProvider === "openai" ? "OpenAI" : "Gemini"} key — always eyeball a generated diagram before pushing.
                            </div>
                        </div>
                    )}
                </div>

                {/* Step 3 — inject */}
                <div style={card}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={injectToDb} onChange={(e) => setInjectToDb(e.target.checked)} />
                        <Database size={15} color="var(--accent-primary)" />
                        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                            Also add the extracted questions to this app&rsquo;s question bank
                        </span>
                    </label>
                    {injectToDb && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Subject (optional)</span>
                                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Physics" style={input} />
                            </label>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Chapter fallback (optional)</span>
                                <input value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="from AI if blank" style={input} />
                            </label>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Source (optional)</span>
                                <input value={dbSource} onChange={(e) => setDbSource(e.target.value)} placeholder="<file> (QBG Ingestion)" style={input} />
                            </label>
                        </div>
                    )}
                </div>

                {/* Step 4 — push to external QBG */}
                <div style={card}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={pushToQbg} onChange={(e) => setPushToQbg(e.target.checked)} />
                        <Upload size={15} color="var(--accent-primary)" />
                        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                            Push the extracted questions to the QBG software (PenPencil API)
                        </span>
                    </label>
                    {pushToQbg && (
                        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                            <label style={{ display: "grid", gap: 5, maxWidth: 280 }}>
                                <span style={label}>QBG category</span>
                                <select value={categoryName} onChange={(e) => setCategoryName(e.target.value)} style={input}>
                                    {Object.keys(QBG_CATEGORIES).map((c) => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </label>
                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                Each question is pushed with its detected type (SCQ / MCQ / Numerical). Diagrams upload to
                                QBG&rsquo;s S3 automatically. Uses your saved QBG token / user / user-id.
                            </div>

                            {/* Chain tagging onto the ids the push just minted — the
                                same Modify → Tag step the QBG Pipeline offers, so an
                                ingested paper doesn't land in QBG untagged. */}
                            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 4 }}>
                                <input
                                    type="checkbox"
                                    checked={tagAfterPush}
                                    onChange={(e) => setTagAfterPush(e.target.checked)}
                                />
                                <Tags size={15} color="var(--accent-primary)" />
                                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    Then AI-tag the pushed questions
                                </span>
                            </label>
                            {tagAfterPush && (
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    Runs straight after the push, on the new QBG ids, using the model chosen above —
                                    subject / chapter / topic / subtopic + difficulty, matched against the
                                    “{categoryName}” taxonomy. Tagging is queued, so it waits if another tagging job
                                    is already running.
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Generate */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {(() => {
                        const notReady = loading || !questionFile;
                        return (
                            <button
                                type="button"
                                onClick={handleGenerate}
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
                                {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                                {loading ? "Extracting…" : "Extract with AI"}
                            </button>
                        );
                    })()}
                    {loading && (
                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                            Working… you can leave this page — it keeps running and shows up under “Recent ingestions” when done.
                        </span>
                    )}
                </div>

                {loading && <QbgProgressLog progress={progress} />}

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
                {result?.success && (
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
                            Extracted {result.questionCount} question(s) from “{result.sourceName}”.
                        </div>

                        {(result.patternUsed || result.patternLearned) && (
                            <div
                                style={{
                                    display: "flex",
                                    gap: 8,
                                    alignItems: "center",
                                    border: "1px solid var(--border-accent)",
                                    background: "var(--accent-glow)",
                                    color: "var(--accent-primary-hover)",
                                    borderRadius: 10,
                                    padding: "8px 12px",
                                    fontSize: "0.8rem",
                                    fontWeight: 600,
                                }}
                            >
                                <Sparkles size={14} />
                                {result.patternUsed
                                    ? `Extracted with the learned format “${result.patternUsed}” — no AI model was used (₹0 model cost).`
                                    : `This file's format was learned (“${result.patternLearned}”) — future uploads in the same format will skip the AI model.`}
                            </div>
                        )}

                        {result.warnings && result.warnings.length > 0 && (
                            <div
                                style={{
                                    border: "1px solid rgba(var(--accent-warning-rgb),0.35)",
                                    background: "rgba(var(--accent-warning-rgb),0.08)",
                                    borderRadius: 10,
                                    padding: "10px 12px",
                                    fontSize: "0.8rem",
                                    color: "var(--text-secondary)",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, marginBottom: 4 }}>
                                    <AlertCircle size={14} color="var(--accent-warning)" />
                                    {result.warnings.length} note(s) — review the flagged questions
                                </div>
                                <ul style={{ margin: 0, paddingLeft: 18 }}>
                                    {result.warnings.map((w, wi) => (
                                        <li key={wi}>{w}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Downloads */}
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {result.zipBase64 && (
                                <button
                                    type="button"
                                    onClick={() => downloadBlob(base64ToBlob(result.zipBase64!, "application/zip"), result.zipName || "ingested.zip")}
                                    style={dlBtn}
                                >
                                    <Download size={15} /> Interactive HTML pack (.zip)
                                </button>
                            )}
                            {result.modifiedCsv && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        downloadBlob(new Blob([result.modifiedCsv!], { type: "text/csv" }), `${result.sourceName}_questions.csv`)
                                    }
                                    style={dlBtn}
                                >
                                    <Download size={15} /> QBG CSV
                                </button>
                            )}
                        </div>

                        {/* Push after the fact — for a run where "Push to QBG" wasn't
                            ticked. Hidden once a push has already happened, so the same
                            questions aren't duplicated into QBG by accident. */}
                        {!result.qbgResults?.length && (result.records || []).length > 0 && (
                            <QbgPushToQbgPanel
                                mode="records"
                                records={result.records || []}
                                meta={result.meta || (result.records || []).map((r) => r.meta || {})}
                                label={`Push · ${result.sourceName || "ingestion"}`}
                                devHeaders={qbgDevHeaders}
                                tagProvider={provider}
                                tagModelId={modelId}
                                tagDevHeaders={tagDevHeaders}
                                hint={`Didn't tick "Also push to QBG" before running? Send the ${(result.records || []).length} question(s) above straight to QBG — no re-extraction, no model cost. Diagrams are uploaded with them.`}
                            />
                        )}

                        {injectSummary && (
                            <div
                                style={{
                                    borderRadius: 10,
                                    padding: "10px 12px",
                                    fontSize: "0.82rem",
                                    border: injected && injected.errors.length === 0
                                        ? "1px solid rgba(var(--accent-success-rgb),0.35)"
                                        : "1px solid rgba(var(--accent-warning-rgb),0.35)",
                                    background: injected && injected.errors.length === 0
                                        ? "rgba(var(--accent-success-rgb),0.08)"
                                        : "rgba(var(--accent-warning-rgb),0.08)",
                                    color: "var(--text-secondary)",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                                    <Database size={14} /> {injectSummary}
                                </div>
                                {injected && injected.errors.length > 0 && (
                                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                                        {injected.errors.slice(0, 8).map((e) => (
                                            <li key={e.questionNumber}>Q{e.questionNumber}: {e.error}</li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}

                        {/* External QBG push results */}
                        {result.qbgError && (
                            <div
                                style={{
                                    borderRadius: 10,
                                    padding: "10px 12px",
                                    fontSize: "0.82rem",
                                    border: "1px solid rgba(var(--accent-warning-rgb),0.35)",
                                    background: "rgba(var(--accent-warning-rgb),0.08)",
                                    color: "var(--text-secondary)",
                                }}
                            >
                                QBG push skipped: {result.qbgError}
                            </div>
                        )}
                        {result.qbgResults && result.qbgResults.length > 0 && (
                            <QbgPushedIds results={result.qbgResults} cardStyle={card} />
                        )}

                        {/* Tagging of the just-pushed ids */}
                        {(tagging || tagResult || tagError) && (
                            <div style={{ ...card, padding: "12px 14px", display: "grid", gap: 8 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: "0.82rem", color: "var(--text-primary)" }}>
                                    <Tags size={14} color="var(--accent-primary)" />
                                    {tagging
                                        ? "Tagging the pushed questions…"
                                        : tagError
                                          ? "Tagging failed"
                                          : `Tagged ${tagResult?.tagged ?? 0} of ${tagResult?.count ?? 0} question(s)`}
                                </div>
                                {tagging && tagProgress.length > 0 && <QbgProgressLog progress={tagProgress} />}
                                {tagError && (
                                    <div style={{ fontSize: "0.78rem", color: "var(--accent-danger)" }}>
                                        {tagError}
                                        <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>
                                            The questions are still in QBG — only the tagging step failed. Retry it from
                                            the QBG Tagging tab with the ids above.
                                        </div>
                                    </div>
                                )}
                                {tagResult && (
                                    <div style={{ display: "grid", gap: 4, maxHeight: 240, overflowY: "auto" }}>
                                        {(tagResult.results || []).map((r, i) => (
                                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.76rem", flexWrap: "wrap" }}>
                                                {r.ok ? (
                                                    <CheckCircle2 size={13} color="var(--accent-success)" />
                                                ) : (
                                                    <AlertCircle size={13} color="var(--accent-danger)" />
                                                )}
                                                {r.qbg_id ? (
                                                    <a
                                                        href={QUESTION_URL + encodeURIComponent(r.qbg_id)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        style={{ fontFamily: "ui-monospace, monospace", color: "var(--accent-primary)" }}
                                                    >
                                                        {r.qbg_id}
                                                    </a>
                                                ) : (
                                                    <span style={{ color: "var(--text-tertiary)" }}>(no id)</span>
                                                )}
                                                {r.ok && r.meta && (
                                                    <span style={{ color: "var(--text-tertiary)" }}>
                                                        {[r.meta.subject_name, r.meta.chapter_name, r.meta.topic_name]
                                                            .filter(Boolean)
                                                            .join(" › ")}
                                                        {r.meta.difficulty_name ? ` · ${r.meta.difficulty_name}` : ""}
                                                    </span>
                                                )}
                                                {!r.ok && r.error && <span style={{ color: "var(--accent-danger)" }}>{r.error}</span>}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Preview */}
                        <div style={{ display: "grid", gap: 12 }}>
                            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)" }}>
                                Preview — always spot-check the answer and type before pushing.
                            </div>
                            {(result.records || []).map((rec, qi) => {
                                const m = rec.meta || result.meta?.[qi] || null;
                                const t = m?.type || "SCQ";
                                const badge = TYPE_BADGE[t] || TYPE_BADGE.SCQ;
                                const chips: string[] = [];
                                if (m?.answer_source && SOURCE_LABEL[m.answer_source]) chips.push(SOURCE_LABEL[m.answer_source]);
                                if (m?.solution_source && SOURCE_LABEL[m.solution_source]) chips.push(SOURCE_LABEL[m.solution_source]);
                                if (m?.diagram_generated) chips.push("AI-drawn diagram");
                                return (
                                    <div key={qi} style={card}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                                            <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--accent-primary)" }}>
                                                Question {qi + 1}
                                            </span>
                                            <span
                                                style={{
                                                    fontSize: "0.66rem",
                                                    fontWeight: 700,
                                                    letterSpacing: "0.03em",
                                                    padding: "2px 8px",
                                                    borderRadius: 999,
                                                    background: badge.bg,
                                                    color: badge.fg,
                                                }}
                                            >
                                                {t}
                                            </span>
                                            <span style={{ fontSize: "0.72rem", color: "var(--accent-success)", fontWeight: 600 }}>
                                                Answer: {answerDisplay(m)}
                                            </span>
                                            {chips.map((c) => (
                                                <span
                                                    key={c}
                                                    style={{
                                                        fontSize: "0.64rem",
                                                        fontWeight: 600,
                                                        padding: "2px 7px",
                                                        borderRadius: 999,
                                                        background: "var(--bg-tertiary)",
                                                        color: "var(--text-tertiary)",
                                                    }}
                                                >
                                                    {c}
                                                </span>
                                            ))}
                                        </div>
                                        <div style={{ fontSize: "0.9rem", color: "var(--text-primary)" }} dangerouslySetInnerHTML={{ __html: rec.content }} />
                                        <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
                                            {rec.options
                                                .filter((o) => o.text !== null)
                                                .map((o, oi) => (
                                                    <div
                                                        key={oi}
                                                        style={{
                                                            display: "flex",
                                                            gap: 8,
                                                            alignItems: "baseline",
                                                            fontSize: "0.85rem",
                                                            color: o.isCorrect ? "var(--accent-success)" : "var(--text-secondary)",
                                                            fontWeight: o.isCorrect ? 700 : 400,
                                                        }}
                                                    >
                                                        <span>({optionLetter(oi)})</span>
                                                        <span dangerouslySetInnerHTML={{ __html: o.text || "" }} />
                                                        {o.isCorrect && <CheckCircle2 size={13} />}
                                                    </div>
                                                ))}
                                        </div>
                                        {rec.solution && (
                                            <details style={{ marginTop: 8 }}>
                                                <summary style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", cursor: "pointer" }}>
                                                    Solution
                                                </summary>
                                                <div
                                                    style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: 4 }}
                                                    dangerouslySetInnerHTML={{ __html: rec.solution }}
                                                />
                                            </details>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Standalone: push a QBG CSV from ANY earlier run, including one whose
                result is no longer on screen (page reloaded, different session). */}
            <QbgPushToQbgPanel
                mode="csv"
                devHeaders={qbgDevHeaders}
                tagProvider={provider}
                tagModelId={modelId}
                tagDevHeaders={tagDevHeaders}
                title="Upload a QBG CSV into QBG"
                hint="Already have the QBG CSV from an earlier run? Upload it here to create those questions in QBG — no re-extraction, no model cost. The CSV a run produces keeps its diagrams inline, so they are uploaded too."
            />

            {/* Previous tasks — running + done + failed (bottom of page, like Agentic QC) */}
            <QbgTaskHistory
                reports={reports}
                activeLabels={[]}
                noun="ingestions"
                loading={loadingReports}
                summary={(rd) => `${rd.questionCount ?? "?"} Q`}
                onView={(r) => viewReport(r as ReportRow)}
                onDelete={(id) => void deleteReport(id)}
            />
        </div>
    );
}

const dlBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid var(--border-accent)",
    borderRadius: 9,
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontSize: "0.8rem",
    fontWeight: 600,
    padding: "9px 13px",
    cursor: "pointer",
};
