"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    CheckCircle2,
    Download,
    FileUp,
    Files,
    Loader2,
    Lock,
    RefreshCw,
    Sparkles,
    Upload,
    X,
    ChevronDown,
    ChevronUp,
    Wand2,
    Trash2,
    Clock,
    History,
    Languages,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import MathContent from "@/components/ui/MathContent";
import { useAIJobQueue, type CompletedReport } from "@/context/AIJobQueueContext";
import type { AIModelProvider, ModelOption } from "@/types/extraction";
import { AI_PROVIDER_LABELS, AI_PROVIDER_MODELS } from "@/types/extraction";
import { downloadTranslationAsDocx, downloadTranslationAsPDF } from "@/lib/downloadTranslation";
import {
    EMPTY_USER_API_KEYS,
    getProviderApiCredential,
    readDevApiKeysFromStorage,
    sanitizeUserApiKeys,
    type UserApiKeys,
} from "@/lib/userApiKeys";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/context/UserProfileContext";

// ==================== TYPES ====================

// "video" removed from the switchable tab set — Video Solution now lives on
// its own page (/video-solution, gated by "use_video_solution" independent of
// "use_ai_tools"). Old "video" ai_reports rows still render in the history
// list below (report_type retains "video" as a value there) — see the
// historyFilterType union just below, which keeps "video" as a filter option.
type AIToolMode = "qc" | "solution" | "modification" | "repeat_check" | "translate";
type ModificationMode = "light" | "hard";
type FileContentType =
    | "questions_only"
    | "questions_with_answer_key"
    | "questions_answer_key_solution";
type ExamTypeOption = "" | "JEE_MAINS" | "JEE_ADVANCE" | "NEET";
type PaperTypeOption = "Paper 1" | "Paper 2";

interface MetadataHierarchy {
    subjects: string[];
    chaptersBySubject: Record<string, string[]>;
    topicsByChapter: Record<string, string[]>;
}

// AI QC Report types
interface QCQuestionReport {
    questionNumber: number;
    questionText: string;
    aiAnswer: string | number | null;
    providedAnswer: string | number | null;
    answerMatch: boolean | null;
    correctness: string;
    suggestions: string[];
    languageQuality: string;
    solutionQuality?: string;
    chapter?: string;
    topic?: string;
    questionType?: string;
    difficulty?: string;
}

interface QCPaperReport {
    totalQuestions: number;
    questionsAnalyzed: number;
    answerKeyMatches: number;
    answerKeyMismatches: number;
    chapterDistribution: Record<string, number>;
    overallSuggestions: string[];
    patternAnalysis?: string;
    syllabusAnalysis?: string;
    questionTypeDistribution?: Record<string, number>;
    questions: QCQuestionReport[];
}

// AI Solution Report types
interface SolutionQuestion {
    questionNumber: number;
    questionText: string;
    answerKey: string | number | null;
    solution: string;
    chapter?: string;
    topic?: string;
}

interface SolutionReport {
    totalQuestions: number;
    questions: SolutionQuestion[];
}

// AI Modification Report types
interface ModificationQuestionReport {
    questionNumber: number;
    originalQuestionSummary: string;
    modifiedQuestionText: string;
    options: Array<{ text: string; isCorrect: boolean }>;
    answerKey: string | number | number[] | null;
    solutionText: string;
    questionType: string;
    subject: string;
    chapter: string;
    topic?: string;
    difficulty: string;
    changesSummary: string;
}

interface ModificationReport {
    totalQuestions: number;
    modificationMode: string;
    questions: ModificationQuestionReport[];
}

interface RepeatCheckItem {
    fileName: string;
    pageNumber: number | null;
    questionNumber: string | null;
    questionText: string;
}

interface RepeatCheckGroup {
    groupId: number;
    matchType: string;
    similarityPercent: number;
    reason: string;
    items: RepeatCheckItem[];
}

interface RepeatCheckReport {
    filesAnalyzed: number;
    totalQuestionsDetected: number;
    duplicatePairs: number;
    summary: string;
    groups: RepeatCheckGroup[];
}

interface TranslationReport {
    targetLanguage: string;
    translatedHtml: string;
    plainText: string;
    notes: string;
}

const DEFAULT_QC_PROMPT = `You are a highly accurate Question Paper Quality Check AI for educational content.

Parse the uploaded paper, solve questions yourself, compare answer keys if provided, check correctness, language quality, solution quality, chapter/topic, question type, difficulty, pattern, syllabus coverage, and overall improvements.

Return ONLY valid JSON in the report schema requested by this tool.`;

const DEFAULT_SOLUTION_PROMPT = `You are a highly accurate Question Solving AI for educational content.

Parse every question in the uploaded paper, generate the correct answer key, chapter/topic, and a concise HTML solution. Use LaTeX for all math. Keep each solution line short and wrap lines in <p> tags.

Return ONLY valid JSON in the report schema requested by this tool.`;

const DEFAULT_MODIFICATION_PROMPT = `You are an expert educational content creator for JEE/NEET question papers.

Modify every uploaded question according to the selected modification mode. Preserve question type, subject, chapter, and solvability. Use HTML with LaTeX for question text, options, and solutions.

Return ONLY valid JSON in the report schema requested by this tool.`;

const DEFAULT_REPEAT_CHECK_PROMPT = `You are a duplicate-question detection AI.

Compare all questions across every uploaded PDF and also within each same PDF. Detect exact duplicates, near duplicates, and semantically repeated questions even when wording, values, formatting, or option order changed.

For every repeat group, include PDF file name, page number, visible question number, question excerpt, match type, similarity percentage, and the reason the questions are repeated.

Return ONLY valid JSON in the repeat-check report schema requested by this tool.`;

const DEFAULT_TRANSLATE_PROMPT = `You are a professional academic translator for JEE/NEET learning material.

Translate the uploaded question paper and optional solution paper into the target language. Preserve question numbers, section headings, option labels, answer keys, solutions, tables, diagrams references, HTML structure, LaTeX, and mathematical notation. Do not summarize, solve, omit, or reorder content.`;

// ==================== COMPONENT ====================

export default function AIToolsPage() {
    const router = useRouter();
    const { can, loading: profileLoading } = useCurrentUser();
    const { savedReports, saveReport, deleteReport: deleteReportFromContext, enqueueJob, activeJobCount, reloadReports, activeVideoJobs } = useAIJobQueue();

    useEffect(() => {
        if (!profileLoading && !can("use_ai_tools")) {
            router.replace("/questions");
        }
    }, [profileLoading, can, router]);

    // Mode state
    const [activeMode, setActiveMode] = useState<AIToolMode>("qc");

    // AI Provider/Model state
    const [aiProvider, setAiProvider] = useState<AIModelProvider>("gemini");
    const [modelId, setModelId] = useState(AI_PROVIDER_MODELS.gemini[0].id);
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    const [providerModels, setProviderModels] = useState<Record<AIModelProvider, ModelOption[]>>({
        ...AI_PROVIDER_MODELS,
    });
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelLoadError, setModelLoadError] = useState<string | null>(null);
    const [usingLiveModels, setUsingLiveModels] = useState(false);

    // File upload state
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [solutionFile, setSolutionFile] = useState<File | null>(null);
    const [repeatCheckFiles, setRepeatCheckFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const solutionFileInputRef = useRef<HTMLInputElement>(null);
    const repeatFilesInputRef = useRef<HTMLInputElement>(null);

    // AI QC form state
    const [fileContentType, setFileContentType] = useState<FileContentType>("questions_only");
    const [examType, setExamType] = useState<ExamTypeOption>("");
    const [advancePatternYear, setAdvancePatternYear] = useState("2025");
    const [paperType, setPaperType] = useState<PaperTypeOption[]>(["Paper 1", "Paper 2"]);
    const [metadata, setMetadata] = useState<MetadataHierarchy>({ subjects: [], chaptersBySubject: {}, topicsByChapter: {} });
    const [selectedSubjects, setSelectedSubjects] = useState<string[]>(["Physics", "Chemistry", "Maths"]);
    const [fullSyllabus, setFullSyllabus] = useState<"Yes" | "No">("Yes");
    const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
    const [loadingMetadata, setLoadingMetadata] = useState(false);

    // AI Modification form state
    const [modificationMode, setModificationMode] = useState<ModificationMode>("light");
    const [qcPrompt, setQcPrompt] = useState(DEFAULT_QC_PROMPT);
    const [solutionPrompt, setSolutionPrompt] = useState(DEFAULT_SOLUTION_PROMPT);
    const [modificationPrompt, setModificationPrompt] = useState(DEFAULT_MODIFICATION_PROMPT);
    const [repeatCheckPrompt, setRepeatCheckPrompt] = useState(DEFAULT_REPEAT_CHECK_PROMPT);
    const [translatePrompt, setTranslatePrompt] = useState(DEFAULT_TRANSLATE_PROMPT);
    const [translateLanguage, setTranslateLanguage] = useState("Hindi");

    // Processing state
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Results
    const [qcReport, setQcReport] = useState<QCPaperReport | null>(null);
    const [solutionReport, setSolutionReport] = useState<SolutionReport | null>(null);
    const [modificationReport, setModificationReport] = useState<ModificationReport | null>(null);
    const [repeatCheckReport, setRepeatCheckReport] = useState<RepeatCheckReport | null>(null);
    const [translationReport, setTranslationReport] = useState<TranslationReport | null>(null);
    const [expandedQuestions, setExpandedQuestions] = useState<Set<number>>(new Set());

    // Report History UI state (data comes from context)
    const [historyExpanded, setHistoryExpanded] = useState(true);
    const [loadingReportId, setLoadingReportId] = useState<string | null>(null);
    // "video" kept here even though it's no longer a switchable AIToolMode —
    // old video reports still show in this history list (see the "Video"
    // filter pill below).
    const [historyFilterType, setHistoryFilterType] = useState<AIToolMode | "extraction" | "video" | "all">("all");

    // Refs
    const aiProviderRef = useRef<AIModelProvider>(aiProvider);
    const modelRequestRef = useRef(0);

    useEffect(() => {
        aiProviderRef.current = aiProvider;
    }, [aiProvider]);

    // Load saved API keys
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
                    if (mounted) setUserApiKeys(keys);
                    return;
                }
            } catch {
                // fallback
            }
            if (!mounted || typeof window === "undefined") return;
            if (document.cookie.includes("qbg_dev_auth=1")) {
                setUserApiKeys(readDevApiKeysFromStorage());
                return;
            }
            setUserApiKeys({ ...EMPTY_USER_API_KEYS });
        }
        void loadSavedApiKeys();
        return () => { mounted = false; };
    }, []);

    // Load live models
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
                        if (loadedModels.some((m) => m.id === prev)) return prev;
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

    // Load metadata for syllabus
    useEffect(() => {
        let mounted = true;
        async function loadMeta() {
            setLoadingMetadata(true);
            try {
                const response = await fetch("/api/metadata", { cache: "no-store" });
                const data = await response.json();
                if (!mounted) return;
                if (data) {
                    const subjects: string[] = Array.isArray(data.subjects) ? data.subjects : [];
                    const chaptersBySubject: Record<string, string[]> = (data.chaptersBySubject && typeof data.chaptersBySubject === "object") ? data.chaptersBySubject : {};
                    // fallback: if subjects is an object with chapter keys (old format)
                    if (!Array.isArray(data.subjects) && data.subjects && typeof data.subjects === "object") {
                        const subjectNames = Object.keys(data.subjects);
                        const cbs: Record<string, string[]> = {};
                        for (const s of subjectNames) {
                            cbs[s] = Object.keys(data.subjects[s] || {});
                        }
                        setMetadata({ subjects: subjectNames, chaptersBySubject: cbs, topicsByChapter: {} });
                    } else {
                        const topicsByChapter: Record<string, string[]> = (data.topicsByChapter && typeof data.topicsByChapter === "object") ? data.topicsByChapter : {};
                        setMetadata({ subjects, chaptersBySubject, topicsByChapter });
                    }
                }
            } catch {
                // ignore
            } finally {
                if (mounted) setLoadingMetadata(false);
            }
        }
        void loadMeta();
        return () => { mounted = false; };
    }, []);

    // ==================== REPORT HISTORY (from context) ====================

    const saveReportToHistory = useCallback(
        async (reportType: AIToolMode, fileName: string, reportData: unknown) => {
            const saved = await saveReport({
                report_type: reportType as CompletedReport["report_type"],
                file_name: fileName,
                provider: aiProvider,
                model_id: modelId,
                report_data: reportData,
            });
            if (!saved) {
                setError("Report generated, but it could not be written to the database. It was kept in this browser only.");
            }
        },
        [aiProvider, modelId, saveReport]
    );

    const loadFullReport = useCallback(async (entry: CompletedReport) => {
        setLoadingReportId(entry.id);

        try {
            let fullEntry = entry;
            if (!fullEntry.report_data) {
                const supabase = createSupabaseBrowserClient();
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const headers = session?.access_token
                    ? { Authorization: `Bearer ${session.access_token}` }
                    : undefined;
                const response = await fetch(`/api/ai-tools/reports/${encodeURIComponent(entry.id)}`, {
                    method: "GET",
                    headers,
                    cache: "no-store",
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    report?: CompletedReport;
                    error?: string;
                };
                if (!response.ok || !payload.success || !payload.report) {
                    throw new Error(payload.error || "Report data not available.");
                }
                fullEntry = payload.report;
            }

            const data = fullEntry.report_data;
            if (!data) {
                throw new Error("Report data not available.");
            }

            // Clear all current reports first
            setQcReport(null);
            setSolutionReport(null);
            setModificationReport(null);
            setRepeatCheckReport(null);
            setTranslationReport(null);
            setExpandedQuestions(new Set());
            setError(null);

            if (fullEntry.report_type === "qc") {
                setQcReport(data as QCPaperReport);
                setActiveMode("qc");
            } else if (fullEntry.report_type === "solution") {
                setSolutionReport(data as SolutionReport);
                setActiveMode("solution");
            } else if (fullEntry.report_type === "modification") {
                setModificationReport(data as ModificationReport);
                setActiveMode("modification");
            } else if (fullEntry.report_type === "repeat_check") {
                setRepeatCheckReport(data as RepeatCheckReport);
                setActiveMode("repeat_check");
            } else if (fullEntry.report_type === "translate") {
                setTranslationReport(data as TranslationReport);
                setActiveMode("translate");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingReportId(null);
        }
    }, []);

    // ==================== QUEUE TO BACKGROUND ====================

    const handleQueueToBackground = useCallback(async () => {
        if (!uploadedFile) {
            setError("Please upload a file first.");
            return;
        }
        if (aiProvider === "openai" && uploadedFile.name.toLowerCase().endsWith(".pdf") && activeMode !== "translate") {
            setError("OpenAI does not support PDF files. Please switch to Gemini or OpenRouter.");
            return;
        }
        if (activeMode === "translate") {
            if (!translateLanguage.trim()) {
                setError("Enter the language to translate to.");
                return;
            }
            if (aiProvider !== "gemini") {
                setError("PDF translation currently requires Gemini because it can read PDF files directly.");
                return;
            }
        }

        try {
            const fileBase64 = await fileToBase64(uploadedFile);
            const solutionFileBase64 = solutionFile ? await fileToBase64(solutionFile) : undefined;
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();

            // Build request body based on active mode
            let endpoint = "";
            let requestBody: Record<string, unknown> = {};

            if (activeMode === "qc") {
                endpoint = "/api/ai-tools/qc";
                let resolvedExamType: string | undefined = examType || undefined;
                if (examType === "JEE_ADVANCE") {
                    const paperLabel = paperType.length === 2 ? "Both Papers" : paperType[0] || "Both Papers";
                    resolvedExamType = `JEE_ADVANCE (Year: ${advancePatternYear}, ${paperLabel})`;
                }
                const syllabusData: Record<string, string[]> = {};
                if (selectedSubjects.length > 0) {
                    if (fullSyllabus === "Yes") {
                        for (const subject of selectedSubjects) syllabusData[subject] = [];
                    } else {
                        for (const subject of selectedSubjects) {
                            const subjectChapters = metadata.chaptersBySubject[subject] || [];
                            const selected = subjectChapters.filter((ch) => selectedChapters.includes(ch));
                            syllabusData[subject] = selected.length > 0 ? selected : [];
                        }
                    }
                }
                requestBody = {
                    fileBase64,
                    fileName: uploadedFile.name,
                    solutionFileBase64: solutionFileBase64 || undefined,
                    solutionFileName: solutionFile?.name || undefined,
                    provider: aiProvider,
                    modelId,
                    contentType: solutionFile ? "questions_answer_key_solution" : fileContentType,
                    examType: resolvedExamType,
                    syllabus: Object.keys(syllabusData).length > 0 ? syllabusData : undefined,
                    customPrompt: qcPrompt.trim() !== DEFAULT_QC_PROMPT ? qcPrompt.trim() : undefined,
                };
            } else if (activeMode === "solution") {
                endpoint = "/api/ai-tools/solution";
                requestBody = {
                    fileBase64,
                    fileName: uploadedFile.name,
                    provider: aiProvider,
                    modelId,
                    customPrompt: solutionPrompt.trim() !== DEFAULT_SOLUTION_PROMPT ? solutionPrompt.trim() : undefined,
                };
            } else if (activeMode === "modification") {
                endpoint = "/api/ai-tools/modification";
                requestBody = {
                    fileBase64,
                    fileName: uploadedFile.name,
                    provider: aiProvider,
                    modelId,
                    mode: modificationMode,
                    customPrompt: modificationPrompt.trim() !== DEFAULT_MODIFICATION_PROMPT ? modificationPrompt.trim() : undefined,
                };
            } else if (activeMode === "translate") {
                endpoint = "/api/ai-tools/translate-document";
                const documents = [
                    {
                        label: "Question PDF",
                        fileName: uploadedFile.name,
                        mimeType: uploadedFile.type || "application/pdf",
                        fileBase64,
                    },
                ];
                if (solutionFile && solutionFileBase64) {
                    documents.push({
                        label: "Solution PDF",
                        fileName: solutionFile.name,
                        mimeType: solutionFile.type || "application/pdf",
                        fileBase64: solutionFileBase64,
                    });
                }
                requestBody = {
                    mode: "pdf",
                    provider: aiProvider,
                    modelId,
                    targetLanguage: translateLanguage,
                    customPrompt: translatePrompt,
                    documents,
                };
            }

            // Add API key header info to request body
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                requestBody._devApiKey = providerApiKey;
            }

            enqueueJob({
                type: activeMode as "qc" | "solution" | "modification" | "translate",
                fileName: uploadedFile.name,
                provider: aiProvider,
                modelId,
                endpoint,
                requestBody,
            });

            // Clear any previous errors — the floating notifier shows job status
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [uploadedFile, solutionFile, aiProvider, modelId, userApiKeys, activeMode, fileContentType, examType, advancePatternYear, paperType, selectedSubjects, selectedChapters, fullSyllabus, metadata.chaptersBySubject, modificationMode, qcPrompt, solutionPrompt, modificationPrompt, translateLanguage, translatePrompt, enqueueJob]);

    // File handling
    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        if (file) {
            const ext = file.name.split(".").pop()?.toLowerCase();
            if (ext !== "pdf" && ext !== "doc" && ext !== "docx") {
                setError("Only PDF and Word files are supported.");
                return;
            }
        }
        setUploadedFile(file);
        setError(null);
    }, []);

    const handleSolutionFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        if (file) {
            const ext = file.name.split(".").pop()?.toLowerCase();
            if (ext !== "pdf" && ext !== "doc" && ext !== "docx") {
                setError("Only PDF and Word files are supported for solution file.");
                return;
            }
        }
        setSolutionFile(file);
        setError(null);
    }, []);

    const handleRepeatFilesChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        const invalidFile = files.find((file) => file.name.split(".").pop()?.toLowerCase() !== "pdf");
        if (invalidFile) {
            setError("AI Repeat Check supports PDF files only.");
            return;
        }
        setRepeatCheckFiles(files);
        setError(null);
    }, []);

    const fileToBase64 = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(",")[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

    // Derived subject options (always show core 3 + any from metadata)
    const FIXED_SUBJECT_OPTIONS = ["Physics", "Chemistry", "Maths"];
    const subjectOptions = useMemo(() => {
        const extras = metadata.subjects.filter(
            (s) => !FIXED_SUBJECT_OPTIONS.some((core) => core.toLowerCase() === s.trim().toLowerCase())
        );
        return Array.from(new Set([...FIXED_SUBJECT_OPTIONS, ...extras]));
    }, [metadata.subjects]);

    // Toggle helpers
    function toggleSubject(subject: string) {
        setSelectedSubjects((prev) =>
            prev.includes(subject) ? prev.filter((s) => s !== subject) : [...prev, subject]
        );
    }
    function toggleChapter(chapter: string) {
        setSelectedChapters((prev) =>
            prev.includes(chapter) ? prev.filter((c) => c !== chapter) : [...prev, chapter]
        );
    }
    function togglePaperType(paper: PaperTypeOption) {
        setPaperType((prev) =>
            prev.includes(paper) ? prev.filter((p) => p !== paper) : [...prev, paper]
        );
    }

    // Run AI QC
    const handleRunQC = useCallback(async () => {
        if (!uploadedFile) {
            setError("Please upload a file first.");
            return;
        }
        // OpenAI does not support PDF files — only Gemini and OpenRouter do
        if (aiProvider === "openai" && uploadedFile.name.toLowerCase().endsWith(".pdf")) {
            setError("OpenAI does not support PDF files. Please switch to Gemini or OpenRouter.");
            return;
        }
        setProcessing(true);
        setError(null);
        setQcReport(null);

        try {
            const fileBase64 = await fileToBase64(uploadedFile);
            const solutionFileBase64 = solutionFile ? await fileToBase64(solutionFile) : undefined;
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-api-key"] = providerApiKey;
            }

            // Build exam type string with year/paper info for JEE Advance
            let resolvedExamType: string | undefined = examType || undefined;
            if (examType === "JEE_ADVANCE") {
                const paperLabel = paperType.length === 2 ? "Both Papers" : paperType[0] || "Both Papers";
                resolvedExamType = `JEE_ADVANCE (Year: ${advancePatternYear}, ${paperLabel})`;
            }

            // Build syllabus data
            const syllabusData: Record<string, string[]> = {};
            if (selectedSubjects.length > 0) {
                if (fullSyllabus === "Yes") {
                    for (const subject of selectedSubjects) {
                        syllabusData[subject] = [];
                    }
                } else {
                    for (const subject of selectedSubjects) {
                        const subjectChapters = metadata.chaptersBySubject[subject] || [];
                        const selected = subjectChapters.filter((ch) => selectedChapters.includes(ch));
                        syllabusData[subject] = selected.length > 0 ? selected : [];
                    }
                }
            }

            const response = await fetch("/api/ai-tools/qc", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    fileBase64,
                    fileName: uploadedFile.name,
                    solutionFileBase64: solutionFileBase64 || undefined,
                    solutionFileName: solutionFile?.name || undefined,
                    provider: aiProvider,
                    modelId,
                    contentType: solutionFile ? "questions_answer_key_solution" : fileContentType,
                    examType: resolvedExamType,
                    syllabus: Object.keys(syllabusData).length > 0 ? syllabusData : undefined,
                    customPrompt: qcPrompt.trim() !== DEFAULT_QC_PROMPT ? qcPrompt.trim() : undefined,
                }),
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || "AI QC analysis failed.");
            }
            setQcReport(result.report);
            setExpandedQuestions(new Set());
            await saveReportToHistory("qc", uploadedFile.name, result.report);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProcessing(false);
        }
    }, [uploadedFile, solutionFile, aiProvider, modelId, userApiKeys, fileContentType, examType, advancePatternYear, paperType, selectedSubjects, selectedChapters, fullSyllabus, metadata.chaptersBySubject, qcPrompt, saveReportToHistory]);

    // Run AI Solution
    const handleRunSolution = useCallback(async () => {
        if (!uploadedFile) {
            setError("Please upload a file first.");
            return;
        }
        if (aiProvider === "openai" && uploadedFile.name.toLowerCase().endsWith(".pdf")) {
            setError("OpenAI does not support PDF files. Please switch to Gemini or OpenRouter.");
            return;
        }
        setProcessing(true);
        setError(null);
        setSolutionReport(null);

        try {
            const fileBase64 = await fileToBase64(uploadedFile);
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-api-key"] = providerApiKey;
            }

            const response = await fetch("/api/ai-tools/solution", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    fileBase64,
                    fileName: uploadedFile.name,
                    provider: aiProvider,
                    modelId,
                    customPrompt: solutionPrompt.trim() !== DEFAULT_SOLUTION_PROMPT ? solutionPrompt.trim() : undefined,
                }),
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || "AI Solution generation failed.");
            }
            setSolutionReport(result.report);
            setExpandedQuestions(new Set());
            await saveReportToHistory("solution", uploadedFile.name, result.report);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProcessing(false);
        }
    }, [uploadedFile, aiProvider, modelId, userApiKeys, solutionPrompt, saveReportToHistory]);

    // Run AI Modification
    const handleRunModification = useCallback(async () => {
        if (!uploadedFile) {
            setError("Please upload a file first.");
            return;
        }
        if (aiProvider === "openai" && uploadedFile.name.toLowerCase().endsWith(".pdf")) {
            setError("OpenAI does not support PDF files. Please switch to Gemini or OpenRouter.");
            return;
        }
        setProcessing(true);
        setError(null);
        setModificationReport(null);

        try {
            const fileBase64 = await fileToBase64(uploadedFile);
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-api-key"] = providerApiKey;
            }

            const response = await fetch("/api/ai-tools/modification", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    fileBase64,
                    fileName: uploadedFile.name,
                    provider: aiProvider,
                    modelId,
                    mode: modificationMode,
                    customPrompt: modificationPrompt.trim() !== DEFAULT_MODIFICATION_PROMPT ? modificationPrompt.trim() : undefined,
                }),
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || "AI Modification failed.");
            }
            setModificationReport(result.report);
            setExpandedQuestions(new Set());
            await saveReportToHistory("modification", uploadedFile.name, result.report);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProcessing(false);
        }
    }, [uploadedFile, aiProvider, modelId, userApiKeys, modificationMode, modificationPrompt, saveReportToHistory]);

    const handleRunRepeatCheck = useCallback(async () => {
        if (repeatCheckFiles.length < 2) {
            setError("Please upload at least two PDF files.");
            return;
        }
        if (aiProvider === "openai") {
            setError("OpenAI does not support PDF repeat checking here. Please switch to Gemini or OpenRouter.");
            return;
        }

        setProcessing(true);
        setError(null);
        setRepeatCheckReport(null);

        try {
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-api-key"] = providerApiKey;
            }

            const files = await Promise.all(
                repeatCheckFiles.map(async (file) => ({
                    fileBase64: await fileToBase64(file),
                    fileName: file.name,
                }))
            );

            const response = await fetch("/api/ai-tools/repeat-check", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    files,
                    provider: aiProvider,
                    modelId,
                    customPrompt: repeatCheckPrompt.trim() !== DEFAULT_REPEAT_CHECK_PROMPT ? repeatCheckPrompt.trim() : undefined,
                }),
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || "AI Repeat Check failed.");
            }

            setRepeatCheckReport(result.report);
            setExpandedQuestions(new Set());
            await saveReportToHistory("repeat_check", repeatCheckFiles.map((file) => file.name).join(", "), result.report);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProcessing(false);
        }
    }, [repeatCheckFiles, aiProvider, modelId, userApiKeys, repeatCheckPrompt, saveReportToHistory]);

    const handleRunTranslate = useCallback(async () => {
        if (!uploadedFile) {
            setError("Please upload a question PDF first.");
            return;
        }
        if (!translateLanguage.trim()) {
            setError("Enter the language to translate to.");
            return;
        }
        if (aiProvider !== "gemini") {
            setError("PDF translation currently requires Gemini because it can read PDF files directly.");
            return;
        }

        setProcessing(true);
        setError(null);
        setTranslationReport(null);

        try {
            const providerApiKey = (userApiKeys[aiProvider] || "").trim();
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (providerApiKey && typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-api-key"] = providerApiKey;
            }

            const documents = [
                {
                    label: "Question PDF",
                    fileName: uploadedFile.name,
                    mimeType: uploadedFile.type || "application/pdf",
                    fileBase64: await fileToBase64(uploadedFile),
                },
            ];
            if (solutionFile) {
                documents.push({
                    label: "Solution PDF",
                    fileName: solutionFile.name,
                    mimeType: solutionFile.type || "application/pdf",
                    fileBase64: await fileToBase64(solutionFile),
                });
            }

            const response = await fetch("/api/ai-tools/translate-document", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    mode: "pdf",
                    provider: aiProvider,
                    modelId,
                    targetLanguage: translateLanguage,
                    customPrompt: translatePrompt,
                    documents,
                }),
            });
            const payload = (await response.json()) as {
                success?: boolean;
                result?: TranslationReport;
                error?: string;
            };
            if (!response.ok || !payload.success || !payload.result) {
                throw new Error(payload.error || "Translation failed.");
            }
            setTranslationReport(payload.result);
            await saveReportToHistory("translate", uploadedFile.name, payload.result);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProcessing(false);
        }
    }, [uploadedFile, solutionFile, aiProvider, modelId, userApiKeys, translateLanguage, translatePrompt, saveReportToHistory]);

    // Derived
    const currentProviderModels = providerModels[aiProvider] || AI_PROVIDER_MODELS[aiProvider];
    const isCurrentModelListed = currentProviderModels.some((m) => m.id === modelId);
    const hasSavedProviderKey = Boolean(getProviderApiCredential(aiProvider, userApiKeys[aiProvider] || ""));
    const hasResolvedProviderKey = hasSavedProviderKey || usingLiveModels;

    const toggleQuestionExpand = (num: number) => {
        setExpandedQuestions((prev) => {
            const next = new Set(prev);
            if (next.has(num)) next.delete(num);
            else next.add(num);
            return next;
        });
    };

    const renderPromptEditor = (
        label: string,
        value: string,
        onChange: (value: string) => void,
        defaultValue: string
    ) => (
        <div style={{ display: "grid", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                    {label}
                </label>
                <button
                    type="button"
                    onClick={() => onChange(defaultValue)}
                    style={{
                        border: "1px solid var(--border-primary)",
                        borderRadius: "7px",
                        background: "var(--bg-tertiary)",
                        color: "var(--text-secondary)",
                        padding: "5px 9px",
                        fontSize: "0.72rem",
                        fontWeight: 650,
                        cursor: "pointer",
                    }}
                >
                    Reset
                </button>
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                rows={8}
                spellCheck={false}
                style={{
                    width: "100%",
                    resize: "vertical",
                    minHeight: "140px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-tertiary)",
                    color: "var(--text-primary)",
                    fontSize: "0.78rem",
                    lineHeight: 1.5,
                    outline: "none",
                    fontFamily: "inherit",
                }}
            />
        </div>
    );

    // ==================== RENDER ====================

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar
                activeTab="ai"
                onTabChange={(tab) => {
                    if (tab === "questions") router.push("/questions");
                    if (tab === "tests") router.push("/tests");
                    if (tab === "analytics") router.push("/analytics");
                    if (tab === "upload") router.push("/upload");
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
                            background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
                            color: "#fff",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        <Sparkles size={16} />
                    </div>
                    <div>
                        <div style={{ fontSize: "0.95rem", fontWeight: 650 }}>AI Tools</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                            Quality check, solve, and analyze question papers using AI
                        </div>
                    </div>
                </header>

                {/* Content */}
                <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 36px" }}>
                    <div style={{ maxWidth: "900px", margin: "0 auto", display: "grid", gap: "16px" }}>
                        {/* Mode Toggle */}
                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
                                gap: "8px",
                                padding: "4px",
                                borderRadius: "12px",
                                background: "var(--bg-tertiary)",
                                border: "1px solid var(--border-primary)",
                            }}
                        >
                            {(
                                [
                                    { id: "qc", label: "AI QC", icon: <CheckCircle2 size={15} /> },
                                    { id: "solution", label: "AI Solution", icon: <Sparkles size={15} /> },
                                    { id: "modification", label: "AI Modification", icon: <Wand2 size={15} /> },
                                    { id: "repeat_check", label: "AI Repeat Check", icon: <Files size={15} /> },
                                    { id: "translate", label: "AI Translate", icon: <Languages size={15} /> },
                                ] as { id: AIToolMode; label: string; icon: React.ReactNode; disabled?: boolean }[]
                            ).map((mode) => (
                                <button
                                    key={mode.id}
                                    type="button"
                                    onClick={() => {
                                        if (!mode.disabled) {
                                            setActiveMode(mode.id);
                                            setError(null);
                                            setQcReport(null);
                                            setSolutionReport(null);
                                            setModificationReport(null);
                                            setRepeatCheckReport(null);
                                            setTranslationReport(null);
                                        }
                                    }}
                                    disabled={mode.disabled}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px",
                                        border: "none",
                                        borderRadius: "8px",
                                        padding: "10px 14px",
                                        fontSize: "0.82rem",
                                        fontWeight: activeMode === mode.id ? 700 : 500,
                                        cursor: mode.disabled ? "default" : "pointer",
                                        background:
                                            activeMode === mode.id
                                                ? "var(--accent-glow)"
                                                : "transparent",
                                        color: mode.disabled
                                            ? "var(--text-muted)"
                                            : activeMode === mode.id
                                                ? "var(--accent-primary-hover)"
                                                : "var(--text-secondary)",
                                        opacity: mode.disabled ? 0.5 : 1,
                                        transition: "all 0.15s ease",
                                        position: "relative",
                                    }}
                                >
                                    {mode.icon}
                                    {mode.label}
                                    {mode.disabled && (
                                        <span
                                            style={{
                                                fontSize: "0.6rem",
                                                padding: "1px 5px",
                                                borderRadius: "3px",
                                                background: "rgba(107,114,128,0.2)",
                                                color: "var(--text-muted)",
                                                fontWeight: 600,
                                            }}
                                        >
                                            Soon
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>

                        {/* AI Provider & Model Section */}
                        <div
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "12px",
                                padding: "20px",
                                background: "var(--bg-secondary)",
                                display: "grid",
                                gap: "16px",
                            }}
                        >
                            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                AI Configuration
                            </div>

                            {/* Provider buttons */}
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

                            {/* Model dropdown */}
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
                            </div>
                        </div>

                        {/* File Upload */}
                        <div
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "12px",
                                padding: "20px",
                                background: "var(--bg-secondary)",
                                display: "grid",
                                gap: "12px",
                            }}
                        >
                            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                {activeMode === "repeat_check"
                                    ? "Upload PDFs for Repeat Check"
                                    : activeMode === "qc" || activeMode === "translate"
                                        ? "Upload Question Paper"
                                        : "Upload File"}
                            </div>
                            {activeMode === "repeat_check" ? (
                                <>
                                    <div
                                        onClick={() => repeatFilesInputRef.current?.click()}
                                        style={{
                                            border: `2px dashed ${repeatCheckFiles.length > 0 ? "rgba(34,197,94,0.5)" : "var(--border-primary)"}`,
                                            borderRadius: "10px",
                                            padding: "28px 20px",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "8px",
                                            cursor: "pointer",
                                            background: repeatCheckFiles.length > 0 ? "rgba(34,197,94,0.05)" : "var(--bg-tertiary)",
                                            transition: "all 0.15s ease",
                                        }}
                                    >
                                        <Files size={24} color={repeatCheckFiles.length > 0 ? "#22c55e" : "var(--text-muted)"} />
                                        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: repeatCheckFiles.length > 0 ? "#22c55e" : "var(--text-secondary)" }}>
                                            {repeatCheckFiles.length > 0 ? `${repeatCheckFiles.length} PDF files selected` : "Click to upload multiple PDF files"}
                                        </div>
                                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            AI will compare repeated questions within each PDF and across all uploaded PDFs
                                        </div>
                                    </div>
                                    {repeatCheckFiles.length > 0 && (
                                        <div style={{ display: "grid", gap: "6px" }}>
                                            {repeatCheckFiles.map((file) => (
                                                <div
                                                    key={`${file.name}-${file.size}`}
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "8px",
                                                        padding: "8px 10px",
                                                        borderRadius: "8px",
                                                        border: "1px solid var(--border-primary)",
                                                        background: "var(--bg-tertiary)",
                                                        fontSize: "0.76rem",
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    <FileUp size={13} />
                                                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                                                    <span style={{ color: "var(--text-muted)" }}>{(file.size / 1024).toFixed(1)} KB</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <input
                                        ref={repeatFilesInputRef}
                                        type="file"
                                        accept=".pdf"
                                        multiple
                                        onChange={handleRepeatFilesChange}
                                        style={{ display: "none" }}
                                    />
                                </>
                            ) : (
                                <>
                                    <div
                                        onClick={() => fileInputRef.current?.click()}
                                        style={{
                                            border: `2px dashed ${uploadedFile ? "rgba(34,197,94,0.5)" : "var(--border-primary)"}`,
                                            borderRadius: "10px",
                                            padding: "28px 20px",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "8px",
                                            cursor: "pointer",
                                            background: uploadedFile ? "rgba(34,197,94,0.05)" : "var(--bg-tertiary)",
                                            transition: "all 0.15s ease",
                                        }}
                                    >
                                        {uploadedFile ? (
                                            <>
                                                <CheckCircle2 size={24} color="#22c55e" />
                                                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#22c55e" }}>
                                                    {uploadedFile.name}
                                                </div>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                    {(uploadedFile.size / 1024).toFixed(1)} KB · Click to change
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <Upload size={24} color="var(--text-muted)" />
                                                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                                    Click to upload PDF or Word file
                                                </div>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                                    Supports .pdf, .doc, .docx · Max 50 questions
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".pdf,.doc,.docx"
                                        onChange={handleFileChange}
                                        style={{ display: "none" }}
                                    />
                                </>
                            )}

                            {/* Solution File Upload (QC / Translate) */}
                            {(activeMode === "qc" || activeMode === "translate") && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <div style={{ flex: 1, height: "1px", background: "var(--border-primary)" }} />
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                            Solution File (Optional)
                                        </span>
                                        <div style={{ flex: 1, height: "1px", background: "var(--border-primary)" }} />
                                    </div>
                                    <div
                                        onClick={() => solutionFileInputRef.current?.click()}
                                        style={{
                                            border: `2px dashed ${solutionFile ? "rgba(99,102,241,0.5)" : "var(--border-secondary)"}`,
                                            borderRadius: "10px",
                                            padding: "18px 16px",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "6px",
                                            cursor: "pointer",
                                            background: solutionFile ? "rgba(99,102,241,0.05)" : "var(--bg-tertiary)",
                                            transition: "all 0.15s ease",
                                        }}
                                    >
                                        {solutionFile ? (
                                            <>
                                                <CheckCircle2 size={20} color="#818cf8" />
                                                <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#818cf8" }}>
                                                    {solutionFile.name}
                                                </div>
                                                <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                                    {(solutionFile.size / 1024).toFixed(1)} KB · Click to change
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSolutionFile(null);
                                                        if (solutionFileInputRef.current) solutionFileInputRef.current.value = "";
                                                    }}
                                                    style={{
                                                        marginTop: "2px",
                                                        padding: "3px 10px",
                                                        borderRadius: "6px",
                                                        border: "1px solid rgba(239,68,68,0.3)",
                                                        background: "rgba(239,68,68,0.08)",
                                                        color: "#ef4444",
                                                        fontSize: "0.7rem",
                                                        fontWeight: 600,
                                                        cursor: "pointer",
                                                    }}
                                                >
                                                    Remove
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <Upload size={18} color="var(--text-muted)" />
                                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-tertiary)" }}>
                                                    Upload separate solution/answer key file
                                                </div>
                                                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                                    If solutions are in a separate file, upload it here
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <input
                                        ref={solutionFileInputRef}
                                        type="file"
                                        accept=".pdf,.doc,.docx"
                                        onChange={handleSolutionFileChange}
                                        style={{ display: "none" }}
                                    />
                                </>
                            )}
                        </div>

                        {/* Mode-specific form */}
                        {activeMode === "qc" && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    AI QC Configuration
                                </div>

                                {/* Exam Type */}
                                <div style={{ display: "grid", gap: "8px" }}>
                                    <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Exam Type <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
                                    </label>
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                        {(
                                            [
                                                { id: "", label: "None" },
                                                { id: "JEE_MAINS", label: "JEE Mains" },
                                                { id: "JEE_ADVANCE", label: "JEE Advance" },
                                                { id: "NEET", label: "NEET" },
                                            ] as { id: ExamTypeOption; label: string }[]
                                        ).map((opt) => (
                                            <button
                                                key={opt.id}
                                                type="button"
                                                onClick={() => setExamType(opt.id)}
                                                style={{
                                                    padding: "7px 12px",
                                                    borderRadius: "8px",
                                                    border: `1px solid ${examType === opt.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: examType === opt.id ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                    color: examType === opt.id ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                    fontSize: "0.78rem",
                                                    fontWeight: examType === opt.id ? 700 : 500,
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                }}
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* JEE Advance Pattern Options */}
                                {examType === "JEE_ADVANCE" && (
                                    <div
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "10px",
                                            padding: "14px",
                                            background: "var(--bg-tertiary)",
                                            display: "grid",
                                            gap: "12px",
                                        }}
                                    >
                                        <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                            JEE Advance Pattern Options
                                        </div>
                                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "12px" }}>
                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>Pattern Year</span>
                                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                                    {["2020", "2021", "2022", "2023", "2024", "2025"].map((year) => (
                                                        <button
                                                            key={year}
                                                            type="button"
                                                            onClick={() => setAdvancePatternYear(year)}
                                                            style={{
                                                                padding: "6px 12px",
                                                                borderRadius: "8px",
                                                                border: `1px solid ${advancePatternYear === year ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                                background: advancePatternYear === year ? "var(--accent-glow)" : "var(--bg-secondary)",
                                                                color: advancePatternYear === year ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                                fontSize: "0.76rem",
                                                                fontWeight: advancePatternYear === year ? 700 : 500,
                                                                cursor: "pointer",
                                                                transition: "all 0.15s ease",
                                                            }}
                                                        >
                                                            {year}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>Paper Type</span>
                                                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                                    {(["Paper 1", "Paper 2"] as PaperTypeOption[]).map((paper) => (
                                                        <button
                                                            key={paper}
                                                            type="button"
                                                            onClick={() => togglePaperType(paper)}
                                                            style={{
                                                                padding: "6px 12px",
                                                                borderRadius: "8px",
                                                                border: `1px solid ${paperType.includes(paper) ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                                background: paperType.includes(paper) ? "var(--accent-glow)" : "var(--bg-secondary)",
                                                                color: paperType.includes(paper) ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                                fontSize: "0.76rem",
                                                                fontWeight: paperType.includes(paper) ? 700 : 500,
                                                                cursor: "pointer",
                                                                transition: "all 0.15s ease",
                                                            }}
                                                        >
                                                            {paper}
                                                        </button>
                                                    ))}
                                                </div>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                                    {paperType.length === 2 ? "Both papers selected" : paperType.length === 1 ? `${paperType[0]} only` : "Select at least one paper"}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Syllabus Configuration */}
                                <div style={{ display: "grid", gap: "12px" }}>
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        Syllabus Configuration <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
                                    </div>

                                    {/* Subjects */}
                                    <div style={{ display: "grid", gap: "8px" }}>
                                        <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>Subjects</label>
                                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                            {subjectOptions.map((subject) => (
                                                <button
                                                    key={subject}
                                                    type="button"
                                                    onClick={() => toggleSubject(subject)}
                                                    style={{
                                                        padding: "7px 12px",
                                                        borderRadius: "8px",
                                                        border: `1px solid ${selectedSubjects.includes(subject) ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                        background: selectedSubjects.includes(subject) ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                        color: selectedSubjects.includes(subject) ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                        fontSize: "0.78rem",
                                                        fontWeight: selectedSubjects.includes(subject) ? 700 : 500,
                                                        cursor: "pointer",
                                                        transition: "all 0.15s ease",
                                                        minWidth: "90px",
                                                    }}
                                                >
                                                    {subject}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Full Syllabus Toggle */}
                                    <div style={{ display: "grid", gap: "8px" }}>
                                        <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>Full Syllabus?</label>
                                        <div style={{ display: "flex", gap: "6px" }}>
                                            {(["Yes", "No"] as const).map((val) => (
                                                <button
                                                    key={val}
                                                    type="button"
                                                    onClick={() => setFullSyllabus(val)}
                                                    style={{
                                                        padding: "7px 16px",
                                                        borderRadius: "8px",
                                                        border: `1px solid ${fullSyllabus === val ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                        background: fullSyllabus === val ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                        color: fullSyllabus === val ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                        fontSize: "0.78rem",
                                                        fontWeight: fullSyllabus === val ? 700 : 500,
                                                        cursor: "pointer",
                                                        transition: "all 0.15s ease",
                                                    }}
                                                >
                                                    {val}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Chapter Selection (when Full Syllabus = No) */}
                                    {fullSyllabus === "No" && (
                                        <div
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "10px",
                                                padding: "14px",
                                                background: "var(--bg-tertiary)",
                                                display: "grid",
                                                gap: "12px",
                                            }}
                                        >
                                            {loadingMetadata ? (
                                                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                                    <Loader2 size={14} className="animate-spin" />
                                                    Loading chapters...
                                                </div>
                                            ) : selectedSubjects.length === 0 ? (
                                                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                                                    Select at least one subject above to choose chapters.
                                                </div>
                                            ) : (
                                                selectedSubjects.map((subject) => {
                                                    const chapters = metadata.chaptersBySubject[subject] || [];
                                                    return (
                                                        <div key={subject} style={{ display: "grid", gap: "8px" }}>
                                                            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>{subject}</div>
                                                            {chapters.length === 0 ? (
                                                                <div style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>No chapters available for {subject}.</div>
                                                            ) : (
                                                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                                                    {chapters.map((chapter) => (
                                                                        <button
                                                                            key={chapter}
                                                                            type="button"
                                                                            onClick={() => toggleChapter(chapter)}
                                                                            style={{
                                                                                padding: "5px 10px",
                                                                                borderRadius: "7px",
                                                                                border: `1px solid ${selectedChapters.includes(chapter) ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                                                background: selectedChapters.includes(chapter) ? "var(--accent-glow)" : "var(--bg-secondary)",
                                                                                color: selectedChapters.includes(chapter) ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                                                fontSize: "0.74rem",
                                                                                fontWeight: selectedChapters.includes(chapter) ? 600 : 400,
                                                                                cursor: "pointer",
                                                                                transition: "all 0.15s ease",
                                                                            }}
                                                                        >
                                                                            {chapter}
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>
                                    )}
                                </div>

                                {renderPromptEditor("AI QC Prompt", qcPrompt, setQcPrompt, DEFAULT_QC_PROMPT)}

                                {/* Run Button */}
                                <button
                                    type="button"
                                    onClick={handleQueueToBackground}
                                    disabled={!uploadedFile}
                                    style={{
                                        width: "100%",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary)",
                                        background: !uploadedFile
                                            ? "var(--accent-glow)"
                                            : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                        color: !uploadedFile ? "var(--accent-primary-hover)" : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor: !uploadedFile ? "default" : "pointer",
                                        opacity: !uploadedFile ? 0.6 : 1,
                                        transition: "all 0.2s ease",
                                    }}
                                >
                                    <Upload size={16} />
                                    Queue AI Quality Check
                                </button>
                            </div>
                        )}

                        {activeMode === "solution" && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    AI Solution Configuration
                                </div>
                                <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                    Upload a question file above and the AI will generate solutions and answer keys for each question.
                                </div>

                                {renderPromptEditor("AI Solution Prompt", solutionPrompt, setSolutionPrompt, DEFAULT_SOLUTION_PROMPT)}

                                <button
                                    type="button"
                                    onClick={handleQueueToBackground}
                                    disabled={!uploadedFile}
                                    style={{
                                        width: "100%",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary)",
                                        background: !uploadedFile
                                            ? "var(--accent-glow)"
                                            : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                        color: !uploadedFile ? "var(--accent-primary-hover)" : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor: !uploadedFile ? "default" : "pointer",
                                        opacity: !uploadedFile ? 0.6 : 1,
                                        transition: "all 0.2s ease",
                                    }}
                                >
                                    <Upload size={16} />
                                    Queue AI Solutions Generation
                                </button>
                            </div>
                        )}

                        {activeMode === "modification" && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    AI Modification Configuration
                                </div>

                                {/* Modification Mode */}
                                <div style={{ display: "grid", gap: "10px" }}>
                                    <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Modification Mode
                                    </label>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                        {([
                                            {
                                                id: "light" as ModificationMode,
                                                label: "Light Modification",
                                                emoji: "✏️",
                                                desc: "Changes question data, options, answer numbers, and phrasing. Core concept stays identical.",
                                                color: "#60a5fa",
                                            },
                                            {
                                                id: "hard" as ModificationMode,
                                                label: "Hard Modification",
                                                emoji: "🔥",
                                                desc: "Creates substantially new questions inspired by originals. Harder, ungoogleable, same chapter & concept.",
                                                color: "#f97316",
                                            },
                                        ]).map((opt) => (
                                            <button
                                                key={opt.id}
                                                type="button"
                                                onClick={() => setModificationMode(opt.id)}
                                                style={{
                                                    padding: "14px",
                                                    borderRadius: "10px",
                                                    border: `2px solid ${modificationMode === opt.id ? opt.color : "var(--border-primary)"}`,
                                                    background: modificationMode === opt.id ? `${opt.color}10` : "var(--bg-tertiary)",
                                                    cursor: "pointer",
                                                    textAlign: "left",
                                                    display: "grid",
                                                    gap: "6px",
                                                    transition: "all 0.15s ease",
                                                }}
                                            >
                                                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: modificationMode === opt.id ? opt.color : "var(--text-primary)" }}>
                                                    {opt.emoji} {opt.label}
                                                </div>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.4 }}>
                                                    {opt.desc}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {renderPromptEditor("AI Modification Prompt", modificationPrompt, setModificationPrompt, DEFAULT_MODIFICATION_PROMPT)}

                                {/* Run Button */}
                                <button
                                    type="button"
                                    onClick={handleRunModification}
                                    disabled={processing || !uploadedFile}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: `1px solid ${modificationMode === "hard" ? "#f97316" : "var(--accent-primary)"}`,
                                        background: processing || !uploadedFile
                                            ? "var(--accent-glow)"
                                            : modificationMode === "hard"
                                                ? "linear-gradient(135deg, #f97316, #ea580c)"
                                                : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                        color: processing || !uploadedFile ? "var(--accent-primary-hover)" : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor: processing || !uploadedFile ? "default" : "pointer",
                                        opacity: processing || !uploadedFile ? 0.6 : 1,
                                        transition: "all 0.2s ease",
                                    }}
                                >
                                    <Upload size={16} />
                                    Queue AI Modification
                                </button>
                            </div>
                        )}

                        {activeMode === "repeat_check" && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    AI Repeat Check Configuration
                                </div>
                                <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                                    Upload multiple PDFs above to detect repeated questions within the same file and across different files, including semantic matches.
                                </div>

                                {renderPromptEditor("AI Repeat Check Prompt", repeatCheckPrompt, setRepeatCheckPrompt, DEFAULT_REPEAT_CHECK_PROMPT)}

                                <button
                                    type="button"
                                    onClick={handleRunRepeatCheck}
                                    disabled={processing || repeatCheckFiles.length < 2}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary)",
                                        background: processing || repeatCheckFiles.length < 2
                                            ? "var(--accent-glow)"
                                            : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                        color: processing || repeatCheckFiles.length < 2 ? "var(--accent-primary-hover)" : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor: processing || repeatCheckFiles.length < 2 ? "default" : "pointer",
                                        opacity: processing || repeatCheckFiles.length < 2 ? 0.6 : 1,
                                        transition: "all 0.2s ease",
                                    }}
                                >
                                    {processing ? <Loader2 size={16} className="animate-spin" /> : <Files size={16} />}
                                    {processing ? "Checking Repeats..." : "Run AI Repeat Check"}
                                </button>
                            </div>
                        )}

                        {activeMode === "translate" && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ display: "grid", gap: "4px" }}>
                                    <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        Translate Uploaded Paper
                                    </div>
                                    <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                        Upload a question PDF and optionally a solution PDF. Gemini reads the PDF and returns a translated version for preview and download.
                                    </div>
                                </div>

                                <label style={{ display: "grid", gap: "6px" }}>
                                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                        Translate To
                                    </span>
                                    <input
                                        value={translateLanguage}
                                        onChange={(event) => setTranslateLanguage(event.target.value)}
                                        placeholder="Hindi, Marathi, Bengali..."
                                        style={{
                                            width: "100%",
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "9px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            padding: "10px 12px",
                                            fontSize: "0.86rem",
                                        }}
                                    />
                                </label>

                                {renderPromptEditor("AI Translate Prompt", translatePrompt, setTranslatePrompt, DEFAULT_TRANSLATE_PROMPT)}

                                <button
                                    type="button"
                                    onClick={handleQueueToBackground}
                                    disabled={!uploadedFile}
                                    style={{
                                        width: "100%",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        padding: "12px 20px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary)",
                                        background: !uploadedFile
                                            ? "var(--accent-glow)"
                                            : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                                        color: !uploadedFile ? "var(--accent-primary-hover)" : "#fff",
                                        fontSize: "0.88rem",
                                        fontWeight: 700,
                                        cursor: !uploadedFile ? "default" : "pointer",
                                        opacity: !uploadedFile ? 0.6 : 1,
                                        marginTop: "4px",
                                    }}
                                >
                                    <Upload size={16} />
                                    Queue PDF Translation
                                </button>
                            </div>
                        )}

                        {/* Video Solution moved to its own page (/video-solution,
                            gated by "use_video_solution" independent of
                            "use_ai_tools") — no longer a switchable tab here. */}

                        {/* Error */}
                        {error && (
                            <div
                                style={{
                                    padding: "12px 16px",
                                    borderRadius: "10px",
                                    border: "1px solid rgba(var(--accent-danger-rgb), 0.35)",
                                    background: "rgba(var(--accent-danger-rgb), 0.08)",
                                    color: "var(--accent-danger)",
                                    fontSize: "0.82rem",
                                    display: "flex",
                                    alignItems: "flex-start",
                                    gap: "8px",
                                }}
                            >
                                <AlertCircle size={16} style={{ marginTop: "1px", flexShrink: 0 }} />
                                <span>{error}</span>
                                <button
                                    onClick={() => setError(null)}
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
                        )}

                        {translationReport && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "14px",
                                }}
                            >
                                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                                    <div>
                                        <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                            Translated Version ({translationReport.targetLanguage})
                                        </div>
                                        {translationReport.notes && (
                                            <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginTop: "3px" }}>
                                                {translationReport.notes}
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                        <button
                                            type="button"
                                            onClick={() => downloadTranslationAsPDF({
                                                title: uploadedFile?.name || "Translated Paper",
                                                targetLanguage: translationReport.targetLanguage,
                                                html: translationReport.translatedHtml,
                                                plainText: translationReport.plainText,
                                                filename: `${uploadedFile?.name || "paper"}-${translationReport.targetLanguage}`,
                                            })}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                padding: "8px 12px",
                                                borderRadius: "8px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                cursor: "pointer",
                                                fontSize: "0.8rem",
                                                fontWeight: 650,
                                            }}
                                        >
                                            <Download size={14} />
                                            PDF
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => downloadTranslationAsDocx({
                                                title: uploadedFile?.name || "Translated Paper",
                                                targetLanguage: translationReport.targetLanguage,
                                                html: translationReport.translatedHtml,
                                                plainText: translationReport.plainText,
                                                filename: `${uploadedFile?.name || "paper"}-${translationReport.targetLanguage}`,
                                            })}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                padding: "8px 12px",
                                                borderRadius: "8px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                cursor: "pointer",
                                                fontSize: "0.8rem",
                                                fontWeight: 650,
                                            }}
                                        >
                                            <Download size={14} />
                                            Word
                                        </button>
                                    </div>
                                </div>
                                <div
                                    style={{
                                        padding: "14px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-tertiary)",
                                        maxHeight: "620px",
                                        overflow: "auto",
                                    }}
                                >
                                    <MathContent
                                        html={translationReport.translatedHtml || `<pre>${translationReport.plainText}</pre>`}
                                        className="question-html"
                                        style={{ fontSize: "0.88rem", lineHeight: 1.7 }}
                                    />
                                </div>
                            </div>
                        )}

                        {/* QC Report Results */}
                        {qcReport && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    📋 AI QC Report
                                </div>

                                {/* Summary stats */}
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                                        gap: "10px",
                                    }}
                                >
                                    {[
                                        { label: "Total Questions", value: qcReport.totalQuestions, color: "var(--text-primary)" },
                                        { label: "Analyzed", value: qcReport.questionsAnalyzed, color: "#60a5fa" },
                                        { label: "Answer Matches", value: qcReport.answerKeyMatches, color: "#22c55e" },
                                        { label: "Mismatches", value: qcReport.answerKeyMismatches, color: "#ef4444" },
                                    ].map((stat) => (
                                        <div
                                            key={stat.label}
                                            style={{
                                                padding: "12px",
                                                borderRadius: "10px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                textAlign: "center",
                                            }}
                                        >
                                            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: stat.color }}>{stat.value}</div>
                                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "2px" }}>{stat.label}</div>
                                        </div>
                                    ))}
                                </div>

                                {/* Chapter Distribution */}
                                {Object.keys(qcReport.chapterDistribution).length > 0 && (
                                    <div style={{ display: "grid", gap: "6px" }}>
                                        <div style={{ fontSize: "0.82rem", fontWeight: 650, color: "var(--text-secondary)" }}>
                                            Chapter Distribution
                                        </div>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                            {Object.entries(qcReport.chapterDistribution).map(([ch, count]) => (
                                                <span
                                                    key={ch}
                                                    style={{
                                                        padding: "4px 10px",
                                                        borderRadius: "6px",
                                                        fontSize: "0.72rem",
                                                        fontWeight: 600,
                                                        background: "rgba(99,102,241,0.1)",
                                                        color: "#818cf8",
                                                        border: "1px solid rgba(99,102,241,0.2)",
                                                    }}
                                                >
                                                    {ch}: {count}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Pattern / Syllabus Analysis */}
                                {qcReport.patternAnalysis && (
                                    <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
                                        <div style={{ fontSize: "0.78rem", fontWeight: 650, color: "var(--text-secondary)", marginBottom: "6px" }}>Pattern Analysis</div>
                                        <div style={{ fontSize: "0.78rem", color: "var(--text-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{qcReport.patternAnalysis}</div>
                                    </div>
                                )}
                                {qcReport.syllabusAnalysis && (
                                    <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
                                        <div style={{ fontSize: "0.78rem", fontWeight: 650, color: "var(--text-secondary)", marginBottom: "6px" }}>Syllabus Analysis</div>
                                        <div style={{ fontSize: "0.78rem", color: "var(--text-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{qcReport.syllabusAnalysis}</div>
                                    </div>
                                )}

                                {/* Overall Suggestions */}
                                {qcReport.overallSuggestions.length > 0 && (
                                    <div style={{ display: "grid", gap: "6px" }}>
                                        <div style={{ fontSize: "0.82rem", fontWeight: 650, color: "var(--text-secondary)" }}>
                                            Overall Suggestions
                                        </div>
                                        {qcReport.overallSuggestions.map((s, i) => (
                                            <div
                                                key={i}
                                                style={{
                                                    padding: "8px 12px",
                                                    borderRadius: "8px",
                                                    background: "rgba(234,179,8,0.06)",
                                                    border: "1px solid rgba(234,179,8,0.2)",
                                                    fontSize: "0.78rem",
                                                    color: "var(--text-primary)",
                                                    lineHeight: 1.5,
                                                }}
                                            >
                                                💡 {s}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Per-question reports */}
                                <div style={{ display: "grid", gap: "6px" }}>
                                    <div style={{ fontSize: "0.82rem", fontWeight: 650, color: "var(--text-secondary)" }}>
                                        Per-Question Analysis
                                    </div>
                                    {qcReport.questions.map((q) => (
                                        <div
                                            key={q.questionNumber}
                                            style={{
                                                border: `1px solid ${q.answerMatch === false ? "rgba(239,68,68,0.3)" : "var(--border-primary)"}`,
                                                borderRadius: "10px",
                                                background: q.answerMatch === false ? "rgba(239,68,68,0.04)" : "var(--bg-tertiary)",
                                                overflow: "hidden",
                                            }}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => toggleQuestionExpand(q.questionNumber)}
                                                style={{
                                                    width: "100%",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "10px",
                                                    padding: "10px 14px",
                                                    border: "none",
                                                    background: "transparent",
                                                    cursor: "pointer",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.8rem",
                                                    fontWeight: 600,
                                                    textAlign: "left",
                                                }}
                                            >
                                                <span style={{
                                                    width: "22px", height: "22px", borderRadius: "6px", display: "grid", placeItems: "center",
                                                    background: q.answerMatch === true ? "rgba(34,197,94,0.15)" : q.answerMatch === false ? "rgba(239,68,68,0.15)" : "var(--bg-elevated)",
                                                    color: q.answerMatch === true ? "#22c55e" : q.answerMatch === false ? "#ef4444" : "var(--text-muted)",
                                                    fontSize: "0.72rem", fontWeight: 700, flexShrink: 0,
                                                }}>
                                                    {q.questionNumber}
                                                </span>
                                                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {q.correctness}
                                                </span>
                                                {q.answerMatch === true && <span style={{ fontSize: "0.68rem", color: "#22c55e", fontWeight: 700 }}>✓ Match</span>}
                                                {q.answerMatch === false && <span style={{ fontSize: "0.68rem", color: "#ef4444", fontWeight: 700 }}>✗ Mismatch</span>}
                                                {expandedQuestions.has(q.questionNumber) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                            </button>
                                            {expandedQuestions.has(q.questionNumber) && (
                                                <div style={{ padding: "0 14px 14px", display: "grid", gap: "8px" }}>
                                                    {q.aiAnswer !== null && (
                                                        <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                            <strong>AI Answer:</strong> {String(q.aiAnswer)}
                                                            {q.providedAnswer !== null && <> · <strong>Provided:</strong> {String(q.providedAnswer)}</>}
                                                        </div>
                                                    )}
                                                    {q.chapter && (
                                                        <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
                                                            {q.chapter}{q.topic ? ` → ${q.topic}` : ""}{q.questionType ? ` · ${q.questionType}` : ""}{q.difficulty ? ` · ${q.difficulty}` : ""}
                                                        </div>
                                                    )}
                                                    <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                        <strong>Language:</strong> {q.languageQuality}
                                                    </div>
                                                    {q.solutionQuality && (
                                                        <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                            <strong>Solution Quality:</strong> {q.solutionQuality}
                                                        </div>
                                                    )}
                                                    {q.suggestions.length > 0 && (
                                                        <div style={{ display: "grid", gap: "3px" }}>
                                                            {q.suggestions.map((s, i) => (
                                                                <div key={i} style={{ fontSize: "0.74rem", color: "#eab308", padding: "4px 8px", borderRadius: "6px", background: "rgba(234,179,8,0.06)" }}>
                                                                    💡 {s}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Solution Report Results */}
                        {solutionReport && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        📝 AI Solutions Report
                                    </div>
                                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                        {solutionReport.totalQuestions} questions
                                    </span>
                                </div>

                                {solutionReport.questions.map((q) => (
                                    <div
                                        key={q.questionNumber}
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "10px",
                                            background: "var(--bg-tertiary)",
                                            overflow: "hidden",
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggleQuestionExpand(q.questionNumber)}
                                            style={{
                                                width: "100%",
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "10px",
                                                padding: "12px 14px",
                                                border: "none",
                                                background: "transparent",
                                                cursor: "pointer",
                                                color: "var(--text-primary)",
                                                fontSize: "0.82rem",
                                                fontWeight: 600,
                                                textAlign: "left",
                                            }}
                                        >
                                            <span style={{
                                                width: "24px", height: "24px", borderRadius: "6px", display: "grid", placeItems: "center",
                                                background: "rgba(99,102,241,0.12)", color: "#818cf8",
                                                fontSize: "0.75rem", fontWeight: 700, flexShrink: 0,
                                            }}>
                                                {q.questionNumber}
                                            </span>
                                            <span style={{ flex: 1 }}>Question {q.questionNumber}</span>
                                            {q.answerKey !== null && (
                                                <span style={{
                                                    padding: "3px 8px", borderRadius: "6px",
                                                    background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                                                    fontSize: "0.72rem", fontWeight: 700, color: "#22c55e",
                                                }}>
                                                    Answer: {String(q.answerKey)}
                                                </span>
                                            )}
                                            {expandedQuestions.has(q.questionNumber) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                        </button>
                                        {expandedQuestions.has(q.questionNumber) && (
                                            <div style={{ padding: "0 14px 14px", display: "grid", gap: "10px" }}>
                                                {q.chapter && (
                                                    <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
                                                        {q.chapter}{q.topic ? ` → ${q.topic}` : ""}
                                                    </div>
                                                )}
                                                <div
                                                    style={{
                                                        padding: "14px",
                                                        borderRadius: "8px",
                                                        background: "var(--bg-secondary)",
                                                        border: "1px solid var(--border-primary)",
                                                    }}
                                                >
                                                    <div style={{ fontSize: "0.72rem", fontWeight: 650, color: "var(--text-muted)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                                        Solution
                                                    </div>
                                                    <style>{`
                                                        .ai-solution-content p {
                                                            margin: 0 0 8px 0;
                                                            line-height: 1.75;
                                                        }
                                                        .ai-solution-content p:last-child {
                                                            margin-bottom: 0;
                                                        }
                                                        .ai-solution-content .katex-display-wrapper {
                                                            margin: 10px 0;
                                                            padding: 8px 12px;
                                                            background: rgba(99,102,241,0.04);
                                                            border-radius: 6px;
                                                            border-left: 3px solid rgba(99,102,241,0.3);
                                                            overflow-x: auto;
                                                        }
                                                        .ai-solution-content strong {
                                                            color: var(--accent-primary-hover);
                                                        }
                                                    `}</style>
                                                    <MathContent
                                                        html={q.solution}
                                                        className="ai-solution-content"
                                                        style={{ fontSize: "0.84rem", lineHeight: 1.75, color: "var(--text-secondary)" }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Modification Report Results */}
                        {modificationReport && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        ✨ AI Modified Questions
                                    </div>
                                    <span style={{
                                        padding: "3px 8px",
                                        borderRadius: "6px",
                                        background: modificationReport.modificationMode === "hard" ? "rgba(249,115,22,0.12)" : "rgba(96,165,250,0.12)",
                                        border: `1px solid ${modificationReport.modificationMode === "hard" ? "rgba(249,115,22,0.3)" : "rgba(96,165,250,0.3)"}`,
                                        fontSize: "0.72rem",
                                        fontWeight: 700,
                                        color: modificationReport.modificationMode === "hard" ? "#f97316" : "#60a5fa",
                                    }}>
                                        {modificationReport.modificationMode === "hard" ? "🔥 Hard" : "✏️ Light"} Mode
                                    </span>
                                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                        {modificationReport.totalQuestions} questions
                                    </span>
                                </div>

                                {modificationReport.questions.map((q) => (
                                    <div
                                        key={q.questionNumber}
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "10px",
                                            background: "var(--bg-tertiary)",
                                            overflow: "hidden",
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggleQuestionExpand(q.questionNumber)}
                                            style={{
                                                width: "100%",
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "10px",
                                                padding: "12px 14px",
                                                border: "none",
                                                background: "transparent",
                                                cursor: "pointer",
                                                color: "var(--text-primary)",
                                                fontSize: "0.82rem",
                                                fontWeight: 600,
                                                textAlign: "left",
                                            }}
                                        >
                                            <span style={{
                                                width: "24px", height: "24px", borderRadius: "6px", display: "grid", placeItems: "center",
                                                background: modificationReport.modificationMode === "hard" ? "rgba(249,115,22,0.12)" : "rgba(99,102,241,0.12)",
                                                color: modificationReport.modificationMode === "hard" ? "#f97316" : "#818cf8",
                                                fontSize: "0.75rem", fontWeight: 700, flexShrink: 0,
                                            }}>
                                                {q.questionNumber}
                                            </span>
                                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {q.subject} › {q.chapter} › {q.questionType}
                                            </span>
                                            <span style={{
                                                padding: "2px 7px",
                                                borderRadius: "5px",
                                                fontSize: "0.68rem",
                                                fontWeight: 600,
                                                background: q.difficulty === "Hard" ? "rgba(239,68,68,0.1)" : q.difficulty === "Easy" ? "rgba(34,197,94,0.1)" : "rgba(234,179,8,0.1)",
                                                color: q.difficulty === "Hard" ? "#ef4444" : q.difficulty === "Easy" ? "#22c55e" : "#eab308",
                                            }}>
                                                {q.difficulty}
                                            </span>
                                            {expandedQuestions.has(q.questionNumber) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                        </button>
                                        {expandedQuestions.has(q.questionNumber) && (
                                            <div style={{ padding: "0 14px 14px", display: "grid", gap: "10px" }}>
                                                {/* Original Summary */}
                                                <div style={{
                                                    padding: "8px 10px",
                                                    borderRadius: "7px",
                                                    background: "rgba(107,114,128,0.06)",
                                                    border: "1px solid rgba(107,114,128,0.15)",
                                                }}>
                                                    <div style={{ fontSize: "0.68rem", fontWeight: 650, color: "var(--text-muted)", marginBottom: "3px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Original</div>
                                                    <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)", fontStyle: "italic" }}>{q.originalQuestionSummary}</div>
                                                </div>

                                                {/* Modified Question */}
                                                <div style={{
                                                    padding: "12px",
                                                    borderRadius: "8px",
                                                    background: "var(--bg-secondary)",
                                                    border: `1px solid ${modificationReport.modificationMode === "hard" ? "rgba(249,115,22,0.2)" : "rgba(99,102,241,0.2)"}`,
                                                }}>
                                                    <div style={{ fontSize: "0.68rem", fontWeight: 650, color: modificationReport.modificationMode === "hard" ? "#f97316" : "#818cf8", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Modified Question</div>
                                                    <MathContent
                                                        html={q.modifiedQuestionText}
                                                        className="question-html"
                                                        style={{ fontSize: "0.84rem", lineHeight: 1.65 }}
                                                    />
                                                </div>

                                                {/* Options */}
                                                {q.options.length > 0 && (
                                                    <div style={{ display: "grid", gap: "5px" }}>
                                                        {q.options.map((opt, idx) => (
                                                            <div
                                                                key={idx}
                                                                style={{
                                                                    display: "flex",
                                                                    alignItems: "flex-start",
                                                                    gap: "8px",
                                                                    padding: "7px 10px",
                                                                    borderRadius: "7px",
                                                                    border: `1px solid ${opt.isCorrect ? "rgba(34,197,94,0.3)" : "var(--border-primary)"}`,
                                                                    background: opt.isCorrect ? "rgba(34,197,94,0.05)" : "transparent",
                                                                }}
                                                            >
                                                                <span style={{
                                                                    width: "20px", height: "20px", borderRadius: "5px", display: "grid", placeItems: "center",
                                                                    background: opt.isCorrect ? "rgba(34,197,94,0.15)" : "var(--bg-elevated)",
                                                                    color: opt.isCorrect ? "#22c55e" : "var(--text-muted)",
                                                                    fontSize: "0.7rem", fontWeight: 700, flexShrink: 0,
                                                                }}>
                                                                    {String.fromCharCode(65 + idx)}
                                                                </span>
                                                                <MathContent
                                                                    html={opt.text}
                                                                    className="question-html"
                                                                    style={{ fontSize: "0.8rem", lineHeight: 1.5, flex: 1 }}
                                                                />
                                                                {opt.isCorrect && <span style={{ fontSize: "0.68rem", color: "#22c55e", fontWeight: 700 }}>✓</span>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Answer Key */}
                                                {q.answerKey !== null && (
                                                    <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                                                        <strong>Answer:</strong> {Array.isArray(q.answerKey) ? q.answerKey.join(", ") : String(q.answerKey)}
                                                    </div>
                                                )}

                                                {/* Solution */}
                                                {q.solutionText && (
                                                    <div style={{
                                                        padding: "10px 12px",
                                                        borderRadius: "8px",
                                                        background: "var(--bg-secondary)",
                                                        border: "1px solid var(--border-primary)",
                                                    }}>
                                                        <div style={{ fontSize: "0.68rem", fontWeight: 650, color: "var(--text-muted)", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Solution</div>
                                                        <MathContent
                                                            html={q.solutionText}
                                                            className="question-html"
                                                            style={{ fontSize: "0.8rem", lineHeight: 1.6 }}
                                                        />
                                                    </div>
                                                )}

                                                {/* Changes Summary */}
                                                {q.changesSummary && (
                                                    <div style={{
                                                        padding: "6px 10px",
                                                        borderRadius: "6px",
                                                        background: "rgba(234,179,8,0.06)",
                                                        border: "1px solid rgba(234,179,8,0.15)",
                                                        fontSize: "0.74rem",
                                                        color: "#eab308",
                                                    }}>
                                                        💡 {q.changesSummary}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {repeatCheckReport && (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "20px",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "16px",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                    <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        AI Repeat Check Report
                                    </div>
                                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                        {repeatCheckReport.filesAnalyzed} files analyzed
                                    </span>
                                </div>

                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                                        gap: "10px",
                                    }}
                                >
                                    {[
                                        { label: "Questions Detected", value: repeatCheckReport.totalQuestionsDetected, color: "#60a5fa" },
                                        { label: "Duplicate Pairs", value: repeatCheckReport.duplicatePairs, color: repeatCheckReport.duplicatePairs > 0 ? "#f97316" : "#22c55e" },
                                        { label: "Repeat Groups", value: repeatCheckReport.groups.length, color: "#818cf8" },
                                    ].map((stat) => (
                                        <div
                                            key={stat.label}
                                            style={{
                                                padding: "12px",
                                                borderRadius: "10px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                textAlign: "center",
                                            }}
                                        >
                                            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: stat.color }}>{stat.value}</div>
                                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "2px" }}>{stat.label}</div>
                                        </div>
                                    ))}
                                </div>

                                {repeatCheckReport.summary && (
                                    <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", fontSize: "0.8rem", lineHeight: 1.6, color: "var(--text-secondary)" }}>
                                        {repeatCheckReport.summary}
                                    </div>
                                )}

                                {repeatCheckReport.groups.length === 0 ? (
                                    <div
                                        style={{
                                            padding: "18px",
                                            borderRadius: "10px",
                                            border: "1px solid rgba(34,197,94,0.25)",
                                            background: "rgba(34,197,94,0.06)",
                                            color: "#22c55e",
                                            fontSize: "0.84rem",
                                            fontWeight: 650,
                                        }}
                                    >
                                        No repeated questions found.
                                    </div>
                                ) : (
                                    <div style={{ display: "grid", gap: "10px" }}>
                                        {repeatCheckReport.groups.map((group) => (
                                            <div
                                                key={group.groupId}
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: "10px",
                                                    background: "var(--bg-tertiary)",
                                                    overflow: "hidden",
                                                }}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => toggleQuestionExpand(group.groupId)}
                                                    style={{
                                                        width: "100%",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "10px",
                                                        padding: "12px 14px",
                                                        border: "none",
                                                        background: "transparent",
                                                        cursor: "pointer",
                                                        color: "var(--text-primary)",
                                                        textAlign: "left",
                                                    }}
                                                >
                                                    <span style={{
                                                        width: "26px",
                                                        height: "26px",
                                                        borderRadius: "7px",
                                                        display: "grid",
                                                        placeItems: "center",
                                                        background: "rgba(249,115,22,0.12)",
                                                        color: "#f97316",
                                                        fontSize: "0.74rem",
                                                        fontWeight: 800,
                                                        flexShrink: 0,
                                                    }}>
                                                        {group.groupId}
                                                    </span>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>
                                                            {group.matchType} match · {group.similarityPercent}% same
                                                        </div>
                                                        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                            {group.reason || `${group.items.length} repeated instances`}
                                                        </div>
                                                    </div>
                                                    {expandedQuestions.has(group.groupId) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                                </button>
                                                {expandedQuestions.has(group.groupId) && (
                                                    <div style={{ padding: "0 14px 14px", display: "grid", gap: "8px" }}>
                                                        {group.items.map((item, index) => (
                                                            <div
                                                                key={`${group.groupId}-${index}`}
                                                                style={{
                                                                    padding: "10px 12px",
                                                                    borderRadius: "8px",
                                                                    border: "1px solid var(--border-primary)",
                                                                    background: "var(--bg-secondary)",
                                                                    display: "grid",
                                                                    gap: "6px",
                                                                }}
                                                            >
                                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                                                    <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>{item.fileName}</span>
                                                                    <span>Page {item.pageNumber ?? "N/A"}</span>
                                                                    <span>Question {item.questionNumber ?? "N/A"}</span>
                                                                </div>
                                                                <div style={{ fontSize: "0.8rem", color: "var(--text-primary)", lineHeight: 1.55 }}>
                                                                    {item.questionText}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {/* Background video jobs banner — shows when there are
                            video renders still running server-side (survives
                            navigation; the report appears in the list below
                            when the job completes). */}
                        {activeVideoJobs.length > 0 && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
                                    padding: "10px 14px",
                                    borderRadius: "10px",
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
                                            <code style={{ background: "rgba(245,158,11,0.15)", padding: "0 4px", borderRadius: "3px" }}>
                                                {j.fileName.slice(0, 40)}
                                            </code>
                                        </span>
                                    ))}
                                    {". Feel free to use other tools — finished videos appear in the report list below."}
                                </span>
                            </div>
                        )}

                        {/* ==================== REPORT HISTORY ==================== */}
                        <div
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "12px",
                                background: "var(--bg-secondary)",
                                overflow: "hidden",
                            }}
                        >
                            {/* History Header */}
                            <button
                                type="button"
                                onClick={() => setHistoryExpanded((prev) => !prev)}
                                style={{
                                    width: "100%",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
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
                                        width: "28px",
                                        height: "28px",
                                        borderRadius: "8px",
                                        background: "rgba(99,102,241,0.12)",
                                        color: "#818cf8",
                                        display: "grid",
                                        placeItems: "center",
                                    }}
                                >
                                    <History size={14} />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: "0.88rem", fontWeight: 700 }}>Report History</div>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                        {savedReports.length} saved report{savedReports.length !== 1 ? "s" : ""}
                                    </div>
                                </div>
                                {historyExpanded ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
                            </button>

                            {historyExpanded && (
                                <div style={{ padding: "0 20px 20px", display: "grid", gap: "12px" }}>
                                    {/* Filter pills */}
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                        {(
                                            [
                                                { id: "all" as const, label: "All" },
                                                { id: "qc" as const, label: "QC" },
                                                { id: "solution" as const, label: "Solution" },
                                                { id: "modification" as const, label: "Modification" },
                                                { id: "repeat_check" as const, label: "Repeat Check" },
                                                { id: "extraction" as const, label: "Extraction" },
                                                { id: "translate" as const, label: "Translate" },
                                                { id: "video" as const, label: "Video" },
                                            ]
                                        ).map((f) => (
                                            <button
                                                key={f.id}
                                                type="button"
                                                onClick={() => setHistoryFilterType(f.id)}
                                                style={{
                                                    padding: "5px 12px",
                                                    borderRadius: "7px",
                                                    border: `1px solid ${historyFilterType === f.id ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: historyFilterType === f.id ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                    color: historyFilterType === f.id ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                                    fontSize: "0.74rem",
                                                    fontWeight: historyFilterType === f.id ? 700 : 500,
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                }}
                                            >
                                                {f.label}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Report list */}
                                    {(() => {
                                        const filtered = historyFilterType === "all"
                                            ? savedReports
                                            : savedReports.filter((r) => r.report_type === historyFilterType);

                                        if (filtered.length === 0) {
                                            return (
                                                <div
                                                    style={{
                                                        padding: "28px 16px",
                                                        textAlign: "center",
                                                        color: "var(--text-muted)",
                                                        fontSize: "0.8rem",
                                                    }}
                                                >
                                                    {savedReports.length === 0
                                                            ? "No reports generated yet. Run an AI tool above to get started."
                                                            : "No reports match the selected filter."}
                                                </div>
                                            );
                                        }

                                        return (
                                            <div style={{ display: "grid", gap: "6px" }}>
                                                {filtered.map((entry) => {
                                                    const typeConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
                                                        qc: { label: "QC", color: "#22c55e", bg: "rgba(34,197,94,0.1)", border: "rgba(34,197,94,0.25)" },
                                                        solution: { label: "Solution", color: "#818cf8", bg: "rgba(99,102,241,0.1)", border: "rgba(99,102,241,0.25)" },
                                                        modification: { label: "Modification", color: "#f97316", bg: "rgba(249,115,22,0.1)", border: "rgba(249,115,22,0.25)" },
                                                        repeat_check: { label: "Repeat", color: "#60a5fa", bg: "rgba(96,165,250,0.1)", border: "rgba(96,165,250,0.25)" },
                                                        translate: { label: "Translate", color: "#c084fc", bg: "rgba(192,132,252,0.1)", border: "rgba(192,132,252,0.25)" },
                                                        video: { label: "Video", color: "#f59e0b", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.25)" },
                                                    };
                                                    const isVideoReport = entry.report_type === "video";
                                                    // Video report metadata, if present, lives on report_data.
                                                    const videoMeta = (() => {
                                                        if (!isVideoReport) return null;
                                                        const d = (entry.report_data || {}) as {
                                                            videoCount?: number;
                                                            voice?: string;
                                                            language?: string;
                                                            ttsEngine?: string;
                                                        };
                                                        return d;
                                                    })();
                                                    const tc = typeConfig[entry.report_type] || typeConfig.qc;
                                                    const isLoading = loadingReportId === entry.id;
                                                    const date = new Date(entry.created_at);
                                                    const timeStr = date.toLocaleDateString("en-IN", {
                                                        day: "2-digit",
                                                        month: "short",
                                                        year: "numeric",
                                                    }) + " · " + date.toLocaleTimeString("en-IN", {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                    });

                                                    return (
                                                        <div
                                                            key={entry.id}
                                                            style={{
                                                                display: "flex",
                                                                alignItems: "center",
                                                                gap: "10px",
                                                                padding: "10px 12px",
                                                                borderRadius: "9px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                cursor: isVideoReport ? "default" : (isLoading ? "default" : "pointer"),
                                                                transition: "all 0.15s ease",
                                                                opacity: isLoading ? 0.7 : 1,
                                                            }}
                                                            onClick={() => {
                                                                if (isVideoReport) return; // video rows have their own Download button
                                                                if (!isLoading) void loadFullReport(entry);
                                                            }}
                                                        >
                                                            {/* Type badge */}
                                                            <span
                                                                style={{
                                                                    padding: "3px 8px",
                                                                    borderRadius: "6px",
                                                                    fontSize: "0.68rem",
                                                                    fontWeight: 700,
                                                                    background: tc.bg,
                                                                    color: tc.color,
                                                                    border: `1px solid ${tc.border}`,
                                                                    whiteSpace: "nowrap",
                                                                    flexShrink: 0,
                                                                }}
                                                            >
                                                                {tc.label}
                                                            </span>

                                                            {/* File name & metadata */}
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
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.68rem",
                                                                        color: "var(--text-muted)",
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: "6px",
                                                                        marginTop: "1px",
                                                                    }}
                                                                >
                                                                    <Clock size={10} />
                                                                    {timeStr}
                                                                    <span style={{ opacity: 0.5 }}>·</span>
                                                                    {entry.provider}/{entry.model_id?.split("/").pop() || entry.model_id}
                                                                    {videoMeta && (
                                                                        <>
                                                                            <span style={{ opacity: 0.5 }}>·</span>
                                                                            <span>
                                                                                {videoMeta.videoCount ?? "?"} videos
                                                                                {videoMeta.voice ? ` • ${videoMeta.voice}` : ""}
                                                                                {videoMeta.language ? ` • ${videoMeta.language}` : ""}
                                                                            </span>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Loading indicator */}
                                                            {isLoading && <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)", flexShrink: 0 }} />}

                                                            {/* Download button for video reports */}
                                                            {isVideoReport && (
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const url = `/api/ai-tools/video-solution/artifact?report_id=${encodeURIComponent(entry.id)}`;
                                                                        // Server returns a 302 redirect to a 1-hour signed URL.
                                                                        window.open(url, "_blank");
                                                                    }}
                                                                    title="Download video ZIP"
                                                                    style={{
                                                                        width: "26px",
                                                                        height: "26px",
                                                                        borderRadius: "6px",
                                                                        border: "1px solid var(--border-primary)",
                                                                        background: "var(--bg-secondary)",
                                                                        color: "var(--accent-primary)",
                                                                        cursor: "pointer",
                                                                        display: "grid",
                                                                        placeItems: "center",
                                                                        flexShrink: 0,
                                                                        transition: "all 0.15s ease",
                                                                    }}
                                                                >
                                                                    <Download size={13} />
                                                                </button>
                                                            )}

                                                            {/* Delete button */}
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    deleteReportFromContext(entry.id);
                                                                }}
                                                                title="Delete report"
                                                                style={{
                                                                    width: "26px",
                                                                    height: "26px",
                                                                    borderRadius: "6px",
                                                                    border: "1px solid rgba(239,68,68,0.2)",
                                                                    background: "rgba(239,68,68,0.05)",
                                                                    color: "#f87171",
                                                                    cursor: "pointer",
                                                                    display: "grid",
                                                                    placeItems: "center",
                                                                    flexShrink: 0,
                                                                    transition: "all 0.15s ease",
                                                                }}
                                                            >
                                                                <Trash2 size={12} />
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
