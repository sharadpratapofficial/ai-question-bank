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
    Tags,
    Wand2,
    Database,
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
import QbgTaskHistory from "@/components/qbg/QbgTaskHistory";
import QbgModifiedPreview from "@/components/qbg/QbgModifiedPreview";
import QbgPushedIds from "@/components/qbg/QbgPushedIds";
import QbgQcSettings, { type QcConfig } from "@/components/qbg/QbgQcSettings";
import QbgQcReport from "@/components/qbg/QbgQcReport";
import QbgKeyBalance from "@/components/qbg/QbgKeyBalance";
import type { QcResult, QcSummary } from "@/lib/api/qbgModification";
import { QBG_CATEGORIES } from "@/lib/qbgCategories";
import { tagQbgIds, type TagIdsResult } from "@/lib/api/qbgTagIds";
import { findLaterChapterUse } from "@/lib/qbgSyllabus";
import QbgLaterChapterWarning from "@/components/qbg/QbgLaterChapterWarning";
import { checkQbgTokenBeforeRun } from "@/lib/qbgToken";

// Same LLM providers the rest of the app offers.
const PROVIDERS = Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[];

// QBG (PenPencil) categories — shared with QBG Ingestion and the Pipeline.

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

interface PreviewOption {
    isCorrect: boolean | null;
    text: string | null;
}
interface PreviewRecord {
    content: string;
    options: PreviewOption[];
    solution: string;
}
interface ApiResult {
    success: boolean;
    error?: string;
    status?: "running" | "done" | "failed";
    sourceName?: string;
    questionCount?: number;
    requestedCount?: number;
    records?: PreviewRecord[];
    originals?: { content: string; answer: string; solution: string }[];
    zipBase64?: string;
    zipName?: string;
    modifiedCsv?: string;
    originalCsv?: string;
    injected?: { savedCount: number; questionIds: string[]; errors: { questionNumber: number; error: string }[] };
    qbgResults?: { num: number; unique_id: string | null; ok: boolean; error?: string }[];
    qbgError?: string;
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    diagramResults?: { num: number; status: "regenerated" | "failed" | "needs review"; detail: string }[];
    qcResults?: QcResult[];
    qcSummary?: QcSummary;
    keyBalance?: import("@/lib/api/qbgModification").KeyBalanceReport;
    qcDiagramResults?: { num: number; status: string; detail: string }[];
    solutionDiagramResults?: { num: number; status: "generated" | "failed"; detail: string }[];
    newFigureResults?: { num: number; status: "generated" | "failed"; detail: string }[];
    /** Per-chunk issues from the batched reframe — e.g. a chunk that came back
     *  short, so the user sees exactly which questions need a retry instead of a
     *  silently smaller result. */
    warnings?: string[];
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
        /* fall through to legacy path */
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

/** The subject the tag picker starts on. Nothing ticked = every subject. */
const DEFAULT_TAG_SUBJECT = "Physics";

export default function QbgModifierPanel() {
    const [sourceMode, setSourceMode] = useState<"docx" | "qbg">("docx");
    const [file, setFile] = useState<File | null>(null);
    const [qbgIds, setQbgIds] = useState("");
    const [provider, setProvider] = useState<AIModelProvider>(DEFAULT_AI_PROVIDER);
    const [modelId, setModelId] = useState<string>(DEFAULT_AI_MODEL);
    const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({ ...AI_PROVIDER_MODELS });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);
    const [sendImages, setSendImages] = useState(true);
    const [mode, setMode] = useState<"paraphrase" | "vary_numbers" | "full_rewrite">("full_rewrite");
    const [difficulty, setDifficulty] = useState<"auto" | "harder" | "much_harder">("auto");
    const [injectToDb, setInjectToDb] = useState(false);
    const [subject, setSubject] = useState("");
    const [chapter, setChapter] = useState("");
    const [dbSource, setDbSource] = useState("");
    const [pushToQbg, setPushToQbg] = useState(false);
    const [categoryName, setCategoryName] = useState<string>("JEE");
    // Tag the ids the push mints, straight after it - the same Modify -> Tag
    // chain the QBG Pipeline runs, so reframed questions don't land untagged.
    const [tagAfterPush, setTagAfterPush] = useState(false);
    // Physics to begin with, like the QBG Tagging tab: these runs are almost
    // always Physics, and an unrestricted list is what lets a Physics question
    // land under Maths when the two share a chapter name.
    const [tagSubjects, setTagSubjects] = useState<string[]>([DEFAULT_TAG_SUBJECT]);
    const [taxonomy, setTaxonomy] = useState<{
        allSubjects: string[];
        subjectsByCategory: Record<string, string[]>;
    } | null>(null);
    const [tagging, setTagging] = useState(false);
    const [tagResult, setTagResult] = useState<TagIdsResult | null>(null);
    const [tagError, setTagError] = useState<string | null>(null);
    const [tagProgress, setTagProgress] = useState<ProgressEvent[]>([]);
    const [regenDiagrams, setRegenDiagrams] = useState(false);
    const [redrawAllFigures, setRedrawAllFigures] = useState(false);
    // On by default: it is the only thing that catches an image model drawing
    // the wrong digits, and a diagram contradicting its question is a wrong question.
    const [verifyDiagrams, setVerifyDiagrams] = useState(true);
    // QC runs after the diagrams are drawn and before the push; its model is
    // chosen separately because it has to be able to READ the figure.
    const [qc, setQc] = useState<QcConfig>({ enabled: false, provider: DEFAULT_AI_PROVIDER, modelId: DEFAULT_AI_MODEL });
    const [addFigures, setAddFigures] = useState(false);
    const [genSolutionDiagrams, setGenSolutionDiagrams] = useState(false);
    const [imgProvider, setImgProvider] = useState<"gemini" | "openai">(DEFAULT_IMG_PROVIDER);
    const [imgModel, setImgModel] = useState<string>(IMG_DEFAULT_MODEL.gemini);
    const [providerImgModels, setProviderImgModels] = useState<Record<string, { id: string; label: string }[]>>({
        ...IMG_FALLBACK_MODELS,
    });
    const [loadingImgModels, setLoadingImgModels] = useState(false);
    const [imgModelLoadError, setImgModelLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ApiResult | null>(null);
    const [progress, setProgress] = useState<ProgressEvent[]>([]);
    const { trackAsyncJob, forgetAsyncJob, activeAsyncJobs } = useAIJobQueue();

    const providerRef = useRef(provider);
    useEffect(() => { providerRef.current = provider; }, [provider]);
    const modelReqRef = useRef(0);

    const currentModels = providerModels[provider] || AI_PROVIDER_MODELS[provider] || [];

    // The subject list only matters once tagging is switched on, so it is
    // fetched then rather than on every visit to the Modifier tab.
    useEffect(() => {
        if (!tagAfterPush || taxonomy) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/ai-tools/qbg-tagging?taxonomy=1", { cache: "no-store" });
                const data = (await res.json()) as {
                    success?: boolean;
                    allSubjects?: string[];
                    subjectsByCategory?: Record<string, string[]>;
                };
                if (!res.ok || !data.success || cancelled) return;
                setTaxonomy({
                    allSubjects: data.allSubjects || [],
                    subjectsByCategory: data.subjectsByCategory || {},
                });
            } catch {
                /* the picker is optional - without it, tagging just considers every subject */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tagAfterPush, taxonomy]);

    /** Subjects offered for the category being pushed to. */
    const tagSubjectPool = useMemo(
        () => taxonomy?.subjectsByCategory[categoryName] || taxonomy?.allSubjects || [],
        [taxonomy, categoryName]
    );

    // Keep the selection inside what that category offers. The picker opens on
    // Physics before the taxonomy has loaded, and a category with no Physics rows
    // would otherwise restrict the tagger to a subject that cannot match
    // anything; an empty selection means "any subject", the safe end of that.
    useEffect(() => {
        if (tagSubjectPool.length === 0) return;
        setTagSubjects((prev) => {
            const kept = prev.filter((s) => tagSubjectPool.includes(s));
            return kept.length === prev.length ? prev : kept;
        });
    }, [tagSubjectPool]);

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
     * Tag the questions the push just created, when the user asked for it.
     *
     * Failures are surfaced on their own line rather than thrown: the reframed
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
                    subjects: tagSubjects,
                    headers: tagDevHeaders(),
                    label: `Reframe tag · ${ids.length} ID(s)`,
                    onProgress: setTagProgress,
                });
                setTagResult(res);
            } catch (err) {
                setTagError(err instanceof Error ? err.message : String(err));
            } finally {
                setTagging(false);
            }
        },
        [modelId, provider, tagAfterPush, tagSubjects, tagDevHeaders]
    );

    const onProviderChange = (p: AIModelProvider) => {
        setProvider(p);
        const list = providerModels[p] || AI_PROVIDER_MODELS[p] || [];
        setModelId(list[0]?.id || "");
        setModelLoadError(null);
    };

    // Fetch the provider's live model list (with a graceful fallback to the
    // built-in list), mirroring the AI Tools / Agentic QC model pickers.
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

    // Fetch the image-model provider's live model list (filtered to image-capable
    // models, same as python/qbg_modification/imagegen.py), with a fallback to a
    // small built-in list. Same UX as the text-model refresh above.
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

    // Only fetch once the diagram-redraw section is actually turned on (it needs
    // an image-model key, which not every user has saved).
    useEffect(() => {
        if (regenDiagrams || addFigures || genSolutionDiagrams) void loadImgModels(imgProvider);
    }, [regenDiagrams, addFigures, genSolutionDiagrams, imgProvider, loadImgModels]);

    // ---- Report history (persisted reframes) ----
    const [reports, setReports] = useState<ReportRow[]>([]);
    const [loadingReports, setLoadingReports] = useState(false);

    const loadReports = useCallback(async () => {
        setLoadingReports(true);
        try {
            // qbg_tasks-backed history: running + done + failed, session-free.
            const res = await fetch("/api/ai-tools/qbg-tasks?type=qbg_modification", { cache: "no-store" });
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
            /* history is best-effort */
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

    async function handleGenerate() {
        setError(null);
        setResult(null);
        setProgress([]);
        setTagResult(null);
        setTagError(null);
        setTagProgress([]);
        if (sourceMode === "docx") {
            if (!file) {
                setError("Please choose a .docx test file.");
                return;
            }
            if (!file.name.toLowerCase().endsWith(".docx")) {
                setError("Only .docx files are accepted.");
                return;
            }
        } else if (!qbgIds.trim()) {
            setError("Paste at least one QBG unique_id.");
            return;
        }
        if (!modelId.trim()) {
            setError("Please enter a model id.");
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
            if (sourceMode === "qbg" || pushToQbg) {
                const gate = await checkQbgTokenBeforeRun();
                if (!gate.proceed) {
                    setError(gate.error || "QBG token check failed.");
                    return;
                }
            }
            let fileBase64: string | undefined;
            let fileName: string | undefined;
            if (sourceMode === "docx" && file) {
                const buf = await file.arrayBuffer();
                let binary = "";
                const bytes = new Uint8Array(buf);
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                fileBase64 = btoa(binary);
                fileName = file.name;
            }

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            // Dev-login users store keys locally and must forward the chosen provider's
            // key (and the QBG creds); real users have them resolved server-side.
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                const cred = getProviderApiCredential(
                    provider as SupportedApiProvider,
                    devKeys[provider as SupportedApiProvider] || ""
                );
                if (cred) headers["x-dev-api-key"] = cred;
                const baseUrl = getProviderBaseUrl(
                    provider as SupportedApiProvider,
                    devKeys[provider as SupportedApiProvider] || ""
                );
                if (baseUrl) headers["x-dev-base-url"] = baseUrl;
                if (sourceMode === "qbg" || pushToQbg) headers["x-dev-qbg"] = devKeys.qbg || "";
                if (qc.enabled && qc.provider !== provider) {
                    headers["x-dev-qc-key"] = getProviderApiCredential(
                        qc.provider as SupportedApiProvider,
                        devKeys[qc.provider as SupportedApiProvider] || ""
                    );
                }
                if (regenDiagrams || addFigures || genSolutionDiagrams) {
                    headers["x-dev-img-key"] = getProviderApiCredential(
                        imgProvider as SupportedApiProvider,
                        devKeys[imgProvider as SupportedApiProvider] || ""
                    );
                }
            }

            const res = await fetch("/api/ai-tools/qbg-modification", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    source: sourceMode,
                    fileBase64,
                    fileName,
                    qbgIds: sourceMode === "qbg" ? qbgIds.trim() : undefined,
                    provider,
                    modelId: modelId.trim(),
                    sendImages,
                    injectToDb,
                    pushToQbg,
                    category: pushToQbg ? QBG_CATEGORIES[categoryName] : undefined,
                    regenDiagrams,
                    redrawAllFigures: regenDiagrams ? redrawAllFigures : undefined,
                    verifyDiagrams: regenDiagrams ? verifyDiagrams : undefined,
                    qc: qc.enabled,
                    qcProvider: qc.enabled ? qc.provider : undefined,
                    qcModel: qc.enabled ? qc.modelId : undefined,
                    addFigures,
                    genSolutionDiagrams,
                    imgProvider: (regenDiagrams || addFigures || genSolutionDiagrams) ? imgProvider : undefined,
                    imgModel: (regenDiagrams || addFigures || genSolutionDiagrams) ? imgModel.trim() : undefined,
                    mode,
                    difficulty,
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

            // The reframe runs in the background; poll until it finishes so a slow
            // job never trips an edge-proxy request timeout.
            const jobId = start.jobId;
            const jobLabel = sourceMode === "docx"
                ? `Reframe · ${file?.name || "docx"}`
                : `Reframe · ${qbgIds.trim().split(/[\s,]+/).filter(Boolean).length} QBG ID(s)`;
            trackAsyncJob({
                jobId,
                kind: "qbg_modification",
                label: jobLabel,
                pollUrl: `/api/ai-tools/qbg-modification?jobId=${encodeURIComponent(jobId)}`,
                startedAt: new Date().toISOString(),
            });
            const deadline = Date.now() + 20 * 60 * 1000; // 20 min safety cap
            for (;;) {
                await new Promise((r) => setTimeout(r, 2500));
                if (Date.now() > deadline) {
                    throw new Error("Timed out waiting for the reframe to finish.");
                }
                const pollRes = await fetch(
                    `/api/ai-tools/qbg-modification?jobId=${encodeURIComponent(jobId)}`,
                    { cache: "no-store" }
                );
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
                    throw new Error(data.error || "Reframe failed.");
                }
                setResult(data);
                forgetAsyncJob(jobId);
                void loadReports();
                // Deliberately awaited AFTER the result is on screen: a tagging
                // failure must never discard a successful reframe + push.
                await maybeTagPushedIds(data);
                break;
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    const injected = result?.injected;
    const injectSummary = useMemo(() => {
        if (!injected) return null;
        const total = injected.savedCount + injected.errors.length;
        return `${injected.savedCount} of ${total} question(s) injected into the question bank.`;
    }, [injected]);

    return (
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
                <p style={{ margin: "0 0 18px", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                    Reframe a Word test&rsquo;s MCQs with AI into fresh, QBG-format questions — with an
                    interactive HTML pack, CSV export, and optional one-click injection into the question bank.
                </p>

                <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
                    {/* Step 1 — input source */}
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>1 · Choose the input</div>
                        <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)", marginBottom: 12 }}>
                            {(["docx", "qbg"] as const).map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    onClick={() => setSourceMode(m)}
                                    style={{
                                        border: "none",
                                        borderRadius: 8,
                                        padding: "7px 14px",
                                        fontSize: "0.8rem",
                                        fontWeight: 600,
                                        cursor: "pointer",
                                        background: sourceMode === m ? "var(--accent-glow)" : "transparent",
                                        color: sourceMode === m ? "var(--accent-primary-hover)" : "var(--text-tertiary)",
                                    }}
                                >
                                    {m === "docx" ? "Upload .docx" : "QBG unique_ids"}
                                </button>
                            ))}
                        </div>
                        {sourceMode === "docx" ? (
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
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                        {file ? file.name : "Choose a .docx file"}
                                    </div>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        Any layout — the questions & solutions are read with AI, so formatting is flexible.
                                    </div>
                                </div>
                                {file && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            setFile(null);
                                        }}
                                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)" }}
                                    >
                                        <X size={16} />
                                    </button>
                                )}
                                <input
                                    type="file"
                                    accept=".docx"
                                    style={{ display: "none" }}
                                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                />
                            </label>
                        ) : (
                            <div>
                                <textarea
                                    value={qbgIds}
                                    onChange={(e) => setQbgIds(e.target.value)}
                                    placeholder={"Paste QBG unique_ids, one per line\n4ii5mxgv84bkvg16rv8akjy1j\nel9dtimjg18xf49stwcr2fvv4"}
                                    style={{ ...input, minHeight: 96, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
                                />
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 6 }}>
                                    Fetched from the QBG API using your saved QBG token (user icon → Manage API Keys → QBG).
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Step 2 — model */}
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>2 · Choose the AI model</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Provider</span>
                                <select
                                    value={provider}
                                    onChange={(e) => onProviderChange(e.target.value as AIModelProvider)}
                                    style={input}
                                >
                                    {PROVIDERS.map((p) => (
                                        <option key={p} value={p}>
                                            {AI_PROVIDER_LABELS[p]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Model</span>
                                <div style={{ display: "flex", gap: 6 }}>
                                    <select
                                        value={modelId}
                                        onChange={(e) => setModelId(e.target.value)}
                                        style={{ ...input, flex: 1 }}
                                    >
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
                            <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                {modelLoadError}
                            </div>
                        )}
                        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                            <input type="checkbox" checked={sendImages} onChange={(e) => setSendImages(e.target.checked)} />
                            <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                Send diagram images to the model (use a vision-capable model)
                            </span>
                        </label>
                        <div
                            style={{
                                marginTop: 10,
                                fontSize: "0.72rem",
                                color: "var(--text-tertiary)",
                                display: "flex",
                                gap: 6,
                                alignItems: "center",
                            }}
                        >
                            <Sparkles size={13} />
                            The provider key is read from your saved API keys (user icon → Manage API Keys).
                        </div>
                    </div>

                    {/* Reframe mode */}
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>Reframe mode</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                            {(
                                [
                                    { id: "paraphrase" as const, emoji: "🔤", title: "Paraphrase only",
                                      desc: "Same numbers, same question — just reworded so it looks new." },
                                    { id: "vary_numbers" as const, emoji: "🔢", title: "Change numbers",
                                      desc: "New numbers, same thing being asked, same difficulty." },
                                    { id: "full_rewrite" as const, emoji: "🚀", title: "Full rewrite",
                                      desc: "Everything can change, including what's asked — and it gets slightly harder." },
                                ]
                            ).map((opt) => (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setMode(opt.id)}
                                    style={{
                                        padding: 12,
                                        borderRadius: 10,
                                        border: `2px solid ${mode === opt.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                        background: mode === opt.id ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                        cursor: "pointer",
                                        textAlign: "left",
                                        display: "grid",
                                        gap: 5,
                                    }}
                                >
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, color: mode === opt.id ? "var(--accent-primary)" : "var(--text-primary)" }}>
                                        {opt.emoji} {opt.title}
                                    </div>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                        {opt.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Difficulty — independent of the mode above */}
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>Difficulty</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                            {(
                                [
                                    { id: "auto" as const, emoji: "⚖️", title: "Same as the mode",
                                      desc: "Keep whatever difficulty the reframe mode above implies." },
                                    { id: "harder" as const, emoji: "📈", title: "Harder",
                                      desc: "One extra reasoning step, or a second idea from the chapter combined in." },
                                    { id: "much_harder" as const, emoji: "🔥", title: "Much harder",
                                      desc: "JEE-Advanced level: chained steps or a non-obvious insight first." },
                                ]
                            ).map((opt) => (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setDifficulty(opt.id)}
                                    style={{
                                        padding: 12,
                                        borderRadius: 10,
                                        border: `2px solid ${difficulty === opt.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                        background: difficulty === opt.id ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                        cursor: "pointer",
                                        textAlign: "left",
                                        display: "grid",
                                        gap: 5,
                                    }}
                                >
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, color: difficulty === opt.id ? "var(--accent-primary)" : "var(--text-primary)" }}>
                                        {opt.emoji} {opt.title}
                                    </div>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                        {opt.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 8 }}>
                            The difficulty is raised through the physics — an extra step or a second concept — not
                            through messier arithmetic. It overrides the mode's own difficulty, so you can pick
                            "Paraphrase only" and still ask for harder.
                        </div>
                    </div>

                    {/* Diagrams — optional AI redraw / new figures / solution diagrams */}
                    <div style={card}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={regenDiagrams} onChange={(e) => setRegenDiagrams(e.target.checked)} />
                            <Sparkles size={15} color="var(--accent-primary)" />
                            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Redraw figures with an image model when the reframe changes their data
                            </span>
                        </label>
                        {regenDiagrams && (
                            <>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8, marginLeft: 23 }}>
                                    <input type="checkbox" checked={redrawAllFigures} onChange={(e) => setRedrawAllFigures(e.target.checked)} />
                                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                        Redraw every figure, not just the ones the AI flags as changed
                                    </span>
                                </label>
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 44, lineHeight: 1.5 }}>
                                    Without this, the AI decides per-question whether the diagram changed — and it
                                    usually says no, so a rewritten question can keep a diagram still showing the
                                    ORIGINAL question's values. Turn it on to force every diagram to be redrawn to
                                    match the new numbers (slower, and costs one image call per figure).
                                </div>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8, marginLeft: 23 }}>
                                    <input type="checkbox" checked={verifyDiagrams} onChange={(e) => setVerifyDiagrams(e.target.checked)} />
                                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                        Check each redrawn diagram against the question, and redraw it if it disagrees
                                    </span>
                                </label>
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 44, lineHeight: 1.5 }}>
                                    Image models draw digits unreliably: told to change &ldquo;5 &Omega;&rdquo; to
                                    &ldquo;8 &Omega;&rdquo; they sometimes produce &ldquo;3 &Omega;&rdquo;. With this on,
                                    every redrawn figure is read back and compared with the question, and redrawn (up to
                                    3 attempts) when it contradicts it; anything still wrong is listed as
                                    &ldquo;needs review&rdquo; instead of shipping silently. Costs one extra AI call per
                                    redrawn figure. Leave it on unless you are short of tokens.
                                </div>
                            </>
                        )}
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 10 }}>
                            <input type="checkbox" checked={addFigures} onChange={(e) => setAddFigures(e.target.checked)} />
                            <Sparkles size={15} color="var(--accent-primary)" />
                            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Create a diagram for a question that has none but would be clearer with one
                            </span>
                        </label>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 23 }}>
                            The AI decides per-question — only where a diagram carries information the words can't
                            (a labelled circuit, a geometry or ray construction, a pulley/incline setup), never as
                            decoration for a question that's already clear.
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 10 }}>
                            <input type="checkbox" checked={genSolutionDiagrams} onChange={(e) => setGenSolutionDiagrams(e.target.checked)} />
                            <Sparkles size={15} color="var(--accent-primary)" />
                            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Draw a solution diagram when a solution genuinely needs one
                            </span>
                        </label>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 23 }}>
                            The AI decides per-question — used rarely, only for setups like U-tubes/manometers or ray
                            diagrams where the solution is hard to follow without a picture, never for routine
                            force/free-body-diagram questions.
                        </div>
                        {(regenDiagrams || addFigures || genSolutionDiagrams) && (
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
                                            <select
                                                value={imgModel}
                                                onChange={(e) => setImgModel(e.target.value)}
                                                style={{ ...input, flex: 1 }}
                                            >
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
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        {imgModelLoadError}
                                    </div>
                                )}
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    Experimental. Only figures the model flags as changed are redrawn from the original, using your saved{" "}
                                    {imgProvider === "openai" ? "OpenAI" : "Gemini"} key — always eyeball the new diagram against the new question.
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
                                Also inject the reframed questions into the question bank
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
                                    <input value={dbSource} onChange={(e) => setDbSource(e.target.value)} placeholder="<file> (QBG Modification)" style={input} />
                                </label>
                            </div>
                        )}
                    </div>

                    {/* Step 4 — push to external QBG */}
                    <div style={card}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={pushToQbg} onChange={(e) => setPushToQbg(e.target.checked)} />
                            <Sparkles size={15} color="var(--accent-primary)" />
                            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Also push the reframed questions to the QBG software (PenPencil API)
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
                                    Diagrams are uploaded to QBG&rsquo;s S3 automatically. Uses your saved QBG token / user / user-id.
                                </div>

                                {/* Chain tagging onto the ids the push mints — the same
                                    Modify → Tag step the QBG Pipeline offers. */}
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
                                    <div style={{ display: "grid", gap: 8 }}>
                                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            Runs straight after the push, on the new QBG ids, using the model chosen above —
                                            subject / chapter / topic / subtopic + difficulty, matched against the
                                            &ldquo;{categoryName}&rdquo; taxonomy. Tagging is queued, so it waits if another
                                            tagging job is already running.
                                        </div>

                                        {/* Subject narrowing. Chapter names repeat across
                                            subjects ("Mathematical Tools and Vectors" exists
                                            under Physics AND Maths), so a Physics question can
                                            be filed under Maths. Unlike the Pipeline there is no
                                            pooled subject to inherit here, so it is asked for —
                                            optional, all subjects by default. */}
                                        {(() => {
                                            const pool = tagSubjectPool;
                                            if (pool.length === 0) return null;
                                            const chosen = new Set(tagSubjects);
                                            const none = chosen.size === 0;
                                            return (
                                                <div style={{ display: "grid", gap: 6 }}>
                                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                                        <span style={label}>Subjects to tag under</span>
                                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                            {none ? "none ticked — every subject considered" : `${chosen.size} selected`}
                                                        </span>
                                                        {!none && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setTagSubjects([])}
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
                                                        {pool.map((sub) => {
                                                            const on = chosen.has(sub);
                                                            return (
                                                                <label
                                                                    key={sub}
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
                                                                                ? [...new Set([...chosen, sub])]
                                                                                : [...chosen].filter((x) => x !== sub);
                                                                            setTagSubjects(next);
                                                                        }}
                                                                    />
                                                                    {sub}
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                        Physics is ticked to begin with. Tick more, or untick everything to let
                                                        the tagger consider any subject. Reframing a Physics paper with only
                                                        Physics ticked, &ldquo;Mathematical Tools and Vectors&rdquo; can&rsquo;t
                                                        be filed under Maths.
                                                    </span>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* QC before pushing */}
                    <QbgQcSettings value={qc} onChange={setQc} />

                    {/* Generate */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {(() => {
                            const notReady = loading || (sourceMode === "docx" ? !file : !qbgIds.trim());
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
                            {loading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                            {loading ? "Reframing…" : "Reframe with AI"}
                        </button>
                            );
                        })()}
                        {loading && (
                            <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                Working… you can leave this page or use other features — it keeps running and
                                shows up under “Recent reframes” when done.
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
                                Reframed {result.questionCount}
                                {typeof result.requestedCount === "number" &&
                                    result.requestedCount !== result.questionCount &&
                                    ` of ${result.requestedCount}`}{" "}
                                question(s) from “{result.sourceName}”.
                            </div>

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
                                        {result.warnings.length} issue(s) during reframing — some questions may need a retry
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
                                        onClick={() =>
                                            downloadBlob(base64ToBlob(result.zipBase64!, "application/zip"), result.zipName || "reframed.zip")
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={15} /> Interactive HTML pack (.zip)
                                    </button>
                                )}
                                {result.modifiedCsv && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(new Blob([result.modifiedCsv!], { type: "text/csv" }), `${result.sourceName}_modified.csv`)
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={15} /> Modified CSV
                                    </button>
                                )}
                                {result.originalCsv && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(new Blob([result.originalCsv!], { type: "text/csv" }), `${result.sourceName}_original.csv`)
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={15} /> Original CSV
                                    </button>
                                )}
                            </div>

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
                            {result.keyBalance && (
                                <QbgKeyBalance report={result.keyBalance} cardStyle={card} />
                            )}

                            {result.qcResults && result.qcResults.length > 0 && (
                                <QbgQcReport
                                    results={result.qcResults}
                                    summary={result.qcSummary}
                                    cardStyle={card}
                                />
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

                            {/* No chapter is selected in this tool, so each question is held
                                to the chapter it was tagged under: its solution may use that
                                chapter and anything earlier in the book, but nothing later. */}
                            {tagResult && (
                                <QbgLaterChapterWarning
                                    items={findLaterChapterUse(tagResult.results || [], (_subject, filed) =>
                                        filed ? [filed] : null
                                    )}
                                    cardStyle={card}
                                    scopeLabel="the chapter they are tagged under"
                                />
                            )}

                            {result.missingIds && result.missingIds.length > 0 && (
                                <div style={{ fontSize: "0.78rem", color: "var(--accent-warning)" }}>
                                    QBG did not return {result.missingIds.length} id(s): {result.missingIds.join(", ")}
                                </div>
                            )}
                            {result.skippedUnsupported && result.skippedUnsupported.length > 0 && (
                                <div style={{ fontSize: "0.78rem", color: "var(--accent-warning)" }}>
                                    Skipped {result.skippedUnsupported.length} question(s) of an unsupported type:{" "}
                                    {result.skippedUnsupported.map((s) => `${s.qbgId} (${s.reason})`).join("; ")}
                                </div>
                            )}

                            {/* Diagram redraw results */}
                            {result.diagramResults && result.diagramResults.length > 0 && (
                                <div style={{ ...card, padding: "10px 12px", fontSize: "0.8rem" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
                                        <Sparkles size={14} color="var(--accent-primary)" />
                                        Diagram redraw — {result.diagramResults.filter((d) => d.status === "regenerated").length} redrawn,{" "}
                                        {result.diagramResults.filter((d) => d.status === "needs review").length} need review,{" "}
                                        {result.diagramResults.filter((d) => d.status === "failed").length} failed
                                    </div>
                                    {result.diagramResults.some((d) => d.status === "needs review") && (
                                        <div style={{ fontSize: "0.74rem", color: "var(--accent-warning)", marginBottom: 4 }}>
                                            A redrawn diagram was read back and still disagrees with its question. The
                                            picture was kept (it is usually closer than the original), but check those
                                            questions before using them.
                                        </div>
                                    )}
                                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--text-tertiary)" }}>
                                        {result.diagramResults.map((d, di) => (
                                            <li key={di}>
                                                {d.num ? `Q${d.num}: ` : ""}
                                                <span
                                                    style={{
                                                        color:
                                                            d.status === "regenerated"
                                                                ? "var(--accent-success)"
                                                                : d.status === "needs review"
                                                                  ? "var(--accent-warning)"
                                                                  : "var(--accent-danger)",
                                                    }}
                                                >
                                                    {d.status}
                                                </span>{" "}
                                                <span style={{ color: "var(--text-tertiary)" }}>({d.detail})</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Solution diagram generation results */}
                            {result.solutionDiagramResults && result.solutionDiagramResults.length > 0 && (
                                <div style={{ ...card, padding: "10px 12px", fontSize: "0.8rem" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
                                        <Sparkles size={14} color="var(--accent-primary)" />
                                        Solution diagrams — {result.solutionDiagramResults.filter((d) => d.status === "generated").length} generated,{" "}
                                        {result.solutionDiagramResults.filter((d) => d.status === "failed").length} failed
                                    </div>
                                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--text-tertiary)" }}>
                                        {result.solutionDiagramResults.map((d, di) => (
                                            <li key={di}>
                                                {d.num ? `Q${d.num}: ` : ""}
                                                <span style={{ color: d.status === "generated" ? "var(--accent-success)" : "var(--accent-danger)" }}>
                                                    {d.status}
                                                </span>{" "}
                                                <span style={{ color: "var(--text-tertiary)" }}>({d.detail})</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {result.newFigureResults && result.newFigureResults.length > 0 && (
                                <div style={{ ...card, padding: "10px 12px", fontSize: "0.8rem" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
                                        <Sparkles size={14} color="var(--accent-primary)" />
                                        New diagrams — {result.newFigureResults.filter((d) => d.status === "generated").length} created,{" "}
                                        {result.newFigureResults.filter((d) => d.status === "failed").length} failed
                                    </div>
                                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--text-tertiary)" }}>
                                        {result.newFigureResults.map((d, di) => (
                                            <li key={di}>
                                                {d.num ? `Q${d.num}: ` : ""}
                                                <span style={{ color: d.status === "generated" ? "var(--accent-success)" : "var(--accent-danger)" }}>
                                                    {d.status}
                                                </span>{" "}
                                                <span style={{ color: "var(--text-tertiary)" }}>({d.detail})</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Preview — shared with the QBG Pipeline's Modify stage. */}
                            <QbgModifiedPreview records={result.records || []} originals={result.originals} />
                        </div>
                    )}
                </div>

                {/* Previous tasks — running + done + failed (bottom of page, like Agentic QC) */}
                <QbgTaskHistory
                    reports={reports}
                    activeLabels={[]}
                    noun="reframes"
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
