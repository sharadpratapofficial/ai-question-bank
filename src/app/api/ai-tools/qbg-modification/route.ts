/**
 * POST /api/ai-tools/qbg-modification
 *
 * The QBG Modification (MCQ Reframer) endpoint. Takes a Word (.docx) test,
 * reframes every MCQ with the chosen AI provider (via the Python sidecar), and
 * returns the interactive HTML pack (zip, base64), the QBG-format CSVs, and the
 * per-question records. Optionally injects the reframed questions straight into
 * the Supabase question bank.
 *
 * Body (application/json):
 *   source      "docx" | "qbg"   input source (default "docx")
 *   fileBase64  string   base64 of the .docx (source "docx")
 *   fileName    string
 *   qbgIds      string   QBG unique_ids, comma/space separated (source "qbg")
 *   provider    "openai" | "anthropic" | "gemini" | "openrouter"
 *   modelId     string
 *   sendImages? boolean  send diagram images to the model (default true)
 *   injectToDb? boolean  also insert reframed questions into this app's bank
 *   pushToQbg?  boolean  also POST reframed questions to the external QBG API
 *   category?   string   QBG category_configuration_id (with pushToQbg)
 *   dbDefaults? { subject?, chapter?, source?, exam?: string[] }
 *
 * QBG (PenPencil) credentials are read from the caller's saved "qbg" vault key.
 */
import { hasDevAuthCookie } from "@/lib/auth/devAuth";
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
import { createTask, completeTask, failTask, startHeartbeat } from "@/lib/api/qbgTaskStore";
import { TABLE_NAME } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase/env";
import {
    reframe,
    embedFigures,
    createReframeJob,
    completeReframeJob,
    failReframeJob,
    getReframeJob,
    deleteReframeJob,
    appendJobProgress,
    getJobProgress,
    QBG_MOD_PROVIDERS,
    type QbgModProvider,
    type QbgCreds,
    type ReframeResult,
} from "@/lib/api/qbgModification";

export const maxDuration = 300;
export const runtime = "nodejs";

interface Body {
    source?: "docx" | "qbg";
    fileBase64?: string;
    fileName?: string;
    qbgIds?: string;
    provider?: string;
    modelId?: string;
    sendImages?: boolean;
    injectToDb?: boolean;
    pushToQbg?: boolean;
    category?: string;
    regenDiagrams?: boolean;
    redrawAllFigures?: boolean;
    verifyDiagrams?: boolean;
    /** QC every reframed question with a (vision-capable) model before pushing. */
    qc?: boolean;
    qcProvider?: string;
    qcModel?: string;
    addFigures?: boolean;
    genSolutionDiagrams?: boolean;
    imgProvider?: "gemini" | "openai";
    imgModel?: string;
    mode?: "paraphrase" | "vary_numbers" | "full_rewrite";
    /** Chapters this test is drawn from, per subject, plus everything earlier in
     *  the book that a question may lean on. Keeps a reframe from reaching into
     *  material the student hasn't been taught. */
    syllabus?: { subject: string; chapters: string[]; permitted: string[] }[];
    difficulty?: "auto" | "harder" | "much_harder";
    /** Every question solvable by hand — no calculator-grade arithmetic. */
    noCalculator?: boolean;
    /** Most questions conceptual rather than calculation-heavy. */
    conceptual?: boolean;
    /** {qbg_id: SCQ|MCQ|NUMERICAL|MATCHING_LIST|ASSERTION_REASON} — seeds to rewrite
     *  as another type (source "qbg" only). */
    targetTypes?: Record<string, string>;
    dbDefaults?: { subject?: string; chapter?: string; source?: string; exam?: string[] };
}

const TARGET_TYPES = ["SCQ", "MCQ", "NUMERICAL", "MATCHING_LIST", "ASSERTION_REASON"];
/** Keep only well-formed {id: known type} pairs; anything else is dropped, not guessed. */
function sanitizeTargetTypes(v: unknown): Record<string, string> | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [id, t] of Object.entries(v as Record<string, unknown>)) {
        const type = String(t || "").toUpperCase();
        if (id.trim() && TARGET_TYPES.includes(type)) out[id.trim()] = type;
    }
    return Object.keys(out).length ? out : undefined;
}

const REFRAME_MODES = ["paraphrase", "vary_numbers", "full_rewrite"] as const;
function isReframeMode(v: unknown): v is (typeof REFRAME_MODES)[number] {
    return typeof v === "string" && (REFRAME_MODES as readonly string[]).includes(v);
}

const REFRAME_DIFFICULTIES = ["auto", "harder", "much_harder"] as const;
function isReframeDifficulty(v: unknown): v is (typeof REFRAME_DIFFICULTIES)[number] {
    return typeof v === "string" && (REFRAME_DIFFICULTIES as readonly string[]).includes(v);
}

function isSupportedProvider(v: string): v is QbgModProvider {
    return (QBG_MOD_PROVIDERS as readonly string[]).includes(v);
}

function buildRows(result: ReframeResult, defaults: Body["dbDefaults"]) {
    const source = defaults?.source?.trim() || `${result.sourceName} (QBG Modification)`;
    return result.records.map((rec, i) => {
        const q = result.questions[i] || {};
        const hasOptions = Array.isArray(rec.options) && rec.options.length > 0;
        const options = (rec.options || []).map(([isCorrect, text]) => ({
            text: embedFigures(text || "", result.figures),
            isCorrect: isCorrect === true,
        }));
        // 1-indexed correct option number for SCQ; null for numeric/no-option.
        const correctIdx = options.findIndex((o) => o.isCorrect);
        const answerKey = hasOptions && correctIdx >= 0 ? correctIdx + 1 : null;
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
            question_type: hasOptions ? "Single_Choice(SCQ)" : "Numerical",
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

/** Save a completed reframe to ai_reports (as the user, via their access token)
 *  so it shows up in history later. Best-effort — never throws. */
async function persistReport(
    accessToken: string,
    userId: string,
    meta: { fileName: string; provider: string; modelId: string },
    reportData: Record<string, unknown>
): Promise<void> {
    if (!accessToken || !userId) return;
    try {
        const db = createAnonClient(
            getSupabaseUrl(),
            getSupabasePublishableKey(),
            {
                auth: { persistSession: false, autoRefreshToken: false },
                global: { headers: { Authorization: `Bearer ${accessToken}` } },
            }
        );
        const { error } = await db.from("ai_reports").insert({
            user_id: userId,
            report_type: "qbg_modification",
            file_name: meta.fileName,
            provider: meta.provider,
            model_id: meta.modelId,
            report_data: reportData,
        });
        if (error) console.error("[qbg-modification] ai_reports insert failed:", error.message);
    } catch (err) {
        console.error("[qbg-modification] persistReport error:", err);
    }
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    try {
        const body = (await req.json()) as Body;
        const { fileBase64, fileName, provider, modelId } = body;
        const source = body.source === "qbg" ? "qbg" : "docx";
        const sendImages = body.sendImages !== false;
        const injectToDb = body.injectToDb === true;
        const pushToQbg = body.pushToQbg === true;
        const regenDiagrams = body.regenDiagrams === true;
        // Only meaningful together with regenDiagrams — that option is what puts "fig_edit"
        // in the AI's schema at all; this one makes filling it mandatory.
        const redrawAllFigures = regenDiagrams && body.redrawAllFigures === true;
        // Defaults to ON: only an explicit false turns the redrawn-diagram check off.
        // It is what catches an image editor that drew the wrong digits, so opting
        // out has to be deliberate (see python/qbg_modification/figcheck.py).
        const verifyDiagrams = body.verifyDiagrams !== false;
        // QC runs after the diagrams are drawn and before anything is pushed. Its
        // model is chosen separately because it must be able to READ the figure —
        // the reframe model may not be able to.
        const qc = body.qc === true;
        const qcProvider = (body.qcProvider || "").trim() || provider;
        const qcModel = (body.qcModel || "").trim() || modelId;
        const addFigures = body.addFigures === true;
        const genSolutionDiagrams = body.genSolutionDiagrams === true;
        const needsImgKey = regenDiagrams || genSolutionDiagrams || addFigures;
        const imgProvider: "gemini" | "openai" = body.imgProvider === "openai" ? "openai" : "gemini";

        if (!provider || !isSupportedProvider(provider)) {
            return NextResponse.json(
                { success: false, error: `Provider must be one of: ${QBG_MOD_PROVIDERS.join(", ")}.` },
                { status: 400 }
            );
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "A model id is required." }, { status: 400 });
        }

        let docxBuffer: Buffer | undefined;
        if (source === "docx") {
            if (!fileBase64 || !fileName) {
                return NextResponse.json({ success: false, error: "A .docx file is required." }, { status: 400 });
            }
            if (!fileName.toLowerCase().endsWith(".docx")) {
                return NextResponse.json({ success: false, error: "Only .docx files are accepted." }, { status: 400 });
            }
            docxBuffer = Buffer.from(fileBase64, "base64");
            if (docxBuffer.length > 25 * 1024 * 1024) {
                return NextResponse.json({ success: false, error: "File too large (max 25 MB)." }, { status: 413 });
            }
        } else if (!body.qbgIds || !body.qbgIds.trim()) {
            return NextResponse.json({ success: false, error: "Paste at least one QBG unique_id." }, { status: 400 });
        }

        // Resolve keys/credentials server-side (never trust the client with them).
        let apiKey = "";
        let baseUrl = "";
        let qbgCreds: QbgCreds | undefined;
        const supabase = await createServerClient();
        const { data: { user } } = await supabase.auth.getUser();
        const isDev = hasDevAuthCookie(req.cookies);
        const prov = provider as SupportedApiProvider;
        // Access token so the background job can persist a report as this user.
        let accessToken = "";
        let imgApiKey = "";
        // Empty when QC reuses the reframe provider — the sidecar falls back to
        // the reframe key in that case.
        let qcApiKey = "";
        const userId = user?.id || "";
        if (user) {
            const keys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
            const raw = keys[provider] || "";
            apiKey = providerNeedsApiKey(prov) ? getProviderApiCredential(prov, raw) : "";
            baseUrl = getProviderBaseUrl(prov, raw);
            qbgCreds = parseQbgProviderConfig(keys.qbg);
            if (needsImgKey) imgApiKey = keys[imgProvider] || "";
            if (qc && qcProvider !== provider) {
                const rawQc = keys[qcProvider as SupportedApiProvider] || "";
                qcApiKey = getProviderApiCredential(qcProvider as SupportedApiProvider, rawQc);
            }
            const { data: { session } } = await supabase.auth.getSession();
            accessToken = session?.access_token || "";
        } else if (isDev) {
            apiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            baseUrl = req.headers.get("x-dev-base-url")?.trim() || "";
            if (needsImgKey) imgApiKey = req.headers.get("x-dev-img-key")?.trim() || "";
            if (qc && qcProvider !== provider) qcApiKey = req.headers.get("x-dev-qc-key")?.trim() || "";
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

        const needsQbg = source === "qbg" || pushToQbg;
        if (needsQbg && !(qbgCreds && qbgCreds.token && qbgCreds.user && qbgCreds.userId)) {
            return NextResponse.json(
                { success: false, error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API." },
                { status: 400 }
            );
        }
        if (pushToQbg && !body.category) {
            return NextResponse.json({ success: false, error: "Choose a QBG category to push to." }, { status: 400 });
        }
        if (needsImgKey && !imgApiKey) {
            const label = imgProvider === "openai" ? "OpenAI" : "Gemini";
            const requested = [
                regenDiagrams ? "diagram redraw" : null,
                addFigures ? "new-diagram generation" : null,
                genSolutionDiagrams ? "solution-diagram generation" : null,
            ].filter(Boolean) as string[];
            const list = requested.length > 1
                ? `${requested.slice(0, -1).join(", ")} and ${requested[requested.length - 1]}`
                : requested[0];
            const feature = `${list.charAt(0).toUpperCase()}${list.slice(1)} ` +
                (requested.length > 1 ? "need" : "needs");
            return NextResponse.json(
                { success: false, error: `${feature} a ${label} API key. Add it under Manage API Keys.` },
                { status: 400 }
            );
        }

        // Everything is validated. Run the (potentially long) pipeline in the
        // background and return a jobId immediately so a slow reframe can't hit
        // the edge proxy's request-timeout HTML page. The client polls GET.
        const jobId = createReframeJob();
        // DB task row (status "running") — session-free history via qbg_tasks.
        const { userId: taskUserId } = await getCurrentUserWithRole();
        await createTask({
            id: jobId,
            userId: taskUserId,
            taskType: "qbg_modification",
            label: source === "docx"
                ? (fileName || "reframe")
                : `Reframe · ${(body.qbgIds || "").trim().split(/[\s,]+/).filter(Boolean).length} QBG ID(s)`,
            provider,
            modelId,
            heartbeat: true,
        });
        // Alive for exactly as long as the reframe below. If this process dies
        // mid-job — dev recompile, restart, crash — the touches stop with it and
        // listTasks can retire the row within minutes, instead of leaving it
        // claiming "running" for three hours with nothing left to finish it.
        const stopHeartbeat = startHeartbeat(jobId);
        void (async () => {
            try {
                const result = await reframe({
                    source,
                    docxBuffer,
                    docxName: fileName,
                    qbgIds: body.qbgIds,
                    provider,
                    modelId,
                    apiKey,
                    baseUrl: baseUrl || undefined,
                    sendImages,
                    qbgPush: pushToQbg,
                    category: body.category,
                    qbgCreds: needsQbg ? qbgCreds : undefined,
                    regenDiagrams,
                    redrawAllFigures,
                    verifyDiagrams,
                    qc,
                    qcProvider: qc ? qcProvider : undefined,
                    qcModel: qc ? qcModel : undefined,
                    qcApiKey: qc ? qcApiKey : undefined,
                    addFigures,
                    genSolutionDiagrams,
                    imgProvider,
                    imgModel: body.imgModel,
                    imgApiKey,
                    mode: isReframeMode(body.mode) ? body.mode : undefined,
                    syllabus: Array.isArray(body.syllabus) && body.syllabus.length > 0
                        ? body.syllabus
                        : undefined,
                    difficulty: isReframeDifficulty(body.difficulty) ? body.difficulty : undefined,
                    noCalculator: body.noCalculator === true,
                    conceptual: body.conceptual === true,
                    targetTypes: sanitizeTargetTypes(body.targetTypes),
                    onProgress: (ev) => appendJobProgress(jobId, ev),
                });

                const previewRecords = result.records.map((rec) => ({
                    content: embedFigures(rec.content || "", result.figures),
                    options: (rec.options || []).map(([isCorrect, text]) => ({
                        isCorrect,
                        text: embedFigures(text || "", result.figures),
                    })),
                    solution: embedFigures(rec.solution || "", result.figures),
                    answer: rec.answer ?? null,
                }));

                const previewOriginals = (result.originals || []).map((o) => ({
                    content: embedFigures(o.content || "", result.figures),
                    answer: o.answer || "",
                    solution: embedFigures(o.solution || "", result.figures),
                }));

                let injected:
                    | { savedCount: number; questionIds: string[]; errors: { questionNumber: number; error: string }[] }
                    | undefined;
                if (injectToDb) {
                    const rows = buildRows(result, body.dbDefaults);
                    const anon = getSupabaseAdmin();
                    const questionIds: string[] = [];
                    const errors: { questionNumber: number; error: string }[] = [];
                    for (let i = 0; i < rows.length; i++) {
                        const { error } = await anon.from(TABLE_NAME).insert(rows[i]);
                        if (error) errors.push({ questionNumber: i + 1, error: error.message });
                        else questionIds.push(rows[i].question_id);
                    }
                    injected = { savedCount: questionIds.length, questionIds, errors };
                }

                // Payload persisted to history (no big zip base64) so the user can
                // reopen it later from any device/session.
                const reportData = {
                    status: "done" as const,
                    sourceName: result.sourceName,
                    questionCount: result.questionCount,
                    requestedCount: result.requestedCount,
                    source,
                    provider,
                    modelId,
                    records: previewRecords,
                    originals: previewOriginals,
                    modifiedCsv: result.modifiedCsv,
                    originalCsv: result.originalCsv,
                    injected,
                    qbgResults: result.qbgResults,
                    qbgError: result.qbgError,
                    missingIds: result.missingIds,
                    skippedUnsupported: result.skippedUnsupported,
                    diagramResults: result.diagramResults,
                    keyBalance: result.keyBalance,
                    typeConversions: result.typeConversions,
                    qcResults: result.qcResults,
                    qcSummary: result.qcSummary,
                    qcDiagramResults: result.qcDiagramResults,
                    solutionDiagramResults: result.solutionDiagramResults,
                    newFigureResults: result.newFigureResults,
                    warnings: result.warnings,
                };

                completeReframeJob(jobId, {
                    success: true,
                    ...reportData,
                    zipBase64: result.zipBuffer.toString("base64"),
                    zipName: result.zipName,
                });

                await completeTask(jobId, reportData);
                await persistReport(accessToken, userId,
                    { fileName: fileName || result.sourceName, provider, modelId }, reportData);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                failReframeJob(jobId, msg);
                await failTask(jobId, msg);
            } finally {
                // After the terminal write either way, so a heartbeat can never
                // land after it and drag `updated_at` past a finished row.
                stopHeartbeat();
            }
        })();

        return NextResponse.json({ success: true, jobId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: `QBG modification failed: ${msg}` }, { status: 500 });
    }
}

// Poll for a job's result. Returns {state:"running"} while in progress, the full
// result payload when done, or {state:"error"} on failure.
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
        const error = job.error || "Reframe failed.";
        deleteReframeJob(jobId);
        return NextResponse.json({ success: false, state: "error", error: `QBG modification failed: ${error}` });
    }
    // done — hand back the payload and free the memory.
    const payload = job.result as Record<string, unknown>;
    deleteReframeJob(jobId);
    return NextResponse.json({ state: "done", ...payload });
}
