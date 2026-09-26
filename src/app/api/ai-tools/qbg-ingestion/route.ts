/**
 * POST /api/ai-tools/qbg-ingestion
 *
 * The QBG Ingestion endpoint. Takes a question Word file (and an optional separate
 * solutions file), has the AI extract each question + correct answer + type +
 * worked solution (solving / authoring / drawing anything missing, via the Python
 * sidecar), and returns the interactive HTML pack (zip base64), the QBG-format CSV,
 * the per-question records + provenance, and optionally injects into this app's
 * question bank and/or pushes to the external QBG API.
 *
 * Body (application/json):
 *   questionFileBase64  string   base64 of the question .docx/.doc, or of a
 *                            structured .html paper (parsed with no AI) (required)
 *   questionFileName    string
 *   solutionFileBase64? string   base64 of a separate solutions .docx/.doc
 *   solutionFileName?   string
 *   provider    one of QBG_INGEST_PROVIDERS
 *   modelId     string
 *   solveMissing?   boolean  AI solves questions with no stated answer (default true)
 *   authorMissing?  boolean  AI writes a solution when none is present (default true)
 *   richSolution?   boolean  TEMPORARY (RankUp): keep Effective Approach / Checks /
 *                            Wrong Answer Analysis in the solution, not just the working
 *   genDiagrams?    boolean  AI draws a figure when one is described but absent
 *   imgProvider?    "gemini" | "openai"
 *   imgModel?       string
 *   injectToDb?     boolean
 *   pushToQbg?      boolean
 *   category?       string   QBG category_configuration_id (with pushToQbg)
 *   dbDefaults?     { subject?, chapter?, source?, exam?: string[] }
 *
 * QBG (PenPencil) credentials are read from the caller's saved "qbg" vault key.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import {
    sanitizeUserApiKeys,
    parseQbgProviderConfig,
    getProviderApiCredential,
    providerNeedsApiKey,
    getProviderBaseUrl,
    type SupportedApiProvider,
} from "@/lib/userApiKeys";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { TABLE_NAME } from "@/lib/constants";
import {
    createReframeJob,
    completeReframeJob,
    failReframeJob,
    getReframeJob,
    deleteReframeJob,
    appendJobProgress,
    getJobProgress,
    embedFigures,
    type QbgCreds,
} from "@/lib/api/qbgModification";
import { createTask, completeTask, failTask } from "@/lib/api/qbgTaskStore";
import {
    ingestWordFile,
    QBG_INGEST_PROVIDERS,
    type QbgIngestProvider,
    type IngestResult,
} from "@/lib/api/qbgIngestion";

export const maxDuration = 300;
export const runtime = "nodejs";

interface Body {
    questionFileBase64?: string;
    questionFileName?: string;
    solutionFileBase64?: string;
    solutionFileName?: string;
    provider?: string;
    modelId?: string;
    solveMissing?: boolean;
    authorMissing?: boolean;
    richSolution?: boolean;
    htmlAi?: boolean;
    genDiagrams?: boolean;
    imgProvider?: "gemini" | "openai";
    imgModel?: string;
    injectToDb?: boolean;
    pushToQbg?: boolean;
    category?: string;
    dbDefaults?: { subject?: string; chapter?: string; source?: string; exam?: string[] };
}

function isSupportedProvider(v: string): v is QbgIngestProvider {
    return (QBG_INGEST_PROVIDERS as readonly string[]).includes(v);
}

const DOC_RE = /\.(docx?)$/i;
/** What the question file may be. HTML is read directly by the sidecar — see
 *  python/qbg_modification/html_ingest.py — so it costs no model tokens. */
const QUESTION_FILE_RE = /\.(docx?|html?|xhtml)$/i;

// QBG question type -> the app bank's question_type label.
const TYPE_LABEL: Record<string, string> = {
    SCQ: "Single_Choice(SCQ)",
    MCQ: "Multiple_Choice(MCQ)",
    Numerical: "Numerical",
};

function buildRows(result: IngestResult, defaults: Body["dbDefaults"]) {
    const source = defaults?.source?.trim() || `${result.sourceName} (QBG Ingestion)`;
    return result.records.map((rec, i) => {
        const q = result.questions[i] || {};
        const meta = result.meta[i];
        const qType = (meta?.type as string) || "SCQ";
        const hasOptions = Array.isArray(rec.options) && rec.options.length > 0;
        const options = (rec.options || []).map(([isCorrect, text]) => ({
            text: embedFigures(text || "", result.figures),
            isCorrect: isCorrect === true,
        }));
        // SCQ -> 1-indexed correct option number. MCQ -> array of correct option
        // numbers. Numerical -> the numeric value string.
        let answerKey: number | number[] | string | null = null;
        if (qType === "Numerical") {
            answerKey = typeof meta?.answer === "string" ? meta.answer : null;
        } else if (hasOptions) {
            const correct = options
                .map((o, idx) => (o.isCorrect ? idx + 1 : 0))
                .filter((n) => n > 0);
            answerKey = qType === "MCQ" ? correct : correct.length > 0 ? correct[0] : null;
        }
        const questionId =
            typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${i}`;
        return {
            question_id: questionId,
            qbg_id: questionId,
            question_text: embedFigures(rec.content || "", result.figures),
            options,
            answer_key: answerKey,
            solution_text: embedFigures(rec.solution || "", result.figures),
            question_type: TYPE_LABEL[qType] || TYPE_LABEL.SCQ,
            subject: defaults?.subject?.trim() || "",
            chapter: (typeof q.chapter === "string" && q.chapter) || defaults?.chapter?.trim() || "",
            topic: "",
            subtopic: null,
            source,
            difficutly_level: "Medium",
            class_level: null,
            exam: Array.isArray(defaults?.exam) && defaults!.exam!.length > 0 ? defaults!.exam : null,
            parent_question_id: null,
            raw_data: null,
        };
    });
}

/** Save a completed ingestion to ai_reports (best-effort). */
async function persistReport(
    accessToken: string,
    userId: string,
    meta: { fileName: string; provider: string; modelId: string },
    reportData: Record<string, unknown>
): Promise<void> {
    if (!accessToken || !userId) return;
    try {
        const db = createAnonClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                auth: { persistSession: false, autoRefreshToken: false },
                global: { headers: { Authorization: `Bearer ${accessToken}` } },
            }
        );
        const { error } = await db.from("ai_reports").insert({
            user_id: userId,
            report_type: "qbg_ingestion",
            file_name: meta.fileName,
            provider: meta.provider,
            model_id: meta.modelId,
            report_data: reportData,
        });
        if (error) console.error("[qbg-ingestion] ai_reports insert failed:", error.message);
    } catch (err) {
        console.error("[qbg-ingestion] persistReport error:", err);
    }
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    try {
        const body = (await req.json()) as Body;
        const { questionFileBase64, questionFileName, provider, modelId } = body;
        const solveMissing = body.solveMissing !== false;
        const authorMissing = body.authorMissing !== false;
        // TEMPORARY (RankUp Test Series) — opt-in, so every other paper keeps the
        // worked-solution-only behaviour it has today.
        const richSolution = body.richSolution === true;
        // Opt-in: an HTML paper is read structurally first (that path copies the
        // document instead of re-writing it) and falls back to the AI by itself.
        const htmlAi = body.htmlAi === true;
        const genDiagrams = body.genDiagrams === true;
        const injectToDb = body.injectToDb === true;
        const pushToQbg = body.pushToQbg === true;
        const imgProvider: "gemini" | "openai" = body.imgProvider === "openai" ? "openai" : "gemini";

        if (!provider || !isSupportedProvider(provider)) {
            return NextResponse.json(
                { success: false, error: `Provider must be one of: ${QBG_INGEST_PROVIDERS.join(", ")}.` },
                { status: 400 }
            );
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "A model id is required." }, { status: 400 });
        }
        if (!questionFileBase64 || !questionFileName) {
            return NextResponse.json({ success: false, error: "A question file is required." }, { status: 400 });
        }
        if (!QUESTION_FILE_RE.test(questionFileName)) {
            return NextResponse.json(
                { success: false, error: "The question file must be a .doc, .docx or .html." },
                { status: 400 }
            );
        }
        if (body.solutionFileName && !DOC_RE.test(body.solutionFileName)) {
            return NextResponse.json({ success: false, error: "The solutions file must be a .doc or .docx." }, { status: 400 });
        }

        const questionBuffer = Buffer.from(questionFileBase64, "base64");
        if (questionBuffer.length > 25 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: "Question file too large (max 25 MB)." }, { status: 413 });
        }
        let solutionBuffer: Buffer | undefined;
        if (body.solutionFileBase64) {
            solutionBuffer = Buffer.from(body.solutionFileBase64, "base64");
            if (solutionBuffer.length > 25 * 1024 * 1024) {
                return NextResponse.json({ success: false, error: "Solutions file too large (max 25 MB)." }, { status: 413 });
            }
        }

        // Resolve keys/credentials server-side (never trust the client with them).
        let apiKey = "";
        let baseUrl = "";
        let qbgCreds: QbgCreds | undefined;
        const supabase = await createServerClient();
        const { data: { user } } = await supabase.auth.getUser();
        const isDev = req.cookies.get("qbg_dev_auth")?.value === "1";
        const prov = provider as SupportedApiProvider;
        let accessToken = "";
        let imgApiKey = "";
        const userId = user?.id || "";
        if (user) {
            const keys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
            const raw = keys[provider] || "";
            apiKey = providerNeedsApiKey(prov) ? getProviderApiCredential(prov, raw) : "";
            baseUrl = getProviderBaseUrl(prov, raw);
            qbgCreds = parseQbgProviderConfig(keys.qbg);
            if (genDiagrams) imgApiKey = keys[imgProvider] || "";
            const { data: { session } } = await supabase.auth.getSession();
            accessToken = session?.access_token || "";
        } else if (isDev) {
            apiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            baseUrl = req.headers.get("x-dev-base-url")?.trim() || "";
            if (genDiagrams) imgApiKey = req.headers.get("x-dev-img-key")?.trim() || "";
            const rawQbg = req.headers.get("x-dev-qbg")?.trim();
            if (rawQbg) qbgCreds = parseQbgProviderConfig(rawQbg);
        }
        if (providerNeedsApiKey(prov) && !apiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon → Manage API Keys.` },
                { status: 400 }
            );
        }
        if ((provider === "custom_openai" || provider === "local") && !baseUrl) {
            return NextResponse.json(
                { success: false, error: `A base URL is required for ${provider}. Set it under Manage API Keys.` },
                { status: 400 }
            );
        }
        if (pushToQbg && !(qbgCreds && qbgCreds.token && qbgCreds.user && qbgCreds.userId)) {
            return NextResponse.json(
                { success: false, error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API." },
                { status: 400 }
            );
        }
        if (pushToQbg && !body.category) {
            return NextResponse.json({ success: false, error: "Choose a QBG category to push to." }, { status: 400 });
        }
        if (genDiagrams && !imgApiKey) {
            const label = imgProvider === "openai" ? "OpenAI" : "Gemini";
            return NextResponse.json(
                { success: false, error: `AI diagram generation needs a ${label} API key. Add it under Manage API Keys.` },
                { status: 400 }
            );
        }

        // Validated — run the (long) pipeline in the background, return a jobId; poll GET.
        const jobId = createReframeJob();
        // Record the task in the DB immediately (status "running") so it shows in
        // "Previous tasks" from the moment it's submitted — session-free, like Agentic QC.
        const { userId: taskUserId } = await getCurrentUserWithRole();
        await createTask({
            id: jobId,
            userId: taskUserId,
            taskType: "qbg_ingestion",
            label: questionFileName || "ingestion",
            provider,
            modelId,
        });
        void (async () => {
            try {
                const result = await ingestWordFile({
                    questionBuffer,
                    questionName: questionFileName,
                    solutionBuffer,
                    solutionName: body.solutionFileName,
                    provider,
                    modelId,
                    apiKey,
                    baseUrl: baseUrl || undefined,
                    solveMissing,
                    authorMissing,
                    richSolution,
                    htmlAi,
                    genDiagrams,
                    imgProvider,
                    imgModel: body.imgModel,
                    imgApiKey,
                    qbgPush: pushToQbg,
                    category: body.category,
                    qbgCreds: pushToQbg ? qbgCreds : undefined,
                    onProgress: (ev) => appendJobProgress(jobId, ev),
                });

                const previewRecords = result.records.map((rec, i) => ({
                    content: embedFigures(rec.content || "", result.figures),
                    options: (rec.options || []).map(([isCorrect, text]) => ({
                        isCorrect,
                        text: embedFigures(text || "", result.figures),
                    })),
                    solution: embedFigures(rec.solution || "", result.figures),
                    meta: result.meta[i] || null,
                }));

                let injected:
                    | { savedCount: number; questionIds: string[]; errors: { questionNumber: number; error: string }[] }
                    | undefined;
                if (injectToDb) {
                    const rows = buildRows(result, body.dbDefaults);
                    const anon = createAnonClient(
                        process.env.NEXT_PUBLIC_SUPABASE_URL!,
                        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
                    );
                    const questionIds: string[] = [];
                    const errors: { questionNumber: number; error: string }[] = [];
                    for (let i = 0; i < rows.length; i++) {
                        const { error } = await anon.from(TABLE_NAME).insert(rows[i]);
                        if (error) errors.push({ questionNumber: i + 1, error: error.message });
                        else questionIds.push(rows[i].question_id);
                    }
                    injected = { savedCount: questionIds.length, questionIds, errors };
                }

                const reportData = {
                    status: "done" as const,
                    sourceName: result.sourceName,
                    questionCount: result.questionCount,
                    requestedCount: result.requestedCount,
                    provider,
                    modelId,
                    records: previewRecords,
                    meta: result.meta,
                    modifiedCsv: result.modifiedCsv,
                    injected,
                    qbgResults: result.qbgResults,
                    qbgError: result.qbgError,
                    warnings: result.warnings,
                    patternUsed: result.patternUsed,
                    patternLearned: result.patternLearned,
                };

                completeReframeJob(jobId, {
                    success: true,
                    ...reportData,
                    zipBase64: result.zipBuffer.toString("base64"),
                    zipName: result.zipName,
                });

                // Session-free DB history (qbg_tasks) — the old ai_reports write needed a
                // cookie session the background job often lacked, so tasks vanished.
                await completeTask(jobId, reportData);
                await persistReport(accessToken, userId,
                    { fileName: questionFileName || result.sourceName, provider, modelId }, reportData);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                failReframeJob(jobId, msg);
                await failTask(jobId, msg);
            }
        })();

        return NextResponse.json({ success: true, jobId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: `QBG ingestion failed: ${msg}` }, { status: 500 });
    }
}

// Poll for a job's result. Mirrors the modification route's GET.
export async function GET(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) {
        return NextResponse.json({ success: false, error: "jobId is required." }, { status: 400 });
    }
    const job = getReframeJob(jobId);
    if (!job) {
        return NextResponse.json(
            { success: false, state: "error", error: "Job not found — it may have expired. Please try again." },
            { status: 404 }
        );
    }
    if (job.state === "running") {
        return NextResponse.json({ success: true, state: "running", progress: getJobProgress(jobId) });
    }
    if (job.state === "error") {
        const error = job.error || "Ingestion failed.";
        deleteReframeJob(jobId);
        return NextResponse.json({ success: false, state: "error", error: `QBG ingestion failed: ${error}` });
    }
    const payload = job.result as Record<string, unknown>;
    deleteReframeJob(jobId);
    return NextResponse.json({ state: "done", ...payload });
}
