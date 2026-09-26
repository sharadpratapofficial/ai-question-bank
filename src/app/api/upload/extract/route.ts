/**
 * POST /api/upload/extract
 *
 * Extracts questions from a PDF via the chosen AI provider. The extracted
 * result is now ALSO persisted to public.pdf_extraction_reports so the user
 * can navigate away mid-extraction and come back to the report later.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractQuestionsFromPDF } from "@/lib/api/aiAdapters";
import type { ExtractionRequest, ExtractionResponse } from "@/types/extraction";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";

export const maxDuration = 120;

const REPORTS_TABLE = "pdf_extraction_reports";

export async function POST(request: NextRequest) {
    const forbid = await checkPermission("upload_pdf");
    if (forbid) return forbid;
    try {
        const body = (await request.json()) as ExtractionRequest;

        if (!body.questionsPdfBase64) {
            return NextResponse.json(
                { success: false, error: "Questions PDF is required" } as ExtractionResponse,
                { status: 400 }
            );
        }

        if (!body.provider) {
            return NextResponse.json(
                { success: false, error: "AI model provider is required" } as ExtractionResponse,
                { status: 400 }
            );
        }

        if (
            body.provider === "local" ||
            body.provider === "g4f" ||
            body.provider === "groq" ||
            body.provider === "nvidia" ||
            body.provider === "fireworks" ||
            body.provider === "custom_openai"
        ) {
            const providerName =
                body.provider === "local" ? "Local models" :
                body.provider === "g4f" ? "gpt4free" :
                body.provider === "groq" ? "Groq" :
                body.provider === "nvidia" ? "NVIDIA NIM" :
                body.provider === "fireworks" ? "Fireworks AI" :
                "OpenAI-compatible providers";
            return NextResponse.json(
                { success: false, error: `${providerName} does not support PDF extraction. Please use Gemini, OpenAI, or OpenRouter.` } as ExtractionResponse,
                { status: 400 }
            );
        }

        if (body.mode === "dual" && !body.solutionsPdfBase64) {
            return NextResponse.json(
                { success: false, error: "Solutions PDF is required in dual mode" } as ExtractionResponse,
                { status: 400 }
            );
        }

        let resolvedApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const supabase = await createClient();
        if (!resolvedApiKey) {
            const {
                data: { user },
            } = await supabase.auth.getUser();

            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[body.provider] || "";
            } else if (request.cookies.get("qbg_dev_auth")?.value === "1") {
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

        // Insert a 'processing' report up-front so the client can poll it / see
        // a stub even if the network request is interrupted.
        const ctx = await getCurrentUserWithRole();
        const questionsBytes = approxBase64Bytes(body.questionsPdfBase64);
        const solutionsBytes = body.solutionsPdfBase64
            ? approxBase64Bytes(body.solutionsPdfBase64)
            : null;

        const { data: reportRow, error: insertErr } = await supabase
            .from(REPORTS_TABLE)
            .insert({
                user_id: ctx.userId,
                user_email: ctx.email,
                source_name: body.sourceName || "Uploaded PDF",
                mode: body.mode || "single",
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

        const reportId = reportRow?.id as string | undefined;
        if (insertErr) {
            console.warn("Could not create extraction report row:", insertErr);
        }

        try {
            const result = await extractQuestionsFromPDF(body.provider, {
                questionsPdfBase64: body.questionsPdfBase64,
                solutionsPdfBase64: body.solutionsPdfBase64,
                apiKey: resolvedApiKey,
                modelId: body.modelId || "gemini-2.5-flash",
                mode: body.mode || "single",
                sourceName: body.sourceName || "Uploaded PDF",
            });

            // Persist the completed result onto the report row.
            if (reportId) {
                await supabase
                    .from(REPORTS_TABLE)
                    .update({
                        status: "completed",
                        pdf_type: result.pdfType,
                        total_pages: result.totalPages,
                        warnings: result.warnings,
                        extracted_questions: result.questions,
                    })
                    .eq("id", reportId);
            }

            return NextResponse.json({
                success: true,
                questions: result.questions,
                pdfType: result.pdfType,
                totalPages: result.totalPages,
                warnings: result.warnings,
                reportId,
            } as ExtractionResponse);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (reportId) {
                await supabase
                    .from(REPORTS_TABLE)
                    .update({
                        status: "failed",
                        error: msg,
                    })
                    .eq("id", reportId);
            }
            throw err;
        }
    } catch (err) {
        console.error("Extraction API error:", err);
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

/** Rough size in bytes from a base64 string — for display only, no validation. */
function approxBase64Bytes(base64: string): number {
    if (!base64) return 0;
    const stripped = base64.startsWith("data:")
        ? base64.slice(base64.indexOf(",") + 1)
        : base64;
    return Math.floor((stripped.length * 3) / 4);
}
