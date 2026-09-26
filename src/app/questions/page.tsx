"use client";

import { useState, useEffect, useCallback, useRef, Suspense, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
    Search,
    ChevronLeft,
    ChevronRight,
    Loader2,
    AlertCircle,
    SlidersHorizontal,
    Pencil,
    X,
    PlusCircle,
    Sparkles,
    FileUp,
    RefreshCw,
    CheckSquare,
    Square,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import QuestionCard from "@/components/questions/QuestionCard";
import QuestionEditModal, {
    type QuestionEditorDraft,
    type QuestionEditorMetadataDraft,
    type QuestionEditorOptionDraft,
    type AiMetadata,
} from "@/components/questions/QuestionEditModal";
import FilterPanel from "@/components/questions/FilterPanel";
import type { MetadataHierarchy, Question, FilterState } from "@/types";
import { EMPTY_FILTERS } from "@/types";
import { AI_PROVIDER_MODELS, type ModelOption } from "@/types/extraction";
import { useCurrentUser } from "@/context/UserProfileContext";
import {
    API_KEY_PROVIDER_LABELS,
    CHAT_API_PROVIDERS,
    EMPTY_USER_API_KEYS,
    readDevApiKeysFromStorage,
    type ChatApiProvider,
    type SupportedApiProvider,
    type UserApiKeys,
} from "@/lib/userApiKeys";

/* ── helpers to read/write filter state from URL search params ── */

const ARRAY_FILTER_KEYS = [
    "subjects",
    "chapters",
    "topics",
    "subtopics",
    "question_types",
    "difficulty_levels",
    "sources",
    "class_levels",
    "statuses",
] as const;

function filtersFromParams(params: URLSearchParams): FilterState {
    const f: FilterState = { ...EMPTY_FILTERS };
    for (const key of ARRAY_FILTER_KEYS) {
        const raw = params.get(key);
        if (raw) {
            // Statuses are a typed enum; cast is safe because invalid values get
            // ignored by the API filter (the .in() simply yields no matches).
            f[key] = raw.split(",") as never;
        }
    }
    f.search = params.get("search") || "";
    return f;
}

function filtersToParams(
    f: FilterState,
    page: number,
    pageSize: number
): URLSearchParams {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    // pageSize is always default, so skip it in URL to keep it clean
    for (const key of ARRAY_FILTER_KEYS) {
        if (f[key].length) params.set(key, (f[key] as string[]).join(","));
    }
    if (f.search) params.set("search", f.search);
    return params;
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

function toAnswerKeyText(answerKey: Question["answer_key"]): string {
    if (Array.isArray(answerKey)) return answerKey.join(", ");
    return answerKey === null || answerKey === undefined ? "" : String(answerKey);
}

interface QuestionsResponse {
    questions: Question[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

interface CreateQuestionPayload {
    question_text: string;
    options: Array<{ text: string | null; isCorrect: boolean | null }>;
    answer_key: number | number[] | null;
    solution_text: string;
    question_type: string;
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string | null;
    source: string;
    difficutly_level: string;
    class_level: string | null;
    exam: string[] | null;
}

const EMPTY_METADATA: MetadataHierarchy = {
    subjects: [],
    chaptersBySubject: {},
    topicsByChapter: {},
    subtopicsByTopic: {},
    questionTypes: [],
    difficultyLevels: [],
    sources: [],
    exams: [],
    classLevels: [],
};

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

function normalizeMetadata(data: unknown): MetadataHierarchy {
    const obj = (data && typeof data === "object" ? data : {}) as Partial<MetadataHierarchy>;
    return {
        subjects: Array.isArray(obj.subjects) ? obj.subjects : [],
        chaptersBySubject:
            obj.chaptersBySubject && typeof obj.chaptersBySubject === "object"
                ? obj.chaptersBySubject
                : {},
        topicsByChapter:
            obj.topicsByChapter && typeof obj.topicsByChapter === "object"
                ? obj.topicsByChapter
                : {},
        subtopicsByTopic:
            obj.subtopicsByTopic && typeof obj.subtopicsByTopic === "object"
                ? obj.subtopicsByTopic
                : {},
        questionTypes: Array.isArray(obj.questionTypes) ? obj.questionTypes : [],
        difficultyLevels: Array.isArray(obj.difficultyLevels) ? obj.difficultyLevels : [],
        sources: Array.isArray(obj.sources) ? obj.sources : [],
        exams: Array.isArray(obj.exams) ? obj.exams : [],
        classLevels: Array.isArray(obj.classLevels) ? obj.classLevels : [],
    };
}

// Cache the filter hierarchy in localStorage so the filters render instantly on
// revisit (the /api/metadata aggregation over the whole bank is slow). Same
// cache-first pattern the Analytics tab uses: paint cached data immediately,
// then refresh in the background.
const METADATA_CACHE_KEY = "qbg_questions_metadata_cache";

function readMetadataCache(): MetadataHierarchy | null {
    try {
        const raw = localStorage.getItem(METADATA_CACHE_KEY);
        if (!raw) return null;
        return normalizeMetadata(JSON.parse(raw));
    } catch {
        return null;
    }
}

function writeMetadataCache(data: MetadataHierarchy): void {
    try {
        localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(data));
    } catch {
        /* quota / unavailable — non-fatal */
    }
}

function looksLikeBulkImportSource(source: string): boolean {
    const normalized = source.trim().toLowerCase();
    return (
        normalized.endsWith(".pdf") ||
        normalized.includes(".pdf ") ||
        normalized.includes("uploaded pdf") ||
        normalized.includes("upload")
    );
}

function HomeContent() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { can } = useCurrentUser();

    // Initialise state from URL search params so Back-navigation restores filters
    const [activeTab, setActiveTab] = useState("questions");
    const [filters, setFilters] = useState<FilterState>(() =>
        filtersFromParams(searchParams)
    );
    const [searchInput, setSearchInput] = useState(
        () => searchParams.get("search") || ""
    );
    const [page, setPage] = useState(
        () => Number(searchParams.get("page")) || 1
    );
    const [pageSize] = useState(20);
    const [data, setData] = useState<QuestionsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
    const [savingQuestionEdit, setSavingQuestionEdit] = useState(false);
    const [showFilterPanel, setShowFilterPanel] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [savingManualCreate, setSavingManualCreate] = useState(false);
    const [showAIModal, setShowAIModal] = useState(false);
    const [savingAICreatedQuestions, setSavingAICreatedQuestions] = useState(false);
    const [generatingAIQuestions, setGeneratingAIQuestions] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [generatedQuestions, setGeneratedQuestions] = useState<CreateQuestionPayload[]>([]);
    const [selectedGeneratedIndexes, setSelectedGeneratedIndexes] = useState<Set<number>>(
        new Set()
    );
    const [metadata, setMetadata] = useState<MetadataHierarchy>(EMPTY_METADATA);
    const [metadataLoading, setMetadataLoading] = useState(true);
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    const [aiProvider, setAiProvider] = useState<ChatApiProvider>("gemini");
    const [providerModels, setProviderModels] = useState<Record<ChatApiProvider, ModelOption[]>>(
        { ...DEFAULT_PROVIDER_MODELS }
    );
    const [loadingModels, setLoadingModels] = useState(false);
    const [aiModelError, setAiModelError] = useState<string | null>(null);
    const [aiCount, setAiCount] = useState(5);
    const [aiQuestionType, setAiQuestionType] = useState("Single_Choice(SCQ)");
    const [aiSubject, setAiSubject] = useState("");
    const [aiChapter, setAiChapter] = useState("");
    const [aiTopic, setAiTopic] = useState("");
    const [aiSubtopic, setAiSubtopic] = useState("");
    const [aiDifficulty, setAiDifficulty] = useState("Medium");
    const [aiSource, setAiSource] = useState("AI Generated");
    const [aiModelId, setAiModelId] = useState(
        DEFAULT_PROVIDER_MODELS.gemini[0]?.id || ""
    );
    const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const modelRequestRef = useRef(0);
    const questionsContainerRef = useRef<HTMLDivElement>(null);

    // Build query string from filters (for the /api/ call)
    const buildQueryString = useCallback(
        (f: FilterState, p: number) => {
            const params = new URLSearchParams();
            params.set("page", String(p));
            params.set("pageSize", String(pageSize));
            for (const key of ARRAY_FILTER_KEYS) {
                if (f[key].length) params.set(key, (f[key] as string[]).join(","));
            }
            if (f.search) params.set("search", f.search);
            return params.toString();
        },
        [pageSize]
    );

    // Persist filters + page into URL search params (replace, no scroll)
    const syncUrl = useCallback(
        (f: FilterState, p: number) => {
            const newParams = filtersToParams(f, p, pageSize);
            const qs = newParams.toString();
            const url = qs ? `${pathname}?${qs}` : pathname;
            router.replace(url, { scroll: false });
        },
        [pathname, router, pageSize]
    );

    // Fetch questions
    const fetchQuestions = useCallback(
        async (f: FilterState, p: number) => {
            setLoading(true);
            setError(null);
            try {
                const qs = buildQueryString(f, p);
                const res = await fetch(`/api/questions?${qs}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json: QuestionsResponse = await res.json();
                setData(json);
                return json;
            } catch (err) {
                console.error("Failed to fetch questions:", err);
                setError(String(err));
                return null;
            } finally {
                setLoading(false);
            }
        },
        [buildQueryString]
    );

    useEffect(() => {
        let cancelled = false;

        const applyDefaults = (payload: MetadataHierarchy) => {
            if (!aiSubject && payload.subjects.length > 0) {
                setAiSubject(payload.subjects[0]);
            }
            if (!aiQuestionType && payload.questionTypes && payload.questionTypes.length > 0) {
                setAiQuestionType(payload.questionTypes[0]);
            }
            if (!aiDifficulty && payload.difficultyLevels.length > 0) {
                setAiDifficulty(payload.difficultyLevels[0]);
            }
        };

        // 1) Paint cached filters immediately so the UI isn't blocked on the
        //    slow aggregation when revisiting the tab.
        const cached = readMetadataCache();
        if (cached && cached.subjects.length > 0) {
            setMetadata(cached);
            applyDefaults(cached);
            setMetadataLoading(false);
        }

        // 2) Refresh in the background and update the cache.
        async function loadMetadata() {
            try {
                if (!cached) setMetadataLoading(true);
                const response = await fetch("/api/metadata", { cache: "no-store" });
                if (!response.ok) throw new Error(`Metadata API failed: HTTP ${response.status}`);
                const payload = normalizeMetadata(await response.json());
                if (cancelled) return;
                setMetadata(payload);
                writeMetadataCache(payload);
                applyDefaults(payload);
            } catch (metadataError) {
                console.error("Failed to load metadata for questions page:", metadataError);
                if (!cancelled && !cached) setMetadata(EMPTY_METADATA);
            } finally {
                if (!cancelled) setMetadataLoading(false);
            }
        }

        void loadMetadata();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setUserApiKeys(readDevApiKeysFromStorage());

        async function loadUserApiKeys() {
            try {
                const response = await fetch("/api/user/api-keys", {
                    method: "GET",
                    cache: "no-store",
                });
                if (!response.ok) return;
                const payload = (await response.json()) as {
                    success?: boolean;
                    apiKeys?: unknown;
                };
                if (!cancelled && payload.success && payload.apiKeys && typeof payload.apiKeys === "object") {
                    setUserApiKeys((current) => ({ ...current, ...(payload.apiKeys as UserApiKeys) }));
                }
            } catch (apiKeysError) {
                console.error("Failed to load user API keys:", apiKeysError);
            }
        }

        void loadUserApiKeys();
        return () => {
            cancelled = true;
        };
    }, []);

    const loadLiveModels = useCallback(
        async (provider: ChatApiProvider) => {
            const requestId = Date.now();
            modelRequestRef.current = requestId;
            setLoadingModels(true);
            setAiModelError(null);

            try {
                const headers: HeadersInit = {};
                const providerApiKey = (userApiKeys[provider] || "").trim();
                if (providerApiKey) headers["x-dev-api-key"] = providerApiKey;

                const response = await fetch(
                    `/api/upload/models?provider=${encodeURIComponent(provider)}`,
                    {
                        method: "GET",
                        cache: "no-store",
                        headers,
                    }
                );
                const payload = (await response.json()) as {
                    success?: boolean;
                    models?: ModelOption[];
                    error?: string;
                };

                if (!response.ok || !payload.success) {
                    throw new Error(payload.error || `Could not load models for ${provider}.`);
                }

                const loadedModels = payload.models || DEFAULT_PROVIDER_MODELS[provider];
                if (modelRequestRef.current !== requestId) return;
                setProviderModels((current) => ({
                    ...current,
                    [provider]: loadedModels.length
                        ? loadedModels
                        : DEFAULT_PROVIDER_MODELS[provider],
                }));
            } catch (modelError) {
                if (modelRequestRef.current !== requestId) return;
                setProviderModels((current) => ({
                    ...current,
                    [provider]: DEFAULT_PROVIDER_MODELS[provider],
                }));
                setAiModelError(modelError instanceof Error ? modelError.message : String(modelError));
            } finally {
                if (modelRequestRef.current === requestId) {
                    setLoadingModels(false);
                }
            }
        },
        [userApiKeys]
    );

    useEffect(() => {
        if (!showAIModal) return;
        void loadLiveModels(aiProvider);
    }, [aiProvider, showAIModal, loadLiveModels]);

    useEffect(() => {
        const currentModels = providerModels[aiProvider] || DEFAULT_PROVIDER_MODELS[aiProvider];
        if (!currentModels.length) return;
        const hasModel = currentModels.some((model) => model.id === aiModelId);
        if (!hasModel) {
            setAiModelId(currentModels[0].id);
        }
    }, [aiProvider, providerModels, aiModelId]);

    const aiAvailableChapters = useMemo(
        () => (aiSubject ? metadata.chaptersBySubject[aiSubject] || [] : []),
        [aiSubject, metadata.chaptersBySubject]
    );
    const aiAvailableTopics = useMemo(
        () => (aiChapter ? metadata.topicsByChapter[aiChapter] || [] : []),
        [aiChapter, metadata.topicsByChapter]
    );
    const aiAvailableSubtopics = useMemo(
        () => (aiTopic ? metadata.subtopicsByTopic[aiTopic] || [] : []),
        [aiTopic, metadata.subtopicsByTopic]
    );
    const bulkImportSources = useMemo(() => {
        const likelyBulkSources = metadata.sources.filter(looksLikeBulkImportSource);
        const list = likelyBulkSources.length ? likelyBulkSources : metadata.sources;
        return list.slice(0, 40);
    }, [metadata.sources]);

    useEffect(() => {
        if (aiChapter && !aiAvailableChapters.includes(aiChapter)) {
            setAiChapter("");
        }
    }, [aiAvailableChapters, aiChapter]);

    useEffect(() => {
        if (aiTopic && !aiAvailableTopics.includes(aiTopic)) {
            setAiTopic("");
        }
    }, [aiAvailableTopics, aiTopic]);

    useEffect(() => {
        if (aiSubtopic && !aiAvailableSubtopics.includes(aiSubtopic)) {
            setAiSubtopic("");
        }
    }, [aiAvailableSubtopics, aiSubtopic]);

    const pushQuestionsToFirstPage = useCallback(
        async (newQuestions: Question[]) => {
            if (!newQuestions.length) return;
            const baseFilters = { ...EMPTY_FILTERS };
            setFilters(baseFilters);
            setSearchInput("");
            setPage(1);
            syncUrl(baseFilters, 1);

            const refreshed = await fetchQuestions(baseFilters, 1);
            if (!refreshed) return;

            const dedup = new Map<string, Question>();
            newQuestions.forEach((question) => dedup.set(question.question_id, question));
            refreshed.questions.forEach((question) => {
                if (!dedup.has(question.question_id)) dedup.set(question.question_id, question);
            });

            const mergedQuestions = Array.from(dedup.values());
            const mergedTotal = Math.max(refreshed.total, mergedQuestions.length);
            setData({
                ...refreshed,
                questions: mergedQuestions.slice(0, refreshed.pageSize),
                total: mergedTotal,
                totalPages: Math.max(1, Math.ceil(mergedTotal / refreshed.pageSize)),
            });
        },
        [fetchQuestions, syncUrl]
    );

    const applySourceFilter = useCallback(
        (source: string) => {
            const nextFilters = { ...EMPTY_FILTERS, sources: [source] };
            setFilters(nextFilters);
            setSearchInput("");
            setPage(1);
            syncUrl(nextFilters, 1);
            void fetchQuestions(nextFilters, 1);
        },
        [fetchQuestions, syncUrl]
    );

    const clearSourceFilter = useCallback(() => {
        const nextFilters = { ...EMPTY_FILTERS };
        setFilters(nextFilters);
        setSearchInput("");
        setPage(1);
        syncUrl(nextFilters, 1);
        void fetchQuestions(nextFilters, 1);
    }, [fetchQuestions, syncUrl]);

    // Initial load — uses filters already parsed from URL params
    useEffect(() => {
        fetchQuestions(filters, page);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // When filters change, reset to page 1
    const handleFiltersChange = useCallback(
        (newFilters: FilterState) => {
            setFilters(newFilters);
            setPage(1);
            syncUrl(newFilters, 1);
            fetchQuestions(newFilters, 1);
        },
        [fetchQuestions, syncUrl]
    );

    // Debounced search
    const handleSearchChange = useCallback(
        (value: string) => {
            setSearchInput(value);
            if (searchTimeout.current) clearTimeout(searchTimeout.current);
            searchTimeout.current = setTimeout(() => {
                const newFilters = { ...filters, search: value };
                setFilters(newFilters);
                setPage(1);
                syncUrl(newFilters, 1);
                fetchQuestions(newFilters, 1);
            }, 400);
        },
        [filters, fetchQuestions, syncUrl]
    );

    // Page change
    const handlePageChange = useCallback(
        (newPage: number) => {
            setPage(newPage);
            syncUrl(filters, newPage);
            fetchQuestions(filters, newPage);
            // Scroll to top of questions list
            questionsContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        },
        [filters, fetchQuestions, syncUrl]
    );

    const getDraftOptions = useCallback((question: Question | null): QuestionEditorOptionDraft[] => {
        if (!question) return [];
        return (question.options || [])
            .filter((opt) => opt?.text !== null)
            .map((opt) => ({
                text: String(opt?.text || ""),
                isCorrect: opt?.isCorrect === true,
            }));
    }, []);

    const buildCreatePayloadFromDraft = useCallback(
        (draft: QuestionEditorDraft, fallbackSource: string): CreateQuestionPayload => {
            const questionType = draft.metadata?.questionType || "Single_Choice(SCQ)";
            const numericalType = isNumericalQuestionType(questionType);
            const parsedNumericAnswer = Number((draft.answerKeyText || "").trim());
            const optionRows = numericalType
                ? []
                : draft.options.map((option) => ({
                    text: option.text.trim() ? option.text : null,
                    isCorrect: option.text.trim() ? option.isCorrect : false,
                }));

            const selectedAnswers = numericalType
                ? []
                : optionRows
                    .map((option, optionIndex) => (option.isCorrect ? optionIndex + 1 : null))
                    .filter((value): value is number => value !== null);

            return {
                question_text: draft.questionText,
                options: optionRows,
                answer_key: numericalType
                    ? Number.isFinite(parsedNumericAnswer)
                        ? parsedNumericAnswer
                        : null
                    : selectedAnswers.length > 0
                        ? selectedAnswers
                        : null,
                solution_text: draft.solutionText,
                question_type: questionType,
                subject: draft.metadata?.subject || "",
                chapter: draft.metadata?.chapter || "",
                topic: draft.metadata?.topic || "",
                subtopic: draft.metadata?.subtopic?.trim() || null,
                source: draft.metadata?.source?.trim() || fallbackSource,
                difficutly_level: draft.metadata?.difficultyLevel || "Medium",
                class_level: draft.metadata?.classLevel?.trim() || null,
                exam: draft.metadata?.exams?.length ? draft.metadata.exams : null,
            };
        },
        []
    );

    const handleCreateQuestion = useCallback(
        async (draft: QuestionEditorDraft) => {
            setSavingManualCreate(true);
            setError(null);
            try {
                const payload = buildCreatePayloadFromDraft(draft, "Manual Entry");
                const response = await fetch("/api/questions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ question: payload }),
                });
                const result = (await response.json()) as {
                    success?: boolean;
                    questions?: Question[];
                    error?: string;
                };

                if (!response.ok || !result.success || !result.questions?.length) {
                    throw new Error(result.error || `Failed to create question (HTTP ${response.status})`);
                }

                setShowCreateModal(false);
                await pushQuestionsToFirstPage(result.questions);
            } catch (creationError) {
                setError(
                    creationError instanceof Error
                        ? creationError.message
                        : String(creationError)
                );
            } finally {
                setSavingManualCreate(false);
            }
        },
        [buildCreatePayloadFromDraft, pushQuestionsToFirstPage]
    );

    const handleGenerateAIQuestions = useCallback(async () => {
        if (!aiModelId.trim()) {
            setAiError("Select an AI model.");
            return;
        }
        if (!aiQuestionType.trim()) {
            setAiError("Select a question type.");
            return;
        }
        if (!aiSubject.trim()) {
            setAiError("Select a subject.");
            return;
        }

        setGeneratingAIQuestions(true);
        setAiError(null);
        try {
            const headers: HeadersInit = {
                "Content-Type": "application/json",
            };
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            if (providerApiKey) headers["x-dev-api-key"] = providerApiKey;

            const response = await fetch("/api/questions/generate-ai", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    provider: aiProvider,
                    modelId: aiModelId,
                    count: aiCount,
                    questionType: aiQuestionType,
                    subject: aiSubject,
                    chapter: aiChapter,
                    topic: aiTopic,
                    subtopic: aiSubtopic,
                    difficultyLevel: aiDifficulty,
                    source: aiSource || "AI Generated",
                    ...(aiProvider === "local" ? { localBaseUrl: providerApiKey || "http://localhost:11434/v1" } : {}),
                }),
            });

            const result = (await response.json()) as {
                success?: boolean;
                questions?: CreateQuestionPayload[];
                error?: string;
            };
            if (!response.ok || !result.success) {
                throw new Error(result.error || `AI generation failed (HTTP ${response.status})`);
            }

            const questions = result.questions || [];
            setGeneratedQuestions(questions);
            setSelectedGeneratedIndexes(new Set(questions.map((_, index) => index)));
            if (!questions.length) {
                setAiError("AI returned zero questions. Try again with a different model or prompt constraints.");
            }
        } catch (generationError) {
            setAiError(
                generationError instanceof Error ? generationError.message : String(generationError)
            );
        } finally {
            setGeneratingAIQuestions(false);
        }
    }, [
        aiCount,
        aiDifficulty,
        aiModelId,
        aiProvider,
        aiQuestionType,
        aiSource,
        aiSubject,
        aiChapter,
        aiTopic,
        aiSubtopic,
        userApiKeys,
    ]);

    const handleSaveSelectedAIQuestions = useCallback(async () => {
        const selected = generatedQuestions.filter((_, index) =>
            selectedGeneratedIndexes.has(index)
        );
        if (selected.length === 0) {
            setAiError("Select at least one generated question to save.");
            return;
        }

        setSavingAICreatedQuestions(true);
        setAiError(null);
        try {
            const response = await fetch("/api/questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: selected }),
            });
            const result = (await response.json()) as {
                success?: boolean;
                questions?: Question[];
                error?: string;
            };
            if (!response.ok || !result.success || !result.questions?.length) {
                throw new Error(result.error || `Failed to save AI questions (HTTP ${response.status})`);
            }

            setShowAIModal(false);
            setGeneratedQuestions([]);
            setSelectedGeneratedIndexes(new Set());
            await pushQuestionsToFirstPage(result.questions);
        } catch (saveError) {
            setAiError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setSavingAICreatedQuestions(false);
        }
    }, [generatedQuestions, pushQuestionsToFirstPage, selectedGeneratedIndexes]);

    const generatedPreviewQuestions = useMemo(
        () =>
            generatedQuestions.map((draft, index) => ({
                question_id: `ai-generated-${index}`,
                qbg_id: `ai-generated-${index}`,
                question_text: draft.question_text,
                options: draft.options,
                answer_key: draft.answer_key ?? [],
                solution_text: draft.solution_text,
                question_type: draft.question_type,
                subject: draft.subject,
                chapter: draft.chapter,
                topic: draft.topic,
                source: draft.source,
                difficutly_level: draft.difficutly_level,
                parent_question_id: null,
                raw_data: null,
                exam: draft.exam,
                class_level: draft.class_level,
                subtopic: draft.subtopic,
            } satisfies Question)),
        [generatedQuestions]
    );

    const toggleGeneratedSelection = useCallback((index: number) => {
        setSelectedGeneratedIndexes((current) => {
            const next = new Set(current);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }, []);

    const selectAllGenerated = useCallback(() => {
        setSelectedGeneratedIndexes(new Set(generatedQuestions.map((_, index) => index)));
    }, [generatedQuestions]);

    const clearGeneratedSelections = useCallback(() => {
        setSelectedGeneratedIndexes(new Set());
    }, []);

    const handleSaveQuestionEdit = useCallback(
        async (draft: QuestionEditorDraft) => {
            if (!editingQuestion) return;
            setSavingQuestionEdit(true);
            try {
                const numericType = isNumericalQuestionType(
                    draft.metadata?.questionType || editingQuestion.question_type
                );
                const sanitizedOptions =
                    draft.options.length > 0
                        ? draft.options.map((opt) => ({
                              text: opt.text.trim() ? opt.text : null,
                              isCorrect: opt.text.trim() ? opt.isCorrect : false,
                          }))
                        : editingQuestion.options;
                const parsedNumericAnswer = Number((draft.answerKeyText || "").trim());
                const numericAnswerKey =
                    numericType && (draft.answerKeyText || "").trim().length > 0 && Number.isFinite(parsedNumericAnswer)
                        ? parsedNumericAnswer
                        : editingQuestion.answer_key;
                const selectedAnswers =
                    draft.options.length > 0
                        ? draft.options
                              .map((opt, index) => (opt.isCorrect ? index + 1 : null))
                              .filter((value): value is number => value !== null)
                        : [];

                const response = await fetch(`/api/questions/${editingQuestion.question_id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        question_text: draft.questionText,
                        solution_text: draft.solutionText,
                        options: sanitizedOptions,
                        answer_key:
                            numericType
                                ? numericAnswerKey
                                : selectedAnswers.length > 0
                                ? selectedAnswers
                                : editingQuestion.answer_key,
                        subject: draft.metadata?.subject || editingQuestion.subject,
                        chapter: draft.metadata?.chapter || editingQuestion.chapter,
                        topic: draft.metadata?.topic || editingQuestion.topic,
                        subtopic: draft.metadata?.subtopic || null,
                        source: draft.metadata?.source || editingQuestion.source,
                        question_type:
                            draft.metadata?.questionType || editingQuestion.question_type,
                        difficutly_level:
                            draft.metadata?.difficultyLevel || editingQuestion.difficutly_level,
                        class_level:
                            draft.metadata?.classLevel || editingQuestion.class_level || null,
                        exam:
                            draft.metadata?.exams?.length
                                ? draft.metadata.exams
                                : editingQuestion.exam,
                    }),
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    question?: Question;
                    error?: string;
                };

                if (!response.ok || !payload.success || !payload.question) {
                    throw new Error(payload.error || `Failed to update question (HTTP ${response.status})`);
                }

                const updatedQuestion = payload.question;
                setData((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        questions: prev.questions.map((question) =>
                            question.question_id === updatedQuestion.question_id
                                ? updatedQuestion
                                : question
                        ),
                    };
                });
                setEditingQuestion(null);
            } catch (err) {
                setError(String(err));
            } finally {
                setSavingQuestionEdit(false);
            }
        },
        [editingQuestion]
    );

    const handleAiMetadataUpdate = useCallback(
        async (aiMeta: AiMetadata) => {
            if (!editingQuestion) return;
            try {
                // Merge ai_metadata into existing raw_data
                const existingRaw = editingQuestion.raw_data;
                let rawObj: Record<string, unknown>;
                if (Array.isArray(existingRaw) && existingRaw.length > 0 && typeof existingRaw[0] === "object") {
                    rawObj = { ...(existingRaw[0] as Record<string, unknown>) };
                } else if (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)) {
                    rawObj = { ...(existingRaw as Record<string, unknown>) };
                } else {
                    rawObj = {};
                }
                rawObj.ai_metadata = aiMeta;

                const newRawData = Array.isArray(existingRaw)
                    ? [rawObj, ...existingRaw.slice(1)]
                    : rawObj;

                const response = await fetch(`/api/questions/${editingQuestion.question_id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ raw_data: newRawData }),
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    question?: Question;
                    error?: string;
                };

                if (!response.ok || !payload.success || !payload.question) {
                    console.error("Failed to save AI metadata:", payload.error);
                    return;
                }

                const updatedQuestion = payload.question;
                setEditingQuestion(updatedQuestion);
                setData((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        questions: prev.questions.map((question) =>
                            question.question_id === updatedQuestion.question_id
                                ? updatedQuestion
                                : question
                        ),
                    };
                });
            } catch (err) {
                console.error("Error saving AI metadata:", err);
            }
        },
        [editingQuestion]
    );

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            {/* Sidebar */}
            <Sidebar
                activeTab={activeTab}
                onTabChange={(id) => {
                    if (id === "tests") router.push("/tests");
                    else if (id === "analytics") router.push("/analytics");
                    else if (id === "upload") router.push("/upload");
                    else if (id === "ai") router.push("/ai-tools");
                    else if (id === "admin") router.push("/admin/users");
                    else if (id === "agentic-qc") router.push("/agentic-qc");
                    else if (id === "qbg") router.push("/qbg");
                    else if (id === "video-solution") router.push("/video-solution");
                    else if (id === "question-wise-videos") router.push("/question-wise-videos");
                    else if (id === "circuit-designer") router.push("/circuit-designer");
                    else setActiveTab(id);
                }}
            />

            {/* Main area */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                {/* Top bar */}
                <header
                    className="glass"
                    style={{
                        padding: "12px 24px",
                        display: "flex",
                        alignItems: "center",
                        gap: "16px",
                        borderBottom: "1px solid var(--border-primary)",
                        zIndex: 30,
                    }}
                >
                    {/* Filter toggle */}
                    <button
                        onClick={() => setShowFilterPanel(!showFilterPanel)}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "36px",
                            height: "36px",
                            borderRadius: "8px",
                            border: "1px solid var(--border-primary)",
                            background: showFilterPanel
                                ? "var(--accent-glow)"
                                : "transparent",
                            color: showFilterPanel
                                ? "var(--accent-primary)"
                                : "var(--text-secondary)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                        }}
                        title="Toggle filters"
                    >
                        <SlidersHorizontal size={18} />
                    </button>

                    {/* Search bar */}
                    <div
                        style={{
                            flex: 1,
                            maxWidth: "600px",
                            position: "relative",
                        }}
                    >
                        <Search
                            size={16}
                            style={{
                                position: "absolute",
                                left: "12px",
                                top: "50%",
                                transform: "translateY(-50%)",
                                color: "var(--text-muted)",
                            }}
                        />
                        <input
                            type="text"
                            placeholder="Search questions..."
                            value={searchInput}
                            onChange={(e) => handleSearchChange(e.target.value)}
                            style={{
                                width: "100%",
                                padding: "9px 12px 9px 38px",
                                borderRadius: "10px",
                                border: "1px solid var(--border-primary)",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                fontSize: "0.88rem",
                                outline: "none",
                                transition: "all 0.15s ease",
                            }}
                            onFocus={(e) => {
                                e.currentTarget.style.borderColor = "var(--accent-primary)";
                                e.currentTarget.style.boxShadow = "var(--shadow-glow)";
                            }}
                            onBlur={(e) => {
                                e.currentTarget.style.borderColor = "var(--border-primary)";
                                e.currentTarget.style.boxShadow = "none";
                            }}
                        />
                        {searchInput && (
                            <button
                                onClick={() => handleSearchChange("")}
                                style={{
                                    position: "absolute",
                                    right: "8px",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    background: "none",
                                    border: "none",
                                    color: "var(--text-muted)",
                                    cursor: "pointer",
                                    padding: "4px",
                                    borderRadius: "4px",
                                }}
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    {/* Actions */}
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginLeft: "auto",
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                        }}
                    >
                        {can("manual_question_entry") && (
                        <button
                            type="button"
                            onClick={() => setShowCreateModal(true)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "9px",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "8px 12px",
                                fontSize: "0.78rem",
                                fontWeight: 600,
                                cursor: "pointer",
                            }}
                        >
                            <PlusCircle size={14} />
                            Create New Question
                        </button>
                        )}
                        {can("use_ai_tools") && (
                        <button
                            type="button"
                            onClick={() => setShowAIModal(true)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                border: "1px solid var(--accent-primary)",
                                borderRadius: "9px",
                                background: "var(--accent-glow)",
                                color: "var(--accent-primary-hover)",
                                padding: "8px 12px",
                                fontSize: "0.78rem",
                                fontWeight: 700,
                                cursor: "pointer",
                            }}
                        >
                            <Sparkles size={14} />
                            Create Question using AI
                        </button>
                        )}
                        {can("upload_pdf") && (
                        <button
                            type="button"
                            onClick={() => router.push("/upload")}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "9px",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "8px 12px",
                                fontSize: "0.78rem",
                                fontWeight: 600,
                                cursor: "pointer",
                            }}
                        >
                            <FileUp size={14} />
                            Bulk Import using AI
                        </button>
                        )}
                    </div>
                </header>

                {/* Content area: filter panel + questions list */}
                <div
                    style={{
                        flex: 1,
                        display: "flex",
                        overflow: "hidden",
                    }}
                >
                    {/* Filter panel */}
                    {showFilterPanel && (
                        <div
                            className="animate-slide-left"
                            style={{
                                width: "320px",
                                minWidth: "320px",
                                borderRight: "1px solid var(--border-primary)",
                                background: "var(--bg-secondary)",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column",
                            }}
                        >
                            <FilterPanel
                                filters={filters}
                                onFiltersChange={handleFiltersChange}
                                totalResults={data?.total ?? 0}
                            />
                        </div>
                    )}

                    {/* Questions list */}
                    <div
                        ref={questionsContainerRef}
                        style={{
                            flex: 1,
                            overflow: "auto",
                            padding: "20px 24px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "12px",
                        }}
                    >
                        {/* Stats */}
                        {data && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "14px",
                                    fontSize: "0.78rem",
                                    color: "var(--text-tertiary)",
                                    flexWrap: "wrap",
                                }}
                            >
                                <span>
                                    Page{" "}
                                    <strong style={{ color: "var(--text-primary)" }}>
                                        {data.page}
                                    </strong>{" "}
                                    of{" "}
                                    <strong style={{ color: "var(--text-primary)" }}>
                                        {data.totalPages}
                                    </strong>
                                </span>
                                <span
                                    style={{
                                        width: "1px",
                                        height: "14px",
                                        background: "var(--border-primary)",
                                    }}
                                />
                                <span>
                                    <strong style={{ color: "var(--text-primary)" }}>
                                        {data.total.toLocaleString()}
                                    </strong>{" "}
                                    questions
                                </span>
                            </div>
                        )}

                        {/* Loading */}
                        {loading && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "60px 20px",
                                    gap: "16px",
                                }}
                            >
                                <Loader2
                                    size={32}
                                    color="var(--accent-primary)"
                                    style={{ animation: "spin 1s linear infinite" }}
                                />
                                <span
                                    style={{
                                        fontSize: "0.85rem",
                                        color: "var(--text-tertiary)",
                                    }}
                                >
                                    Loading questions...
                                </span>
                                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                            </div>
                        )}

                        {/* Error */}
                        {error && !loading && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "60px 20px",
                                    gap: "12px",
                                }}
                            >
                                <AlertCircle size={32} color="var(--accent-danger)" />
                                <span
                                    style={{
                                        fontSize: "0.85rem",
                                        color: "var(--accent-danger)",
                                    }}
                                >
                                    Failed to load questions
                                </span>
                                <span
                                    style={{
                                        fontSize: "0.75rem",
                                        color: "var(--text-muted)",
                                        maxWidth: "400px",
                                        textAlign: "center",
                                    }}
                                >
                                    {error}
                                </span>
                                <button
                                    onClick={() => fetchQuestions(filters, page)}
                                    style={{
                                        marginTop: "8px",
                                        padding: "8px 20px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--accent-primary)",
                                        background: "transparent",
                                        color: "var(--accent-primary)",
                                        cursor: "pointer",
                                        fontSize: "0.8rem",
                                        fontWeight: 500,
                                    }}
                                >
                                    Retry
                                </button>
                            </div>
                        )}

                        {/* Empty state */}
                        {!loading && !error && data?.questions.length === 0 && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "80px 20px",
                                    gap: "12px",
                                }}
                            >
                                <Search
                                    size={40}
                                    color="var(--text-muted)"
                                    strokeWidth={1.5}
                                />
                                <span
                                    style={{
                                        fontSize: "1rem",
                                        fontWeight: 600,
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    No questions found
                                </span>
                                <span
                                    style={{
                                        fontSize: "0.82rem",
                                        color: "var(--text-muted)",
                                        textAlign: "center",
                                    }}
                                >
                                    Try adjusting your filters or search query
                                </span>
                            </div>
                        )}

                        {/* Question cards */}
                        {!loading &&
                            !error &&
                            data?.questions.map((q, i) => (
                                <QuestionCard
                                    key={q.question_id}
                                    question={q}
                                    index={i}
                                    trailingControl={
                                        <button
                                            type="button"
                                            onClick={() => setEditingQuestion(q)}
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
                                            title="Edit question"
                                        >
                                            <Pencil size={12} />
                                        </button>
                                    }
                                />
                            ))}

                        {/* Pagination */}
                        {!loading && !error && data && data.totalPages > 1 && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px",
                                    padding: "20px 0 40px 0",
                                }}
                            >
                                <button
                                    onClick={() => handlePageChange(page - 1)}
                                    disabled={page <= 1}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "4px",
                                        padding: "8px 14px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-tertiary)",
                                        color:
                                            page <= 1
                                                ? "var(--text-muted)"
                                                : "var(--text-secondary)",
                                        cursor: page <= 1 ? "default" : "pointer",
                                        fontSize: "0.82rem",
                                        opacity: page <= 1 ? 0.5 : 1,
                                        transition: "all 0.15s ease",
                                    }}
                                >
                                    <ChevronLeft size={16} />
                                    Previous
                                </button>

                                {/* Page numbers */}
                                {generatePageNumbers(page, data.totalPages).map((p, i) =>
                                    p === "..." ? (
                                        <span
                                            key={`dots-${i}`}
                                            style={{
                                                padding: "8px 4px",
                                                color: "var(--text-muted)",
                                                fontSize: "0.82rem",
                                            }}
                                        >
                                            ...
                                        </span>
                                    ) : (
                                        <button
                                            key={p}
                                            onClick={() => handlePageChange(p as number)}
                                            style={{
                                                padding: "8px 12px",
                                                borderRadius: "8px",
                                                border:
                                                    page === p
                                                        ? "1px solid var(--accent-primary)"
                                                        : "1px solid var(--border-primary)",
                                                background:
                                                    page === p
                                                        ? "var(--accent-glow)"
                                                        : "var(--bg-tertiary)",
                                                color:
                                                    page === p
                                                        ? "var(--accent-primary-hover)"
                                                        : "var(--text-secondary)",
                                                cursor: "pointer",
                                                fontSize: "0.82rem",
                                                fontWeight: page === p ? 600 : 400,
                                                minWidth: "36px",
                                                transition: "all 0.15s ease",
                                            }}
                                        >
                                            {p}
                                        </button>
                                    )
                                )}

                                <button
                                    onClick={() => handlePageChange(page + 1)}
                                    disabled={page >= data.totalPages}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "4px",
                                        padding: "8px 14px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-tertiary)",
                                        color:
                                            page >= data.totalPages
                                                ? "var(--text-muted)"
                                                : "var(--text-secondary)",
                                        cursor:
                                            page >= data.totalPages
                                                ? "default"
                                                : "pointer",
                                        fontSize: "0.82rem",
                                        opacity: page >= data.totalPages ? 0.5 : 1,
                                        transition: "all 0.15s ease",
                                    }}
                                >
                                    Next
                                    <ChevronRight size={16} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <QuestionEditModal
                open={Boolean(editingQuestion)}
                title={editingQuestion ? `Edit Question ${editingQuestion.question_id.slice(0, 8)}` : "Edit Question"}
                initialQuestionText={editingQuestion?.question_text || ""}
                initialSolutionText={editingQuestion?.solution_text || ""}
                initialOptions={getDraftOptions(editingQuestion)}
                initialAnswerKeyText={
                    editingQuestion ? toAnswerKeyText(editingQuestion.answer_key) : ""
                }
                initialMetadata={
                    editingQuestion
                        ? ({
                              subject: editingQuestion.subject,
                              chapter: editingQuestion.chapter,
                              topic: editingQuestion.topic,
                              subtopic: editingQuestion.subtopic || "",
                              source: editingQuestion.source,
                              questionType: editingQuestion.question_type,
                              difficultyLevel: editingQuestion.difficutly_level,
                              classLevel: editingQuestion.class_level || "",
                              exams: editingQuestion.exam || [],
                          } satisfies QuestionEditorMetadataDraft)
                        : undefined
                }
                metadataHierarchy={metadata}
                saving={savingQuestionEdit}
                onCancel={() => {
                    if (savingQuestionEdit) return;
                    setEditingQuestion(null);
                }}
                onSave={handleSaveQuestionEdit}
                questionId={editingQuestion?.question_id}
                rawData={editingQuestion?.raw_data}
                onAiMetadataUpdate={handleAiMetadataUpdate}
                status={editingQuestion?.status}
            />

            <QuestionEditModal
                open={showCreateModal}
                title="Create New Question"
                initialQuestionText=""
                initialSolutionText=""
                initialOptions={[
                    { text: "", isCorrect: false },
                    { text: "", isCorrect: false },
                    { text: "", isCorrect: false },
                    { text: "", isCorrect: false },
                ]}
                initialAnswerKeyText=""
                initialMetadata={{
                    subject: aiSubject || "",
                    chapter: "",
                    topic: "",
                    subtopic: "",
                    source: "Manual Entry",
                    questionType:
                        metadata.questionTypes[0] || "Single_Choice(SCQ)",
                    difficultyLevel: metadata.difficultyLevels[0] || "Medium",
                    classLevel: metadata.classLevels[0] || "",
                    exams: [],
                }}
                metadataHierarchy={metadata}
                saving={savingManualCreate}
                onCancel={() => {
                    if (savingManualCreate) return;
                    setShowCreateModal(false);
                }}
                onSave={handleCreateQuestion}
            />

            {showAIModal && (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 190,
                        background: "rgba(0,0,0,0.58)",
                        display: "grid",
                        placeItems: "center",
                        padding: "14px",
                    }}
                    onClick={() => {
                        if (generatingAIQuestions || savingAICreatedQuestions) return;
                        setShowAIModal(false);
                    }}
                >
                    <div
                        style={{
                            width: "min(1360px, 98vw)",
                            maxHeight: "94vh",
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
                                padding: "12px 14px",
                                borderBottom: "1px solid var(--border-primary)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                            }}
                        >
                            <div>
                                <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>
                                    Create Question Using AI
                                </div>
                                <div style={{ fontSize: "0.73rem", color: "var(--text-tertiary)" }}>
                                    Configure metadata, generate questions, discard unwanted ones, then save selected.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowAIModal(false)}
                                disabled={generatingAIQuestions || savingAICreatedQuestions}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    padding: "7px 11px",
                                    cursor:
                                        generatingAIQuestions || savingAICreatedQuestions
                                            ? "default"
                                            : "pointer",
                                }}
                            >
                                Close
                            </button>
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateRows: "auto minmax(0, 1fr)",
                                minHeight: 0,
                            }}
                        >
                            <section
                                style={{
                                    padding: "12px",
                                    borderBottom: "1px solid var(--border-primary)",
                                    overflowY: "auto",
                                    overflowX: "hidden",
                                    display: "grid",
                                    gap: "10px",
                                    alignContent: "start",
                                }}
                            >
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                                        gap: "8px",
                                    }}
                                >
                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            AI Provider
                                        </span>
                                        <select
                                            value={aiProvider}
                                            onChange={(event) => {
                                                const nextProvider = event.target.value as ChatApiProvider;
                                                setAiProvider(nextProvider);
                                                const fallbackModel = (
                                                    providerModels[nextProvider] ||
                                                    DEFAULT_PROVIDER_MODELS[nextProvider]
                                                )[0];
                                                if (fallbackModel) setAiModelId(fallbackModel.id);
                                            }}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            {CHAT_API_PROVIDERS.map((provider) => (
                                                <option key={provider} value={provider}>
                                                    {API_KEY_PROVIDER_LABELS[provider]}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Model
                                        </span>
                                        {aiProvider === "custom_openai" ? (
                                            <input
                                                type="text"
                                                value={aiModelId}
                                                onChange={(event) => setAiModelId(event.target.value)}
                                                placeholder="Enter model ID"
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: "8px",
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.78rem",
                                                    padding: "8px 9px",
                                                    width: "100%",
                                                    minWidth: 0,
                                                }}
                                            />
                                        ) : (
                                            <select
                                                value={aiModelId}
                                                onChange={(event) => setAiModelId(event.target.value)}
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: "8px",
                                                    background: "var(--bg-tertiary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.78rem",
                                                    padding: "8px 9px",
                                                    width: "100%",
                                                    minWidth: 0,
                                                }}
                                            >
                                                {(providerModels[aiProvider] || DEFAULT_PROVIDER_MODELS[aiProvider]).map(
                                                    (model) => (
                                                        <option key={model.id} value={model.id}>
                                                            {model.label}
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        )}
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Question Type
                                        </span>
                                        <select
                                            value={aiQuestionType}
                                            onChange={(event) => setAiQuestionType(event.target.value)}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            {(metadata.questionTypes.length
                                                ? metadata.questionTypes
                                                : ["Single_Choice(SCQ)", "Multi_Choice(MCQ)", "Integer", "Numerical"]
                                            ).map((type) => (
                                                <option key={type} value={type}>
                                                    {type}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Subject
                                        </span>
                                        <select
                                            value={aiSubject}
                                            onChange={(event) => {
                                                setAiSubject(event.target.value);
                                                setAiChapter("");
                                                setAiTopic("");
                                                setAiSubtopic("");
                                            }}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            {metadata.subjects.map((subject) => (
                                                <option key={subject} value={subject}>
                                                    {subject}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Chapter
                                        </span>
                                        <select
                                            value={aiChapter}
                                            onChange={(event) => {
                                                setAiChapter(event.target.value);
                                                setAiTopic("");
                                                setAiSubtopic("");
                                            }}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            <option value="">Any chapter</option>
                                            {aiAvailableChapters.map((chapter) => (
                                                <option key={chapter} value={chapter}>
                                                    {chapter}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Topic
                                        </span>
                                        <select
                                            value={aiTopic}
                                            onChange={(event) => {
                                                setAiTopic(event.target.value);
                                                setAiSubtopic("");
                                            }}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            <option value="">Any topic</option>
                                            {aiAvailableTopics.map((topic) => (
                                                <option key={topic} value={topic}>
                                                    {topic}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Subtopic
                                        </span>
                                        <select
                                            value={aiSubtopic}
                                            onChange={(event) => setAiSubtopic(event.target.value)}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            <option value="">Any subtopic</option>
                                            {aiAvailableSubtopics.map((subtopic) => (
                                                <option key={subtopic} value={subtopic}>
                                                    {subtopic}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Difficulty
                                        </span>
                                        <select
                                            value={aiDifficulty}
                                            onChange={(event) => setAiDifficulty(event.target.value)}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        >
                                            {(metadata.difficultyLevels.length
                                                ? metadata.difficultyLevels
                                                : ["Easy", "Medium", "Hard"]
                                            ).map((difficulty) => (
                                                <option key={difficulty} value={difficulty}>
                                                    {difficulty}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Count
                                        </span>
                                        <input
                                            type="number"
                                            min={1}
                                            max={25}
                                            value={aiCount}
                                            onChange={(event) => {
                                                const value = Number(event.target.value);
                                                if (!Number.isFinite(value)) return;
                                                setAiCount(Math.max(1, Math.min(25, Math.floor(value))));
                                            }}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        />
                                    </label>

                                    <label style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                                            Source Label
                                        </span>
                                        <input
                                            value={aiSource}
                                            onChange={(event) => setAiSource(event.target.value)}
                                            placeholder="AI Generated"
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.78rem",
                                                padding: "8px 9px",
                                                width: "100%",
                                                minWidth: 0,
                                            }}
                                        />
                                    </label>
                                </div>

                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <button
                                        type="button"
                                        onClick={() => void loadLiveModels(aiProvider)}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            fontSize: "0.74rem",
                                            padding: "6px 9px",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <RefreshCw size={13} className={loadingModels ? "animate-spin" : ""} />
                                        {loadingModels ? "Loading models..." : "Reload models"}
                                    </button>
                                    {aiModelError && (
                                        <div style={{ fontSize: "0.72rem", color: "var(--accent-danger)" }}>
                                            {aiModelError}
                                        </div>
                                    )}
                                </div>
                            </section>

                            <section
                                style={{
                                    padding: "12px",
                                    overflowY: "auto",
                                    display: "grid",
                                    gap: "10px",
                                    alignContent: "start",
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: "10px",
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                                        Generated:{" "}
                                        <strong style={{ color: "var(--text-primary)" }}>
                                            {generatedQuestions.length}
                                        </strong>{" "}
                                        · Selected:{" "}
                                        <strong style={{ color: "var(--text-primary)" }}>
                                            {selectedGeneratedIndexes.size}
                                        </strong>
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <button
                                            type="button"
                                            onClick={selectAllGenerated}
                                            disabled={generatedQuestions.length === 0}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "5px",
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                padding: "6px 10px",
                                                fontSize: "0.74rem",
                                                cursor:
                                                    generatedQuestions.length === 0
                                                        ? "default"
                                                        : "pointer",
                                                opacity: generatedQuestions.length === 0 ? 0.55 : 1,
                                            }}
                                        >
                                            <CheckSquare size={13} />
                                            Select all
                                        </button>
                                        <button
                                            type="button"
                                            onClick={clearGeneratedSelections}
                                            disabled={generatedQuestions.length === 0}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "5px",
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                padding: "6px 10px",
                                                fontSize: "0.74rem",
                                                cursor:
                                                    generatedQuestions.length === 0
                                                        ? "default"
                                                        : "pointer",
                                                opacity: generatedQuestions.length === 0 ? 0.55 : 1,
                                            }}
                                        >
                                            <Square size={13} />
                                            Clear
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleGenerateAIQuestions()}
                                            disabled={generatingAIQuestions || savingAICreatedQuestions}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                border: "1px solid var(--accent-primary)",
                                                borderRadius: "8px",
                                                background: "var(--accent-primary)",
                                                color: "#fff",
                                                padding: "7px 12px",
                                                fontSize: "0.76rem",
                                                fontWeight: 700,
                                                cursor:
                                                    generatingAIQuestions || savingAICreatedQuestions
                                                        ? "default"
                                                        : "pointer",
                                                opacity:
                                                    generatingAIQuestions || savingAICreatedQuestions
                                                        ? 0.75
                                                        : 1,
                                            }}
                                        >
                                            {generatingAIQuestions ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Sparkles size={14} />
                                            )}
                                            {generatingAIQuestions ? "Generating..." : "Generate"}
                                        </button>
                                    </div>
                                </div>

                                {aiError && (
                                    <div
                                        style={{
                                            border: "1px solid rgba(var(--accent-danger-rgb),0.35)",
                                            background: "rgba(var(--accent-danger-rgb),0.1)",
                                            color: "var(--accent-danger)",
                                            padding: "8px 10px",
                                            borderRadius: "8px",
                                            fontSize: "0.74rem",
                                        }}
                                    >
                                        {aiError}
                                    </div>
                                )}

                                {generatedPreviewQuestions.length === 0 ? (
                                    <div
                                        style={{
                                            border: "1px dashed var(--border-primary)",
                                            borderRadius: "10px",
                                            padding: "36px 16px",
                                            textAlign: "center",
                                            color: "var(--text-muted)",
                                            fontSize: "0.82rem",
                                        }}
                                    >
                                        Generate AI questions to review them here.
                                    </div>
                                ) : (
                                    generatedPreviewQuestions.map((question, index) => (
                                        <QuestionCard
                                            key={`${question.question_id}-${index}`}
                                            question={question}
                                            index={index}
                                            leadingControl={
                                                <button
                                                    type="button"
                                                    onClick={() => toggleGeneratedSelection(index)}
                                                    style={{
                                                        width: "24px",
                                                        height: "24px",
                                                        borderRadius: "6px",
                                                        border: selectedGeneratedIndexes.has(index)
                                                            ? "1px solid var(--accent-primary)"
                                                            : "1px solid var(--border-primary)",
                                                        background: selectedGeneratedIndexes.has(index)
                                                            ? "var(--accent-glow)"
                                                            : "var(--bg-tertiary)",
                                                        color: selectedGeneratedIndexes.has(index)
                                                            ? "var(--accent-primary)"
                                                            : "var(--text-secondary)",
                                                        cursor: "pointer",
                                                        display: "grid",
                                                        placeItems: "center",
                                                    }}
                                                    title="Select for save"
                                                >
                                                    {selectedGeneratedIndexes.has(index) ? (
                                                        <CheckSquare size={13} />
                                                    ) : (
                                                        <Square size={13} />
                                                    )}
                                                </button>
                                            }
                                        />
                                    ))
                                )}
                            </section>
                        </div>

                        <div
                            style={{
                                borderTop: "1px solid var(--border-primary)",
                                padding: "10px 14px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                            }}
                        >
                            <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                Uncheck any generated question to discard it before saving.
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <button
                                    type="button"
                                    onClick={() => setShowAIModal(false)}
                                    disabled={generatingAIQuestions || savingAICreatedQuestions}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        padding: "8px 12px",
                                        fontSize: "0.78rem",
                                        cursor:
                                            generatingAIQuestions || savingAICreatedQuestions
                                                ? "default"
                                                : "pointer",
                                        opacity:
                                            generatingAIQuestions || savingAICreatedQuestions ? 0.7 : 1,
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSaveSelectedAIQuestions()}
                                    disabled={
                                        savingAICreatedQuestions ||
                                        generatingAIQuestions ||
                                        selectedGeneratedIndexes.size === 0
                                    }
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        border: "1px solid var(--accent-primary)",
                                        borderRadius: "8px",
                                        background: "var(--accent-primary)",
                                        color: "#fff",
                                        padding: "8px 12px",
                                        fontSize: "0.78rem",
                                        fontWeight: 700,
                                        cursor:
                                            savingAICreatedQuestions ||
                                            generatingAIQuestions ||
                                            selectedGeneratedIndexes.size === 0
                                                ? "default"
                                                : "pointer",
                                        opacity:
                                            savingAICreatedQuestions ||
                                            generatingAIQuestions ||
                                            selectedGeneratedIndexes.size === 0
                                                ? 0.72
                                                : 1,
                                    }}
                                >
                                    {savingAICreatedQuestions ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <CheckSquare size={14} />
                                    )}
                                    {savingAICreatedQuestions
                                        ? "Saving..."
                                        : `Save Selected (${selectedGeneratedIndexes.size})`}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Helper: generate smart page number array like [1, 2, ..., 5, 6, 7, ..., 99, 100]
function generatePageNumbers(
    current: number,
    total: number
): (number | "...")[] {
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const pages: (number | "...")[] = [];

    // Always show first page
    pages.push(1);

    if (current > 3) {
        pages.push("...");
    }

    // Show pages around current
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);

    for (let i = start; i <= end; i++) {
        pages.push(i);
    }

    if (current < total - 2) {
        pages.push("...");
    }

    // Always show last page
    if (total > 1) {
        pages.push(total);
    }

    return pages;
}

export default function Home() {
    return (
        <Suspense>
            <HomeContent />
        </Suspense>
    );
}
