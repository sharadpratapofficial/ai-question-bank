/**
 * POST /api/tests/generate-word
 *
 * Generates a .docx test paper from a list of question IDs whose source rows
 * have `source_docx` populated (i.e. they were ingested via the Word upload
 * pipeline). The output preserves equations + diagrams byte-exact because we
 * stitch the original OOXML chunks rather than re-rendering anything.
 *
 * Body:
 *   {
 *     question_ids: string[],   // must already have source_docx
 *     title?: string,
 *     subtitle?: string
 *   }
 *
 * Response: application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *           with Content-Disposition: attachment; filename="…docx"
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { buildWordTest } from "@/lib/api/wordTestBuilder";

export const maxDuration = 120;

const TABLE = "qbg_questions";

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;

    let body: { question_ids?: string[]; title?: string; subtitle?: string };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON payload." }, { status: 400 });
    }

    const ids = Array.isArray(body.question_ids) ? body.question_ids.filter((x) => typeof x === "string") : [];
    if (ids.length === 0) {
        return NextResponse.json({ success: false, error: "question_ids is required." }, { status: 400 });
    }
    if (ids.length > 500) {
        return NextResponse.json({ success: false, error: "Maximum 500 questions per test." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
        .from(TABLE)
        .select("question_id, subject, answer_key, options, question_type, source_docx")
        .in("question_id", ids);

    if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
        return NextResponse.json({ success: false, error: "No matching questions found." }, { status: 404 });
    }

    // Preserve the order the caller asked for.
    type Row = typeof data[number];
    const byId = new Map<string, Row>(data.map((r) => [r.question_id as string, r]));
    const ordered: Row[] = [];
    for (const id of ids) {
        const r = byId.get(id);
        if (r) ordered.push(r);
    }

    // Filter to rows that actually carry a source_docx payload — others are
    // PDF/AI/manual rows and can't be rendered through this raw-OOXML path.
    const withDocx = ordered.filter((r) => r.source_docx != null);
    if (withDocx.length === 0) {
        return NextResponse.json(
            {
                success: false,
                error: "None of the selected questions have a Word-source payload. Make sure the 'Word source only' filter is on when picking questions.",
            },
            { status: 400 }
        );
    }

    try {
        const built = await buildWordTest({
            questions: withDocx.map((r) => ({
                question_id: r.question_id as string,
                subject: r.subject as string,
                answer_key: r.answer_key as number | number[] | null,
                options: r.options as Parameters<typeof buildWordTest>[0]["questions"][number]["options"],
                question_type: r.question_type as string,
                source_docx: r.source_docx as Parameters<typeof buildWordTest>[0]["questions"][number]["source_docx"],
            })),
            title: body.title || "Test Paper",
            subtitle: body.subtitle,
            supabase,
        });

        const filename = sanitizeFileName(`${body.title || "test-paper"}.docx`);
        return new NextResponse(built.buffer as unknown as ArrayBuffer, {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "X-Included-Count": String(built.includedCount),
                "X-Skipped-Count": String(built.skippedCount),
                "X-Warnings": JSON.stringify(built.warnings).slice(0, 1000),
            },
        });
    } catch (err) {
        console.error("Word test generation failed:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}

function sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "test-paper.docx";
}
