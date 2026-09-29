import { NextRequest, NextResponse } from "next/server";
import { finalizeGeneratedTests, getQuestionUsageMap } from "@/lib/api/testHistory";
import { TABLE_NAME } from "@/lib/constants";
import type { ExamPreset, GeneratedTest, Question, TestGenerationConfig } from "@/types";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

interface FinalizePayload {
    batchNames: string[];
    examPreset: ExamPreset;
    testDate?: string;
    testName?: string;
    language?: string;
    outputConfig?: Record<string, unknown>;
    generationConfig?: Partial<TestGenerationConfig>;
    tests: GeneratedTest[];
}

const AI_GENERATED_SOURCE = "AI Generated";

function getSupabase() {
    return getSupabaseAdmin();
}

function mapQuestionToDBRow(question: Question) {
    const questionId = String(question.question_id || crypto.randomUUID());
    const qbgId = String(question.qbg_id || questionId);

    return {
        question_id: questionId,
        qbg_id: qbgId,
        question_text: String(question.question_text || ""),
        options: Array.isArray(question.options)
            ? question.options.map((option) => ({
                  text: option?.text ?? null,
                  isCorrect: option?.isCorrect ?? null,
              }))
            : [],
        answer_key: question.answer_key ?? null,
        solution_text: String(question.solution_text || ""),
        question_type: String(question.question_type || "Single_Choice(SCQ)"),
        subject: String(question.subject || ""),
        chapter: String(question.chapter || ""),
        topic: String(question.topic || ""),
        subtopic: question.subtopic ? String(question.subtopic) : null,
        source: AI_GENERATED_SOURCE,
        difficutly_level: String(question.difficutly_level || "Medium"),
        class_level: question.class_level ? String(question.class_level) : null,
        exam:
            Array.isArray(question.exam) && question.exam.length > 0
                ? question.exam.map((exam) => String(exam))
                : null,
        parent_question_id: null,
        raw_data: null,
    };
}

async function persistAIGeneratedQuestions(tests: GeneratedTest[]) {
    const rowsById = new Map<string, ReturnType<typeof mapQuestionToDBRow>>();

    tests.forEach((test) => {
        test.sections.forEach((section) => {
            section.questionTypes.forEach((group) => {
                group.questions.forEach((question) => {
                    if (String(question.source || "") !== AI_GENERATED_SOURCE) return;
                    const row = mapQuestionToDBRow(question);
                    rowsById.set(row.question_id, row);
                });
            });
        });
    });

    if (rowsById.size === 0) return;

    const supabase = getSupabase();
    const rows = Array.from(rowsById.values());
    const chunkSize = 200;

    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await supabase
            .from(TABLE_NAME)
            .upsert(chunk, { onConflict: "question_id", ignoreDuplicates: true });
        if (error) {
            throw new Error(`Failed to save AI-generated questions: ${error.message}`);
        }
    }
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as FinalizePayload;
        const batchNames = Array.isArray(body?.batchNames)
            ? body.batchNames.map((name) => String(name || "").trim()).filter(Boolean)
            : [];
        if (!batchNames.length) {
            return NextResponse.json(
                { success: false, error: "At least one batch is required." },
                { status: 400 }
            );
        }
        if (!body?.examPreset) {
            return NextResponse.json(
                { success: false, error: "Exam preset is required." },
                { status: 400 }
            );
        }
        if (!Array.isArray(body?.tests) || body.tests.length === 0) {
            return NextResponse.json(
                { success: false, error: "No tests to finalise." },
                { status: 400 }
            );
        }

        await persistAIGeneratedQuestions(body.tests);

        const result = await finalizeGeneratedTests({
            batchNames,
            examPreset: body.examPreset,
            testDate: body.testDate,
            testName: body.testName,
            language: (body.language || body.generationConfig?.language || "english"),
            outputConfig: body.outputConfig,
            generationConfig: body.generationConfig,
            tests: body.tests,
        });

        const questionIds = body.tests.flatMap((test) =>
            test.sections.flatMap((section) =>
                section.questionTypes.flatMap((group) =>
                    group.questions.map((question) => question.question_id)
                )
            )
        );
        const questionUsageById = await getQuestionUsageMap(questionIds);

        return NextResponse.json({
            success: true,
            savedTestIds: result.savedTestIds,
            warnings: result.warnings,
            questionUsageById,
        });
    } catch (error) {
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
