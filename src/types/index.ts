// Question data types for QBG View
// Updated to match actual Supabase schema (2026-02-15)

import type { UserRole } from "@/lib/auth/permissions";
export type { UserRole };

export interface QuestionOption {
    text: string | null;       // null for Integer-type questions
    isCorrect: boolean | null; // null for Integer-type questions
}

export interface Question {
    question_id: string;
    qbg_id: string;
    question_text: string;          // HTML string, may contain MathML, <img>, <sub>, <sup>
    options: QuestionOption[];
    answer_key: number | number[];  // [1] for SCQ, [1,3] for MCQ, 243 for Integer (mixed types!)
    solution_text: string;          // HTML string, may contain MathML
    question_type: QuestionType;
    subject: string;
    chapter: string;
    topic: string;
    source: string;
    difficutly_level: DifficultyLevel;  // ⚠️ Typo preserved from DB column name
    parent_question_id: string | null;
    child_order?: number | null;        // position within a passage (1-based); null for standalone questions
    raw_data: RawQuestionData[] | null;
    // New columns extracted from raw_data (may be null if migration hasn't run)
    exam: string[] | null;              // e.g. ["JEE Mains", "NEET"]
    class_level: string | null;         // e.g. "11", "12"
    subtopic: string | null;            // e.g. "Geometry or Shapes of Molecules"
    // QC workflow + identity columns (added by add_question_status_and_history migration)
    status?: QuestionStatus;
    created_by?: string | null;
    last_modified_by?: string | null;
    last_modified_at?: string;
}

// ==================== QC WORKFLOW ====================

export type QuestionStatus =
    | "verification_pending"
    | "verified"
    | "double_verified"
    | "uat_passed"
    | "rejected";

export const ALL_QUESTION_STATUSES: QuestionStatus[] = [
    "verification_pending",
    "verified",
    "double_verified",
    "uat_passed",
    "rejected",
];

export const QUESTION_STATUS_LABELS: Record<QuestionStatus, string> = {
    verification_pending: "Verification Pending",
    verified: "Verified (1st QC)",
    double_verified: "Double Verified (2nd QC)",
    uat_passed: "UAT Passed",
    rejected: "Rejected",
};

export const QUESTION_STATUS_SHORT_LABELS: Record<QuestionStatus, string> = {
    verification_pending: "Pending",
    verified: "Verified",
    double_verified: "2x Verified",
    uat_passed: "UAT ✓",
    rejected: "Rejected",
};

// hex colors used by the status pill (background + foreground)
export const QUESTION_STATUS_COLORS: Record<QuestionStatus, { bg: string; fg: string }> = {
    verification_pending: { bg: "#f59e0b22", fg: "#f59e0b" },
    verified:             { bg: "#3b82f622", fg: "#3b82f6" },
    double_verified:      { bg: "#8b5cf622", fg: "#8b5cf6" },
    uat_passed:           { bg: "#22c55e22", fg: "#22c55e" },
    rejected:             { bg: "#ef444422", fg: "#ef4444" },
};

export interface QuestionStatusTransition {
    id: string;
    question_id: string;
    from_status: QuestionStatus | null;
    to_status: QuestionStatus;
    actor_user_id: string | null;
    actor_email: string | null;
    actor_display_name: string | null;
    actor_role: UserRole | null;
    note: string | null;
    created_at: string;
}

export interface QuestionEditSnapshot {
    id: string;
    question_id: string;
    editor_user_id: string | null;
    editor_email: string | null;
    editor_display_name: string | null;
    editor_role: UserRole | null;
    change_type: "create" | "update" | "restore";
    snapshot: Question;
    changed_fields: string[] | null;
    created_at: string;
}

// Extended question with extra derived fields (video, verification, etc.)
export interface QuestionExtended extends Question {
    video_solution_url?: string; // from raw_data[0].solutions[0].english.videoSolution.url
    verification_status?: number; // 0 or 1
}

// Known question types in the system
export type QuestionType =
    | "Single_Choice(SCQ)"
    | "Multi_Choice(MCQ)"
    | "Integer"
    | "Numerical"
    | "Single_Digit_Integer"
    | "Assertion_Reason(AR)"
    | "Matching_List(ML)"
    | "Composite"
    | "Passage_Numerical"
    | "passage_numerical"
    | string; // Allow unknown types for forward compatibility

// Known difficulty levels
export type DifficultyLevel = "Easy" | "Medium" | "Hard" | string;

// Raw data structure from QBG system (stored in raw_data JSONB column)
export interface RawQuestionData {
    unique_id: string;
    type: number;               // 1=SCQ, 2=MCQ, 3=Integer, 7=AR, 9=ML
    difficulty: number;         // 1=Easy, 2=Medium, 3=Hard
    verification_status: number;
    conceptTags: ConceptTag[];
    examDetails: ExamDetail[];
    solutions: RawSolution[];
    content: { english: string };
    bilingual_options?: { english: QuestionOption[] };
    slug: string;
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
    parent_question_id: string | null;
    child_questions: unknown | null;
    sources: RawSource[];
    [key: string]: unknown;     // Allow other fields
}

export interface ConceptTag {
    subject: {
        subject_id: string;
        english_name: string;
        versions: { name: string; language_id: string }[];
    };
    chapter: {
        chapter_id: string;
        english_name: string;
        versions: { name: string; language_id: string }[];
    };
    topic: {
        topic_id: string;
        english_name: string;
        versions: { name: string; language_id: string }[];
    };
    subtopic?: {
        subtopic_id: string;
        english_name: string;
        versions: { name: string; language_id: string }[];
    };
    class: {
        class_id: string;
        english_name: string; // "11" or "12"
        versions: { name: string; language_id: string }[];
    };
}

export interface ExamDetail {
    unique_id: string;
    english_name: string; // "JEE Mains", "JEE Advanced"
    negative_marks: number;
    positive_marks: number;
    partial_positive_marks: number;
    versions: { name: string; language_id: string }[];
}

export interface RawSolution {
    english: {
        text: string;
        otherSolution: string;
        videoSolution: {
            url: string;
            type: number;
        };
    };
}

export interface RawSource {
    unique_id: string;
    english_name: string;
    versions: { name: string; language_id: string }[];
}

export interface AiVerificationEntry {
    index: number;
    provider: string;
    modelId: string;
    modelLabel: string;
    answerKeyVerified: boolean;
    aiAnswer: string;
    aiAnswerExplanation: string;
    aiSolution: string;
    aiSuggestion: string;
    questionLanguageQuality: string;
    solutionLanguageQuality: string;
    overallVerdict: string;
    verifiedAt: string;
}

export interface AiTranslationEntry {
    index: number;
    targetLanguage: string;
    translatedQuestionText: string;
    translatedOptions: Array<{ text: string; isCorrect: boolean }>;
    translatedSolutionText: string;
    translationNotes: string;
    provider: string;
    modelId: string;
    modelLabel: string;
    translatedAt: string;
}

export interface AiMetadata {
    verifications: AiVerificationEntry[];
    translations: AiTranslationEntry[];
}

// Row from public.question_translations
export interface QuestionTranslation {
    id: string;
    question_id: string;
    language: string;
    question_text: string;
    options: Array<{ text: string; isCorrect: boolean }>;
    solution_text: string | null;
    translation_notes: string | null;
    is_default: boolean;
    provider: string | null;
    model_id: string | null;
    model_label: string | null;
    translated_by: string | null;
    created_at: string;
    updated_at: string;
}

export const SUPPORTED_TRANSLATION_LANGUAGES = [
    "english",
    "hindi",
    "marathi",
    "bengali",
    "tamil",
    "telugu",
    "gujarati",
    "kannada",
    "malayalam",
    "punjabi",
    "urdu",
] as const;

export type TranslationLanguage = typeof SUPPORTED_TRANSLATION_LANGUAGES[number] | string;

// ==================== METADATA ====================

export interface MetadataEntry {
    id: string;
    name: string;
}

export interface ChapterEntry extends MetadataEntry {
    subject: string; // subject name (flat, not FK)
}

export interface TopicEntry extends MetadataEntry {
    chapter: string; // chapter name (flat, not FK)
}

export interface SubtopicEntry extends MetadataEntry {
    topic: string; // topic name (flat, not FK)
}

// Hierarchical metadata for cascading filters
export interface MetadataHierarchy {
    subjects: string[];
    chaptersBySubject: Record<string, string[]>;
    topicsByChapter: Record<string, string[]>;
    subtopicsByTopic: Record<string, string[]>;
    questionTypes: string[];
    difficultyLevels: string[];
    sources: string[];
    /** Questions available per source — shown beside each option in the picker. */
    sourceCounts?: Record<string, number>;
    exams: string[];
    classLevels: string[];
}

// ==================== FILTERS ====================

export interface FilterState {
    subjects: string[];
    chapters: string[];
    topics: string[];
    subtopics: string[];
    question_types: string[];
    difficulty_levels: string[];
    sources: string[];
    exams: string[];
    class_levels: string[];
    statuses: QuestionStatus[];
    search: string;
    /** Restrict to questions ingested from .docx (source_docx column populated).
     *  Drives the "Word source only" toggle on /tests for Word-output generation. */
    has_source_docx?: boolean;
}

export const EMPTY_FILTERS: FilterState = {
    subjects: [],
    chapters: [],
    topics: [],
    subtopics: [],
    question_types: [],
    difficulty_levels: [],
    sources: [],
    exams: [],
    class_levels: [],
    statuses: [],
    search: "",
};

// ==================== TESTS ====================

export interface TestConfig {
    title: string;
    subtitle: string;
    date: string;
    duration: string;
    positive_marks: number;
    negative_marks: number;
    instructions: string;        // HTML string for instructions page
    sections: TestSection[];
}

export interface TestSection {
    name: string;
    subject: string;
    question_ids: string[];
}

export interface TestTemplate {
    id: string;
    name: string;
    description?: string;
    config: TestConfig;
    created_by?: string;
    created_at?: string;
}

export interface Test {
    id: string;
    title: string;
    subtitle?: string;
    template_id?: string;
    batch_name?: string;
    config: TestConfig;
    question_ids: string[];
    sections: TestSection[];
    status: "draft" | "finalized" | "shared";
    share_token?: string;
    pdf_url?: string;
    is_student_accessible: boolean;
    created_by?: string;
    created_at?: string;
    updated_at?: string;
}

// ==================== TEST GENERATION ====================

export type ExamPreset = "NEET" | "JEE_MAINS" | "JEE_ADVANCE";
export type JeeAdvancedPaper = "Paper 1" | "Paper 2";
export type BaseExamPreset = Exclude<ExamPreset, "JEE_ADVANCE">;

/** Per-subject question requirements for an exam preset */
export interface SubjectRequirement {
    subject: string;
    /** Optional section grouping (used for JEE Advanced Paper 1/Paper 2) */
    paper?: JeeAdvancedPaper;
    /** Map of question_type -> count required */
    questionTypes: { type: string; count: number; questionNumbers?: string }[];
}

/** Exam preset definitions */
export const EXAM_PRESETS: Record<BaseExamPreset, {
    label: string;
    subjects: SubjectRequirement[];
    totalQuestions: number;
}> = {
    NEET: {
        label: "NEET",
        subjects: [
            {
                subject: "Physics",
                questionTypes: [{ type: "Single_Choice(SCQ)", count: 45, questionNumbers: "1-45" }],
            },
            {
                subject: "Chemistry",
                questionTypes: [{ type: "Single_Choice(SCQ)", count: 45, questionNumbers: "1-45" }],
            },
            {
                subject: "Biology",
                questionTypes: [{ type: "Single_Choice(SCQ)", count: 45, questionNumbers: "1-45" }],
            },
        ],
        totalQuestions: 135,
    },
    JEE_MAINS: {
        label: "JEE Mains",
        subjects: [
            {
                subject: "Physics",
                questionTypes: [
                    { type: "Single_Choice(SCQ)", count: 20, questionNumbers: "1-20" },
                    { type: "Integer", count: 5, questionNumbers: "21-25" },    // also accepts Single_Digit_Integer
                ],
            },
            {
                subject: "Chemistry",
                questionTypes: [
                    { type: "Single_Choice(SCQ)", count: 20, questionNumbers: "1-20" },
                    { type: "Integer", count: 5, questionNumbers: "21-25" },
                ],
            },
            {
                subject: "Maths",
                questionTypes: [
                    { type: "Single_Choice(SCQ)", count: 20, questionNumbers: "1-20" },
                    { type: "Integer", count: 5, questionNumbers: "21-25" },
                ],
            },
        ],
        totalQuestions: 75,
    },
};

export interface JeeAdvancedQuestionTypeRequirement {
    type: string;
    count: number;
    questionNumbers: string;
}

export interface QuestionTypeDistributionRow {
    type: string;
    count: number;
    questionNumbers?: string;
}

export const JEE_ADVANCED_PATTERN_MATRIX: Record<
    string,
    Record<JeeAdvancedPaper, JeeAdvancedQuestionTypeRequirement[]>
> = {
    "2025": {
        "Paper 1": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Multi_Choice(MCQ)", count: 3, questionNumbers: "5-7" },
            { type: "Numerical", count: 6, questionNumbers: "8-14" },
            { type: "Matching_List(ML)", count: 3, questionNumbers: "15-17" },
        ],
        "Paper 2": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Multi_Choice(MCQ)", count: 4, questionNumbers: "5-8" },
            { type: "Numerical", count: 8, questionNumbers: "9-16" },
        ],
    },
    "2024": {
        "Paper 1": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Multi_Choice(MCQ)", count: 3, questionNumbers: "5-7" },
            { type: "Integer", count: 6, questionNumbers: "8-14" },
            { type: "Matching_List(ML)", count: 4, questionNumbers: "15-18" },
        ],
        "Paper 2": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Multi_Choice(MCQ)", count: 3, questionNumbers: "5-7" },
            { type: "Integer", count: 6, questionNumbers: "8-14" },
            { type: "Passage_Numerical", count: 2, questionNumbers: "15-18" },
        ],
    },
    "2023": {
        "Paper 1": [
            { type: "Multi_Choice(MCQ)", count: 3, questionNumbers: "1-3" },
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "4-7" },
            { type: "Integer", count: 6, questionNumbers: "8-14" },
            { type: "Matching_List(ML)", count: 4, questionNumbers: "15-18" },
        ],
        "Paper 2": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Multi_Choice(MCQ)", count: 3, questionNumbers: "5-7" },
            { type: "Integer", count: 6, questionNumbers: "8-14" },
            { type: "Passage_Numerical", count: 2, questionNumbers: "15-18" },
        ],
    },
    "2022": {
        "Paper 1": [
            { type: "Numerical", count: 8, questionNumbers: "1-8" },
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "9-14" },
            { type: "Matching_List(ML)", count: 4, questionNumbers: "15-18" },
        ],
        "Paper 2": [
            { type: "Single_Digit_Integer", count: 8, questionNumbers: "1-8" },
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "9-14" },
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "15-18" },
        ],
    },
    "2021": {
        "Paper 1": [
            { type: "Single_Choice(SCQ)", count: 4, questionNumbers: "1-4" },
            { type: "Passage_Numerical", count: 3, questionNumbers: "5-7" },
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "8-14" },
            { type: "Integer", count: 3, questionNumbers: "15-17" },
        ],
        "Paper 2": [
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "1-6" },
            { type: "Passage_Numerical", count: 3, questionNumbers: "7-12" },
            { type: "Passage_SCQ", count: 2, questionNumbers: "13-16" },
            { type: "Integer", count: 3, questionNumbers: "17-19" },
        ],
    },
    "2020": {
        "Paper 1": [
            { type: "Single_Choice(SCQ)", count: 6, questionNumbers: "1-6" },
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "7-12" },
            { type: "Numerical", count: 6, questionNumbers: "13-18" },
        ],
        "Paper 2": [
            { type: "Single_Choice(SCQ)", count: 6, questionNumbers: "1-6" },
            { type: "Multi_Choice(MCQ)", count: 6, questionNumbers: "7-12" },
            { type: "Numerical", count: 6, questionNumbers: "13-18" },
        ],
    },
};

/** Source preference with soft percentage */
export interface SourcePreference {
    source: string;
    percent: number;   // 0-100
}

/** Difficulty distribution (rest = Medium) */
export interface DifficultyDistribution {
    easyPercent: number;   // 0-100
    hardPercent: number;   // 0-100
    // mediumPercent is implicit: 100 - easy - hard
}

/** Row-level criteria for customised test generation */
export interface CustomTestRowConfig {
    questionType: string;
    numQuestions: number;
    easyPercent: number;
    hardPercent: number;
    subject: string;
    chapter?: string;
    topic?: string;
}

export interface AIGenerationConfig {
    enabled: boolean;
    provider:
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
    modelId: string;
}

/** Configuration for generating automated tests */
export interface TestGenerationConfig {
    examPreset: ExamPreset;
    jeeAdvancedYear?: string;
    jeeAdvancedPapers?: JeeAdvancedPaper[];
    /** Optional override for non-advance distributions (applies to each selected subject). */
    questionTypeDistribution?: QuestionTypeDistributionRow[];
    /** Optional override for JEE Advance distributions, by paper. */
    questionTypeDistributionByPaper?: Partial<
        Record<JeeAdvancedPaper, QuestionTypeDistributionRow[]>
    >;
    batchName: string;
    testDate?: string;                  // ISO date string, optional reference
    numberOfTests: number;              // 1-10
    fullSyllabus: boolean;
    /** Optional: selected subjects to constrain generation */
    selectedSubjects?: string[];
    /** Only used if fullSyllabus is false. Map of subject -> selected chapters */
    selectedChapters: Record<string, string[]>;
    /** Optional: map of chapter -> selected topics. Empty array means all topics. */
    selectedTopicsByChapter?: Record<string, string[]>;
    sourcePreferences: SourcePreference[];
    difficultyDistribution: DifficultyDistribution;
    /** Avoid selecting questions already finalised in the same batch. */
    avoidBatchRepeats?: boolean;
    /** If strict avoidance cannot satisfy required count, allow reuse as fallback. */
    allowBatchRepeatFallback?: boolean;
    /** Optional: when provided, these rows drive customised test generation */
    customRows?: CustomTestRowConfig[];
    /** Optional: AI generation mode for creating fresh questions */
    aiGeneration?: AIGenerationConfig;
    /**
     * Test language. When set to anything other than "english", the candidate
     * pool is restricted to questions that have a default translation in that
     * language (via public.question_translations), and the test renders the
     * translated fields.
     */
    language?: string;
    /**
     * When true, only questions whose `source_docx` column is populated (i.e.
     * ingested via the Word upload pipeline) are considered. Use this when
     * you intend to emit the test as a Word document via /api/tests/generate-word —
     * otherwise the docx output will skip any non-Word-sourced questions.
     */
    wordSourceOnly?: boolean;
}

/** A single generated test result */
export interface GeneratedTest {
    testNumber: number;
    batchName: string;
    testDate?: string;
    examPreset: ExamPreset;
    sections: GeneratedTestSection[];
    totalQuestions: number;
    /** Stats for display */
    stats: {
        byDifficulty: Record<string, number>;
        bySource: Record<string, number>;
        byChapter: Record<string, number>;
    };
}

export interface GeneratedTestSection {
    paper?: JeeAdvancedPaper;
    subject: string;
    questionTypes: {
        type: string;
        typeLabel: string;
        questions: Question[];
    }[];
    totalQuestions: number;
}

export interface FinalizedQuestionUsage {
    testId: string;
    batchName: string;
    testNumber: number;
    examPreset: ExamPreset;
    testDate?: string;
    createdAt: string;
}

export interface BatchOption {
    id: string;
    name: string;
    createdAt?: string;
}

export interface TestHistorySummary {
    id: string;
    batchName: string;
    testNumber: number;
    examPreset: ExamPreset;
    testDate?: string;
    testName?: string;
    createdAt: string;
    totalQuestions: number;
    /** Lower-cased language identifier the test was generated in. */
    language?: string;
}

export interface TestHistoryQuestionItem {
    question: Question;
    questionOrder: number;
    paper?: JeeAdvancedPaper;
    subject: string;
    questionType: string;
    typeLabel: string;
}

export interface TestHistoryDetail extends TestHistorySummary {
    questions: Question[];
    questionItems?: TestHistoryQuestionItem[];
    outputConfig?: Record<string, unknown> | null;
    generationConfig?: Partial<TestGenerationConfig> | null;
    aiVerificationReport?: TestAiVerificationReport | null;
}

export interface TestAiPatternCheck {
    label: string;
    subject: string;
    paper?: JeeAdvancedPaper;
    expectedByType: Record<string, number>;
    actualByType: Record<string, number>;
    missingByType: Record<string, number>;
    extraByType: Record<string, number>;
    passed: boolean;
}

export interface TestAiVerificationQuestionResult {
    questionId: string;
    displayNumber: number;
    subject: string;
    chapter: string;
    topic: string;
    questionType: string;
    paper?: JeeAdvancedPaper;
    answerKeyVerified: boolean;
    aiAnswer: string;
    aiAnswerExplanation: string;
    aiSolution: string;
    aiSuggestion: string;
    questionLanguageQuality: string;
    solutionLanguageQuality: string;
    overallVerdict: string;
    outOfSyllabus: boolean;
    outOfSyllabusReason?: string;
    structuralIssues: string[];
    verifiedAt: string;
}

export interface TestAiVerificationWrongQuestion {
    questionId: string;
    displayNumber: number;
    summary: string;
    suggestion: string;
}

export interface TestAiVerificationReport {
    provider: string;
    modelId: string;
    modelLabel: string;
    verifiedAt: string;
    examPreset: ExamPreset;
    totalQuestions: number;
    aiVerifiedCount: number;
    incorrectAnswerKeyCount: number;
    needsReviewCount: number;
    outOfSyllabusCount: number;
    patternChecks: TestAiPatternCheck[];
    subjectQuestionCounts: Record<string, number>;
    chapterQuestionCounts: Record<string, number>;
    overallSummary: string;
    paperStructureAssessment: string;
    syllabusBalanceAssessment: string;
    topRecommendations: string[];
    wrongQuestions: TestAiVerificationWrongQuestion[];
    questions: TestAiVerificationQuestionResult[];
}

/** Full response from the generation API */
export interface TestGenerationResponse {
    success: boolean;
    tests: GeneratedTest[];
    warnings: string[];           // Soft-constraint violations logged here
    questionUsageById?: Record<string, FinalizedQuestionUsage[]>;
    error?: string;
}

// ==================== USER & AUTH ====================
// Real UserRole comes from @/lib/auth/permissions (re-exported at the top of this file).
// Legacy UserProfile stub was unused — removed in favor of the user_profiles row shape
// defined inline by the admin pages.

// ==================== STUDENT TEST ====================

export interface TestAttempt {
    id: string;
    test_id: string;
    student_id: string;
    started_at: string;
    finished_at?: string;
    time_spent_seconds?: number;
    status: "in_progress" | "submitted" | "timed_out";
    responses: Record<string, { selected: number[]; time_spent: number }>;
    score?: TestScore;
}

export interface TestScore {
    total: number;
    correct: number;
    incorrect: number;
    unattempted: number;
    marks: number;
    max_marks: number;
    section_scores?: Record<string, { correct: number; incorrect: number; marks: number }>;
}

// ==================== UI ====================

export type Theme = "light" | "dark";

// ==================== UTILITY ====================

/**
 * Normalize answer_key to always be an array.
 * Handles the mixed types in the DB (number vs number[]).
 */
export function normalizeAnswerKey(
    ak: number | number[] | null | undefined
): number[] {
    if (ak === null || ak === undefined) return [];
    const arr = Array.isArray(ak) ? ak : [ak];
    // Drop null/undefined/NaN entries so a missing key never renders as "null".
    return arr.filter(
        (v): v is number => v !== null && v !== undefined && !Number.isNaN(Number(v))
    );
}

/**
 * Resolve the answer key for a question, falling back to the options'
 * `isCorrect` flags when the `answer_key` column is missing/null (common when
 * the DB row predates the answer-key backfill). Returns 1-based option indices
 * for option questions, or the stored integer answer for numeric types. Empty
 * array means the answer genuinely couldn't be determined.
 */
export function resolveAnswerKey(question: {
    answer_key?: number | number[] | null;
    options?: QuestionOption[] | { text: string | null; isCorrect: boolean | null }[] | null;
}): number[] {
    const direct = normalizeAnswerKey(question.answer_key);
    if (direct.length > 0) return direct;
    if (Array.isArray(question.options)) {
        const derived = question.options
            .map((opt, index) => (opt?.isCorrect ? index + 1 : null))
            .filter((v): v is number => v !== null);
        if (derived.length > 0) return derived;
    }
    return [];
}

/**
 * Extract extended data from raw_data for a question.
 */
export function extractExtendedData(q: Question): QuestionExtended {
    const raw = q.raw_data?.[0];
    if (!raw) return q as QuestionExtended;

    return {
        ...q,
        // Only fill these if they're not already populated from DB columns
        subtopic: q.subtopic ?? raw.conceptTags?.[0]?.subtopic?.english_name ?? null,
        class_level: q.class_level ?? raw.conceptTags?.[0]?.class?.english_name ?? null,
        exam: q.exam ?? (raw.examDetails?.map((e: { english_name?: string }) => e.english_name).filter(Boolean) as string[]) ?? null,
        video_solution_url: raw.solutions?.[0]?.english?.videoSolution?.url || undefined,
        verification_status: raw.verification_status,
    };
}

/**
 * Map numeric question type to display label
 */
export const QUESTION_TYPE_MAP: Record<number, string> = {
    1: "Single_Choice(SCQ)",
    2: "Multi_Choice(MCQ)",
    3: "Integer",
    7: "Assertion_Reason(AR)",
    9: "Matching_List(ML)",
};

/**
 * Map numeric difficulty to display label
 */
export const DIFFICULTY_MAP: Record<number, DifficultyLevel> = {
    1: "Easy",
    2: "Medium",
    3: "Hard",
};

/**
 * Get a display-friendly question type label
 */
export function getQuestionTypeLabel(type: string): string {
    const labels: Record<string, string> = {
        "Single_Choice(SCQ)": "SCQ",
        "Multi_Choice(MCQ)": "MCQ",
        "Integer": "Integer",
        "Numerical": "Numerical",
        "Single_Digit_Integer": "Single Digit Integer",
        "Assertion_Reason(AR)": "Assertion & Reason",
        "Matching_List(ML)": "Matrix Match",
        "Composite": "Composite",
        "Passage_Numerical": "Passage Numerical",
        "passage_numerical": "Passage Numerical",
    };
    const normalized = type.trim().toLowerCase();
    if (normalized === "passage_numerical") return "Passage Numerical";
    return labels[type] || type;
}
