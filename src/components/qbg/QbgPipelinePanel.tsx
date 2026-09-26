"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Download, ListChecks, Loader2, RefreshCw } from "lucide-react";
import QbgPoolConfigForm, { type PoolConfigHandle } from "@/components/qbg/QbgPoolConfigForm";
import QbgProgressLog, { type ProgressEvent } from "@/components/qbg/QbgProgressLog";
import QbgTaskHistory, { type HistoryReport } from "@/components/qbg/QbgTaskHistory";
import QbgModifiedPreview, { type PreviewOriginal } from "@/components/qbg/QbgModifiedPreview";
import QbgQcSettings, { type QcConfig } from "@/components/qbg/QbgQcSettings";
import QbgQcReport from "@/components/qbg/QbgQcReport";
import QbgKeyBalance from "@/components/qbg/QbgKeyBalance";
import type { QcResult, QcSummary } from "@/lib/api/qbgModification";
import { QBG_CATEGORIES } from "@/lib/qbgCategories";
import {
    findLaterChapterUse,
    findOutOfSyllabus,
    groupOutOfSyllabus,
    permittedChaptersForSubject,
    type LaterChapterUseItem,
    type OutOfSyllabusItem,
} from "@/lib/qbgSyllabus";
import QbgLaterChapterWarning from "@/components/qbg/QbgLaterChapterWarning";
import { pollQbgJob } from "@/lib/api/qbgJobPoll";
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
import type { PoolQuestion, PoolSelectionResult } from "@/lib/api/qbgPoolSelection";
import {
    adaptPoolRowsToParsedQuestions,
    adaptModifiedRecordsToParsedQuestions,
    type ModifiedRecord,
    type ModifyQbgPushResult,
} from "@/lib/agenticQC/qbgPoolAdapter";
import type { ParsedQuestion } from "@/lib/agenticQC/parseStructured";
import type { PreparsedQuestion } from "@/lib/agenticQC/executor";
import type { JobRecord } from "@/lib/agenticQC/jobStore";
import { downloadJobAsPDF } from "@/lib/agenticQC/exports";
import { mapPoolItemsToGeneratedTest, type PoolDocItem } from "@/lib/api/qbgPoolDocMapper";
import {
    answerLetter,
    checkAnswerKeyBalance,
    rebalanceAnswerKey,
    type AnswerKeyIssue,
} from "@/lib/api/qbgPaperPlan";
import { downloadTestAsDocx, downloadTestAsPDF } from "@/lib/downloadTest";
import type { ExamPreset } from "@/types";
import { checkQbgTokenBeforeRun } from "@/lib/qbgToken";

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};
const label: React.CSSProperties = { fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" };
/** Download button — same look as QBG Modification's artefact buttons. */
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

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

/**
 * How long to keep watching a job before falling back to its DB record.
 *
 * A fixed cap can only ever be wrong in one direction: too short for a big paper.
 * Scale it with the question count instead, with a floor for start-up/queueing
 * and a ceiling so a genuinely stuck job still surfaces.
 */
function jobTimeoutMs(questionCount: number, secondsPerQuestion: number): number {
    const FLOOR_MS = 10 * 60 * 1000;
    const CEILING_MS = 3 * 60 * 60 * 1000;
    return Math.min(CEILING_MS, Math.max(FLOOR_MS, questionCount * secondsPerQuestion * 1000));
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

function base64ToBlob(b64: string, mime: string): Blob {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function csvCell(v: unknown): string {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildPoolIdsCsv(rows: PoolQuestion[]): string {
    const header = ["unique_id", "subject", "chapter", "topic", "subtopic", "class_level", "source", "question_type", "difficulty_level"];
    const lines = [header.join(",")];
    for (const r of rows) {
        lines.push(
            [r.unique_id, r.subject, r.chapter, r.topic, r.subtopic, r.class_level, r.source, r.question_type, r.difficulty_level]
                .map(csvCell)
                .join(",")
        );
    }
    return lines.join("\n");
}

/** CSV of the ids Modify produced. Pairs each NEW id with the ORIGINAL it was
 *  reframed from where that mapping is known — `num` is the question's 1-based
 *  position in the id list sent to Modify (see cli.py's _maybe_qbg_push), so it
 *  indexes back into the working set. Falls back to array position, and omits
 *  the original column entirely when the working ids aren't available. */
function buildModifiedIdsCsv(
    results: ModifyQbgPushResult[],
    originalIds: string[] | null
): string {
    const hasOriginals = Array.isArray(originalIds) && originalIds.length > 0;
    const header = hasOriginals
        ? ["original_qbg_id", "new_qbg_id", "status", "error"]
        : ["new_qbg_id", "status", "error"];
    const lines = [header.join(",")];
    results.forEach((r, i) => {
        const num = typeof r.num === "number" && r.num >= 1 ? r.num : i + 1;
        const original = hasOriginals ? (originalIds![num - 1] ?? originalIds![i] ?? "") : null;
        const row = [
            ...(hasOriginals ? [original ?? ""] : []),
            r.unique_id || "",
            r.ok ? "ok" : "failed",
            r.error || "",
        ];
        lines.push(row.map(csvCell).join(","));
    });
    return lines.join("\n");
}

interface AgentSlot {
    label: string; // "QC1" | "QC2" | "QC3" | "Aggregator"
    enabled: boolean;
    provider: AIModelProvider;
    modelId: string;
}

/** One QC agent / aggregator config row — mirrors AgentSlotRow from
 *  src/app/agentic-qc/page.tsx (provider + model + refresh, greyed out when
 *  disabled), simplified to a plain <select> instead of that page's
 *  searchable vendor-grouped combobox. */
function AgentSlotRow({
    slot,
    required,
    providerModels,
    loadingModels,
    onChange,
    onRefresh,
}: {
    slot: AgentSlot;
    required: boolean;
    providerModels: Record<string, ModelOption[]>;
    loadingModels: boolean;
    onChange: (next: AgentSlot) => void;
    onRefresh: (provider: AIModelProvider) => void;
}) {
    const models = providerModels[slot.provider] || AI_PROVIDER_MODELS[slot.provider] || [];
    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 1fr auto",
                gap: 8,
                alignItems: "center",
                padding: "8px 10px",
                borderRadius: 9,
                border: "1px solid var(--border-primary)",
                background: slot.enabled ? "var(--bg-tertiary)" : "transparent",
                opacity: slot.enabled ? 1 : 0.6,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {!required && (
                    <input type="checkbox" checked={slot.enabled} onChange={(e) => onChange({ ...slot, enabled: e.target.checked })} />
                )}
                <strong style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>{slot.label}</strong>
                {required && <span style={{ fontSize: "0.62rem", color: "var(--accent-danger)", fontWeight: 700 }}>required</span>}
            </div>
            <select
                value={slot.provider}
                disabled={!slot.enabled}
                onChange={(e) => {
                    const p = e.target.value as AIModelProvider;
                    const list = providerModels[p] || AI_PROVIDER_MODELS[p] || [];
                    onChange({ ...slot, provider: p, modelId: list[0]?.id || "" });
                }}
                style={{ ...input, padding: "6px 8px" }}
            >
                {(Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[]).map((p) => (
                    <option key={p} value={p}>
                        {AI_PROVIDER_LABELS[p]}
                    </option>
                ))}
            </select>
            <select value={slot.modelId} disabled={!slot.enabled} onChange={(e) => onChange({ ...slot, modelId: e.target.value })} style={{ ...input, padding: "6px 8px" }}>
                {models.length === 0 && <option value="">No models</option>}
                {models.map((m) => (
                    <option key={m.id} value={m.id}>
                        {m.label || m.id}
                    </option>
                ))}
            </select>
            <button
                type="button"
                onClick={() => onRefresh(slot.provider)}
                disabled={!slot.enabled || loadingModels}
                title="Refresh models from the provider"
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: 8,
                    background: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    padding: "0 8px",
                    height: 30,
                    cursor: !slot.enabled || loadingModels ? "default" : "pointer",
                    display: "grid",
                    placeItems: "center",
                }}
            >
                <RefreshCw size={13} className={loadingModels ? "animate-spin" : ""} />
            </button>
        </div>
    );
}

interface ModifyResult {
    success?: boolean;
    error?: string;
    records?: ModifiedRecord[];
    /** The pre-reframe questions, index-aligned with `records` — what the
     *  "Compare with original" panel shows (same payload QBG Modification gets,
     *  since both call the one qbg-modification endpoint). */
    originals?: PreviewOriginal[];
    /** Interactive HTML pack (side-by-side comparison), base64 zip. */
    zipBase64?: string;
    zipName?: string;
    modifiedCsv?: string;
    originalCsv?: string;
    sourceName?: string;
    qbgResults?: ModifyQbgPushResult[];
    warnings?: string[];
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    qcResults?: QcResult[];
    qcSummary?: QcSummary;
    keyBalance?: import("@/lib/api/qbgModification").KeyBalanceReport;
    [k: string]: unknown;
}
/** Outcome of one video-solution render, as stored in the pipeline's task
 *  record so a past run can show what was produced. */
interface VideoStageSummary {
    jobId: string;
    videoCount: number;
    missingIds: string[];
    skippedUnsupported: { qbgId: string; reason: string }[];
}
interface TagResult {
    success?: boolean;
    error?: string;
    tagged?: number;
    count?: number;
    results?: { qbg_id: string | null; ok: boolean; error?: string }[];
    [k: string]: unknown;
}

// Chrome/Safari can discard a backgrounded tab (switching desktops or even
// just switching Chrome tabs) and reload it from scratch when refocused,
// wiping all in-memory React state — this survives that by round-tripping
// the stage settings through sessionStorage (the pool-config form persists
// separately, see QbgPoolConfigForm.tsx), so a forced reload restores the
// pipeline setup instead of resetting to defaults (reported 2026-07-20).
const PIPELINE_SETTINGS_KEY = "qbg-pipeline-settings";

interface PersistedPipelineSettings {
    modifyEnabled: boolean;
    tagEnabled: boolean;
    tagSubjects: string[];
    qcEnabled: boolean;
    videoEnabled: boolean;
    categoryName: string;
    reframeMode: "paraphrase" | "vary_numbers" | "full_rewrite";
    reframeDifficulty: "auto" | "harder" | "much_harder";
    noCalculator?: boolean;
    conceptual?: boolean;
    provider: AIModelProvider;
    modelId: string;
    regenDiagrams: boolean;
    redrawAllFigures: boolean;
    verifyDiagrams: boolean;
    qc?: QcConfig;
    addFigures: boolean;
    genSolutionDiagrams: boolean;
    imgProvider: "gemini" | "openai";
    imgModel: string;
    qcAgents: AgentSlot[];
    qcAggregator: AgentSlot;
}

function loadPersistedPipelineSettings(): Partial<PersistedPipelineSettings> {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.sessionStorage.getItem(PIPELINE_SETTINGS_KEY);
        return raw ? (JSON.parse(raw) as Partial<PersistedPipelineSettings>) : {};
    } catch {
        return {};
    }
}

/** Toggle card shared by the Modify/Tag/QC stage cards. */
function StageToggle({
    title,
    description,
    enabled,
    onToggle,
    disabled,
    disabledReason,
    children,
}: {
    title: string;
    description: string;
    enabled: boolean;
    onToggle: (v: boolean) => void;
    disabled?: boolean;
    disabledReason?: string;
    children?: React.ReactNode;
}) {
    return (
        <div
            style={{
                ...card,
                opacity: disabled ? 0.5 : 1,
                border: enabled && !disabled ? "1px solid var(--accent-primary)" : "1px solid var(--border-primary)",
            }}
        >
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: disabled ? "default" : "pointer" }}>
                <input
                    type="checkbox"
                    checked={enabled}
                    disabled={disabled}
                    onChange={(e) => onToggle(e.target.checked)}
                    style={{ marginTop: 3 }}
                />
                <span style={{ display: "grid", gap: 2 }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
                    <span style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                        {disabled && disabledReason ? disabledReason : description}
                    </span>
                </span>
            </label>
            {enabled && !disabled && children && <div style={{ marginTop: 12 }}>{children}</div>}
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


/**
 * Read a JSON response, or explain what actually came back.
 *
 * A stage that outruns the reverse proxy's timeout gets an HTML error page, and
 * a bare `res.json()` then fails with "Unexpected token '<', \"<!DOCTYPE \"..."
 * — which says nothing about the stage, the status, or the cause. This reports
 * the status and names the likely reason instead.
 */
async function readJson<T>(res: Response, stage: string): Promise<T> {
    const body = await res.text();
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(body);
    if (looksHtml) {
        const timedOut = res.status === 504 || res.status === 524 || res.status === 502;
        throw new Error(
            `${stage} did not return data (HTTP ${res.status}). ` +
                (timedOut || res.status === 200
                    ? "The request ran longer than the server or proxy allows — try a smaller batch."
                    : "The server returned an error page instead of JSON.")
        );
    }
    try {
        return JSON.parse(body) as T;
    } catch {
        const snippet = body.trim().slice(0, 120);
        throw new Error(`${stage} returned an unreadable response (HTTP ${res.status}): ${snippet}`);
    }
}

export default function QbgPipelinePanel() {
    const formRef = useRef<PoolConfigHandle>(null);

    // Read once per mount (not per-field) — see loadPersistedPipelineSettings.
    const persistedSettingsRef = useRef<Partial<PersistedPipelineSettings> | null>(null);
    if (persistedSettingsRef.current === null) {
        persistedSettingsRef.current = loadPersistedPipelineSettings();
    }
    const persistedSettings = persistedSettingsRef.current;

    const [running, setRunning] = useState(false);
    const [stageLabel, setStageLabel] = useState<string | null>(null);
    const [errors, setErrors] = useState<string[]>([]);

    const [poolResult, setPoolResult] = useState<PoolSelectionResult | null>(null);
    const [modifyResult, setModifyResult] = useState<ModifyResult | null>(null);
    const [tagResult, setTagResult] = useState<TagResult | null>(null);
    const [workingIds, setWorkingIds] = useState<string[] | null>(null);

    const [modifyProgress, setModifyProgress] = useState<ProgressEvent[]>([]);
    const [tagProgress, setTagProgress] = useState<ProgressEvent[]>([]);

    // ---- "Generate video solutions" — reuses the QBG-id video path, fed
    // this pipeline's own finalIds (live run's workingIds, or a past run's
    // saved finalIds). A small dedicated poll loop rather than
    // qbgJobPoll.ts's pollQbgJob: the video status endpoint returns a plain
    // `log` string, not the `progress: ProgressEvent[]` shape that helper
    // expects, and it's not worth reshaping that endpoint for one caller. ----
    const [videoJobId, setVideoJobId] = useState<string | null>(null);
    const [videoJobState, setVideoJobState] = useState<"idle" | "running" | "done" | "error">("idle");
    const [videoLog, setVideoLog] = useState("");
    const [videoCount, setVideoCount] = useState(0);
    const [videoError, setVideoError] = useState<string | null>(null);
    const [videoMissingIds, setVideoMissingIds] = useState<string[]>([]);
    const [videoSkipped, setVideoSkipped] = useState<{ qbgId: string; reason: string }[]>([]);
    const videoPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Subject names the bundled taxonomy actually knows, for the Tag stage picker.
    useEffect(() => {
        void (async () => {
            try {
                const res = await fetch("/api/ai-tools/qbg-tagging?taxonomy=1", { cache: "no-store" });
                const data = await res.json();
                if (data?.success && Array.isArray(data.allSubjects)) setTaxonomySubjects(data.allSubjects);
            } catch {
                /* the picker just stays hidden; tagging still defaults to the pool's subjects */
            }
        })();
    }, []);

    // ---- history ----
    const [reports, setReports] = useState<HistoryReport[]>([]);
    const [loadingReports, setLoadingReports] = useState(false);
    const [viewedReport, setViewedReport] = useState<HistoryReport | null>(null);
    const loadReports = useCallback(async () => {
        setLoadingReports(true);
        try {
            const res = await fetch("/api/ai-tools/qbg-tasks?type=qbg_pipeline", { cache: "no-store" });
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
                        report_data: { ...(t.data as object), status: t.status as "running" | "done" | "failed", error: t.error ?? undefined },
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
    const deleteReport = async (id: string) => {
        try {
            await fetch(`/api/ai-tools/qbg-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        } catch {
            /* ignore */
        }
        void loadReports();
    };

    const [qcJob, setQcJob] = useState<JobRecord | null>(null);
    const [qcStatusLabel, setQcStatusLabel] = useState<string | null>(null);
    const [finalDocItems, setFinalDocItems] = useState<PoolDocItem[] | null>(null);
    const [finalDocMeta, setFinalDocMeta] = useState<{ batchName: string; examPreset: ExamPreset } | null>(null);
    const [downloading, setDownloading] = useState<"docx" | "pdf" | null>(null);
    const [downloadingQcPdf, setDownloadingQcPdf] = useState(false);
    const [idsCopied, setIdsCopied] = useState(false);
    const [viewedIdsCopied, setViewedIdsCopied] = useState(false);
    const [modifiedIdsCopied, setModifiedIdsCopied] = useState(false);
    const [viewedQcDownloading, setViewedQcDownloading] = useState(false);

    // ---- stage toggles ----
    const [modifyEnabled, setModifyEnabled] = useState(persistedSettings.modifyEnabled ?? false);
    const [tagEnabled, setTagEnabled] = useState(persistedSettings.tagEnabled ?? false);
    // Subjects the tagger may file these questions under. Empty = "whatever the
    // pool was drawn from", which is what you almost always want here: a chapter
    // like Thermodynamics exists under BOTH Physics and Chemistry, so without a
    // subject the model can file a Physics question under Chemistry.
    const [tagSubjects, setTagSubjects] = useState<string[]>(persistedSettings.tagSubjects ?? []);
    const [taxonomySubjects, setTaxonomySubjects] = useState<string[]>([]);
    /** Tagged questions that landed outside the test's selected chapters. */
    const [outOfSyllabus, setOutOfSyllabus] = useState<OutOfSyllabusItem[]>([]);
    const [laterChapterUse, setLaterChapterUse] = useState<LaterChapterUseItem[]>([]);
    const [keyIssues, setKeyIssues] = useState<AnswerKeyIssue[]>([]);
    const [qcEnabled, setQcEnabled] = useState(persistedSettings.qcEnabled ?? false);
    const [videoEnabled, setVideoEnabled] = useState(persistedSettings.videoEnabled ?? false);
    const [categoryName, setCategoryName] = useState<string>(persistedSettings.categoryName ?? "JEE");
    const [reframeMode, setReframeMode] = useState<"paraphrase" | "vary_numbers" | "full_rewrite">(
        persistedSettings.reframeMode ?? "full_rewrite"
    );
    const [reframeDifficulty, setReframeDifficulty] = useState<"auto" | "harder" | "much_harder">(
        persistedSettings.reframeDifficulty ?? "auto"
    );
    // On by default: students sit these papers without a calculator.
    const [noCalculator, setNoCalculator] = useState<boolean>(persistedSettings.noCalculator ?? true);
    const [conceptual, setConceptual] = useState<boolean>(persistedSettings.conceptual ?? false);

    // ---- shared AI provider/model (Modify + Tag) ----
    const [provider, setProvider] = useState<AIModelProvider>(persistedSettings.provider ?? DEFAULT_AI_PROVIDER);
    const [modelId, setModelId] = useState<string>(persistedSettings.modelId ?? DEFAULT_AI_MODEL);
    const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({ ...AI_PROVIDER_MODELS });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);
    const providerRef = useRef(provider);
    useEffect(() => {
        providerRef.current = provider;
    }, [provider]);
    const modelReqRef = useRef(0);
    const currentModels = providerModels[provider] || AI_PROVIDER_MODELS[provider] || [];

    // ---- Modify: optional AI diagram redraw / solution diagrams ----
    const [regenDiagrams, setRegenDiagrams] = useState(persistedSettings.regenDiagrams ?? false);
    const [redrawAllFigures, setRedrawAllFigures] = useState(persistedSettings.redrawAllFigures ?? false);
    // On by default: it is the only thing that catches an image model drawing
    // the wrong digits, and a diagram contradicting its question is a wrong question.
    const [verifyDiagrams, setVerifyDiagrams] = useState(persistedSettings.verifyDiagrams ?? true);
    // QC runs after the diagrams are drawn and before the push; its model is
    // chosen separately because it has to be able to READ the figure.
    const [qc, setQc] = useState<QcConfig>(
        persistedSettings.qc ?? { enabled: false, provider: DEFAULT_AI_PROVIDER, modelId: DEFAULT_AI_MODEL }
    );
    const [addFigures, setAddFigures] = useState(persistedSettings.addFigures ?? false);
    const [genSolutionDiagrams, setGenSolutionDiagrams] = useState(persistedSettings.genSolutionDiagrams ?? false);
    const [imgProvider, setImgProvider] = useState<"gemini" | "openai">(persistedSettings.imgProvider ?? DEFAULT_IMG_PROVIDER);
    const [imgModel, setImgModel] = useState<string>(persistedSettings.imgModel ?? IMG_DEFAULT_MODEL[DEFAULT_IMG_PROVIDER]);
    const [providerImgModels, setProviderImgModels] = useState<Record<string, { id: string; label: string }[]>>({
        ...IMG_FALLBACK_MODELS,
    });
    const [loadingImgModels, setLoadingImgModels] = useState(false);
    const [imgModelLoadError, setImgModelLoadError] = useState<string | null>(null);
    const imgProviderRef = useRef(imgProvider);
    useEffect(() => {
        imgProviderRef.current = imgProvider;
    }, [imgProvider]);
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
        if (regenDiagrams || addFigures || genSolutionDiagrams) void loadImgModels(imgProvider);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [regenDiagrams, addFigures, genSolutionDiagrams, imgProvider]);

    // ---- QC agent config (QC1 required, QC2/QC3 optional, + Aggregator) —
    // mirrors src/app/agentic-qc/page.tsx's own "Configure parallel QC agents"
    // section. Shares the providerModels cache above (keyed by provider, so
    // any slot picking a provider already refreshed elsewhere benefits too).
    const [qcAgents, setQcAgents] = useState<AgentSlot[]>(
        persistedSettings.qcAgents ?? [
            { label: "QC1", enabled: true, provider: "gemini", modelId: AI_PROVIDER_MODELS.gemini[0]?.id || "" },
            { label: "QC2", enabled: false, provider: "openai", modelId: AI_PROVIDER_MODELS.openai[0]?.id || "" },
            { label: "QC3", enabled: false, provider: "anthropic", modelId: AI_PROVIDER_MODELS.anthropic[0]?.id || "" },
        ]
    );
    const [qcAggregator, setQcAggregator] = useState<AgentSlot>(
        persistedSettings.qcAggregator ?? {
            label: "Aggregator",
            enabled: true,
            provider: "openai",
            modelId: AI_PROVIDER_MODELS.openai[0]?.id || "",
        }
    );

    // Write settings back to sessionStorage whenever any of them change, so a
    // browser-forced reload (see loadPersistedPipelineSettings above) restores
    // this setup instead of resetting to defaults.
    useEffect(() => {
        try {
            window.sessionStorage.setItem(
                PIPELINE_SETTINGS_KEY,
                JSON.stringify({
                    modifyEnabled, tagEnabled, tagSubjects, qcEnabled, videoEnabled, categoryName, reframeMode,
                    reframeDifficulty, noCalculator, conceptual, provider, modelId, regenDiagrams, redrawAllFigures,
                    verifyDiagrams, qc, addFigures, genSolutionDiagrams, imgProvider, imgModel, qcAgents, qcAggregator,
                } satisfies PersistedPipelineSettings)
            );
        } catch {
            /* sessionStorage unavailable (private mode / quota) — persistence is best-effort */
        }
    }, [modifyEnabled, tagEnabled, tagSubjects, qcEnabled, videoEnabled, categoryName, reframeMode, reframeDifficulty,
        noCalculator, conceptual, provider, modelId, regenDiagrams, redrawAllFigures, verifyDiagrams, qc, addFigures, genSolutionDiagrams, imgProvider,
        imgModel, qcAgents, qcAggregator]);

    // Video narration is written by the same AI provider/model as Modify/Tag
    // (posted as ai_provider / ai_model_id), so it needs the picker too.
    const needsAiPicker = modifyEnabled || tagEnabled || videoEnabled;

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
        if (needsAiPicker) void loadModels(provider);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsAiPicker]);

    function toPreparsedQuestions(qs: ParsedQuestion[]): PreparsedQuestion[] {
        return qs.map((q) => ({
            questionNumber: q.questionNumber,
            sourceId: q.sourceId,
            questionText: q.questionText,
            questionHtml: q.questionHtml,
            options: q.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
            correctAnswer: q.correctAnswer,
            questionType: q.questionType,
            solutionText: q.solutionText,
            solutionHtml: q.solutionHtml,
            subject: q.subject,
            chapter: q.chapter,
            topic: q.topic,
            klass: q.klass,
            difficulty: q.difficulty,
            hasVideoSolution: q.hasVideoSolution,
            imageUrls: q.imageUrls,
        }));
    }

    /** Starts a structured-mode Agentic QC job and drives it to completion via
     *  its SSE stream (mirrors src/app/agentic-qc/page.tsx's EventSource
     *  consumption, trimmed to the terminal-state cases this summary view
     *  needs). Requires a real logged-in session — Agentic QC has no dev-auth
     *  bypass, unlike the rest of this panel's stages. */
    async function runQcStage(
        parsedQuestions: PreparsedQuestion[],
        jobLabel: string,
        qcAgentConfigs: { label: string; provider: string; modelId: string }[],
        aggregatorConfig: { label: string; provider: string; modelId: string }
    ): Promise<JobRecord> {
        const startRes = await fetch("/api/agentic-qc/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                label: jobLabel,
                inputMode: "structured",
                parsedQuestions,
                qcAgents: qcAgentConfigs,
                aggregator: aggregatorConfig,
            }),
        });
        const start = (await startRes.json()) as { success?: boolean; jobId?: string; error?: string };
        if (!startRes.ok || !start.success || !start.jobId) {
            throw new Error(start.error || `Could not start QC (${startRes.status}). Agentic QC requires a real logged-in session.`);
        }
        const jobId = start.jobId;

        return new Promise<JobRecord>((resolve, reject) => {
            const es = new EventSource(`/api/agentic-qc/jobs/${jobId}/stream`);
            const finish = (fn: () => void) => {
                es.close();
                fn();
            };
            es.onmessage = (msg) => {
                let ev: Record<string, unknown>;
                try {
                    ev = JSON.parse(msg.data);
                } catch {
                    return;
                }
                const t = ev.type as string;
                if (t === "snapshot") {
                    const job = ev.job as JobRecord;
                    if (job.status === "done") {
                        finish(() => resolve(job));
                    } else if (job.status === "failed" || job.status === "cancelled") {
                        finish(() => reject(new Error(job.fatalError || `QC ${job.status}.`)));
                    } else {
                        setQcJob(job);
                    }
                    return;
                }
                if (t === "agent_completed" || t === "aggregator_completed") {
                    setQcStatusLabel(ev.questionNumber ? `QC · Q${ev.questionNumber} done` : "QC running…");
                } else if (t === "complete") {
                    setTimeout(() => {
                        fetch(`/api/agentic-qc/jobs/${jobId}`)
                            .then((r) => r.json())
                            .then((body: { job?: JobRecord }) => {
                                if (body.job) finish(() => resolve(body.job as JobRecord));
                                else finish(() => reject(new Error("QC completed but the report could not be read back.")));
                            })
                            .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
                    }, 1200);
                } else if (t === "fatal_error") {
                    finish(() => reject(new Error(String(ev.error || "QC failed."))));
                } else if (t === "cancelled") {
                    finish(() => reject(new Error("QC was cancelled.")));
                }
            };
            es.onerror = () => {
                // EventSource auto-reconnects on transient drops; only treat this
                // as fatal if the connection never recovers within a safety window.
            };
        });
    }

    async function taskCreate(id: string, taskLabel: string) {
        try {
            await fetch("/api/ai-tools/qbg-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, taskType: "qbg_pipeline", label: taskLabel, provider, modelId }),
            });
        } catch {
            /* best-effort — history must never block the run */
        }
    }
    async function taskPatch(id: string, patch: { data?: Record<string, unknown>; status?: "done" | "failed"; error?: string }) {
        try {
            await fetch("/api/ai-tools/qbg-tasks", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, ...patch }),
            });
        } catch {
            /* best-effort */
        }
    }

    /**
     * The run's LAST patch — the one that moves the row out of "running".
     *
     * The mid-run taskPatch calls are fire-and-forget on purpose: losing one
     * costs a stage's detail and nothing more. Losing THIS one strands the row
     * as "running" forever. A pipeline's stages run client-side, so unlike
     * qbg-modification there is no server job to call completeTask/failTask as
     * a backstop, and qbgTaskStore only auto-repairs a stuck row after three
     * hours. It used to be `void taskPatch(...)`, which lost the write whenever
     * the tab was closed or reloaded in the seconds after a failure — likely,
     * because setErrors() paints the error synchronously while the request is
     * still in flight, so the run *looks* finished well before it is.
     *
     * `keepalive` is what makes the browser deliver a request that outlives the
     * page. sendBeacon is the usual tool for this, but it can only issue POST
     * and this route's POST is createTask — a beacon would try to re-INSERT the
     * existing row instead of patching it. Browsers cap a keepalive body at 64KB
     * and reject the fetch outright above that, so it is opt-in by size: the
     * "failed" payload is a few hundred bytes and always qualifies, while the
     * "done" payload carries the whole run (records, originals, the QC job) and
     * falls back to a plain awaited fetch. That asymmetry is fine — "done" is
     * only reached on the happy path, where nothing is prompting the user to
     * navigate away, and a lost "done" still leaves the last mid-run patch.
     *
     * Callers must await this so the surrounding `finally` cannot tear the run
     * down while the request is still outstanding.
     */
    async function taskPatchFinal(
        id: string,
        patch: { data?: Record<string, unknown>; status: "done" | "failed"; error?: string }
    ) {
        const body = JSON.stringify({ id, ...patch });
        // A little under the 64KB keepalive cap, leaving room for headers.
        const KEEPALIVE_LIMIT = 60 * 1024;
        try {
            await fetch("/api/ai-tools/qbg-tasks", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body,
                keepalive: body.length <= KEEPALIVE_LIMIT,
            });
        } catch {
            /* best-effort, same contract as taskPatch */
        }
    }

    function devHeaders(includeQbg: boolean, includeImg = false): Record<string, string> {
        const headers: Record<string, string> = {};
        if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
            const devKeys = readDevApiKeysFromStorage();
            if (includeQbg) headers["x-dev-qbg"] = devKeys.qbg || "";
            const cred = getProviderApiCredential(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
            if (cred) headers["x-dev-api-key"] = cred;
            const baseUrl = getProviderBaseUrl(provider as SupportedApiProvider, devKeys[provider as SupportedApiProvider] || "");
            if (baseUrl) headers["x-dev-base-url"] = baseUrl;
            if (includeImg && (regenDiagrams || addFigures || genSolutionDiagrams)) {
                headers["x-dev-img-key"] = getProviderApiCredential(
                    imgProvider as SupportedApiProvider,
                    devKeys[imgProvider as SupportedApiProvider] || ""
                );
            }
            if (qc.enabled && qc.provider !== provider) {
                headers["x-dev-qc-key"] = getProviderApiCredential(
                    qc.provider as SupportedApiProvider,
                    devKeys[qc.provider as SupportedApiProvider] || ""
                );
            }
        }
        return headers;
    }

    /** Poll a video job to completion. Resolves with the finished summary, or
     *  rejects when the render fails — so it can be awaited as a pipeline
     *  stage. UI state is updated on every tick either way, which is what the
     *  fire-and-forget manual button relies on. */
    function pollVideoJob(id: string): Promise<VideoStageSummary> {
        if (videoPollRef.current) clearTimeout(videoPollRef.current);
        return new Promise<VideoStageSummary>((resolve, reject) => {
            const tick = async () => {
                try {
                    const res = await fetch(`/api/ai-tools/video-solution/videos/${id}/status`, {
                        headers: devHeaders(false),
                    });
                    const data = (await res.json()) as {
                        success?: boolean;
                        state?: "queued" | "running" | "done" | "error";
                        log?: string;
                        videoCount?: number;
                        error?: string;
                        missingIds?: string[];
                        skippedUnsupported?: { qbgId: string; reason: string }[];
                    };
                    if (!res.ok || !data.success) throw new Error("status poll failed");
                    setVideoLog(data.log || "");
                    setVideoCount(data.videoCount || 0);
                    setVideoMissingIds(data.missingIds || []);
                    setVideoSkipped(data.skippedUnsupported || []);
                    if (data.state === "done") {
                        setVideoJobState("done");
                        resolve({
                            jobId: id,
                            videoCount: data.videoCount || 0,
                            missingIds: data.missingIds || [],
                            skippedUnsupported: data.skippedUnsupported || [],
                        });
                        return;
                    }
                    if (data.state === "error") {
                        const message = data.error || "Video generation failed.";
                        setVideoJobState("error");
                        setVideoError(message);
                        reject(new Error(message));
                        return;
                    }
                    videoPollRef.current = setTimeout(tick, 3000);
                } catch {
                    // transient poll blip — the Python render keeps going; retry
                    videoPollRef.current = setTimeout(tick, 3000);
                }
            };
            void tick();
        });
    }

    /** Kick off a video-solution render for `ids` and resolve once it finishes.
     *  Shared by the automatic pipeline stage and the manual button. */
    async function runVideoStage(ids: string[]): Promise<VideoStageSummary> {
        setVideoJobId(null);
        setVideoJobState("running");
        setVideoLog("");
        setVideoCount(0);
        setVideoError(null);
        setVideoMissingIds([]);
        setVideoSkipped([]);
        const res = await fetch("/api/ai-tools/video-solution/videos", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...devHeaders(true) },
            body: JSON.stringify({
                qbg_ids: ids.join("\n"),
                ai_provider: provider,
                ai_model_id: modelId,
            }),
        });
        const body = await res.json();
        if (!res.ok || !body.success) {
            throw new Error(body.error || `Status ${res.status}`);
        }
        const newJobId = body.jobId as string;
        setVideoJobId(newJobId);
        return pollVideoJob(newJobId);
    }

    /** Manual "Generate video solutions" button — fire-and-forget; errors land
     *  in the panel's own video state rather than the pipeline error list. */
    async function handleGenerateVideos(ids: string[]) {
        try {
            await runVideoStage(ids);
        } catch (err) {
            setVideoJobState("error");
            setVideoError(err instanceof Error ? err.message : String(err));
        }
    }

    useEffect(() => {
        return () => {
            if (videoPollRef.current) clearTimeout(videoPollRef.current);
        };
    }, []);

    async function handleRunPipeline() {
        setErrors([]);
        setPoolResult(null);
        setModifyResult(null);
        setOutOfSyllabus([]);
        setKeyIssues([]);
        setTagResult(null);
        setOutOfSyllabus([]);
        setLaterChapterUse([]);
        setWorkingIds(null);
        setModifyProgress([]);
        setTagProgress([]);
        setQcJob(null);
        setQcStatusLabel(null);
        setFinalDocItems(null);

        const built = formRef.current?.buildConfig();
        if (!built) return;
        if (built.errors.length || !built.config) {
            setErrors(built.errors.length ? built.errors : ["Could not build a config."]);
            return;
        }
        if ((modifyEnabled || videoEnabled) && !modelId.trim()) {
            setErrors([
                modifyEnabled
                    ? "Please choose an AI model for Modify/Tag."
                    : "Please choose an AI model — video narration is written by it.",
            ]);
            return;
        }
        if (qcEnabled) {
            const enabledQcAgents = qcAgents.filter((a) => a.enabled);
            if (enabledQcAgents.length === 0) {
                setErrors(["Enable at least one QC agent (QC1 is required)."]);
                return;
            }
            for (const a of enabledQcAgents) {
                if (!a.modelId) {
                    setErrors([`Pick a model for ${a.label}.`]);
                    return;
                }
            }
            if (!qcAggregator.modelId) {
                setErrors(["Pick a model for the Aggregator."]);
                return;
            }
        }
        if (modifyEnabled && !QBG_CATEGORIES[categoryName]) {
            setErrors(["Choose a QBG category to push modified questions to."]);
            return;
        }

        setRunning(true);
        const taskId = crypto.randomUUID();
        // Before any AI call: an expired QBG token otherwise surfaces only at the
        // push, after every AI call in the run has already been paid for.
        if (modifyEnabled || tagEnabled || qcEnabled || videoEnabled) {
            const gate = await checkQbgTokenBeforeRun();
            if (!gate.proceed) {
                setErrors([gate.error || "QBG token check failed."]);
                setRunning(false);
                return;
            }
        }
        const taskData: Record<string, unknown> = {};
        const batchLabel = built.config.batchNames?.length ? built.config.batchNames.join(", ") : "no batch";
        void taskCreate(taskId, `Pipeline · ${batchLabel}`);
        try {
            // ---- Stage 1: pool selection ----
            setStageLabel("Selecting pool…");
            const poolRes = await fetch("/api/qbg/pipeline/select-pool", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // A type the pool is short of can be filled from other types as
                // seeds, but only when Modify runs: Modify is what rewrites a seed
                // into the wanted type. Without it a seed would ship as the wrong
                // type, so the paper comes back short instead, as before.
                body: JSON.stringify({ ...built.config, allowTypeSeeds: modifyEnabled }),
            });
            const poolData = await readJson<PoolSelectionResult & { success?: boolean; error?: string }>(
                poolRes,
                "Pool selection"
            );
            if (!poolRes.ok || !poolData.success) throw new Error(poolData.error || `Pool selection failed (${poolRes.status}).`);
            setPoolResult(poolData);
            let ids = poolData.uniqueIds;
            setWorkingIds(ids);
            taskData.pool = {
                requested: poolData.poolMeta.requested,
                selected: poolData.poolMeta.selected,
                warnings: poolData.warnings,
                ...(poolData.typeConversions?.length ? { typeConversions: poolData.typeConversions } : {}),
            };
            // Saved after every stage that changes `ids`, not just at the very
            // end — a run that gets interrupted mid-pipeline (browser reload,
            // network blip) still leaves whatever ids were valid as of the
            // last-completed stage recoverable from "Previous pipeline runs",
            // instead of losing everything because the run never reached its
            // final "done" patch.
            taskData.finalIds = ids;
            void taskPatch(taskId, { data: taskData });

            if (ids.length === 0) {
                throw new Error("No questions were selected — adjust the filters and try again.");
            }

            // Captured locally (not read back from state) — React state updates
            // aren't synchronously visible within the same async function.
            let modifyData: ModifyResult | null = null;

            // ---- Stage 2: Modify (optional) ----
            if (modifyEnabled) {
                setStageLabel("Reframing + pushing to QBG…");
                const data = await pollQbgJob<ModifyResult>({
                    startUrl: "/api/ai-tools/qbg-modification",
                    startBody: {
                        source: "qbg",
                        qbgIds: ids.join("\n"),
                        provider,
                        modelId: modelId.trim(),
                        pushToQbg: true,
                        category: QBG_CATEGORIES[categoryName],
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
                        mode: reframeMode,
                        difficulty: reframeDifficulty,
                        noCalculator,
                        conceptual,
                        // Seeds picked for a type the pool was short of: rewrite each
                        // as the type the paper asked for.
                        targetTypes: Object.fromEntries(
                            (poolData.typeConversions || []).map((c) => [c.uniqueId, c.reframeType])
                        ),
                        // Keep the reframe inside the syllabus this test was pooled
                        // from: the chosen chapters are what a question must BE about,
                        // and everything earlier in the book is fair game as a
                        // prerequisite. Without this the model can reach forward into
                        // chapters the student hasn't been taught.
                        syllabus: built.config.fullSyllabus
                            ? undefined
                            : Object.entries(built.config.selectedChapters || {})
                                  .filter(([, ch]) => (ch || []).length > 0)
                                  .map(([subject, chapters]) => ({
                                      subject,
                                      chapters,
                                      permitted: permittedChaptersForSubject(subject, chapters),
                                  })),
                    },
                    startHeaders: devHeaders(true, true),
                    buildPollUrl: (jobId) => `/api/ai-tools/qbg-modification?jobId=${encodeURIComponent(jobId)}`,
                    // Deliberately not registered with the cross-navigation
                    // tracker — see qbgJobPoll.ts's file-level comment. The
                    // pipeline needs this call to reliably return the new
                    // qbg_ids so it can chain into Tag/QC.
                    kind: "qbg_pipeline_modify",
                    label: `Pipeline modify · ${ids.length} ID(s)`,
                    onProgress: setModifyProgress,
                    // A reframe runs the model once per 5-question chunk and each
                    // chunk writes full step-by-step solutions, so wall time scales
                    // with the paper: 35 questions measured 21m51s against the old
                    // fixed 20-minute cap.
                    timeoutMs: jobTimeoutMs(ids.length, 90),
                    onNote: setStageLabel,
                });
                modifyData = data;
                setModifyResult(data);
                const newIds = (data.qbgResults || []).filter((r) => r.ok && r.unique_id).map((r) => r.unique_id as string);
                ids = newIds;
                setWorkingIds(ids);
                taskData.modify = { pushed: newIds.length, attempted: (data.qbgResults || []).length };
                // Reframed questions + the originals they came from, so reopening
                // this run from history shows the same comparison the live view
                // does. Both keys are stripped from history *listings* by
                // qbgTaskStore's HEAVY_DATA_KEYS and fetched only when opened —
                // the zip is deliberately not persisted (too big for jsonb).
                taskData.records = data.records || [];
                taskData.originals = data.originals || [];
                taskData.finalIds = ids;
                void taskPatch(taskId, { data: taskData });
                if (ids.length === 0) {
                    throw new Error("Modify finished but produced no successfully pushed questions — stopping before Tag.");
                }
            }

            // ---- Stage 3: Tag (optional, requires Modify) ----
            if (modifyEnabled && tagEnabled) {
                setStageLabel("Tagging modified questions…");
                const data = await pollQbgJob<TagResult>({
                    startUrl: "/api/ai-tools/qbg-tagging",
                    startBody: {
                        mode: "ai",
                        qbgIds: ids.join("\n"),
                        provider,
                        modelId: modelId.trim(),
                        // An explicit choice wins; otherwise fall back to the subjects
                        // this pipeline actually pooled from. Without a subject a shared
                        // chapter name (Thermodynamics lives under Physics AND Chemistry)
                        // lets the model file the question under the wrong one.
                        subjects: tagSubjects.length > 0
                            ? tagSubjects
                            : built.config.selectedSubjects || [],
                    },
                    startHeaders: devHeaders(true),
                    buildPollUrl: (jobId) => `/api/ai-tools/qbg-tagging?jobId=${encodeURIComponent(jobId)}`,
                    kind: "qbg_pipeline_tag",
                    label: `Pipeline tag · ${ids.length} ID(s)`,
                    onProgress: setTagProgress,
                    // Three model calls per question, plus a queue that may hold
                    // this job behind another user's.
                    timeoutMs: jobTimeoutMs(ids.length, 45),
                    onNote: setStageLabel,
                });
                setTagResult(data);
                taskData.tag = { tagged: data.tagged, count: data.count };

                // The tags are the first hard evidence of what each reframed
                // question is actually ABOUT. Anything filed outside the chapters
                // this test selected has drifted off-syllabus — surface it with
                // its ids rather than letting it ship unnoticed.
                const scope = {
                    chaptersBySubject: built.config.selectedChapters || {},
                    fullSyllabus: !!built.config.fullSyllabus,
                };
                const strays = findOutOfSyllabus(scope, data.results || []);
                setOutOfSyllabus(strays);
                if (strays.length > 0) {
                    taskData.outOfSyllabus = groupOutOfSyllabus(strays);
                }
                // The filed chapter can be right while the SOLUTION reaches into a
                // later chapter (a Laws of Motion question solved with the
                // work-energy theorem). Judged on the chapters the tagger says each
                // question relies on, against the selected chapters plus everything
                // earlier in the book.
                const reachesAhead = findLaterChapterUse(data.results || [], (subject) =>
                    scope.fullSyllabus ? null : scope.chaptersBySubject[subject] || null
                );
                setLaterChapterUse(reachesAhead);
                if (reachesAhead.length > 0) taskData.laterChapterUse = reachesAhead;
                void taskPatch(taskId, { data: taskData });
            }

            // Final working set, adapted once and shared by QC + the document
            // download buttons — the modified set if Modify ran, the raw pool
            // rows otherwise (see qbgPoolAdapter.ts).
            let docItems: PoolDocItem[];
            if (modifyEnabled) {
                const poolRowsById: Record<string, PoolQuestion> = {};
                for (const row of poolData.rows) poolRowsById[row.unique_id] = row;
                const { questions, originalRows, warnings } = adaptModifiedRecordsToParsedQuestions({
                    records: modifyData?.records || [],
                    qbgResults: modifyData?.qbgResults || [],
                    originalIds: poolData.uniqueIds,
                    poolRowsById,
                });
                if (warnings.length) setErrors((prev) => [...prev, ...warnings]);
                docItems = questions.map((question, i) => ({ question, originalRow: originalRows[i] }));
            } else {
                const { questions, originalRows, warnings } = adaptPoolRowsToParsedQuestions(poolData.rows);
                if (warnings.length) setErrors((prev) => [...prev, ...warnings]);
                docItems = questions.map((question, i) => ({ question, originalRow: originalRows[i] }));
            }
            // ---- Answer-key balance ----
            // Reframing changes which option is correct, so the key is only
            // knowable now. Questions of the same subject and type swap places
            // to break any run longer than three of the same option (preferring
            // a swap that also keeps two questions from one chapter apart);
            // whatever survives is reported rather than hidden. Numerical
            // questions have no option letter and are carried along untouched.
            docItems = rebalanceAnswerKey(
                docItems,
                (item) => ({
                    answer: answerLetter(item.question.options || []),
                    chapter: item.question.chapter || item.originalRow?.chapter || "",
                    group: `${item.question.subject || item.originalRow?.subject || ""}||${item.question.questionType}`,
                }),
                { maxRun: 3 }
            ).map((item, i) => ({ ...item, question: { ...item.question, questionNumber: i + 1 } }));

            const issues = checkAnswerKeyBalance(
                docItems.map((item, i) => ({
                    questionNumber: i + 1,
                    answer: answerLetter(item.question.options || []),
                }))
            );
            setKeyIssues(issues);
            if (issues.length) taskData.answerKey = issues;

            setFinalDocItems(docItems);
            setFinalDocMeta({ batchName: batchLabel, examPreset: built.config.examPreset });

            // ---- Stage 4: Agentic QC (optional, independent of Modify/Tag) ----
            if (qcEnabled) {
                setStageLabel("Running Agentic QC…");
                setQcStatusLabel("Starting QC…");
                if (docItems.length === 0) {
                    throw new Error("No questions available to QC after adapting the working set.");
                }
                const parsedQuestions = toPreparsedQuestions(docItems.map((it) => it.question));
                const enabledQcAgents = qcAgents
                    .filter((a) => a.enabled)
                    .map((a) => ({ label: a.label, provider: a.provider, modelId: a.modelId.trim() }));
                const job = await runQcStage(
                    parsedQuestions,
                    `Pipeline QC · ${parsedQuestions.length} question(s)`,
                    enabledQcAgents,
                    { label: qcAggregator.label, provider: qcAggregator.provider, modelId: qcAggregator.modelId.trim() }
                );
                setQcJob(job);
                // Store the FULL JobRecord (not just a summary) so "Previous
                // pipeline runs" can regenerate the QC PDF report exactly like
                // the live view does — see downloadJobAsPDF(report_data.qc).
                // jsonb, no practical size concern for a single QC run.
                taskData.qc = job;
                taskData.qcSummary = {
                    status: job.status,
                    totalQuestions: job.questions.length,
                    flaggedForReview: job.questions.filter((q) => q.aggregator.needsManualReview).length,
                };
                // Patched immediately, not just bundled into the final "done"
                // patch below — so an interruption during/after QC (the
                // longest stage) doesn't lose a QC run that actually finished.
                void taskPatch(taskId, { data: taskData });
            }

            // ---- Stage 5: Video solutions (optional) ----
            // Renders a narrated video per question straight from QBG, using the
            // final working ids — so it covers the modified questions when Modify
            // ran, and the raw pool otherwise.
            if (videoEnabled) {
                setStageLabel(`Rendering video solutions (${ids.length} question(s))…`);
                // A video failure must not discard everything the pipeline has
                // already produced (pool, modify, tag and QC are all pushed and
                // patched above), so surface it as an error line but still let
                // the run finish as "done".
                try {
                    if (ids.length === 0) {
                        throw new Error("no questions in the final set to render.");
                    }
                    const summary = await runVideoStage(ids);
                    taskData.video = summary;
                    void taskPatch(taskId, { data: taskData });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    setErrors((prev) => [...prev, `Video solutions: ${message}`]);
                }
            }

            taskData.finalCount = docItems.length;
            taskData.finalIds = ids;
            await taskPatchFinal(taskId, { status: "done", data: taskData });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setErrors([message]);
            await taskPatchFinal(taskId, { status: "failed", error: message });
        } finally {
            setRunning(false);
            setStageLabel(null);
            void loadReports();
        }
    }

    async function handleDownload(format: "docx" | "pdf") {
        if (!finalDocItems || !finalDocMeta || finalDocItems.length === 0) return;
        setDownloading(format);
        try {
            const test = mapPoolItemsToGeneratedTest(finalDocItems, finalDocMeta);
            const options = {
                tests: [test],
                contentMode: "QUESTIONS_ANSWER_KEY_SOLUTION" as const,
                labelFormat: "ABCD" as const,
                deliveryMode: "PAPER_WISE" as const,
                showAnswerKeyBeforeSolution: false,
                twoColumnFormat: false,
                instructions: "",
                includeMetadata: true,
                metadataFields: ["Subject", "Chapter", "Topic", "Subtopic", "Difficulty", "Source"],
                filename: `${finalDocMeta.batchName}_pipeline_test`,
            };
            if (format === "docx") await downloadTestAsDocx(options);
            else await downloadTestAsPDF(options);
        } catch (err) {
            setErrors([err instanceof Error ? err.message : String(err)]);
        } finally {
            setDownloading(null);
        }
    }

    function renderVideoGenBlock(ids: string[]) {
        if (!ids || ids.length === 0) return null;
        const busy = videoJobState === "running";
        return (
            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 10, marginTop: 4 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        {videoJobState === "done"
                            ? `Narrated video solutions for these ${ids.length} question(s).`
                            : `Generate a narrated video solution for these ${ids.length} question(s), sourced directly from QBG.`}
                    </div>
                    <button
                        type="button"
                        onClick={() => void handleGenerateVideos(ids)}
                        disabled={busy}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            border: "1px solid var(--accent-primary)",
                            borderRadius: 8,
                            background: "var(--accent-glow)",
                            color: "var(--accent-primary-hover)",
                            padding: "6px 12px",
                            fontSize: "0.78rem",
                            fontWeight: 600,
                            cursor: busy ? "default" : "pointer",
                            opacity: busy ? 0.6 : 1,
                        }}
                    >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : null}
                        {busy ? "Generating…" : "Generate video solutions"}
                    </button>
                </div>

                {videoJobState !== "idle" && (
                    <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                            {videoJobState === "done"
                                ? `Done — ${videoCount} video(s) rendered.`
                                : videoJobState === "error"
                                    ? videoError || "Video generation failed."
                                    : "Rendering… this can take a while (about 30s per question)."}
                        </div>
                        {videoLog && videoJobState === "running" && (
                            <pre
                                style={{
                                    margin: 0,
                                    padding: "8px 10px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    color: "var(--text-secondary)",
                                    fontSize: "0.7rem",
                                    lineHeight: 1.4,
                                    maxHeight: "160px",
                                    overflow: "auto",
                                    whiteSpace: "pre-wrap",
                                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                }}
                            >
                                {videoLog}
                            </pre>
                        )}
                        {(videoMissingIds.length > 0 || videoSkipped.length > 0) && (
                            <div style={{ fontSize: "0.72rem", color: "#f59e0b" }}>
                                {videoMissingIds.length > 0 && `${videoMissingIds.length} id(s) not found in QBG. `}
                                {videoSkipped.length > 0 && `${videoSkipped.length} skipped (unsupported type).`}
                            </div>
                        )}
                        {videoJobState === "done" && videoJobId && (
                            <a
                                href={`/api/ai-tools/video-solution/videos/${videoJobId}/download`}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: 8,
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-secondary)",
                                    padding: "6px 12px",
                                    fontSize: "0.78rem",
                                    fontWeight: 600,
                                    textDecoration: "none",
                                    width: "fit-content",
                                }}
                            >
                                <Download size={13} /> Download videos (.zip)
                            </a>
                        )}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
            <p style={{ margin: "0 0 18px", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                Pick a pool of questions from the imported reference dataset (same filters as the Tests
                feature), then optionally chain QBG Modification, QBG Tagging, and an Agentic QC report — all
                in one run.
            </p>

            <div style={{ display: "grid", gap: 16 }}>
                <QbgPoolConfigForm ref={formRef} />

                <StageToggle
                    title="Modify (optional)"
                    description="Reframe the selected questions with AI and push the new versions straight to QBG (no review checkpoint)."
                    enabled={modifyEnabled}
                    onToggle={(v) => {
                        setModifyEnabled(v);
                        if (!v) setTagEnabled(false);
                    }}
                >
                    <label style={{ display: "grid", gap: 5, maxWidth: 280 }}>
                        <span style={label}>QBG category to push to</span>
                        <select value={categoryName} onChange={(e) => setCategoryName(e.target.value)} style={input}>
                            {Object.keys(QBG_CATEGORIES).map((c) => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-secondary)" }}>
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
                                    onClick={() => setReframeMode(opt.id)}
                                    style={{
                                        padding: 12,
                                        borderRadius: 10,
                                        border: `2px solid ${reframeMode === opt.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                        background: reframeMode === opt.id ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                        cursor: "pointer",
                                        textAlign: "left",
                                        display: "grid",
                                        gap: 5,
                                    }}
                                >
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, color: reframeMode === opt.id ? "var(--accent-primary)" : "var(--text-primary)" }}>
                                        {opt.emoji} {opt.title}
                                    </div>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                        {opt.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-secondary)" }}>
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
                                    onClick={() => setReframeDifficulty(opt.id)}
                                    style={{
                                        padding: 12,
                                        borderRadius: 10,
                                        border: `2px solid ${reframeDifficulty === opt.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                        background: reframeDifficulty === opt.id ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                        cursor: "pointer",
                                        textAlign: "left",
                                        display: "grid",
                                        gap: 5,
                                    }}
                                >
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, color: reframeDifficulty === opt.id ? "var(--accent-primary)" : "var(--text-primary)" }}>
                                        {opt.emoji} {opt.title}
                                    </div>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                        {opt.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 8 }}>
                            Raised through the physics — an extra step or a second concept — not through messier
                            arithmetic. Overrides the mode's own difficulty.
                        </div>
                    </div>

                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-secondary)", display: "grid", gap: 10 }}>
                        <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-primary)" }}>Paper style</div>
                        <div>
                            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                <input type="checkbox" checked={noCalculator} onChange={(e) => setNoCalculator(e.target.checked)} />
                                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    🧮 No calculator
                                </span>
                            </label>
                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 23, lineHeight: 1.5 }}>
                                Every question must be solvable by hand: values chosen so they cancel (g = 10, standard
                                angles, perfect squares), clean answers and options, no long multiplication, logs or
                                awkward roots. Overrides a mode that keeps the original&rsquo;s numbers.
                            </div>
                        </div>
                        <div>
                            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                <input type="checkbox" checked={conceptual} onChange={(e) => setConceptual(e.target.checked)} />
                                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    💡 Mostly conceptual
                                </span>
                            </label>
                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 23, lineHeight: 1.5 }}>
                                Most questions test understanding: theory questions (which statement is right, what
                                changes when, compare or rank), or numericals with light arithmetic where the hard part
                                is recognising which concept or formula applies, often two ideas combined, never a
                                formula handed over by the wording.
                            </div>
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                            When the pool has too few questions of a type the paper asks for, the gap is filled from
                            other types in the same chapters, and Modify rewrites each one as the type asked for (an
                            SCQ can become a Numerical, and the reverse). The pool-selection notes list every one.
                        </div>
                    </div>

                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-secondary)" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={regenDiagrams} onChange={(e) => setRegenDiagrams(e.target.checked)} />
                            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Redraw figures with an image model when the reframe changes their data
                            </span>
                        </label>
                        {regenDiagrams && (
                            <>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8, marginLeft: 23 }}>
                                    <input type="checkbox" checked={redrawAllFigures} onChange={(e) => setRedrawAllFigures(e.target.checked)} />
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                        Redraw every figure, not just the ones the AI flags as changed
                                    </span>
                                </label>
                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 44, lineHeight: 1.5 }}>
                                    Without this the AI decides per-question, and it usually says nothing changed —
                                    so a rewritten question can keep a diagram still showing the ORIGINAL values.
                                    One image call per figure.
                                </div>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8, marginLeft: 23 }}>
                                    <input type="checkbox" checked={verifyDiagrams} onChange={(e) => setVerifyDiagrams(e.target.checked)} />
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
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
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
                            <input type="checkbox" checked={addFigures} onChange={(e) => setAddFigures(e.target.checked)} />
                            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Create a diagram for a question that has none but would be clearer with one
                            </span>
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
                            <input type="checkbox" checked={genSolutionDiagrams} onChange={(e) => setGenSolutionDiagrams(e.target.checked)} />
                            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                Draw a solution diagram when a solution genuinely needs one
                            </span>
                        </label>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 4, marginLeft: 23 }}>
                            The AI decides per-question — used rarely, only for setups like U-tubes/manometers or ray
                            diagrams where the solution is hard to follow without a picture, never for routine
                            force/free-body-diagram questions.
                        </div>
                        {(regenDiagrams || addFigures || genSolutionDiagrams) && (
                            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
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
                                                <option key={p} value={p}>
                                                    {IMG_PROVIDER_LABELS[p]}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label style={{ display: "grid", gap: 5 }}>
                                        <span style={label}>Image model</span>
                                        <div style={{ display: "flex", gap: 6 }}>
                                            <select value={imgModel} onChange={(e) => setImgModel(e.target.value)} style={{ ...input, flex: 1 }}>
                                                {currentImgModels.length === 0 && <option value="">No models</option>}
                                                {currentImgModels.map((m) => (
                                                    <option key={m.id} value={m.id}>
                                                        {m.label || m.id}
                                                    </option>
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
                                    Experimental. Only figures the model flags as changed are redrawn from the original, using your saved{" "}
                                    {imgProvider === "openai" ? "OpenAI" : "Gemini"} key — always eyeball the new diagram against the new question.
                                </div>
                            </div>
                        )}

                        {/* The last gate before anything is pushed. */}
                        <div style={{ marginTop: 12 }}>
                            <QbgQcSettings value={qc} onChange={setQc} compact />
                        </div>
                    </div>
                </StageToggle>

                <StageToggle
                    title="Tag (optional)"
                    description="AI-tag the newly modified questions."
                    enabled={tagEnabled}
                    onToggle={setTagEnabled}
                    disabled={!modifyEnabled}
                    disabledReason="Requires Modify to be enabled — tagging always runs against the newly modified questions."
                >
                    <div style={{ display: "grid", gap: 7 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={label}>Tag under subject</span>
                            <span style={{ fontSize: "0.72rem", color: "var(--accent-success)" }}>
                                {tagSubjects.length === 0
                                    ? "taken automatically from this run's subjects — nothing to choose"
                                    : `overridden: ${tagSubjects.length} selected`}
                            </span>
                            {tagSubjects.length > 0 && (
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
                                    Use the pool&rsquo;s subjects
                                </button>
                            )}
                        </div>
                        {taxonomySubjects.length > 0 && (
                            <details>
                                <summary style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", cursor: "pointer" }}>
                                    Override the subject (rarely needed)
                                </summary>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                                {taxonomySubjects.map((s) => {
                                    const on = tagSubjects.includes(s);
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
                                                onChange={(e) =>
                                                    setTagSubjects((prev) =>
                                                        e.target.checked
                                                            ? [...new Set([...prev, s])]
                                                            : prev.filter((x) => x !== s)
                                                    )
                                                }
                                            />
                                            {s}
                                        </label>
                                    );
                                })}
                            </div>
                            </details>
                        )}
                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            Chapters that exist under more than one subject — Thermodynamics is in both
                            Physics and Chemistry — can otherwise be filed under the wrong one. Left
                            untouched, tagging is restricted to the subjects this pipeline pooled from.
                        </span>
                    </div>
                </StageToggle>

                <StageToggle
                    title="Agentic QC (optional)"
                    description="1-3 parallel QC agents + an aggregator that re-derives the final answer key, against the current working question set — the modified set if Modify is on, the raw pool otherwise. Requires you to be logged in (Agentic QC has no dev-auth mode)."
                    enabled={qcEnabled}
                    onToggle={setQcEnabled}
                >
                    <div style={{ display: "grid", gap: 8 }}>
                        {qcAgents.map((slot, idx) => (
                            <AgentSlotRow
                                key={slot.label}
                                slot={slot}
                                required={idx === 0}
                                providerModels={providerModels}
                                loadingModels={loadingModels}
                                onChange={(next) =>
                                    setQcAgents((prev) => {
                                        const copy = [...prev];
                                        copy[idx] = next;
                                        return copy;
                                    })
                                }
                                onRefresh={(p) => void loadModels(p)}
                            />
                        ))}
                        <div
                            style={{
                                padding: "10px 12px",
                                borderRadius: 9,
                                border: "1px solid var(--accent-primary)",
                                background: "var(--accent-glow)",
                                display: "grid",
                                gap: 6,
                            }}
                        >
                            <span style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--accent-primary-hover)" }}>
                                Aggregator (final decision)
                            </span>
                            <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                Reads the paper again + every QC agent&rsquo;s verdict, re-derives each answer independently, and
                                produces the consolidated report.
                            </span>
                            <AgentSlotRow
                                slot={qcAggregator}
                                required
                                providerModels={providerModels}
                                loadingModels={loadingModels}
                                onChange={setQcAggregator}
                                onRefresh={(p) => void loadModels(p)}
                            />
                        </div>
                    </div>
                </StageToggle>

                <StageToggle
                    title="Video solutions (optional)"
                    description="Render a narrated video solution for every question in the final set, straight from QBG — the modified questions when Modify is on, the raw pool otherwise. Uses the AI model picked above to write the narration. Adds roughly 30s of render time per question."
                    enabled={videoEnabled}
                    onToggle={setVideoEnabled}
                >
                    <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                        Videos are rendered after QC as the last pipeline stage, and the finished
                        set is downloadable as a ZIP below once the run completes. You can also
                        generate them on demand later from the run&rsquo;s results.
                    </div>
                </StageToggle>

                <div style={card}>
                    <div style={{ ...label, marginBottom: 8 }}>Test document</div>
                    {finalDocItems && finalDocItems.length > 0 ? (
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                            <button
                                type="button"
                                onClick={() => void handleDownload("docx")}
                                disabled={downloading !== null}
                                style={{
                                    border: "1px solid var(--accent-primary)",
                                    borderRadius: 9,
                                    background: "var(--accent-glow)",
                                    color: "var(--accent-primary-hover)",
                                    padding: "8px 14px",
                                    fontSize: "0.8rem",
                                    fontWeight: 600,
                                    cursor: downloading ? "default" : "pointer",
                                    opacity: downloading ? 0.7 : 1,
                                }}
                            >
                                {downloading === "docx" ? "Downloading…" : "Download Word (.docx)"}
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleDownload("pdf")}
                                disabled={downloading !== null}
                                style={{
                                    border: "1px solid var(--accent-primary)",
                                    borderRadius: 9,
                                    background: "var(--accent-glow)",
                                    color: "var(--accent-primary-hover)",
                                    padding: "8px 14px",
                                    fontSize: "0.8rem",
                                    fontWeight: 600,
                                    cursor: downloading ? "default" : "pointer",
                                    opacity: downloading ? 0.7 : 1,
                                }}
                            >
                                {downloading === "pdf" ? "Downloading…" : "Download PDF"}
                            </button>
                            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                {finalDocItems.length} question(s) in the final working set.
                            </span>
                        </div>
                    ) : (
                        <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                            Run the pipeline first — the download becomes available once a final question set exists.
                        </div>
                    )}
                </div>

                {needsAiPicker && (
                    <div style={card}>
                        <div style={{ ...label, marginBottom: 8 }}>AI model (used by Modify + Tag)</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Provider</span>
                                <select value={provider} onChange={(e) => onProviderChange(e.target.value as AIModelProvider)} style={input}>
                                    {(Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[]).map((p) => (
                                        <option key={p} value={p}>
                                            {AI_PROVIDER_LABELS[p]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label style={{ display: "grid", gap: 5 }}>
                                <span style={label}>Model</span>
                                <div style={{ display: "flex", gap: 6 }}>
                                    <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ ...input, flex: 1 }}>
                                        {currentModels.length === 0 && <option value="">No models</option>}
                                        {currentModels.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.label || m.id}
                                            </option>
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
                        {modelLoadError && <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{modelLoadError}</div>}
                    </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                        type="button"
                        onClick={handleRunPipeline}
                        disabled={running}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            border: "none",
                            borderRadius: 12,
                            padding: "12px 20px",
                            background: running ? "var(--bg-hover)" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                            color: "#fff",
                            fontSize: "0.9rem",
                            fontWeight: 700,
                            cursor: running ? "default" : "pointer",
                            opacity: running ? 0.7 : 1,
                        }}
                    >
                        {running ? <Loader2 size={16} className="animate-spin" /> : <ListChecks size={16} />}
                        {running ? stageLabel || "Running…" : "Run pipeline"}
                    </button>
                </div>

                {running && modifyEnabled && modifyProgress.length > 0 && !modifyResult && <QbgProgressLog progress={modifyProgress} />}
                {running && tagEnabled && tagProgress.length > 0 && !tagResult && <QbgProgressLog progress={tagProgress} />}
                {running && qcEnabled && qcStatusLabel && !qcJob && (
                    <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
                        <Loader2 size={13} className="animate-spin" /> {qcStatusLabel}
                    </div>
                )}
                {running && videoEnabled && videoJobState === "running" && (
                    <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
                            <Loader2 size={13} className="animate-spin" />
                            Rendering video solutions{videoCount > 0 ? ` — ${videoCount} done` : ""}…
                        </div>
                        {videoLog && (
                            <pre
                                style={{
                                    margin: 0,
                                    padding: "8px 10px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: 8,
                                    color: "var(--text-secondary)",
                                    fontSize: "0.7rem",
                                    lineHeight: 1.4,
                                    maxHeight: 160,
                                    overflow: "auto",
                                    whiteSpace: "pre-wrap",
                                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                }}
                            >
                                {videoLog}
                            </pre>
                        )}
                    </div>
                )}

                {errors.length > 0 && (
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
                        <div style={{ display: "grid", gap: 4 }}>
                            {errors.map((e, i) => (
                                <span key={i}>{e}</span>
                            ))}
                        </div>
                    </div>
                )}

                {poolResult && (
                    <div style={{ display: "grid", gap: 10 }}>
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
                            Selected {poolResult.poolMeta.selected} of {poolResult.poolMeta.requested} requested question(s).
                        </div>

                        {poolResult.warnings.length > 0 && (
                            <div style={{ ...card, fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                {poolResult.warnings.map((w, i) => (
                                    <div key={i}>{w}</div>
                                ))}
                            </div>
                        )}

                        <div style={{ ...card, display: "grid", gap: 6 }}>
                            <div style={label}>By requirement</div>
                            {poolResult.poolMeta.byRequirement.map((r, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                    <span>
                                        {r.subject} · {r.type}
                                    </span>
                                    <span>
                                        {r.selected} / {r.requested}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div style={{ ...card, display: "grid", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <div style={label}>Question IDs ({poolResult.uniqueIds.length})</div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void copyText(poolResult.uniqueIds.join("\n")).then((ok) => {
                                                if (ok) {
                                                    setIdsCopied(true);
                                                    setTimeout(() => setIdsCopied(false), 2000);
                                                }
                                            });
                                        }}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: 8,
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            padding: "6px 12px",
                                            fontSize: "0.78rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Copy size={13} /> {idsCopied ? "Copied!" : "Copy IDs"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(
                                                new Blob([buildPoolIdsCsv(poolResult.rows)], { type: "text/csv" }),
                                                `${poolResult.uniqueIds.length}_qbg_ids.csv`
                                            )
                                        }
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: 8,
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            padding: "6px 12px",
                                            fontSize: "0.78rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Download size={13} /> Download CSV
                                    </button>
                                </div>
                            </div>
                            <textarea
                                readOnly
                                value={poolResult.uniqueIds.join("\n")}
                                style={{
                                    ...input,
                                    minHeight: 90,
                                    maxHeight: 180,
                                    fontFamily: "ui-monospace, monospace",
                                    fontSize: "0.76rem",
                                    resize: "vertical",
                                }}
                            />
                        </div>
                    </div>
                )}

                {modifyResult?.keyBalance && (
                    <QbgKeyBalance report={modifyResult.keyBalance} cardStyle={card} />
                )}

                {modifyResult?.qcResults && modifyResult.qcResults.length > 0 && (
                    <QbgQcReport
                        results={modifyResult.qcResults}
                        summary={modifyResult.qcSummary}
                        cardStyle={card}
                    />
                )}

                {modifyResult && (() => {
                    // The NEW ids QBG minted for the reframed questions — the ones
                    // worth copying onward (into a test, a tagging run, or the
                    // video/QC tools). Only successful pushes have an id.
                    const modifiedIds = (modifyResult.qbgResults || [])
                        .filter((r) => r.ok && r.unique_id)
                        .map((r) => r.unique_id as string);
                    return (
                    <div style={{ ...card, display: "grid", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <div style={label}>
                                Modify result{modifiedIds.length > 0 ? ` — new QBG IDs (${modifiedIds.length})` : ""}
                            </div>
                            {modifiedIds.length > 0 && (
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void copyText(modifiedIds.join("\n")).then((ok) => {
                                                if (ok) {
                                                    setModifiedIdsCopied(true);
                                                    setTimeout(() => setModifiedIdsCopied(false), 2000);
                                                }
                                            });
                                        }}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: 8,
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            padding: "6px 12px",
                                            fontSize: "0.78rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Copy size={13} /> {modifiedIdsCopied ? "Copied!" : "Copy IDs"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(
                                                new Blob([buildModifiedIdsCsv(modifyResult.qbgResults || [], workingIds)],
                                                         { type: "text/csv" }),
                                                `${modifiedIds.length}_modified_qbg_ids.csv`
                                            )
                                        }
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: 8,
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            padding: "6px 12px",
                                            fontSize: "0.78rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Download size={13} /> Download CSV
                                    </button>
                                </div>
                            )}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            Pushed to QBG — {(modifyResult.qbgResults || []).filter((r) => r.ok).length} of{" "}
                            {(modifyResult.qbgResults || []).length} succeeded.
                        </div>
                        {(modifyResult.warnings || []).length > 0 && (
                            <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                {(modifyResult.warnings || []).map((w, i) => (
                                    <div key={i}>{w}</div>
                                ))}
                            </div>
                        )}
                        {(modifyResult.missingIds || []).length > 0 && (
                            <div style={{ fontSize: "0.78rem", color: "var(--accent-warning)" }}>
                                QBG did not return {modifyResult.missingIds!.length} id(s): {modifyResult.missingIds!.join(", ")}
                            </div>
                        )}
                        {(modifyResult.skippedUnsupported || []).length > 0 && (
                            <div style={{ fontSize: "0.78rem", color: "var(--accent-warning)" }}>
                                Skipped {modifyResult.skippedUnsupported!.length} question(s) of an unsupported type:{" "}
                                {modifyResult.skippedUnsupported!.map((s) => `${s.qbgId} (${s.reason})`).join("; ")}
                            </div>
                        )}
                        <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                            {(modifyResult.qbgResults || []).map((r, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.76rem" }}>
                                    {r.ok ? <CheckCircle2 size={13} color="var(--accent-success)" /> : <AlertCircle size={13} color="var(--accent-danger)" />}
                                    {r.unique_id ? (
                                        <a href={QUESTION_URL + encodeURIComponent(r.unique_id)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "ui-monospace, monospace", color: "var(--accent-primary)" }}>
                                            {r.unique_id}
                                        </a>
                                    ) : (
                                        <span style={{ color: "var(--text-tertiary)" }}>(no id)</span>
                                    )}
                                    {!r.ok && r.error && <span style={{ color: "var(--accent-danger)" }}>{r.error}</span>}
                                </div>
                            ))}
                        </div>

                        {/* The same reframe artefacts QBG Modification offers — the
                            side-by-side HTML pack and both CSVs come back on this
                            job result already, they were simply never surfaced here. */}
                        {(modifyResult.zipBase64 || modifyResult.modifiedCsv || modifyResult.originalCsv) && (
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                {modifyResult.zipBase64 && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(
                                                base64ToBlob(modifyResult.zipBase64!, "application/zip"),
                                                modifyResult.zipName || "reframed.zip"
                                            )
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={14} /> Interactive HTML pack (.zip)
                                    </button>
                                )}
                                {modifyResult.modifiedCsv && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(
                                                new Blob([modifyResult.modifiedCsv!], { type: "text/csv" }),
                                                `${modifyResult.sourceName || "pipeline"}_modified.csv`
                                            )
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={14} /> Modified CSV
                                    </button>
                                )}
                                {modifyResult.originalCsv && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            downloadBlob(
                                                new Blob([modifyResult.originalCsv!], { type: "text/csv" }),
                                                `${modifyResult.sourceName || "pipeline"}_original.csv`
                                            )
                                        }
                                        style={dlBtn}
                                    >
                                        <Download size={14} /> Original CSV
                                    </button>
                                )}
                            </div>
                        )}

                        <QbgModifiedPreview
                            records={modifyResult.records || []}
                            originals={modifyResult.originals}
                        />
                    </div>
                    );
                })()}

                {tagResult && (
                    <div style={{ ...card, display: "grid", gap: 8 }}>
                        <div style={label}>Tag result</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            Tagged {tagResult.tagged ?? "?"} of {tagResult.count ?? "?"} question(s).
                        </div>
                        <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                            {(tagResult.results || []).map((r, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.76rem" }}>
                                    {r.ok ? <CheckCircle2 size={13} color="var(--accent-success)" /> : <AlertCircle size={13} color="var(--accent-danger)" />}
                                    {r.qbg_id ? (
                                        <a href={QUESTION_URL + encodeURIComponent(r.qbg_id)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "ui-monospace, monospace", color: "var(--accent-primary)" }}>
                                            {r.qbg_id}
                                        </a>
                                    ) : (
                                        <span style={{ color: "var(--text-tertiary)" }}>(no id)</span>
                                    )}
                                    {!r.ok && r.error && <span style={{ color: "var(--accent-danger)" }}>{r.error}</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {qcJob && (
                    <div style={{ ...card, display: "grid", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <div style={label}>QC result</div>
                            <button
                                type="button"
                                onClick={() => {
                                    setDownloadingQcPdf(true);
                                    void downloadJobAsPDF(qcJob).finally(() => setDownloadingQcPdf(false));
                                }}
                                disabled={downloadingQcPdf || qcJob.questions.length === 0}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    border: "1px solid var(--accent-primary)",
                                    borderRadius: 8,
                                    background: "var(--accent-glow)",
                                    color: "var(--accent-primary-hover)",
                                    padding: "6px 12px",
                                    fontSize: "0.78rem",
                                    fontWeight: 600,
                                    cursor: downloadingQcPdf || qcJob.questions.length === 0 ? "default" : "pointer",
                                    opacity: downloadingQcPdf || qcJob.questions.length === 0 ? 0.6 : 1,
                                }}
                            >
                                <Download size={13} /> {downloadingQcPdf ? "Generating…" : "Download QC report (PDF)"}
                            </button>
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            Status: {qcJob.status} · {qcJob.questions.length} question(s) ·{" "}
                            {qcJob.questions.filter((q) => q.aggregator.needsManualReview).length} flagged for manual review.
                        </div>
                        {qcJob.fatalError && <div style={{ fontSize: "0.78rem", color: "var(--accent-danger)" }}>{qcJob.fatalError}</div>}
                        <div style={{ display: "grid", gap: 4, maxHeight: 260, overflowY: "auto" }}>
                            {qcJob.questions.map((q) => (
                                <div
                                    key={q.questionNumber}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                        fontSize: "0.76rem",
                                        color: q.aggregator.needsManualReview ? "var(--accent-danger)" : "var(--text-secondary)",
                                    }}
                                >
                                    {q.aggregator.needsManualReview ? <AlertCircle size={13} color="var(--accent-danger)" /> : <CheckCircle2 size={13} color="var(--accent-success)" />}
                                    <span>
                                        Q{q.questionNumber}
                                        {q.qbgId ? ` · ${q.qbgId}` : ""} — {q.aggregator.needsManualReview ? q.aggregator.manualReviewReason || "flagged" : "ok"}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            Also visible in the Agentic QC page&rsquo;s own history.
                        </div>
                    </div>
                )}

                {/* Answer-key balance — after the swap pass, what is still uneven. */}
                {keyIssues.length > 0 && (
                    <div
                        style={{
                            ...card,
                            display: "grid",
                            gap: 6,
                            border: "1px solid rgba(var(--accent-warning-rgb),0.35)",
                            background: "rgba(var(--accent-warning-rgb),0.06)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: "0.85rem", color: "var(--accent-warning)" }}>
                            <AlertCircle size={15} />
                            Answer key: {keyIssues.length} thing(s) the reorder could not fix
                        </div>
                        {keyIssues.map((issue, i) => (
                            <div key={i} style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                                {issue.message}
                            </div>
                        ))}
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            Questions were already reordered within their own subject and question type to break runs of
                            more than three identical options. What is left needs a different question, or a question
                            whose options are re-lettered.
                        </div>
                    </div>
                )}

                {/* Out-of-syllabus audit — what the tagger says each question is
                    really about, checked against the chapters this test selected. */}
                {outOfSyllabus.length > 0 && (
                    <div
                        style={{
                            ...card,
                            display: "grid",
                            gap: 8,
                            border: "1px solid rgba(var(--accent-warning-rgb),0.45)",
                            background: "rgba(var(--accent-warning-rgb),0.08)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: "0.85rem", color: "var(--accent-warning)" }}>
                            <AlertCircle size={15} />
                            {outOfSyllabus.length} question(s) are OUT OF SYLLABUS for this test
                        </div>
                        <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                            After tagging, these landed in chapters that are not among the ones you
                            selected. Review or drop them before using the paper.
                        </div>
                        {groupOutOfSyllabus(outOfSyllabus).map((g) => (
                            <div key={`${g.subject}||${g.chapter}`} style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                    {g.chapter}
                                    {g.subject ? ` · ${g.subject}` : ""} — {g.ids.length} question(s), not in this
                                    test&rsquo;s syllabus
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    {g.ids.map((id) => (
                                        <a
                                            key={id}
                                            href={QUESTION_URL + encodeURIComponent(id)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                fontFamily: "ui-monospace, monospace",
                                                fontSize: "0.72rem",
                                                color: "var(--accent-primary)",
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: 7,
                                                padding: "2px 7px",
                                                background: "var(--bg-tertiary)",
                                            }}
                                        >
                                            {id}
                                        </a>
                                    ))}
                                </div>
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={() => {
                                void copyText(outOfSyllabus.map((o) => o.qbgId).join("\n"));
                            }}
                            style={{
                                justifySelf: "start",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "6px 12px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                            }}
                        >
                            <Copy size={13} /> Copy the {outOfSyllabus.length} flagged ID(s)
                        </button>
                    </div>
                )}

                <QbgLaterChapterWarning
                    items={laterChapterUse}
                    cardStyle={card}
                    scopeLabel="this test's chapters allow"
                />

                {workingIds && (
                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        Current working set: {workingIds.length} question(s).
                    </div>
                )}
                {!running && workingIds && renderVideoGenBlock(workingIds)}

                {viewedReport && (
                    <div style={{ ...card, display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={label}>{viewedReport.file_name || "Pipeline run"}</div>
                            <button
                                type="button"
                                onClick={() => setViewedReport(null)}
                                style={{ border: "none", background: "transparent", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "0.75rem" }}
                            >
                                Close
                            </button>
                        </div>
                        {(() => {
                            const finalIds = (viewedReport.report_data as { finalIds?: string[] })?.finalIds;
                            if (!finalIds || finalIds.length === 0) return null;
                            return (
                                <div style={{ display: "grid", gap: 6 }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                        <div style={label}>Final QBG IDs ({finalIds.length})</div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void copyText(finalIds.join("\n")).then((ok) => {
                                                    if (ok) {
                                                        setViewedIdsCopied(true);
                                                        setTimeout(() => setViewedIdsCopied(false), 2000);
                                                    }
                                                });
                                            }}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: 6,
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: 8,
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                padding: "6px 12px",
                                                fontSize: "0.78rem",
                                                cursor: "pointer",
                                            }}
                                        >
                                            <Copy size={13} /> {viewedIdsCopied ? "Copied!" : "Copy IDs"}
                                        </button>
                                    </div>
                                    <textarea
                                        readOnly
                                        value={finalIds.join("\n")}
                                        style={{
                                            ...input,
                                            minHeight: 70,
                                            maxHeight: 140,
                                            fontFamily: "ui-monospace, monospace",
                                            fontSize: "0.75rem",
                                            resize: "vertical",
                                        }}
                                    />
                                </div>
                            );
                        })()}
                        {renderVideoGenBlock(((viewedReport.report_data as { finalIds?: string[] })?.finalIds) || [])}
                        {(() => {
                            const qc = (viewedReport.report_data as { qc?: unknown })?.qc;
                            if (!qc || typeof qc !== "object" || !Array.isArray((qc as JobRecord).questions)) return null;
                            const job = qc as JobRecord;
                            const flagged = job.questions.filter((q) => q.aggregator.needsManualReview).length;
                            return (
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                        QC: {job.questions.length} question(s) · {flagged} flagged for review
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setViewedQcDownloading(true);
                                            void downloadJobAsPDF(job).finally(() => setViewedQcDownloading(false));
                                        }}
                                        disabled={viewedQcDownloading || job.questions.length === 0}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            border: "1px solid var(--border-accent)",
                                            borderRadius: 8,
                                            background: "var(--accent-glow)",
                                            color: "var(--accent-primary-hover)",
                                            padding: "6px 12px",
                                            fontSize: "0.78rem",
                                            fontWeight: 600,
                                            cursor: viewedQcDownloading || job.questions.length === 0 ? "default" : "pointer",
                                            opacity: viewedQcDownloading || job.questions.length === 0 ? 0.6 : 1,
                                        }}
                                    >
                                        <Download size={13} /> {viewedQcDownloading ? "Generating…" : "Download QC report (PDF)"}
                                    </button>
                                </div>
                            );
                        })()}
                        {(() => {
                            // Persisted by the Modify stage; arrives with the
                            // on-demand fetchFullTaskData payload, not the listing.
                            const rd = viewedReport.report_data as {
                                records?: ModifiedRecord[];
                                originals?: PreviewOriginal[];
                            };
                            if (!rd?.records || rd.records.length === 0) return null;
                            return (
                                <QbgModifiedPreview
                                    records={rd.records}
                                    originals={rd.originals}
                                    heading="Modified questions — open “Compare with original” on any question."
                                />
                            );
                        })()}
                        <details>
                            <summary style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", cursor: "pointer" }}>
                                Raw run data
                            </summary>
                            <pre
                                style={{
                                    fontSize: "0.72rem",
                                    color: "var(--text-secondary)",
                                    whiteSpace: "pre-wrap",
                                    margin: "6px 0 0",
                                    fontFamily: "ui-monospace, monospace",
                                    maxHeight: 300,
                                    overflowY: "auto",
                                }}
                            >
                                {JSON.stringify(
                                    // The question HTML carries inlined figure
                                    // data: URLs — dumping it raw is megabytes of
                                    // base64 nobody reads. It's shown properly by
                                    // the preview above.
                                    Object.fromEntries(
                                        Object.entries(viewedReport.report_data as Record<string, unknown>)
                                            .filter(([k]) => k !== "records" && k !== "originals")
                                    ),
                                    null,
                                    2
                                )}
                            </pre>
                        </details>
                    </div>
                )}
            </div>

            <QbgTaskHistory
                reports={reports}
                activeLabels={[]}
                noun="pipeline runs"
                loading={loadingReports}
                summary={(rd) => {
                    const pool = rd.pool as { selected?: number; requested?: number } | undefined;
                    const finalCount = rd.finalCount as number | undefined;
                    const finalIds = rd.finalIds as string[] | undefined;
                    const qcSummary = rd.qcSummary as { flaggedForReview?: number } | undefined;
                    const count = finalCount ?? finalIds?.length ?? pool?.selected ?? "?";
                    const suffix = qcSummary ? ` · QC: ${qcSummary.flaggedForReview ?? 0} flagged for review` : "";
                    // A run interrupted before its final "done" patch (e.g. a
                    // reload mid-run) never sets finalCount — say "so far" so
                    // it's clear this may be a partial result, not a finished one.
                    return `${count} question(s)${finalCount === undefined ? " so far" : " in final set"}${suffix}`;
                }}
                onView={(r) => {
                    const row = r as HistoryReport;
                    setViewedReport(row);
                    // Pull in the QC payload the listing left out.
                    void fetchFullTaskData(row.id).then((full) => {
                        if (full) {
                            setViewedReport((prev) =>
                                prev && prev.id === row.id
                                    ? { ...prev, report_data: { ...prev.report_data, ...full } }
                                    : prev
                            );
                        }
                    });
                }}
                onDelete={(id) => void deleteReport(id)}
            />
        </div>
    );
}
