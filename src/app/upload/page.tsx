"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useCurrentUser } from "@/context/UserProfileContext";
import { useRouter } from "next/navigation";
import {
    Upload,
    FileUp,
    Loader2,
    RefreshCw,
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Trash2,
    Save,
    Eye,
    Pencil,
    X,
    Sparkles,
    FileText,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import MathContent from "@/components/ui/MathContent";
import { useAIJobQueue } from "@/context/AIJobQueueContext";
import { useExtractionQueue } from "@/context/ExtractionQueueContext";
import QuestionEditModal, {
    type QuestionEditorDraft,
    type QuestionEditorMetadataDraft,
    type QuestionEditorOptionDraft,
} from "@/components/questions/QuestionEditModal";
import type {
    AIModelProvider,
    ModelOption,
    UploadMode,
    ExtractedQuestion,
    ExtractionRequest,
    ExtractionResponse,
    SaveQuestionsResponse,
} from "@/types/extraction";
import { AI_PROVIDER_LABELS, AI_PROVIDER_MODELS } from "@/types/extraction";
import {
    KNOWN_SUBJECTS,
    KNOWN_QUESTION_TYPES,
    KNOWN_DIFFICULTIES,
    KNOWN_SOURCES,
    QUESTION_TYPE_LABELS,
    SUBJECT_COLORS,
    DIFFICULTY_COLORS,
    QUESTION_TYPE_COLORS,
    DEFAULT_BADGE_COLOR,
} from "@/lib/constants";
import {
    EMPTY_USER_API_KEYS,
    getProviderApiCredential,
    readDevApiKeysFromStorage,
    sanitizeUserApiKeys,
    type UserApiKeys,
} from "@/lib/userApiKeys";

// ==================== HELPER COMPONENTS ====================

function Badge({
    color,
    children,
}: {
    color: { bg: string; text: string; border: string };
    children: React.ReactNode;
}) {
    return (
        <span
            style={{
                padding: "2px 8px",
                borderRadius: "6px",
                fontSize: "0.72rem",
                fontWeight: 600,
                background: color.bg,
                color: color.text,
                border: `1px solid ${color.border}`,
                whiteSpace: "nowrap",
            }}
        >
            {children}
        </span>
    );
}

// ==================== MAIN PAGE COMPONENT ====================

export default function UploadPage() {
    const router = useRouter();
    const { can, loading: profileLoading } = useCurrentUser();
    const { enqueueJob } = useAIJobQueue();
    const { enqueue: enqueueExtraction, jobs: extractionJobs } = useExtractionQueue();

    useEffect(() => {
        if (!profileLoading && !can("upload_pdf")) {
            router.replace("/questions");
        }
    }, [profileLoading, can, router]);

    // Upload state
    const [uploadMode, setUploadMode] = useState<UploadMode>("single");
    const [aiProvider, setAiProvider] = useState<AIModelProvider>("gemini");
    const [modelId, setModelId] = useState(AI_PROVIDER_MODELS.gemini[0].id);
    const [apiKey, setApiKey] = useState("");
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    const [providerModels, setProviderModels] = useState<Record<AIModelProvider, ModelOption[]>>({
        ...AI_PROVIDER_MODELS,
    });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);
    const [usingLiveModels, setUsingLiveModels] = useState(false);
    const [sourceName, setSourceName] = useState("");
    const [questionsPdf, setQuestionsPdf] = useState<File | null>(null);
    const [solutionsPdf, setSolutionsPdf] = useState<File | null>(null);

    // Extraction state
    const [extracting, setExtracting] = useState(false);
    const [extractionError, setExtractionError] = useState<string | null>(null);
    const [extractedQuestions, setExtractedQuestions] = useState<ExtractedQuestion[]>([]);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [pdfType, setPdfType] = useState<string>("");

    // Review state
    const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
    const [selectedQuestions, setSelectedQuestions] = useState<Set<number>>(new Set());
    const [editingQuestionIndex, setEditingQuestionIndex] = useState<number | null>(null);

    // Save state
    const [saving, setSaving] = useState(false);
    const [saveResult, setSaveResult] = useState<SaveQuestionsResponse | null>(null);

    // Refs
    const aiProviderRef = useRef<AIModelProvider>(aiProvider);
    const modelRequestRef = useRef(0);
    const questionsFileRef = useRef<HTMLInputElement>(null);
    const solutionsFileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        aiProviderRef.current = aiProvider;
    }, [aiProvider]);

    useEffect(() => {
        let mounted = true;

        async function loadSavedApiKeys() {
            try {
                const response = await fetch("/api/user/api-keys", {
                    method: "GET",
                    cache: "no-store",
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    apiKeys?: unknown;
                };

                if (response.ok && payload.success) {
                    const keys = sanitizeUserApiKeys(payload.apiKeys);
                    if (mounted) {
                        setUserApiKeys(keys);
                    }
                    return;
                }
            } catch {
                // Ignore and continue with fallback strategies.
            }

            if (!mounted || typeof window === "undefined") return;

            if (document.cookie.includes("qbg_dev_auth=1")) {
                setUserApiKeys(readDevApiKeysFromStorage());
                return;
            }

            const legacyKey = localStorage.getItem("pdf_extract_api_key") || "";
            setUserApiKeys({
                ...EMPTY_USER_API_KEYS,
                gemini: legacyKey.trim(),
            });
        }

        void loadSavedApiKeys();
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        setApiKey(userApiKeys[aiProvider] || "");
    }, [aiProvider, userApiKeys]);

    const loadLiveModels = useCallback(
        async (provider: AIModelProvider) => {
            const requestId = ++modelRequestRef.current;
            const providerApiKey = (userApiKeys[provider] || "").trim();

            if (aiProviderRef.current === provider && modelRequestRef.current === requestId) {
                setLoadingModels(true);
                setModelLoadError(null);
            }
            try {
                const headers: Record<string, string> = {};
                if (
                    providerApiKey &&
                    typeof document !== "undefined" &&
                    document.cookie.includes("qbg_dev_auth=1")
                ) {
                    headers["x-dev-api-key"] = providerApiKey;
                }

                const response = await fetch(`/api/upload/models?provider=${provider}`, {
                    method: "GET",
                    headers,
                    cache: "no-store",
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    models?: ModelOption[];
                    error?: string;
                };

                if (!response.ok || !payload.success || !Array.isArray(payload.models) || payload.models.length === 0) {
                    throw new Error(payload.error || "Could not load live models.");
                }

                setProviderModels((prev) => ({
                    ...prev,
                    [provider]: payload.models || AI_PROVIDER_MODELS[provider],
                }));
                if (aiProviderRef.current === provider && modelRequestRef.current === requestId) {
                    setModelId((prev) => {
                        const loadedModels = payload.models || AI_PROVIDER_MODELS[provider];
                        if (loadedModels.some((model) => model.id === prev)) return prev;
                        return loadedModels[0]?.id || prev;
                    });
                    setUsingLiveModels(true);
                    setModelLoadError(null);
                }
            } catch (err) {
                setProviderModels((prev) => ({
                    ...prev,
                    [provider]: AI_PROVIDER_MODELS[provider],
                }));
                if (aiProviderRef.current === provider && modelRequestRef.current === requestId) {
                    setUsingLiveModels(false);
                    setModelLoadError(
                        err instanceof Error
                            ? `${err.message} Showing fallback model list.`
                            : "Could not load live models. Showing fallback model list."
                    );
                }
            } finally {
                if (aiProviderRef.current === provider && modelRequestRef.current === requestId) {
                    setLoadingModels(false);
                }
            }
        },
        [userApiKeys]
    );

    useEffect(() => {
        void loadLiveModels(aiProvider);
    }, [aiProvider, loadLiveModels]);

    // ==================== FILE HANDLING ====================

    /** Which document type we're uploading — drives accept= and the API endpoint. */
    const [uploadKind, setUploadKind] = useState<"pdf" | "docx">("pdf");

    function fileMatchesKind(file: File, kind: "pdf" | "docx"): boolean {
        const lower = file.name.toLowerCase();
        if (kind === "pdf") return file.type === "application/pdf" || lower.endsWith(".pdf");
        return (
            lower.endsWith(".docx") ||
            file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
    }

    const handleQuestionsPdfChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        if (file && !fileMatchesKind(file, uploadKind)) {
            alert(
                uploadKind === "pdf"
                    ? "Please upload a .pdf file (switch to the Word tab for .docx)."
                    : "Please upload a .docx file (switch to the PDF tab for .pdf)."
            );
            e.target.value = "";
            return;
        }
        setQuestionsPdf(file);
        if (file && !sourceName) {
            setSourceName(file.name.replace(/\.(pdf|docx)$/i, ""));
        }
    }, [sourceName, uploadKind]);

    const handleSolutionsPdfChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        if (file && !fileMatchesKind(file, uploadKind)) {
            alert(
                uploadKind === "pdf"
                    ? "Please upload a .pdf file (switch to the Word tab for .docx)."
                    : "Please upload a .docx file (switch to the PDF tab for .pdf)."
            );
            e.target.value = "";
            return;
        }
        setSolutionsPdf(file);
    }, [uploadKind]);

    // ==================== EXTRACTION ====================

    const fileToBase64 = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                // Remove the data:...;base64, prefix
                const base64 = result.split(",")[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

    const handleExtract = useCallback(async () => {
        if (!questionsPdf) return;

        setExtracting(true);
        setExtractionError(null);
        setExtractedQuestions([]);
        setWarnings([]);
        setSaveResult(null);

        try {
            const questionsPdfBase64 = await fileToBase64(questionsPdf);
            let solutionsPdfBase64: string | undefined;
            if (uploadMode === "dual" && solutionsPdf) {
                solutionsPdfBase64 = await fileToBase64(solutionsPdf);
            }

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1") && apiKey.trim()) {
                headers["x-dev-api-key"] = apiKey.trim();
            }

            const response = await fetch("/api/upload/extract", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    questionsPdfBase64,
                    solutionsPdfBase64,
                    mode: uploadMode,
                    provider: aiProvider,
                    modelId,
                    apiKey: apiKey.trim() || undefined,
                    sourceName: sourceName || questionsPdf.name.replace(/\.pdf$/i, ""),
                }),
            });

            const result: ExtractionResponse = await response.json();

            if (!result.success) {
                setExtractionError(result.error || "Extraction failed");
                return;
            }

            setExtractedQuestions(result.questions);
            setWarnings(result.warnings);
            setPdfType(result.pdfType);
            // Select all by default
            setSelectedQuestions(new Set(result.questions.map((_, i) => i)));
            // Expand first question
            if (result.questions.length > 0) {
                setExpandedCards(new Set([0]));
            }
        } catch (err) {
            setExtractionError(`Extraction error: ${String(err)}`);
        } finally {
            setExtracting(false);
        }
    }, [questionsPdf, solutionsPdf, apiKey, aiProvider, modelId, uploadMode, sourceName]);

    // ==================== QUEUE EXTRACTION IN BACKGROUND ====================
    //
    // Default upload flow: enqueue extraction into the dedicated extraction queue
    // so the user can navigate away while it runs. The server persists the
    // result into pdf_extraction_reports — surfaced under /upload/reports.

    const handleQueueExtraction = useCallback(async () => {
        if (!questionsPdf) return;

        try {
            const questionsBase64 = await fileToBase64(questionsPdf);
            let solutionsBase64: string | undefined;
            if (uploadMode === "dual" && solutionsPdf) {
                solutionsBase64 = await fileToBase64(solutionsPdf);
            }

            const resolvedSourceName =
                sourceName || questionsPdf.name.replace(/\.(pdf|docx)$/i, "");

            const requestBody: ExtractionRequest = uploadKind === "pdf"
                ? {
                      kind: "pdf",
                      questionsPdfBase64: questionsBase64,
                      solutionsPdfBase64: solutionsBase64,
                      mode: uploadMode,
                      provider: aiProvider,
                      modelId,
                      apiKey: apiKey.trim() || undefined,
                      sourceName: resolvedSourceName,
                      questionsPdfName: questionsPdf.name,
                      solutionsPdfName: solutionsPdf?.name,
                  }
                : {
                      kind: "docx",
                      questionsDocxBase64: questionsBase64,
                      solutionsDocxBase64: solutionsBase64,
                      mode: uploadMode,
                      provider: aiProvider,
                      modelId,
                      apiKey: apiKey.trim() || undefined,
                      sourceName: resolvedSourceName,
                      questionsPdfName: questionsPdf.name,
                      solutionsPdfName: solutionsPdf?.name,
                  };

            enqueueExtraction({
                kind: uploadKind,
                sourceName: resolvedSourceName,
                questionsPdfName: questionsPdf.name,
                solutionsPdfName: solutionsPdf?.name,
                mode: uploadMode,
                provider: aiProvider,
                modelId,
                requestBody,
            });

            setExtractionError(null);
            setQuestionsPdf(null);
            setSolutionsPdf(null);
            if (questionsFileRef.current) questionsFileRef.current.value = "";
            if (solutionsFileRef.current) solutionsFileRef.current.value = "";
        } catch (err) {
            setExtractionError(`Queue error: ${String(err)}`);
        }
    }, [questionsPdf, solutionsPdf, apiKey, aiProvider, modelId, uploadMode, sourceName, uploadKind, enqueueExtraction]);

    // Keep the unused enqueueJob reference around so the old AI queue still
    // works for translate / verify / qc tasks elsewhere in the app.
    void enqueueJob;

    // ==================== QUESTION EDITING ====================

    const updateQuestion = useCallback((index: number, updates: Partial<ExtractedQuestion>) => {
        setExtractedQuestions((prev) => {
            const copy = [...prev];
            copy[index] = { ...copy[index], ...updates };
            return copy;
        });
    }, []);

    const getEditorOptions = useCallback((question: ExtractedQuestion | null): QuestionEditorOptionDraft[] => {
        if (!question) return [];
        return (question.options || []).map((option) => ({
            text: String(option?.text || ""),
            isCorrect: option?.isCorrect === true,
        }));
    }, []);

    const handleSaveExtractedQuestionEdit = useCallback(
        async (draft: QuestionEditorDraft) => {
            if (editingQuestionIndex === null) return;
            const metadata = draft.metadata;
            const resolvedQuestionType =
                metadata?.questionType || extractedQuestions[editingQuestionIndex]?.questionType || "";
            const numericType = isNumericalQuestionType(resolvedQuestionType);
            const selectedAnswers = draft.options
                .map((option, index) => (option.isCorrect ? index + 1 : null))
                .filter((value): value is number => value !== null);
            const numericParsed = Number((draft.answerKeyText || "").trim());
            const numericAnswerKey =
                numericType && (draft.answerKeyText || "").trim().length > 0 && Number.isFinite(numericParsed)
                    ? numericParsed
                    : extractedQuestions[editingQuestionIndex]?.answerKey ?? null;

            updateQuestion(editingQuestionIndex, {
                questionText: draft.questionText,
                solutionText: draft.solutionText,
                options: numericType
                    ? []
                    : draft.options.map((option) => ({
                          text: option.text,
                          isCorrect: option.isCorrect,
                      })),
                answerKey:
                    numericType
                        ? numericAnswerKey
                        : selectedAnswers.length === 0
                            ? null
                            : selectedAnswers.length === 1
                                ? selectedAnswers[0]
                                : selectedAnswers,
                subject: metadata ? metadata.subject : extractedQuestions[editingQuestionIndex]?.subject || "",
                chapter: metadata ? metadata.chapter : extractedQuestions[editingQuestionIndex]?.chapter || "",
                topic: metadata ? metadata.topic : extractedQuestions[editingQuestionIndex]?.topic || "",
                subtopic: metadata ? metadata.subtopic : extractedQuestions[editingQuestionIndex]?.subtopic || "",
                questionType: resolvedQuestionType,
                difficultyLevel:
                    metadata
                        ? metadata.difficultyLevel
                        : extractedQuestions[editingQuestionIndex]?.difficultyLevel || "",
                classLevel:
                    metadata
                        ? metadata.classLevel
                        : extractedQuestions[editingQuestionIndex]?.classLevel || "",
                exam: metadata ? metadata.exams : extractedQuestions[editingQuestionIndex]?.exam || [],
            });
            if (metadata && metadata.source.trim()) {
                setSourceName(metadata.source.trim());
            }
            setEditingQuestionIndex(null);
        },
        [editingQuestionIndex, extractedQuestions, updateQuestion]
    );

    const toggleCard = useCallback((index: number) => {
        setExpandedCards((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }, []);

    const toggleSelection = useCallback((index: number) => {
        setSelectedQuestions((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelectedQuestions(new Set(extractedQuestions.map((_, i) => i)));
    }, [extractedQuestions]);

    const deselectAll = useCallback(() => {
        setSelectedQuestions(new Set());
    }, []);

    // ==================== SAVE ====================

    const handleSave = useCallback(async () => {
        const questionsToSave = extractedQuestions.filter((_, i) => selectedQuestions.has(i));
        if (questionsToSave.length === 0) return;

        setSaving(true);
        setSaveResult(null);

        try {
            const response = await fetch("/api/upload/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    questions: questionsToSave,
                    sourceName: sourceName || "Uploaded PDF",
                }),
            });

            const result: SaveQuestionsResponse = await response.json();
            setSaveResult(result);
        } catch (err) {
            setSaveResult({
                success: false,
                savedCount: 0,
                questionIds: [],
                errors: [{ questionNumber: 0, error: String(err) }],
            });
        } finally {
            setSaving(false);
        }
    }, [extractedQuestions, selectedQuestions, sourceName]);

    // ==================== RENDER ====================

    const hasExtractedQuestions = extractedQuestions.length > 0;
    const selectedCount = selectedQuestions.size;
    const editingQuestion =
        editingQuestionIndex !== null ? extractedQuestions[editingQuestionIndex] || null : null;
    const currentProviderModels = providerModels[aiProvider] || AI_PROVIDER_MODELS[aiProvider];
    const isCurrentModelListed = currentProviderModels.some((m) => m.id === modelId);
    const hasSavedProviderKey = Boolean(getProviderApiCredential(aiProvider, userApiKeys[aiProvider] || ""));
    const hasResolvedProviderKey = hasSavedProviderKey || usingLiveModels;

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar
                activeTab="upload"
                onTabChange={(tab) => {
                    if (tab === "questions") router.push("/questions");
                    if (tab === "tests") router.push("/tests");
                    if (tab === "analytics") router.push("/analytics");
                    if (tab === "ai") router.push("/ai-tools");
                    if (tab === "admin") router.push("/admin/users");
                    if (tab === "agentic-qc") router.push("/agentic-qc");
                    if (tab === "qbg") router.push("/qbg");
                    if (tab === "video-solution") router.push("/video-solution");
                    else if (tab === "question-wise-videos") router.push("/question-wise-videos");
                    else if (tab === "circuit-designer") router.push("/circuit-designer");
                }}
            />

            <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Header */}
                <header
                    className="glass"
                    style={{
                        borderBottom: "1px solid var(--border-primary)",
                        padding: "14px 24px",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                    }}
                >
                    <div
                        style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "10px",
                            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                            color: "#fff",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        <Upload size={16} />
                    </div>
                    <div>
                        <div style={{ fontSize: "0.95rem", fontWeight: 650 }}>Upload & Extract</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                            {hasExtractedQuestions
                                ? `${extractedQuestions.length} questions extracted · ${selectedCount} selected`
                                : "Upload a PDF or Word file to extract questions using AI"}
                        </div>
                    </div>

                    {hasExtractedQuestions && (
                        <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || selectedCount === 0 || !!saveResult?.success}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    padding: "9px 14px",
                                    borderRadius: "10px",
                                    border: `1px solid ${saveResult?.success ? "rgba(34,197,94,0.5)" : "var(--accent-primary)"}`,
                                    background:
                                        saving || selectedCount === 0 || saveResult?.success
                                            ? saveResult?.success ? "rgba(34, 197, 94, 0.12)" : "var(--accent-glow)"
                                            : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                    color: saveResult?.success ? "#4ade80" : (saving || selectedCount === 0 ? "var(--accent-primary-hover)" : "#fff"),
                                    fontSize: "0.84rem",
                                    fontWeight: 700,
                                    cursor: saving || selectedCount === 0 || saveResult?.success ? "default" : "pointer",
                                    opacity: saving || selectedCount === 0 ? 0.6 : 1,
                                    transition: "all 0.2s ease",
                                }}
                            >
                                {saving ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : saveResult?.success ? (
                                    <CheckCircle2 size={14} />
                                ) : (
                                    <Save size={14} />
                                )}
                                {saving ? "Saving..." : saveResult?.success ? "Already Saved ✓" : `Save ${selectedCount} to Database`}
                            </button>
                        </div>
                    )}
                </header>

                {/* Content */}
                <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 36px" }}>
                    <div style={{ maxWidth: "900px", margin: "0 auto", display: "grid", gap: "16px" }}>
                        {/* Save result banner */}
                        {saveResult && (
                            <div
                                style={{
                                    padding: "12px 16px",
                                    borderRadius: "10px",
                                    border: `1px solid ${saveResult.success ? "var(--success-border, #22c55e33)" : "var(--warning-border)"}`,
                                    background: saveResult.success ? "rgba(34, 197, 94, 0.08)" : "var(--warning-bg)",
                                    color: saveResult.success ? "#22c55e" : "var(--warning-text)",
                                    fontSize: "0.82rem",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                    {saveResult.success ? (
                                        <CheckCircle2 size={16} />
                                    ) : (
                                        <AlertCircle size={16} />
                                    )}
                                    <div>
                                        <strong>{saveResult.savedCount}</strong> questions saved to database.
                                        {saveResult.errors.length > 0 && (
                                            <span> {saveResult.errors.length} errors occurred.</span>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => setSaveResult(null)}
                                        style={{
                                            marginLeft: "auto",
                                            background: "none",
                                            border: "none",
                                            cursor: "pointer",
                                            color: "inherit",
                                            padding: "2px",
                                        }}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                                {saveResult.errors.length > 0 && (
                                    <div style={{ marginTop: "8px", fontSize: "0.74rem", maxHeight: "120px", overflowY: "auto" }}>
                                        {saveResult.errors.slice(0, 5).map((err, i) => (
                                            <div key={i} style={{ padding: "2px 0", wordBreak: "break-word" }}>
                                                Q{err.questionNumber}: {err.error}
                                            </div>
                                        ))}
                                        {saveResult.errors.length > 5 && (
                                            <div style={{ opacity: 0.7 }}>...and {saveResult.errors.length - 5} more</div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Upload Configuration Section */}
                        {!hasExtractedQuestions && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "20px",
                                }}
                            >
                                {/* File-type tabs: PDF | Word */}
                                <div
                                    style={{
                                        display: "inline-flex",
                                        gap: "4px",
                                        padding: "4px",
                                        borderRadius: "10px",
                                        background: "var(--bg-tertiary)",
                                        border: "1px solid var(--border-primary)",
                                        width: "fit-content",
                                    }}
                                >
                                    {(["pdf", "docx"] as const).map((kind) => {
                                        const active = uploadKind === kind;
                                        return (
                                            <button
                                                key={kind}
                                                type="button"
                                                onClick={() => {
                                                    if (active) return;
                                                    setUploadKind(kind);
                                                    setQuestionsPdf(null);
                                                    setSolutionsPdf(null);
                                                    if (questionsFileRef.current) questionsFileRef.current.value = "";
                                                    if (solutionsFileRef.current) solutionsFileRef.current.value = "";
                                                }}
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "6px",
                                                    padding: "6px 14px",
                                                    borderRadius: "7px",
                                                    border: "none",
                                                    background: active ? "var(--accent-primary, #818cf8)" : "transparent",
                                                    color: active ? "#fff" : "var(--text-secondary)",
                                                    fontSize: "0.8rem",
                                                    fontWeight: 700,
                                                    cursor: "pointer",
                                                }}
                                            >
                                                {kind === "pdf" ? "PDF" : "Word (.docx)"}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Upload Mode */}
                                <div style={{ display: "grid", gap: "8px" }}>
                                    <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Upload Mode
                                    </label>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                        {(["single", "dual"] as UploadMode[]).map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => setUploadMode(mode)}
                                                style={{
                                                    flex: 1,
                                                    padding: "10px 14px",
                                                    borderRadius: "10px",
                                                    border: `1px solid ${uploadMode === mode ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: uploadMode === mode ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                    color: uploadMode === mode ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                    fontSize: "0.82rem",
                                                    fontWeight: uploadMode === mode ? 700 : 500,
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                }}
                                            >
                                                {mode === "single"
                                                    ? `📄 Single ${uploadKind === "pdf" ? "PDF" : "Word file"} (Question + Solution)`
                                                    : `📄📄 Two ${uploadKind === "pdf" ? "PDFs" : "Word files"} (Question and Solution separate)`}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* AI Provider Selector */}
                                <div style={{ display: "grid", gap: "8px" }}>
                                    <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        AI Provider
                                    </label>
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                        {(Object.keys(AI_PROVIDER_LABELS) as AIModelProvider[]).map((provider) => (
                                            <button
                                                key={provider}
                                                type="button"
                                                onClick={() => {
                                                    setAiProvider(provider);
                                                    const defaultModel =
                                                        providerModels[provider]?.[0]?.id ||
                                                        AI_PROVIDER_MODELS[provider][0]?.id ||
                                                        "";
                                                    setModelId(defaultModel);
                                                }}
                                                style={{
                                                    padding: "7px 14px",
                                                    borderRadius: "8px",
                                                    border: `1px solid ${aiProvider === provider ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: aiProvider === provider ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                    color: aiProvider === provider ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                    fontSize: "0.8rem",
                                                    fontWeight: aiProvider === provider ? 700 : 500,
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                }}
                                            >
                                                {AI_PROVIDER_LABELS[provider]}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Model Selector */}
                                <div style={{ display: "grid", gap: "8px" }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                        <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                            Model
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => void loadLiveModels(aiProvider)}
                                            disabled={loadingModels}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                padding: "6px 10px",
                                                fontSize: "0.74rem",
                                                fontWeight: 650,
                                                cursor: loadingModels ? "default" : "pointer",
                                                opacity: loadingModels ? 0.7 : 1,
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                            }}
                                        >
                                            <RefreshCw size={12} className={loadingModels ? "animate-spin" : ""} />
                                            Refresh Live Models
                                        </button>
                                    </div>
                                    <div style={{ display: "grid", gap: "8px" }}>
                                        <select
                                            value={isCurrentModelListed ? modelId : "__custom__"}
                                            onChange={(e) => {
                                                if (e.target.value !== "__custom__") setModelId(e.target.value);
                                            }}
                                            style={{
                                                padding: "8px 12px",
                                                borderRadius: "8px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.82rem",
                                                outline: "none",
                                            }}
                                        >
                                            {currentProviderModels.map((m) => (
                                                <option key={m.id} value={m.id}>{m.label}</option>
                                            ))}
                                            <option value="__custom__">Custom model ID...</option>
                                        </select>
                                        {/* Custom model ID input */}
                                        {!isCurrentModelListed && (
                                            <input
                                                type="text"
                                                value={modelId}
                                                onChange={(e) => setModelId(e.target.value)}
                                                placeholder="Enter custom model ID"
                                                style={{
                                                    padding: "7px 12px",
                                                    borderRadius: "8px",
                                                    border: "1px solid var(--accent-primary)",
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.8rem",
                                                    outline: "none",
                                                }}
                                            />
                                        )}
                                    </div>
                                    <div
                                        style={{
                                            border: `1px solid ${hasResolvedProviderKey ? "rgba(34,197,94,0.35)" : "rgba(234,179,8,0.35)"}`,
                                            background: hasResolvedProviderKey ? "rgba(34,197,94,0.08)" : "rgba(234,179,8,0.08)",
                                            color: hasResolvedProviderKey ? "#22c55e" : "#eab308",
                                            borderRadius: "8px",
                                            padding: "8px 10px",
                                            fontSize: "0.75rem",
                                        }}
                                    >
                                        {hasResolvedProviderKey
                                            ? `Using saved ${AI_PROVIDER_LABELS[aiProvider]} API key from account settings.`
                                            : `No saved ${AI_PROVIDER_LABELS[aiProvider]} API key found. Add it from the user icon.`}
                                    </div>
                                    <div
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-tertiary)",
                                            padding: "8px 10px",
                                            fontSize: "0.74rem",
                                        }}
                                    >
                                        {loadingModels
                                            ? `Loading live models from ${AI_PROVIDER_LABELS[aiProvider]}...`
                                            : usingLiveModels
                                                ? "Showing live provider model list."
                                                : "Showing fallback model list."}
                                        {modelLoadError && <span> {modelLoadError}</span>}
                                    </div>
                                </div>

                                {/* Source Name */}
                                <div style={{ display: "grid", gap: "8px" }}>
                                    <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Source Name <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>(defaults to PDF filename)</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={sourceName}
                                        onChange={(e) => setSourceName(e.target.value)}
                                        placeholder="e.g. JEE_Mains_2025_Physics"
                                        style={{
                                            padding: "8px 12px",
                                            borderRadius: "8px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.82rem",
                                            outline: "none",
                                        }}
                                    />
                                </div>

                                {/* File Upload Areas */}
                                <div style={{ display: "grid", gridTemplateColumns: uploadMode === "dual" ? "1fr 1fr" : "1fr", gap: "16px" }}>
                                    {/* Questions PDF */}
                                    <div
                                        onClick={() => questionsFileRef.current?.click()}
                                        style={{
                                            border: `2px dashed ${questionsPdf ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                            borderRadius: "12px",
                                            padding: "32px 20px",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "10px",
                                            cursor: "pointer",
                                            background: questionsPdf ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                            transition: "all 0.2s ease",
                                        }}
                                    >
                                        <FileUp size={28} color={questionsPdf ? "var(--accent-primary)" : "var(--text-tertiary)"} />
                                        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)", textAlign: "center" }}>
                                            {questionsPdf ? questionsPdf.name : `Click to upload Questions ${uploadKind === "pdf" ? "PDF" : "Word file"}`}
                                        </div>
                                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            {questionsPdf
                                                ? `${(questionsPdf.size / 1024 / 1024).toFixed(2)} MB`
                                                : uploadKind === "pdf"
                                                ? "PDF files up to 20 MB"
                                                : "Word (.docx) files up to 20 MB"}
                                        </div>
                                        <input
                                            ref={questionsFileRef}
                                            type="file"
                                            accept={uploadKind === "pdf"
                                                ? ".pdf"
                                                : ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
                                            onChange={handleQuestionsPdfChange}
                                            style={{ display: "none" }}
                                        />
                                    </div>

                                    {/* Solutions PDF (dual mode only) */}
                                    {uploadMode === "dual" && (
                                        <div
                                            onClick={() => solutionsFileRef.current?.click()}
                                            style={{
                                                border: `2px dashed ${solutionsPdf ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                borderRadius: "12px",
                                                padding: "32px 20px",
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                gap: "10px",
                                                cursor: "pointer",
                                                background: solutionsPdf ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                transition: "all 0.2s ease",
                                            }}
                                        >
                                            <FileUp size={28} color={solutionsPdf ? "var(--accent-primary)" : "var(--text-tertiary)"} />
                                            <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)", textAlign: "center" }}>
                                                {solutionsPdf ? solutionsPdf.name : `Click to upload Solutions ${uploadKind === "pdf" ? "PDF" : "Word file"}`}
                                            </div>
                                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                {solutionsPdf
                                                    ? `${(solutionsPdf.size / 1024 / 1024).toFixed(2)} MB`
                                                    : uploadKind === "pdf"
                                                    ? "PDF files up to 20 MB"
                                                    : "Word (.docx) files up to 20 MB"}
                                            </div>
                                            <input
                                                ref={solutionsFileRef}
                                                type="file"
                                                accept={uploadKind === "pdf"
                                                    ? ".pdf"
                                                    : ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
                                                onChange={handleSolutionsPdfChange}
                                                style={{ display: "none" }}
                                            />
                                        </div>
                                    )}
                                </div>

                                {/* Extract Button */}
                                {/* Default: enqueue into background queue so the user can navigate away. */}
                                <button
                                    type="button"
                                    onClick={handleQueueExtraction}
                                    disabled={!questionsPdf || !modelId.trim()}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "none",
                                        background:
                                            !questionsPdf || !modelId.trim()
                                                ? "var(--bg-tertiary)"
                                                : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                                        color:
                                            !questionsPdf || !modelId.trim()
                                                ? "var(--text-tertiary)"
                                                : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor:
                                            !questionsPdf || !modelId.trim() ? "default" : "pointer",
                                        transition: "all 0.2s ease",
                                        boxShadow:
                                            questionsPdf && modelId.trim()
                                                ? "0 4px 14px rgba(99, 102, 241, 0.35)"
                                                : "none",
                                    }}
                                >
                                    <Sparkles size={16} />
                                    Queue Extraction
                                </button>

                                {/* Fallback: legacy inline extract (PDF-only). */}
                                {uploadKind === "pdf" && <button
                                    type="button"
                                    onClick={handleExtract}
                                    disabled={extracting || !questionsPdf || !modelId.trim()}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-tertiary)",
                                        color: extracting || !questionsPdf || !modelId.trim() ? "var(--text-muted)" : "var(--text-secondary)",
                                        fontSize: "0.82rem",
                                        fontWeight: 600,
                                        cursor: extracting || !questionsPdf || !modelId.trim() ? "default" : "pointer",
                                        opacity: extracting || !questionsPdf || !modelId.trim() ? 0.5 : 1,
                                        transition: "all 0.2s ease",
                                    }}
                                    title="Extract now and show results on this page (slower; tab must stay open)."
                                >
                                    {extracting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                    {extracting ? "Extracting…" : "Extract Inline"}
                                </button>}

                                <Link
                                    href="/upload/reports"
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "12px 16px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary, #818cf8)",
                                        background: "transparent",
                                        color: "var(--accent-primary, #818cf8)",
                                        fontSize: "0.82rem",
                                        fontWeight: 700,
                                        textDecoration: "none",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    <FileText size={14} />
                                    Extraction reports
                                    {extractionJobs.length > 0 && (
                                        <span
                                            style={{
                                                marginLeft: "4px",
                                                padding: "1px 6px",
                                                borderRadius: "999px",
                                                background: "var(--accent-primary, #818cf8)",
                                                color: "#fff",
                                                fontSize: "0.66rem",
                                            }}
                                        >
                                            {extractionJobs.length}
                                        </span>
                                    )}
                                </Link>

                                {/* Error */}
                                {extractionError && (
                                    <div
                                        style={{
                                            padding: "10px 14px",
                                            borderRadius: "8px",
                                            border: "1px solid var(--warning-border)",
                                            background: "var(--warning-bg)",
                                            color: "var(--warning-text)",
                                            fontSize: "0.8rem",
                                            display: "flex",
                                            alignItems: "flex-start",
                                            gap: "8px",
                                        }}
                                    >
                                        <AlertCircle size={14} style={{ marginTop: "2px", flexShrink: 0 }} />
                                        <div style={{ wordBreak: "break-word" }}>{extractionError}</div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Warnings */}
                        {warnings.length > 0 && (
                            <div
                                style={{
                                    padding: "10px 14px",
                                    borderRadius: "8px",
                                    border: "1px solid rgba(234, 179, 8, 0.25)",
                                    background: "rgba(234, 179, 8, 0.06)",
                                    color: "#eab308",
                                    fontSize: "0.78rem",
                                    display: "grid",
                                    gap: "4px",
                                }}
                            >
                                <strong>Warnings:</strong>
                                {warnings.map((w, i) => (
                                    <div key={i}>• {w}</div>
                                ))}
                            </div>
                        )}

                        {/* Extraction stats */}
                        {hasExtractedQuestions && (
                            <div
                                style={{
                                    display: "flex",
                                    gap: "8px",
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                }}
                            >
                                <Badge color={{ bg: "rgba(99,102,241,0.12)", text: "#818cf8", border: "rgba(99,102,241,0.25)" }}>
                                    {pdfType === "questions_and_solutions" ? "Q + Solutions" : "Questions Only"}
                                </Badge>
                                <Badge color={{ bg: "rgba(34,197,94,0.12)", text: "#4ade80", border: "rgba(34,197,94,0.25)" }}>
                                    {extractedQuestions.length} Questions
                                </Badge>

                                <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
                                    <button
                                        type="button"
                                        onClick={selectAll}
                                        style={{
                                            padding: "5px 10px",
                                            borderRadius: "6px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            fontSize: "0.74rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        Select All
                                    </button>
                                    <button
                                        type="button"
                                        onClick={deselectAll}
                                        style={{
                                            padding: "5px 10px",
                                            borderRadius: "6px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            fontSize: "0.74rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        Deselect All
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setExtractedQuestions([]);
                                            setSelectedQuestions(new Set());
                                            setSaveResult(null);
                                        }}
                                        style={{
                                            padding: "5px 10px",
                                            borderRadius: "6px",
                                            border: "1px solid rgba(239,68,68,0.3)",
                                            background: "rgba(239,68,68,0.06)",
                                            color: "#f87171",
                                            fontSize: "0.74rem",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Trash2 size={12} style={{ marginRight: "4px", verticalAlign: "middle" }} />
                                        Clear All
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Extracted Question Cards */}
                        {extractedQuestions.map((q, index) => {
                            const isExpanded = expandedCards.has(index);
                            const isSelected = selectedQuestions.has(index);
                            const isNumericalType = isNumericalQuestionType(q.questionType);
                            const subjectColor = SUBJECT_COLORS[q.subject as keyof typeof SUBJECT_COLORS] || DEFAULT_BADGE_COLOR;
                            const difficultyColor = DIFFICULTY_COLORS[q.difficultyLevel as keyof typeof DIFFICULTY_COLORS] || DEFAULT_BADGE_COLOR;
                            const typeColor = QUESTION_TYPE_COLORS[q.questionType as keyof typeof QUESTION_TYPE_COLORS] || DEFAULT_BADGE_COLOR;

                            return (
                                <div
                                    key={index}
                                    style={{
                                        border: `1px solid ${isSelected ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                        borderRadius: "10px",
                                        background: "var(--bg-secondary)",
                                        overflow: "hidden",
                                        transition: "border-color 0.15s ease",
                                    }}
                                >
                                    {/* Card Header */}
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "10px",
                                            padding: "10px 14px",
                                            cursor: "pointer",
                                            background: isSelected ? "var(--accent-glow)" : "transparent",
                                        }}
                                        onClick={() => toggleCard(index)}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={(e) => {
                                                e.stopPropagation();
                                                toggleSelection(index);
                                            }}
                                            style={{ accentColor: "var(--accent-primary)", cursor: "pointer" }}
                                        />
                                        <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                            Q{q.questionNumber}
                                        </span>
                                        <Badge color={subjectColor}>{q.subject || "—"}</Badge>
                                        <Badge color={typeColor}>
                                            {QUESTION_TYPE_LABELS[q.questionType] || q.questionType || "—"}
                                        </Badge>
                                        <Badge color={difficultyColor}>{q.difficultyLevel || "—"}</Badge>
                                        {q.confidence < 0.7 && (
                                            <Badge color={{ bg: "rgba(239,68,68,0.12)", text: "#f87171", border: "rgba(239,68,68,0.25)" }}>
                                                Low confidence
                                            </Badge>
                                        )}
                                        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setEditingQuestionIndex(index);
                                                }}
                                                title="Edit question"
                                                style={{
                                                    width: "24px",
                                                    height: "24px",
                                                    borderRadius: "6px",
                                                    border: "1px solid var(--border-primary)",
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-secondary)",
                                                    cursor: "pointer",
                                                    display: "grid",
                                                    placeItems: "center",
                                                }}
                                            >
                                                <Pencil size={12} />
                                            </button>
                                            {isExpanded ? <ChevronUp size={16} color="var(--text-tertiary)" /> : <ChevronDown size={16} color="var(--text-tertiary)" />}
                                        </div>
                                    </div>

                                    {/* Question Preview (collapsed) */}
                                    {!isExpanded && (
                                        <div style={{ padding: "0 14px 10px", fontSize: "0.8rem", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                            <MathContent
                                                html={q.questionText.slice(0, 200) + (q.questionText.length > 200 ? "..." : "")}
                                                className="question-html"
                                                style={{ fontSize: "0.8rem" }}
                                            />
                                        </div>
                                    )}

                                    {/* Expanded Edit Area */}
                                    {isExpanded && (
                                        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border-primary)", display: "grid", gap: "14px" }}>
                                            {/* Question Text */}
                                            <div style={{ display: "grid", gap: "6px" }}>
                                                <label style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Question Text (HTML)</label>
                                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                                    <textarea
                                                        value={q.questionText}
                                                        onChange={(e) => updateQuestion(index, { questionText: e.target.value })}
                                                        rows={5}
                                                        style={{
                                                            padding: "8px",
                                                            borderRadius: "8px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            fontFamily: "monospace",
                                                            resize: "vertical",
                                                            outline: "none",
                                                        }}
                                                    />
                                                    <div
                                                        style={{
                                                            padding: "8px",
                                                            borderRadius: "8px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            fontSize: "0.82rem",
                                                            overflow: "auto",
                                                            maxHeight: "200px",
                                                        }}
                                                    >
                                                        <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                                                            <Eye size={10} style={{ verticalAlign: "middle", marginRight: "3px" }} />
                                                            Preview
                                                        </div>
                                                        <MathContent html={q.questionText} className="question-html" style={{ fontSize: "0.82rem" }} />
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Solution Text */}
                                            {q.solutionText && (
                                                <div style={{ display: "grid", gap: "6px" }}>
                                                    <label style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Solution Text (HTML)</label>
                                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                                        <textarea
                                                            value={q.solutionText}
                                                            onChange={(e) => updateQuestion(index, { solutionText: e.target.value })}
                                                            rows={4}
                                                            style={{
                                                                padding: "8px",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.78rem",
                                                                fontFamily: "monospace",
                                                                resize: "vertical",
                                                                outline: "none",
                                                            }}
                                                        />
                                                        <div
                                                            style={{
                                                                padding: "8px",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                fontSize: "0.82rem",
                                                                overflow: "auto",
                                                                maxHeight: "200px",
                                                            }}
                                                        >
                                                            <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                                                                <Eye size={10} style={{ verticalAlign: "middle", marginRight: "3px" }} />
                                                                Preview
                                                            </div>
                                                            <MathContent html={q.solutionText} className="question-html" style={{ fontSize: "0.82rem" }} />
                                                        </div>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Metadata Grid */}
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                                                {/* Subject */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Subject</label>
                                                    <select
                                                        value={q.subject}
                                                        onChange={(e) => updateQuestion(index, { subject: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    >
                                                        <option value="">Select...</option>
                                                        {KNOWN_SUBJECTS.map((s) => (
                                                            <option key={s} value={s}>{s}</option>
                                                        ))}
                                                        {!KNOWN_SUBJECTS.includes(q.subject as typeof KNOWN_SUBJECTS[number]) && q.subject && (
                                                            <option value={q.subject}>{q.subject}</option>
                                                        )}
                                                    </select>
                                                </div>

                                                {/* Question Type */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Question Type</label>
                                                    <select
                                                        value={q.questionType}
                                                        onChange={(e) => updateQuestion(index, { questionType: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    >
                                                        {KNOWN_QUESTION_TYPES.map((t) => (
                                                            <option key={t} value={t}>
                                                                {QUESTION_TYPE_LABELS[t] || t}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>

                                                {/* Difficulty */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Difficulty</label>
                                                    <select
                                                        value={q.difficultyLevel}
                                                        onChange={(e) => updateQuestion(index, { difficultyLevel: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    >
                                                        {KNOWN_DIFFICULTIES.map((d) => (
                                                            <option key={d} value={d}>{d}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                {/* Class Level */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Class</label>
                                                    <select
                                                        value={q.classLevel}
                                                        onChange={(e) => updateQuestion(index, { classLevel: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    >
                                                        <option value="">Select...</option>
                                                        <option value="11">Class 11</option>
                                                        <option value="12">Class 12</option>
                                                    </select>
                                                </div>

                                                {/* Chapter */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Chapter</label>
                                                    <input
                                                        type="text"
                                                        value={q.chapter}
                                                        onChange={(e) => updateQuestion(index, { chapter: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    />
                                                </div>

                                                {/* Topic */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Topic</label>
                                                    <input
                                                        type="text"
                                                        value={q.topic}
                                                        onChange={(e) => updateQuestion(index, { topic: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    />
                                                </div>

                                                {/* Source */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Source</label>
                                                    <input
                                                        type="text"
                                                        value={sourceName}
                                                        onChange={(e) => setSourceName(e.target.value)}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    />
                                                </div>

                                                {/* Language */}
                                                <div style={{ display: "grid", gap: "4px" }}>
                                                    <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Language</label>
                                                    <select
                                                        value={q.questionLanguage}
                                                        onChange={(e) => updateQuestion(index, { questionLanguage: e.target.value })}
                                                        style={{
                                                            padding: "6px 8px",
                                                            borderRadius: "6px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.78rem",
                                                            outline: "none",
                                                        }}
                                                    >
                                                        <option value="English">English</option>
                                                        <option value="Hindi">Hindi</option>
                                                        <option value="Bilingual">Bilingual</option>
                                                    </select>
                                                </div>
                                            </div>

                                            {/* Options */}
                                            {!isNumericalType && q.options.length > 0 && (
                                                <div style={{ display: "grid", gap: "6px" }}>
                                                    <label style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Options</label>
                                                    {q.options.map((opt, oi) => (
                                                        <div key={oi} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                                            <span style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--text-tertiary)", width: "20px" }}>
                                                                {String.fromCharCode(65 + oi)}.
                                                            </span>
                                                            <input
                                                                type="text"
                                                                value={opt.text}
                                                                onChange={(e) => {
                                                                    const newOptions = [...q.options];
                                                                    newOptions[oi] = { ...newOptions[oi], text: e.target.value };
                                                                    updateQuestion(index, { options: newOptions });
                                                                }}
                                                                style={{
                                                                    flex: 1,
                                                                    padding: "5px 8px",
                                                                    borderRadius: "6px",
                                                                    border: `1px solid ${opt.isCorrect ? "rgba(34,197,94,0.4)" : "var(--border-primary)"}`,
                                                                    background: opt.isCorrect ? "rgba(34,197,94,0.06)" : "var(--bg-tertiary)",
                                                                    color: "var(--text-primary)",
                                                                    fontSize: "0.78rem",
                                                                    outline: "none",
                                                                }}
                                                            />
                                                            <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={opt.isCorrect === true}
                                                                    onChange={(e) => {
                                                                        const newOptions = [...q.options];
                                                                        newOptions[oi] = { ...newOptions[oi], isCorrect: e.target.checked };
                                                                        updateQuestion(index, { options: newOptions });
                                                                    }}
                                                                    style={{ accentColor: "#22c55e" }}
                                                                />
                                                                Correct
                                                            </label>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {isNumericalType && (
                                                <div
                                                    style={{
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "6px",
                                                        padding: "6px 9px",
                                                        borderRadius: "7px",
                                                        border: "1px solid rgba(34,197,94,0.35)",
                                                        background: "rgba(34,197,94,0.1)",
                                                        color: "#4ade80",
                                                        fontSize: "0.75rem",
                                                        width: "fit-content",
                                                    }}
                                                >
                                                    <strong>Answer Key:</strong>{" "}
                                                    {Array.isArray(q.answerKey)
                                                        ? q.answerKey.join(", ")
                                                        : q.answerKey === null || q.answerKey === undefined
                                                            ? "-"
                                                            : String(q.answerKey)}
                                                </div>
                                            )}

                                            {/* AI Notes */}
                                            {q.aiNotes && (
                                                <div style={{
                                                    padding: "8px 10px",
                                                    borderRadius: "6px",
                                                    background: "rgba(99,102,241,0.06)",
                                                    border: "1px solid rgba(99,102,241,0.15)",
                                                    fontSize: "0.74rem",
                                                    color: "var(--text-tertiary)",
                                                }}>
                                                    <strong>AI Notes:</strong> {q.aiNotes}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </main>

            <QuestionEditModal
                open={Boolean(editingQuestion)}
                title={
                    editingQuestion
                        ? `Edit Extracted Question ${editingQuestion.questionNumber}`
                        : "Edit Extracted Question"
                }
                initialQuestionText={editingQuestion?.questionText || ""}
                initialSolutionText={editingQuestion?.solutionText || ""}
                initialOptions={getEditorOptions(editingQuestion)}
                initialAnswerKeyText={
                    editingQuestion ? answerKeyToText(editingQuestion.answerKey) : ""
                }
                initialMetadata={
                    editingQuestion
                        ? ({
                              subject: editingQuestion.subject || "",
                              chapter: editingQuestion.chapter || "",
                              topic: editingQuestion.topic || "",
                              subtopic: editingQuestion.subtopic || "",
                              source: sourceName || "",
                              questionType: editingQuestion.questionType || "",
                              difficultyLevel: editingQuestion.difficultyLevel || "",
                              classLevel: editingQuestion.classLevel || "",
                              exams: editingQuestion.exam || [],
                          } satisfies QuestionEditorMetadataDraft)
                        : undefined
                }
                onCancel={() => setEditingQuestionIndex(null)}
                onSave={handleSaveExtractedQuestionEdit}
            />
        </div>
    );
}

function isNumericalQuestionType(questionType: string): boolean {
    const normalized = String(questionType || "")
        .trim()
        .toLowerCase()
        .replace(/[\s()-]+/g, "_");
    return (
        normalized === "integer" ||
        normalized === "numerical" ||
        normalized === "single_digit_integer" ||
        normalized === "passage_numerical" ||
        normalized.includes("single_digit_integer") ||
        normalized.includes("passage_numerical")
    );
}

function answerKeyToText(answerKey: ExtractedQuestion["answerKey"]): string {
    if (Array.isArray(answerKey)) return answerKey.join(", ");
    return answerKey === null || answerKey === undefined ? "" : String(answerKey);
}
