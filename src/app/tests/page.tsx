"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    ArrowDown,
    ArrowUp,
    AlertCircle,
    Bot,
    Calendar,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Database,
    Download,
    Eye,
    Languages,
    Loader2,
    Plus,
    Pencil,
    RefreshCw,
    Sparkles,
    Trash2,
    Wand2,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import { downloadTestAsPDF, downloadTestAsDocx } from "@/lib/downloadTest";
import type {
    FinalizedQuestionUsage,
    GeneratedTest,
    JeeAdvancedPaper,
    MetadataHierarchy,
    Question,
    TestAiVerificationReport,
    TestHistoryDetail,
    TestHistoryQuestionItem,
    TestHistorySummary,
    TestGenerationConfig,
    TestGenerationResponse,
} from "@/types";
import {
    getQuestionTypeLabel,
    JEE_ADVANCED_PATTERN_MATRIX,
    normalizeAnswerKey,
    resolveAnswerKey,
    type QuestionType,
} from "@/types";
import { DIFFICULTY_COLORS, KNOWN_QUESTION_TYPES } from "@/lib/constants";
import { fetchAvailableLanguages } from "@/lib/api/translations";
import { SUPPORTED_TRANSLATION_LANGUAGES } from "@/types";
import { useQuestionTaskQueue } from "@/context/QuestionTaskQueueContext";
import { compareChaptersBySubject } from "@/lib/chapterOrder";
import QuestionCard from "@/components/questions/QuestionCard";
import MathContent from "@/components/ui/MathContent";
import QuestionEditModal, {
    type QuestionEditorDraft,
    type QuestionEditorMetadataDraft,
    type QuestionEditorOptionDraft,
    type AiMetadata,
} from "@/components/questions/QuestionEditModal";
import SearchableMultiSelect from "@/components/ui/SearchableMultiSelect";
import type { ModelOption } from "@/types/extraction";
import {
    API_KEY_PROVIDER_LABELS,
    CHAT_API_PROVIDERS,
    EMPTY_USER_API_KEYS,
    getProviderApiCredential,
    readDevApiKeysFromStorage,
    sanitizeUserApiKeys,
    type SupportedApiProvider,
    type UserApiKeys,
} from "@/lib/userApiKeys";

type PageTab = "history" | "create" | "results";
type CreateStep = 1 | 2;
type TestMode = "question_bank" | "ai";
type ExamType = "JEE_MAINS" | "JEE_ADVANCE" | "NEET" | "CUSTOMISED_TEST";
type FullSyllabus = "Yes" | "No";
type PaperType = "Paper 1" | "Paper 2";
type LabelFormat = "ABCD" | "1234";
type DeliveryMode = "PAPER_WISE" | "QUESTION_WISE";
type ContentMode =
    | "QUESTIONS_ONLY"
    | "QUESTIONS_WITH_ANSWER_KEY"
    | "QUESTIONS_ANSWER_KEY_SOLUTION";
type AITestProvider =
    | "gemini"
    | "openrouter"
    | "anthropic"
    | "openai"
    | "grok"
    | "groq"
    | "nvidia"
    | "fireworks"
    | "custom_openai"
    | "local"
    | "g4f";

interface CustomRow {
    id: string;
    questionType: string;
    numQuestions: number;
    easyPercent: number;
    hardPercent: number;
    subject: string;
    chapter: string;
    topic: string;
}

interface QuestionDistributionRow {
    id: string;
    type: string;
    count: number;
}

interface FinalPreviewQuestionItem {
    question: Question;
    subject: string;
    paper?: PaperType;
    typeLabel: string;
}

interface OutputSettings {
    labelFormat: LabelFormat;
    deliveryMode: DeliveryMode;
    contentMode: ContentMode;
    showAnswerKeyBeforeSolution: boolean;
    includeMetadata: boolean;
    metadataFields: string[];
    instructions: string;
    twoColumnFormat: boolean;
}

interface CreateTestFormState {
    examType: ExamType;
    questionSource: string[];
    sourcePercentages: Record<string, number>;
    easyPercent: number;
    hardPercent: number;
    mediumPercent: number;
    batchNames: string[];
    examDate: string;
    language: string;
    numberOfTests: number;
    fullSyllabus: FullSyllabus;
    subjects: string[];
    selectedChapters: string[];
    selectedTopics: Record<string, string[]>;
    advancePatternYear: string;
    paperType: PaperType[];
    questionDistribution: QuestionDistributionRow[];
    jeeAdvanceDistributionByPaper: Record<PaperType, QuestionDistributionRow[]>;
    customRows: CustomRow[];
    output: OutputSettings;
    /** When ON, the candidate pool is restricted to questions with a raw-OOXML
     *  payload (source_docx). Pair this with the "Word (native source)"
     *  download to get a byte-exact .docx output. */
    wordSourceOnly: boolean;
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

const BATCH_STORAGE_KEY = "qbg_saved_batches_v1";
const DEFAULT_BATCH_NAME = "Batch Test";
const DEFAULT_TEST_TRANSLATE_PROMPT = `You are a professional academic translator for JEE/NEET test papers.

Translate the provided generated test content into the target language. Preserve HTML tags, LaTeX, mathematical notation, question numbering intent, option order, answer correctness, answer keys, and solution structure. Do not solve, simplify, omit, or reorder any question.`;
const EXAM_TYPE_LABELS: Record<ExamType, string> = {
    JEE_MAINS: "JEE Mains",
    JEE_ADVANCE: "JEE Advance",
    NEET: "NEET",
    CUSTOMISED_TEST: "Customised Test",
};
const FIXED_SUBJECT_OPTIONS = ["Physics", "Chemistry", "Maths"];
const SUBJECT_DISPLAY_ORDER = ["Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"];
const PAPER_DISPLAY_ORDER: PaperType[] = ["Paper 1", "Paper 2"];
const DEFAULT_ADVANCE_PAPERS: PaperType[] = ["Paper 1", "Paper 2"];
const DEFAULT_JEE_MAINS_DISTRIBUTION = [
    { type: "Single_Choice(SCQ)", count: 20 },
    { type: "Integer", count: 5 },
];
const DEFAULT_NEET_DISTRIBUTION = [{ type: "Single_Choice(SCQ)", count: 45 }];
const METADATA_FIELDS = [
    "Subject",
    "Chapter",
    "Topic",
    "Subtopic",
    "Difficulty",
    "Source",
    "Question Type",
    "Exam",
    "Class Level",
    "Question ID",
    "QBG ID",
];
const AI_GENERATED_SOURCE = "AI Generated";
const AI_PROVIDER_LABELS: Record<AITestProvider, string> = {
    gemini: "Gemini",
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    openai: "OpenAI",
    grok: "Grok",
    groq: "Groq",
    nvidia: "NVIDIA",
    fireworks: "Fireworks AI",
    custom_openai: "OpenAI Compatible",
    local: "Local (Ollama)",
    g4f: "gpt4free (local g4f server)",
};
const AI_PROVIDER_ORDER: AITestProvider[] = [
    "gemini",
    "openrouter",
    "anthropic",
    "openai",
    "grok",
    "groq",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
];
const DEFAULT_AI_MODELS: Record<AITestProvider, ModelOption[]> = {
    gemini: [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
    openrouter: [
        { id: "openai/gpt-4o", label: "GPT-4o" },
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
    anthropic: [
        { id: "claude-3-7-sonnet-latest", label: "Claude Sonnet" },
    ],
    openai: [
        { id: "gpt-4o", label: "GPT-4o" },
        { id: "gpt-4.1", label: "GPT-4.1" },
    ],
    grok: [
        { id: "grok-3", label: "Grok 3" },
    ],
    groq: [
        { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    ],
    nvidia: [
        { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
        { id: "nvidia/llama-3.1-nemotron-70b-instruct", label: "Nemotron 70B" },
        { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1" },
    ],
    fireworks: [
        { id: "accounts/fireworks/models/deepseek-r1-0528", label: "DeepSeek R1 0528" },
        { id: "accounts/fireworks/models/deepseek-v3p2", label: "DeepSeek V3.2" },
        { id: "accounts/fireworks/models/glm-4p7", label: "GLM 4.7" },
        { id: "accounts/fireworks/models/minimax-m2p1", label: "MiniMax M2.1" },
        { id: "accounts/fireworks/models/qwen3-235b-a22b", label: "Qwen3 235B A22B" },
        { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B Instruct" },
    ],
    custom_openai: [
        { id: "gpt-4o-mini", label: "Custom model ID..." },
    ],
    local: [
        { id: "llama3.1:8b", label: "Llama 3.1 8B" },
        { id: "qwen2.5:7b", label: "Qwen 2.5 7B" },
        { id: "mistral:7b", label: "Mistral 7B" },
    ],
    g4f: [
        { id: "gpt-4o", label: "GPT-4o" },
        { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
    ],
};

function createDefaultOutputSettings(): OutputSettings {
    return {
        labelFormat: "ABCD",
        deliveryMode: "PAPER_WISE",
        contentMode: "QUESTIONS_ANSWER_KEY_SOLUTION",
        showAnswerKeyBeforeSolution: true,
        includeMetadata: false,
        metadataFields: [],
        instructions: "",
        twoColumnFormat: true,
    };
}

function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDistributionRows(
    rows: Array<{ type: string; count: number }>
): QuestionDistributionRow[] {
    return rows
        .filter((row) => row.type && row.count > 0)
        .map((row) => ({
            id: makeId(),
            type: row.type,
            count: Math.max(1, Math.floor(row.count)),
        }));
}

function normalizeDistributionRows(
    rows: QuestionDistributionRow[]
): QuestionDistributionRow[] {
    return rows
        .filter((row) => row.type && row.count > 0)
        .map((row) => ({
            ...row,
            count: Math.max(1, Math.floor(row.count)),
        }));
}

function rowsWithQuestionNumbers(rows: QuestionDistributionRow[]): Array<{
    id: string;
    type: string;
    count: number;
    questionNumbers: string;
}> {
    let start = 1;
    return normalizeDistributionRows(rows).map((row) => {
        const end = start + row.count - 1;
        const questionNumbers = `${start}-${end}`;
        const next = {
            ...row,
            questionNumbers,
        };
        start = end + 1;
        return next;
    });
}

function getDefaultAdvanceDistributionRows(
    year: string,
    paper: JeeAdvancedPaper
): QuestionDistributionRow[] {
    const yearRows = JEE_ADVANCED_PATTERN_MATRIX[year]?.[paper] || [];
    return createDistributionRows(
        yearRows.map((row) => ({
            type: row.type,
            count: row.count,
        }))
    );
}

/**
 * Rebalance percentages after the selection changes, keeping the ratios the user
 * already set. A newcomer takes an equal share and the existing ones are scaled
 * down to make room, so adding a 6th source no longer throws away a hand-tuned
 * split across the other five.
 */
function rebalanceSourcePercentages(
    nextSelected: string[],
    prev: Record<string, number>
): Record<string, number> {
    if (nextSelected.length === 0) return {};
    const kept = nextSelected.filter((s) => typeof prev[s] === "number");
    const added = nextSelected.filter((s) => typeof prev[s] !== "number");
    const keptTotal = kept.reduce((sum, s) => sum + (prev[s] || 0), 0);

    // Nothing meaningful to preserve — fall back to an even split.
    if (kept.length === 0 || keptTotal <= 0) return buildEqualSourcePercentages(nextSelected);

    if (added.length === 0) {
        // Only removals: scale what is left back up to 100, preserving ratios.
        const out: Record<string, number> = {};
        let running = 0;
        kept.forEach((sname, i) => {
            const share = i === kept.length - 1
                ? 100 - running
                : Math.round(((prev[sname] || 0) / keptTotal) * 100);
            out[sname] = Math.max(0, share);
            running += out[sname];
        });
        return out;
    }

    const perNew = Math.floor(100 / nextSelected.length);
    const forAdded = perNew * added.length;
    const forKept = Math.max(0, 100 - forAdded);
    const out: Record<string, number> = {};
    let running = 0;
    kept.forEach((sname) => {
        const share = Math.max(0, Math.round(((prev[sname] || 0) / keptTotal) * forKept));
        out[sname] = share;
        running += share;
    });
    added.forEach((sname, i) => {
        const share = i === added.length - 1 ? Math.max(0, 100 - running) : perNew;
        out[sname] = share;
        running += share;
    });
    return out;
}

function buildEqualSourcePercentages(sources: string[]): Record<string, number> {
    if (sources.length === 0) return {};

    const base = Math.floor((100 / sources.length) / 10) * 10;
    let remainder = 100 - base * sources.length;
    const next: Record<string, number> = {};

    sources.forEach((source) => {
        const bonus = remainder > 0 ? 10 : 0;
        if (bonus > 0) remainder -= 10;
        next[source] = base + bonus;
    });

    return next;
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

function subjectOrderValue(subject: string): number {
    const index = SUBJECT_DISPLAY_ORDER.findIndex(
        (name) => name.toLowerCase() === subject.toLowerCase()
    );
    return index === -1 ? SUBJECT_DISPLAY_ORDER.length : index;
}

function sortSectionsBySubject(
    sections: GeneratedTest["sections"]
): GeneratedTest["sections"] {
    return [...sections].sort((a, b) => {
        const av = subjectOrderValue(a.subject);
        const bv = subjectOrderValue(b.subject);
        if (av !== bv) return av - bv;
        return a.subject.localeCompare(b.subject);
    });
}

function getPaperGroups(test: GeneratedTest): Array<{
    paper: PaperType;
    sections: GeneratedTest["sections"];
}> {
    return PAPER_DISPLAY_ORDER.map((paper) => ({
        paper,
        sections: sortSectionsBySubject(
            test.sections.filter((section) => section.paper === paper)
        ),
    })).filter((group) => group.sections.length > 0);
}

function getQuestionSelectionKey(testNumber: number, questionId: string): string {
    return `${testNumber}::${questionId}`;
}

function formatQuestionUsageLabel(usages: FinalizedQuestionUsage[]): string {
    if (!usages.length) return "";
    const top = usages.slice(0, 2);
    const text = top
        .map(
            (usage) =>
                `${usage.batchName} • Test ${usage.testNumber} • ${new Date(
                    usage.createdAt
                ).toLocaleDateString()}`
        )
        .join(" | ");
    const remaining = usages.length - top.length;
    return remaining > 0 ? `${text} | +${remaining} more` : text;
}

function filterGeneratedTests(
    tests: GeneratedTest[],
    excludedQuestionKeys: Set<string>
): GeneratedTest[] {
    return tests
        .map((test) => {
            const sections = test.sections
                .map((section) => {
                    const questionTypes = section.questionTypes
                        .map((group) => ({
                            ...group,
                            questions: group.questions.filter(
                                (question) =>
                                    !excludedQuestionKeys.has(
                                        getQuestionSelectionKey(test.testNumber, question.question_id)
                                    )
                            ),
                        }))
                        .filter((group) => group.questions.length > 0);

                    return {
                        ...section,
                        questionTypes,
                        totalQuestions: questionTypes.reduce(
                            (sum, group) => sum + group.questions.length,
                            0
                        ),
                    };
                })
                .filter((section) => section.totalQuestions > 0);

            const stats = {
                byDifficulty: {} as Record<string, number>,
                bySource: {} as Record<string, number>,
                byChapter: {} as Record<string, number>,
            };

            sections.forEach((section) => {
                section.questionTypes.forEach((group) => {
                    group.questions.forEach((question) => {
                        const difficulty = question.difficutly_level || "Unknown";
                        const source = question.source || "Unknown";
                        const chapter = question.chapter || "Unknown";
                        stats.byDifficulty[difficulty] = (stats.byDifficulty[difficulty] || 0) + 1;
                        stats.bySource[source] = (stats.bySource[source] || 0) + 1;
                        stats.byChapter[chapter] = (stats.byChapter[chapter] || 0) + 1;
                    });
                });
            });

            return {
                ...test,
                sections,
                totalQuestions: sections.reduce((sum, section) => sum + section.totalQuestions, 0),
                stats,
            };
        })
        .filter((test) => test.totalQuestions > 0);
}

function countSelectedQuestionsForTest(
    test: GeneratedTest,
    excludedQuestionKeys: Set<string>
): number {
    let count = 0;
    test.sections.forEach((section) => {
        section.questionTypes.forEach((group) => {
            group.questions.forEach((question) => {
                if (
                    !excludedQuestionKeys.has(
                        getQuestionSelectionKey(test.testNumber, question.question_id)
                    )
                ) {
                    count += 1;
                }
            });
        });
    });
    return count;
}

function buildSavedTestIdsByTestNumber(
    savedTestIds: string[],
    tests: GeneratedTest[],
    batchCount: number
): Record<number, string[]> {
    const result: Record<number, string[]> = {};
    const testCount = tests.length;
    if (testCount === 0 || batchCount <= 0) return result;

    tests.forEach((test, testIndex) => {
        const ids: string[] = [];
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
            const savedId = savedTestIds[batchIndex * testCount + testIndex];
            if (savedId) ids.push(savedId);
        }
        result[test.testNumber] = ids;
    });

    return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function normalizeSavedOutputSettings(value: unknown): OutputSettings {
    const defaults = createDefaultOutputSettings();
    const saved = asRecord(value);
    if (!saved) return defaults;

    const labelFormat = saved.labelFormat === "1234" ? "1234" : defaults.labelFormat;
    const deliveryMode =
        saved.deliveryMode === "QUESTION_WISE" ? "QUESTION_WISE" : defaults.deliveryMode;
    const contentMode =
        saved.contentMode === "QUESTIONS_WITH_ANSWER_KEY" ||
        saved.contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" ||
        saved.contentMode === "QUESTIONS_ONLY"
            ? saved.contentMode
            : defaults.contentMode;
    const metadataFields = Array.isArray(saved.metadataFields)
        ? saved.metadataFields
              .map((field) => String(field))
              .filter((field) => METADATA_FIELDS.includes(field))
        : defaults.metadataFields;

    return {
        labelFormat,
        deliveryMode,
        contentMode,
        showAnswerKeyBeforeSolution:
            typeof saved.showAnswerKeyBeforeSolution === "boolean"
                ? saved.showAnswerKeyBeforeSolution
                : defaults.showAnswerKeyBeforeSolution,
        includeMetadata:
            typeof saved.includeMetadata === "boolean"
                ? saved.includeMetadata
                : metadataFields.length > 0,
        metadataFields,
        instructions:
            typeof saved.instructions === "string" ? saved.instructions : defaults.instructions,
        twoColumnFormat:
            typeof saved.twoColumnFormat === "boolean"
                ? saved.twoColumnFormat
                : defaults.twoColumnFormat,
    };
}

function examPresetToExamType(examPreset: string): ExamType {
    if (examPreset === "NEET") return "NEET";
    if (examPreset === "JEE_ADVANCE") return "JEE_ADVANCE";
    return "JEE_MAINS";
}

function buildGeneratedTestFromHistoryDetail(detail: TestHistoryDetail): GeneratedTest {
    const fallbackItems: TestHistoryQuestionItem[] = detail.questions.map((question, index) => ({
        question,
        questionOrder: index + 1,
        paper: undefined,
        subject: question.subject || "General",
        questionType: question.question_type || "Single_Choice(SCQ)",
        typeLabel: getQuestionTypeLabel(question.question_type || "Single_Choice(SCQ)"),
    }));
    const questionItems =
        detail.questionItems && detail.questionItems.length > 0
            ? [...detail.questionItems]
            : fallbackItems;
    questionItems.sort((a, b) => a.questionOrder - b.questionOrder);

    const sectionMap = new Map<string, GeneratedTest["sections"][number]>();
    const stats = {
        byDifficulty: {} as Record<string, number>,
        bySource: {} as Record<string, number>,
        byChapter: {} as Record<string, number>,
    };

    questionItems.forEach((item) => {
        const paperKey = item.paper || "";
        const subject = item.subject || item.question.subject || "General";
        const sectionKey = `${paperKey}::${subject}`;
        let section = sectionMap.get(sectionKey);
        if (!section) {
            section = {
                paper: item.paper,
                subject,
                questionTypes: [],
                totalQuestions: 0,
            };
            sectionMap.set(sectionKey, section);
        }

        const questionType = item.questionType || item.question.question_type || "Single_Choice(SCQ)";
        let group = section.questionTypes.find((entry) => entry.type === questionType);
        if (!group) {
            group = {
                type: questionType,
                typeLabel: item.typeLabel || getQuestionTypeLabel(questionType),
                questions: [],
            };
            section.questionTypes.push(group);
        }
        group.questions.push(item.question);
        section.totalQuestions += 1;

        const difficulty = item.question.difficutly_level || "Unknown";
        const source = item.question.source || "Unknown";
        const chapter = item.question.chapter || "Unknown";
        stats.byDifficulty[difficulty] = (stats.byDifficulty[difficulty] || 0) + 1;
        stats.bySource[source] = (stats.bySource[source] || 0) + 1;
        stats.byChapter[chapter] = (stats.byChapter[chapter] || 0) + 1;
    });

    return {
        testNumber: detail.testNumber,
        batchName: detail.batchName,
        testDate: detail.testDate,
        examPreset: detail.examPreset,
        sections: Array.from(sectionMap.values()),
        totalQuestions: questionItems.length,
        stats,
    };
}

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

function Section({
    title,
    subtitle,
    children,
}: {
    title?: string;
    subtitle?: string;
    children: React.ReactNode;
}) {
    const hasHeader = Boolean(title || subtitle);
    return (
        <section
            className="glass-card"
            style={{
                borderRadius: "12px",
                padding: "16px 18px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-primary)",
            }}
        >
            {hasHeader && (
                <div style={{ marginBottom: "10px" }}>
                    {title && <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 650 }}>{title}</h3>}
                    {subtitle && (
                        <p
                            style={{
                                margin: "4px 0 0",
                                fontSize: "0.76rem",
                                color: "var(--text-tertiary)",
                            }}
                        >
                            {subtitle}
                        </p>
                    )}
                </div>
            )}
            {children}
        </section>
    );
}

function ChipButton({
    active,
    children,
    onClick,
    minWidth,
}: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
    minWidth?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                minWidth,
                padding: "7px 12px",
                borderRadius: "9px",
                border: active
                    ? "1px solid rgba(var(--accent-success-rgb), 0.6)"
                    : "1px solid var(--border-primary)",
                background: active
                    ? "linear-gradient(135deg, rgba(var(--accent-success-rgb), 0.18), rgba(var(--accent-success-rgb), 0.08))"
                    : "var(--bg-tertiary)",
                color: active ? "var(--accent-success)" : "var(--text-secondary)",
                fontSize: "0.8rem",
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
            }}
        >
            {children}
        </button>
    );
}


const INSTRUCTION_TEMPLATES: Record<string, string> = {
    JEE_MAINS: `General Instructions:
1. Immediately fill in the particulars on this page of the test booklet.
2. The test is of 3 hours duration.
3. The test booklet consists of 90 questions. The maximum marks are 300.
4. There are three sections in the question paper, Section I, II & III consisting of Section-I (Physics), Section-II (Chemistry), Section-III (Mathematics) and having 30 questions in each section in which first 20 questions are compulsory and are of Objective Type and last 10 questions are integer type with answers ranging from '0' to '999' where answer needs to be rounded off to the nearest integer. Only 5 questions have to be attempted out of the last 10 questions of each section.
5. There is only one correct response among 4 alternate choices provided for each objective type question.
6. Each correct answer will give 4 marks while 1 Mark will be deducted for a wrong response.
7. No student is allowed to carry any textual material, printed or written, bits of papers, pager, mobile phone, any electronic device, etc. inside the examination room/hall.
8. On completion of the test, the candidate must hand over the Answer Sheet to the Invigilator on duty in the Room/Hall. However, the candidates are allowed to take away this Test Booklet with them.
9. Do not fold or make any stray mark on the Answer Sheet (OMR).

OMR Instructions:
1. Use blue/black dark ballpoint pens.
2. Darken the bubbles completely. Don't put a tick mark or a cross mark where it is specified that you fill the bubbles completely. Half-filled or over-filled bubbles will not be read by the software.
3. Never use pencils to mark your answers.
4. Never use whiteners to rectify filling errors as they may disrupt the scanning and evaluation process.
5. Writing on the OMR Sheet is permitted on the specified area only and even small marks other than the specified area may create problems during the evaluation.
6. Multiple markings will be treated as invalid responses.
7. Do not fold or make any stray mark on the Answer Sheet (OMR).`,
    NEET: `GENERAL INSTRUCTIONS TO THE CANDIDATES
(Please read the instructions carefully)

1. This Test Booklet contains 200 items (questions). Each item comprises four response alternatives (A), (B), (C) and (D). You are to select the correct alternative and darken the oval on the OMR Answer Sheet. If more than one alternative is darkened, the answer will be treated as incorrect.
2. The Test Booklet consists of 4 subjects — Physics (50 questions), Chemistry (50 questions), Botany (50 questions), and Zoology (50 questions).
3. Each subject has Two Sections:
   Section A — 35 Questions (Q.No. 1–35): All are compulsory.
   Section B — 15 Questions (Q.No. 36–50): Attempt any 10 out of 15. If more than 10 are attempted, only the first 10 will be evaluated.
4. Total Duration: 3 Hours 20 Minutes (200 Minutes).
5. Maximum Marks: 720.

MARKING SCHEME
  ✓ Correct Answer: +4 Marks
  ✗ Wrong Answer: −1 Mark
  ○ Unanswered/Unattempted: 0 Marks
  ✗ Multiple options marked: −1 Mark (treated as wrong)

IMPORTANT INSTRUCTIONS
• Use only Blue/Black ball point pen provided by the Centre for darkening the appropriate oval on the OMR Answer Sheet.
• Once an answer is marked on the OMR Sheet, it CANNOT be changed or erased. Use of white fluid/correction pen is STRICTLY PROHIBITED.
• Do not fold, wrinkle, or mutilate the OMR Answer Sheet.
• Handle the OMR Answer Sheet with care.
• Rough work must be done in the space provided in the Test Booklet only.
• No calculators, log tables, mobile phones, pagers, or electronic gadgets of any kind are allowed.`,

    JEE_ADVANCE: `GENERAL INSTRUCTIONS

1. This question paper contains THREE Parts: Part I (Physics), Part II (Chemistry) and Part III (Mathematics).
2. Each Part has FOUR sections. The number of questions, the type of questions and the marking scheme are indicated at the beginning of each section.
3. Duration of Paper: 3 Hours. Maximum Marks: 180.
4. Appearing in both Paper 1 and Paper 2 is COMPULSORY for JEE (Advanced) ranking.

SECTION-WISE MARKING SCHEME

Section 1 — Single Correct Option (SCQ):
  Each question has FOUR options. ONLY ONE of these four options is the correct answer.
  ✓ Full Marks: +3 if only the correct option is chosen.
  ✗ Negative Marks: −1 in all other cases.
  ○ Zero Marks: 0 if the question is unanswered.

Section 2 — One or More Than One Correct Option (MCQ):
  Each question has FOUR options. ONE OR MORE THAN ONE of these options is/are correct.
  ✓ Full Marks: +4 if all the correct option(s) is/are chosen and no incorrect option is chosen.
  ◐ Partial Marks: +3 if all four options are correct but only three options are chosen.
  ◐ Partial Marks: +2 if three or more options are correct but only two correct options are chosen.
  ◐ Partial Marks: +1 if two or more options are correct but only one correct option is chosen.
  ✗ Negative Marks: −2 in all other cases.
  ○ Zero Marks: 0 if the question is unanswered.

Section 3 — Numerical Answer Type (NAT):
  The answer is a numerical value (may be integer or decimal, rounded to two decimal places).
  ✓ Full Marks: +4 if the correct numerical value is entered.
  ○ Zero Marks: 0 in all other cases. There is NO negative marking.

Section 4 — Matching List Type (ML):
  Each question has two matching lists with combinations given as options.
  ✓ Full Marks: +3 for correct combination.
  ✗ Negative Marks: −1 for incorrect combination.
  ○ Zero Marks: 0 if unanswered.

IMPORTANT
• NO ELECTRONIC DEVICES (including calculators, mobile phones, smart watches, Bluetooth devices) are allowed inside the examination hall.
• This is a computer-based test (CBT). Read all on-screen instructions carefully before attempting.
• No clarification on the question paper shall be given by the Invigilator or anyone else during the test.`,

    CUSTOMISED_TEST: `GENERAL INSTRUCTIONS

1. Read all the questions carefully before attempting.
2. All questions are compulsory unless stated otherwise.
3. Write legibly using blue or black ball point pen only.
4. Rough work may be done in the space provided at the end of the booklet.
5. Use of electronic devices, calculators, log tables, mobile phones, or any unauthorized material is strictly prohibited.
6. Ensure all answers are clearly marked. Overwriting or use of correction fluid is NOT allowed.
7. Darken the bubble/oval completely for MCQ-type questions. Partially darkened or lightly marked answers may not be evaluated.
8. Any unfair means will result in immediate disqualification.
9. Hand over the Answer Sheet and Question Paper to the Invigilator before leaving the examination hall.
10. No candidate shall be permitted to leave the examination hall before the end of the test.`,
};


export function getQuestionTypeHeading(examType: string, typeLabel: string) {
    if (!typeLabel) return "";
    const lowerLabel = String(typeLabel).toLowerCase();
    const isNumerical = lowerLabel.includes("numerical") || lowerLabel.includes("integer") || lowerLabel.includes("single");
    
    if (examType === "JEE_MAINS" && isNumerical) {
        return "Integer Type Questions";
    }
    if (examType === "JEE_ADVANCE" && isNumerical) {
        return "Numerical Value Type Questions";
    }
    
    if (!lowerLabel.includes("type questions") && !lowerLabel.includes("questions") && typeLabel.trim() !== "") {
        return `${typeLabel} Type Questions`;
    }
    
    return typeLabel;
}

export default function TestBuilderPage() {
    const router = useRouter();
    const taskQueue = useQuestionTaskQueue();
    const examDateRef = useRef<HTMLInputElement>(null);
    const aiProviderRef = useRef<AITestProvider>("gemini");
    const aiModelsRequestRef = useRef(0);

    // Land on the Create form by default — most users come here to make a new
    // test. The previously-generated-tests panel sits at the bottom of the
    // Create form as a collapsible (collapsed by default) so it's still
    // one-click discoverable without dominating the screen.
    const [activeTab, setActiveTab] = useState<PageTab>("create");
    const [historyExpanded, setHistoryExpanded] = useState(false);
    const [createStep, setCreateStep] = useState<CreateStep>(1);
    // Free-text filter for the Question Source chip list (helps when there are

    const [metadata, setMetadata] = useState<MetadataHierarchy>(EMPTY_METADATA);
    const [loadingMetadata, setLoadingMetadata] = useState(true);
    const [metadataError, setMetadataError] = useState<string | null>(null);

    const [batchOptions, setBatchOptions] = useState<string[]>([]);
    const [newBatchName, setNewBatchName] = useState("");
    const [batchDropdownOpen, setBatchDropdownOpen] = useState(false);

    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [results, setResults] = useState<GeneratedTest[]>([]);
    const [excludedQuestionKeys, setExcludedQuestionKeys] = useState<string[]>([]);
    const [questionUsageById, setQuestionUsageById] = useState<
        Record<string, FinalizedQuestionUsage[]>
    >({});
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [historyTests, setHistoryTests] = useState<TestHistorySummary[]>([]);
    const [historyDetailsById, setHistoryDetailsById] = useState<
        Record<string, TestHistoryDetail>
    >({});
    const [expandedHistoryTestId, setExpandedHistoryTestId] = useState<string | null>(null);
    const [historyDetailLoadingId, setHistoryDetailLoadingId] = useState<string | null>(null);
    const [deletingHistoryTestId, setDeletingHistoryTestId] = useState<string | null>(null);
    const [finalizedSavedAt, setFinalizedSavedAt] = useState<string | null>(null);
    const [savedTestIdsByTestNumber, setSavedTestIdsByTestNumber] = useState<
        Record<number, string[]>
    >({});
    const [verificationReportsByTestNumber, setVerificationReportsByTestNumber] = useState<
        Record<number, TestAiVerificationReport>
    >({});
    // Anchor for the inline "AI Verification Report" section so the action-bar
    // button can scroll the user straight to it once a report is ready.
    const verifyReportRef = useRef<HTMLDivElement>(null);
    const [verifyReportFlash, setVerifyReportFlash] = useState(false);
    const hasVerificationReport = Object.keys(verificationReportsByTestNumber).length > 0;
    const scrollToVerifyReport = useCallback(() => {
        verifyReportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        setVerifyReportFlash(true);
        window.setTimeout(() => setVerifyReportFlash(false), 1600);
    }, []);
    const [expandedTestAnalysisKeys, setExpandedTestAnalysisKeys] = useState<string[]>([]);
    const [showFinalOutputPreview, setShowFinalOutputPreview] = useState(false);
    const [showFullScreenPreview, setShowFullScreenPreview] = useState(false);
    const [appliedInstructions, setAppliedInstructions] = useState("");
    const [testName, setTestName] = useState("");
    const [savingForPreview, setSavingForPreview] = useState(false);
    // Word native-source download — stitching can take several seconds; this
    // state shows a spinner + disables the button so users don't double-click.
    const [downloadingWordSource, setDownloadingWordSource] = useState(false);
    const [showAiVerifyDialog, setShowAiVerifyDialog] = useState(false);
    const [aiVerifyProvider, setAiVerifyProvider] = useState<AITestProvider>("gemini");
    const [aiVerifyModelId, setAiVerifyModelId] = useState(DEFAULT_AI_MODELS.gemini[0].id);
    const [aiVerifyModelOptionsByProvider, setAiVerifyModelOptionsByProvider] = useState<
        Record<AITestProvider, ModelOption[]>
    >({
        gemini: DEFAULT_AI_MODELS.gemini,
        anthropic: DEFAULT_AI_MODELS.anthropic,
        openai: DEFAULT_AI_MODELS.openai,
        groq: DEFAULT_AI_MODELS.groq,
        grok: DEFAULT_AI_MODELS.grok,
        openrouter: DEFAULT_AI_MODELS.openrouter,
        nvidia: DEFAULT_AI_MODELS.nvidia,
        fireworks: DEFAULT_AI_MODELS.fireworks,
        custom_openai: DEFAULT_AI_MODELS.custom_openai,
        local: DEFAULT_AI_MODELS.local,
        g4f: DEFAULT_AI_MODELS.g4f,
    });
    const [fetchingVerifyModelsProvider, setFetchingVerifyModelsProvider] = useState<SupportedApiProvider | null>(null);
    const [aiVerifyError, setAiVerifyError] = useState<string | null>(null);
    // Derived from the background queue — true while any test_verify task is in flight.
    const verifyingTestWithAi = useMemo(
        () => taskQueue.tasks.some((t) => t.kind === "test_verify" && t.status === "running"),
        [taskQueue.tasks]
    );
    const [showAiTranslateDialog, setShowAiTranslateDialog] = useState(false);
    const [aiTranslateProvider, setAiTranslateProvider] = useState<AITestProvider>("gemini");
    const [aiTranslateModelId, setAiTranslateModelId] = useState(DEFAULT_AI_MODELS.gemini[0].id);
    const [aiTranslateLanguage, setAiTranslateLanguage] = useState("Hindi");
    const [aiTranslatePrompt, setAiTranslatePrompt] = useState(DEFAULT_TEST_TRANSLATE_PROMPT);
    const [aiTranslateError, setAiTranslateError] = useState<string | null>(null);
    const translatingTestWithAi = useMemo(
        () => taskQueue.tasks.some((t) => t.kind === "test_translate" && t.status === "running"),
        [taskQueue.tasks]
    );
    const [translatedResults, setTranslatedResults] = useState<GeneratedTest[] | null>(null);
    const [translatedResultLanguage, setTranslatedResultLanguage] = useState("");
    const [translatedResultNotes, setTranslatedResultNotes] = useState("");
    const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
    const [savingQuestionEdit, setSavingQuestionEdit] = useState(false);
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    const [testMode, setTestMode] = useState<TestMode>("question_bank");
    const [aiProvider, setAiProvider] = useState<AITestProvider>("gemini");
    const [aiModelId, setAiModelId] = useState(DEFAULT_AI_MODELS.gemini[0].id);
    const [aiModelOptionsByProvider, setAiModelOptionsByProvider] = useState<
        Record<AITestProvider, ModelOption[]>
    >({ ...DEFAULT_AI_MODELS });
    const [loadingAiModels, setLoadingAiModels] = useState(false);
    const [aiModelsError, setAiModelsError] = useState<string | null>(null);
    const [usingLiveAiModels, setUsingLiveAiModels] = useState(false);
    const [availableLanguages, setAvailableLanguages] = useState<string[]>(["english"]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const langs = await fetchAvailableLanguages();
                if (cancelled) return;
                // Merge with the static list so users always see common languages,
                // even before any translations exist. "english" is implicit.
                const merged = new Set<string>(["english", ...langs]);
                SUPPORTED_TRANSLATION_LANGUAGES.forEach((l) => merged.add(l));
                setAvailableLanguages([...merged]);
            } catch {
                /* keep the default list */
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const [form, setForm] = useState<CreateTestFormState>({
        examType: "JEE_MAINS",
        questionSource: [],
        sourcePercentages: {},
        easyPercent: 30,
        hardPercent: 30,
        mediumPercent: 40,
        batchNames: [],
        examDate: "",
        language: "english",
        numberOfTests: 1,
        fullSyllabus: "Yes",
        subjects: ["Physics", "Chemistry", "Maths"],
        selectedChapters: [],
        selectedTopics: {},
        advancePatternYear: "2025",
        paperType: [...DEFAULT_ADVANCE_PAPERS],
        questionDistribution: createDistributionRows(DEFAULT_JEE_MAINS_DISTRIBUTION),
        jeeAdvanceDistributionByPaper: {
            "Paper 1": getDefaultAdvanceDistributionRows("2025", "Paper 1"),
            "Paper 2": getDefaultAdvanceDistributionRows("2025", "Paper 2"),
        },
        customRows: [
            {
                id: makeId(),
                questionType: "Single_Choice(SCQ)",
                numQuestions: 1,
                easyPercent: 30,
                hardPercent: 30,
                subject: "Physics",
                chapter: "",
                topic: "",
            },
        ],
        output: createDefaultOutputSettings(),
        wordSourceOnly: false,
    });

    useEffect(() => {
        async function loadMetadata() {
            try {
                const res = await fetch("/api/metadata");
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                setMetadata(normalizeMetadata(data));
                setMetadataError(null);
            } catch (err) {
                setMetadata(EMPTY_METADATA);
                setMetadataError(`Unable to load metadata: ${String(err)}`);
            } finally {
                setLoadingMetadata(false);
            }
        }

        loadMetadata();
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function loadBatches() {
            try {
                const res = await fetch("/api/batches");
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as {
                    success?: boolean;
                    batches?: Array<{ name?: string }>;
                };
                if (!data.success) throw new Error("Failed to load batches.");
                if (cancelled) return;
                const names = (data.batches || [])
                    .map((batch) => String(batch.name || "").trim())
                    .filter(Boolean);
                setBatchOptions(names);
            } catch {
                if (typeof window === "undefined" || cancelled) return;
                try {
                    const raw = window.localStorage.getItem(BATCH_STORAGE_KEY);
                    if (!raw) return;
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        const cleaned = parsed
                            .map((b) => (typeof b === "string" ? b.trim() : ""))
                            .filter(Boolean);
                        setBatchOptions(cleaned);
                    }
                } catch {
                    // ignore invalid persisted data
                }
            }
        }

        loadBatches();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batchOptions));
    }, [batchOptions]);

    useEffect(() => {
        aiProviderRef.current = aiProvider;
    }, [aiProvider]);

    useEffect(() => {
        let mounted = true;

        async function loadUserApiKeys() {
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
                    if (!mounted) return;
                    setUserApiKeys(sanitizeUserApiKeys(payload.apiKeys));
                    return;
                }
            } catch {
                // fall back for dev auth below
            }

            if (!mounted || typeof window === "undefined") return;
            if (document.cookie.includes("qbg_dev_auth=1")) {
                setUserApiKeys(readDevApiKeysFromStorage());
            }
        }

        loadUserApiKeys().catch(() => {
            // handled above
        });

        return () => {
            mounted = false;
        };
    }, []);

    const loadLiveAiModels = useCallback(
        async (provider: AITestProvider) => {
            const requestId = ++aiModelsRequestRef.current;
            const providerApiKey = (userApiKeys[provider] || "").trim();

            if (aiProviderRef.current === provider && aiModelsRequestRef.current === requestId) {
                setLoadingAiModels(true);
                setAiModelsError(null);
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

                setAiModelOptionsByProvider((prev) => ({
                    ...prev,
                    [provider]: payload.models || DEFAULT_AI_MODELS[provider],
                }));

                if (aiProviderRef.current === provider && aiModelsRequestRef.current === requestId) {
                    setAiModelId((prev) => {
                        const loadedModels = payload.models || DEFAULT_AI_MODELS[provider];
                        if (loadedModels.some((model) => model.id === prev)) return prev;
                        return loadedModels[0]?.id || prev;
                    });
                    setUsingLiveAiModels(true);
                    setAiModelsError(null);
                }
            } catch (err) {
                setAiModelOptionsByProvider((prev) => ({
                    ...prev,
                    [provider]: DEFAULT_AI_MODELS[provider],
                }));
                if (aiProviderRef.current === provider && aiModelsRequestRef.current === requestId) {
                    setUsingLiveAiModels(false);
                    setAiModelsError(
                        err instanceof Error
                            ? `${err.message} Showing fallback model list.`
                            : "Could not load live models. Showing fallback model list."
                    );
                }
            } finally {
                if (aiProviderRef.current === provider && aiModelsRequestRef.current === requestId) {
                    setLoadingAiModels(false);
                }
            }
        },
        [userApiKeys]
    );

    const refreshVerifyModels = useCallback(
        async (provider: AITestProvider) => {
            setFetchingVerifyModelsProvider(provider);
            setAiVerifyError(null);
            try {
                const headers: Record<string, string> = {};
                const providerApiKey = (userApiKeys[provider] || "").trim();
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

                setAiVerifyModelOptionsByProvider((prev) => ({
                    ...prev,
                    [provider]: payload.models || prev[provider],
                }));
                if (provider === aiVerifyProvider) {
                    setAiVerifyModelId((prev) =>
                        (payload.models || []).some((model) => model.id === prev)
                            ? prev
                            : payload.models?.[0]?.id || prev
                    );
                }
            } catch (err) {
                setAiVerifyModelOptionsByProvider((prev) => ({
                    ...prev,
                    [provider]: DEFAULT_AI_MODELS[provider],
                }));
                if (provider === aiVerifyProvider) {
                    setAiVerifyError(
                        err instanceof Error
                            ? `${err.message} Showing fallback model list.`
                            : "Could not load live models. Showing fallback model list."
                    );
                }
            } finally {
                setFetchingVerifyModelsProvider(null);
            }
        },
        [aiVerifyProvider, userApiKeys]
    );

    const subjectOptions = useMemo(() => {
        const extras = metadata.subjects.filter(
            (subject) =>
                !FIXED_SUBJECT_OPTIONS.some(
                    (core) => core.toLowerCase() === subject.trim().toLowerCase()
                )
        );
        const ordered = [...FIXED_SUBJECT_OPTIONS, ...extras];
        return Array.from(new Set(ordered));
    }, [metadata.subjects]);

    const sourceOptions = useMemo(() => {
        return metadata.sources;
    }, [metadata.sources]);
    /** Question counts per source, shown next to each option in the picker. */
    const sourceQuestionCounts = useMemo(
        () => metadata.sourceCounts ?? {},
        [metadata.sourceCounts]
    );
    const sourceOptionsWithAi = useMemo(() => sourceOptions, [sourceOptions]);
    const isAiGeneratedSelected = testMode === "ai";
    const visibleSourceOptions = useMemo(
        () => (isAiGeneratedSelected ? [AI_GENERATED_SOURCE] : sourceOptionsWithAi),
        [isAiGeneratedSelected, sourceOptionsWithAi]
    );
    const currentAiModelOptions = useMemo(
        () => aiModelOptionsByProvider[aiProvider] || DEFAULT_AI_MODELS[aiProvider],
        [aiModelOptionsByProvider, aiProvider]
    );
    const currentVerifyModelOptions = useMemo(
        () => aiVerifyModelOptionsByProvider[aiVerifyProvider] || DEFAULT_AI_MODELS[aiVerifyProvider],
        [aiVerifyModelOptionsByProvider, aiVerifyProvider]
    );
    const normalizedAiModelId = aiModelId.trim();
    const normalizedAiVerifyModelId = aiVerifyModelId.trim();
    const isCurrentAiModelListed = useMemo(
        () =>
            normalizedAiModelId.length > 0 &&
            currentAiModelOptions.some((model) => model.id === normalizedAiModelId),
        [currentAiModelOptions, normalizedAiModelId]
    );
    const isCurrentVerifyModelListed = useMemo(
        () =>
            normalizedAiVerifyModelId.length > 0 &&
            currentVerifyModelOptions.some((model) => model.id === normalizedAiVerifyModelId),
        [currentVerifyModelOptions, normalizedAiVerifyModelId]
    );
    const selectedAiProviderApiKey = (userApiKeys[aiProvider] || "").trim();
    const hasSelectedAiProviderKey = getProviderApiCredential(aiProvider, selectedAiProviderApiKey).length > 0;
    const selectedVerifyProviderApiKey = (userApiKeys[aiVerifyProvider] || "").trim();
    const hasSelectedVerifyProviderKey = getProviderApiCredential(aiVerifyProvider, selectedVerifyProviderApiKey).length > 0;
    const currentTranslateModelOptions = useMemo(
        () => aiVerifyModelOptionsByProvider[aiTranslateProvider] || DEFAULT_AI_MODELS[aiTranslateProvider],
        [aiVerifyModelOptionsByProvider, aiTranslateProvider]
    );
    const normalizedAiTranslateModelId = aiTranslateModelId.trim();
    const isCurrentTranslateModelListed = useMemo(
        () =>
            normalizedAiTranslateModelId.length > 0 &&
            currentTranslateModelOptions.some((model) => model.id === normalizedAiTranslateModelId),
        [currentTranslateModelOptions, normalizedAiTranslateModelId]
    );
    const selectedTranslateProviderApiKey = (userApiKeys[aiTranslateProvider] || "").trim();
    const hasSelectedTranslateProviderKey = getProviderApiCredential(aiTranslateProvider, selectedTranslateProviderApiKey).length > 0;

    const selectedResults = useMemo(
        () => filterGeneratedTests(results, new Set(excludedQuestionKeys)),
        [results, excludedQuestionKeys]
    );
    const excludedQuestionKeySet = useMemo(
        () => new Set(excludedQuestionKeys),
        [excludedQuestionKeys]
    );
    const totalGeneratedQuestions = useMemo(
        () => results.reduce((sum, test) => sum + test.totalQuestions, 0),
        [results]
    );
    const totalSelectedQuestions = useMemo(
        () => selectedResults.reduce((sum, test) => sum + test.totalQuestions, 0),
        [selectedResults]
    );

    useEffect(() => {
        if (sourceOptions.length === 0) return;
        setForm((prev) => {
            if (prev.questionSource.length > 0) return prev;
            const nextSelected = [...sourceOptions];
            return {
                ...prev,
                questionSource: nextSelected,
                sourcePercentages: buildEqualSourcePercentages(nextSelected),
            };
        });
    }, [sourceOptions]);

    useEffect(() => {
        if (testMode === "ai") {
            setForm((prev) => ({
                ...prev,
                questionSource: [AI_GENERATED_SOURCE],
                sourcePercentages: { [AI_GENERATED_SOURCE]: 100 },
            }));
        } else {
            setForm((prev) => {
                if (prev.questionSource.length === 1 && prev.questionSource[0] === AI_GENERATED_SOURCE) {
                    const fallbackSources = [...sourceOptions];
                    return {
                        ...prev,
                        questionSource: fallbackSources,
                        sourcePercentages: buildEqualSourcePercentages(fallbackSources),
                    };
                }
                return prev;
            });
        }
    }, [testMode, sourceOptions]);

    useEffect(() => {
        if (!isAiGeneratedSelected) return;
        loadLiveAiModels(aiProvider).catch(() => {
            // handled in loadLiveAiModels state
        });
    }, [isAiGeneratedSelected, aiProvider, loadLiveAiModels, selectedAiProviderApiKey]);

    useEffect(() => {
        setForm((prev) => {
            if (prev.examType !== "JEE_ADVANCE") return prev;
            const hasDefaultSelection =
                prev.paperType.length === DEFAULT_ADVANCE_PAPERS.length &&
                DEFAULT_ADVANCE_PAPERS.every((paper) => prev.paperType.includes(paper));
            if (hasDefaultSelection) return prev;
            return {
                ...prev,
                paperType: [...DEFAULT_ADVANCE_PAPERS],
            };
        });
    }, [form.examType]);

    useEffect(() => {
        setForm((prev) => {
            if (prev.examType === "JEE_MAINS") {
                return {
                    ...prev,
                    questionDistribution: createDistributionRows(DEFAULT_JEE_MAINS_DISTRIBUTION),
                };
            }
            if (prev.examType === "NEET") {
                return {
                    ...prev,
                    questionDistribution: createDistributionRows(DEFAULT_NEET_DISTRIBUTION),
                };
            }
            return prev;
        });
    }, [form.examType]);

    useEffect(() => {
        if (form.examType !== "JEE_ADVANCE") return;
        setForm((prev) => {
            if (prev.examType !== "JEE_ADVANCE") return prev;

            const nextMap: Record<PaperType, QuestionDistributionRow[]> = {
                ...prev.jeeAdvanceDistributionByPaper,
            };
            let changed = false;

            prev.paperType.forEach((paper) => {
                const defaults = getDefaultAdvanceDistributionRows(prev.advancePatternYear, paper);
                const current = prev.jeeAdvanceDistributionByPaper[paper] || [];
                const same =
                    current.length === defaults.length &&
                    current.every(
                        (row, idx) =>
                            row.type === defaults[idx]?.type && row.count === defaults[idx]?.count
                    );
                if (!same) {
                    nextMap[paper] = defaults;
                    changed = true;
                }
            });

            if (!changed) return prev;
            return {
                ...prev,
                jeeAdvanceDistributionByPaper: nextMap,
            };
        });
    }, [form.examType, form.advancePatternYear, form.paperType]);

    async function loadHistory(batchFilter?: string) {
        setHistoryLoading(true);
        setHistoryError(null);
        try {
            const query = new URLSearchParams();
            query.set("limit", "100");
            if (batchFilter) query.set("batch", batchFilter);
            const res = await fetch(`/api/tests/history?${query.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                success?: boolean;
                tests?: TestHistorySummary[];
                error?: string;
            };
            if (!data.success) throw new Error(data.error || "Failed to load test history.");
            setHistoryTests(data.tests || []);
        } catch (err) {
            setHistoryError(String(err));
        } finally {
            setHistoryLoading(false);
        }
    }

    async function fetchHistoryDetail(testId: string): Promise<TestHistoryDetail | null> {
        if (historyDetailsById[testId]) return historyDetailsById[testId];
        setHistoryError(null);
        setHistoryDetailLoadingId(testId);
        try {
            const res = await fetch(`/api/tests/history/${testId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                success?: boolean;
                test?: TestHistoryDetail;
                error?: string;
            };
            if (!data.success || !data.test) {
                throw new Error(data.error || "Failed to load test details.");
            }
            setHistoryDetailsById((prev) => ({ ...prev, [testId]: data.test! }));
            return data.test;
        } catch (err) {
            setHistoryError(String(err));
            return null;
        } finally {
            setHistoryDetailLoadingId(null);
        }
    }

    async function loadHistoryDetail(testId: string) {
        if (expandedHistoryTestId === testId) {
            setExpandedHistoryTestId(null);
            return;
        }
        setExpandedHistoryTestId(testId);
        await fetchHistoryDetail(testId);
    }

    async function openHistoryTestInBuilder(testId: string) {
        setError(null);
        const detail = await fetchHistoryDetail(testId);
        if (!detail) return;

        const generatedTest = buildGeneratedTestFromHistoryDetail(detail);
        const restoredOutput = normalizeSavedOutputSettings(detail.outputConfig);
        const restoredExamType = examPresetToExamType(detail.examPreset);
        const restoredSubjects = Array.from(
            new Set(
                generatedTest.sections
                    .map((section) => section.subject)
                    .filter((subject) => subject.trim().length > 0)
            )
        );
        const restoredPapers = Array.from(
            new Set(
                generatedTest.sections
                    .map((section) => section.paper)
                    .filter((paper): paper is PaperType => paper === "Paper 1" || paper === "Paper 2")
            )
        );

        setResults([generatedTest]);
        setExcludedQuestionKeys([]);
        setQuestionUsageById({});
        setFinalizedSavedAt(detail.createdAt || new Date().toISOString());
        setSavedTestIdsByTestNumber({ [generatedTest.testNumber]: [detail.id] });
        setVerificationReportsByTestNumber(
            detail.aiVerificationReport
                ? { [generatedTest.testNumber]: detail.aiVerificationReport }
                : {}
        );

        // Restore any previously-saved AI test translation so the user can
        // re-download without re-running the (expensive) translation.
        const savedTranslations =
            (detail.outputConfig as { aiTestTranslations?: Record<string, {
                language: string;
                notes?: string;
                translatedTest?: GeneratedTest;
            }> } | null | undefined)?.aiTestTranslations;
        if (savedTranslations) {
            // Use the test's language if non-English, otherwise pick the most
            // recently saved translation entry.
            const restoredLang =
                detail.language && detail.language !== "english"
                    ? detail.language.toLowerCase()
                    : Object.keys(savedTranslations)[0] || "";
            const entry = savedTranslations[restoredLang];
            if (entry?.translatedTest) {
                setTranslatedResults([entry.translatedTest]);
                setTranslatedResultLanguage(entry.language);
                setTranslatedResultNotes(entry.notes || "");
            } else {
                setTranslatedResults(null);
                setTranslatedResultLanguage("");
                setTranslatedResultNotes("");
            }
        } else {
            setTranslatedResults(null);
            setTranslatedResultLanguage("");
            setTranslatedResultNotes("");
        }

        setExpandedTestAnalysisKeys([]);
        setShowFinalOutputPreview(true);
        setShowFullScreenPreview(false);
        setAppliedInstructions(restoredOutput.instructions);
        setTestName(detail.testName || "");
        setForm((prev) => ({
            ...prev,
            examType: restoredExamType,
            batchNames: [detail.batchName],
            examDate: detail.testDate || "",
            language:
                ((detail as { language?: string }).language ||
                    (detail.generationConfig as { language?: string } | undefined)?.language ||
                    "english")
                    .toString()
                    .toLowerCase(),
            numberOfTests: 1,
            subjects: restoredSubjects.length > 0 ? restoredSubjects : prev.subjects,
            paperType: restoredPapers.length > 0 ? restoredPapers : prev.paperType,
            output: restoredOutput,
        }));
        setCreateStep(2);
        setActiveTab("create");
        setExpandedHistoryTestId(null);
    }

    async function deleteHistoryTest(historyTest: TestHistorySummary) {
        const historyTitle =
            historyTest.testName?.trim() ||
            `${historyTest.batchName} - Test ${historyTest.testNumber}`;
        const confirmed = window.confirm(
            `Delete "${historyTitle}" from previously generated tests? This will only remove the saved test history, not the original question bank questions.`
        );
        if (!confirmed) return;

        setHistoryError(null);
        setDeletingHistoryTestId(historyTest.id);
        try {
            const res = await fetch(`/api/tests/history/${historyTest.id}`, {
                method: "DELETE",
            });
            const data = (await res.json()) as { success?: boolean; error?: string };
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }

            setHistoryTests((prev) => prev.filter((test) => test.id !== historyTest.id));
            setHistoryDetailsById((prev) => {
                const next = { ...prev };
                delete next[historyTest.id];
                return next;
            });
            if (expandedHistoryTestId === historyTest.id) {
                setExpandedHistoryTestId(null);
            }
            setWarnings((prev) => [`Deleted saved test "${historyTitle}".`, ...prev]);
        } catch (err) {
            setHistoryError(String(err));
        } finally {
            setDeletingHistoryTestId(null);
        }
    }

    useEffect(() => {
        loadHistory().catch(() => {
            // handled in loadHistory state
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function toggleArrayValue<T extends string>(values: T[], value: T): T[] {
        return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
    }

    function clampNumber(value: number, min: number, max: number) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function updateDifficulty(easy: number, hard: number, changed: "easy" | "hard") {
        let nextEasy = clampNumber(easy, 0, 100);
        let nextHard = clampNumber(hard, 0, 100);

        if (changed === "easy") {
            nextHard = Math.min(nextHard, 100 - nextEasy);
        } else {
            nextEasy = Math.min(nextEasy, 100 - nextHard);
        }

        const medium = 100 - nextEasy - nextHard;
        setForm((prev) => ({
            ...prev,
            easyPercent: nextEasy,
            hardPercent: nextHard,
            mediumPercent: medium,
        }));
    }

    function openDatePicker() {
        const input = examDateRef.current as HTMLInputElement & { showPicker?: () => void };
        if (!input) return;
        if (typeof input.showPicker === "function") input.showPicker();
        else {
            input.focus();
            input.click();
        }
    }

    function toggleBatchSelection(batch: string) {
        setForm((prev) => ({ ...prev, batchNames: toggleArrayValue(prev.batchNames, batch) }));
    }

    function toggleQuestionSelection(testNumber: number, questionId: string) {
        const key = getQuestionSelectionKey(testNumber, questionId);
        setExcludedQuestionKeys((prev) =>
            prev.includes(key) ? prev.filter((value) => value !== key) : [...prev, key]
        );
        setFinalizedSavedAt(null);
        setSavedTestIdsByTestNumber({});
        setVerificationReportsByTestNumber({});
        setShowFinalOutputPreview(false);
    }

    function renderQuestionSelectionControl(testNumber: number, questionId: string) {
        return (
            <input
                type="checkbox"
                checked={!excludedQuestionKeySet.has(
                    getQuestionSelectionKey(testNumber, questionId)
                )}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleQuestionSelection(testNumber, questionId)}
                style={{
                    width: "18px",
                    height: "18px",
                    accentColor: "var(--accent-primary)",
                    cursor: "pointer",
                }}
            />
        );
    }

    function renderQuestionControls(testNumber: number, question: Question) {
        return (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                {renderQuestionSelectionControl(testNumber, question.question_id)}
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        setEditingQuestion(question);
                    }}
                    title="Edit question"
                    style={{
                        width: "22px",
                        height: "22px",
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
            </div>
        );
    }

    function renderHistoryQuestionEditControl(question: Question) {
        return (
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    setEditingQuestion(question);
                }}
                title="Edit question"
                style={{
                    width: "22px",
                    height: "22px",
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
        );
    }

    function formatHistoryDate(value?: string): string {
        if (!value) return "NA";
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return value;
        return parsed.toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function getQuestionEditorOptions(question: Question | null): QuestionEditorOptionDraft[] {
        if (!question) return [];
        return (question.options || [])
            .filter((option) => option?.text !== null)
            .map((option) => ({
                text: String(option?.text || ""),
                isCorrect: option?.isCorrect === true,
            }));
    }

    function replaceQuestionAcrossResults(updatedQuestion: Question) {
        setResults((prev) =>
            prev.map((test) => ({
                ...test,
                sections: test.sections.map((section) => ({
                    ...section,
                    questionTypes: section.questionTypes.map((group) => ({
                        ...group,
                        questions: group.questions.map((question) =>
                            question.question_id === updatedQuestion.question_id
                                ? updatedQuestion
                                : question
                        ),
                    })),
                })),
            }))
        );
    }

    function replaceQuestionsAcrossResults(updatedQuestions: Question[]) {
        updatedQuestions.forEach((question) => {
            replaceQuestionAcrossResults(question);
        });
    }

    async function finalizeSelectedTests(): Promise<Record<number, string[]>> {
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            throw new Error("Generate preview questions and keep at least one selected.");
        }

        if (finalizedSavedAt && Object.keys(savedTestIdsByTestNumber).length > 0) {
            return savedTestIdsByTestNumber;
        }

        const selectedBatchNames = form.batchNames.map((b) => b.trim()).filter(Boolean);
        const finalizedBatchNames = selectedBatchNames.length > 0 ? selectedBatchNames : [DEFAULT_BATCH_NAME];
        const payload = buildGenerationPayload(finalizedBatchNames[0]);
        const resolvedTestName =
            testName.trim() ||
            `${EXAM_TYPE_LABELS[form.examType]}_${finalizedBatchNames[0]}_${form.examDate || new Date().toISOString().slice(0, 10)}`;

        const response = await fetch("/api/tests/finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                batchNames: finalizedBatchNames,
                examPreset: payload.examPreset,
                testDate: payload.testDate,
                testName: resolvedTestName,
                language: payload.language || "english",
                outputConfig: form.output,
                generationConfig: payload,
                tests: selectedResults,
            }),
        });
        const result = (await response.json()) as {
            success?: boolean;
            savedTestIds?: string[];
            warnings?: string[];
            questionUsageById?: Record<string, FinalizedQuestionUsage[]>;
            error?: string;
        };
        if (!response.ok || !result.success) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        const mappedSavedIds = buildSavedTestIdsByTestNumber(
            result.savedTestIds || [],
            selectedResults,
            finalizedBatchNames.length
        );

        setFinalizedSavedAt(new Date().toISOString());
        setSavedTestIdsByTestNumber(mappedSavedIds);
        setQuestionUsageById(result.questionUsageById || {});
        if (result.warnings?.length) {
            setWarnings((prev) => [...result.warnings!, ...prev]);
        }
        await loadHistory(finalizedBatchNames[0]);
        return mappedSavedIds;
    }

    async function handleVerifyTestUsingAi() {
        setError(null);
        setAiVerifyError(null);

        const stepError = validateStepTwo();
        if (stepError) {
            setAiVerifyError(stepError);
            return;
        }
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            setAiVerifyError("Generate preview questions and keep at least one selected.");
            return;
        }
        if (!normalizedAiVerifyModelId) {
            setAiVerifyError("Select or enter an AI model to verify the test.");
            return;
        }
        if (!hasSelectedVerifyProviderKey) {
            setAiVerifyError(
                `Save a ${API_KEY_PROVIDER_LABELS[aiVerifyProvider]} API key from the user menu before running AI verification.`
            );
            return;
        }

        // Finalize is synchronous (cheap) — must complete before we can enqueue,
        // since the bg task needs test IDs to call /api/tests/verify with.
        let savedIdsMap: Record<number, string[]>;
        try {
            savedIdsMap = await finalizeSelectedTests();
        } catch (err) {
            setAiVerifyError(err instanceof Error ? err.message : String(err));
            return;
        }

        const payload = buildGenerationPayload(form.batchNames[0] || DEFAULT_BATCH_NAME);
        const isDevMode =
            typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1");
        const verifyModelLabel =
            currentVerifyModelOptions.find((model) => model.id === normalizedAiVerifyModelId)?.label ||
            normalizedAiVerifyModelId;
        const capturedTests = selectedResults;
        const capturedProvider = aiVerifyProvider;
        const capturedModelId = normalizedAiVerifyModelId;
        const capturedApiKey = selectedVerifyProviderApiKey;
        const batchName = form.batchNames[0] || DEFAULT_BATCH_NAME;
        const taskLabel = capturedTests.length === 1
            ? `${batchName} · Test ${capturedTests[0].testNumber}`
            : `${batchName} · ${capturedTests.length} tests`;

        setShowAiVerifyDialog(false);

        taskQueue.enqueue({
            kind: "test_verify",
            questionId: `test-batch:${batchName}`,
            label: taskLabel,
            detail: verifyModelLabel,
            run: async () => {
                const headers: Record<string, string> = { "Content-Type": "application/json" };
                if (isDevMode && capturedApiKey) {
                    headers["x-dev-api-key"] = capturedApiKey;
                }
                const reports: Record<number, TestAiVerificationReport> = {};
                const updates: { testFirstId: string; report: TestAiVerificationReport; updatedQuestions: Question[] }[] = [];
                for (const test of capturedTests) {
                    const testIds = savedIdsMap[test.testNumber] || [];
                    if (testIds.length === 0) {
                        throw new Error(`Saved test id not found for Test ${test.testNumber}.`);
                    }
                    const response = await fetch("/api/tests/verify", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            testIds,
                            test,
                            examPreset: payload.examPreset,
                            generationConfig: payload,
                            provider: capturedProvider,
                            modelId: capturedModelId,
                            modelLabel: verifyModelLabel,
                        }),
                    });
                    const result = (await response.json()) as {
                        success?: boolean;
                        report?: TestAiVerificationReport;
                        updatedQuestions?: Question[];
                        error?: string;
                    };
                    if (!response.ok || !result.success || !result.report) {
                        throw new Error(
                            result.error || `Failed to verify Test ${test.testNumber} (HTTP ${response.status})`
                        );
                    }
                    reports[test.testNumber] = result.report;
                    updates.push({
                        testFirstId: testIds[0],
                        report: result.report,
                        updatedQuestions: result.updatedQuestions || [],
                    });
                }
                return { reports, updates };
            },
            onComplete: async (raw) => {
                const r = raw as {
                    reports: Record<number, TestAiVerificationReport>;
                    updates: { testFirstId: string; report: TestAiVerificationReport; updatedQuestions: Question[] }[];
                };
                r.updates.forEach((u) => {
                    if (u.updatedQuestions.length) replaceQuestionsAcrossResults(u.updatedQuestions);
                });
                setHistoryDetailsById((prev) => {
                    const next = { ...prev };
                    r.updates.forEach((u) => {
                        const current = next[u.testFirstId];
                        if (!current) return;
                        next[u.testFirstId] = {
                            ...current,
                            aiVerificationReport: u.report,
                            questions: u.updatedQuestions.length ? u.updatedQuestions : current.questions,
                        };
                    });
                    return next;
                });
                setVerificationReportsByTestNumber((prev) => ({ ...prev, ...r.reports }));
                setWarnings((prev) => [
                    "AI verification completed. Review the report and flagged questions below.",
                    ...prev,
                ]);
            },
        });
    }

    function buildAiTranslateItems(tests: GeneratedTest[]) {
        const seen = new Set<string>();
        const items: Array<{
            id: string;
            questionText: string;
            options: Array<{ text: string | null; isCorrect: boolean | null }>;
            solutionText: string;
        }> = [];

        tests.forEach((test) => {
            test.sections.forEach((section) => {
                section.questionTypes.forEach((group) => {
                    group.questions.forEach((question) => {
                        const id = question.question_id;
                        if (!id || seen.has(id)) return;
                        seen.add(id);
                        items.push({
                            id,
                            questionText: question.question_text || "",
                            options: (question.options || []).map((option) => ({
                                text: option.text,
                                isCorrect: option.isCorrect,
                            })),
                            solutionText: question.solution_text || "",
                        });
                    });
                });
            });
        });

        return items;
    }

    function applyTranslationsToTests(
        tests: GeneratedTest[],
        translations: Array<{
            id?: string;
            translatedQuestionText?: string;
            translatedOptions?: Array<{ text?: string | null; isCorrect?: boolean | null }>;
            translatedSolutionText?: string;
        }>
    ): GeneratedTest[] {
        const translationById = new Map(translations.map((entry) => [String(entry.id || ""), entry]));

        return tests.map((test) => ({
            ...test,
            batchName: `${test.batchName} (${aiTranslateLanguage})`,
            sections: test.sections.map((section) => ({
                ...section,
                questionTypes: section.questionTypes.map((group) => ({
                    ...group,
                    questions: group.questions.map((question) => {
                        const translated = translationById.get(question.question_id);
                        if (!translated) return question;
                        return {
                            ...question,
                            question_text: String(translated.translatedQuestionText || question.question_text || ""),
                            options: Array.isArray(translated.translatedOptions)
                                ? translated.translatedOptions.map((option, index) => ({
                                      text:
                                          option.text === null || option.text === undefined
                                              ? question.options?.[index]?.text ?? null
                                              : String(option.text),
                                      isCorrect:
                                          typeof option.isCorrect === "boolean"
                                              ? option.isCorrect
                                              : question.options?.[index]?.isCorrect ?? false,
                                  }))
                                : question.options,
                            solution_text: String(translated.translatedSolutionText || question.solution_text || ""),
                        };
                    }),
                })),
            })),
        }));
    }

    async function handleTranslateTestUsingAi() {
        setAiTranslateError(null);
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            setAiTranslateError("Generate preview questions and keep at least one selected.");
            return;
        }
        if (!aiTranslateLanguage.trim()) {
            setAiTranslateError("Enter the language to translate to.");
            return;
        }
        if (!normalizedAiTranslateModelId) {
            setAiTranslateError("Select or enter an AI model to translate the test.");
            return;
        }
        if (!hasSelectedTranslateProviderKey && aiTranslateProvider !== "local") {
            setAiTranslateError(`Save ${API_KEY_PROVIDER_LABELS[aiTranslateProvider]} API key from the user menu before translating.`);
            return;
        }

        // Finalise before queuing so the result has a stable test ID to persist
        // against (and so the user can reopen the test from history later).
        let savedIdsMap: Record<number, string[]>;
        try {
            savedIdsMap = await finalizeSelectedTests();
        } catch (err) {
            setAiTranslateError(err instanceof Error ? err.message : String(err));
            return;
        }

        const isDevMode =
            typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1");
        const capturedTests = selectedResults;
        const capturedLanguage = aiTranslateLanguage;
        const capturedProvider = aiTranslateProvider;
        const capturedModelId = normalizedAiTranslateModelId;
        const capturedPrompt = aiTranslatePrompt;
        const capturedApiKey = selectedTranslateProviderApiKey;
        const translateModelLabel =
            currentTranslateModelOptions.find((m) => m.id === normalizedAiTranslateModelId)?.label ||
            normalizedAiTranslateModelId;
        const batchName = form.batchNames[0] || DEFAULT_BATCH_NAME;
        const taskLabel = capturedTests.length === 1
            ? `${batchName} · Test ${capturedTests[0].testNumber}`
            : `${batchName} · ${capturedTests.length} tests`;

        setShowAiTranslateDialog(false);

        taskQueue.enqueue({
            kind: "test_translate",
            questionId: `test-batch:${batchName}:${capturedLanguage}`,
            label: taskLabel,
            detail: `${capturedLanguage} · ${translateModelLabel}`,
            run: async () => {
                const headers: Record<string, string> = { "Content-Type": "application/json" };
                if (isDevMode && capturedApiKey) {
                    headers["x-dev-api-key"] = capturedApiKey;
                }
                const allItems = buildAiTranslateItems(capturedTests);
                const allTranslations: Array<{
                    id?: string;
                    translatedQuestionText?: string;
                    translatedOptions?: Array<{ text?: string | null; isCorrect?: boolean | null }>;
                    translatedSolutionText?: string;
                }> = [];
                const notes: string[] = [];
                const chunkSize = 15;
                for (let start = 0; start < allItems.length; start += chunkSize) {
                    const items = allItems.slice(start, start + chunkSize);
                    const response = await fetch("/api/ai-tools/translate-document", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            mode: "test",
                            provider: capturedProvider,
                            modelId: capturedModelId,
                            targetLanguage: capturedLanguage,
                            customPrompt: capturedPrompt,
                            items,
                        }),
                    });
                    const payload = (await response.json()) as {
                        success?: boolean;
                        result?: {
                            targetLanguage: string;
                            translations: Array<{
                                id?: string;
                                translatedQuestionText?: string;
                                translatedOptions?: Array<{ text?: string | null; isCorrect?: boolean | null }>;
                                translatedSolutionText?: string;
                            }>;
                            notes?: string;
                        };
                        error?: string;
                    };
                    if (!response.ok || !payload.success || !payload.result) {
                        throw new Error(payload.error || `Test translation failed for questions ${start + 1}-${start + items.length}.`);
                    }
                    allTranslations.push(...(payload.result.translations || []));
                    if (payload.result.notes) notes.push(payload.result.notes);
                }
                const translatedTests = applyTranslationsToTests(capturedTests, allTranslations);
                return {
                    translatedTests,
                    notes: notes.filter(Boolean).join(" "),
                };
            },
            onComplete: async (raw) => {
                const r = raw as { translatedTests: GeneratedTest[]; notes: string };
                setTranslatedResults(r.translatedTests);
                setTranslatedResultLanguage(capturedLanguage);
                setTranslatedResultNotes(r.notes);
                setWarnings((prev) => [
                    `AI translation completed in ${capturedLanguage}. Use the translated download buttons in the dialog.`,
                    ...prev,
                ]);

                // Persist each translated test to qbg_generated_tests.output_config
                // so the user can reopen and re-download even after closing the tab.
                try {
                    for (const translatedTest of r.translatedTests) {
                        const testIds = savedIdsMap[translatedTest.testNumber] || [];
                        if (testIds.length === 0) continue;
                        await fetch("/api/tests/save-translation", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                testIds,
                                language: capturedLanguage,
                                translatedTest,
                                notes: r.notes,
                            }),
                        });
                    }
                } catch (saveErr) {
                    console.warn("Persist translated test failed:", saveErr);
                }
            },
        });
    }

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
                    : [rawObj];

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const updatedQuestion: any = { ...editingQuestion, raw_data: newRawData };
                setEditingQuestion(updatedQuestion);
                replaceQuestionAcrossResults(updatedQuestion);

                if ((editingQuestion.source || "") !== AI_GENERATED_SOURCE) {
                    const response = await fetch(`/api/questions/${editingQuestion.question_id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ raw_data: newRawData }),
                    });
                    const payload = await response.json();
                    if (!response.ok || !payload.success) {
                        console.error("Failed to save AI metadata:", payload.error);
                    }
                }
            } catch (err) {
                console.error("Error updating AI metadata:", err);
            }
        },
        [editingQuestion] // replaceQuestionAcrossResults is not stable, so omit if it causes loop, but usually functions are omitted or useCallback'd
    );

    async function handleSaveEditedQuestion(draft: QuestionEditorDraft) {
        if (!editingQuestion) return;
        setSavingQuestionEdit(true);
        setError(null);
        const metadata = draft.metadata;
        const numericType = isNumericalQuestionType(
            metadata ? metadata.questionType : editingQuestion.question_type
        );

        const sanitizedOptions =
            draft.options.length > 0
                ? draft.options.map((option) => ({
                      text: option.text.trim() ? option.text : null,
                      isCorrect: option.text.trim() ? option.isCorrect : false,
                  }))
                : editingQuestion.options;
        const parsedNumericAnswer = Number((draft.answerKeyText || "").trim());
        const numericAnswerKey =
            numericType && (draft.answerKeyText || "").trim().length > 0 && Number.isFinite(parsedNumericAnswer)
                ? parsedNumericAnswer
                : editingQuestion.answer_key;
        const selectedAnswerIndexes =
            draft.options.length > 0
                ? draft.options
                      .map((option, index) => (option.isCorrect ? index + 1 : null))
                      .filter((index): index is number => index !== null)
                : [];

        const localUpdatedQuestion: Question = {
            ...editingQuestion,
            question_text: draft.questionText,
            solution_text: draft.solutionText,
            options: sanitizedOptions,
            subject: metadata ? metadata.subject : editingQuestion.subject,
            chapter: metadata ? metadata.chapter : editingQuestion.chapter,
            topic: metadata ? metadata.topic : editingQuestion.topic,
            subtopic: metadata ? metadata.subtopic || null : editingQuestion.subtopic,
            source: metadata ? metadata.source : editingQuestion.source,
            question_type: metadata ? metadata.questionType : editingQuestion.question_type,
            difficutly_level: metadata
                ? metadata.difficultyLevel
                : editingQuestion.difficutly_level,
            class_level: metadata ? metadata.classLevel || null : editingQuestion.class_level,
            exam: metadata ? metadata.exams : editingQuestion.exam,
            answer_key:
                numericType
                    ? numericAnswerKey
                    : selectedAnswerIndexes.length > 0
                    ? selectedAnswerIndexes
                    : editingQuestion.answer_key,
        };
        setFinalizedSavedAt(null);
        setSavedTestIdsByTestNumber({});
        setVerificationReportsByTestNumber({});
        replaceQuestionAcrossResults(localUpdatedQuestion);

        try {
            if ((editingQuestion.source || "") !== AI_GENERATED_SOURCE) {
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
                                : selectedAnswerIndexes.length > 0
                                ? selectedAnswerIndexes
                                : editingQuestion.answer_key,
                        subject: metadata ? metadata.subject : editingQuestion.subject,
                        chapter: metadata ? metadata.chapter : editingQuestion.chapter,
                        topic: metadata ? metadata.topic : editingQuestion.topic,
                        subtopic: metadata ? metadata.subtopic || null : editingQuestion.subtopic,
                        source: metadata ? metadata.source : editingQuestion.source,
                        question_type:
                            metadata ? metadata.questionType : editingQuestion.question_type,
                        difficutly_level: metadata
                            ? metadata.difficultyLevel
                            : editingQuestion.difficutly_level,
                        class_level: metadata
                            ? metadata.classLevel || null
                            : editingQuestion.class_level,
                        exam: metadata ? metadata.exams : editingQuestion.exam,
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
                replaceQuestionAcrossResults(payload.question);
            }

            setEditingQuestion(null);
        } catch (err) {
            setWarnings((prev) => [
                `Question ${editingQuestion.question_id.slice(0, 8)} edited locally, but DB update failed: ${String(
                    err
                )}`,
                ...prev,
            ]);
        } finally {
            setSavingQuestionEdit(false);
        }
    }

    async function addBatchOption() {
        const next = newBatchName.trim();
        if (!next) return;

        try {
            const res = await fetch("/api/batches", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: next }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                success?: boolean;
                batches?: Array<{ name?: string }>;
                error?: string;
            };
            if (!data.success) throw new Error(data.error || "Failed to save batch.");
            const names = (data.batches || [])
                .map((batch) => String(batch.name || "").trim())
                .filter(Boolean);
            setBatchOptions(names);
        } catch {
            setBatchOptions((prev) => {
                if (prev.includes(next)) return prev;
                return [...prev, next].sort((a, b) => a.localeCompare(b));
            });
        }

        setForm((prev) => ({
            ...prev,
            batchNames: prev.batchNames.includes(next)
                ? prev.batchNames
                : [...prev.batchNames, next],
        }));

        setNewBatchName("");
    }

    async function deleteBatchOption(batch: string) {
        try {
            const res = await fetch(`/api/batches?name=${encodeURIComponent(batch)}`, {
                method: "DELETE",
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                success?: boolean;
                batches?: Array<{ name?: string }>;
            };
            if (data.success) {
                const names = (data.batches || [])
                    .map((item) => String(item.name || "").trim())
                    .filter(Boolean);
                setBatchOptions(names);
            } else {
                setBatchOptions((prev) => prev.filter((b) => b !== batch));
            }
        } catch {
            setBatchOptions((prev) => prev.filter((b) => b !== batch));
        }
        setForm((prev) => ({
            ...prev,
            batchNames: prev.batchNames.filter((b) => b !== batch),
        }));
    }

    function toggleSource(source: string) {
        setForm((prev) => {
            const nextSelected = toggleArrayValue(prev.questionSource, source);
            return {
                ...prev,
                questionSource: nextSelected,
                sourcePercentages: rebalanceSourcePercentages(nextSelected, prev.sourcePercentages),
            };
        });
    }

    /** Replace the whole selection at once (the multi-select hands back a list). */
    function setSelectedSources(nextSelected: string[]) {
        setForm((prev) => ({
            ...prev,
            questionSource: nextSelected,
            sourcePercentages: rebalanceSourcePercentages(nextSelected, prev.sourcePercentages),
        }));
    }

    /** Reset every selected source to an even share. */
    function distributeSourcesEvenly() {
        setForm((prev) => ({
            ...prev,
            sourcePercentages: buildEqualSourcePercentages(prev.questionSource),
        }));
    }



    function setSourcePercent(source: string, value: number) {
        const normalized = clampNumber(value, 0, 100);
        setForm((prev) => ({
            ...prev,
            sourcePercentages: {
                ...prev.sourcePercentages,
                [source]: normalized,
            },
        }));
    }

    function toggleSubject(subject: string) {
        setForm((prev) => {
            const nextSubjects = toggleArrayValue(prev.subjects, subject);
            const allowedChapters = new Set(nextSubjects.flatMap((s) => metadata.chaptersBySubject[s] || []));
            const nextSelectedChapters = prev.selectedChapters.filter((ch) => allowedChapters.has(ch));
            const nextSelectedTopics = Object.fromEntries(
                Object.entries(prev.selectedTopics).filter(([chapter]) => allowedChapters.has(chapter))
            );
            return {
                ...prev,
                subjects: nextSubjects,
                selectedChapters: nextSelectedChapters,
                selectedTopics: nextSelectedTopics,
            };
        });
    }

    function toggleChapter(chapter: string) {
        setForm((prev) => {
            const isSelected = prev.selectedChapters.includes(chapter);
            const nextSelectedChapters = isSelected
                ? prev.selectedChapters.filter((ch) => ch !== chapter)
                : [...prev.selectedChapters, chapter];

            const nextSelectedTopics = { ...prev.selectedTopics };
            if (isSelected) delete nextSelectedTopics[chapter];
            else if (!nextSelectedTopics[chapter]) nextSelectedTopics[chapter] = [];

            return {
                ...prev,
                selectedChapters: nextSelectedChapters,
                selectedTopics: nextSelectedTopics,
            };
        });
    }

    function toggleTopic(chapter: string, topic: string) {
        setForm((prev) => {
            const current = prev.selectedTopics[chapter] || [];
            const next = current.includes(topic) ? current.filter((t) => t !== topic) : [...current, topic];
            return {
                ...prev,
                selectedTopics: {
                    ...prev.selectedTopics,
                    [chapter]: next,
                },
            };
        });
    }

    function updateDistributionCount(
        rowId: string,
        value: number,
        paper?: PaperType
    ) {
        const nextCount = Math.max(1, Math.floor(value || 1));
        setForm((prev) => {
            if (paper) {
                const rows = prev.jeeAdvanceDistributionByPaper[paper] || [];
                const nextRows = rows.map((row) =>
                    row.id === rowId ? { ...row, count: nextCount } : row
                );
                return {
                    ...prev,
                    jeeAdvanceDistributionByPaper: {
                        ...prev.jeeAdvanceDistributionByPaper,
                        [paper]: nextRows,
                    },
                };
            }

            return {
                ...prev,
                questionDistribution: prev.questionDistribution.map((row) =>
                    row.id === rowId ? { ...row, count: nextCount } : row
                ),
            };
        });
    }

    function updateDistributionType(
        rowId: string,
        newType: QuestionType,
        paper?: PaperType
    ) {
        setForm((prev) => {
            if (paper) {
                const rows = prev.jeeAdvanceDistributionByPaper[paper] || [];
                const nextRows = rows.map((row) =>
                    row.id === rowId ? { ...row, type: newType } : row
                );
                return {
                    ...prev,
                    jeeAdvanceDistributionByPaper: {
                        ...prev.jeeAdvanceDistributionByPaper,
                        [paper]: nextRows,
                    },
                };
            }

            return {
                ...prev,
                questionDistribution: prev.questionDistribution.map((row) =>
                    row.id === rowId ? { ...row, type: newType } : row
                ),
            };
        });
    }

    function moveDistributionRow(
        rowId: string,
        direction: "up" | "down",
        paper?: PaperType
    ) {
        setForm((prev) => {
            const move = (rows: QuestionDistributionRow[]): QuestionDistributionRow[] => {
                const index = rows.findIndex((row) => row.id === rowId);
                if (index === -1) return rows;
                const target = direction === "up" ? index - 1 : index + 1;
                if (target < 0 || target >= rows.length) return rows;
                const nextRows = [...rows];
                const [row] = nextRows.splice(index, 1);
                nextRows.splice(target, 0, row);
                return nextRows;
            };

            if (paper) {
                const rows = prev.jeeAdvanceDistributionByPaper[paper] || [];
                return {
                    ...prev,
                    jeeAdvanceDistributionByPaper: {
                        ...prev.jeeAdvanceDistributionByPaper,
                        [paper]: move(rows),
                    },
                };
            }

            return {
                ...prev,
                questionDistribution: move(prev.questionDistribution),
            };
        });
    }

    function setFullSyllabus(value: FullSyllabus) {
        setForm((prev) => {
            if (value === "Yes") {
                return { ...prev, fullSyllabus: value, selectedChapters: [], selectedTopics: {} };
            }
            return { ...prev, fullSyllabus: value };
        });
    }

    function addCustomRow() {
        setForm((prev) => {
            const subject = prev.subjects[0] || subjectOptions[0] || "Physics";
            const chapter = "";
            const questionType = metadata.questionTypes[0] || "Single_Choice(SCQ)";

            return {
                ...prev,
                customRows: [
                    ...prev.customRows,
                    {
                        id: makeId(),
                        questionType,
                        numQuestions: 1,
                        easyPercent: 30,
                        hardPercent: 30,
                        subject,
                        chapter,
                        topic: "",
                    },
                ],
            };
        });
    }

    function removeCustomRow(id: string) {
        setForm((prev) => {
            if (prev.customRows.length <= 1) return prev;
            return { ...prev, customRows: prev.customRows.filter((row) => row.id !== id) };
        });
    }

    function updateCustomRow(id: string, patch: Partial<CustomRow>) {
        setForm((prev) => {
            const nextRows = prev.customRows.map((row) => {
                if (row.id !== id) return row;

                const next = { ...row, ...patch };

                if (patch.subject !== undefined) {
                    const chapterOptions = metadata.chaptersBySubject[next.subject] || [];
                    if (!chapterOptions.includes(next.chapter)) next.chapter = chapterOptions[0] || "";
                    const topicOptions = metadata.topicsByChapter[next.chapter] || [];
                    if (!topicOptions.includes(next.topic)) next.topic = "";
                }

                if (patch.chapter !== undefined) {
                    const topicOptions = metadata.topicsByChapter[next.chapter] || [];
                    if (!topicOptions.includes(next.topic)) next.topic = "";
                }

                if (patch.easyPercent !== undefined || patch.hardPercent !== undefined) {
                    let e = next.easyPercent;
                    let h = next.hardPercent;

                    if (patch.easyPercent !== undefined) {
                        e = clampNumber(patch.easyPercent, 0, 100);
                        h = Math.min(h, 100 - e);
                    }

                    if (patch.hardPercent !== undefined) {
                        h = clampNumber(patch.hardPercent, 0, 100);
                        e = Math.min(e, 100 - h);
                    }

                    next.easyPercent = e;
                    next.hardPercent = h;
                }

                return next;
            });

            return { ...prev, customRows: nextRows };
        });
    }

    function buildSelectedChaptersBySubject(): Record<string, string[]> {
        const result: Record<string, string[]> = {};
        form.subjects.forEach((subject) => {
            const chapterSet = new Set(metadata.chaptersBySubject[subject] || []);
            result[subject] = form.selectedChapters.filter((chapter) => chapterSet.has(chapter));
        });
        return result;
    }

    function validateStepOne(): string | null {
        if (form.numberOfTests < 1 || form.numberOfTests > 10) {
            return "Number of tests must be between 1 and 10.";
        }
        if (!isAiGeneratedSelected && form.questionSource.length === 0) {
            return "Select at least one question source.";
        }
        if (isAiGeneratedSelected) {
            if (!normalizedAiModelId) {
                return "Select or enter an AI model.";
            }
            if (!hasSelectedAiProviderKey) {
                return `Save a ${AI_PROVIDER_LABELS[aiProvider]} API key from the user menu before using AI Generated source.`;
            }
        }
        if (form.examType !== "CUSTOMISED_TEST" && form.subjects.length === 0) {
            return "Select at least one subject.";
        }
        if (form.examType === "JEE_ADVANCE" && form.paperType.length === 0) {
            return "Select at least one paper type for JEE Advance.";
        }
        if (form.examType === "JEE_ADVANCE") {
            const missingPaperConfig = form.paperType.filter(
                (paper) =>
                    normalizeDistributionRows(form.jeeAdvanceDistributionByPaper[paper] || []).length ===
                    0
            );
            if (missingPaperConfig.length) {
                return `Add at least one question type row for ${missingPaperConfig.join(", ")}.`;
            }
        }
        if (
            (form.examType === "JEE_MAINS" || form.examType === "NEET") &&
            normalizeDistributionRows(form.questionDistribution).length === 0
        ) {
            return "Add at least one question type row in distribution.";
        }
        return null;
    }

    function validateStepTwo(): string | null {
        return null;
    }

    function buildGenerationPayload(batchName?: string): TestGenerationConfig {
        const normalizedBatchName = batchName?.trim() || DEFAULT_BATCH_NAME;
        const aiEnabled = isAiGeneratedSelected;
        const examPreset =
            form.examType === "NEET"
                ? "NEET"
                : form.examType === "JEE_ADVANCE"
                    ? "JEE_ADVANCE"
                    : "JEE_MAINS";
        const questionTypeDistribution =
            form.examType === "JEE_MAINS" || form.examType === "NEET"
                ? rowsWithQuestionNumbers(form.questionDistribution).map((row) => ({
                      type: row.type,
                      count: row.count,
                      questionNumbers: row.questionNumbers,
                  }))
                : undefined;
        const questionTypeDistributionByPaper =
            form.examType === "JEE_ADVANCE"
                ? Object.fromEntries(
                      form.paperType.map((paper) => [
                          paper,
                          rowsWithQuestionNumbers(
                              form.jeeAdvanceDistributionByPaper[paper] || []
                          ).map((row) => ({
                              type: row.type,
                              count: row.count,
                              questionNumbers: row.questionNumbers,
                          })),
                      ])
                  )
                : undefined;

        return {
            examPreset,
            jeeAdvancedYear:
                form.examType === "JEE_ADVANCE" ? form.advancePatternYear : undefined,
            jeeAdvancedPapers:
                form.examType === "JEE_ADVANCE" ? form.paperType : undefined,
            questionTypeDistribution,
            questionTypeDistributionByPaper,
            batchName: normalizedBatchName,
            testDate: form.examDate || undefined,
            numberOfTests: form.numberOfTests,
            fullSyllabus: form.fullSyllabus === "Yes",
            selectedSubjects: form.subjects,
            selectedChapters: form.fullSyllabus === "Yes" ? {} : buildSelectedChaptersBySubject(),
            selectedTopicsByChapter: form.fullSyllabus === "Yes" ? {} : form.selectedTopics,
            sourcePreferences: aiEnabled
                ? [{ source: AI_GENERATED_SOURCE, percent: 100 }]
                : form.questionSource.map((source) => ({
                      source,
                      percent: form.sourcePercentages[source] ?? 0,
                  })),
            difficultyDistribution: {
                easyPercent: form.easyPercent,
                hardPercent: form.hardPercent,
            },
            avoidBatchRepeats: true,
            allowBatchRepeatFallback: true,
            aiGeneration: aiEnabled
                ? {
                      enabled: true,
                      provider: aiProvider,
                      modelId: normalizedAiModelId,
                  }
                : undefined,
            customRows:
                form.examType === "CUSTOMISED_TEST"
                    ? form.customRows.map((row) => ({
                          questionType: row.questionType,
                          numQuestions: row.numQuestions,
                          easyPercent: row.easyPercent,
                          hardPercent: row.hardPercent,
                          subject: row.subject,
                          chapter: row.chapter || undefined,
                          topic: row.topic || undefined,
                      }))
                    : undefined,
            language: (form.language || "english").trim().toLowerCase(),
            wordSourceOnly: form.wordSourceOnly === true,
        };
    }

    async function handleGeneratePreview() {
        setError(null);
        setWarnings([]);
        setShowFinalOutputPreview(false);
        setTranslatedResults(null);
        setTranslatedResultLanguage("");
        setTranslatedResultNotes("");

        const validationError = validateStepOne();
        if (validationError) {
            setError(validationError);
            return;
        }

        setGenerating(true);
        try {
            const selectedBatchNames = form.batchNames
                .map((batch) => batch.trim())
                .filter(Boolean);
            const previewBatch = selectedBatchNames[0] || DEFAULT_BATCH_NAME;
            const payload = buildGenerationPayload(previewBatch);
            const isDevMode =
                typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1");
            const endpoint = isAiGeneratedSelected
                ? "/api/tests/generate-ai"
                : "/api/tests/generate";
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (isAiGeneratedSelected && isDevMode && selectedAiProviderApiKey) {
                headers["x-dev-api-key"] = selectedAiProviderApiKey;
            }

            const res = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
            });
            const data = (await res.json()) as TestGenerationResponse;

            if (!res.ok || !data.success) {
                throw new Error(data.error || `Generation failed (HTTP ${res.status})`);
            }

            const nextWarnings = [...(data.warnings || [])];
            nextWarnings.unshift(
                "Questions generated. Review selection, then click Show Preview."
            );

            setResults(data.tests || []);
            setQuestionUsageById(data.questionUsageById || {});
            setFinalizedSavedAt(null);
            setSavedTestIdsByTestNumber({});
            setVerificationReportsByTestNumber({});
            setExcludedQuestionKeys([]);
            setWarnings(nextWarnings);
            setActiveTab("results");
        } catch (err) {
            setError(String(err));
        } finally {
            setGenerating(false);
        }
    }

    function handleFinaliseAndOpenOptions() {
        setError(null);
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            setError("Select at least one preview question before opening preview.");
            return;
        }
        const defaultOutput = createDefaultOutputSettings();
        const templateForExam = INSTRUCTION_TEMPLATES[form.examType] || INSTRUCTION_TEMPLATES.CUSTOMISED_TEST || "";
        defaultOutput.instructions = templateForExam;
        setForm((prev) => ({
            ...prev,
            output: defaultOutput,
        }));
        setAppliedInstructions(templateForExam);
        setShowFinalOutputPreview(true);
        setCreateStep(2);
        setActiveTab("create");
    }

    function handleGenerateFinalTest() {
        setError(null);
        const stepError = validateStepTwo();
        if (stepError) {
            setError(stepError);
            return;
        }
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            setError(
                "Generate preview questions from Step 1 and keep at least one question selected before finalising."
            );
            return;
        }

        const selectedBatchNames = form.batchNames
            .map((batch) => batch.trim())
            .filter(Boolean);
        setBatchOptions((prev) => {
            const merged = new Set(prev);
            selectedBatchNames.forEach((b) => merged.add(b));
            return Array.from(merged).sort((a, b) => a.localeCompare(b));
        });

        const persistAndWarn = async () => {
            try {
                await finalizeSelectedTests();
            } catch (err) {
                setError(String(err));
                return;
            }

            setWarnings((prev) => [
                "Final test generated and saved successfully.",
                ...prev,
            ]);
            setShowFinalOutputPreview(true);
        };

        persistAndWarn().catch((err) => {
            setError(String(err));
        });
    }

    async function handleSaveAndPreview() {
        setError(null);
        const stepError = validateStepTwo();
        if (stepError) {
            setError(stepError);
            return;
        }
        if (selectedResults.length === 0 || totalSelectedQuestions === 0) {
            setError("Generate preview questions and keep at least one selected.");
            return;
        }

        setSavingForPreview(true);
        try {
            const savedIdsMap = await finalizeSelectedTests();
            const testId = savedIdsMap[selectedResults[0]?.testNumber || 0]?.[0];
            if (testId) {
                setShowFullScreenPreview(true);
            } else {
                setError("Test saved but no test ID returned.");
            }
        } catch (err) {
            setError(String(err));
        } finally {
            setSavingForPreview(false);
        }
    }

    function getOptionLabel(index: number, format: LabelFormat): string {
        if (format === "1234") return String(index + 1);
        return String.fromCharCode(65 + index);
    }

    function formatAnswerKeyForPreview(question: Question): string {
        const values = resolveAnswerKey(question);
        if (values.length === 0) return "—";
        const hasTextOptions =
            Array.isArray(question.options) &&
            question.options.some((option) => Boolean(option?.text));

        if (!hasTextOptions) {
            return values.map((value) => String(value)).join(", ");
        }

        return values
            .map((value) => {
                const numeric = Number(value);
                if (!Number.isFinite(numeric) || numeric < 1) return String(value);
                return getOptionLabel(numeric - 1, form.output.labelFormat);
            })
            .join(", ");
    }

    function getMetadataRowsForPreview(
        question: Question,
        sectionSubject: string
    ): Array<{ label: string; value: string }> {
        if (!form.output.includeMetadata) return [];

        const values: Record<string, string> = {
            Subject: question.subject || sectionSubject || "-",
            Chapter: question.chapter || "-",
            Topic: question.topic || "-",
            Subtopic: question.subtopic || "-",
            Difficulty: question.difficutly_level || "-",
            Source: question.source || "-",
            "Question Type": getQuestionTypeLabel(question.question_type || ""),
            Exam: Array.isArray(question.exam) && question.exam.length > 0 ? question.exam.join(", ") : "-",
            "Class Level": question.class_level || "-",
            "Question ID": question.question_id || "-",
            "QBG ID": question.qbg_id || "-",
        };

        return form.output.metadataFields
            .map((field) => ({ label: field, value: values[field] || "-" }))
            .filter((row) => row.value.trim().length > 0);
    }

    function collectPreviewQuestionItems(test: GeneratedTest): FinalPreviewQuestionItem[] {
        const items: FinalPreviewQuestionItem[] = [];
        const paperGroups = getPaperGroups(test);

        if (paperGroups.length > 0) {
            paperGroups.forEach((paperGroup) => {
                paperGroup.sections.forEach((section) => {
                    section.questionTypes.forEach((questionType) => {
                        questionType.questions.forEach((question) => {
                            items.push({
                                question,
                                subject: section.subject,
                                paper: paperGroup.paper,
                                typeLabel: questionType.typeLabel,
                            });
                        });
                    });
                });
            });
            return items;
        }

        sortSectionsBySubject(test.sections).forEach((section) => {
            section.questionTypes.forEach((questionType) => {
                questionType.questions.forEach((question) => {
                    items.push({
                        question,
                        subject: section.subject,
                        typeLabel: questionType.typeLabel,
                    });
                });
            });
        });

        return items;
    }

    function buildQuestionWiseGroups(test: GeneratedTest): Array<{
        paper: PaperType | null;
        subjects: Array<{
            subject: string;
            entries: Array<{ item: FinalPreviewQuestionItem; qNo: number }>;
        }>;
    }> {
        const paperGroups = getPaperGroups(test);

        if (paperGroups.length > 0) {
            return paperGroups.map((paperGroup) => {
                let qNo = 0;
                const subjects = paperGroup.sections
                    .map((section) => {
                        const entries: Array<{ item: FinalPreviewQuestionItem; qNo: number }> = [];
                        section.questionTypes.forEach((questionType) => {
                            questionType.questions.forEach((question) => {
                                entries.push({
                                    item: {
                                        question,
                                        subject: section.subject,
                                        paper: paperGroup.paper,
                                        typeLabel: questionType.typeLabel,
                                    },
                                    qNo: ++qNo,
                                });
                            });
                        });
                        return {
                            subject: section.subject,
                            entries,
                        };
                    })
                    .filter((subjectGroup) => subjectGroup.entries.length > 0);

                return {
                    paper: paperGroup.paper,
                    subjects,
                };
            });
        }

        let qNo = 0;
        const subjects = sortSectionsBySubject(test.sections)
            .map((section) => {
                const entries: Array<{ item: FinalPreviewQuestionItem; qNo: number }> = [];
                section.questionTypes.forEach((questionType) => {
                    questionType.questions.forEach((question) => {
                        entries.push({
                            item: {
                                question,
                                subject: section.subject,
                                typeLabel: questionType.typeLabel,
                            },
                            qNo: ++qNo,
                        });
                    });
                });
                return {
                    subject: section.subject,
                    entries,
                };
            })
            .filter((subjectGroup) => subjectGroup.entries.length > 0);

        return [{ paper: null, subjects }];
    }

    function renderQuestionWiseOutputBlock(test: GeneratedTest, keyPrefix: string) {
        const groups = buildQuestionWiseGroups(test);

        return (
            <div style={{ display: "grid", gap: "14px" }}>
                {groups.map((group, groupIndex) => (
                    <div key={`${keyPrefix}-paper-group-${group.paper || "single"}-${groupIndex}`} style={{ display: "grid", gap: "10px" }}>
                        {group.paper && (
                            <div
                                className="no-column-break"
                                style={{
                                    fontSize: "0.9rem",
                                    fontWeight: 800,
                                    color: "var(--text-primary)",
                                    textAlign: "center",
                                    padding: "6px 8px",
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-tertiary)",
                                }}
                            >
                                {group.paper}
                            </div>
                        )}

                        {group.subjects.map((subjectGroup, subjectIndex) => (
                            <div
                                key={`${keyPrefix}-subject-group-${group.paper || "single"}-${subjectGroup.subject}-${subjectIndex}`}
                                style={{ display: "grid", gap: "8px" }}
                            >
                                <div
                                    className="no-column-break"
                                    style={{
                                        fontSize: "0.82rem",
                                        fontWeight: 800,
                                        color: "var(--text-primary)",
                                        textAlign: "center",
                                        padding: "6px 8px",
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-tertiary)",
                                    }}
                                >
                                    {subjectGroup.subject}
                                </div>
                                <div
                                    className={form.output.twoColumnFormat ? "two-column-flow" : ""}
                                    style={{
                                        display: form.output.twoColumnFormat ? "block" : "grid",
                                        gap: "8px",
                                    }}
                                >
                                    {subjectGroup.entries.map((entry, entryIndex) => {
                                        const heading = getQuestionTypeHeading(form.examType, entry.item.typeLabel || "");
                                        const prevHeading = entryIndex > 0 ? getQuestionTypeHeading(form.examType, subjectGroup.entries[entryIndex - 1].item.typeLabel || "") : null;
                                        return (
                                            <React.Fragment key={`${keyPrefix}-question-${group.paper || "single"}-${subjectGroup.subject}-${entry.item.question.question_id}-${entryIndex}-wrapper`}>
                                                {heading !== prevHeading && heading && (
                                                    <div
                                                        className="no-column-break"
                                                        style={{
                                                            columnSpan: "all",
                                                            WebkitColumnSpan: "all",
                                                            fontSize: "0.85rem",
                                                            fontWeight: 700,
                                                            color: "var(--accent-primary)",
                                                            padding: "4px 8px",
                                                            margin: entryIndex === 0 ? "0 0 6px 0" : "10px 0 6px 0",
                                                            borderBottom: "1px solid var(--border-primary)",
                                                            width: "100%",
                                                        }}
                                                    >
                                                        {heading}
                                                    </div>
                                                )}
                                                {renderFinalPreviewQuestion(
                                                    entry.item,
                                                    entry.qNo,
                                                    `${keyPrefix}-question-${group.paper || "single"}-${subjectGroup.subject}-${entry.item.question.question_id}-${entryIndex}`
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        );
    }

    function renderFinalPreviewQuestionStatement(
        item: FinalPreviewQuestionItem,
        questionNumber: number,
        key: string
    ) {
        const { question, subject } = item;
        const options = (question.options || []).filter((option) => Boolean(option?.text));
        const isNumericalType = isNumericalQuestionType(question.question_type);
        const metadataRows = getMetadataRowsForPreview(question, subject);
        const canUseTwoColumnOptions =
            options.length >= 2 &&
            options.length <= 4 &&
            options.every((option) => {
                const html = String(option.text || "");
                if (/<img|<table/i.test(html)) return false;
                const plain = html
                    .replace(/<[^>]*>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&amp;/g, "&")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .trim();
                return plain.length <= 120;
            });
        const numericAnswerPreview = normalizeAnswerKey(question.answer_key).join(", ");
        const useBalancedOptionColumns = form.output.twoColumnFormat && options.length >= 3;
        const splitIndex = options.length <= 3 ? 1 : Math.ceil(options.length / 2);
        const leftOptions = options.slice(0, splitIndex);
        const rightOptions = options.slice(splitIndex);

        return (
            <div
                className="column-item"
                key={key}
                style={{
                    border: "1px solid var(--border-secondary)",
                    borderRadius: "10px",
                    background: "var(--bg-tertiary)",
                    padding: "12px",
                    display: "grid",
                    gap: "10px",
                    overflowX: "visible",
                }}
            >
                <div
                    style={{
                        display: "grid",
                        gap: "6px",
                        alignItems: "start",
                    }}
                >
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <span
                            style={{
                                display: "inline-flex",
                                width: "fit-content",
                                padding: "2px 10px",
                                borderRadius: "6px",
                                border: "1px solid var(--border-primary)",
                                color: "var(--text-primary)",
                                fontWeight: 700,
                                fontSize: "0.78rem",
                                alignSelf: "start",
                            }}
                        >
                            {questionNumber}.
                        </span>
                    </div>
                    <MathContent
                        html={question.question_text || ""}
                        className="question-html"
                        style={{
                            color: "var(--text-primary)",
                            fontSize: "0.95rem",
                            lineHeight: 1.55,
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            overflowX: "auto",
                        }}
                    />
                </div>

                {!isNumericalType && options.length > 0 && (
                    <div
                        style={{
                            display: "grid",
                            gap: "6px",
                            gridTemplateColumns: useBalancedOptionColumns
                                ? "repeat(2, minmax(0, 1fr))"
                                : canUseTwoColumnOptions
                                    ? "repeat(2, minmax(0, 1fr))"
                                    : "1fr",
                        }}
                    >
                        {(useBalancedOptionColumns
                            ? [
                                  leftOptions.map((option, localIndex) => ({
                                      option,
                                      index: localIndex,
                                  })),
                                  rightOptions.map((option, localIndex) => ({
                                      option,
                                      index: splitIndex + localIndex,
                                  })),
                              ]
                            : [
                                  options.map((option, index) => ({
                                      option,
                                      index,
                                  })),
                              ]).map((optionColumn, columnIndex) => (
                            <div
                                key={`${question.question_id}-option-column-${columnIndex}`}
                                style={{ display: "grid", gap: "6px", minWidth: 0 }}
                            >
                                {optionColumn.map(({ option, index }) => (
                                    <div
                                        key={`${question.question_id}-option-${index}`}
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns: "34px 1fr",
                                            gap: "8px",
                                            alignItems: "start",
                                            padding: "8px 10px",
                                            borderRadius: "8px",
                                            background: "var(--bg-secondary)",
                                            border: "1px solid var(--border-primary)",
                                            minWidth: 0,
                                        }}
                                    >
                                        <span
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                fontSize: "0.74rem",
                                                fontWeight: 700,
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            {getOptionLabel(index, form.output.labelFormat)}.
                                        </span>
                                        <MathContent
                                            html={option.text || ""}
                                            className="question-html"
                                            style={{
                                                color: "var(--text-secondary)",
                                                fontSize: "0.86rem",
                                                overflowWrap: "anywhere",
                                                wordBreak: "break-word",
                                                overflowX: "auto",
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}


                {metadataRows.length > 0 && (
                    <div
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "8px",
                            padding: "8px",
                            background: "var(--bg-secondary)",
                            display: "grid",
                            gap: "5px",
                        }}
                    >
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px" }}>
                            {metadataRows.map((row) => (
                                <div key={`${question.question_id}-${row.label}`} style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                                    <span style={{ color: "var(--text-tertiary)" }}>{row.label}: </span>
                                    <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>{row.value}</strong>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

            </div>
        );
    }

    function renderFinalPreviewQuestion(
        item: FinalPreviewQuestionItem,
        questionNumber: number,
        key: string
    ) {
        const answerKeyText = formatAnswerKeyForPreview(item.question);
        const shouldShowSolution = Boolean((item.question.solution_text || "").trim());
        const placeAnswerBeforeSolution =
            form.output.deliveryMode === "QUESTION_WISE" ||
            (form.output.deliveryMode === "PAPER_WISE" &&
                form.output.showAnswerKeyBeforeSolution);

        return (
            <div className="column-item" style={{ display: "grid", gap: "8px" }} key={key}>
                {renderFinalPreviewQuestionStatement(item, questionNumber, `${key}-statement`)}

                {form.output.contentMode === "QUESTIONS_WITH_ANSWER_KEY" && (
                    <div
                        style={{
                            border: "1px solid rgba(var(--accent-success-rgb), 0.3)",
                            borderRadius: "8px",
                            padding: "8px 10px",
                            background: "rgba(var(--accent-success-rgb), 0.08)",
                            color: "var(--accent-success)",
                            fontSize: "0.82rem",
                        }}
                    >
                        <strong>Answer Key:</strong> {answerKeyText}
                    </div>
                )}

                {form.output.contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" && (
                    <div style={{ display: "grid", gap: "8px" }}>
                        {placeAnswerBeforeSolution && (
                            <div
                                style={{
                                    border: "1px solid rgba(var(--accent-success-rgb), 0.3)",
                                    borderRadius: "8px",
                                    padding: "8px 10px",
                                    background: "rgba(var(--accent-success-rgb), 0.08)",
                                    color: "var(--accent-success)",
                                    fontSize: "0.82rem",
                                }}
                            >
                                <strong>Answer Key:</strong> {answerKeyText}
                            </div>
                        )}

                        {shouldShowSolution && (
                            <div
                                style={{
                                    border: "1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.25)",
                                    borderRadius: "8px",
                                    padding: "8px 10px",
                                    background: "rgba(var(--accent-primary-rgb, 99, 102, 241), 0.08)",
                                    display: "grid",
                                    gap: "6px",
                                }}
                            >
                                <div style={{ fontSize: "0.72rem", color: "var(--accent-primary)", fontWeight: 700 }}>
                                    Solution
                                </div>
                                <MathContent
                                    html={item.question.solution_text || ""}
                                    className="question-html"
                                    style={{ color: "var(--text-secondary)", fontSize: "0.86rem" }}
                                />
                            </div>
                        )}

                        {!placeAnswerBeforeSolution && (
                            <div
                                style={{
                                    border: "1px solid rgba(var(--accent-success-rgb), 0.3)",
                                    borderRadius: "8px",
                                    padding: "8px 10px",
                                    background: "rgba(var(--accent-success-rgb), 0.08)",
                                    color: "var(--accent-success)",
                                    fontSize: "0.82rem",
                                }}
                            >
                                <strong>Answer Key:</strong> {answerKeyText}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    function renderPaperWiseOutputBlock(
        title: string | null,
        items: FinalPreviewQuestionItem[],
        keyPrefix: string
    ) {
        if (items.length === 0) return null;

        const groupedBySubjectMap = new Map<string, FinalPreviewQuestionItem[]>();
        items.forEach((item) => {
            const subject = item.subject || "Unknown";
            const existing = groupedBySubjectMap.get(subject);
            if (existing) {
                existing.push(item);
            } else {
                groupedBySubjectMap.set(subject, [item]);
            }
        });

        const groupedBySubject = Array.from(groupedBySubjectMap.entries())
            .sort((a, b) => {
                const av = subjectOrderValue(a[0]);
                const bv = subjectOrderValue(b[0]);
                if (av !== bv) return av - bv;
                return a[0].localeCompare(b[0]);
            })
            .map(([subject, subjectItems]) => ({
                subject,
                items: subjectItems,
            }));

        let runningQuestionNo = 0;
        const groupedQuestionEntries = groupedBySubject.map((group) => ({
            subject: group.subject,
            entries: group.items.map((item) => ({
                item,
                qNo: ++runningQuestionNo,
            })),
        }));
        const orderedQuestionEntries = groupedQuestionEntries.flatMap((group) => group.entries);

        return (
            <div
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "9px",
                    padding: "10px",
                    background: "var(--bg-secondary)",
                    display: "grid",
                    gap: "10px",
                    overflowX: "visible",
                }}
                key={`${keyPrefix}-block`}
            >
                {title && (
                    <div
                        style={{
                            fontSize: "0.9rem",
                            fontWeight: 800,
                            color: "var(--text-primary)",
                            textAlign: "center",
                        }}
                    >
                        {title}
                    </div>
                )}

                <div style={{ display: "grid", gap: "10px" }}>
                    {groupedQuestionEntries.map((group) => (
                        <div key={`${keyPrefix}-question-group-${group.subject}`} style={{ display: "grid", gap: "8px" }}>
                            {groupedQuestionEntries.length > 1 && (
                                <div
                                    className="no-column-break"
                                    style={{
                                        fontSize: "0.82rem",
                                        fontWeight: 800,
                                        color: "var(--text-primary)",
                                        padding: "6px 8px",
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-tertiary)",
                                    }}
                                >
                                    {group.subject}
                                </div>
                            )}
                            <div
                                className={form.output.twoColumnFormat ? "two-column-flow" : ""}
                                style={{ display: form.output.twoColumnFormat ? "block" : "grid", gap: "8px" }}
                            >
                                {group.entries.map((entry, index) =>
                                    renderFinalPreviewQuestionStatement(
                                        entry.item,
                                        entry.qNo,
                                        `${keyPrefix}-question-${group.subject}-${entry.item.question.question_id}-${index}`
                                    )
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                {form.output.contentMode !== "QUESTIONS_ONLY" && (
                    <div
                        className="page-break-before-print no-column-break"
                        style={{
                            border: "1px solid var(--border-secondary)",
                            borderRadius: "8px",
                            background: "var(--bg-tertiary)",
                            padding: "10px",
                            display: "grid",
                            gap: "8px",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.86rem",
                                fontWeight: 800,
                                color: "var(--text-primary)",
                                textAlign: "center",
                            }}
                        >
                            Answer Key
                        </div>
                        {(() => {
                            const entriesBySubject: Record<
                                string,
                                Array<{ qNo: number; answer: string }>
                            > = {};
                            orderedQuestionEntries.forEach((entry) => {
                                const subject = entry.item.subject || "Unknown";
                                if (!entriesBySubject[subject]) entriesBySubject[subject] = [];
                                entriesBySubject[subject].push({
                                    qNo: entry.qNo,
                                    answer: formatAnswerKeyForPreview(entry.item.question),
                                });
                            });

                            const orderedSubjects = Object.keys(entriesBySubject).sort(
                                (a, b) => {
                                    const av = subjectOrderValue(a);
                                    const bv = subjectOrderValue(b);
                                    if (av !== bv) return av - bv;
                                    return a.localeCompare(b);
                                }
                            );
                            const singleSubject = orderedSubjects.length === 1;

                            const subjectColumns =
                                orderedSubjects.length === 1
                                    ? (() => {
                                          const subject = orderedSubjects[0];
                                          const allEntries = entriesBySubject[subject] || [];
                                          const mid = Math.ceil(allEntries.length / 2);
                                          return [
                                              {
                                                  label: subject,
                                                  entries: allEntries.slice(0, mid),
                                              },
                                              {
                                                  label: subject,
                                                  entries: allEntries.slice(mid),
                                              },
                                          ];
                                      })()
                                    : orderedSubjects.map((subject) => ({
                                          label: subject,
                                          entries: entriesBySubject[subject] || [],
                                      }));

                            return (
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: `repeat(${Math.max(
                                            1,
                                            subjectColumns.length
                                        )}, minmax(0, 1fr))`,
                                        gap: "10px",
                                    }}
                                >
                                    {subjectColumns.map((column, columnIndex) => (
                                        <div
                                            key={`${keyPrefix}-answer-col-${column.label}-${columnIndex}`}
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                padding: "8px",
                                                background: "var(--bg-tertiary)",
                                                display: "grid",
                                                gap: "6px",
                                            }}
                                        >
                                            {!singleSubject && (
                                                <div
                                                    style={{
                                                        fontSize: "0.8rem",
                                                        color: "var(--text-primary)",
                                                        fontWeight: 700,
                                                        textAlign: "center",
                                                    }}
                                                >
                                                    {column.label}
                                                </div>
                                            )}
                                            <div style={{ display: "grid", gap: "4px" }}>
                                                {column.entries.length > 0 ? (
                                                    column.entries.map((entry) => (
                                                        <div
                                                            key={`${keyPrefix}-answer-${column.label}-${entry.qNo}`}
                                                            style={{
                                                                fontSize: "0.8rem",
                                                                color: "var(--text-secondary)",
                                                                borderBottom:
                                                                    "1px dashed var(--border-primary)",
                                                                paddingBottom: "4px",
                                                            }}
                                                        >
                                                            <strong style={{ color: "var(--text-primary)" }}>{entry.qNo}.</strong>
                                                            : {entry.answer}
                                                        </div>
                                                    ))
                                                ) : (
                                                    <span
                                                        style={{
                                                            fontSize: "0.78rem",
                                                            color: "var(--text-tertiary)",
                                                        }}
                                                    >
                                                        No entries
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                )}

                {form.output.contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" && (
                    <div
                        style={{
                            border: "1px solid var(--border-secondary)",
                            borderRadius: "8px",
                            background: "var(--bg-tertiary)",
                            padding: "10px",
                            display: "grid",
                            gap: "8px",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "0.86rem",
                                fontWeight: 800,
                                color: "var(--text-primary)",
                                textAlign: "center",
                            }}
                        >
                            Solutions
                        </div>
                        <div style={{ display: "grid", gap: "10px" }}>
                            {groupedQuestionEntries.map((group) => (
                                <div key={`${keyPrefix}-solution-group-${group.subject}`} style={{ display: "grid", gap: "8px" }}>
                                    {groupedQuestionEntries.length > 1 && (
                                        <div
                                            className="no-column-break"
                                            style={{
                                                fontSize: "0.82rem",
                                                fontWeight: 800,
                                                color: "var(--text-primary)",
                                                padding: "6px 8px",
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                            }}
                                        >
                                            {group.subject}
                                        </div>
                                    )}
                                    <div
                                        className={form.output.twoColumnFormat ? "two-column-flow" : ""}
                                        style={{ display: form.output.twoColumnFormat ? "block" : "grid", gap: "8px" }}
                                    >
                                        {group.entries.map((entry, index) => (
                                            <div
                                                className="column-item"
                                                key={`${keyPrefix}-solution-${group.subject}-${entry.item.question.question_id}-${index}`}
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: "8px",
                                                    padding: "8px 10px",
                                                    background: "var(--bg-tertiary)",
                                                    display: "grid",
                                                    gap: "6px",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        fontSize: "0.8rem",
                                                        color: "var(--text-primary)",
                                                        fontWeight: 700,
                                                    }}
                                                >
                                                    {entry.qNo}.
                                                </div>
                                                {form.output.showAnswerKeyBeforeSolution && (
                                                    <div
                                                        style={{
                                                            border: "1px solid rgba(var(--accent-success-rgb), 0.3)",
                                                            borderRadius: "8px",
                                                            padding: "6px 8px",
                                                            background: "rgba(var(--accent-success-rgb), 0.08)",
                                                            color: "var(--accent-success)",
                                                            fontSize: "0.79rem",
                                                        }}
                                                    >
                                                        <strong>Answer Key:</strong>{" "}
                                                        {formatAnswerKeyForPreview(entry.item.question)}
                                                    </div>
                                                )}
                                                <MathContent
                                                    html={(entry.item.question.solution_text || "").trim() || "<p>No solution available.</p>"}
                                                    className="question-html"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                        fontSize: "0.84rem",
                                                        overflowWrap: "anywhere",
                                                        wordBreak: "break-word",
                                                    }}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    function toggleMetadataField(field: string) {
        setForm((prev) => {
            const nextFields = toggleArrayValue(prev.output.metadataFields, field);
            return {
                ...prev,
                output: {
                    ...prev.output,
                    metadataFields: nextFields,
                    includeMetadata: nextFields.length > 0,
                },
            };
        });
    }

    function buildDownloadOptions(filenameBase: string) {
        return {
            tests: selectedResults,
            contentMode: form.output.contentMode,
            labelFormat: form.output.labelFormat,
            deliveryMode: form.output.deliveryMode,
            showAnswerKeyBeforeSolution: form.output.showAnswerKeyBeforeSolution,
            twoColumnFormat: form.output.twoColumnFormat,
            instructions: appliedInstructions,
            includeMetadata: form.output.includeMetadata,
            metadataFields: form.output.metadataFields,
            examType: form.examType,
            filename: filenameBase,
        };
    }

    async function handleDownloadPDF() {
        if (selectedResults.length === 0) return;
        const batchName = selectedResults[0]?.batchName || "Test";
        await downloadTestAsPDF(buildDownloadOptions(batchName));
    }

    async function handleDownloadDocx() {
        if (selectedResults.length === 0) return;
        const batchName = selectedResults[0]?.batchName || "Test";
        await downloadTestAsDocx(buildDownloadOptions(batchName));
    }

    /**
     * Word-native download — works only for questions that were ingested via
     * the .docx upload pipeline (i.e. carry a source_docx blob). The new server
     * route stitches their raw OOXML chunks + media into a fresh .docx, so
     * equations and diagrams come through byte-exact.
     */
    async function handleDownloadWordSource() {
        if (selectedResults.length === 0) return;
        // Guard against double-clicks while the server is stitching.
        if (downloadingWordSource) return;

        const batchName = selectedResults[0]?.batchName || "Test";
        // Collect every question_id from every selected test, in display order.
        const ids: string[] = [];
        for (const test of selectedResults) {
            for (const section of test.sections) {
                for (const group of section.questionTypes) {
                    for (const q of group.questions) {
                        if (q.question_id) ids.push(q.question_id);
                    }
                }
            }
        }
        if (ids.length === 0) {
            alert("No questions selected to download.");
            return;
        }

        setDownloadingWordSource(true);
        try {
            const res = await fetch("/api/tests/generate-word", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question_ids: ids,
                    title: batchName,
                    subtitle: form.examDate ? `Date: ${form.examDate}` : undefined,
                }),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                throw new Error(errBody.error || `Status ${res.status}`);
            }
            const blob = await res.blob();
            const includedCount = res.headers.get("X-Included-Count");
            const skippedCount = res.headers.get("X-Skipped-Count");

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${batchName}-word.docx`.replace(/[^a-zA-Z0-9._-]+/g, "_");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (skippedCount && Number(skippedCount) > 0) {
                alert(`Downloaded ${includedCount} questions. ${skippedCount} skipped because they don't have a Word-source payload.`);
            }
        } catch (err) {
            alert(`Word-source download failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setDownloadingWordSource(false);
        }
    }

    async function handleDownloadTranslatedPDF() {
        if (!translatedResults?.length) return;
        const batchName = translatedResults[0]?.batchName || "Translated Test";
        await downloadTestAsPDF({
            ...buildDownloadOptions(`${batchName}-${translatedResultLanguage || aiTranslateLanguage}`),
            tests: translatedResults,
        });
    }

    async function handleDownloadTranslatedDocx() {
        if (!translatedResults?.length) return;
        const batchName = translatedResults[0]?.batchName || "Translated Test";
        await downloadTestAsDocx({
            ...buildDownloadOptions(`${batchName}-${translatedResultLanguage || aiTranslateLanguage}`),
            tests: translatedResults,
        });
    }

    function clearAllMetadataFields() {
        setForm((prev) => ({
            ...prev,
            output: {
                ...prev.output,
                includeMetadata: false,
                metadataFields: [],
            },
        }));
    }

    function toggleTestAnalysisKey(key: string) {
        setExpandedTestAnalysisKeys((prev) =>
            prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
        );
    }

    function normalizeClassBucket(classLevel: string | null | undefined): string {
        const classRaw = String(classLevel || "").toLowerCase();
        if (classRaw.includes("11")) return "11";
        if (classRaw.includes("12")) return "12";
        return "Other";
    }

    function buildPerTestAnalysis(test: GeneratedTest) {
        const difficultyCounts: Record<string, number> = {};
        const sourceCounts: Record<string, number> = {};
        const classCounts: Record<string, number> = {};
        const chapterCountsBySubject: Record<string, Record<string, number>> = {};
        let total = 0;

        test.sections.forEach((section) => {
            section.questionTypes.forEach((group) => {
                group.questions.forEach((question) => {
                    const key = getQuestionSelectionKey(test.testNumber, question.question_id);
                    if (excludedQuestionKeySet.has(key)) return;

                    total += 1;
                    const difficulty = question.difficutly_level || "Unknown";
                    const source = question.source || "Unknown";
                    const classBucket = normalizeClassBucket(question.class_level);
                    const chapter = question.chapter || "Unknown";
                    const subject = section.subject || question.subject || "Unknown";

                    difficultyCounts[difficulty] = (difficultyCounts[difficulty] || 0) + 1;
                    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
                    classCounts[classBucket] = (classCounts[classBucket] || 0) + 1;
                    if (!chapterCountsBySubject[subject]) chapterCountsBySubject[subject] = {};
                    chapterCountsBySubject[subject][chapter] =
                        (chapterCountsBySubject[subject][chapter] || 0) + 1;
                });
            });
        });

        return {
            total,
            difficultyCounts,
            sourceCounts,
            classCounts,
            chapterCountsBySubject,
        };
    }

    function renderMiniMetricBars(
        title: string,
        entries: Array<[string, number]>,
        barColor: string
    ) {
        const maxValue = Math.max(1, ...entries.map(([, value]) => value));
        return (
            <div
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "8px",
                    padding: "8px",
                    display: "grid",
                    gap: "5px",
                }}
            >
                <div
                    style={{
                        fontSize: "0.74rem",
                        color: "var(--text-tertiary)",
                        fontWeight: 600,
                    }}
                >
                    {title}
                </div>
                {entries.length === 0 ? (
                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        No data
                    </span>
                ) : (
                    entries.map(([label, value]) => (
                        <div
                            key={`${title}-${label}`}
                            style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(80px, 1fr) 24px",
                                gap: "6px",
                                alignItems: "center",
                            }}
                        >
                            <div style={{ display: "grid", gap: "3px" }}>
                                <div
                                    style={{
                                        fontSize: "0.71rem",
                                        color: "var(--text-secondary)",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                    }}
                                >
                                    {label}
                                </div>
                                <div
                                    style={{
                                        height: "5px",
                                        borderRadius: "999px",
                                        background: "var(--border-secondary)",
                                        overflow: "hidden",
                                    }}
                                >
                                    <div
                                        style={{
                                            height: "100%",
                                            width: `${(value / maxValue) * 100}%`,
                                            background: barColor,
                                            borderRadius: "999px",
                                        }}
                                    />
                                </div>
                            </div>
                            <span
                                style={{
                                    fontSize: "0.72rem",
                                    color: "var(--text-secondary)",
                                    textAlign: "right",
                                }}
                            >
                                {value}
                            </span>
                        </div>
                    ))
                )}
            </div>
        );
    }

    const batchSelectionOptions = batchOptions;
    const selectedBatchLabel = form.batchNames.join(", ");
    const leftHeaderAction =
        activeTab === "results" ? (
            <button
                type="button"
                onClick={() => {
                    setActiveTab("create");
                    setCreateStep(1);
                }}
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "9px",
                    border: "1px solid var(--border-primary)",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                }}
            >
                <ChevronLeft size={14} />
                Back
            </button>
        ) : activeTab === "create" && createStep === 2 ? (
            <button
                type="button"
                onClick={() => setActiveTab("results")}
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "9px",
                    border: "1px solid var(--border-primary)",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                }}
            >
                <ChevronLeft size={14} />
                Back
            </button>
        ) : null;

    const rightHeaderAction =
        activeTab === "create" && createStep === 1 ? (
            <div style={{ display: "flex", gap: "10px" }}>
                {results.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setActiveTab("results")}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "9px 14px",
                            borderRadius: "10px",
                            border: "1px solid var(--border-primary)",
                            background: "transparent",
                            color: "var(--text-secondary)",
                            fontSize: "0.84rem",
                            fontWeight: 700,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                        }}
                    >
                        Forward
                        <ChevronRight size={14} />
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleGeneratePreview}
                    disabled={generating}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--accent-primary)",
                        background: "var(--accent-glow)",
                        color: "var(--accent-primary-hover)",
                        fontSize: "0.84rem",
                        fontWeight: 700,
                        cursor: generating ? "default" : "pointer",
                        opacity: generating ? 0.7 : 1,
                    }}
                >
                    {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {generating ? "Creating..." : "Create Test"}
                </button>
            </div>
        ) : activeTab === "results" ? (
            <button
                type="button"
                onClick={handleFinaliseAndOpenOptions}
                disabled={selectedResults.length === 0 || totalSelectedQuestions === 0}
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "9px 14px",
                    borderRadius: "10px",
                    border: "1px solid var(--accent-primary)",
                    background: "var(--accent-glow)",
                    color: "var(--accent-primary-hover)",
                    fontSize: "0.84rem",
                    fontWeight: 700,
                    cursor:
                        selectedResults.length === 0 || totalSelectedQuestions === 0
                            ? "default"
                            : "pointer",
                    opacity:
                        selectedResults.length === 0 || totalSelectedQuestions === 0
                            ? 0.55
                            : 1,
                }}
            >
                Show Preview
            </button>
        ) : activeTab === "create" && createStep === 2 ? (
            <>
                <button
                    type="button"
                    onClick={() => {
                        setAiTranslateError(null);
                        setShowAiTranslateDialog(true);
                    }}
                    disabled={selectedResults.length === 0 || translatingTestWithAi}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--accent-primary)",
                        background:
                            selectedResults.length === 0 || translatingTestWithAi
                                ? "var(--accent-glow)"
                                : "linear-gradient(135deg, rgba(var(--accent-primary-rgb, 99, 102, 241), 0.18), rgba(var(--accent-primary-rgb, 99, 102, 241), 0.1))",
                        color: "var(--accent-primary-hover)",
                        fontSize: "0.84rem",
                        fontWeight: 700,
                        cursor:
                            selectedResults.length === 0 || translatingTestWithAi
                                ? "default"
                                : "pointer",
                        opacity: selectedResults.length === 0 || translatingTestWithAi ? 0.55 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title="Translate this generated test using AI"
                >
                    {translatingTestWithAi ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />}
                    {translatingTestWithAi ? "Translating..." : "Language Translate Using AI"}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setAiVerifyError(null);
                        setShowAiVerifyDialog(true);
                    }}
                    disabled={selectedResults.length === 0 || verifyingTestWithAi}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid rgba(var(--accent-success-rgb), 0.45)",
                        background:
                            selectedResults.length === 0 || verifyingTestWithAi
                                ? "rgba(var(--accent-success-rgb), 0.08)"
                                : "linear-gradient(135deg, rgba(var(--accent-success-rgb), 0.18), rgba(var(--accent-success-rgb), 0.1))",
                        color: "var(--accent-success)",
                        fontSize: "0.84rem",
                        fontWeight: 700,
                        cursor:
                            selectedResults.length === 0 || verifyingTestWithAi
                                ? "default"
                                : "pointer",
                        opacity: selectedResults.length === 0 || verifyingTestWithAi ? 0.55 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title="Verify this test paper using AI"
                >
                    {verifyingTestWithAi ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                    {verifyingTestWithAi ? "Verifying..." : "Verify Test Using AI"}
                </button>
                {hasVerificationReport && (
                    <button
                        type="button"
                        onClick={scrollToVerifyReport}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "9px 14px",
                            borderRadius: "10px",
                            border: "1px solid rgba(var(--accent-success-rgb), 0.45)",
                            background: "rgba(var(--accent-success-rgb), 0.12)",
                            color: "var(--accent-success)",
                            fontSize: "0.84rem",
                            fontWeight: 700,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                        }}
                        title="Jump to the AI verification report for this test"
                    >
                        <Eye size={14} />
                        View AI Report
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleSaveAndPreview}
                    disabled={selectedResults.length === 0 || savingForPreview}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--accent-primary)",
                        background:
                            selectedResults.length === 0 || savingForPreview
                                ? "var(--accent-glow)"
                                : "linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))",
                        color: selectedResults.length === 0 || savingForPreview ? "var(--accent-primary-hover)" : "#fff",
                        fontSize: "0.84rem",
                        fontWeight: 700,
                        cursor: selectedResults.length === 0 || savingForPreview ? "default" : "pointer",
                        opacity: selectedResults.length === 0 || savingForPreview ? 0.55 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title="Save test and open full-screen preview"
                >
                    {savingForPreview ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                    {savingForPreview ? "Saving..." : "Save & Preview"}
                </button>
                <button
                    type="button"
                    onClick={handleDownloadPDF}
                    disabled={selectedResults.length === 0}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        fontSize: "0.84rem",
                        fontWeight: 600,
                        cursor: selectedResults.length === 0 ? "not-allowed" : "pointer",
                        opacity: selectedResults.length === 0 ? 0.55 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title="Download as PDF (opens print dialog)"
                >
                    <Download size={14} />
                    PDF
                </button>
                <button
                    type="button"
                    onClick={handleDownloadDocx}
                    disabled={selectedResults.length === 0}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        fontSize: "0.84rem",
                        fontWeight: 600,
                        cursor: selectedResults.length === 0 ? "not-allowed" : "pointer",
                        opacity: selectedResults.length === 0 ? 0.55 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title="Download as Word document"
                >
                    <Download size={14} />
                    Word (docx)
                </button>
                <button
                    type="button"
                    onClick={handleDownloadWordSource}
                    disabled={selectedResults.length === 0 || downloadingWordSource}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 14px",
                        borderRadius: "10px",
                        border: "1px solid var(--accent-primary, #818cf8)",
                        background: selectedResults.length === 0 || downloadingWordSource ? "var(--bg-tertiary)" : "var(--accent-primary, #818cf8)",
                        color: selectedResults.length === 0 || downloadingWordSource ? "var(--text-tertiary)" : "#fff",
                        fontSize: "0.84rem",
                        fontWeight: 700,
                        cursor: selectedResults.length === 0 || downloadingWordSource ? "not-allowed" : "pointer",
                        opacity: selectedResults.length === 0 ? 0.55 : downloadingWordSource ? 0.85 : 1,
                        transition: "all 0.15s ease",
                    }}
                    title={
                        downloadingWordSource
                            ? "Stitching paragraphs + media into a fresh .docx — this can take 5–60 seconds depending on the number of questions."
                            : "Word output stitched from native .docx source — equations & diagrams preserved byte-exact. Works only for questions ingested via the Word upload pipeline."
                    }
                >
                    {downloadingWordSource ? (
                        <Loader2 size={14} className="animate-spin" />
                    ) : (
                        <Download size={14} />
                    )}
                    {downloadingWordSource ? "Building Word file…" : "Word (native source)"}
                </button>
            </>
        ) : null;

    if (showFullScreenPreview && selectedResults.length > 0) {
        return (
            <div style={{ background: "#ffffff", minHeight: "100vh" }}>
                <style>{`
                    html, body {
                        background: #ffffff !important;
                    }
                    @page {
                        size: A4 portrait;
                        margin: 4mm;
                    }
                    @media print {
                        body * { visibility: hidden; }
                        .print-page-container, .print-page-container * { visibility: visible; }
                        .print-page-container { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; margin: 0 !important; box-shadow: none !important; }
                        .no-print { display: none !important; }
                        .question-block { page-break-inside: avoid; }
                        .two-column-flow { column-count: 2 !important; column-gap: 4mm !important; column-rule: 1px solid #d1d5db !important; display: block !important; overflow: visible !important; }
                        .print-page-container .two-column-flow * { max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
                        .column-item { break-inside: avoid !important; page-break-inside: avoid !important; }
                    }
                    .print-page-container {
                        --bg-primary: #ffffff;
                        --bg-secondary: #f9fafb;
                        --bg-tertiary: #f3f4f6;
                        --bg-elevated: #ffffff;
                        --text-primary: #000000;
                        --text-secondary: #111827;
                        --text-tertiary: #4b5563;
                        --border-primary: #e5e7eb;
                        --border-secondary: #f3f4f6;
                        --accent-primary: #2563eb;
                        background: var(--bg-primary) !important;
                        color: var(--text-primary) !important;
                        width: min(100%, 210mm);
                        margin: 40px auto;
                        padding: 5mm;
                        border-radius: 12px;
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                    }
                    .page-break-before-print {
                        break-before: page;
                        page-break-before: always;
                    }
                    @media (max-width: 768px) {
                        .print-page-container { margin: 20px auto; padding: 20px; }
                    }
                `}</style>
                <header className="no-print" style={{ position: "sticky", top: 0, zIndex: 100, background: "#ffffff", borderBottom: "1px solid #e5e7eb", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                        <button onClick={() => setShowFullScreenPreview(false)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", background: "none", border: "none", color: "#374151", cursor: "pointer", fontSize: "0.95rem", fontWeight: 600 }}>
                            <ChevronLeft size={20} /> Back
                        </button>
                        <div style={{ height: "24px", width: "1px", background: "#e5e7eb" }} />
                        <h1 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "#111827" }}>
                            {testName.trim() || `${EXAM_TYPE_LABELS[form.examType]}_${form.batchNames[0] || DEFAULT_BATCH_NAME}_${form.examDate || new Date().toISOString().slice(0, 10)}`}
                        </h1>
                    </div>
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                        <button onClick={() => window.print()} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 20px", borderRadius: "8px", background: "var(--accent-glow)", color: "var(--accent-primary)", border: "1px solid var(--accent-primary)", cursor: "pointer", fontWeight: 650, fontSize: "0.9rem" }}>
                            Print Test
                        </button>
                    </div>
                </header>

                <div className="print-page-container a4-preview-sheet">
                    <h1 className="no-column-break" style={{ textAlign: "center", marginBottom: "30px", fontSize: "2rem", color: "#000", fontWeight: 800 }}>
                        {testName.trim() || `${EXAM_TYPE_LABELS[form.examType]} - ${form.batchNames[0] || DEFAULT_BATCH_NAME}`}
                    </h1>
                    
                    {appliedInstructions && (
                        <div className="no-column-break" style={{ marginBottom: "40px", padding: "24px", border: "1px solid #d1d5db", borderRadius: "8px", background: "#f9fafb" }}>
                            <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "1.2rem", fontWeight: 700, color: "#111827" }}>General Instructions:</h3>
                            <div style={{ whiteSpace: "pre-wrap", fontSize: "1.05rem", color: "#374151", lineHeight: 1.6 }}>{appliedInstructions}</div>
                        </div>
                    )}

                    <div style={{ display: "grid", gap: "40px" }}>
                        {selectedResults.map((test) => {
                            const paperGroups = getPaperGroups(test);
                            const hasPaperGroups = paperGroups.length > 0;
                            return (
                                <div key={`fullscreen-${test.testNumber}`} style={{ display: "grid", gap: "24px" }}>
                                    {results.length > 1 && <h2 style={{ borderBottom: "2px solid #e5e7eb", paddingBottom: "12px", fontSize: "1.5rem" }}>Test {test.testNumber}</h2>}
                                    {form.output.deliveryMode === "QUESTION_WISE" ? (
                                        <div style={{ display: "grid", gap: "20px" }}>
                                            {renderQuestionWiseOutputBlock(test, `fs-qw-${test.testNumber}`)}
                                        </div>
                                    ) : hasPaperGroups ? (
                                        <div style={{ display: "grid", gap: "30px" }}>
                                            {paperGroups.map((paperGroup) => {
                                                const paperItems: any[] = [];
                                                paperGroup.sections.forEach(s => s.questionTypes.forEach(g => g.questions.forEach(q => paperItems.push({ question: q, subject: s.subject, paper: paperGroup.paper, typeLabel: g.typeLabel }))));
                                                return renderPaperWiseOutputBlock(paperGroup.paper, paperItems, `fs-pw-${test.testNumber}-${paperGroup.paper}`);
                                            })}
                                        </div>
                                    ) : (
                                        <div style={{ display: "grid", gap: "20px" }}>
                                            {renderPaperWiseOutputBlock(null, collectPreviewQuestionItems(test), `fs-pwnone-${test.testNumber}`)}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar
                activeTab="tests"
                onTabChange={(tab) => {
                    if (tab === "questions") router.push("/questions");
                    if (tab === "analytics") router.push("/analytics");
                    if (tab === "upload") router.push("/upload");
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
                <header
                    className="glass"
                    style={{
                        borderBottom: "1px solid var(--border-primary)",
                        padding: "14px 24px",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        flexWrap: "wrap",
                    }}
                >
                    {leftHeaderAction}
                    <div
                        style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "10px",
                            background: "var(--accent-glow)",
                            color: "var(--accent-primary)",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        <Wand2 size={16} />
                    </div>
                    <div>
                        <div style={{ fontSize: "0.95rem", fontWeight: 650 }}>Tests</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                            {activeTab === "create" ? `Create Test - Step ${createStep} of 2` : activeTab === "results" ? "Generated Results" : "Previously Generated Tests"}
                        </div>
                    </div>
                    {rightHeaderAction && (
                        <div
                            style={{
                                marginLeft: "auto",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                            }}
                        >
                            {rightHeaderAction}
                        </div>
                    )}
                </header>

                <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "20px 24px 36px" }}>
                    <div style={{ maxWidth: "100%", margin: "0 auto", display: "grid", gap: "8px" }}>
                        {activeTab !== "history" && metadataError && (
                            <div
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: "9px",
                                    border: "1px solid rgba(var(--accent-warning-rgb), 0.3)",
                                    background: "rgba(var(--accent-warning-rgb), 0.08)",
                                    color: "var(--accent-warning)",
                                    fontSize: "0.78rem",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                }}
                            >
                                <AlertCircle size={14} />
                                {metadataError}
                            </div>
                        )}

                        {/* History panel — renders during Create step 1 when the
                            user expands the bottom collapsible (or directly on
                            the "history" tab for back-compat with the old route
                            entry-points). Wrapped with `order: 2` so even though
                            it appears earlier in source, CSS grid pushes it
                            BELOW the create-step-1 content. */}
                        {(activeTab === "history" || (activeTab === "create" && createStep === 1 && historyExpanded)) && (
                            <div style={{ order: 2 }}>
                            <Section
                                title="Previously Generated Tests"
                                subtitle="Open any saved test to review previously generated questions."
                            >
                                <div style={{ display: "grid", gap: "10px" }}>
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            gap: "8px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                            {historyTests.length} saved test{historyTests.length === 1 ? "" : "s"}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void loadHistory();
                                            }}
                                            disabled={historyLoading}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-secondary)",
                                                borderRadius: "8px",
                                                padding: "7px 10px",
                                                fontSize: "0.76rem",
                                                cursor: historyLoading ? "default" : "pointer",
                                                opacity: historyLoading ? 0.7 : 1,
                                            }}
                                        >
                                            <RefreshCw size={13} className={historyLoading ? "animate-spin" : ""} />
                                            Refresh
                                        </button>
                                    </div>

                                    {historyError && (
                                        <div
                                            style={{
                                                padding: "10px 12px",
                                                borderRadius: "9px",
                                                border: "1px solid rgba(var(--accent-danger-rgb),0.3)",
                                                background: "rgba(var(--accent-danger-rgb),0.08)",
                                                color: "var(--accent-danger)",
                                                fontSize: "0.78rem",
                                            }}
                                        >
                                            {historyError}
                                        </div>
                                    )}

                                    {historyLoading ? (
                                        <div
                                            style={{
                                                fontSize: "0.8rem",
                                                color: "var(--text-tertiary)",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "8px",
                                            }}
                                        >
                                            <Loader2 size={14} className="animate-spin" />
                                            Loading previously generated tests...
                                        </div>
                                    ) : historyTests.length === 0 ? (
                                        <div style={{ fontSize: "0.82rem", color: "var(--text-tertiary)" }}>
                                            No previously generated tests found. Click <strong>Generate New Test</strong> to create one.
                                        </div>
                                    ) : (
                                        <div style={{ display: "grid", gap: "10px" }}>
                                            {historyTests.map((historyTest) => {
                                                const detail = historyDetailsById[historyTest.id];
                                                const isExpanded = expandedHistoryTestId === historyTest.id;
                                                const isLoadingDetail = historyDetailLoadingId === historyTest.id;
                                                const isDeleting = deletingHistoryTestId === historyTest.id;
                                                const historyTitle =
                                                    historyTest.testName?.trim() ||
                                                    `${historyTest.batchName} - Test ${historyTest.testNumber}`;
                                                const examLabel =
                                                    EXAM_TYPE_LABELS[historyTest.examPreset as ExamType] ||
                                                    historyTest.examPreset.replace(/_/g, " ");

                                                return (
                                                    <div
                                                        key={historyTest.id}
                                                        role="button"
                                                        tabIndex={0}
                                                        onClick={() => {
                                                            void openHistoryTestInBuilder(historyTest.id);
                                                        }}
                                                        onKeyDown={(event) => {
                                                            if (event.key === "Enter" || event.key === " ") {
                                                                event.preventDefault();
                                                                void openHistoryTestInBuilder(historyTest.id);
                                                            }
                                                        }}
                                                        style={{
                                                            border: "1px solid var(--border-secondary)",
                                                            borderRadius: "10px",
                                                            background: "var(--bg-tertiary)",
                                                            padding: "12px",
                                                            display: "grid",
                                                            gap: "8px",
                                                            cursor: "pointer",
                                                        }}
                                                    >
                                                        <div
                                                            style={{
                                                                display: "flex",
                                                                alignItems: "flex-start",
                                                                justifyContent: "space-between",
                                                                gap: "10px",
                                                                flexWrap: "wrap",
                                                            }}
                                                        >
                                                            <div style={{ display: "grid", gap: "3px" }}>
                                                                <div style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                                                                    {historyTitle}
                                                                </div>
                                                                <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                                                    {historyTest.batchName} - Test {historyTest.testNumber} - {examLabel}
                                                                </div>
                                                            </div>
                                                            <div style={{ display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
                                                                <button
                                                                    type="button"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        void openHistoryTestInBuilder(historyTest.id);
                                                                    }}
                                                                    disabled={isDeleting}
                                                                    style={{
                                                                        display: "inline-flex",
                                                                        alignItems: "center",
                                                                        gap: "6px",
                                                                        padding: "7px 11px",
                                                                        borderRadius: "8px",
                                                                        border: "1px solid var(--border-primary)",
                                                                        background: "var(--bg-secondary)",
                                                                        color: "var(--text-secondary)",
                                                                        fontSize: "0.76rem",
                                                                        fontWeight: 600,
                                                                        cursor: isDeleting ? "default" : "pointer",
                                                                        opacity: isDeleting ? 0.6 : 1,
                                                                    }}
                                                                >
                                                                    {isLoadingDetail ? (
                                                                        <Loader2 size={13} className="animate-spin" />
                                                                    ) : (
                                                                        <Eye size={13} />
                                                                    )}
                                                                    Open Test
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        void deleteHistoryTest(historyTest);
                                                                    }}
                                                                    disabled={isDeleting}
                                                                    style={{
                                                                        display: "inline-flex",
                                                                        alignItems: "center",
                                                                        gap: "6px",
                                                                        padding: "7px 11px",
                                                                        borderRadius: "8px",
                                                                        border: "1px solid rgba(var(--accent-danger-rgb), 0.35)",
                                                                        background: "rgba(var(--accent-danger-rgb), 0.08)",
                                                                        color: "var(--accent-danger)",
                                                                        fontSize: "0.76rem",
                                                                        fontWeight: 600,
                                                                        cursor: isDeleting ? "default" : "pointer",
                                                                        opacity: isDeleting ? 0.6 : 1,
                                                                    }}
                                                                >
                                                                    {isDeleting ? (
                                                                        <Loader2 size={13} className="animate-spin" />
                                                                    ) : (
                                                                        <Trash2 size={13} />
                                                                    )}
                                                                    Delete
                                                                </button>
                                                            </div>
                                                        </div>

                                                        <div
                                                            style={{
                                                                display: "grid",
                                                                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                                                                gap: "8px",
                                                                fontSize: "0.75rem",
                                                                color: "var(--text-secondary)",
                                                            }}
                                                        >
                                                            <div>
                                                                <strong>Total Questions:</strong> {historyTest.totalQuestions}
                                                            </div>
                                                            <div>
                                                                <strong>Created:</strong> {formatHistoryDate(historyTest.createdAt)}
                                                            </div>
                                                            <div>
                                                                <strong>Test Date:</strong> {formatHistoryDate(historyTest.testDate)}
                                                            </div>
                                                        </div>

                                                        {isExpanded && (
                                                            <div
                                                                style={{
                                                                    borderTop: "1px solid var(--border-primary)",
                                                                    paddingTop: "10px",
                                                                    display: "grid",
                                                                    gap: "8px",
                                                                }}
                                                            >
                                                                {isLoadingDetail ? (
                                                                    <div
                                                                        style={{
                                                                            fontSize: "0.78rem",
                                                                            color: "var(--text-tertiary)",
                                                                            display: "inline-flex",
                                                                            alignItems: "center",
                                                                            gap: "8px",
                                                                        }}
                                                                    >
                                                                        <Loader2 size={14} className="animate-spin" />
                                                                        Loading test questions...
                                                                    </div>
                                                                ) : detail ? (
                                                                    <>
                                                                        {detail.aiVerificationReport && (
                                                                            <div
                                                                                style={{
                                                                                    border: "1px solid rgba(var(--accent-success-rgb), 0.24)",
                                                                                    borderRadius: "10px",
                                                                                    background: "rgba(var(--accent-success-rgb), 0.05)",
                                                                                    padding: "12px",
                                                                                    display: "grid",
                                                                                    gap: "8px",
                                                                                }}
                                                                            >
                                                                                <div
                                                                                    style={{
                                                                                        display: "flex",
                                                                                        justifyContent: "space-between",
                                                                                        gap: "10px",
                                                                                        flexWrap: "wrap",
                                                                                    }}
                                                                                >
                                                                                    <div style={{ display: "grid", gap: "3px" }}>
                                                                                        <div style={{ fontSize: "0.86rem", fontWeight: 700 }}>
                                                                                            AI Verification Report
                                                                                        </div>
                                                                                        <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                                                                            {API_KEY_PROVIDER_LABELS[detail.aiVerificationReport.provider as SupportedApiProvider] || detail.aiVerificationReport.provider} • {detail.aiVerificationReport.modelLabel} • {formatHistoryDate(detail.aiVerificationReport.verifiedAt)}
                                                                                        </div>
                                                                                    </div>
                                                                                    <div
                                                                                        style={{
                                                                                            display: "flex",
                                                                                            gap: "8px",
                                                                                            flexWrap: "wrap",
                                                                                        }}
                                                                                    >
                                                                                        <span style={{ fontSize: "0.74rem", color: "var(--accent-success)" }}>
                                                                                            {detail.aiVerificationReport.aiVerifiedCount}/{detail.aiVerificationReport.totalQuestions} AI verified
                                                                                        </span>
                                                                                        <span style={{ fontSize: "0.74rem", color: "var(--accent-danger)" }}>
                                                                                            {detail.aiVerificationReport.incorrectAnswerKeyCount} incorrect
                                                                                        </span>
                                                                                    </div>
                                                                                </div>
                                                                                <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                                                    {detail.aiVerificationReport.overallSummary}
                                                                                </div>
                                                                                {detail.aiVerificationReport.topRecommendations.length > 0 && (
                                                                                    <div style={{ display: "grid", gap: "4px" }}>
                                                                                        {detail.aiVerificationReport.topRecommendations.slice(0, 4).map((item, index) => (
                                                                                            <div key={`${historyTest.id}-report-reco-${index}`} style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                                                                                                • {item}
                                                                                            </div>
                                                                                        ))}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        )}

                                                                        {detail.questions?.length ? (
                                                                            detail.questions.map((question, index) => (
                                                                                <QuestionCard
                                                                                    key={`${historyTest.id}-${question.question_id}-${index}`}
                                                                                    question={question}
                                                                                    index={index}
                                                                                    displayNumber={index + 1}
                                                                                    expandForDetailsOnly
                                                                                    hideExamBadges
                                                                                    leadingControl={renderHistoryQuestionEditControl(
                                                                                        question
                                                                                    )}
                                                                                />
                                                                            ))
                                                                        ) : (
                                                                            <div
                                                                                style={{
                                                                                    fontSize: "0.78rem",
                                                                                    color: "var(--text-tertiary)",
                                                                                }}
                                                                            >
                                                                                No question details available for this test.
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                ) : (
                                                                    <div
                                                                        style={{
                                                                            fontSize: "0.78rem",
                                                                            color: "var(--text-tertiary)",
                                                                        }}
                                                                    >
                                                                        No question details available for this test.
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </Section>
                            </div>
                        )}

                        {activeTab === "create" && createStep === 1 && (
                            <>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px" }}>
                                    <Section title="Test Source" subtitle="Choose where questions come from.">
                                        <div style={{ display: "flex", gap: "8px" }}>
                                            <ChipButton
                                                active={testMode === "question_bank"}
                                                onClick={() => setTestMode("question_bank")}
                                                minWidth="160px"
                                            >
                                                <Database size={14} style={{ marginRight: "4px" }} />
                                                Question Bank
                                            </ChipButton>
                                            <ChipButton
                                                active={testMode === "ai"}
                                                onClick={() => setTestMode("ai")}
                                                minWidth="160px"
                                            >
                                                <Sparkles size={14} style={{ marginRight: "4px" }} />
                                                AI Generated
                                            </ChipButton>
                                        </div>
                                    </Section>

                                    <Section title="Exam Type">
                                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                            {(Object.keys(EXAM_TYPE_LABELS) as ExamType[]).map((type) => (
                                                <ChipButton
                                                    key={type}
                                                    active={form.examType === type}
                                                    onClick={() => setForm((prev) => ({ ...prev, examType: type }))}
                                                    minWidth="130px"
                                                >
                                                    {EXAM_TYPE_LABELS[type]}
                                                </ChipButton>
                                            ))}
                                        </div>
                                    </Section>
                                </div>

                                {form.examType === "JEE_ADVANCE" && (
                                    <Section title="JEE Advance Pattern Options">
                                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>Pattern Year</span>
                                                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                                                    {["2020", "2021", "2022", "2023", "2024", "2025"].map((year) => (
                                                        <ChipButton key={year} active={form.advancePatternYear === year} onClick={() => setForm((prev) => ({ ...prev, advancePatternYear: year }))}>{year}</ChipButton>
                                                    ))}
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>Paper Type</span>
                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                    {(["Paper 1", "Paper 2"] as PaperType[]).map((paper) => (
                                                        <ChipButton key={paper} active={form.paperType.includes(paper)} onClick={() => setForm((prev) => ({ ...prev, paperType: toggleArrayValue(prev.paperType, paper) }))}>{paper}</ChipButton>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </Section>
                                )}

                                {form.examType !== "CUSTOMISED_TEST" && (
                                    <Section
                                        title="Question Distribution"
                                        subtitle="Edit question counts and reorder rows. Question number ranges update automatically."
                                    >
                                        {form.examType === "JEE_ADVANCE" ? (
                                            <div
                                                style={{
                                                    display: "grid",
                                                    gap: "12px",
                                                    gridTemplateColumns:
                                                        form.paperType.length > 1
                                                            ? "repeat(auto-fit, minmax(420px, 1fr))"
                                                            : "1fr",
                                                }}
                                            >
                                                {PAPER_DISPLAY_ORDER.filter((paper) =>
                                                    form.paperType.includes(paper)
                                                ).map((paper) => {
                                                    const rows = rowsWithQuestionNumbers(
                                                        form.jeeAdvanceDistributionByPaper[paper] || []
                                                    );
                                                    return (
                                                        <div
                                                            key={paper}
                                                            style={{
                                                                border: "1px solid var(--border-secondary)",
                                                                borderRadius: "10px",
                                                                padding: "10px",
                                                                background: "var(--bg-secondary)",
                                                                display: "grid",
                                                                gap: "8px",
                                                            }}
                                                        >
                                                            <div style={{ fontSize: "0.86rem", fontWeight: 700 }}>
                                                                {paper}
                                                            </div>
                                                            <div
                                                                style={{
                                                                    display: "grid",
                                                                    gridTemplateColumns: "120px 250px 160px",
                                                                    gap: "24px",
                                                                    fontSize: "0.74rem",
                                                                    color: "var(--text-tertiary)",
                                                                    fontWeight: 600,
                                                                }}
                                                            >
                                                                <span>Question Numbers</span>
                                                                <span>Question Type</span>
                                                                <span>Number of Questions</span>
                                                            </div>
                                                            {rows.map((row, index) => (
                                                                <div
                                                                    key={row.id}
                                                                    style={{
                                                                    display: "grid",
                                                                        gridTemplateColumns: "120px 250px 160px",
                                                                        gap: "24px",
                                                                        alignItems: "center",
                                                                    }}
                                                                >
                                                                    <span
                                                                        style={{
                                                                            fontSize: "0.78rem",
                                                                            color: "var(--text-secondary)",
                                                                        }}
                                                                    >
                                                                        {row.questionNumbers}
                                                                    </span>
                                                                    <select
                                                                        value={row.type}
                                                                        onChange={(e) => updateDistributionType(row.id, e.target.value as QuestionType, paper)}
                                                                        style={{
                                                                            width: "100%",
                                                                            padding: "8px 10px",
                                                                            borderRadius: "8px",
                                                                            border: "1px solid var(--border-primary)",
                                                                            background: "var(--bg-elevated)",
                                                                            color: "var(--text-primary)",
                                                                            fontSize: "0.8rem",
                                                                        }}
                                                                    >
                                                                        {KNOWN_QUESTION_TYPES.map(type => (
                                                                            <option key={type} value={type}>
                                                                                {getQuestionTypeLabel(type)}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                    <input
                                                                        type="number"
                                                                        min={1}
                                                                        value={row.count}
                                                                        onChange={(e) =>
                                                                            updateDistributionCount(
                                                                                row.id,
                                                                                Number(e.target.value),
                                                                                paper
                                                                            )
                                                                        }
                                                                        style={{
                                                                            width: "100%",
                                                                            padding: "8px 10px",
                                                                            borderRadius: "8px",
                                                                            border: "1px solid var(--border-primary)",
                                                                            background: "var(--bg-elevated)",
                                                                            color: "var(--text-primary)",
                                                                        }}
                                                                    />
                                                                </div>
                                                            ))}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <div
                                                style={{
                                                    border: "1px solid var(--border-secondary)",
                                                    borderRadius: "10px",
                                                    padding: "10px",
                                                    background: "var(--bg-secondary)",
                                                    display: "grid",
                                                    gap: "8px",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        display: "grid",
                                                        gridTemplateColumns: "120px 250px 160px",
                                                        gap: "24px",
                                                        fontSize: "0.74rem",
                                                        color: "var(--text-tertiary)",
                                                        fontWeight: 600,
                                                    }}
                                                >
                                                    <span>Question Numbers</span>
                                                    <span>Question Type</span>
                                                    <span>Number of Questions</span>
                                                </div>
                                                {rowsWithQuestionNumbers(form.questionDistribution).map(
                                                    (row, index, list) => (
                                                        <div
                                                            key={row.id}
                                                            style={{
                                                                display: "grid",
                                                                gridTemplateColumns: "120px 250px 160px",
                                                                gap: "24px",
                                                                alignItems: "center",
                                                            }}
                                                        >
                                                            <span
                                                                style={{
                                                                    fontSize: "0.78rem",
                                                                    color: "var(--text-secondary)",
                                                                }}
                                                            >
                                                                {row.questionNumbers}
                                                            </span>
                                                            <select
                                                                value={row.type}
                                                                onChange={(e) => updateDistributionType(row.id, e.target.value as QuestionType)}
                                                                style={{
                                                                    width: "100%",
                                                                    padding: "8px 10px",
                                                                    borderRadius: "8px",
                                                                    border: "1px solid var(--border-primary)",
                                                                    background: "var(--bg-elevated)",
                                                                    color: "var(--text-primary)",
                                                                    fontSize: "0.8rem",
                                                                }}
                                                                >
                                                                {KNOWN_QUESTION_TYPES.map(type => (
                                                                    <option key={type} value={type}>
                                                                        {getQuestionTypeLabel(type)}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                value={row.count}
                                                                onChange={(e) =>
                                                                    updateDistributionCount(
                                                                        row.id,
                                                                        Number(e.target.value)
                                                                    )
                                                                }
                                                                style={{
                                                                    width: "100%",
                                                                    padding: "8px 10px",
                                                                    borderRadius: "8px",
                                                                    border: "1px solid var(--border-primary)",
                                                                    background: "var(--bg-elevated)",
                                                                    color: "var(--text-primary)",
                                                                }}
                                                            />
                                                        </div>
                                                    )
                                                )}
                                            </div>
                                        )}
                                    </Section>
                                )}

                                {!isAiGeneratedSelected && (
                                <Section title="Question Source">
                                    {(() => {
                                        const allSources = visibleSourceOptions;
                                        const selectedCount = form.questionSource.length;
                                        const percentTotal = form.questionSource.reduce(
                                            (sum, src) => sum + (form.sourcePercentages[src] ?? 0),
                                            0
                                        );
                                        const percentOff = selectedCount > 0 && percentTotal !== 100;
                                        const toolbarBtn: React.CSSProperties = {
                                            padding: "4px 10px",
                                            borderRadius: "7px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-secondary)",
                                            fontSize: "0.74rem",
                                            fontWeight: 500,
                                            cursor: "pointer",
                                        };
                                        return (
                                    <div style={{ display: "grid", gap: "10px" }}>
                                        <SearchableMultiSelect
                                            options={allSources}
                                            selected={form.questionSource}
                                            onChange={setSelectedSources}
                                            placeholder="Search and select sources…"
                                            noun="source"
                                            counts={sourceQuestionCounts}
                                        />

                                        {selectedCount > 0 && (
                                            <>
                                                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", borderTop: "1px solid var(--border-secondary)", paddingTop: "10px" }}>
                                                    <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", marginRight: "auto" }}>
                                                        Share per source
                                                    </span>
                                                    <span
                                                        style={{
                                                            fontSize: "0.74rem",
                                                            fontWeight: 600,
                                                            color: percentOff ? "var(--accent-warning, #d97706)" : "var(--accent-success, #16a34a)",
                                                        }}
                                                        title={percentOff ? "Shares should add up to 100%" : "Shares add up to 100%"}
                                                    >
                                                        {percentTotal}% total
                                                    </span>
                                                    <button type="button" style={toolbarBtn} onClick={distributeSourcesEvenly}>
                                                        Distribute evenly
                                                    </button>
                                                </div>

                                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "8px", maxHeight: selectedCount > 10 ? "240px" : undefined, overflowY: selectedCount > 10 ? "auto" : undefined }}>
                                                    {form.questionSource.map((source) => (
                                                        <div key={source} style={{ display: "flex", gap: "10px", alignItems: "center", fontSize: "0.78rem" }}>
                                                            <span style={{ color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={source}>{source}</span>
                                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                                <input type="number" min={0} max={100} value={form.sourcePercentages[source] ?? 0} onChange={(e) => setSourcePercent(source, Number(e.target.value))} style={{ width: "80px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: "0.78rem" }} />
                                                                <span style={{ color: "var(--text-tertiary)" }}>%</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                        );
                                    })()}
                                </Section>
                                )}

                                {isAiGeneratedSelected && (
                                    <Section title="AI Generation" subtitle="Choose provider and model. This test will be generated fresh using AI.">
                                        <div style={{ display: "grid", gap: "12px" }}>
                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>AI Provider</span>
                                                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                                                    {AI_PROVIDER_ORDER.map((provider) => (
                                                        <ChipButton
                                                            key={provider}
                                                            active={aiProvider === provider}
                                                            onClick={() => {
                                                                setAiProvider(provider);
                                                                setAiModelId((prev) => {
                                                                    const trimmed = prev.trim();
                                                                    const models =
                                                                        aiModelOptionsByProvider[provider] ||
                                                                        DEFAULT_AI_MODELS[provider];
                                                                    if (
                                                                        trimmed &&
                                                                        models.some((model) => model.id === trimmed)
                                                                    ) {
                                                                        return trimmed;
                                                                    }
                                                                    return models[0]?.id || trimmed;
                                                                });
                                                            }}
                                                        >
                                                            {AI_PROVIDER_LABELS[provider]}
                                                        </ChipButton>
                                                    ))}
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>Model</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            loadLiveAiModels(aiProvider).catch(() => {
                                                                // handled in loadLiveAiModels state
                                                            });
                                                        }}
                                                        disabled={loadingAiModels}
                                                        style={{
                                                            borderRadius: "8px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-secondary)",
                                                            padding: "6px 10px",
                                                            fontSize: "0.76rem",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "6px",
                                                            cursor: loadingAiModels ? "default" : "pointer",
                                                            opacity: loadingAiModels ? 0.7 : 1,
                                                        }}
                                                    >
                                                        {loadingAiModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                                        Refresh Live Models
                                                    </button>
                                                </div>

                                                <select
                                                    value={isCurrentAiModelListed ? normalizedAiModelId : ""}
                                                    onChange={(e) => setAiModelId(e.target.value)}
                                                    style={{
                                                        width: "100%",
                                                        padding: "9px 12px",
                                                        borderRadius: "9px",
                                                        border: "1px solid var(--border-primary)",
                                                        background: "var(--bg-tertiary)",
                                                        color: "var(--text-primary)",
                                                    }}
                                                >
                                                    <option value="" disabled>
                                                        {loadingAiModels ? "Loading models..." : "Select a model"}
                                                    </option>
                                                    {currentAiModelOptions.map((model) => (
                                                        <option key={model.id} value={model.id}>
                                                            {model.label}
                                                        </option>
                                                    ))}
                                                </select>

                                                <label style={{ display: "grid", gap: "6px" }}>
                                                    <span style={{ fontSize: "0.77rem", fontWeight: 600, color: "var(--text-tertiary)" }}>Custom Model Name</span>
                                                    <input
                                                        value={aiModelId}
                                                        onChange={(e) => setAiModelId(e.target.value)}
                                                        placeholder="Enter exact model id (optional)"
                                                        style={{
                                                            width: "100%",
                                                            padding: "9px 12px",
                                                            borderRadius: "9px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                        }}
                                                    />
                                                </label>

                                                <span style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                                    {usingLiveAiModels ? "Live model list loaded for selected provider." : "Showing fallback model list."}
                                                </span>

                                                {aiModelsError && (
                                                    <span style={{ fontSize: "0.74rem", color: "var(--accent-warning)" }}>{aiModelsError}</span>
                                                )}

                                                {!hasSelectedAiProviderKey && (
                                                    <span style={{ fontSize: "0.74rem", color: "var(--accent-danger)" }}>
                                                        Save {AI_PROVIDER_LABELS[aiProvider]} API key from the user menu to generate AI tests.
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </Section>
                                )}

                                {form.examType !== "CUSTOMISED_TEST" && (
                                    <>
                                        <Section title="Difficulty (%)">
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                                                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Easy.text, whiteSpace: "nowrap" }}>Easy Questions</span>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                        <input type="number" min={0} max={100 - form.hardPercent} value={form.easyPercent} onChange={(e) => updateDifficulty(Number(e.target.value), form.hardPercent, "easy")} style={{ width: "80px", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>%</span>
                                                    </div>
                                                </div>

                                                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Hard.text, whiteSpace: "nowrap" }}>Hard Questions</span>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                        <input type="number" min={0} max={100 - form.easyPercent} value={form.hardPercent} onChange={(e) => updateDifficulty(form.easyPercent, Number(e.target.value), "hard")} style={{ width: "80px", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>%</span>
                                                    </div>
                                                </div>

                                                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Medium.text, whiteSpace: "nowrap" }}>Medium Questions</span>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                        <input value={form.mediumPercent} readOnly style={{ width: "80px", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-secondary)" }} />
                                                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </Section>

                                        {!isAiGeneratedSelected && (
                                            <Section title="Batches and Test Basics" subtitle={`Choose saved batches, or leave blank to use ${DEFAULT_BATCH_NAME}.`}>
                                                <div style={{ display: "grid", gap: "12px" }}>
                                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px" }}>
                                                        <div style={{ display: "grid", gap: "8px" }}>
                                                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Select Batches</span>
                                                            <div style={{ border: "1px solid var(--border-primary)", borderRadius: "10px", background: "var(--bg-tertiary)", overflow: "hidden" }}>
                                                                <button type="button" onClick={() => setBatchDropdownOpen((v) => !v)} style={{ width: "100%", textAlign: "left", padding: "10px 12px", border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.84rem" }}>
                                                                    {selectedBatchLabel.length ? selectedBatchLabel : `Select batches (default: ${DEFAULT_BATCH_NAME})`}
                                                                </button>
                                                                {batchDropdownOpen && (
                                                                    <div style={{ borderTop: "1px solid var(--border-primary)", padding: "8px 10px", maxHeight: "180px", overflow: "auto", display: "grid", gap: "6px" }}>
                                                                        {batchOptions.length === 0 && (
                                                                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>No saved batches yet.</span>
                                                                        )}
                                                                        {batchSelectionOptions.map((batch) => (
                                                                            <div key={batch} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px", alignItems: "center" }}>
                                                                                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                                                                    <input type="checkbox" checked={form.batchNames.includes(batch)} onChange={() => toggleBatchSelection(batch)} style={{ accentColor: "var(--accent-primary)" }} />
                                                                                {batch}
                                                                            </label>
                                                                            <button type="button" onClick={() => { deleteBatchOption(batch).catch(() => { /* handled in function */ }); }} title={`Delete ${batch}`} style={{ width: "24px", height: "24px", borderRadius: "6px", border: "1px solid rgba(var(--accent-danger-rgb), 0.35)", background: "rgba(var(--accent-danger-rgb), 0.1)", color: "var(--accent-danger)", display: "grid", placeItems: "center", cursor: "pointer" }}>
                                                                                <Trash2 size={12} />
                                                                            </button>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                    </div>

                                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" }}>
                                                        <div style={{ display: "grid", gap: "8px" }}>
                                                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Add New Batch Name</span>
                                                            <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) auto", justifyContent: "start", gap: "8px" }}>
                                                                <input value={newBatchName} onChange={(e) => setNewBatchName(e.target.value)} placeholder="Type batch name" style={{ width: "100%", padding: "9px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                                <button type="button" onClick={() => { addBatchOption().catch(() => { /* handled in function */ }); }} style={{ borderRadius: "9px", border: "1px solid var(--accent-primary)", background: "var(--accent-glow)", color: "var(--accent-primary-hover)", padding: "0 14px", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                                                    <Plus size={14} />
                                                                    Save
                                                                </button>
                                                            </div>
                                                        </div>
                                                        <label style={{ display: "grid", gap: "6px" }}>
                                                            <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Exam Date (Optional)</span>
                                                            <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto" }}>
                                                                <input ref={examDateRef} type="date" value={form.examDate} onChange={(e) => setForm((prev) => ({ ...prev, examDate: e.target.value }))} style={{ width: "100%", padding: "9px 12px", borderRadius: "9px 0 0 9px", border: "1px solid var(--border-primary)", borderRight: "none", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                                <button type="button" onClick={openDatePicker} style={{ width: "40px", borderRadius: "0 9px 9px 0", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-secondary)", cursor: "pointer" }}>
                                                                    <Calendar size={14} />
                                                                </button>
                                                            </div>
                                                        </label>

                                                        <label style={{ display: "grid", gap: "6px" }}>
                                                            <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Number of Tests</span>
                                                            <input type="number" min={1} max={10} value={form.numberOfTests} onChange={(e) => setForm((prev) => ({ ...prev, numberOfTests: Math.max(1, Math.min(10, Number(e.target.value) || 1)) }))} style={{ width: "100%", padding: "9px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                        </label>

                                                        <label style={{ display: "grid", gap: "6px" }}>
                                                            <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Test Language</span>
                                                            <select
                                                                value={form.language}
                                                                onChange={(e) => setForm((prev) => ({ ...prev, language: e.target.value }))}
                                                                style={{ width: "100%", padding: "9px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", textTransform: "capitalize" }}
                                                                title="If non-English, only questions with a default translation in this language will be used."
                                                            >
                                                                {availableLanguages.map((lang) => (
                                                                    <option key={lang} value={lang} style={{ textTransform: "capitalize" }}>{lang}</option>
                                                                ))}
                                                            </select>
                                                        </label>
                                                    </div>
                                                </div>
                                            </Section>
                                        )}

                                        <Section title="Syllabus Configuration">
                                            <div style={{ display: "grid", gap: "12px" }}>
                                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px", alignItems: "end" }}>
                                                    <div style={{ display: "grid", gap: "8px" }}>
                                                        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>Subjects</span>
                                                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                            {subjectOptions.map((subject) => (
                                                                <ChipButton key={subject} active={form.subjects.includes(subject)} onClick={() => toggleSubject(subject)} minWidth="120px">{subject}</ChipButton>
                                                            ))}
                                                        </div>
                                                    </div>

                                                    <div style={{ display: "grid", gap: "8px" }}>
                                                        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>Full Syllabus?</span>
                                                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", background: "var(--bg-elevated)", border: "1px solid var(--border-primary)", borderRadius: "10px", padding: "4px", minWidth: "220px" }}>
                                                            <ChipButton active={form.fullSyllabus === "Yes"} onClick={() => setFullSyllabus("Yes")}>Yes</ChipButton>
                                                            <ChipButton active={form.fullSyllabus === "No"} onClick={() => setFullSyllabus("No")}>No</ChipButton>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Word-source-only toggle — pairs with the "Word (native source)" download */}
                                                <div
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "10px",
                                                        padding: "10px 14px",
                                                        borderRadius: "10px",
                                                        border: `1px solid ${form.wordSourceOnly ? "var(--accent-primary, #818cf8)" : "var(--border-primary)"}`,
                                                        background: form.wordSourceOnly ? "var(--accent-primary, #818cf8)15" : "var(--bg-secondary)",
                                                    }}
                                                >
                                                    <label style={{ display: "inline-flex", alignItems: "center", gap: "10px", cursor: "pointer", flex: 1 }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={form.wordSourceOnly}
                                                            onChange={(e) => setForm((prev) => ({ ...prev, wordSourceOnly: e.target.checked }))}
                                                        />
                                                        <span style={{ display: "grid", gap: "2px" }}>
                                                            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                                                Word source only
                                                            </span>
                                                            <span style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                                                Pick questions only from .docx ingests (preserves equations + diagrams). Pair with the <strong>Word (native source)</strong> download to get a byte-exact .docx test paper.
                                                            </span>
                                                        </span>
                                                    </label>
                                                </div>

                                                {form.fullSyllabus === "No" && (
                                                    <>
                                                        <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "10px", padding: "12px", background: "var(--bg-secondary)" }}>
                                                            {loadingMetadata ? (
                                                                <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>Loading chapters...</span>
                                                            ) : (
                                                                <div style={{ display: "grid", gap: "12px" }}>
                                                                    {form.subjects.map((subject) => {
                                                                        const chapters = metadata.chaptersBySubject[subject] || [];
                                                                        return (
                                                                            <div key={subject} style={{ display: "grid", gap: "8px" }}>
                                                                                <div style={{ fontSize: "0.84rem", fontWeight: 700 }}>{subject}</div>
                                                                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                                                                    {chapters.map((chapter) => (
                                                                                        <ChipButton key={chapter} active={form.selectedChapters.includes(chapter)} onClick={() => toggleChapter(chapter)}>{chapter}</ChipButton>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </div>

                                                        {form.selectedChapters.length > 0 && (
                                                            <div style={{ display: "grid", gap: "10px" }}>
                                                                {form.selectedChapters.map((chapter) => {
                                                                    const chapterTopics = metadata.topicsByChapter[chapter] || [];
                                                                    const selectedTopics = form.selectedTopics[chapter] || [];
                                                                    return (
                                                                        <div key={chapter} style={{ border: "1px solid var(--border-secondary)", borderRadius: "10px", padding: "10px", background: "var(--bg-tertiary)" }}>
                                                                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
                                                                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>{chapter}</span>
                                                                                <button type="button" onClick={() => setForm((prev) => ({ ...prev, selectedTopics: { ...prev.selectedTopics, [chapter]: [] } }))} style={{ border: "1px solid var(--border-primary)", background: "transparent", color: "var(--text-tertiary)", borderRadius: "7px", padding: "4px 8px", fontSize: "0.72rem", cursor: "pointer" }}>All Topics</button>
                                                                            </div>
                                                                            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                                                                {chapterTopics.map((topic) => (
                                                                                    <ChipButton key={topic} active={selectedTopics.includes(topic)} onClick={() => toggleTopic(chapter, topic)}>{topic}</ChipButton>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        </Section>
                                    </>
                                )}

                                {form.examType === "CUSTOMISED_TEST" && !isAiGeneratedSelected && (
                                    <Section title="Batches and Test Basics" subtitle={`Choose saved batches, or leave blank to use ${DEFAULT_BATCH_NAME}.`}>
                                        <div style={{ display: "grid", gap: "12px" }}>
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px" }}>
                                                <div style={{ display: "grid", gap: "8px" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Select Batches</span>
                                                    <div style={{ border: "1px solid var(--border-primary)", borderRadius: "10px", background: "var(--bg-tertiary)", overflow: "hidden" }}>
                                                        <button type="button" onClick={() => setBatchDropdownOpen((v) => !v)} style={{ width: "100%", textAlign: "left", padding: "10px 12px", border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.84rem" }}>
                                                            {selectedBatchLabel.length ? selectedBatchLabel : `Select batches (default: ${DEFAULT_BATCH_NAME})`}
                                                        </button>
                                                        {batchDropdownOpen && (
                                                            <div style={{ borderTop: "1px solid var(--border-primary)", padding: "8px 10px", maxHeight: "180px", overflow: "auto", display: "grid", gap: "6px" }}>
                                                                {batchOptions.length === 0 && (
                                                                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>No saved batches yet.</span>
                                                                )}
                                                                {batchSelectionOptions.map((batch) => (
                                                                    <div key={batch} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px", alignItems: "center" }}>
                                                                        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                                                            <input type="checkbox" checked={form.batchNames.includes(batch)} onChange={() => toggleBatchSelection(batch)} style={{ accentColor: "var(--accent-primary)" }} />
                                                                            {batch}
                                                                        </label>
                                                                        <button type="button" onClick={() => { deleteBatchOption(batch).catch(() => { /* handled in function */ }); }} title={`Delete ${batch}`} style={{ width: "24px", height: "24px", borderRadius: "6px", border: "1px solid rgba(var(--accent-danger-rgb), 0.35)", background: "rgba(var(--accent-danger-rgb), 0.1)", color: "var(--accent-danger)", display: "grid", placeItems: "center", cursor: "pointer" }}>
                                                                            <Trash2 size={12} />
                                                                        </button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                            </div>

                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" }}>
                                                <div style={{ display: "grid", gap: "8px" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Add New Batch Name</span>
                                                    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) auto", justifyContent: "start", gap: "8px" }}>
                                                        <input value={newBatchName} onChange={(e) => setNewBatchName(e.target.value)} placeholder="Type batch name" style={{ width: "100%", padding: "9px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                        <button type="button" onClick={() => { addBatchOption().catch(() => { /* handled in function */ }); }} style={{ borderRadius: "9px", border: "1px solid var(--accent-primary)", background: "var(--accent-glow)", color: "var(--accent-primary-hover)", padding: "0 14px", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                                            <Plus size={14} />
                                                            Save
                                                        </button>
                                                    </div>
                                                </div>
                                                <label style={{ display: "grid", gap: "6px" }}>
                                                    <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Exam Date (Optional)</span>
                                                    <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto" }}>
                                                        <input ref={examDateRef} type="date" value={form.examDate} onChange={(e) => setForm((prev) => ({ ...prev, examDate: e.target.value }))} style={{ width: "100%", padding: "9px 12px", borderRadius: "9px 0 0 9px", border: "1px solid var(--border-primary)", borderRight: "none", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                        <button type="button" onClick={openDatePicker} style={{ width: "40px", borderRadius: "0 9px 9px 0", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-secondary)", cursor: "pointer" }}>
                                                            <Calendar size={14} />
                                                        </button>
                                                    </div>
                                                </label>

                                                <label style={{ display: "grid", gap: "6px" }}>
                                                    <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Number of Tests</span>
                                                    <input type="number" min={1} max={10} value={form.numberOfTests} onChange={(e) => setForm((prev) => ({ ...prev, numberOfTests: Math.max(1, Math.min(10, Number(e.target.value) || 1)) }))} style={{ width: "100%", padding: "9px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }} />
                                                </label>
                                            </div>
                                        </div>
                                    </Section>
                                )}

                                {form.examType === "CUSTOMISED_TEST" && (
                                    <Section title="Customised Test Rows" subtitle="Add/remove rows. Easy/Hard sliders are per row.">
                                        <div style={{ display: "grid", gap: "10px" }}>
                                            {form.customRows.map((row, index) => {
                                                const rowChapterOptions = metadata.chaptersBySubject[row.subject] || [];
                                                const rowTopicOptions = metadata.topicsByChapter[row.chapter] || [];

                                                return (
                                                    <div key={row.id} style={{ overflowX: "auto" }}>
                                                        <div
                                                            style={{
                                                                minWidth: "960px",
                                                                border: "1px solid var(--border-secondary)",
                                                                borderRadius: "10px",
                                                                padding: "10px",
                                                                background: "var(--bg-tertiary)",
                                                                display: "grid",
                                                                gridTemplateColumns: "1.35fr 72px 110px 110px 1fr 1.3fr 1.3fr auto",
                                                                gap: "8px",
                                                                alignItems: "center",
                                                            }}
                                                        >
                                                            <select value={row.questionType} onChange={(e) => updateCustomRow(row.id, { questionType: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
                                                                {metadata.questionTypes.map((type) => (
                                                                    <option key={type} value={type}>{getQuestionTypeLabel(type)}</option>
                                                                ))}
                                                                {!metadata.questionTypes.length && <option value="Single_Choice(SCQ)">SCQ</option>}
                                                            </select>

                                                            <input type="number" min={1} value={row.numQuestions} onChange={(e) => updateCustomRow(row.id, { numQuestions: Math.max(1, Number(e.target.value) || 1) })} style={{ width: "100%", padding: "8px 6px", borderRadius: "8px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" }} />

                                                            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                                                <span style={{ fontSize: "0.68rem", color: DIFFICULTY_COLORS.Easy.text, width: "24px" }}>Easy</span>
                                                                <input type="number" min={0} max={100 - row.hardPercent} value={row.easyPercent} onChange={(e) => updateCustomRow(row.id, { easyPercent: Number(e.target.value) })} style={{ width: "65px", padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: "0.72rem" }} />
                                                                <span style={{ fontSize: "0.68rem" }}>%</span>
                                                            </div>

                                                            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                                                <span style={{ fontSize: "0.68rem", color: DIFFICULTY_COLORS.Hard.text, width: "24px" }}>Hard</span>
                                                                <input type="number" min={0} max={100 - row.easyPercent} value={row.hardPercent} onChange={(e) => updateCustomRow(row.id, { hardPercent: Number(e.target.value) })} style={{ width: "65px", padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: "0.72rem" }} />
                                                                <span style={{ fontSize: "0.68rem" }}>%</span>
                                                            </div>

                                                            <select value={row.subject} onChange={(e) => updateCustomRow(row.id, { subject: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
                                                                {subjectOptions.map((subject) => (<option key={subject} value={subject}>{subject}</option>))}
                                                            </select>

                                                            <select value={row.chapter} onChange={(e) => updateCustomRow(row.id, { chapter: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
                                                                <option value="">Any Chapter</option>
                                                                {rowChapterOptions.map((chapter) => (<option key={chapter} value={chapter}>{chapter}</option>))}
                                                            </select>

                                                            <select value={row.topic} onChange={(e) => updateCustomRow(row.id, { topic: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
                                                                <option value="">Any Topic</option>
                                                                {rowTopicOptions.map((topic) => (<option key={topic} value={topic}>{topic}</option>))}
                                                            </select>

                                                            <button type="button" onClick={() => removeCustomRow(row.id)} title={`Delete Row ${index + 1}`} style={{ width: "34px", height: "34px", borderRadius: "8px", border: "1px solid rgba(var(--accent-danger-rgb), 0.35)", background: "rgba(var(--accent-danger-rgb), 0.1)", color: "var(--accent-danger)", display: "grid", placeItems: "center", cursor: "pointer" }}>
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}

                                            <button type="button" onClick={addCustomRow} style={{ width: "fit-content", display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "9px", border: "1px solid var(--accent-primary)", background: "var(--accent-glow)", color: "var(--accent-primary-hover)", cursor: "pointer", fontSize: "0.8rem", fontWeight: 600 }}>
                                                <Plus size={14} />
                                                Add Row
                                            </button>
                                        </div>
                                    </Section>
                                )}

                                {error && (
                                    <div style={{ padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(var(--accent-danger-rgb), 0.3)", background: "rgba(var(--accent-danger-rgb), 0.08)", color: "var(--accent-danger)", fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "8px" }}>
                                        <AlertCircle size={14} />
                                        {error}
                                    </div>
                                )}

                                {/* Collapsible "Previously Generated Tests" toggle.
                                    Sits at the bottom of the Create form. Clicking
                                    expands the history panel (rendered above with
                                    `order: 2` so it appears BELOW this button
                                    despite being earlier in JSX source order). */}
                                <button
                                    type="button"
                                    onClick={() => setHistoryExpanded(prev => !prev)}
                                    style={{
                                        order: 1,
                                        width: "100%",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: "12px",
                                        padding: "14px 18px",
                                        marginTop: "8px",
                                        borderRadius: "12px",
                                        border: "1px solid var(--border-primary)",
                                        background: historyExpanded
                                            ? "var(--bg-tertiary)"
                                            : "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.86rem",
                                        fontWeight: 650,
                                        cursor: "pointer",
                                        transition: "background 0.15s ease",
                                    }}
                                    aria-expanded={historyExpanded}
                                    aria-controls="previously-generated-tests-panel"
                                >
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                                        {historyExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                        Previously Generated Tests
                                        {historyTests.length > 0 && (
                                            <span
                                                style={{
                                                    fontSize: "0.72rem",
                                                    fontWeight: 700,
                                                    color: "var(--accent-primary)",
                                                    background: "var(--accent-glow)",
                                                    padding: "2px 8px",
                                                    borderRadius: "999px",
                                                }}
                                            >
                                                {historyTests.length}
                                            </span>
                                        )}
                                    </span>
                                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", fontWeight: 500 }}>
                                        {historyExpanded ? "Click to collapse" : "Click to view saved tests"}
                                    </span>
                                </button>

                            </>
                        )}

                        {activeTab === "create" && createStep === 2 && (
                            <>
                                <Section>
                                    <div style={{ display: "grid", gap: "12px" }}>
                                        {/* Test Name */}
                                        <div style={{ display: "grid", gap: "6px" }}>
                                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                                Test Name <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span>
                                            </span>
                                            <input
                                                type="text"
                                                value={testName}
                                                onChange={(e) => setTestName(e.target.value)}
                                                placeholder={`${EXAM_TYPE_LABELS[form.examType]}_${form.batchNames[0]?.trim() || DEFAULT_BATCH_NAME}_${form.examDate || new Date().toISOString().slice(0, 10)}`}
                                                style={{
                                                    padding: "8px 12px",
                                                    borderRadius: "8px",
                                                    border: "1px solid var(--border-primary)",
                                                    background: "var(--bg-primary)",
                                                    color: "var(--text-primary)",
                                                    fontSize: "0.84rem",
                                                    outline: "none",
                                                }}
                                            />
                                        </div>
                                        <div
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns:
                                                    "repeat(auto-fit, minmax(260px, 1fr))",
                                                gap: "12px",
                                                alignItems: "start",
                                            }}
                                        >
                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Option Label Format</span>
                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                    <ChipButton active={form.output.labelFormat === "ABCD"} onClick={() => setForm((prev) => ({ ...prev, output: { ...prev.output, labelFormat: "ABCD" } }))}>A, B, C, D</ChipButton>
                                                    <ChipButton active={form.output.labelFormat === "1234"} onClick={() => setForm((prev) => ({ ...prev, output: { ...prev.output, labelFormat: "1234" } }))}>1, 2, 3, 4</ChipButton>
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Output Ordering</span>
                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                    <ChipButton active={form.output.deliveryMode === "PAPER_WISE"} onClick={() => setForm((prev) => ({ ...prev, output: { ...prev.output, deliveryMode: "PAPER_WISE" } }))}>Paper-wise</ChipButton>
                                                    <ChipButton active={form.output.deliveryMode === "QUESTION_WISE"} onClick={() => setForm((prev) => ({ ...prev, output: { ...prev.output, deliveryMode: "QUESTION_WISE" } }))}>Question-wise</ChipButton>
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>2-Column Format</span>
                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                    <ChipButton
                                                        active={form.output.twoColumnFormat}
                                                        onClick={() =>
                                                            setForm((prev) => ({
                                                                ...prev,
                                                                output: {
                                                                    ...prev.output,
                                                                    twoColumnFormat: true,
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        Yes
                                                    </ChipButton>
                                                    <ChipButton
                                                        active={!form.output.twoColumnFormat}
                                                        onClick={() =>
                                                            setForm((prev) => ({
                                                                ...prev,
                                                                output: {
                                                                    ...prev.output,
                                                                    twoColumnFormat: false,
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        No
                                                    </ChipButton>
                                                </div>
                                            </div>

                                            <div style={{ display: "grid", gap: "8px" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Content Selection</span>
                                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                    <ChipButton
                                                        active
                                                        onClick={() =>
                                                            setForm((prev) => ({
                                                                ...prev,
                                                                output: {
                                                                    ...prev.output,
                                                                    contentMode: "QUESTIONS_ONLY",
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        Question
                                                    </ChipButton>
                                                    <ChipButton
                                                        active={
                                                            form.output.contentMode ===
                                                                "QUESTIONS_WITH_ANSWER_KEY" ||
                                                            form.output.contentMode ===
                                                                "QUESTIONS_ANSWER_KEY_SOLUTION"
                                                        }
                                                        onClick={() =>
                                                            setForm((prev) => ({
                                                                ...prev,
                                                                output: {
                                                                    ...prev.output,
                                                                    contentMode:
                                                                        prev.output.contentMode ===
                                                                            "QUESTIONS_ONLY"
                                                                            ? "QUESTIONS_WITH_ANSWER_KEY"
                                                                            : "QUESTIONS_ONLY",
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        Answer Key
                                                    </ChipButton>
                                                    <ChipButton
                                                        active={
                                                            form.output.contentMode ===
                                                            "QUESTIONS_ANSWER_KEY_SOLUTION"
                                                        }
                                                        onClick={() =>
                                                            setForm((prev) => ({
                                                                ...prev,
                                                                output: {
                                                                    ...prev.output,
                                                                    contentMode:
                                                                        prev.output.contentMode ===
                                                                            "QUESTIONS_ANSWER_KEY_SOLUTION"
                                                                            ? "QUESTIONS_WITH_ANSWER_KEY"
                                                                            : "QUESTIONS_ANSWER_KEY_SOLUTION",
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        Solution
                                                    </ChipButton>
                                                </div>
                                            </div>

                                            {form.output.contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" &&
                                                form.output.deliveryMode === "PAPER_WISE" && (
                                                <div style={{ display: "grid", gap: "8px" }}>
                                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                                        Show Answer Key before Solution
                                                    </span>
                                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                        <ChipButton
                                                            active={form.output.showAnswerKeyBeforeSolution}
                                                            onClick={() =>
                                                                setForm((prev) => ({
                                                                    ...prev,
                                                                    output: {
                                                                        ...prev.output,
                                                                        showAnswerKeyBeforeSolution: true,
                                                                    },
                                                                }))
                                                            }
                                                        >
                                                            Yes
                                                        </ChipButton>
                                                        <ChipButton
                                                            active={!form.output.showAnswerKeyBeforeSolution}
                                                            onClick={() =>
                                                                setForm((prev) => ({
                                                                    ...prev,
                                                                    output: {
                                                                        ...prev.output,
                                                                        showAnswerKeyBeforeSolution: false,
                                                                    },
                                                                }))
                                                            }
                                                        >
                                                            No
                                                        </ChipButton>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </Section>

                                <Section>
                                    <div style={{ display: "grid", gap: "12px" }}>
                                        <div style={{ display: "grid", gap: "8px" }}>
                                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Select Fields (Optional)</span>
                                            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                                {METADATA_FIELDS.map((field) => (
                                                    <ChipButton key={field} active={form.output.metadataFields.includes(field)} onClick={() => toggleMetadataField(field)}>{field}</ChipButton>
                                                ))}
                                            </div>
                                            {form.output.metadataFields.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={clearAllMetadataFields}
                                                    style={{
                                                        width: "fit-content",
                                                        padding: "6px 10px",
                                                        borderRadius: "8px",
                                                        border: "1px solid var(--border-primary)",
                                                        background: "var(--bg-tertiary)",
                                                        color: "var(--text-secondary)",
                                                        fontSize: "0.75rem",
                                                        cursor: "pointer",
                                                    }}
                                                >
                                                    Clear Selection
                                                </button>
                                            )}
                                            <span style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                                {form.output.metadataFields.length > 0
                                                    ? `${form.output.metadataFields.length} field(s) selected`
                                                    : "No fields selected"}
                                            </span>
                                        </div>

                                        <label style={{ display: "grid", gap: "6px" }}>
                                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                                <span style={{ fontSize: "0.79rem", fontWeight: 600 }}>Instructions before Test</span>
                                                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                                    {Object.entries({ JEE_MAINS: "JEE Mains", NEET: "NEET", JEE_ADVANCE: "JEE Adv", CUSTOMISED_TEST: "Custom" }).map(([key, label]) => (
                                                        <button
                                                            key={key}
                                                            type="button"
                                                            onClick={() => setForm((prev) => ({ ...prev, output: { ...prev.output, instructions: INSTRUCTION_TEMPLATES[key] || "" } }))}
                                                            style={{
                                                                padding: "3px 8px",
                                                                borderRadius: "6px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: form.examType === key ? "var(--accent-glow)" : "var(--bg-elevated)",
                                                                color: form.examType === key ? "var(--accent-primary)" : "var(--text-secondary)",
                                                                fontSize: "0.68rem",
                                                                fontWeight: 600,
                                                                cursor: "pointer",
                                                            }}
                                                        >
                                                            {label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                            <textarea value={form.output.instructions} onChange={(e) => setForm((prev) => ({ ...prev, output: { ...prev.output, instructions: e.target.value } }))} placeholder="Example: Use black ball pen only. No calculators allowed. Read all instructions carefully..." rows={5} style={{ width: "100%", padding: "10px 12px", borderRadius: "9px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", resize: "vertical" }} />
                                            <button
                                                type="button"
                                                onClick={() => setAppliedInstructions(form.output.instructions)}
                                                style={{
                                                    width: "fit-content",
                                                    padding: "7px 12px",
                                                    borderRadius: "8px",
                                                    border: "1px solid var(--accent-primary)",
                                                    background: "var(--accent-glow)",
                                                    color: "var(--accent-primary-hover)",
                                                    fontSize: "0.76rem",
                                                    fontWeight: 650,
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Update
                                            </button>
                                        </label>
                                    </div>
                                </Section>

                                {hasVerificationReport && (
                                    <div
                                        ref={verifyReportRef}
                                        style={{
                                            scrollMarginTop: "80px",
                                            borderRadius: "13px",
                                            transition: "box-shadow 0.4s ease",
                                            boxShadow: verifyReportFlash
                                                ? "0 0 0 3px rgba(var(--accent-success-rgb), 0.55)"
                                                : "0 0 0 0 rgba(var(--accent-success-rgb), 0)",
                                        }}
                                    >
                                    <Section
                                        title="AI Verification Report"
                                        subtitle="Paper-level QC findings for the current saved test."
                                    >
                                        <div style={{ display: "grid", gap: "12px" }}>
                                            {selectedResults.map((test) => {
                                                const report = verificationReportsByTestNumber[test.testNumber];
                                                if (!report) return null;

                                                return (
                                                    <div
                                                        key={`verify-report-${test.testNumber}`}
                                                        style={{
                                                            display: "grid",
                                                            gap: "10px",
                                                            border: "1px solid rgba(var(--accent-success-rgb), 0.22)",
                                                            borderRadius: "10px",
                                                            background: "rgba(var(--accent-success-rgb), 0.05)",
                                                            padding: "12px",
                                                        }}
                                                    >
                                                        <div
                                                            style={{
                                                                display: "flex",
                                                                justifyContent: "space-between",
                                                                gap: "10px",
                                                                flexWrap: "wrap",
                                                                alignItems: "center",
                                                            }}
                                                        >
                                                            <div style={{ display: "grid", gap: "3px" }}>
                                                                <div style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                                                                    Test {test.testNumber} verified with {report.modelLabel}
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.74rem",
                                                                        color: "var(--text-tertiary)",
                                                                    }}
                                                                >
                                                                    {API_KEY_PROVIDER_LABELS[report.provider as SupportedApiProvider] || report.provider} • {formatHistoryDate(report.verifiedAt)}
                                                                </div>
                                                            </div>
                                                            <div
                                                                style={{
                                                                    display: "flex",
                                                                    gap: "8px",
                                                                    flexWrap: "wrap",
                                                                }}
                                                            >
                                                                <span
                                                                    style={{
                                                                        fontSize: "0.74rem",
                                                                        padding: "4px 8px",
                                                                        borderRadius: "999px",
                                                                        background: "rgba(var(--accent-success-rgb), 0.12)",
                                                                        color: "var(--accent-success)",
                                                                    }}
                                                                >
                                                                    {report.aiVerifiedCount}/{report.totalQuestions} AI verified
                                                                </span>
                                                                <span
                                                                    style={{
                                                                        fontSize: "0.74rem",
                                                                        padding: "4px 8px",
                                                                        borderRadius: "999px",
                                                                        background: "rgba(239, 68, 68, 0.1)",
                                                                        color: "var(--accent-danger)",
                                                                    }}
                                                                >
                                                                    {report.incorrectAnswerKeyCount} incorrect
                                                                </span>
                                                                <span
                                                                    style={{
                                                                        fontSize: "0.74rem",
                                                                        padding: "4px 8px",
                                                                        borderRadius: "999px",
                                                                        background: "rgba(245, 158, 11, 0.1)",
                                                                        color: "var(--accent-warning)",
                                                                    }}
                                                                >
                                                                    {report.outOfSyllabusCount} out of syllabus
                                                                </span>
                                                            </div>
                                                        </div>

                                                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                                            {report.overallSummary}
                                                        </div>

                                                        <div
                                                            style={{
                                                                display: "grid",
                                                                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                                                                gap: "10px",
                                                            }}
                                                        >
                                                            <div
                                                                style={{
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: "8px",
                                                                    background: "var(--bg-secondary)",
                                                                    padding: "10px",
                                                                    display: "grid",
                                                                    gap: "6px",
                                                                }}
                                                            >
                                                                <div style={{ fontSize: "0.76rem", fontWeight: 700 }}>
                                                                    Structure
                                                                </div>
                                                                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                                                                    {report.paperStructureAssessment}
                                                                </div>
                                                            </div>
                                                            <div
                                                                style={{
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: "8px",
                                                                    background: "var(--bg-secondary)",
                                                                    padding: "10px",
                                                                    display: "grid",
                                                                    gap: "6px",
                                                                }}
                                                            >
                                                                <div style={{ fontSize: "0.76rem", fontWeight: 700 }}>
                                                                    Syllabus Balance
                                                                </div>
                                                                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                                                                    {report.syllabusBalanceAssessment}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {report.topRecommendations.length > 0 && (
                                                            <div style={{ display: "grid", gap: "6px" }}>
                                                                <div style={{ fontSize: "0.76rem", fontWeight: 700 }}>
                                                                    Top Recommendations
                                                                </div>
                                                                <div style={{ display: "grid", gap: "4px" }}>
                                                                    {report.topRecommendations.slice(0, 5).map((item, index) => (
                                                                        <div
                                                                            key={`${test.testNumber}-recommendation-${index}`}
                                                                            style={{
                                                                                fontSize: "0.75rem",
                                                                                color: "var(--text-secondary)",
                                                                            }}
                                                                        >
                                                                            • {item}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {report.wrongQuestions.length > 0 && (
                                                            <div style={{ display: "grid", gap: "6px" }}>
                                                                <div style={{ fontSize: "0.76rem", fontWeight: 700 }}>
                                                                    Flagged Questions
                                                                </div>
                                                                <div style={{ display: "grid", gap: "6px" }}>
                                                                    {report.wrongQuestions.slice(0, 8).map((item) => (
                                                                        <div
                                                                            key={`${test.testNumber}-wrong-${item.questionId}`}
                                                                            style={{
                                                                                border: "1px solid var(--border-primary)",
                                                                                borderRadius: "8px",
                                                                                background: "var(--bg-secondary)",
                                                                                padding: "8px 10px",
                                                                                display: "grid",
                                                                                gap: "4px",
                                                                            }}
                                                                        >
                                                                            <div style={{ fontSize: "0.76rem", fontWeight: 700 }}>
                                                                                Q{item.displayNumber}
                                                                            </div>
                                                                            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                                                                                {item.summary}
                                                                            </div>
                                                                            <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                                                                {item.suggestion}
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </Section>
                                    </div>
                                )}

                                {showFinalOutputPreview && (
                                    <Section
                                        title="Final Test Format Preview"
                                        subtitle="This mirrors the final test layout before PDF/Word export."
                                    >
                                        <div style={{ display: "grid", gap: "12px", overflowX: "visible" }}>
                                            {selectedResults.map((test) => {
                                                const paperGroups = getPaperGroups(test);
                                                const hasPaperGroups = paperGroups.length > 0;

                                                return (
                                                    <div
                                                        key={`final-preview-${test.testNumber}`}
                                                        style={{
                                                            border: "1px solid var(--border-secondary)",
                                                            borderRadius: "10px",
                                                            background: "var(--bg-secondary)",
                                                            padding: form.output.twoColumnFormat ? "5mm" : "10px",
                                                            display: "grid",
                                                            gap: "10px",
                                                            overflowX: "visible",
                                                        }}
                                                        className={form.output.twoColumnFormat ? "a4-preview-sheet" : ""}
                                                    >
                                                        <div className="no-column-break">
                                                            <div
                                                                style={{
                                                                    display: "flex",
                                                                    justifyContent: "space-between",
                                                                    alignItems: "center",
                                                                    gap: "8px",
                                                                    flexWrap: "wrap",
                                                                }}
                                                            >
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.92rem",
                                                                        fontWeight: 700,
                                                                        color: "var(--text-primary)",
                                                                    }}
                                                                >
                                                                    {test.batchName} • Test {test.testNumber}
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.76rem",
                                                                        color: "var(--text-tertiary)",
                                                                    }}
                                                                >
                                                                    {test.totalQuestions} selected question(s)
                                                                </div>
                                                            </div>

                                                            <div
                                                                style={{
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: "9px",
                                                                    padding: "10px",
                                                                    background: "var(--bg-secondary)",
                                                                    display: "grid",
                                                                    gap: "6px",
                                                                    marginTop: "10px",
                                                                    marginBottom: "10px"
                                                                }}
                                                            >
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.78rem",
                                                                        fontWeight: 700,
                                                                        color: "var(--text-primary)",
                                                                    }}
                                                                >
                                                                    Instructions Before Test
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.82rem",
                                                                        color: "var(--text-secondary)",
                                                                        whiteSpace: "pre-wrap",
                                                                    }}
                                                                >
                                                                    {appliedInstructions.trim().length > 0
                                                                        ? appliedInstructions
                                                                        : "No additional instructions provided."}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {form.output.deliveryMode === "QUESTION_WISE" ? (
                                                            <div style={{ display: "grid", gap: "8px" }}>
                                                                {renderQuestionWiseOutputBlock(
                                                                    test,
                                                                    `questionwise-${test.testNumber}`
                                                                )}
                                                            </div>
                                                        ) : hasPaperGroups ? (
                                                            <div style={{ display: "grid", gap: "12px" }}>
                                                                {paperGroups.map((paperGroup) => {
                                                                    const paperItems: FinalPreviewQuestionItem[] = [];
                                                                    paperGroup.sections.forEach((section) => {
                                                                        section.questionTypes.forEach((group) => {
                                                                            group.questions.forEach((question) => {
                                                                                paperItems.push({
                                                                                    question,
                                                                                    subject: section.subject,
                                                                                    paper: paperGroup.paper,
                                                                                    typeLabel: group.typeLabel,
                                                                                });
                                                                            });
                                                                        });
                                                                    });

                                                                    return renderPaperWiseOutputBlock(
                                                                        paperGroup.paper,
                                                                        paperItems,
                                                                        `paperwise-${test.testNumber}-${paperGroup.paper}`
                                                                    );
                                                                })}
                                                            </div>
                                                        ) : (
                                                            <div style={{ display: "grid", gap: "10px" }}>
                                                                {renderPaperWiseOutputBlock(
                                                                    null,
                                                                    collectPreviewQuestionItems(test),
                                                                    `paperwise-none-${test.testNumber}`
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </Section>
                                )}

                                {error && (
                                    <div style={{ padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(var(--accent-danger-rgb), 0.3)", background: "rgba(var(--accent-danger-rgb), 0.08)", color: "var(--accent-danger)", fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "8px" }}>
                                        <AlertCircle size={14} />
                                        {error}
                                    </div>
                                )}

                            </>
                        )}

                        {activeTab === "results" && (
                            <>
                                <Section title="Generation Output">
                                    {results.length === 0 ? (
                                        <div style={{ fontSize: "0.82rem", color: "var(--text-tertiary)", padding: "6px 0" }}>
                                            No tests generated yet. Open <strong>Create Test</strong> tab and run generation.
                                        </div>
                                    ) : (
                                        <div style={{ display: "grid", gap: "8px" }}>
                                            {results.map((test) => {
                                                let overallQuestionNumber = 0;
                                                const showPerTestAnalysis = true;
                                                const analysis = buildPerTestAnalysis(test);
                                                const difficultyEntries = Object.entries(
                                                    analysis.difficultyCounts
                                                ).sort((a, b) => b[1] - a[1]);
                                                const sourceEntries = Object.entries(
                                                    analysis.sourceCounts
                                                )
                                                    .sort((a, b) => b[1] - a[1])
                                                    .slice(0, 6);
                                                const classEntries = (
                                                    [
                                                        ["11", analysis.classCounts["11"] || 0],
                                                        ["12", analysis.classCounts["12"] || 0],
                                                        ["Other", analysis.classCounts["Other"] || 0],
                                                    ] as Array<[string, number]>
                                                ).filter(([, value]) => value > 0);
                                                const subjectChapterEntries = Object.entries(
                                                    analysis.chapterCountsBySubject
                                                ).sort(
                                                    (a, b) =>
                                                        subjectOrderValue(a[0]) - subjectOrderValue(b[0])
                                                );

                                                return (
                                                <div key={test.testNumber} style={{ border: "1px solid var(--border-secondary)", borderRadius: "10px", padding: "10px 12px", background: "var(--bg-tertiary)" }}>
                                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
                                                        <div>
                                                            <div style={{ fontSize: "0.9rem", fontWeight: 700 }}>{test.batchName} - Test {test.testNumber}</div>
                                                            <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                                                                {EXAM_TYPE_LABELS[form.examType]} • {countSelectedQuestionsForTest(test, excludedQuestionKeySet)} selected / {test.totalQuestions} generated
                                                            </div>
                                                        </div>
                                                        <CheckCircle2 size={16} color="var(--accent-success)" />
                                                    </div>

                                                    {showPerTestAnalysis && (
                                                        <div
                                                            style={{
                                                                border: "1px solid var(--border-primary)",
                                                                borderRadius: "9px",
                                                                background: "var(--bg-secondary)",
                                                                padding: "8px",
                                                                marginBottom: "8px",
                                                                display: "grid",
                                                                gap: "8px",
                                                            }}
                                                        >
                                                            <div
                                                                style={{
                                                                    fontSize: "0.76rem",
                                                                    color: "var(--text-tertiary)",
                                                                }}
                                                            >
                                                                Analysis (selected questions: {analysis.total})
                                                            </div>

                                                            <div
                                                                style={{
                                                                    display: "grid",
                                                                    gridTemplateColumns:
                                                                        "repeat(auto-fit, minmax(180px, 1fr))",
                                                                    gap: "8px",
                                                                }}
                                                            >
                                                                {renderMiniMetricBars(
                                                                    "Difficulty",
                                                                    difficultyEntries,
                                                                    "linear-gradient(90deg, #22c55e, #16a34a)"
                                                                )}
                                                                {renderMiniMetricBars(
                                                                    "Source",
                                                                    sourceEntries,
                                                                    "linear-gradient(90deg, #3b82f6, #2563eb)"
                                                                )}
                                                                {renderMiniMetricBars(
                                                                    "Class",
                                                                    classEntries,
                                                                    "linear-gradient(90deg, #f59e0b, #d97706)"
                                                                )}
                                                            </div>

                                                            <div
                                                                style={{
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: "8px",
                                                                    padding: "8px",
                                                                    display: "grid",
                                                                    gap: "6px",
                                                                }}
                                                            >
                                                                <div
                                                                    style={{
                                                                        fontSize: "0.74rem",
                                                                        color: "var(--text-tertiary)",
                                                                        fontWeight: 600,
                                                                    }}
                                                                >
                                                                    Chapters by Subject
                                                                </div>
                                                                {subjectChapterEntries.map(
                                                                    ([subject, chapters]) => {
                                                                        const subjectTotal = Object.values(
                                                                            chapters
                                                                        ).reduce(
                                                                            (sum, count) => sum + count,
                                                                            0
                                                                        );
                                                                        const toggleKey = `${test.testNumber}:${subject}`;
                                                                        const isExpanded =
                                                                            expandedTestAnalysisKeys.includes(
                                                                                toggleKey
                                                                            );
                                                                        const chapterRows =
                                                                            Object.entries(chapters).sort(
                                                                                (a, b) =>
                                                                                    compareChaptersBySubject(
                                                                                        subject,
                                                                                        a[0],
                                                                                        b[0]
                                                                                    )
                                                                            );

                                                                        return (
                                                                            <div
                                                                                key={toggleKey}
                                                                                style={{
                                                                                    border: "1px solid var(--border-secondary)",
                                                                                    borderRadius: "7px",
                                                                                    overflow: "hidden",
                                                                                }}
                                                                            >
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() =>
                                                                                        toggleTestAnalysisKey(
                                                                                            toggleKey
                                                                                        )
                                                                                    }
                                                                                    style={{
                                                                                        width: "100%",
                                                                                        border: "none",
                                                                                        background:
                                                                                            "var(--bg-tertiary)",
                                                                                        color: "var(--text-secondary)",
                                                                                        padding: "6px 8px",
                                                                                        fontSize: "0.73rem",
                                                                                        display: "flex",
                                                                                        justifyContent:
                                                                                            "space-between",
                                                                                        cursor: "pointer",
                                                                                    }}
                                                                                >
                                                                                    <span>{subject}</span>
                                                                                    <span>
                                                                                        {subjectTotal} questions
                                                                                    </span>
                                                                                </button>

                                                                                {isExpanded && (
                                                                                    <div
                                                                                        style={{
                                                                                            padding: "6px 8px",
                                                                                            maxHeight: "140px",
                                                                                            overflowY: "auto",
                                                                                            display: "grid",
                                                                                            gap: "4px",
                                                                                            background:
                                                                                                "var(--bg-secondary)",
                                                                                        }}
                                                                                    >
                                                                                        {chapterRows.map(
                                                                                            ([
                                                                                                chapter,
                                                                                                count,
                                                                                            ]) => (
                                                                                                <div
                                                                                                    key={`${toggleKey}:${chapter}`}
                                                                                                    style={{
                                                                                                        display:
                                                                                                            "flex",
                                                                                                        justifyContent:
                                                                                                            "space-between",
                                                                                                        gap: "8px",
                                                                                                        fontSize:
                                                                                                            "0.72rem",
                                                                                                        color: "var(--text-secondary)",
                                                                                                    }}
                                                                                                >
                                                                                                    <span>
                                                                                                        {chapter}
                                                                                                    </span>
                                                                                                    <span>
                                                                                                        {count}
                                                                                                    </span>
                                                                                                </div>
                                                                                            )
                                                                                        )}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    }
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}

                                                    <div style={{ display: "grid", gap: "6px" }}>
                                                        {getPaperGroups(test).length > 0 ? (
                                                            getPaperGroups(test).map((paperGroup) => {
                                                                let paperQuestionNumber = 0;

                                                                return (
                                                                <div key={`${test.testNumber}-${paperGroup.paper}`} style={{ border: "1px solid var(--border-primary)", borderRadius: "8px", padding: "6px 8px", display: "grid", gap: "8px", background: "var(--bg-secondary)" }}>
                                                                    <div style={{ fontSize: "0.88rem", fontWeight: 700, color: "var(--text-secondary)" }}>
                                                                        {paperGroup.paper}
                                                                    </div>
                                                                    <div style={{ display: "grid", gap: "10px" }}>
                                                                        {paperGroup.sections.map((section) => (
                                                                        <div key={`${paperGroup.paper}-${section.subject}`} style={{ border: "1px solid var(--border-secondary)", borderRadius: "8px", padding: "6px 8px", display: "grid", gap: "6px", background: "var(--bg-secondary)" }}>
                                                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.92rem" }}>
                                                                                <span style={{ fontWeight: 800, fontSize: "1.05rem", width: "100%", textAlign: "center" }}>{section.subject}</span>
                                                                                <span style={{ color: "var(--text-tertiary)" }}>{section.totalQuestions}</span>
                                                                            </div>
                                                                            {section.questionTypes.map((group) => (
                                                                                <div key={`${paperGroup.paper}-${section.subject}-${group.type}`} style={{ display: "grid", gap: "4px" }}>
                                                                                    <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                                                        {group.typeLabel} ({group.questions.length})
                                                                                    </div>
                                                                                    {group.questions.map((question, index) => (
                                                                                        <div key={`${question.question_id}-${index}`} style={{ display: "grid", gap: "4px" }}>
                                                                                            {(questionUsageById[question.question_id] || []).length > 0 && (
                                                                                                <div
                                                                                                    style={{
                                                                                                        fontSize: "0.72rem",
                                                                                                        color: "var(--accent-warning)",
                                                                                                        background: "rgba(var(--accent-warning-rgb), 0.08)",
                                                                                                        border: "1px solid rgba(var(--accent-warning-rgb), 0.25)",
                                                                                                        borderRadius: "6px",
                                                                                                        padding: "4px 8px",
                                                                                                        width: "fit-content",
                                                                                                    }}
                                                                                                >
                                                                                                    Previously used in: {formatQuestionUsageLabel(questionUsageById[question.question_id] || [])}
                                                                                                </div>
                                                                                            )}
                                                                                            <QuestionCard
                                                                                                question={question}
                                                                                                index={index}
                                                                                                displayNumber={++paperQuestionNumber}
                                                                                                expandForDetailsOnly
                                                                                                hideExamBadges
                                                                                                leadingControl={renderQuestionControls(
                                                                                                    test.testNumber,
                                                                                                    question
                                                                                                )}
                                                                                            />
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    ))}
                                                                    </div>
                                                                </div>
                                                            )})
                                                        ) : (
                                                            <div style={{ display: "grid", gap: "10px" }}>
                                                            {sortSectionsBySubject(test.sections).map((section) => (
                                                                <div key={section.subject} style={{ border: "1px solid var(--border-secondary)", borderRadius: "8px", padding: "6px 8px", display: "grid", gap: "6px", background: "var(--bg-secondary)" }}>
                                                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.92rem" }}>
                                                                        <span style={{ fontWeight: 800, fontSize: "1.05rem", width: "100%", textAlign: "center" }}>{section.subject}</span>
                                                                        <span style={{ color: "var(--text-tertiary)" }}>{section.totalQuestions}</span>
                                                                    </div>
                                                                    {section.questionTypes.map((group) => (
                                                                        <div key={`${section.subject}-${group.type}`} style={{ display: "grid", gap: "4px" }}>
                                                                            <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                                                {group.typeLabel} ({group.questions.length})
                                                                            </div>
                                                                            {group.questions.map((question, index) => (
                                                                                <div key={`${question.question_id}-${index}`} style={{ display: "grid", gap: "4px" }}>
                                                                                    {(questionUsageById[question.question_id] || []).length > 0 && (
                                                                                        <div
                                                                                            style={{
                                                                                                fontSize: "0.72rem",
                                                                                                color: "var(--accent-warning)",
                                                                                                background: "rgba(var(--accent-warning-rgb), 0.08)",
                                                                                                border: "1px solid rgba(var(--accent-warning-rgb), 0.25)",
                                                                                                borderRadius: "6px",
                                                                                                padding: "4px 8px",
                                                                                                width: "fit-content",
                                                                                            }}
                                                                                        >
                                                                                            Previously used in: {formatQuestionUsageLabel(questionUsageById[question.question_id] || [])}
                                                                                        </div>
                                                                                    )}
                                                                                    <QuestionCard
                                                                                        question={question}
                                                                                        index={index}
                                                                                        displayNumber={++overallQuestionNumber}
                                                                                        expandForDetailsOnly
                                                                                        hideExamBadges
                                                                                        leadingControl={renderQuestionControls(
                                                                                            test.testNumber,
                                                                                            question
                                                                                        )}
                                                                                    />
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            ))
                                                            }
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )})}
                                        </div>
                                    )}
                                </Section>

                                {warnings.length > 0 && (
                                    <div style={{ padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.08)", color: "#fbbf24", fontSize: "0.78rem" }}>
                                        {warnings.map((warning, index) => (
                                            <div key={index} style={{ marginBottom: index === warnings.length - 1 ? 0 : 4 }}>
                                                • {warning}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </main>

            {showAiTranslateDialog && (
                <div
                    role="dialog"
                    aria-modal="true"
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(15, 23, 42, 0.56)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "20px",
                        zIndex: 70,
                    }}
                >
                    <div
                        style={{
                            width: "min(760px, 100%)",
                            maxHeight: "90vh",
                            overflow: "auto",
                            borderRadius: "14px",
                            border: "1px solid var(--border-primary)",
                            background: "var(--bg-elevated)",
                            boxShadow: "var(--shadow-xl)",
                            padding: "18px",
                            display: "grid",
                            gap: "14px",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                            <div style={{ display: "grid", gap: "4px" }}>
                                <div style={{ fontSize: "1rem", fontWeight: 700 }}>
                                    Language Translate Using AI
                                </div>
                                <div style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
                                    Translate the already generated selected test. Existing output settings are reused for PDF and Word export.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    if (translatingTestWithAi) return;
                                    setShowAiTranslateDialog(false);
                                }}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    padding: "6px 10px",
                                    cursor: translatingTestWithAi ? "default" : "pointer",
                                    opacity: translatingTestWithAi ? 0.6 : 1,
                                }}
                            >
                                Close
                            </button>
                        </div>

                        <div
                            style={{
                                border: "1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.24)",
                                borderRadius: "12px",
                                padding: "12px",
                                background: "rgba(var(--accent-primary-rgb, 99, 102, 241), 0.06)",
                                display: "grid",
                                gap: "10px",
                            }}
                        >
                            <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-secondary)" }}>
                                Choose AI Provider, Model, and Language
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
                                <select
                                    value={aiTranslateProvider}
                                    onChange={(event) => {
                                        const provider = event.target.value as AITestProvider;
                                        setAiTranslateProvider(provider);
                                        const models = aiVerifyModelOptionsByProvider[provider] || [];
                                        if (models.length > 0) setAiTranslateModelId(models[0].id);
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                    }}
                                >
                                    {CHAT_API_PROVIDERS.map((provider) => (
                                        <option key={provider} value={provider}>
                                            {API_KEY_PROVIDER_LABELS[provider]}
                                        </option>
                                    ))}
                                </select>

                                <select
                                    value={isCurrentTranslateModelListed ? normalizedAiTranslateModelId : ""}
                                    onChange={(event) => setAiTranslateModelId(event.target.value)}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                    }}
                                >
                                    <option value="" disabled>
                                        {fetchingVerifyModelsProvider === aiTranslateProvider ? "Loading models..." : "Select model"}
                                    </option>
                                    {currentTranslateModelOptions.map((model) => (
                                        <option key={model.id} value={model.id}>
                                            {model.label}
                                        </option>
                                    ))}
                                </select>

                                <input
                                    value={aiTranslateLanguage}
                                    onChange={(event) => setAiTranslateLanguage(event.target.value)}
                                    placeholder="Hindi"
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                    }}
                                />
                            </div>

                            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                <input
                                    value={aiTranslateModelId}
                                    onChange={(event) => setAiTranslateModelId(event.target.value)}
                                    placeholder="Custom model id"
                                    style={{
                                        flex: 1,
                                        minWidth: "240px",
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => void refreshVerifyModels(aiTranslateProvider)}
                                    disabled={fetchingVerifyModelsProvider === aiTranslateProvider}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        padding: "8px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        cursor: fetchingVerifyModelsProvider === aiTranslateProvider ? "default" : "pointer",
                                        opacity: fetchingVerifyModelsProvider === aiTranslateProvider ? 0.6 : 1,
                                    }}
                                    title="Refresh models"
                                >
                                    {fetchingVerifyModelsProvider === aiTranslateProvider ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <RefreshCw size={14} />
                                    )}
                                </button>
                            </div>

                            <label style={{ display: "grid", gap: "6px" }}>
                                <span style={{ fontSize: "0.76rem", color: "var(--text-tertiary)", fontWeight: 600 }}>
                                    Prompt
                                </span>
                                <textarea
                                    value={aiTranslatePrompt}
                                    onChange={(event) => setAiTranslatePrompt(event.target.value)}
                                    rows={6}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                        resize: "vertical",
                                    }}
                                />
                            </label>

                            {!hasSelectedTranslateProviderKey && aiTranslateProvider !== "local" && (
                                <div style={{ fontSize: "0.75rem", color: "var(--accent-danger)" }}>
                                    Save {API_KEY_PROVIDER_LABELS[aiTranslateProvider]} API key from the user menu before translating.
                                </div>
                            )}

                            {aiTranslateError && (
                                <div style={{ fontSize: "0.75rem", color: "var(--accent-warning)" }}>
                                    {aiTranslateError}
                                </div>
                            )}
                        </div>

                        {translatedResults?.length ? (
                            <div
                                style={{
                                    padding: "12px",
                                    borderRadius: "12px",
                                    border: "1px solid var(--border-primary)",
                                    background: "var(--bg-secondary)",
                                    display: "grid",
                                    gap: "8px",
                                }}
                            >
                                <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>
                                    Translated test ready: {translatedResultLanguage || aiTranslateLanguage}
                                </div>
                                {translatedResultNotes && (
                                    <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                        {translatedResultNotes}
                                    </div>
                                )}
                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    <button
                                        type="button"
                                        onClick={handleDownloadTranslatedPDF}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            padding: "8px 12px",
                                            fontWeight: 700,
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Download size={14} />
                                        Download PDF
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleDownloadTranslatedDocx}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-tertiary)",
                                            color: "var(--text-primary)",
                                            padding: "8px 12px",
                                            fontWeight: 700,
                                            cursor: "pointer",
                                        }}
                                    >
                                        <Download size={14} />
                                        Download Word
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                            <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                {selectedResults.length} test(s), {totalSelectedQuestions} selected question(s)
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (translatingTestWithAi) return;
                                        setShowAiTranslateDialog(false);
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        padding: "8px 12px",
                                        cursor: translatingTestWithAi ? "default" : "pointer",
                                        opacity: translatingTestWithAi ? 0.6 : 1,
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleTranslateTestUsingAi()}
                                    disabled={translatingTestWithAi || !normalizedAiTranslateModelId}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        border: "1px solid var(--accent-primary)",
                                        borderRadius: "8px",
                                        background: "var(--accent-glow)",
                                        color: "var(--accent-primary-hover)",
                                        padding: "8px 14px",
                                        fontWeight: 700,
                                        cursor: translatingTestWithAi || !normalizedAiTranslateModelId ? "default" : "pointer",
                                        opacity: translatingTestWithAi || !normalizedAiTranslateModelId ? 0.6 : 1,
                                    }}
                                >
                                    {translatingTestWithAi ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />}
                                    {translatingTestWithAi ? "Translating..." : "Run Translation"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showAiVerifyDialog && (
                <div
                    role="dialog"
                    aria-modal="true"
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(15, 23, 42, 0.56)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "20px",
                        zIndex: 80,
                    }}
                >
                    <div
                        style={{
                            width: "min(720px, 100%)",
                            borderRadius: "16px",
                            border: "1px solid var(--border-primary)",
                            background: "var(--bg-elevated)",
                            boxShadow: "0 32px 80px rgba(15, 23, 42, 0.28)",
                            display: "grid",
                            gap: "14px",
                            padding: "18px",
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: "12px",
                                alignItems: "flex-start",
                            }}
                        >
                            <div style={{ display: "grid", gap: "4px" }}>
                                <div style={{ fontSize: "1rem", fontWeight: 700 }}>
                                    Verify Test Using AI
                                </div>
                                <div style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
                                    This will solve every selected question, update AI verification data on each question, and save a full paper report on the same test record.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    if (verifyingTestWithAi) return;
                                    setShowAiVerifyDialog(false);
                                }}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    padding: "6px 10px",
                                    cursor: verifyingTestWithAi ? "default" : "pointer",
                                    opacity: verifyingTestWithAi ? 0.6 : 1,
                                }}
                            >
                                Close
                            </button>
                        </div>

                        <div
                            style={{
                                border: "1px solid rgba(var(--accent-success-rgb), 0.2)",
                                borderRadius: "12px",
                                padding: "12px",
                                background: "rgba(var(--accent-success-rgb), 0.05)",
                                display: "grid",
                                gap: "10px",
                            }}
                        >
                            <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-secondary)" }}>
                                Choose AI Provider and Model
                            </div>
                            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                <select
                                    value={aiVerifyProvider}
                                    onChange={(event) => {
                                        const provider = event.target.value as AITestProvider;
                                        setAiVerifyProvider(provider);
                                        const models = aiVerifyModelOptionsByProvider[provider] || [];
                                        if (models.length > 0) {
                                            setAiVerifyModelId(models[0].id);
                                        }
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                        minWidth: "150px",
                                    }}
                                >
                                    {CHAT_API_PROVIDERS.map((provider) => (
                                        <option key={provider} value={provider}>
                                            {API_KEY_PROVIDER_LABELS[provider]}
                                        </option>
                                    ))}
                                </select>

                                <select
                                    value={isCurrentVerifyModelListed ? normalizedAiVerifyModelId : ""}
                                    onChange={(event) => setAiVerifyModelId(event.target.value)}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                        minWidth: "240px",
                                        flex: 1,
                                    }}
                                >
                                    <option value="" disabled>
                                        {fetchingVerifyModelsProvider === aiVerifyProvider ? "Loading models..." : "Select model"}
                                    </option>
                                    {currentVerifyModelOptions.map((model) => (
                                        <option key={model.id} value={model.id}>
                                            {model.label}
                                        </option>
                                    ))}
                                </select>

                                <button
                                    type="button"
                                    onClick={() => {
                                        void refreshVerifyModels(aiVerifyProvider);
                                    }}
                                    disabled={fetchingVerifyModelsProvider === aiVerifyProvider}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        padding: "8px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        cursor:
                                            fetchingVerifyModelsProvider === aiVerifyProvider
                                                ? "default"
                                                : "pointer",
                                        opacity:
                                            fetchingVerifyModelsProvider === aiVerifyProvider ? 0.6 : 1,
                                    }}
                                    title="Refresh models"
                                >
                                    {fetchingVerifyModelsProvider === aiVerifyProvider ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <RefreshCw size={14} />
                                    )}
                                </button>
                            </div>

                            <label style={{ display: "grid", gap: "6px" }}>
                                <span style={{ fontSize: "0.76rem", color: "var(--text-tertiary)", fontWeight: 600 }}>
                                    Custom Model Name
                                </span>
                                <input
                                    value={aiVerifyModelId}
                                    onChange={(event) => setAiVerifyModelId(event.target.value)}
                                    placeholder="Enter exact model id (optional)"
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.78rem",
                                        padding: "8px 10px",
                                    }}
                                />
                            </label>

                            {!hasSelectedVerifyProviderKey && (
                                <div style={{ fontSize: "0.75rem", color: "var(--accent-danger)" }}>
                                    Save {API_KEY_PROVIDER_LABELS[aiVerifyProvider]} API key from the user menu before verifying.
                                </div>
                            )}

                            {aiVerifyError && (
                                <div style={{ fontSize: "0.75rem", color: "var(--accent-warning)" }}>
                                    {aiVerifyError}
                                </div>
                            )}
                        </div>

                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "10px",
                                flexWrap: "wrap",
                            }}
                        >
                            <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                {selectedResults.length} test(s), {totalSelectedQuestions} selected question(s)
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (verifyingTestWithAi) return;
                                        setShowAiVerifyDialog(false);
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        padding: "8px 12px",
                                        cursor: verifyingTestWithAi ? "default" : "pointer",
                                        opacity: verifyingTestWithAi ? 0.6 : 1,
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void handleVerifyTestUsingAi();
                                    }}
                                    disabled={verifyingTestWithAi || !normalizedAiVerifyModelId}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        border: "1px solid rgba(var(--accent-success-rgb), 0.45)",
                                        borderRadius: "8px",
                                        background: "linear-gradient(135deg, rgba(var(--accent-success-rgb), 0.18), rgba(var(--accent-success-rgb), 0.1))",
                                        color: "var(--accent-success)",
                                        padding: "8px 14px",
                                        fontWeight: 700,
                                        cursor:
                                            verifyingTestWithAi || !normalizedAiVerifyModelId
                                                ? "default"
                                                : "pointer",
                                        opacity:
                                            verifyingTestWithAi || !normalizedAiVerifyModelId ? 0.6 : 1,
                                    }}
                                >
                                    {verifyingTestWithAi ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <Bot size={14} />
                                    )}
                                    {verifyingTestWithAi ? "Verifying..." : "Run Full Test Verification"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <QuestionEditModal
                open={Boolean(editingQuestion)}
                title={
                    editingQuestion
                        ? `Edit Question ${editingQuestion.question_id.slice(0, 8)}`
                        : "Edit Question"
                }
                initialQuestionText={editingQuestion?.question_text || ""}
                initialSolutionText={editingQuestion?.solution_text || ""}
                initialOptions={getQuestionEditorOptions(editingQuestion)}
                initialAnswerKeyText={
                    editingQuestion ? normalizeAnswerKey(editingQuestion.answer_key).join(", ") : ""
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
                saving={savingQuestionEdit}
                onCancel={() => {
                    if (savingQuestionEdit) return;
                    setEditingQuestion(null);
                }}
                onSave={handleSaveEditedQuestion}
                questionId={editingQuestion?.question_id}
                rawData={editingQuestion?.raw_data}
                onAiMetadataUpdate={handleAiMetadataUpdate}
            />
        </div>
    );
}
