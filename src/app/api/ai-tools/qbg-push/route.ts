/**
 * POST /api/ai-tools/qbg-push
 *
 * Push questions that ALREADY exist to the external QBG API — no AI, no re-extraction.
 * Covers the two cases where the "Push to QBG" tick was missed at run time:
 *
 *   { records: [...], meta: [...], category }  push a finished run's questions
 *   { csv: "...", csvType?, category }         push a QBG-format CSV downloaded earlier
 *
 * Long pushes are run in the background behind a jobId (same pattern as the
 * ingestion/modification routes) so a slow batch can't hit the proxy's request
 * timeout and come back as an HTML error page. The client polls GET.
 *
 * QBG (PenPencil) credentials come from the caller's saved "qbg" vault key.
 */
import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys, parseQbgProviderConfig } from "@/lib/userApiKeys";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { createTask, completeTask, failTask } from "@/lib/api/qbgTaskStore";
import {
    createReframeJob,
    completeReframeJob,
    failReframeJob,
    getReframeJob,
    deleteReframeJob,
    appendJobProgress,
    getJobProgress,
    type QbgCreds,
} from "@/lib/api/qbgModification";
import {
    pushToQbg,
    type QbgPushQuestion,
    type QbgPushQuestionType,
} from "@/lib/api/qbgPush";

export const maxDuration = 300;
export const runtime = "nodejs";

/** One record as the ingestion/modification job hands it back to the browser. */
interface PreviewRecord {
    content?: string;
    options?: { isCorrect: boolean | null; text: string | null }[];
    solution?: string;
    answer?: string | null;
}
/** Per-question provenance from an ingestion run — carries type + answer. */
interface PreviewMeta {
    num?: number | null;
    type?: string | null;
    answer?: string | string[] | null;
}

interface Body {
    records?: PreviewRecord[];
    meta?: PreviewMeta[];
    csv?: string;
    csvType?: string;
    category?: string;
    /** Shown in the task list so the push is traceable to its source run. */
    label?: string;
}

const TYPES: QbgPushQuestionType[] = ["SCQ", "MCQ", "Numerical"];
function asType(v: unknown): QbgPushQuestionType {
    const s = String(v || "").trim();
    const hit = TYPES.find((t) => t.toLowerCase() === s.toLowerCase());
    return hit || "SCQ";
}

/** Preview records + meta -> the sidecar's push shape. */
function toPushQuestions(records: PreviewRecord[], meta: PreviewMeta[]): QbgPushQuestion[] {
    return records.map((rec, i) => {
        const m = meta[i] || {};
        const options = (rec.options || []).map(
            (o) => [o.isCorrect, o.text] as [boolean | null, string | null]
        );
        // A record with no options is Numerical whatever the meta says — pushing it
        // as SCQ would create an answerless question.
        const type = options.length === 0 ? "Numerical" : asType(m.type);
        return {
            num: typeof m.num === "number" ? m.num : i + 1,
            type,
            answer: m.answer ?? rec.answer ?? null,
            content: rec.content || "",
            options,
            solution: rec.solution || "",
        };
    });
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    try {
        const body = (await req.json()) as Body;
        const category = (body.category || "").trim();
        const csv = typeof body.csv === "string" ? body.csv : "";
        const records = Array.isArray(body.records) ? body.records : [];

        if (!category) {
            return NextResponse.json({ success: false, error: "Choose a QBG category to push to." }, { status: 400 });
        }
        if (records.length === 0 && !csv.trim()) {
            return NextResponse.json(
                { success: false, error: "Nothing to push — provide the run's questions or a QBG CSV." },
                { status: 400 }
            );
        }
        if (csv.length > 25 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: "CSV too large (max 25 MB)." }, { status: 413 });
        }

        // QBG credentials, server-side only.
        let creds: QbgCreds | undefined;
        const supabase = await createServerClient();
        const { data: { user } } = await supabase.auth.getUser();
        const isDev = hasDevAuthCookie(req.cookies);
        if (user) {
            creds = parseQbgProviderConfig(sanitizeUserApiKeys(user.user_metadata?.api_keys).qbg);
        } else if (isDev) {
            const rawQbg = req.headers.get("x-dev-qbg")?.trim();
            if (rawQbg) creds = parseQbgProviderConfig(rawQbg);
        }
        if (!(creds && creds.token && creds.user && creds.userId)) {
            return NextResponse.json(
                { success: false, error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API." },
                { status: 400 }
            );
        }

        const questions =
            records.length > 0
                ? toPushQuestions(records, Array.isArray(body.meta) ? body.meta : [])
                : undefined;

        const jobId = createReframeJob();
        const { userId: taskUserId } = await getCurrentUserWithRole();
        const count = questions ? questions.length : 0;
        await createTask({
            id: jobId,
            userId: taskUserId,
            taskType: "qbg_push",
            label: body.label?.trim() || (questions ? `Push · ${count} question(s)` : "Push · CSV"),
            provider: "",
            modelId: "",
        });

        void (async () => {
            try {
                const outcome = await pushToQbg({
                    questions,
                    csv: questions ? undefined : csv,
                    csvType: asType(body.csvType),
                    category,
                    creds: creds!,
                    onProgress: (ev) => appendJobProgress(jobId, ev),
                });
                const reportData = {
                    status: "done" as const,
                    count: outcome.count,
                    pushed: outcome.pushed,
                    qbgResults: outcome.results,
                    blankImages: outcome.blankImages,
                    warnings: outcome.warnings,
                    source: questions ? ("records" as const) : ("csv" as const),
                };
                completeReframeJob(jobId, { success: true, ...reportData });
                await completeTask(jobId, reportData);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                failReframeJob(jobId, msg);
                await failTask(jobId, msg);
            }
        })();

        return NextResponse.json({ success: true, jobId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: `QBG push failed: ${msg}` }, { status: 500 });
    }
}

/** Poll a push job. Mirrors the ingestion route's GET. */
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
        const error = job.error || "Push failed.";
        deleteReframeJob(jobId);
        return NextResponse.json({ success: false, state: "error", error: `QBG push failed: ${error}` });
    }
    const payload = job.result as Record<string, unknown>;
    deleteReframeJob(jobId);
    return NextResponse.json({ state: "done", ...payload });
}
