/**
 * POST /api/upload/extract/reports/[id]/save
 *
 * Commit a saved extraction report's questions into qbg_questions and mark the
 * report as 'saved'. Optional body lets the caller override:
 *   - questions: ExtractedQuestion[]   (use these instead of the stored set —
 *                                       useful after the user edited them)
 *   - sourceName: string                (override the row.source)
 */
import { NextRequest, NextResponse } from "next/server";
import type { ExtractedQuestion } from "@/types/extraction";
import { TABLE_NAME } from "@/lib/constants";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";

const REPORTS_TABLE = "pdf_extraction_reports";

function newId(): string {
    return crypto.randomUUID();
}

function mapExtractedToDBRow(
    q: ExtractedQuestion,
    sourceName: string,
    actor: { userId: string | null; now: string }
): Record<string, unknown> {
    const options = q.options.map((opt) => ({
        text: opt.text,
        isCorrect: opt.isCorrect,
    }));

    let questionText = q.questionText || "";
    if (q.diagrams && q.diagrams.length > 0) {
        q.diagrams.forEach((d) => {
            if (d.dataUrl) {
                questionText += `<div class="question-diagram"><img src="${d.dataUrl}" alt="${d.description || "Diagram"}" style="max-width:100%;"/></div>`;
            }
        });
    }

    // Docx-ingested questions carry a raw-OOXML payload alongside the
    // metadata. Copy it through so the new qbg_questions.source_docx column
    // holds the authoritative content for Word-output generation later.
    const maybeDocx = (q as ExtractedQuestion & { source_docx?: unknown }).source_docx;

    const questionId = newId();
    return {
        question_id: questionId,
        qbg_id: questionId,
        question_text: questionText,
        options,
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
        source_docx: maybeDocx ?? null,
        // QC workflow stamps so the trigger captures editor identity
        status: "verification_pending",
        created_by: actor.userId,
        last_modified_by: actor.userId,
        last_modified_at: actor.now,
    };
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const supabase = await createServerClient();
    const { data: report, error: loadErr } = await supabase
        .from(REPORTS_TABLE)
        .select("id, user_id, source_name, status, extracted_questions")
        .eq("id", id)
        .maybeSingle();

    if (loadErr) return NextResponse.json({ success: false, error: loadErr.message }, { status: 500 });
    if (!report) return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });

    const ctx = await getCurrentUserWithRole();
    const isOwner = ctx.userId && report.user_id === ctx.userId;
    const isAdminish = ctx.role === "admin" || ctx.role === "manager";
    if (!isOwner && !isAdminish) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    if (report.status === "saved") {
        return NextResponse.json(
            { success: false, error: "This report has already been saved." },
            { status: 400 }
        );
    }

    // Read optional overrides from the body.
    let body: { questions?: ExtractedQuestion[]; sourceName?: string } = {};
    try {
        body = (await request.json().catch(() => ({}))) as typeof body;
    } catch {
        body = {};
    }

    const sourceName = body.sourceName?.trim() || (report.source_name as string) || "Uploaded PDF";
    const questions: ExtractedQuestion[] = Array.isArray(body.questions) && body.questions.length > 0
        ? body.questions
        : (Array.isArray(report.extracted_questions) ? (report.extracted_questions as ExtractedQuestion[]) : []);

    if (questions.length === 0) {
        return NextResponse.json(
            { success: false, error: "No questions to save." },
            { status: 400 }
        );
    }

    const actor = { userId: ctx.userId, now: new Date().toISOString() };
    const savedIds: string[] = [];
    const errors: { questionNumber: number; error: string }[] = [];

    for (const q of questions) {
        try {
            const row = mapExtractedToDBRow(q, sourceName, actor);
            const { error: insertErr } = await supabase.from(TABLE_NAME).insert(row);
            if (insertErr) {
                errors.push({
                    questionNumber: q.questionNumber,
                    error: insertErr.message,
                });
            } else {
                savedIds.push(row.question_id as string);
            }
        } catch (err) {
            errors.push({ questionNumber: q.questionNumber, error: String(err) });
        }
    }

    // Mark the report saved when at least one question landed.
    if (savedIds.length > 0) {
        await supabase
            .from(REPORTS_TABLE)
            .update({
                status: "saved",
                saved_question_ids: savedIds,
                saved_at: new Date().toISOString(),
            })
            .eq("id", id);
    }

    return NextResponse.json({
        success: errors.length === 0,
        savedCount: savedIds.length,
        questionIds: savedIds,
        errors,
    });
}
