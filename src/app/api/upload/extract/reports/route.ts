/**
 * GET /api/upload/extract/reports
 *
 * Lists PDF extraction reports — the user's own, plus everyone else's if the
 * caller has admin or manager (so a team lead can see what their team has
 * extracted). The extracted_questions blob is stripped from the list payload
 * (use the per-report GET to load it).
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";

const TABLE = "pdf_extraction_reports";

export async function GET() {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;

    const supabase = await createClient();
    const ctx = await getCurrentUserWithRole();

    // Managers/admins see everything; everyone else sees only their own reports.
    const isAdminish = ctx.role === "admin" || ctx.role === "manager";

    let q = supabase
        .from(TABLE)
        .select(
            "id, user_id, user_email, source_name, mode, document_type, provider, model_id, " +
            "questions_pdf_name, questions_pdf_size, solutions_pdf_name, solutions_pdf_size, " +
            "status, pdf_type, total_pages, warnings, error, saved_question_ids, " +
            "saved_at, created_at, updated_at, " +
            "extracted_questions"
        )
        .neq("status", "discarded")
        .order("created_at", { ascending: false })
        .limit(200);

    if (!isAdminish && ctx.userId) {
        q = q.eq("user_id", ctx.userId);
    }

    const { data, error } = await q;
    if (error) {
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        );
    }

    // Strip extracted_questions for size; expose question_count instead.
    type Row = Record<string, unknown> & { extracted_questions?: unknown[] };
    const rows = (data ?? []) as unknown as Row[];
    const reports = rows.map((row) => {
        const qs = Array.isArray(row.extracted_questions) ? row.extracted_questions : [];
        const { extracted_questions: _omit, ...rest } = row;
        return { ...rest, question_count: qs.length };
    });

    return NextResponse.json({ success: true, reports });
}
