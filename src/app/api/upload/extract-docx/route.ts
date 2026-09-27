/**
 * POST /api/upload/extract-docx
 *
 * Word-document ingestion pipeline. Unlike the PDF flow this is fully
 * deterministic on the content path:
 *   1) jszip + paragraph scan splits the .docx into per-question OOXML chunks.
 *   2) Referenced media binaries (WMF/EMF/PNG/JPEG/OLE) are uploaded to the
 *      docx-media Supabase Storage bucket; their rIds + storage paths are
 *      recorded in source_docx.media_refs.
 *   3) A short plain-text snippet of each question is sent to the AI for
 *      metadata tagging (subject / chapter / type / difficulty / class / exam).
 *      The AI never rewrites the content.
 *   4) The list of DocxExtractedQuestion is stored on the pdf_extraction_reports
 *      row (document_type='docx'). The review UI lets the user check + edit
 *      metadata and commit selected rows to qbg_questions.
 */
import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import type {
    DocxExtractedQuestion,
    ExtractionRequest,
    ExtractionResponse,
} from "@/types/extraction";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { ingestDocx } from "@/lib/api/docxIngest";
import { tagDocxQuestionsMetadata } from "@/lib/api/aiAdapters";

export const maxDuration = 300;

const REPORTS_TABLE = "pdf_extraction_reports";

interface ExtractDocxRequest extends ExtractionRequest {
    questionsDocxBase64?: string;
    solutionsDocxBase64?: string;
}

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;

    try {
        const body = (await request.json()) as ExtractDocxRequest;

        if (!body.questionsDocxBase64) {
            return NextResponse.json(
                { success: false, error: "Questions DOCX is required" } as ExtractionResponse,
                { status: 400 }
            );
        }
        if (!body.provider) {
            return NextResponse.json(
                { success: false, error: "AI model provider is required" } as ExtractionResponse,
                { status: 400 }
            );
        }
        if (body.mode === "dual" && !body.solutionsDocxBase64) {
            return NextResponse.json(
                { success: false, error: "Solutions DOCX is required in dual mode" } as ExtractionResponse,
                { status: 400 }
            );
        }

        const supabase = await createClient();

        // Resolve API key (request override > stored profile key > dev header).
        let resolvedApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!resolvedApiKey) {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[body.provider] || "";
            } else if (hasDevAuthCookie(request.cookies)) {
                resolvedApiKey = request.headers.get("x-dev-api-key")?.trim() || "";
            }
        }
        if (!resolvedApiKey) {
            return NextResponse.json(
                {
                    success: false,
                    questions: [],
                    pdfType: "questions_only",
                    totalPages: 0,
                    warnings: [],
                    error: `No saved API key found for ${body.provider}. Add it from the user icon.`,
                } as ExtractionResponse,
                { status: 400 }
            );
        }

        const ctx = await getCurrentUserWithRole();
        const questionsBytes = approxBase64Bytes(body.questionsDocxBase64);
        const solutionsBytes = body.solutionsDocxBase64 ? approxBase64Bytes(body.solutionsDocxBase64) : null;

        // Persist a processing row up-front so the user can navigate to the
        // report mid-extraction.
        const { data: reportRow, error: insertErr } = await supabase
            .from(REPORTS_TABLE)
            .insert({
                user_id: ctx.userId,
                user_email: ctx.email,
                source_name: body.sourceName || "Uploaded Word File",
                mode: body.mode || "single",
                document_type: "docx",
                provider: body.provider,
                model_id: body.modelId || null,
                questions_pdf_name: body.questionsPdfName || null,
                questions_pdf_size: questionsBytes,
                solutions_pdf_name: body.solutionsPdfName || null,
                solutions_pdf_size: solutionsBytes,
                status: "processing",
            })
            .select("id")
            .maybeSingle();
        if (insertErr) console.warn("Could not create docx extraction report row:", insertErr);
        const reportId = reportRow?.id as string | undefined;

        try {
            const qBuffer = Buffer.from(body.questionsDocxBase64, "base64");
            const sBuffer = body.solutionsDocxBase64
                ? Buffer.from(body.solutionsDocxBase64, "base64")
                : null;

            // 1) Split (AI-driven boundary detection) + collect raw OOXML +
            //    upload media to Storage. The AI sees only plain-text
            //    paragraph snippets — never the OOXML — so equations and
            //    diagrams come through byte-exact.
            const ingest = await ingestDocx(qBuffer, reportId || crypto.randomUUID(), {
                solutionsBuffer: sBuffer,
                originalFileName: body.questionsPdfName || "Questions.docx",
                solutionsFileName: body.solutionsPdfName || null,
                supabase,
                ai: {
                    provider: body.provider,
                    apiKey: resolvedApiKey,
                    modelId: body.modelId || "gemini-2.5-flash",
                },
            });

            // 2) If any rows still need metadata (AI fallback to regex, or
            //    AI returned partial classification), batch-tag them now.
            const needsTagging = ingest.questions.filter((q) => !q.subject || !q.chapter);
            let tagged: DocxExtractedQuestion[] = ingest.questions;
            if (needsTagging.length > 0) {
                const taggerInput = needsTagging.map((q) => ({
                    q_number: q.questionNumber,
                    snippet: q.questionText,
                }));
                const tags = await tagDocxQuestionsMetadata(
                    body.provider,
                    taggerInput,
                    resolvedApiKey,
                    body.modelId || "gemini-2.5-flash"
                );
                const tagByNum = new Map(tags.map((t) => [t.q_number, t]));
                tagged = ingest.questions.map((q) => {
                    const t = tagByNum.get(q.questionNumber);
                    if (!t) return q;
                    return {
                        ...q,
                        subject: q.subject || t.subject,
                        chapter: q.chapter || t.chapter,
                        topic: q.topic || t.topic,
                        subtopic: q.subtopic || t.subtopic,
                        classLevel: q.classLevel || t.classLevel,
                        exam: q.exam?.length ? q.exam : t.exam,
                        confidence: q.confidence ?? t.confidence,
                        difficultyLevel: (q.difficultyLevel || t.difficultyLevel) as DocxExtractedQuestion["difficultyLevel"],
                        questionType: (q.questionType || t.questionType) as DocxExtractedQuestion["questionType"],
                    };
                });
            }

            // 3) Persist the completed result.
            if (reportId) {
                await supabase
                    .from(REPORTS_TABLE)
                    .update({
                        status: "completed",
                        pdf_type: body.mode === "dual" ? "questions_and_solutions" : "questions_only",
                        total_pages: ingest.paragraphCount,
                        warnings: ingest.warnings,
                        extracted_questions: tagged,
                    })
                    .eq("id", reportId);
            }

            return NextResponse.json({
                success: true,
                questions: tagged,
                pdfType: body.mode === "dual" ? "questions_and_solutions" : "questions_only",
                totalPages: ingest.paragraphCount,
                warnings: ingest.warnings,
                reportId,
            } as ExtractionResponse);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (reportId) {
                await supabase
                    .from(REPORTS_TABLE)
                    .update({ status: "failed", error: msg })
                    .eq("id", reportId);
            }
            throw err;
        }
    } catch (err) {
        console.error("DOCX ingest API error:", err);
        return NextResponse.json(
            {
                success: false,
                questions: [],
                pdfType: "questions_only",
                totalPages: 0,
                warnings: [],
                error: `Extraction failed: ${String(err)}`,
            } as ExtractionResponse,
            { status: 500 }
        );
    }
}

function approxBase64Bytes(base64: string): number {
    if (!base64) return 0;
    const stripped = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
    return Math.floor((stripped.length * 3) / 4);
}
