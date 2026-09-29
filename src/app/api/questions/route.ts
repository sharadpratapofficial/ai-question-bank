import { NextRequest, NextResponse } from "next/server";
import { fetchQuestions } from "@/lib/api/questions";
import { createClient as createServerClient } from "@/lib/supabase/server";
import type { FilterState, QuestionStatus } from "@/types";
import type { Question, QuestionOption } from "@/types";
import { ALL_QUESTION_STATUSES } from "@/types";
import { TABLE_NAME } from "@/lib/constants";
import { checkPermission, getCurrentUserWithRole, checkAnyPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

interface CreateQuestionInput {
    question_text?: string;
    options?: QuestionOption[] | Array<{ text?: string | null; isCorrect?: boolean | null }>;
    answer_key?: number | number[] | null;
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

interface CreateQuestionsRequest {
    question?: CreateQuestionInput;
    questions?: CreateQuestionInput[];
}

function getSupabase() {
    return getSupabaseAdmin();
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

function normalizeOptions(options: CreateQuestionInput["options"]): QuestionOption[] {
    if (!Array.isArray(options)) return [];
    return options.map((option) => ({
        text:
            option?.text === null || option?.text === undefined
                ? null
                : String(option.text),
        isCorrect:
            typeof option?.isCorrect === "boolean"
                ? option.isCorrect
                : option?.isCorrect === null
                    ? null
                    : false,
    }));
}

function normalizeCreateInput(
    input: CreateQuestionInput,
    index: number
): Record<string, unknown> {
    const questionText = String(input.question_text || "").trim();
    if (!questionText) {
        throw new Error(`Question ${index + 1}: question_text is required.`);
    }

    const questionId = crypto.randomUUID();
    const questionType = String(input.question_type || "Single_Choice(SCQ)");
    const numericalType = isNumericalQuestionType(questionType);
    const options = numericalType ? [] : normalizeOptions(input.options);

    let answerKey: number | number[] | null = null;
    if (typeof input.answer_key === "number") {
        answerKey = input.answer_key;
    } else if (Array.isArray(input.answer_key)) {
        answerKey = input.answer_key
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
    } else if (!numericalType && options.length > 0) {
        const selectedAnswers = options
            .map((opt, optionIndex) => (opt.isCorrect ? optionIndex + 1 : null))
            .filter((value): value is number => value !== null);
        answerKey = selectedAnswers.length > 0 ? selectedAnswers : null;
    }

    return {
        question_id: questionId,
        qbg_id: questionId,
        question_text: questionText,
        options,
        answer_key: answerKey,
        solution_text: String(input.solution_text || ""),
        question_type: questionType,
        subject: String(input.subject || ""),
        chapter: String(input.chapter || ""),
        topic: String(input.topic || ""),
        subtopic:
            input.subtopic === null
                ? null
                : String(input.subtopic || "").trim() || null,
        source: String(input.source || "Manual Entry"),
        difficutly_level: String(input.difficutly_level || "Medium"),
        class_level:
            input.class_level === null
                ? null
                : String(input.class_level || "").trim() || null,
        exam:
            Array.isArray(input.exam) && input.exam.length > 0
                ? input.exam.map((exam) => String(exam)).filter((exam) => exam.trim().length > 0)
                : null,
        parent_question_id:
            input.parent_question_id === null
                ? null
                : String(input.parent_question_id || "").trim() || null,
        raw_data: input.raw_data ?? null,
    };
}

export async function GET(request: NextRequest) {
    // Reads through the server-only client, so this route is the access check.
    const forbid = await checkAnyPermission(["view_questions", "generate_tests"]);
    if (forbid) return forbid;
    try {
        const { searchParams } = new URL(request.url);

        // Parse pagination
        const page = parseInt(searchParams.get("page") || "1", 10);
        const pageSize = parseInt(searchParams.get("pageSize") || "20", 10);

        // Parse filters
        const filters: Partial<FilterState> = {};

        const subjects = searchParams.get("subjects");
        if (subjects) filters.subjects = subjects.split(",");

        const chapters = searchParams.get("chapters");
        if (chapters) filters.chapters = chapters.split(",");

        const topics = searchParams.get("topics");
        if (topics) filters.topics = topics.split(",");

        const types = searchParams.get("question_types");
        if (types) filters.question_types = types.split(",");

        const difficulties = searchParams.get("difficulty_levels");
        if (difficulties) filters.difficulty_levels = difficulties.split(",");

        const sources = searchParams.get("sources");
        if (sources) filters.sources = sources.split(",");

        const classLevels = searchParams.get("class_levels");
        if (classLevels) filters.class_levels = classLevels.split(",");

        const subtopics = searchParams.get("subtopics");
        if (subtopics) filters.subtopics = subtopics.split(",");

        const search = searchParams.get("search");
        if (search) filters.search = search;

        const hasSourceDocx = searchParams.get("has_source_docx");
        if (hasSourceDocx === "1" || hasSourceDocx === "true") {
            filters.has_source_docx = true;
        }

        const statusesParam = searchParams.get("statuses");
        if (statusesParam) {
            const list = statusesParam
                .split(",")
                .map((s) => s.trim())
                .filter((s): s is QuestionStatus =>
                    (ALL_QUESTION_STATUSES as string[]).includes(s)
                );
            if (list.length > 0) filters.statuses = list;
        }

        const result = await fetchQuestions(filters, page, pageSize);

        return NextResponse.json(result);
    } catch (err) {
        console.error("API /questions error:", err);
        return NextResponse.json(
            { error: "Failed to fetch questions", details: String(err) },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("manual_question_entry");
    if (forbid) return forbid;
    try {
        const body = (await request.json()) as CreateQuestionsRequest;
        const rawQuestions = Array.isArray(body.questions)
            ? body.questions
            : body.question
                ? [body.question]
                : [];

        if (rawQuestions.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    questions: [],
                    error: "Provide either `question` or `questions` payload.",
                },
                { status: 400 }
            );
        }

        // Capture creator so the trigger + columns record who made each question.
        // For dev-auth synthesized admins, userId is null — those rows show as
        // "(unknown)" in history (acceptable; dev-only).
        const ctx = await getCurrentUserWithRole();
        const now = new Date().toISOString();

        const rows = rawQuestions.map((input, index) => ({
            ...normalizeCreateInput(input || {}, index),
            status: "verification_pending",
            created_by: ctx.userId ?? null,
            last_modified_by: ctx.userId ?? null,
            last_modified_at: now,
        }));

        // Use the cookie-aware server client so auth.uid() resolves inside the
        // snapshot trigger and the editor identity is attached to question_edit_history.
        const supabase = await createServerClient();
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .insert(rows)
            .select("*");

        if (error) {
            throw new Error(error.message);
        }

        return NextResponse.json({
            success: true,
            questions: (data || []) as Question[],
        });
    } catch (err) {
        console.error("API /questions POST error:", err);
        const message =
            err instanceof Error ? err.message : "Failed to create questions";
        const status =
            message.includes("question_text is required") ||
            message.includes("Provide either")
                ? 400
                : 500;
        return NextResponse.json(
            {
                success: false,
                questions: [],
                error: message,
            },
            { status }
        );
    }
}
