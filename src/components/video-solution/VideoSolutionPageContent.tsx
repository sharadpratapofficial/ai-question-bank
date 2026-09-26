"use client";

/**
 * Self-contained content for the standalone /video-solution page.
 *
 * Video Solution used to be one tab inside the shared /ai-tools hub, reusing
 * that page's shared file-upload widgets and provider/model picker (not
 * separable components — see src/app/ai-tools/page.tsx). Now that it's its
 * own page (gated by the "use_video_solution" permission, independent of
 * "use_ai_tools"), it needs its own small versions of those — same
 * self-contained-panel shape as every QBG panel (e.g. QbgModifierPanel.tsx's
 * provider/model picker).
 *
 * Report history reuses the SAME global `savedReports`/`reloadReports` from
 * AIJobQueueContext that /ai-tools uses (already fetches every report type,
 * including "video" — no new API call needed), filtered down to video rows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Clock,
    Download,
    History,
    Loader2,
    RefreshCw,
    Upload,
} from "lucide-react";
import {
    EMPTY_USER_API_KEYS,
    getProviderApiCredential,
    readDevApiKeysFromStorage,
    sanitizeUserApiKeys,
    type SupportedApiProvider,
    type UserApiKeys,
} from "@/lib/userApiKeys";
import { AI_PROVIDER_LABELS, AI_PROVIDER_MODELS, type AIModelProvider, type ModelOption } from "@/types/extraction";
import { useAIJobQueue } from "@/context/AIJobQueueContext";
import VideoSolutionPanel from "@/components/ai-tools/VideoSolutionPanel";

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    padding: 20,
    background: "var(--bg-secondary)",
    display: "grid",
    gap: 14,
};
const label: React.CSSProperties = { fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" };
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

export default function VideoSolutionPageContent() {
    // ---- shared AI provider/model picker (same self-contained-panel pattern
    // used by every QBG panel this session) ----
    const [provider, setProvider] = useState<AIModelProvider>("gemini");
    const [modelId, setModelId] = useState<string>(AI_PROVIDER_MODELS.gemini[0]?.id || "");
    const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({ ...AI_PROVIDER_MODELS });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);
    const providerRef = useRef(provider);
    useEffect(() => {
        providerRef.current = provider;
    }, [provider]);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- saved API keys (same load pattern as /ai-tools) ----
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    useEffect(() => {
        let mounted = true;
        async function loadSavedApiKeys() {
            try {
                const res = await fetch("/api/user/api-keys", { method: "GET", cache: "no-store" });
                const payload = (await res.json()) as { success?: boolean; apiKeys?: unknown };
                if (res.ok && payload.success) {
                    if (mounted) setUserApiKeys(sanitizeUserApiKeys(payload.apiKeys));
                    return;
                }
            } catch {
                /* fall through */
            }
            if (!mounted || typeof window === "undefined") return;
            if (document.cookie.includes("qbg_dev_auth=1")) {
                setUserApiKeys(readDevApiKeysFromStorage());
                return;
            }
            setUserApiKeys({ ...EMPTY_USER_API_KEYS });
        }
        void loadSavedApiKeys();
        return () => {
            mounted = false;
        };
    }, []);

    const hasResolvedProviderKey = Boolean(getProviderApiCredential(provider, userApiKeys[provider] || ""));

    // ---- input source: upload PDFs/docx, or paste QBG unique_ids ----
    const [sourceMode, setSourceMode] = useState<"upload" | "qbg">("upload");
    const [questionPdf, setQuestionPdf] = useState<File | null>(null);
    const [solutionsPdf, setSolutionsPdf] = useState<File | null>(null);
    const questionInputRef = useRef<HTMLInputElement>(null);
    const solutionInputRef = useRef<HTMLInputElement>(null);
    const [qbgIdsRaw, setQbgIdsRaw] = useState("");
    const qbgIds = qbgIdsRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    // ---- history + background-jobs banner (global context, same source
    // /ai-tools uses — no separate fetch needed) ----
    const { savedReports, reloadReports, activeVideoJobs } = useAIJobQueue();
    const [historyExpanded, setHistoryExpanded] = useState(true);
    const videoReports = savedReports.filter((r) => r.report_type === "video");

    return (
        <div style={{ display: "grid", gap: 16, maxWidth: 900 }}>
            {/* Provider/model */}
            <div style={card}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>AI Configuration</div>
                <div style={{ display: "grid", gap: 8 }}>
                    <span style={label}>AI Provider</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {(Object.keys(AI_PROVIDER_LABELS) as AIModelProvider[]).map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => onProviderChange(p)}
                                style={{
                                    padding: "7px 14px",
                                    borderRadius: 8,
                                    border: `1px solid ${provider === p ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                    background: provider === p ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                    color: provider === p ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                    fontSize: "0.8rem",
                                    fontWeight: provider === p ? 700 : 500,
                                    cursor: "pointer",
                                }}
                            >
                                {AI_PROVIDER_LABELS[p]}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={label}>Model</span>
                        <button
                            type="button"
                            onClick={() => void loadModels(provider)}
                            disabled={loadingModels}
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "6px 10px",
                                fontSize: "0.74rem",
                                fontWeight: 650,
                                cursor: loadingModels ? "default" : "pointer",
                                opacity: loadingModels ? 0.7 : 1,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                            }}
                        >
                            <RefreshCw size={12} className={loadingModels ? "animate-spin" : ""} />
                            Refresh
                        </button>
                    </div>
                    <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={input}>
                        {currentModels.length === 0 && <option value="">No models</option>}
                        {currentModels.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.label || m.id}
                            </option>
                        ))}
                    </select>
                    {modelLoadError && (
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{modelLoadError}</div>
                    )}
                    <div
                        style={{
                            border: `1px solid ${hasResolvedProviderKey ? "rgba(34,197,94,0.35)" : "rgba(234,179,8,0.35)"}`,
                            background: hasResolvedProviderKey ? "rgba(34,197,94,0.08)" : "rgba(234,179,8,0.08)",
                            color: hasResolvedProviderKey ? "#22c55e" : "#eab308",
                            borderRadius: 8,
                            padding: "8px 10px",
                            fontSize: "0.75rem",
                        }}
                    >
                        {hasResolvedProviderKey
                            ? `Using saved ${AI_PROVIDER_LABELS[provider]} API key from account settings.`
                            : `No saved ${AI_PROVIDER_LABELS[provider]} API key found. Add it from the user icon.`}
                    </div>
                </div>
            </div>

            {/* Input source */}
            <div style={card}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>Question Source</div>
                <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)" }}>
                    {(["upload", "qbg"] as const).map((m) => (
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
                            {m === "upload" ? "Upload PDF/Word" : "QBG unique_ids"}
                        </button>
                    ))}
                </div>

                {sourceMode === "qbg" ? (
                    <div>
                        <textarea
                            value={qbgIdsRaw}
                            onChange={(e) => setQbgIdsRaw(e.target.value)}
                            placeholder={"Paste QBG unique_ids, one per line\n4ii5mxgv84bkvg16rv8akjy1j\nel9dtimjg18xf49stwcr2fvv4"}
                            style={{ ...input, minHeight: 96, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
                        />
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: 6 }}>
                            Question, options, and solution are fetched straight from QBG using your saved QBG token
                            (user icon → Manage API Keys → QBG) — no PDF needed. Ids that can&rsquo;t be fetched, or
                            are a type this pipeline doesn&rsquo;t support yet, are skipped with a reason.
                        </div>
                    </div>
                ) : (
                    <>
                        <div
                            onClick={() => questionInputRef.current?.click()}
                            style={{
                                border: `2px dashed ${questionPdf ? "rgba(34,197,94,0.5)" : "var(--border-primary)"}`,
                                borderRadius: 10,
                                padding: "28px 20px",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 8,
                                cursor: "pointer",
                                background: questionPdf ? "rgba(34,197,94,0.05)" : "var(--bg-tertiary)",
                            }}
                        >
                            {questionPdf ? (
                                <>
                                    <CheckCircle2 size={24} color="#22c55e" />
                                    <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#22c55e" }}>{questionPdf.name}</div>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        {(questionPdf.size / 1024).toFixed(1)} KB · Click to change
                                    </div>
                                </>
                            ) : (
                                <>
                                    <Upload size={24} color="var(--text-muted)" />
                                    <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Click to upload PDF or Word file
                                    </div>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Supports .pdf, .doc, .docx</div>
                                </>
                            )}
                        </div>
                        <input
                            ref={questionInputRef}
                            type="file"
                            accept=".pdf,.doc,.docx"
                            onChange={(e) => setQuestionPdf(e.target.files?.[0] ?? null)}
                            style={{ display: "none" }}
                        />

                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 1, background: "var(--border-primary)" }} />
                            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                Solution File (required for videos)
                            </span>
                            <div style={{ flex: 1, height: 1, background: "var(--border-primary)" }} />
                        </div>
                        <div
                            onClick={() => solutionInputRef.current?.click()}
                            style={{
                                border: `2px dashed ${solutionsPdf ? "rgba(99,102,241,0.5)" : "var(--border-secondary)"}`,
                                borderRadius: 10,
                                padding: "20px",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 6,
                                cursor: "pointer",
                                background: solutionsPdf ? "rgba(99,102,241,0.05)" : "var(--bg-tertiary)",
                            }}
                        >
                            {solutionsPdf ? (
                                <>
                                    <CheckCircle2 size={20} color="var(--accent-primary)" />
                                    <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>{solutionsPdf.name}</div>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                        {(solutionsPdf.size / 1024).toFixed(1)} KB · Click to change
                                    </div>
                                </>
                            ) : (
                                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Click to upload solutions PDF</div>
                            )}
                        </div>
                        <input
                            ref={solutionInputRef}
                            type="file"
                            accept=".pdf,.doc,.docx"
                            onChange={(e) => setSolutionsPdf(e.target.files?.[0] ?? null)}
                            style={{ display: "none" }}
                        />
                    </>
                )}
            </div>

            {/* Video Solution's own knobs + run buttons + live job status */}
            <VideoSolutionPanel
                questionPdf={sourceMode === "upload" ? questionPdf : null}
                solutionsPdf={sourceMode === "upload" ? solutionsPdf : null}
                qbgIds={sourceMode === "qbg" ? qbgIds : undefined}
                aiProvider={provider}
                aiModelId={modelId}
                userApiKeys={userApiKeys}
                onReportSaved={() => {
                    void reloadReports();
                }}
            />

            {/* Background video jobs banner */}
            {activeVideoJobs.length > 0 && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid rgba(245,158,11,0.35)",
                        background: "rgba(245,158,11,0.08)",
                        color: "#f59e0b",
                        fontSize: "0.78rem",
                    }}
                >
                    <Loader2 size={14} className="animate-spin" />
                    <span>
                        <strong>{activeVideoJobs.length}</strong> video{activeVideoJobs.length === 1 ? "" : "s"} rendering in background
                        {" — "}
                        {activeVideoJobs.map((j, i) => (
                            <span key={j.jobId}>
                                {i > 0 && ", "}
                                <code style={{ background: "rgba(245,158,11,0.15)", padding: "0 4px", borderRadius: 3 }}>
                                    {j.fileName.slice(0, 40)}
                                </code>
                            </span>
                        ))}
                        {". Feel free to navigate away — finished videos appear in the history below."}
                    </span>
                </div>
            )}

            {/* History — video reports only */}
            <div style={{ ...card, padding: 0, gap: 0, overflow: "hidden" }}>
                <button
                    type="button"
                    onClick={() => setHistoryExpanded((prev) => !prev)}
                    style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "16px 20px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--text-primary)",
                        textAlign: "left",
                    }}
                >
                    <div
                        style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            background: "rgba(99,102,241,0.12)",
                            color: "#818cf8",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        <History size={14} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "0.88rem", fontWeight: 700 }}>Video History</div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                            {videoReports.length} saved video report{videoReports.length !== 1 ? "s" : ""}
                        </div>
                    </div>
                    {historyExpanded ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
                </button>

                {historyExpanded && (
                    <div style={{ padding: "0 20px 20px", display: "grid", gap: 6 }}>
                        {videoReports.length === 0 ? (
                            <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                                No video reports yet. Generate one above to get started.
                            </div>
                        ) : (
                            videoReports.map((entry) => {
                                const d = (entry.report_data || {}) as {
                                    videoCount?: number;
                                    voice?: string;
                                    language?: string;
                                };
                                const date = new Date(entry.created_at);
                                const timeStr =
                                    date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) +
                                    " · " +
                                    date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
                                return (
                                    <div
                                        key={entry.id}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "10px 12px",
                                            borderRadius: 9,
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                        }}
                                    >
                                        <span
                                            style={{
                                                padding: "3px 8px",
                                                borderRadius: 6,
                                                fontSize: "0.68rem",
                                                fontWeight: 700,
                                                background: "rgba(245,158,11,0.1)",
                                                color: "#f59e0b",
                                                border: "1px solid rgba(245,158,11,0.25)",
                                                whiteSpace: "nowrap",
                                                flexShrink: 0,
                                            }}
                                        >
                                            Video
                                        </span>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div
                                                style={{
                                                    fontSize: "0.8rem",
                                                    fontWeight: 600,
                                                    color: "var(--text-primary)",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {entry.file_name || "Unnamed file"}
                                            </div>
                                            <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
                                                <Clock size={10} />
                                                {timeStr}
                                                <span style={{ opacity: 0.5 }}>·</span>
                                                {entry.provider}/{entry.model_id?.split("/").pop() || entry.model_id}
                                                {d.videoCount != null && (
                                                    <>
                                                        <span style={{ opacity: 0.5 }}>·</span>
                                                        <span>
                                                            {d.videoCount} videos
                                                            {d.voice ? ` • ${d.voice}` : ""}
                                                            {d.language ? ` • ${d.language}` : ""}
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const url = `/api/ai-tools/video-solution/artifact?report_id=${encodeURIComponent(entry.id)}`;
                                                window.open(url, "_blank");
                                            }}
                                            title="Download video ZIP"
                                            style={{
                                                width: 26,
                                                height: 26,
                                                borderRadius: 6,
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-elevated)",
                                                color: "var(--text-secondary)",
                                                cursor: "pointer",
                                                display: "grid",
                                                placeItems: "center",
                                                flexShrink: 0,
                                            }}
                                        >
                                            <Download size={13} />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
