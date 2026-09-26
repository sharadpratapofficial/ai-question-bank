"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2, Bot, Globe, CheckCircle2, XCircle, ChevronDown, ChevronUp, RefreshCw, Star, History as HistoryIcon, Pencil, Workflow } from "lucide-react";
import RichHtmlEditor from "@/components/ui/RichHtmlEditor";
import MathContent from "@/components/ui/MathContent";
import QuestionStatusPill from "@/components/questions/QuestionStatusPill";
import QuestionStatusPanel from "@/components/questions/QuestionStatusPanel";
import QuestionHistoryPanel from "@/components/questions/QuestionHistoryPanel";
import type {
    AiMetadata,
    AiTranslationEntry,
    AiVerificationEntry,
    MetadataHierarchy,
    QuestionStatus,
    QuestionTranslation,
} from "@/types";
import {
    fetchTranslationsForQuestion,
    setTranslationAsDefault,
    deleteTranslation,
} from "@/lib/api/translations";
import { useQuestionTaskQueue } from "@/context/QuestionTaskQueueContext";
import { AI_PROVIDER_MODELS, type ModelOption } from "@/types/extraction";
import {
    API_KEY_PROVIDER_LABELS,
    CHAT_API_PROVIDERS,
    EMPTY_USER_API_KEYS,
    readDevApiKeysFromStorage,
    type ChatApiProvider,
    type SupportedApiProvider,
    type UserApiKeys,
} from "@/lib/userApiKeys";

export type { AiMetadata, AiTranslationEntry, AiVerificationEntry } from "@/types";

const DEFAULT_PROVIDER_MODELS: Record<ChatApiProvider, ModelOption[]> = {
    gemini: AI_PROVIDER_MODELS.gemini,
    openai: AI_PROVIDER_MODELS.openai,
    openrouter: AI_PROVIDER_MODELS.openrouter,
    groq: AI_PROVIDER_MODELS.groq,
    grok: AI_PROVIDER_MODELS.grok,
    anthropic: [{ id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" }],
    nvidia: AI_PROVIDER_MODELS.nvidia,
    fireworks: AI_PROVIDER_MODELS.fireworks,
    custom_openai: AI_PROVIDER_MODELS.custom_openai,
    local: AI_PROVIDER_MODELS.local,
    g4f: [
        { id: "gpt-4o", label: "GPT-4o" },
        { id: "gpt-4o-mini", label: "GPT-4o Mini" },
        { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
        { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
        { id: "llama-3.1-70b", label: "Llama 3.1 70B" },
        { id: "deepseek-r1", label: "DeepSeek R1" },
    ],
};

const TRANSLATION_LANGUAGES = [
    "Hindi", "Tamil", "Telugu", "Kannada", "Malayalam", "Marathi", "Bengali",
    "Gujarati", "Punjabi", "Odia", "Urdu", "Assamese", "Sanskrit",
    "Spanish", "French", "German", "Japanese", "Korean", "Chinese",
];

export interface QuestionEditorOptionDraft {
    text: string;
    isCorrect: boolean;
}

export interface QuestionEditorMetadataDraft {
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string;
    source: string;
    questionType: string;
    difficultyLevel: string;
    classLevel: string;
    exams: string[];
}

export interface QuestionEditorMetadataInput
    extends Partial<Omit<QuestionEditorMetadataDraft, "exams">> {
    exams?: string[] | string;
}

export interface QuestionEditorDraft {
    questionText: string;
    solutionText: string;
    options: QuestionEditorOptionDraft[];
    answerKeyText?: string;
    metadata?: QuestionEditorMetadataDraft;
}

interface QuestionEditModalProps {
    open: boolean;
    title?: string;
    initialQuestionText: string;
    initialSolutionText: string;
    initialOptions: QuestionEditorOptionDraft[];
    initialAnswerKeyText?: string;
    initialMetadata?: QuestionEditorMetadataInput;
    metadataHierarchy?: MetadataHierarchy;
    saving?: boolean;
    onSave: (draft: QuestionEditorDraft) => void | Promise<void>;
    onCancel: () => void;
    // AI features
    questionId?: string;
    rawData?: unknown;
    onAiMetadataUpdate?: (aiMeta: AiMetadata) => void | Promise<void>;
    // QC workflow — when editing an existing question, show its current status pill
    // and a deep-link to the history tab.
    status?: QuestionStatus;
}

const MIN_OPTION_COUNT = 4;
const METADATA_FIELDS: Array<{
    key: Exclude<keyof QuestionEditorMetadataDraft, "exams">;
    label: string;
    placeholder: string;
}> = [
    { key: "subject", label: "Subject", placeholder: "Physics" },
    { key: "chapter", label: "Chapter", placeholder: "Kinematics" },
    { key: "topic", label: "Topic", placeholder: "Motion in One Dimension" },
    { key: "subtopic", label: "Subtopic", placeholder: "Relative Velocity" },
    { key: "source", label: "Source", placeholder: "DPP / PYQ / Module" },
    { key: "difficultyLevel", label: "Difficulty", placeholder: "Easy / Medium / Hard" },
    { key: "classLevel", label: "Class Level", placeholder: "11 / 12" },
];

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseExams(exams: QuestionEditorMetadataInput["exams"]): string[] {
    if (Array.isArray(exams)) {
        return exams.map((exam) => String(exam).trim()).filter(Boolean);
    }
    if (typeof exams === "string") {
        return exams
            .split(",")
            .map((exam) => exam.trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeMetadata(
    metadata: QuestionEditorMetadataInput | undefined
): QuestionEditorMetadataDraft {
    return {
        subject: String(metadata?.subject || ""),
        chapter: String(metadata?.chapter || ""),
        topic: String(metadata?.topic || ""),
        subtopic: String(metadata?.subtopic || ""),
        source: String(metadata?.source || ""),
        questionType: String(metadata?.questionType || ""),
        difficultyLevel: String(metadata?.difficultyLevel || ""),
        classLevel: String(metadata?.classLevel || ""),
        exams: parseExams(metadata?.exams),
    };
}

function normalizeOptions(options: QuestionEditorOptionDraft[]): QuestionEditorOptionDraft[] {
    if (!options.length) return [];
    const base = options.map((option) => ({
        text: sanitizeOptionHtml(option.text ?? ""),
        isCorrect: !!option.isCorrect,
    }));
    while (base.length < MIN_OPTION_COUNT) {
        base.push({ text: "", isCorrect: false });
    }
    return base;
}

function estimateEditorHeight(
    html: string,
    config: { min: number; max: number; charsPerLine: number; base: number; lineHeight: number }
): number {
    const plain = String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const lineBreakHints = (String(html || "").match(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi) || [])
        .length;
    const textLines = plain.length > 0 ? Math.ceil(plain.length / config.charsPerLine) : 1;
    const estimated =
        config.base + (textLines + lineBreakHints) * config.lineHeight;
    return Math.max(config.min, Math.min(config.max, estimated));
}

function optionLabel(index: number): string {
    return String.fromCharCode(65 + index);
}

function isNumericalQuestionType(questionType: string): boolean {
    const normalized = String(questionType || "")
        .toLowerCase()
        .replace(/\s+/g, "_");
    return (
        normalized === "integer" ||
        normalized === "numerical" ||
        normalized === "single_digit_integer" ||
        normalized === "passage_numerical" ||
        normalized.includes("single_digit_integer") ||
        normalized.includes("passage_numerical")
    );
}

function hasLatexLikeContent(html: string): boolean {
    const text = String(html || "");
    return /\\\(|\\\[|\$\$|\\[a-zA-Z]+/.test(text);
}

function sanitizeOptionHtml(html: string): string {
    let cleaned = String(html || "").replace(/\u200B/g, "").trim();
    if (!cleaned) return "";

    const emptyBlock = "(?:\\s|&nbsp;|&#160;|<br\\s*\\/?>)*";

    let previous = "";
    while (cleaned !== previous) {
        previous = cleaned;
        cleaned = cleaned
            .replace(new RegExp(`^\\s*<(p|div)[^>]*>${emptyBlock}<\\/\\1>`, "i"), "")
            .replace(new RegExp(`<(p|div)[^>]*>${emptyBlock}<\\/\\1>\\s*$`, "i"), "")
            .trim();
    }

    if (/^(?:\s|&nbsp;|&#160;|<br\s*\/?>)*$/i.test(cleaned)) return "";
    return cleaned;
}

export default function QuestionEditModal({
    open,
    title = "Edit Question",
    initialQuestionText,
    initialSolutionText,
    initialOptions,
    initialAnswerKeyText = "",
    initialMetadata,
    metadataHierarchy,
    saving = false,
    onSave,
    onCancel,
    questionId,
    rawData,
    onAiMetadataUpdate,
    status,
}: QuestionEditModalProps) {
    const questionTaskQueue = useQuestionTaskQueue();
    const [questionText, setQuestionText] = useState("");
    const [solutionText, setSolutionText] = useState("");
    const [options, setOptions] = useState<QuestionEditorOptionDraft[]>([]);
    const [answerKeyText, setAnswerKeyText] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    // QC workflow tab — only available when editing an existing question
    // (questionId set). For new question creation we stay on the Edit tab.
    type EditModalTab = "edit" | "status" | "history";
    const [activeTab, setActiveTab] = useState<EditModalTab>("edit");
    const [currentStatus, setCurrentStatus] = useState<QuestionStatus | undefined>(status);
    const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
    // Reset to Edit tab + sync status whenever the modal opens for a different question.
    useEffect(() => {
        if (open) {
            setActiveTab("edit");
            setCurrentStatus(status);
        }
    }, [open, questionId, status]);
    const [metadata, setMetadata] = useState<QuestionEditorMetadataDraft>(
        normalizeMetadata(initialMetadata)
    );
    const [examsText, setExamsText] = useState("");

    // ── AI Verify state ──
    const [showAiVerifyPanel, setShowAiVerifyPanel] = useState(false);
    const [aiVerifyProvider, setAiVerifyProvider] = useState<ChatApiProvider>("gemini");
    const [aiVerifyModelId, setAiVerifyModelId] = useState(DEFAULT_PROVIDER_MODELS.gemini[0]?.id || "");
    const [aiVerifyError, setAiVerifyError] = useState<string | null>(null);
    const [aiVerifications, setAiVerifications] = useState<AiVerificationEntry[]>([]);
    const [expandedVerification, setExpandedVerification] = useState<number | null>(null);

    // ── AI Translate state ──
    const [showAiTranslatePanel, setShowAiTranslatePanel] = useState(false);
    const [aiTranslateProvider, setAiTranslateProvider] = useState<ChatApiProvider>("gemini");
    const [aiTranslateModelId, setAiTranslateModelId] = useState(DEFAULT_PROVIDER_MODELS.gemini[0]?.id || "");
    const [aiTranslateLanguage, setAiTranslateLanguage] = useState("Hindi");
    const [aiTranslateError, setAiTranslateError] = useState<string | null>(null);
    // Translations now live in their own table (public.question_translations).
    const [aiTranslations, setAiTranslations] = useState<QuestionTranslation[]>([]);
    const [loadingTranslations, setLoadingTranslations] = useState(false);
    const [expandedTranslation, setExpandedTranslation] = useState<string | null>(null);
    const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
    const [deletingTranslationId, setDeletingTranslationId] = useState<string | null>(null);
    // Translations previously embedded in raw_data — preserved as-is so that
    // saving AI verifications doesn't accidentally wipe them. Never mutated.
    const [legacyTranslations, setLegacyTranslations] = useState<AiTranslationEntry[]>([]);

    // Derived running flags from the background task queue. The button shows
    // a spinner while a translate/verify job is in flight for this question.
    const aiTranslating = useMemo(
        () =>
            !!questionId &&
            questionTaskQueue.tasks.some(
                (t) => t.questionId === questionId && t.kind === "translate" && t.status === "running"
            ),
        [questionId, questionTaskQueue.tasks]
    );
    const aiVerifying = useMemo(
        () =>
            !!questionId &&
            questionTaskQueue.tasks.some(
                (t) => t.questionId === questionId && t.kind === "verify" && t.status === "running"
            ),
        [questionId, questionTaskQueue.tasks]
    );

    // ── AI Models state ──
    const [dynamicModels, setDynamicModels] = useState<Record<ChatApiProvider, ModelOption[]>>(DEFAULT_PROVIDER_MODELS);
    const [fetchingModelsProvider, setFetchingModelsProvider] = useState<ChatApiProvider | null>(null);

    const handleRefreshModels = useCallback(async (provider: ChatApiProvider) => {
        setFetchingModelsProvider(provider);
        try {
            const res = await fetch(`/api/ai-tools/models?provider=${provider}`);
            const data = await res.json();
            if (res.ok && data.success && data.models) {
                setDynamicModels(prev => ({ ...prev, [provider]: data.models }));
                // Update selected model if current selection is not in the new list
                setAiVerifyModelId(current => {
                    if (aiVerifyProvider !== provider) return current;
                    return data.models.find((m: ModelOption) => m.id === current) ? current : (data.models[0]?.id || "");
                });
                setAiTranslateModelId(current => {
                    if (aiTranslateProvider !== provider) return current;
                    return data.models.find((m: ModelOption) => m.id === current) ? current : (data.models[0]?.id || "");
                });
            } else {
                const errorMsg = data.error || "Failed to fetch models";
                if (provider === aiVerifyProvider) setAiVerifyError(errorMsg);
                if (provider === aiTranslateProvider) setAiTranslateError(errorMsg);
            }
        } catch (err) {
            console.error("Error refreshing models:", err);
        } finally {
            setFetchingModelsProvider(null);
        }
    }, [aiVerifyProvider, aiTranslateProvider]);

    // ── User API keys ──
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });

    // Load user API keys
    useEffect(() => {
        if (!open) return;
        setUserApiKeys(readDevApiKeysFromStorage());
        let cancelled = false;
        async function loadKeys() {
            try {
                const res = await fetch("/api/user/api-keys", { method: "GET", cache: "no-store" });
                if (!res.ok) return;
                const payload = (await res.json()) as { success?: boolean; apiKeys?: unknown };
                if (!cancelled && payload.success && payload.apiKeys && typeof payload.apiKeys === "object") {
                    setUserApiKeys((c) => ({ ...c, ...(payload.apiKeys as UserApiKeys) }));
                }
            } catch { /* ignore */ }
        }
        void loadKeys();
        return () => { cancelled = true; };
    }, [open]);

    // Parse existing AI metadata from rawData (verifications + legacy translations for back-compat)
    useEffect(() => {
        if (!open) return;
        const rd = rawData;
        const firstEntry = Array.isArray(rd) ? rd[0] : (rd && typeof rd === "object" ? rd : null);
        const aiMeta = (firstEntry as Record<string, unknown> | null)?.ai_metadata as AiMetadata | undefined;
        if (aiMeta) {
            setAiVerifications(Array.isArray(aiMeta.verifications) ? aiMeta.verifications : []);
            setLegacyTranslations(Array.isArray(aiMeta.translations) ? aiMeta.translations : []);
        } else {
            setAiVerifications([]);
            setLegacyTranslations([]);
        }
    }, [open, rawData]);

    // Load translations from public.question_translations
    const reloadTranslations = useCallback(async () => {
        if (!questionId) {
            setAiTranslations([]);
            return;
        }
        setLoadingTranslations(true);
        try {
            const rows = await fetchTranslationsForQuestion(questionId);
            setAiTranslations(rows);
        } finally {
            setLoadingTranslations(false);
        }
    }, [questionId]);

    useEffect(() => {
        if (!open) return;
        void reloadTranslations();
    }, [open, reloadTranslations]);

    // When a background translate task for this question completes, re-pull
    // the list so the new row (with its is_default flag) shows up.
    useEffect(() => {
        if (!open || !questionId) return;
        const justFinished = questionTaskQueue.tasks.find(
            (t) =>
                t.questionId === questionId &&
                t.kind === "translate" &&
                t.status === "done" &&
                t.finishedAt &&
                Date.now() - t.finishedAt < 2_000
        );
        if (justFinished) {
            void reloadTranslations();
        }
    }, [open, questionId, questionTaskQueue.tasks, reloadTranslations]);

    // Helper to get model label
    const getModelLabel = useCallback((provider: ChatApiProvider, modelId: string): string => {
        const models = DEFAULT_PROVIDER_MODELS[provider] || [];
        const match = models.find((m) => m.id === modelId);
        return match ? match.label : modelId;
    }, []);

    // ── AI Verify handler ──
    // Enqueued into the background task queue. The modal stays usable, the
    // user can close it, and the floating notifier reports completion.
    const handleAiVerify = useCallback(() => {
        if (!questionText.trim()) {
            setAiVerifyError("Question text is required to verify.");
            return;
        }
        setAiVerifyError(null);

        const capturedQuestionId = questionId || "(unsaved)";
        const capturedProvider = aiVerifyProvider;
        const capturedModelId = aiVerifyModelId;
        const capturedModelLabel = getModelLabel(aiVerifyProvider, aiVerifyModelId);
        const providerKey = (userApiKeys[capturedProvider] || "").trim();
        const requestBody = {
            questionText,
            options: options.map((o) => ({ text: o.text || null, isCorrect: o.isCorrect })),
            answerKey: answerKeyText.trim()
                ? answerKeyText.includes(",")
                    ? answerKeyText.split(",").map((v) => Number(v.trim())).filter(Number.isFinite)
                    : Number(answerKeyText.trim())
                : null,
            solutionText,
            questionType: metadata.questionType,
            subject: metadata.subject,
            chapter: metadata.chapter,
            topic: metadata.topic,
            provider: capturedProvider,
            modelId: capturedModelId,
        };
        // Snapshot the current list at enqueue time. Persistence runs in the
        // background callback against this snapshot.
        const currentVerifications = aiVerifications;
        const currentLegacyTranslations = legacyTranslations;

        questionTaskQueue.enqueue({
            kind: "verify",
            questionId: capturedQuestionId,
            label: (questionId || "Question").slice(0, 8),
            detail: capturedModelLabel,
            run: async () => {
                const headers: HeadersInit = { "Content-Type": "application/json" };
                if (providerKey) headers["x-dev-api-key"] = providerKey;
                const res = await fetch("/api/ai-tools/verify", {
                    method: "POST",
                    headers,
                    body: JSON.stringify(requestBody),
                });
                const payload = (await res.json()) as {
                    success?: boolean;
                    result?: Record<string, unknown>;
                    error?: string;
                };
                if (!res.ok || !payload.success) {
                    throw new Error(payload.error || `Verification failed (HTTP ${res.status})`);
                }
                return payload.result;
            },
            onComplete: async (raw) => {
                if (!raw) return;
                const r = raw as Record<string, unknown>;
                const newEntry: AiVerificationEntry = {
                    index: currentVerifications.length + 1,
                    provider: capturedProvider,
                    modelId: capturedModelId,
                    modelLabel: capturedModelLabel,
                    answerKeyVerified: r.answerKeyVerified === true,
                    aiAnswer: String(r.aiAnswer ?? ""),
                    aiAnswerExplanation: String(r.aiAnswerExplanation ?? ""),
                    aiSolution: String(r.aiSolution ?? ""),
                    aiSuggestion: String(r.aiSuggestion ?? ""),
                    questionLanguageQuality: String(r.questionLanguageQuality ?? ""),
                    solutionLanguageQuality: String(r.solutionLanguageQuality ?? ""),
                    overallVerdict: String(r.overallVerdict ?? ""),
                    verifiedAt: new Date().toISOString(),
                };
                const updated = [...currentVerifications, newEntry];
                // Only mutate modal state if it's still showing this question.
                if (questionId === capturedQuestionId) {
                    setAiVerifications(updated);
                    setExpandedVerification(newEntry.index);
                }
                if (onAiMetadataUpdate) {
                    try {
                        await onAiMetadataUpdate({
                            verifications: updated,
                            translations: currentLegacyTranslations,
                        });
                    } catch (saveErr) {
                        console.warn("Persist AI verify metadata failed:", saveErr);
                    }
                }
            },
        });
    }, [
        questionId,
        questionText,
        options,
        answerKeyText,
        solutionText,
        metadata,
        aiVerifyProvider,
        aiVerifyModelId,
        userApiKeys,
        aiVerifications,
        legacyTranslations,
        onAiMetadataUpdate,
        getModelLabel,
        questionTaskQueue,
    ]);

    // ── AI Translate handler ──
    // Fire-and-forget via the QuestionTaskQueue. The modal stays usable, the
    // user can close it, and a floating notifier reports completion. On
    // success we also drop an optimistic row into the local list so the
    // result is visible immediately if the modal is still open.
    const handleAiTranslate = useCallback(() => {
        if (!questionText.trim()) {
            setAiTranslateError("Question text is required to translate.");
            return;
        }
        if (!questionId) {
            setAiTranslateError("This question must be saved before it can be translated.");
            return;
        }
        setAiTranslateError(null);

        const capturedQuestionId = questionId;
        const capturedLanguage = aiTranslateLanguage;
        const capturedProvider = aiTranslateProvider;
        const capturedModelId = aiTranslateModelId;
        const capturedModelLabel = getModelLabel(aiTranslateProvider, aiTranslateModelId);
        const capturedQuestionText = questionText;
        const capturedSolutionText = solutionText;
        const capturedOptions = options.map((o) => ({ text: o.text || null, isCorrect: o.isCorrect }));
        const providerKey = (userApiKeys[capturedProvider] || "").trim();

        questionTaskQueue.enqueue({
            kind: "translate",
            questionId: capturedQuestionId,
            label: capturedQuestionId.slice(0, 8),
            detail: `${capturedLanguage} · ${capturedModelLabel}`,
            run: async () => {
                const headers: HeadersInit = { "Content-Type": "application/json" };
                if (providerKey) headers["x-dev-api-key"] = providerKey;
                const res = await fetch("/api/ai-tools/translate", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        questionId: capturedQuestionId,
                        questionText: capturedQuestionText,
                        options: capturedOptions,
                        solutionText: capturedSolutionText,
                        targetLanguage: capturedLanguage,
                        provider: capturedProvider,
                        modelId: capturedModelId,
                        modelLabel: capturedModelLabel,
                    }),
                });
                const payload = (await res.json()) as {
                    success?: boolean;
                    result?: Record<string, unknown>;
                    translation?: QuestionTranslation | null;
                    translationId?: string | null;
                    persistError?: string | null;
                    error?: string;
                };
                if (!res.ok || !payload.success) {
                    throw new Error(payload.error || `Translation failed (HTTP ${res.status})`);
                }
                return payload;
            },
            onComplete: async (raw) => {
                const payload = raw as {
                    result?: Record<string, unknown>;
                    translation?: QuestionTranslation | null;
                    translationId?: string | null;
                    persistError?: string | null;
                };
                // Only update modal state if the same question is still in view.
                if (questionId !== capturedQuestionId) return;

                if (payload.translation) {
                    // Authoritative row from the DB. Reload to absorb the
                    // is_default flip the trigger just performed.
                    await reloadTranslations();
                    if (payload.translationId) setExpandedTranslation(payload.translationId);
                } else if (payload.result) {
                    // Persist failed — show the result locally so the user can
                    // still see it. Mark with a synthetic id so the row keys.
                    const r = payload.result;
                    const synthetic: QuestionTranslation = {
                        id: `local-${Date.now()}`,
                        question_id: capturedQuestionId,
                        language: capturedLanguage.toLowerCase(),
                        question_text: String(r.translatedQuestionText ?? ""),
                        options: Array.isArray(r.translatedOptions)
                            ? (r.translatedOptions as Array<{ text?: string; isCorrect?: boolean }>).map((o) => ({
                                text: String(o.text ?? ""),
                                isCorrect: o.isCorrect === true,
                            }))
                            : [],
                        solution_text: String(r.translatedSolutionText ?? "") || null,
                        translation_notes: String(r.translationNotes ?? "") || null,
                        is_default: false,
                        provider: capturedProvider,
                        model_id: capturedModelId,
                        model_label: capturedModelLabel,
                        translated_by: null,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    };
                    setAiTranslations((prev) => [synthetic, ...prev]);
                    setExpandedTranslation(synthetic.id);
                    setAiTranslateError(
                        payload.persistError
                            ? `Translation generated but not saved to DB: ${payload.persistError}. Run scripts/sql/fix_question_translations_rls.sql in Supabase.`
                            : "Translation generated but did not return a stored row."
                    );
                }
            },
        });
    }, [
        questionId,
        questionText,
        options,
        solutionText,
        aiTranslateLanguage,
        aiTranslateProvider,
        aiTranslateModelId,
        userApiKeys,
        getModelLabel,
        reloadTranslations,
        questionTaskQueue,
    ]);

    // ── Set translation as default ──
    const handleSetTranslationDefault = useCallback(async (translationId: string) => {
        setSettingDefaultId(translationId);
        try {
            await setTranslationAsDefault(translationId);
            await reloadTranslations();
        } catch (err) {
            console.error(err);
            setAiTranslateError(err instanceof Error ? err.message : String(err));
        } finally {
            setSettingDefaultId(null);
        }
    }, [reloadTranslations]);

    // ── Delete a translation version ──
    const handleDeleteTranslation = useCallback(async (translationId: string) => {
        if (!confirm("Delete this translation version? This cannot be undone.")) return;
        setDeletingTranslationId(translationId);
        try {
            await deleteTranslation(translationId);
            await reloadTranslations();
        } catch (err) {
            console.error(err);
            setAiTranslateError(err instanceof Error ? err.message : String(err));
        } finally {
            setDeletingTranslationId(null);
        }
    }, [reloadTranslations]);

    useEffect(() => {
        if (!open) return;
        setQuestionText(initialQuestionText || "");
        setSolutionText(initialSolutionText || "");
        setOptions(normalizeOptions(initialOptions || []));
        setAnswerKeyText(initialAnswerKeyText || "");
        setErrorMessage(null);
        const normalizedMetadata = normalizeMetadata(initialMetadata);
        setMetadata(normalizedMetadata);
        setExamsText(normalizedMetadata.exams.join(", "));
        setShowAiVerifyPanel(false);
        setShowAiTranslatePanel(false);
        setAiVerifyError(null);
        setAiTranslateError(null);
    }, [
        open,
        initialAnswerKeyText,
        initialMetadata,
        initialOptions,
        initialQuestionText,
        initialSolutionText,
    ]);

    useEffect(() => {
        if (!open) return;
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !saving) onCancel();
        };
        window.addEventListener("keydown", onEscape);
        return () => window.removeEventListener("keydown", onEscape);
    }, [onCancel, open, saving]);

    const isNumericalType = useMemo(
        () => isNumericalQuestionType(metadata.questionType),
        [metadata.questionType]
    );

    const questionTypeOptions = useMemo(() => {
        const fromHierarchy = metadataHierarchy?.questionTypes || [];
        return uniqueStrings([...fromHierarchy, metadata.questionType]);
    }, [metadataHierarchy?.questionTypes, metadata.questionType]);

    const subjectOptions = useMemo(() => {
        const fromHierarchy = metadataHierarchy?.subjects || [];
        return uniqueStrings([...fromHierarchy, metadata.subject]);
    }, [metadataHierarchy?.subjects, metadata.subject]);

    const chapterOptions = useMemo(() => {
        if (!metadataHierarchy) return uniqueStrings([metadata.chapter]);
        const bySubject = metadata.subject
            ? metadataHierarchy.chaptersBySubject[metadata.subject] || []
            : uniqueStrings(Object.values(metadataHierarchy.chaptersBySubject).flat());
        return uniqueStrings([...bySubject, metadata.chapter]);
    }, [metadata.subject, metadata.chapter, metadataHierarchy]);

    const topicOptions = useMemo(() => {
        if (!metadataHierarchy) return uniqueStrings([metadata.topic]);
        const byChapter = metadata.chapter
            ? metadataHierarchy.topicsByChapter[metadata.chapter] || []
            : uniqueStrings(Object.values(metadataHierarchy.topicsByChapter).flat());
        return uniqueStrings([...byChapter, metadata.topic]);
    }, [metadata.chapter, metadata.topic, metadataHierarchy]);

    const classLevelOptions = useMemo(() => {
        const fromHierarchy = metadataHierarchy?.classLevels || [];
        return uniqueStrings([...fromHierarchy, metadata.classLevel]);
    }, [metadataHierarchy?.classLevels, metadata.classLevel]);

    const difficultyOptions = useMemo(() => {
        const fromHierarchy = metadataHierarchy?.difficultyLevels || [];
        return uniqueStrings([...fromHierarchy, metadata.difficultyLevel]);
    }, [metadataHierarchy?.difficultyLevels, metadata.difficultyLevel]);

    useEffect(() => {
        if (!metadata.chapter || chapterOptions.includes(metadata.chapter)) return;
        setMetadata((current) => ({ ...current, chapter: "", topic: "", subtopic: "" }));
    }, [chapterOptions, metadata.chapter]);

    useEffect(() => {
        if (!metadata.topic || topicOptions.includes(metadata.topic)) return;
        setMetadata((current) => ({ ...current, topic: "", subtopic: "" }));
    }, [metadata.topic, topicOptions]);

    const isScqQuestion = useMemo(() => {
        const normalized = (metadata.questionType || "").toLowerCase();
        return normalized.includes("single_choice") || normalized.includes("scq");
    }, [metadata.questionType]);

    const questionEditorMinHeight = useMemo(
        () =>
            estimateEditorHeight(questionText, {
                min: 82,
                max: 360,
                charsPerLine: 110,
                base: 28,
                lineHeight: 18,
            }),
        [questionText]
    );
    const solutionEditorMinHeight = useMemo(
        () =>
            estimateEditorHeight(solutionText, {
                min: 82,
                max: 340,
                charsPerLine: 110,
                base: 26,
                lineHeight: 18,
            }),
        [solutionText]
    );

    async function handleSave() {
        if (!questionText.trim()) {
            setErrorMessage("Question text cannot be empty.");
            return;
        }

        setErrorMessage(null);
        await onSave({
            questionText,
            solutionText,
            options: isNumericalType
                ? []
                : options.map((option) => ({
                    ...option,
                    text: sanitizeOptionHtml(option.text),
                })),
            answerKeyText,
            metadata: {
                ...metadata,
                exams: examsText
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
            },
        });
    }

    if (!open) return null;

    return (
        <div
            className="no-print"
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 180,
                display: "grid",
                placeItems: "center",
                padding: "16px",
                background: "rgba(0,0,0,0.55)",
            }}
            onClick={() => {
                if (!saving) onCancel();
            }}
        >
            <div
                style={{
                    width: "min(1120px, 96vw)",
                    maxHeight: "92vh",
                    borderRadius: "12px",
                    border: "1px solid var(--border-accent)",
                    background: "var(--bg-elevated)",
                    boxShadow: "var(--shadow-lg)",
                    display: "grid",
                    gridTemplateRows: "auto minmax(0, 1fr) auto",
                    overflow: "hidden",
                }}
                onClick={(event) => event.stopPropagation()}
            >
                <div
                    style={{
                        padding: "14px 16px 0",
                        borderBottom: "1px solid var(--border-primary)",
                        display: "grid",
                        gap: "10px",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "12px",
                            flexWrap: "wrap",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>{title}</div>
                            {questionId && currentStatus && <QuestionStatusPill status={currentStatus} />}
                            {questionId && (
                                <Link
                                    href={`/question/${questionId}?tab=history`}
                                    target="_blank"
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "4px",
                                        padding: "3px 8px",
                                        borderRadius: "6px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        fontSize: "0.7rem",
                                        fontWeight: 600,
                                        textDecoration: "none",
                                    }}
                                    title="Open this question in a full page"
                                >
                                    Open full page ↗
                                </Link>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={saving}
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "8px",
                                background: "var(--bg-secondary)",
                                color: "var(--text-secondary)",
                                padding: "7px 12px",
                                cursor: saving ? "default" : "pointer",
                            }}
                        >
                            Close
                        </button>
                    </div>

                    {/* Tab strip — only shown when editing an existing question */}
                    {questionId && (
                        <div style={{ display: "flex", gap: "2px" }}>
                            {(
                                [
                                    { id: "edit" as const, label: "Edit", icon: <Pencil size={13} /> },
                                    { id: "status" as const, label: "Status", icon: <Workflow size={13} /> },
                                    { id: "history" as const, label: "History", icon: <HistoryIcon size={13} /> },
                                ]
                            ).map((tab) => {
                                const active = activeTab === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        onClick={() => setActiveTab(tab.id)}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            padding: "8px 14px",
                                            borderRadius: "8px 8px 0 0",
                                            border: "none",
                                            borderBottom: `2px solid ${active ? "var(--accent-primary, #818cf8)" : "transparent"}`,
                                            background: active ? "var(--bg-secondary)" : "transparent",
                                            color: active ? "var(--accent-primary-hover, var(--text-primary))" : "var(--text-secondary)",
                                            fontSize: "0.82rem",
                                            fontWeight: active ? 700 : 600,
                                            cursor: "pointer",
                                            marginBottom: "-1px",
                                        }}
                                    >
                                        {tab.icon}
                                        {tab.label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div style={{ overflowY: "auto", padding: "16px", display: "grid", gap: "14px" }}>
                    {/* QC workflow tab: status pill + transition buttons */}
                    {activeTab === "status" && questionId && (
                        <QuestionStatusPanel
                            questionId={questionId}
                            status={currentStatus ?? "verification_pending"}
                            onChanged={(next) => {
                                setCurrentStatus(next);
                                setHistoryRefreshKey((k) => k + 1);
                            }}
                        />
                    )}

                    {/* History tab: timeline of status changes + edit snapshots */}
                    {activeTab === "history" && questionId && (
                        <QuestionHistoryPanel
                            questionId={questionId}
                            refreshKey={historyRefreshKey}
                        />
                    )}

                    {/* Edit tab: the full question editor (existing content). */}
                    {activeTab === "edit" && (<>
                    <section
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "10px",
                            padding: "12px",
                            background: "var(--bg-secondary)",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                color: "var(--text-tertiary)",
                                marginBottom: "8px",
                            }}
                        >
                            Question Text
                        </div>
                        <RichHtmlEditor
                            value={questionText}
                            onChange={setQuestionText}
                            minHeight={questionEditorMinHeight}
                            maxHeight={560}
                            placeholder="Write the question statement..."
                        />
                        {hasLatexLikeContent(questionText) && (
                            <div
                                style={{
                                    marginTop: "10px",
                                    border: "1px dashed var(--border-accent)",
                                    borderRadius: "8px",
                                    background: "var(--bg-elevated)",
                                    padding: "10px",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: "0.7rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        color: "var(--text-tertiary)",
                                        marginBottom: "6px",
                                    }}
                                >
                                    Rendered Preview
                                </div>
                                <MathContent
                                    html={questionText}
                                    className="question-html"
                                    style={{ fontSize: "0.84rem" }}
                                />
                            </div>
                        )}
                    </section>

                    <section
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "10px",
                            padding: "12px",
                            background: "var(--bg-secondary)",
                            display: "grid",
                            gap: "6px",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                color: "var(--text-tertiary)",
                            }}
                        >
                            Question Type
                        </div>
                        {questionTypeOptions.length > 0 ? (
                            <select
                                value={metadata.questionType}
                                onChange={(event) =>
                                    setMetadata((current) => ({
                                        ...current,
                                        questionType: event.target.value,
                                    }))
                                }
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.78rem",
                                    padding: "8px 9px",
                                    outline: "none",
                                    width: "min(420px, 100%)",
                                }}
                            >
                                {questionTypeOptions.map((questionType) => (
                                    <option key={questionType} value={questionType}>
                                        {questionType}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                value={metadata.questionType}
                                onChange={(event) =>
                                    setMetadata((current) => ({
                                        ...current,
                                        questionType: event.target.value,
                                    }))
                                }
                                placeholder="Single_Choice(SCQ)"
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.78rem",
                                    padding: "7px 9px",
                                    outline: "none",
                                    width: "min(420px, 100%)",
                                }}
                            />
                        )}
                    </section>

                    {!isNumericalType && (
                        <section
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "10px",
                                padding: "12px",
                                background: "var(--bg-secondary)",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    marginBottom: "10px",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: "0.75rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        color: "var(--text-tertiary)",
                                    }}
                                >
                                    Options
                                </div>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setOptions((current) => [...current, { text: "", isCorrect: false }])
                                    }
                                    disabled={saving}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "6px 10px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-tertiary)",
                                        color: "var(--text-secondary)",
                                        fontSize: "0.74rem",
                                        cursor: saving ? "default" : "pointer",
                                    }}
                                >
                                    <Plus size={13} />
                                    Add Option
                                </button>
                            </div>
                            <div style={{ display: "grid", gap: "12px" }}>
                                {options.map((option, index) => (
                                    <div
                                        key={index}
                                        style={{
                                            border: "1px solid var(--border-secondary)",
                                            borderRadius: "10px",
                                            padding: "10px",
                                            background: "var(--bg-tertiary)",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "10px",
                                                marginBottom: "8px",
                                            }}
                                        >
                                            <span
                                                style={{
                                                    width: "22px",
                                                    height: "22px",
                                                    borderRadius: "6px",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    background: "rgba(100,100,140,0.15)",
                                                    color: "var(--text-secondary)",
                                                    fontSize: "0.74rem",
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {optionLabel(index)}
                                            </span>
                                            <label
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "6px",
                                                    fontSize: "0.76rem",
                                                    color: "var(--text-secondary)",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={option.isCorrect}
                                                    onChange={(event) =>
                                                        setOptions((current) =>
                                                            current.map((entry, idx) =>
                                                                idx === index
                                                                    ? { ...entry, isCorrect: event.target.checked }
                                                                    : entry
                                                            )
                                                        )
                                                    }
                                                    style={{
                                                        width: "14px",
                                                        height: "14px",
                                                        accentColor: "var(--accent-success)",
                                                        cursor: "pointer",
                                                    }}
                                                />
                                                Correct
                                            </label>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setOptions((current) =>
                                                        current.length <= 2
                                                            ? current
                                                            : current.filter((_, idx) => idx !== index)
                                                    )
                                                }
                                                disabled={saving || options.length <= 2}
                                                style={{
                                                    marginLeft: "auto",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "4px",
                                                    padding: "4px 8px",
                                                    borderRadius: "6px",
                                                    border: "1px solid rgba(var(--accent-danger-rgb),0.3)",
                                                    background: "rgba(var(--accent-danger-rgb),0.1)",
                                                    color: "var(--accent-danger)",
                                                    fontSize: "0.7rem",
                                                    cursor:
                                                        saving || options.length <= 2
                                                            ? "default"
                                                            : "pointer",
                                                    opacity: options.length <= 2 ? 0.5 : 1,
                                                }}
                                            >
                                                <Trash2 size={12} />
                                                Remove
                                            </button>
                                        </div>
                                        <RichHtmlEditor
                                            value={sanitizeOptionHtml(option.text)}
                                            onChange={(value) =>
                                                setOptions((current) =>
                                                    current.map((entry, idx) =>
                                                        idx === index
                                                            ? { ...entry, text: sanitizeOptionHtml(value) }
                                                            : entry
                                                    )
                                                )
                                            }
                                            minHeight={estimateEditorHeight(
                                                sanitizeOptionHtml(option.text),
                                                {
                                                min: isScqQuestion ? 60 : 70,
                                                max: 170,
                                                charsPerLine: 92,
                                                base: 22,
                                                lineHeight: 18,
                                                }
                                            )}
                                            maxHeight={220}
                                            placeholder={`Option ${optionLabel(index)}...`}
                                        />
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {isNumericalType && (
                        <section
                            style={{
                                border: "1px solid rgba(34,197,94,0.28)",
                                borderRadius: "10px",
                                padding: "10px 12px",
                                background: "rgba(34,197,94,0.08)",
                                display: "grid",
                                gap: "6px",
                            }}
                        >
                            <div
                                style={{
                                    fontSize: "0.75rem",
                                    fontWeight: 700,
                                    textTransform: "uppercase",
                                    color: "#86efac",
                                }}
                            >
                                Answer Key
                            </div>
                            <input
                                value={answerKeyText}
                                onChange={(event) => setAnswerKeyText(event.target.value)}
                                placeholder="Type answer key (e.g. 42)"
                                style={{
                                    width: "220px",
                                    maxWidth: "100%",
                                    border: "1px solid rgba(34,197,94,0.35)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.78rem",
                                    padding: "7px 9px",
                                    outline: "none",
                                }}
                            />
                        </section>
                    )}

                    <section
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "10px",
                            padding: "12px",
                            background: "var(--bg-secondary)",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                color: "var(--text-tertiary)",
                                marginBottom: "8px",
                            }}
                        >
                            Solution
                        </div>
                        <RichHtmlEditor
                            value={solutionText}
                            onChange={setSolutionText}
                            minHeight={solutionEditorMinHeight}
                            maxHeight={520}
                            placeholder="Write the explanation or solving steps..."
                        />
                        {hasLatexLikeContent(solutionText) && (
                            <div
                                style={{
                                    marginTop: "10px",
                                    border: "1px dashed var(--border-accent)",
                                    borderRadius: "8px",
                                    background: "var(--bg-elevated)",
                                    padding: "10px",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: "0.7rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        color: "var(--text-tertiary)",
                                        marginBottom: "6px",
                                    }}
                                >
                                    Rendered Preview
                                </div>
                                <MathContent
                                    html={solutionText}
                                    className="question-html"
                                    style={{ fontSize: "0.84rem" }}
                                />
                            </div>
                        )}
                    </section>

                    {/* ════════════ AI TOOLS ════════════ */}
                    {questionId && (
                        <section
                            style={{
                                border: "1px solid rgba(139, 92, 246, 0.25)",
                                borderRadius: "10px",
                                padding: "12px",
                                background: "rgba(139, 92, 246, 0.04)",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    marginBottom: aiVerifications.length > 0 || aiTranslations.length > 0 || showAiVerifyPanel || showAiTranslatePanel ? "10px" : "0",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: "0.75rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        color: "#a78bfa",
                                        flex: 1,
                                    }}
                                >
                                    AI Tools
                                </div>
                                <button
                                    type="button"
                                    onClick={() => { setShowAiVerifyPanel(!showAiVerifyPanel); setShowAiTranslatePanel(false); }}
                                    disabled={saving || aiVerifying || aiTranslating}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "5px",
                                        padding: "6px 12px",
                                        borderRadius: "8px",
                                        border: showAiVerifyPanel ? "1px solid rgba(139, 92, 246, 0.5)" : "1px solid var(--border-primary)",
                                        background: showAiVerifyPanel ? "rgba(139, 92, 246, 0.15)" : "var(--bg-tertiary)",
                                        color: showAiVerifyPanel ? "#a78bfa" : "var(--text-secondary)",
                                        fontSize: "0.74rem",
                                        fontWeight: 600,
                                        cursor: "pointer",
                                        transition: "all 0.15s ease",
                                    }}
                                >
                                    <Bot size={14} />
                                    AI Verify
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setShowAiTranslatePanel(!showAiTranslatePanel); setShowAiVerifyPanel(false); }}
                                    disabled={saving || aiVerifying || aiTranslating}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "5px",
                                        padding: "6px 12px",
                                        borderRadius: "8px",
                                        border: showAiTranslatePanel ? "1px solid rgba(34, 197, 94, 0.5)" : "1px solid var(--border-primary)",
                                        background: showAiTranslatePanel ? "rgba(34, 197, 94, 0.12)" : "var(--bg-tertiary)",
                                        color: showAiTranslatePanel ? "#4ade80" : "var(--text-secondary)",
                                        fontSize: "0.74rem",
                                        fontWeight: 600,
                                        cursor: "pointer",
                                        transition: "all 0.15s ease",
                                    }}
                                >
                                    <Globe size={14} />
                                    AI Translate
                                </button>
                            </div>

                            {/* ── AI Verify Panel ── */}
                            {showAiVerifyPanel && (
                                <div
                                    style={{
                                        border: "1px solid rgba(139, 92, 246, 0.2)",
                                        borderRadius: "8px",
                                        padding: "10px",
                                        background: "rgba(139, 92, 246, 0.06)",
                                        display: "grid",
                                        gap: "8px",
                                        marginBottom: "8px",
                                    }}
                                >
                                    <div style={{ fontSize: "0.72rem", color: "#c4b5fd", fontWeight: 600 }}>
                                        Select AI Model to Verify This Question
                                    </div>
                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <select
                                            value={aiVerifyProvider}
                                            onChange={(e) => {
                                                const p = e.target.value as ChatApiProvider;
                                                setAiVerifyProvider(p);
                                                const models = dynamicModels[p] || [];
                                                if (models.length > 0) setAiVerifyModelId(models[0].id);
                                            }}
                                            style={{
                                                border: "1px solid rgba(139, 92, 246, 0.3)",
                                                borderRadius: "7px",
                                                background: "var(--bg-secondary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.76rem",
                                                padding: "6px 8px",
                                                outline: "none",
                                                minWidth: "120px",
                                            }}
                                        >
                                            {CHAT_API_PROVIDERS.map((p) => (
                                                <option key={p} value={p}>{API_KEY_PROVIDER_LABELS[p]}</option>
                                            ))}
                                        </select>
                                        {aiVerifyProvider === "custom_openai" ? (
                                            <input
                                                type="text"
                                                value={aiVerifyModelId}
                                                onChange={(e) => setAiVerifyModelId(e.target.value)}
                                                placeholder="Enter model ID"
                                                style={{
                                                    border: "1px solid rgba(139, 92, 246, 0.3)",
                                                    borderRadius: "7px",
                                                    background: "var(--bg-secondary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.76rem",
                                                    padding: "6px 8px",
                                                    outline: "none",
                                                    flex: 1,
                                                    minWidth: "160px",
                                                }}
                                            />
                                        ) : (
                                            <select
                                                value={aiVerifyModelId}
                                                onChange={(e) => setAiVerifyModelId(e.target.value)}
                                                style={{
                                                    border: "1px solid rgba(139, 92, 246, 0.3)",
                                                    borderRadius: "7px",
                                                    background: "var(--bg-secondary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.76rem",
                                                    padding: "6px 8px",
                                                    outline: "none",
                                                    flex: 1,
                                                    minWidth: "160px",
                                                }}
                                            >
                                                {(dynamicModels[aiVerifyProvider] || []).map((m) => (
                                                    <option key={m.id} value={m.id}>{m.label}</option>
                                                ))}
                                            </select>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => { void handleRefreshModels(aiVerifyProvider); }}
                                            disabled={fetchingModelsProvider === aiVerifyProvider}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                padding: "6px",
                                                borderRadius: "7px",
                                                border: "1px solid rgba(139, 92, 246, 0.3)",
                                                background: "var(--bg-secondary)",
                                                color: "var(--text-secondary)",
                                                cursor: fetchingModelsProvider === aiVerifyProvider ? "default" : "pointer",
                                                opacity: fetchingModelsProvider === aiVerifyProvider ? 0.5 : 1,
                                            }}
                                            title="Refresh Models"
                                        >
                                            <RefreshCw size={14} style={fetchingModelsProvider === aiVerifyProvider ? { animation: "spin 1s linear infinite" } : undefined} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { void handleAiVerify(); }}
                                            disabled={aiVerifying || !aiVerifyModelId}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "5px",
                                                padding: "6px 14px",
                                                borderRadius: "8px",
                                                border: "none",
                                                background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
                                                color: "#ffffff",
                                                fontSize: "0.76rem",
                                                fontWeight: 700,
                                                cursor: aiVerifying ? "default" : "pointer",
                                                opacity: aiVerifying ? 0.7 : 1,
                                                boxShadow: "0 1px 4px rgba(124, 58, 237, 0.35)",
                                            }}
                                        >
                                            {aiVerifying && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                                            {aiVerifying ? "Verifying..." : "Run Verification"}
                                        </button>
                                    </div>
                                    {aiVerifyError && (
                                        <div style={{ fontSize: "0.73rem", color: "var(--accent-danger)", padding: "4px 0" }}>
                                            {aiVerifyError}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── AI Translate Panel ── */}
                            {showAiTranslatePanel && (
                                <div
                                    style={{
                                        border: "1px solid rgba(34, 197, 94, 0.2)",
                                        borderRadius: "8px",
                                        padding: "10px",
                                        background: "rgba(34, 197, 94, 0.06)",
                                        display: "grid",
                                        gap: "8px",
                                        marginBottom: "8px",
                                    }}
                                >
                                    <div style={{ fontSize: "0.72rem", color: "#86efac", fontWeight: 600 }}>
                                        Translate This Question to Another Language
                                    </div>
                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <select
                                            value={aiTranslateLanguage}
                                            onChange={(e) => setAiTranslateLanguage(e.target.value)}
                                            style={{
                                                border: "1px solid rgba(34, 197, 94, 0.3)",
                                                borderRadius: "7px",
                                                background: "var(--bg-secondary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.76rem",
                                                padding: "6px 8px",
                                                outline: "none",
                                                minWidth: "120px",
                                            }}
                                        >
                                            {TRANSLATION_LANGUAGES.map((lang) => (
                                                <option key={lang} value={lang}>{lang}</option>
                                            ))}
                                        </select>
                                        <select
                                            value={aiTranslateProvider}
                                            onChange={(e) => {
                                                const p = e.target.value as ChatApiProvider;
                                                setAiTranslateProvider(p);
                                                const models = dynamicModels[p] || [];
                                                if (models.length > 0) setAiTranslateModelId(models[0].id);
                                            }}
                                            style={{
                                                border: "1px solid rgba(34, 197, 94, 0.3)",
                                                borderRadius: "7px",
                                                background: "var(--bg-secondary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.76rem",
                                                padding: "6px 8px",
                                                outline: "none",
                                                minWidth: "120px",
                                            }}
                                        >
                                            {CHAT_API_PROVIDERS.map((p) => (
                                                <option key={p} value={p}>{API_KEY_PROVIDER_LABELS[p]}</option>
                                            ))}
                                        </select>
                                        {aiTranslateProvider === "custom_openai" ? (
                                            <input
                                                type="text"
                                                value={aiTranslateModelId}
                                                onChange={(e) => setAiTranslateModelId(e.target.value)}
                                                placeholder="Enter model ID"
                                                style={{
                                                    border: "1px solid rgba(34, 197, 94, 0.3)",
                                                    borderRadius: "7px",
                                                    background: "var(--bg-secondary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.76rem",
                                                    padding: "6px 8px",
                                                    outline: "none",
                                                    flex: 1,
                                                    minWidth: "160px",
                                                }}
                                            />
                                        ) : (
                                            <select
                                                value={aiTranslateModelId}
                                                onChange={(e) => setAiTranslateModelId(e.target.value)}
                                                style={{
                                                    border: "1px solid rgba(34, 197, 94, 0.3)",
                                                    borderRadius: "7px",
                                                    background: "var(--bg-secondary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.76rem",
                                                    padding: "6px 8px",
                                                    outline: "none",
                                                    flex: 1,
                                                    minWidth: "160px",
                                                }}
                                            >
                                                {(dynamicModels[aiTranslateProvider] || []).map((m) => (
                                                    <option key={m.id} value={m.id}>{m.label}</option>
                                                ))}
                                            </select>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => { void handleRefreshModels(aiTranslateProvider); }}
                                            disabled={fetchingModelsProvider === aiTranslateProvider}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                padding: "6px",
                                                borderRadius: "7px",
                                                border: "1px solid rgba(34, 197, 94, 0.3)",
                                                background: "var(--bg-secondary)",
                                                color: "var(--text-secondary)",
                                                cursor: fetchingModelsProvider === aiTranslateProvider ? "default" : "pointer",
                                                opacity: fetchingModelsProvider === aiTranslateProvider ? 0.5 : 1,
                                            }}
                                            title="Refresh Models"
                                        >
                                            <RefreshCw size={14} style={fetchingModelsProvider === aiTranslateProvider ? { animation: "spin 1s linear infinite" } : undefined} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { void handleAiTranslate(); }}
                                            disabled={aiTranslating || !aiTranslateModelId}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "5px",
                                                padding: "6px 14px",
                                                borderRadius: "8px",
                                                border: "none",
                                                background: "linear-gradient(135deg, #16a34a, #15803d)",
                                                color: "#ffffff",
                                                fontSize: "0.76rem",
                                                fontWeight: 700,
                                                cursor: aiTranslating ? "default" : "pointer",
                                                opacity: aiTranslating ? 0.7 : 1,
                                                boxShadow: "0 1px 4px rgba(22, 163, 74, 0.35)",
                                            }}
                                        >
                                            {aiTranslating && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                                            {aiTranslating ? "Translating..." : "Translate"}
                                        </button>
                                    </div>
                                    {aiTranslateError && (
                                        <div style={{ fontSize: "0.73rem", color: "var(--accent-danger)", padding: "4px 0" }}>
                                            {aiTranslateError}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── Verification History ── */}
                            {aiVerifications.length > 0 && (
                                <div style={{ display: "grid", gap: "6px", marginBottom: aiTranslations.length > 0 ? "8px" : "0" }}>
                                    <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-tertiary)" }}>
                                        Verification History ({aiVerifications.length})
                                    </div>
                                    {aiVerifications.map((v) => (
                                        <div
                                            key={v.index}
                                            style={{
                                                border: `1px solid ${v.answerKeyVerified ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                                                borderRadius: "8px",
                                                background: v.answerKeyVerified ? "rgba(34, 197, 94, 0.06)" : "rgba(239, 68, 68, 0.06)",
                                                overflow: "hidden",
                                            }}
                                        >
                                            <div
                                                onClick={() => setExpandedVerification(expandedVerification === v.index ? null : v.index)}
                                                style={{
                                                    padding: "8px 10px",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    cursor: "pointer",
                                                    fontSize: "0.76rem",
                                                }}
                                            >
                                                {v.answerKeyVerified ? (
                                                    <CheckCircle2 size={15} color="#4ade80" />
                                                ) : (
                                                    <XCircle size={15} color="#f87171" />
                                                )}
                                                <span style={{ fontWeight: 600, color: v.answerKeyVerified ? "#4ade80" : "#f87171" }}>
                                                    {v.answerKeyVerified ? "AI Verified ✓" : "Answer Key Mismatch ✗"}
                                                </span>
                                                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginLeft: "4px" }}>
                                                    #{v.index} • {v.modelLabel} ({API_KEY_PROVIDER_LABELS[v.provider as SupportedApiProvider] || v.provider})
                                                </span>
                                                <span style={{ marginLeft: "auto", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                                                    {new Date(v.verifiedAt).toLocaleString()}
                                                </span>
                                                {expandedVerification === v.index ? <ChevronUp size={14} color="var(--text-muted)" /> : <ChevronDown size={14} color="var(--text-muted)" />}
                                            </div>
                                            {expandedVerification === v.index && (
                                                <div style={{ padding: "0 10px 10px 10px", display: "grid", gap: "8px", fontSize: "0.76rem" }}>
                                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                                                        <div>
                                                            <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" }}>AI Answer</span>
                                                            <div style={{ color: "var(--text-primary)", marginTop: "2px" }}>{v.aiAnswer || "—"}</div>
                                                        </div>
                                                        <div>
                                                            <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" }}>Verdict</span>
                                                            <div style={{ color: "var(--text-primary)", marginTop: "2px" }}>{v.overallVerdict || "—"}</div>
                                                        </div>
                                                    </div>
                                                    {v.aiSuggestion && (
                                                        <div>
                                                            <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" }}>AI Suggestion</span>
                                                            <div style={{ color: "var(--text-secondary)", marginTop: "2px", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{v.aiSuggestion}</div>
                                                        </div>
                                                    )}
                                                    {v.aiSolution && (
                                                        <details>
                                                            <summary style={{ fontSize: "0.7rem", fontWeight: 600, color: "#a78bfa", cursor: "pointer", textTransform: "uppercase", padding: "4px 0" }}>
                                                                View AI Solution
                                                            </summary>
                                                            <MathContent
                                                                html={v.aiSolution}
                                                                className="question-html"
                                                                style={{ marginTop: "6px", padding: "10px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", fontSize: "0.82rem" }}
                                                            />
                                                        </details>
                                                    )}
                                                    <div style={{ display: "flex", gap: "16px", fontSize: "0.68rem", color: "var(--text-muted)" }}>
                                                        <span>Q Language: {v.questionLanguageQuality || "—"}</span>
                                                        <span>Solution Quality: {v.solutionLanguageQuality || "—"}</span>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* ── Translation History (grouped by language) ── */}
                            {(loadingTranslations || aiTranslations.length > 0) && (
                                <div style={{ display: "grid", gap: "6px" }}>
                                    <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: "6px" }}>
                                        Translations
                                        {loadingTranslations && <Loader2 size={12} className="animate-spin" />}
                                    </div>
                                    {aiTranslations.map((t) => {
                                        const optionsArr = Array.isArray(t.options) ? t.options : [];
                                        const isDefault = t.is_default;
                                        const isSettingDefault = settingDefaultId === t.id;
                                        const isDeleting = deletingTranslationId === t.id;
                                        return (
                                        <div
                                            key={t.id}
                                            style={{
                                                border: `1px solid ${isDefault ? "rgba(250, 204, 21, 0.5)" : "rgba(34, 197, 94, 0.2)"}`,
                                                borderRadius: "8px",
                                                background: isDefault ? "rgba(250, 204, 21, 0.05)" : "rgba(34, 197, 94, 0.04)",
                                                overflow: "hidden",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    padding: "8px 10px",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    fontSize: "0.76rem",
                                                }}
                                            >
                                                <Globe size={14} color="#4ade80" />
                                                <span style={{ fontWeight: 600, color: "#4ade80", textTransform: "capitalize" }}>
                                                    {t.language}
                                                </span>
                                                {isDefault && (
                                                    <span style={{ fontSize: "0.62rem", fontWeight: 700, color: "#fbbf24", background: "rgba(250, 204, 21, 0.15)", padding: "2px 6px", borderRadius: "10px", display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                                        <Star size={9} fill="#fbbf24" stroke="#fbbf24" />
                                                        DEFAULT
                                                    </span>
                                                )}
                                                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginLeft: "4px" }}>
                                                    {t.model_label || t.model_id || ""}
                                                    {t.provider ? ` (${API_KEY_PROVIDER_LABELS[t.provider as SupportedApiProvider] || t.provider})` : ""}
                                                </span>
                                                <span style={{ marginLeft: "auto", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                                                    {new Date(t.created_at).toLocaleString()}
                                                </span>
                                                {!isDefault && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleSetTranslationDefault(t.id)}
                                                        disabled={isSettingDefault || isDeleting}
                                                        title="Use this version when generating tests in this language"
                                                        style={{
                                                            display: "inline-flex", alignItems: "center", gap: "4px",
                                                            padding: "3px 8px", borderRadius: "6px",
                                                            border: "1px solid rgba(250, 204, 21, 0.35)",
                                                            background: "transparent", color: "#fbbf24",
                                                            fontSize: "0.65rem", fontWeight: 600, cursor: "pointer",
                                                        }}
                                                    >
                                                        {isSettingDefault ? <Loader2 size={10} className="animate-spin" /> : <Star size={10} />}
                                                        Set default
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => handleDeleteTranslation(t.id)}
                                                    disabled={isDeleting || isSettingDefault}
                                                    title="Delete this version"
                                                    style={{
                                                        display: "inline-flex", alignItems: "center",
                                                        padding: "3px 6px", borderRadius: "6px",
                                                        border: "1px solid rgba(239, 68, 68, 0.3)",
                                                        background: "transparent", color: "#f87171",
                                                        fontSize: "0.65rem", cursor: "pointer",
                                                    }}
                                                >
                                                    {isDeleting ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedTranslation(expandedTranslation === t.id ? null : t.id)}
                                                    style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 2px", display: "inline-flex", alignItems: "center" }}
                                                >
                                                    {expandedTranslation === t.id ? <ChevronUp size={14} color="var(--text-muted)" /> : <ChevronDown size={14} color="var(--text-muted)" />}
                                                </button>
                                            </div>
                                            {expandedTranslation === t.id && (
                                                <div style={{ padding: "0 10px 10px 10px", display: "grid", gap: "8px", fontSize: "0.76rem" }}>
                                                    <div>
                                                        <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" }}>Translated Question</span>
                                                        <MathContent
                                                            html={t.question_text}
                                                            className="question-html"
                                                            style={{ marginTop: "4px", padding: "8px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", fontSize: "0.82rem" }}
                                                        />
                                                    </div>
                                                    {optionsArr.length > 0 && (
                                                        <div>
                                                            <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" }}>Translated Options</span>
                                                            <div style={{ display: "grid", gap: "4px", marginTop: "4px" }}>
                                                                {optionsArr.map((o, oi) => (
                                                                    <div key={oi} style={{
                                                                        padding: "6px 8px",
                                                                        borderRadius: "6px",
                                                                        background: o.isCorrect ? "rgba(34, 197, 94, 0.08)" : "var(--bg-tertiary)",
                                                                        border: `1px solid ${o.isCorrect ? "rgba(34, 197, 94, 0.2)" : "var(--border-secondary)"}`,
                                                                        fontSize: "0.8rem",
                                                                    }}>
                                                                        <span style={{ fontWeight: 600, marginRight: "6px", color: o.isCorrect ? "#4ade80" : "var(--text-tertiary)" }}>
                                                                            {String.fromCharCode(65 + oi)}.
                                                                        </span>
                                                                        <MathContent html={o.text} className="question-html" style={{ display: "inline" }} />
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {t.solution_text && (
                                                        <details>
                                                            <summary style={{ fontSize: "0.7rem", fontWeight: 600, color: "#4ade80", cursor: "pointer", textTransform: "uppercase", padding: "4px 0" }}>
                                                                View Translated Solution
                                                            </summary>
                                                            <MathContent
                                                                html={t.solution_text}
                                                                className="question-html"
                                                                style={{ marginTop: "6px", padding: "10px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", fontSize: "0.82rem" }}
                                                            />
                                                        </details>
                                                    )}
                                                    {t.translation_notes && (
                                                        <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                                                            Notes: {t.translation_notes}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}

                    <section
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "10px",
                            background: "var(--bg-secondary)",
                            padding: "12px",
                            display: "grid",
                            gap: "10px",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                color: "var(--text-tertiary)",
                            }}
                        >
                            Metadata
                        </div>
                        <div
                            style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "12px",
                            }}
                        >
                            <label style={{ display: "grid", gap: "4px", flex: "1 1 160px" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Subject
                                </span>
                                {subjectOptions.length > 0 ? (
                                    <select
                                        value={metadata.subject}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                subject: event.target.value,
                                                chapter: "",
                                                topic: "",
                                                subtopic: "",
                                            }))
                                        }
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    >
                                        <option value="">Select Subject</option>
                                        {subjectOptions.map((subject) => (
                                            <option key={subject} value={subject}>
                                                {subject}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={metadata.subject}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                subject: event.target.value,
                                            }))
                                        }
                                        placeholder="Physics"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </label>

                            <label style={{ display: "grid", gap: "4px", flex: "1 1 160px" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Chapter
                                </span>
                                {chapterOptions.length > 0 ? (
                                    <select
                                        value={metadata.chapter}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                chapter: event.target.value,
                                                topic: "",
                                                subtopic: "",
                                            }))
                                        }
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    >
                                        <option value="">Select Chapter</option>
                                        {chapterOptions.map((chapter) => (
                                            <option key={chapter} value={chapter}>
                                                {chapter}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={metadata.chapter}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                chapter: event.target.value,
                                            }))
                                        }
                                        placeholder="Kinematics"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </label>

                            <label style={{ display: "grid", gap: "4px", flex: "1 1 160px" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Topic
                                </span>
                                {topicOptions.length > 0 ? (
                                    <select
                                        value={metadata.topic}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                topic: event.target.value,
                                                subtopic: "",
                                            }))
                                        }
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    >
                                        <option value="">Select Topic</option>
                                        {topicOptions.map((topic) => (
                                            <option key={topic} value={topic}>
                                                {topic}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={metadata.topic}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                topic: event.target.value,
                                            }))
                                        }
                                        placeholder="Motion in One Dimension"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </label>

                            <label style={{ display: "grid", gap: "4px", flex: "1 1 160px" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Difficulty
                                </span>
                                {difficultyOptions.length > 0 ? (
                                    <select
                                        value={metadata.difficultyLevel}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                difficultyLevel: event.target.value,
                                            }))
                                        }
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    >
                                        <option value="">Select Difficulty</option>
                                        {difficultyOptions.map((difficulty) => (
                                            <option key={difficulty} value={difficulty}>
                                                {difficulty}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={metadata.difficultyLevel}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                difficultyLevel: event.target.value,
                                            }))
                                        }
                                        placeholder="Easy / Medium / Hard"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </label>

                            <label style={{ display: "grid", gap: "4px", flex: "1 1 160px" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Class Level
                                </span>
                                {classLevelOptions.length > 0 ? (
                                    <select
                                        value={metadata.classLevel}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                classLevel: event.target.value,
                                            }))
                                        }
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    >
                                        <option value="">Select Class</option>
                                        {classLevelOptions.map((classLevel) => (
                                            <option key={classLevel} value={classLevel}>
                                                {classLevel}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={metadata.classLevel}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                classLevel: event.target.value,
                                            }))
                                        }
                                        placeholder="11 / 12"
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </label>

                            {METADATA_FIELDS.filter(
                                (field) =>
                                    ![
                                        "subject",
                                        "chapter",
                                        "topic",
                                        "difficultyLevel",
                                        "classLevel",
                                    ].includes(field.key)
                            ).map((field) => (
                                <label key={field.key} style={{ display: "grid", gap: "4px" }}>
                                    <span
                                        style={{
                                            fontSize: "0.7rem",
                                            color: "var(--text-tertiary)",
                                            fontWeight: 600,
                                        }}
                                    >
                                        {field.label}
                                    </span>
                                    <input
                                        value={metadata[field.key]}
                                        onChange={(event) =>
                                            setMetadata((current) => ({
                                                ...current,
                                                [field.key]: event.target.value,
                                            }))
                                        }
                                        placeholder={field.placeholder}
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.78rem",
                                            padding: "7px 9px",
                                            outline: "none",
                                        }}
                                    />
                                </label>
                            ))}
                            <label style={{ display: "grid", gap: "4px", gridColumn: "1 / -1" }}>
                                <span
                                    style={{
                                        fontSize: "0.7rem",
                                        color: "var(--text-tertiary)",
                                        fontWeight: 600,
                                    }}
                                >
                                    Exams (comma separated)
                                </span>
                                <input
                                    value={examsText}
                                    onChange={(event) => setExamsText(event.target.value)}
                                    placeholder="JEE Mains, JEE Advanced"
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-tertiary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "7px 9px",
                                        outline: "none",
                                    }}
                                />
                            </label>
                        </div>
                    </section>
                    </>)}
                </div>

                <div
                    style={{
                        borderTop: "1px solid var(--border-primary)",
                        padding: "12px 16px",
                        display: activeTab === "edit" ? "flex" : "none",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                    }}
                >
                    <div
                        style={{
                            minHeight: "20px",
                            fontSize: "0.75rem",
                            color: "var(--accent-danger)",
                        }}
                    >
                        {errorMessage}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={saving}
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "8px",
                                background: "var(--bg-secondary)",
                                color: "var(--text-secondary)",
                                padding: "8px 14px",
                                fontSize: "0.8rem",
                                cursor: saving ? "default" : "pointer",
                                opacity: saving ? 0.7 : 1,
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void handleSave();
                            }}
                            disabled={saving}
                            style={{
                                border: "1px solid var(--accent-primary)",
                                borderRadius: "8px",
                                background: "var(--accent-primary)",
                                color: "#fff",
                                padding: "8px 14px",
                                fontSize: "0.8rem",
                                fontWeight: 700,
                                cursor: saving ? "default" : "pointer",
                                opacity: saving ? 0.8 : 1,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                            }}
                        >
                            {saving && <Loader2 size={14} className="animate-spin" />}
                            {saving ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
