import { NextRequest, NextResponse } from "next/server";
import {
    fetchQuestionById,
    fetchChildQuestions,
    extractQuestionPatch,
    QUESTION_EDITABLE_FIELDS,
    updateQuestionById,
    type UpdateQuestionPatch,
} from "@/lib/api/questions";
import { isPassageParentQuestionType } from "@/lib/questionTypes";
import { checkAnyPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { createClient as createServerClient } from "@/lib/supabase/server";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        const question = await fetchQuestionById(id);

        if (!question) {
            return NextResponse.json(
                { error: "Question not found" },
                { status: 404 }
            );
        }

        // For composite/passage questions: fetch child questions
        let childQuestions = null;
        if (isPassageParentQuestionType(question.question_type)) {
            childQuestions = await fetchChildQuestions(question.question_id);
        }

        // For child questions: fetch the parent passage and siblings
        let parentQuestion = null;
        let siblingQuestions = null;
        if (question.parent_question_id) {
            parentQuestion = await fetchQuestionById(question.parent_question_id);
            if (parentQuestion) {
                const allChildren = await fetchChildQuestions(question.parent_question_id);
                // Siblings = all children of same parent (including self)
                siblingQuestions = allChildren;
            }
        }

        return NextResponse.json({
            question,
            childQuestions,
            parentQuestion,
            siblingQuestions,
        });
    } catch (err) {
        console.error("API /questions/[id] error:", err);
        return NextResponse.json(
            { error: "Failed to fetch question", details: String(err) },
            { status: 500 }
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkAnyPermission(["manual_question_entry", "edit_metadata"]);
    if (forbid) return forbid;
    try {
        const { id } = await params;
        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { success: false, error: "Invalid JSON payload." },
                { status: 400 }
            );
        }

        if (!id?.trim()) {
            return NextResponse.json(
                { success: false, error: "Question id is required." },
                { status: 400 }
            );
        }

        if (!isRecord(body)) {
            return NextResponse.json(
                { success: false, error: "Payload must be a JSON object." },
                { status: 400 }
            );
        }

        const payload = body as Record<string, unknown>;

        if (Object.prototype.hasOwnProperty.call(payload, "question_id")) {
            return NextResponse.json(
                { success: false, error: "question_id cannot be updated." },
                { status: 400 }
            );
        }
        if (Object.prototype.hasOwnProperty.call(payload, "qbg_id")) {
            return NextResponse.json(
                { success: false, error: "qbg_id cannot be updated." },
                { status: 400 }
            );
        }

        const unsupportedFields = Object.keys(payload).filter((field) =>
            !QUESTION_EDITABLE_FIELDS.includes(field as keyof UpdateQuestionPatch) &&
            field !== "question_id" &&
            field !== "qbg_id"
        );
        if (unsupportedFields.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: `Unsupported field(s): ${unsupportedFields.join(", ")}`,
                    allowedFields: QUESTION_EDITABLE_FIELDS,
                },
                { status: 400 }
            );
        }

        const patch = extractQuestionPatch(payload);

        if (Object.keys(patch).length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: "At least one editable field is required.",
                    allowedFields: QUESTION_EDITABLE_FIELDS,
                },
                { status: 400 }
            );
        }

        const ctx = await getCurrentUserWithRole();
        const supabase = await createServerClient();
        const question = await updateQuestionById(id, patch as UpdateQuestionPatch, {
            supabase,
            actor: {
                userId: ctx.userId,
                timestamp: new Date().toISOString(),
            },
        });

        return NextResponse.json({
            success: true,
            question,
        });
    } catch (err) {
        console.error("API /questions/[id] PATCH error:", err);
        const message = getErrorMessage(err);
        if (message.toLowerCase().startsWith("question not found")) {
            return NextResponse.json(
                { success: false, error: message },
                { status: 404 }
            );
        }
        if (
            message === "Question id is required." ||
            message.startsWith("No editable fields provided.")
        ) {
            return NextResponse.json(
                { success: false, error: message },
                { status: 400 }
            );
        }
        return NextResponse.json(
            { success: false, error: "Failed to update question", details: message },
            { status: 500 }
        );
    }
}
