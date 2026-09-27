import type { createClient } from "@supabase/supabase-js";
import type { Question, QuestionOption, FilterState, MetadataHierarchy } from "@/types";
import { TABLE_NAME, DEFAULT_PAGE_SIZE, SUPABASE_MAX_ROWS } from "@/lib/constants";
import { sortChaptersForSubject } from "@/lib/chapterOrder";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// Singleton client for API routes / server usage

function getSupabase(): any {
        return getSupabaseAdmin(); // itself a process-wide singleton
}

// ==================== QUESTIONS ====================

export interface QuestionsResult {
    questions: Question[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

/**
 * Apply common filters to a supabase query
 */
function applyFilters(
    query: ReturnType<ReturnType<typeof createClient>["from"]>["select"],
    filters: Partial<FilterState>
) {
    if (filters.subjects?.length) {
        query = query.in("subject", filters.subjects);
    }
    if (filters.chapters?.length) {
        query = query.in("chapter", filters.chapters);
    }
    if (filters.topics?.length) {
        query = query.in("topic", filters.topics);
    }
    if (filters.subtopics?.length) {
        query = query.in("subtopic", filters.subtopics);
    }
    if (filters.question_types?.length) {
        query = query.in("question_type", filters.question_types);
    }
    if (filters.difficulty_levels?.length) {
        query = query.in("difficutly_level", filters.difficulty_levels); // typo preserved from DB
    }
    if (filters.sources?.length) {
        query = query.in("source", filters.sources);
    }
    if (filters.class_levels?.length) {
        query = query.in("class_level", filters.class_levels);
    }
    // Exam is a text[] column — use overlaps (&&) to match any of the selected exams
    if (filters.exams?.length) {
        query = query.overlaps("exam", filters.exams);
    }
    if (filters.statuses?.length) {
        query = query.in("status", filters.statuses);
    }
    // Word-source-only filter — used by the Word-test generator to constrain
    // selection to questions that have raw OOXML preserved.
    if (filters.has_source_docx) {
        query = query.not("source_docx", "is", null);
    }
    if (filters.search?.trim()) {
        query = query.ilike("question_text", `%${filters.search.trim()}%`);
    }
    return query;
}

/**
 * Fetch questions with filtering & pagination
 */
export async function fetchQuestions(
    filters: Partial<FilterState> = {},
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE
): Promise<QuestionsResult> {
    const supabase = getSupabase();

    let query = supabase.from(TABLE_NAME).select("*", { count: "exact" });
    query = applyFilters(query, filters) as typeof query;

    // Pagination
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    query = query.range(from, to).order("question_id");

    const { data, error, count } = await query;

    if (error) {
        console.error("Error fetching questions:", error);
        throw new Error(`Failed to fetch questions: ${error.message}`);
    }

    const total = count ?? 0;

    return {
        questions: (data as Question[]) || [],
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

/**
 * Fetch a single question by ID
 */
export async function fetchQuestionById(
    questionId: string
): Promise<Question | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select("*")
        .eq("question_id", questionId)
        .single();

    if (error) {
        console.error("Error fetching question:", error);
        return null;
    }

    return data as Question;
}

/**
 * Fetch all child questions of a parent (composite/passage) question
 */
export async function fetchChildQuestions(
    parentQuestionId: string
): Promise<Question[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select("*")
        .eq("parent_question_id", parentQuestionId)
        .order("question_id");

    if (error) {
        console.error("Error fetching child questions:", error);
        return [];
    }

    return (data as Question[]) || [];
}

export interface UpdateQuestionPatch {
    question_text?: string;
    options?: QuestionOption[];
    answer_key?: number | number[];
    solution_text?: string;
    question_type?: string;
    subject?: string;
    chapter?: string;
    topic?: string;
    subtopic?: string | null;
    source?: string;
    difficutly_level?: string;
    class_level?: string | null;
    exam?: string[] | null;
    parent_question_id?: string | null;
    raw_data?: unknown;
}

export const QUESTION_EDITABLE_FIELDS: Array<keyof UpdateQuestionPatch> = [
    "question_text",
    "options",
    "answer_key",
    "solution_text",
    "question_type",
    "subject",
    "chapter",
    "topic",
    "subtopic",
    "source",
    "difficutly_level",
    "class_level",
    "exam",
    "parent_question_id",
    "raw_data",
];

export function extractQuestionPatch(
    payload: Record<string, unknown>
): Partial<UpdateQuestionPatch> {
    const patch: Partial<UpdateQuestionPatch> = {};
    QUESTION_EDITABLE_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
            (patch as Record<string, unknown>)[field] = payload[field];
        }
    });
    return patch;
}

function normalizeOptionPatch(options: QuestionOption[]): QuestionOption[] {
    return options.map((option) => ({
        text: option?.text === null ? null : String(option?.text ?? ""),
        isCorrect:
            typeof option?.isCorrect === "boolean"
                ? option.isCorrect
                : option?.isCorrect === null
                    ? null
                    : false,
    }));
}

export interface UpdateQuestionOptions {
    /** Cookie-aware Supabase client. If omitted, falls back to the bare anon client
     *  (which means the snapshot trigger won't see auth.uid() — caller-beware).
     *  Typed loosely because @supabase/supabase-js and @supabase/ssr expose the same
     *  query surface but have different generic instantiations. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase?: any;
    /** Audit columns recorded on qbg_questions itself. */
    actor?: { userId: string | null; timestamp: string };
}

export async function updateQuestionById(
    questionId: string,
    patch: UpdateQuestionPatch,
    options: UpdateQuestionOptions = {}
): Promise<Question> {
    const supabase = options.supabase ?? getSupabase();
    const normalizedQuestionId = questionId.trim();
    const normalizedPatch = extractQuestionPatch(patch as Record<string, unknown>);
    const payload: Record<string, unknown> = {};

    if (!normalizedQuestionId) {
        throw new Error("Question id is required.");
    }

    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "question_text")) {
        payload.question_text = String(normalizedPatch.question_text ?? "");
    }
    if (
        Object.prototype.hasOwnProperty.call(normalizedPatch, "options") &&
        Array.isArray(normalizedPatch.options)
    ) {
        payload.options = normalizeOptionPatch(normalizedPatch.options);
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "answer_key")) {
        payload.answer_key = normalizedPatch.answer_key ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "solution_text")) {
        payload.solution_text = String(normalizedPatch.solution_text ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "question_type")) {
        payload.question_type = String(normalizedPatch.question_type ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "subject")) {
        payload.subject = String(normalizedPatch.subject ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "chapter")) {
        payload.chapter = String(normalizedPatch.chapter ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "topic")) {
        payload.topic = String(normalizedPatch.topic ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "subtopic")) {
        payload.subtopic =
            normalizedPatch.subtopic === null ? null : String(normalizedPatch.subtopic ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "source")) {
        payload.source = String(normalizedPatch.source ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "difficutly_level")) {
        payload.difficutly_level = String(normalizedPatch.difficutly_level ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "class_level")) {
        payload.class_level =
            normalizedPatch.class_level === null ? null : String(normalizedPatch.class_level ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "exam")) {
        payload.exam = Array.isArray(normalizedPatch.exam)
            ? normalizedPatch.exam.map((value) => String(value)).filter((value) => value.trim().length > 0)
            : null;
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "parent_question_id")) {
        payload.parent_question_id =
            normalizedPatch.parent_question_id === null
                ? null
                : String(normalizedPatch.parent_question_id ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "raw_data")) {
        payload.raw_data = normalizedPatch.raw_data ?? null;
    }

    if (Object.keys(payload).length === 0) {
        throw new Error(
            `No editable fields provided. Allowed fields: ${QUESTION_EDITABLE_FIELDS.join(", ")}`
        );
    }

    // Stamp audit columns on the row itself; the DB trigger handles the
    // snapshot row in question_edit_history.
    if (options.actor) {
        payload.last_modified_by = options.actor.userId;
        payload.last_modified_at = options.actor.timestamp;
    }

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .update(payload)
        .eq("question_id", normalizedQuestionId)
        .select("*")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to update question: ${error.message}`);
    }

    if (!data) {
        throw new Error(`Question not found: ${normalizedQuestionId}`);
    }

    return data as Question;
}

// ==================== METADATA / FILTERS ====================

interface MetadataRow {
    subject: string;
    chapter: string;
    topic: string;
    question_type: string;
    difficutly_level: string;
    source: string;
    // New columns (may be null if migration hasn't run)
    exam: string[] | null;
    class_level: string | null;
    subtopic: string | null;
}

/**
 * Fetch all unique filter values from the questions table.
 * Paginates through all rows to collect distinct values.
 */
export async function fetchMetadataHierarchy(): Promise<MetadataHierarchy> {
    const supabase = getSupabase();

    const allRows: MetadataRow[] = [];
    let page = 0;

    // Fetch columns — include new columns, but handle gracefully if they don't exist
    const selectCols =
        "subject, chapter, topic, question_type, difficutly_level, source, exam, class_level, subtopic";

    while (true) {
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .select(selectCols)
            .range(page * SUPABASE_MAX_ROWS, (page + 1) * SUPABASE_MAX_ROWS - 1);

        // If new columns don't exist yet, fall back to old query
        if (error && error.message?.includes("column")) {
            console.warn("New columns not found, falling back:", error.message);
            return fetchMetadataHierarchyFallback();
        }

        if (!data || data.length === 0) break;
        allRows.push(...(data as MetadataRow[]));
        page++;
        if (data.length < SUPABASE_MAX_ROWS) break;
    }

    // Build hierarchy
    const subjects = [...new Set(allRows.map((r) => r.subject))].filter(Boolean).sort();
    const questionTypes = [...new Set(allRows.map((r) => r.question_type))].filter(Boolean).sort();
    const difficultyLevels = [
        ...new Set(allRows.map((r) => r.difficutly_level)),
    ].filter((v) => v && v.trim()).sort();
    const sources = [...new Set(allRows.map((r) => r.source))].filter(Boolean).sort();
    // How many questions each source has — shown next to it in the source picker,
    // which matters once there are dozens to choose between.
    const sourceCounts: Record<string, number> = {};
    allRows.forEach((r) => {
        if (r.source) sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
    });

    // New: exams (flatten arrays), class levels, subtopics
    const examsSet = new Set<string>();
    const classSet = new Set<string>();
    allRows.forEach((r) => {
        if (r.exam && Array.isArray(r.exam)) {
            r.exam.forEach((e) => e && examsSet.add(e));
        }
        if (r.class_level) classSet.add(r.class_level);
    });
    const exams = [...examsSet].filter(Boolean).sort();
    const classLevels = [...classSet].filter(Boolean).sort();

    // Group chapters by subject
    const chaptersBySubject: Record<string, string[]> = {};
    allRows.forEach((r) => {
        if (!r.subject || !r.chapter) return;
        if (!chaptersBySubject[r.subject]) chaptersBySubject[r.subject] = [];
        if (!chaptersBySubject[r.subject].includes(r.chapter)) {
            chaptersBySubject[r.subject].push(r.chapter);
        }
    });
    Object.entries(chaptersBySubject).forEach(([subject, arr]) => {
        chaptersBySubject[subject] = sortChaptersForSubject(subject, arr);
    });

    // Group topics by chapter
    const topicsByChapter: Record<string, string[]> = {};
    allRows.forEach((r) => {
        if (!r.chapter || !r.topic) return;
        if (!topicsByChapter[r.chapter]) topicsByChapter[r.chapter] = [];
        if (!topicsByChapter[r.chapter].includes(r.topic)) {
            topicsByChapter[r.chapter].push(r.topic);
        }
    });
    Object.values(topicsByChapter).forEach((arr) => arr.sort());

    // Group subtopics by topic
    const subtopicsByTopic: Record<string, string[]> = {};
    allRows.forEach((r) => {
        if (!r.topic || !r.subtopic) return;
        if (!subtopicsByTopic[r.topic]) subtopicsByTopic[r.topic] = [];
        if (!subtopicsByTopic[r.topic].includes(r.subtopic)) {
            subtopicsByTopic[r.topic].push(r.subtopic);
        }
    });
    Object.values(subtopicsByTopic).forEach((arr) => arr.sort());

    return {
        subjects,
        chaptersBySubject,
        topicsByChapter,
        subtopicsByTopic,
        questionTypes,
        difficultyLevels,
        sources,
        sourceCounts,
        exams,
        classLevels,
    };
}

/**
 * Fallback metadata fetch when new columns don't exist yet
 */
async function fetchMetadataHierarchyFallback(): Promise<MetadataHierarchy> {
    const supabase = getSupabase();

    const allRows: {
        subject: string;
        chapter: string;
        topic: string;
        question_type: string;
        difficutly_level: string;
        source: string;
    }[] = [];

    let page = 0;
    while (true) {
        const { data } = await supabase
            .from(TABLE_NAME)
            .select("subject, chapter, topic, question_type, difficutly_level, source")
            .range(page * SUPABASE_MAX_ROWS, (page + 1) * SUPABASE_MAX_ROWS - 1);

        if (!data || data.length === 0) break;
        allRows.push(
            ...(data as typeof allRows)
        );
        page++;
        if (data.length < SUPABASE_MAX_ROWS) break;
    }

    const subjects = [...new Set(allRows.map((r) => r.subject))].filter(Boolean).sort();
    const questionTypes = [...new Set(allRows.map((r) => r.question_type))].filter(Boolean).sort();
    const difficultyLevels = [
        ...new Set(allRows.map((r) => r.difficutly_level)),
    ].filter((v) => v && v.trim()).sort();
    const sources = [...new Set(allRows.map((r) => r.source))].filter(Boolean).sort();
    // How many questions each source has — shown next to it in the source picker,
    // which matters once there are dozens to choose between.
    const sourceCounts: Record<string, number> = {};
    allRows.forEach((r) => {
        if (r.source) sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
    });

    const chaptersBySubject: Record<string, string[]> = {};
    allRows.forEach((r) => {
        if (!r.subject || !r.chapter) return;
        if (!chaptersBySubject[r.subject]) chaptersBySubject[r.subject] = [];
        if (!chaptersBySubject[r.subject].includes(r.chapter)) {
            chaptersBySubject[r.subject].push(r.chapter);
        }
    });
    Object.entries(chaptersBySubject).forEach(([subject, arr]) => {
        chaptersBySubject[subject] = sortChaptersForSubject(subject, arr);
    });

    const topicsByChapter: Record<string, string[]> = {};
    allRows.forEach((r) => {
        if (!r.chapter || !r.topic) return;
        if (!topicsByChapter[r.chapter]) topicsByChapter[r.chapter] = [];
        if (!topicsByChapter[r.chapter].includes(r.topic)) {
            topicsByChapter[r.chapter].push(r.topic);
        }
    });
    Object.values(topicsByChapter).forEach((arr) => arr.sort());

    // Extract exams and class levels from raw_data
    const examSet = new Set<string>();
    const classSet = new Set<string>();
    const subtopicsByTopic: Record<string, string[]> = {};

    // Paginate through raw_data
    let rawPage = 0;
    while (true) {
        const { data } = await supabase
            .from(TABLE_NAME)
            .select("topic, raw_data")
            .not("raw_data", "is", null)
            .range(rawPage * SUPABASE_MAX_ROWS, (rawPage + 1) * SUPABASE_MAX_ROWS - 1);

        if (!data || data.length === 0) break;

        data.forEach((row: { topic: string; raw_data: unknown }) => {
            const rd = row.raw_data;
            const r = Array.isArray(rd) ? rd[0] : rd;
            if (!r) return;

            // Exams
            if (r.examDetails && Array.isArray(r.examDetails)) {
                r.examDetails.forEach((e: { english_name?: string }) => {
                    if (e.english_name) examSet.add(e.english_name);
                });
            }

            // Class level
            const ct = r.conceptTags?.[0];
            if (ct?.class?.english_name) classSet.add(ct.class.english_name);

            // Subtopic
            if (row.topic && ct?.subtopic?.english_name) {
                if (!subtopicsByTopic[row.topic]) subtopicsByTopic[row.topic] = [];
                if (!subtopicsByTopic[row.topic].includes(ct.subtopic.english_name)) {
                    subtopicsByTopic[row.topic].push(ct.subtopic.english_name);
                }
            }
        });

        rawPage++;
        if (data.length < SUPABASE_MAX_ROWS) break;
    }

    Object.values(subtopicsByTopic).forEach((arr) => arr.sort());

    return {
        subjects,
        chaptersBySubject,
        topicsByChapter,
        subtopicsByTopic,
        questionTypes,
        difficultyLevels,
        sources,
        sourceCounts,
        exams: [...examSet].filter(Boolean).sort(),
        classLevels: [...classSet].filter(Boolean).sort(),
    };
}

/**
 * Get count of questions matching a set of filters
 */
export async function getFilteredCount(
    filters: Partial<FilterState>
): Promise<number> {
    const supabase = getSupabase();

    let query = supabase
        .from(TABLE_NAME)
        .select("*", { count: "exact", head: true });

    query = applyFilters(query, filters) as typeof query;

    const { count, error } = await query;

    if (error) {
        console.error("Error getting filtered count:", error);
        return 0;
    }

    return count ?? 0;
}
