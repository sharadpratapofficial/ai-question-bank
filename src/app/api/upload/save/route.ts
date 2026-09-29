import { NextRequest, NextResponse } from "next/server";
import type { SaveQuestionsRequest, SaveQuestionsResponse, ExtractedQuestion } from "@/types/extraction";
import { TABLE_NAME } from "@/lib/constants";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function getSupabase() {
    return getSupabaseAdmin();
}

function generateQuestionId(): string {
    return crypto.randomUUID();
}

function mapExtractedToDBRow(q: ExtractedQuestion, sourceName: string) {
    // Convert options to match DB format — array of {text, isCorrect} objects
    const options = q.options.map((opt) => ({
        text: opt.text,
        isCorrect: opt.isCorrect,
    }));

    // Build question_text HTML — inject diagram images if present
    let questionText = q.questionText || "";
    if (q.diagrams && q.diagrams.length > 0) {
        q.diagrams.forEach((diagram) => {
            if (diagram.dataUrl) {
                questionText += `<div class="question-diagram"><img src="${diagram.dataUrl}" alt="${diagram.description || "Diagram"}" style="max-width:100%;"/></div>`;
            }
        });
    }

    const questionId = generateQuestionId();

    return {
        question_id: questionId,
        qbg_id: questionId,
        question_text: questionText,
        options: options,
        answer_key: q.answerKey,
        solution_text: q.solutionText || "",
        question_type: q.questionType || "Single_Choice(SCQ)",
        subject: q.subject || "",
        chapter: q.chapter || "",
        topic: q.topic || "",
        subtopic: q.subtopic || null,
        source: sourceName || "Uploaded PDF",
        difficutly_level: q.difficultyLevel || "Medium",
        class_level: q.classLevel || null,
        exam: Array.isArray(q.exam) && q.exam.length > 0 ? q.exam : null,
        parent_question_id: null,
        raw_data: null,
    };
}

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;
    try {
        const body = (await request.json()) as SaveQuestionsRequest;

        if (!body.questions || body.questions.length === 0) {
            return NextResponse.json(
                { success: false, savedCount: 0, questionIds: [], errors: [{ questionNumber: 0, error: "No questions provided" }] } as SaveQuestionsResponse,
                { status: 400 }
            );
        }

        const supabase = getSupabase();
        const savedIds: string[] = [];
        const errors: { questionNumber: number; error: string }[] = [];

        // Insert questions one by one for better error handling
        for (const q of body.questions) {
            try {
                const row = mapExtractedToDBRow(q, body.sourceName);
                console.log(`Saving Q${q.questionNumber}, row keys:`, Object.keys(row));
                const { error: insertError } = await supabase
                    .from(TABLE_NAME)
                    .insert(row);

                if (insertError) {
                    console.error(`Save error Q${q.questionNumber}:`, insertError.message, insertError.details, insertError.hint);
                    errors.push({
                        questionNumber: q.questionNumber,
                        error: `${insertError.message}${insertError.details ? ` | ${insertError.details}` : ""}${insertError.hint ? ` | Hint: ${insertError.hint}` : ""}`,
                    });
                } else {
                    savedIds.push(row.question_id);
                }
            } catch (err) {
                console.error(`Exception saving Q${q.questionNumber}:`, err);
                errors.push({
                    questionNumber: q.questionNumber,
                    error: String(err),
                });
            }
        }

        return NextResponse.json({
            success: errors.length === 0,
            savedCount: savedIds.length,
            questionIds: savedIds,
            errors,
        } as SaveQuestionsResponse);
    } catch (err) {
        console.error("Save questions error:", err);
        return NextResponse.json(
            {
                success: false,
                savedCount: 0,
                questionIds: [],
                errors: [{ questionNumber: 0, error: `Save failed: ${String(err)}` }],
            } as SaveQuestionsResponse,
            { status: 500 }
        );
    }
}
