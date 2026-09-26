/**
 * POST /api/ai-tools/qbg-tagging
 *
 * The QBG Tagging endpoint. Two modes:
 *   * AI mode  — qbgIds in; the sidecar fetches each question, AI-matches the nearest
 *                subject/chapter/topic/subtopic + difficulty (1/2/3) from the bundled
 *                tagging table, and PUTs the tags to QBG.
 *   * CSV mode — a ready tagging CSV (ids + difficulty already) is PUT directly, no AI.
 *
 * Both modes WRITE to the external QBG software (a PUT that overrides each question's
 * conceptTags + difficulty). The user triggering this action is the authorization.
 *
 * Body (application/json):
 *   mode        "ai" | "csv"
 *   qbgIds?     string   (ai) QBG unique_ids, comma/space/newline separated
 *   tagCsv?     string   (csv) the uploaded tagging CSV text (sample format)
 *   provider?   one of QBG_TAG_PROVIDERS   (ai)
 *   modelId?    string                     (ai)
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
import { readTaxonomySummary } from "@/lib/api/qbgTaxonomy";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { createTask, completeTask, failTask, startHeartbeat } from "@/lib/api/qbgTaskStore";
import { type QbgCreds } from "@/lib/api/qbgModification";
import { QBG_TAG_PROVIDERS, type QbgTagProvider } from "@/lib/api/qbgTagging";
import {
    enqueueTagJob,
    getJob,
    getQueueSnapshot,
    cancelTagJob,
    type PublicTagJob,
} from "@/lib/api/qbgTaggingQueue";

export const maxDuration = 300;
export const runtime = "nodejs";

interface Body {
    mode?: "ai" | "csv";
    /** Subject names the tagger may choose from; empty/absent = all of them. */
    subjects?: string[];
    qbgIds?: string;
    tagCsv?: string;
    provider?: string;
    modelId?: string;
    /** AI mode: match against this category's taxonomy instead of the question's
     *  own — for a QBG category the bundled tagging table doesn't cover. */
    taxonomyCategory?: string;
}

function isSupportedProvider(v: string): v is QbgTagProvider {
    return (QBG_TAG_PROVIDERS as readonly string[]).includes(v);
}

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
            report_type: "qbg_tagging",
            file_name: meta.fileName,
            provider: meta.provider,
            model_id: meta.modelId,
            report_data: reportData,
        });
        if (error) console.error("[qbg-tagging] ai_reports insert failed:", error.message);
    } catch (err) {
        console.error("[qbg-tagging] persistReport error:", err);
    }
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    try {
        const body = (await req.json()) as Body;
        const mode = body.mode === "csv" ? "csv" : "ai";
        const provider = body.provider;
        const modelId = body.modelId;

        if (mode === "ai") {
            if (!provider || !isSupportedProvider(provider)) {
                return NextResponse.json(
                    { success: false, error: `Provider must be one of: ${QBG_TAG_PROVIDERS.join(", ")}.` },
                    { status: 400 }
                );
            }
            if (!modelId) {
                return NextResponse.json({ success: false, error: "A model id is required." }, { status: 400 });
            }
            if (!body.qbgIds || !body.qbgIds.trim()) {
                return NextResponse.json({ success: false, error: "Paste at least one QBG unique_id." }, { status: 400 });
            }
        } else {
            if (!body.tagCsv || !body.tagCsv.trim()) {
                return NextResponse.json({ success: false, error: "Upload a tagging CSV." }, { status: 400 });
            }
        }

        // Resolve keys/credentials server-side (never trust the client with them).
        let apiKey = "";
        let baseUrl = "";
        let qbgCreds: QbgCreds | undefined;
        const supabase = await createServerClient();
        const { data: { user } } = await supabase.auth.getUser();
        const isDev = req.cookies.get("qbg_dev_auth")?.value === "1";
        let accessToken = "";
        const userId = user?.id || "";
        if (user) {
            const keys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
            qbgCreds = parseQbgProviderConfig(keys.qbg);
            if (mode === "ai") {
                const prov = provider as SupportedApiProvider;
                const raw = keys[prov] || "";
                apiKey = providerNeedsApiKey(prov) ? getProviderApiCredential(prov, raw) : "";
                baseUrl = getProviderBaseUrl(prov, raw);
            }
            const { data: { session } } = await supabase.auth.getSession();
            accessToken = session?.access_token || "";
        } else if (isDev) {
            apiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            baseUrl = req.headers.get("x-dev-base-url")?.trim() || "";
            const rawQbg = req.headers.get("x-dev-qbg")?.trim();
            if (rawQbg) qbgCreds = parseQbgProviderConfig(rawQbg);
        }

        if (!(qbgCreds && qbgCreds.token && qbgCreds.user && qbgCreds.userId)) {
            return NextResponse.json(
                { success: false, error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API." },
                { status: 400 }
            );
        }
        if (mode === "ai" && providerNeedsApiKey(provider as SupportedApiProvider) && !apiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon → Manage API Keys.` },
                { status: 400 }
            );
        }
        if (mode === "ai" && (provider === "custom_openai" || provider === "local") && !baseUrl) {
            return NextResponse.json(
                { success: false, error: `A base URL is required for ${provider}. Set it under Manage API Keys.` },
                { status: 400 }
            );
        }

        // Validated — enqueue (starts immediately if nothing else is running for
        // this feature, otherwise waits its turn); poll GET ?queue=1 for status.
        const { userId: taskUserId } = await getCurrentUserWithRole();
        const nIds = mode === "ai" ? (body.qbgIds || "").trim().split(/[\s,]+/).filter(Boolean).length : 0;
        const label = mode === "ai" ? `AI tagging · ${nIds} ID(s)` : "CSV tagging";

        // Heartbeat plumbing. Declared up here because onSettled below closes
        // over it, but only started after createTask has inserted the row —
        // and skipped entirely if the job already settled by then, which a
        // fast CSV tagging run can genuinely do. Without the `settled` guard
        // that race would start a heartbeat nothing ever stops, leaving a
        // finished row looking permanently alive.
        let stopHeartbeat: (() => void) | null = null;
        let settled = false;
        const stopHb = () => {
            settled = true;
            stopHeartbeat?.();
            stopHeartbeat = null;
        };

        const { jobId, position } = enqueueTagJob({
            label,
            mode,
            count: mode === "ai" ? nIds : Math.max(0, (body.tagCsv || "").trim().split("\n").length - 1),
            args: {
                mode,
                qbgIds: body.qbgIds,
                tagCsv: body.tagCsv,
                provider: mode === "ai" ? (provider as QbgTagProvider) : undefined,
                modelId: mode === "ai" ? modelId : undefined,
                taxonomyCategory: mode === "ai" ? (body.taxonomyCategory || "").trim() : undefined,
                subjects: mode === "ai" && Array.isArray(body.subjects)
                    ? body.subjects.map((s) => String(s).trim()).filter(Boolean)
                    : undefined,
                apiKey: mode === "ai" ? apiKey : undefined,
                baseUrl: baseUrl || undefined,
                qbgCreds: qbgCreds!,
            },
            onSettled: (job: PublicTagJob) => {
                // Fire-and-forget history/report persistence — must never block
                // the queue from moving on to the next job.
                void (async () => {
                    try {
                    if (job.status === "done" && job.result) {
                        const reportData = {
                            status: "done" as const,
                            mode: job.result.mode,
                            count: job.result.count,
                            tagged: job.result.tagged,
                            provider: mode === "ai" ? provider : null,
                            modelId: mode === "ai" ? modelId : null,
                            results: job.result.results,
                        };
                        await completeTask(job.id, reportData);
                        await persistReport(accessToken, userId,
                            { fileName: `QBG tagging (${job.result.mode})`, provider: provider || "", modelId: modelId || "" },
                            reportData);
                    } else {
                        await failTask(job.id, job.error || "Tagging failed.");
                    }
                    } finally {
                        // After the terminal write either way, so a late tick
                        // cannot drag `updated_at` past a finished row.
                        stopHb();
                    }
                })();
            },
        });

        // DB task row (status "running") so the run is visible in "Previous tasks"
        // immediately, session-free (see qbgTaskStore) — even while still queued,
        // since qbg_tasks has no separate "queued" status.
        await createTask({
            id: jobId,
            userId: taskUserId,
            taskType: "qbg_tagging",
            label,
            provider: provider || "",
            modelId: modelId || "",
            heartbeat: true,
        });
        // Covers the queued wait as well as the run itself — both read as
        // "running" on the row, so both need to look alive.
        if (!settled) stopHeartbeat = startHeartbeat(jobId);

        return NextResponse.json({ success: true, jobId, position });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: `QBG tagging failed: ${msg}` }, { status: 500 });
    }
}

// GET ?queue=1            -> the whole queue (running + queued + recently finished).
// GET ?jobId=<id>          -> one job's status, non-destructive (safe for multiple
//                             concurrent pollers — see qbgTaggingQueue.ts's getJob()).
export async function GET(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const url = new URL(req.url);
    if (url.searchParams.get("taxonomy")) {
        // Category + subject lists for the panel's pickers, read from the bundled
        // tagging table so they can never drift from what the tagger can match.
        try {
            return NextResponse.json({ success: true, ...(await readTaxonomySummary()) });
        } catch (err) {
            return NextResponse.json(
                { success: false, error: err instanceof Error ? err.message : String(err) },
                { status: 500 }
            );
        }
    }
    if (url.searchParams.get("queue")) {
        return NextResponse.json({ success: true, jobs: getQueueSnapshot() });
    }

    const jobId = url.searchParams.get("jobId");
    if (!jobId) {
        return NextResponse.json({ success: false, error: "jobId or queue=1 is required." }, { status: 400 });
    }
    const job = getJob(jobId);
    if (!job) {
        return NextResponse.json(
            { success: false, state: "error", error: "Job not found — it may have been cancelled or cleared." },
            { status: 404 }
        );
    }
    if (job.status === "queued" || job.status === "running") {
        return NextResponse.json({
            success: true,
            state: "running",
            status: job.status,
            queuePosition: job.queuePosition,
            progress: job.progress,
        });
    }
    if (job.status === "error" || job.status === "cancelled") {
        return NextResponse.json({ success: false, state: "error", error: job.error || "Tagging failed." });
    }
    const r = job.result;
    return NextResponse.json({
        state: "done",
        success: true,
        mode: r?.mode,
        count: r?.count,
        tagged: r?.tagged,
        provider: null,
        modelId: null,
        results: r?.results || [],
    });
}

// DELETE ?jobId=<id> -> cancel a queued or running job.
export async function DELETE(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) {
        return NextResponse.json({ success: false, error: "jobId is required." }, { status: 400 });
    }
    const outcome = cancelTagJob(jobId);
    if (!outcome.ok) {
        return NextResponse.json({ success: false, error: outcome.error || "Could not cancel this job." }, { status: 400 });
    }
    return NextResponse.json({ success: true });
}
