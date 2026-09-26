/**
 * GET  /api/agentic-qc/jobs        → list this user's saved QC runs
 * POST /api/agentic-qc/jobs        → start a new QC run (returns { jobId })
 *
 * The actual execution happens in the background via `runJob` from
 * `lib/agenticQC/executor`. The client subscribes to live events via
 * /api/agentic-qc/jobs/[id]/stream (SSE) AFTER receiving the jobId.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { randomUUID } from "crypto";
import { createJob, listJobs, toClientView, type AgentConfig } from "@/lib/agenticQC/jobStore";
import type { PreparsedQuestion } from "@/lib/agenticQC/executor";
import type { FileInput } from "@/lib/agenticQC/llm";

export const runtime = "nodejs";
// This route only creates the job row and returns within a few hundred ms.
// The executor is NOT started here: Vercel freezes the function the moment we
// respond, so detached background work never progresses. Instead the executor
// runs inside the live SSE connection (GET /stream), which the client opens
// immediately after this returns and auto-reconnects to resume long runs.
export const maxDuration = 60;

const TEXT_ONLY_PROVIDERS = new Set([
    "groq",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
]);

const VALID_PROVIDERS = [
    "gemini",
    "anthropic",
    "openai",
    "openrouter",
    "groq",
    "grok",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
] as const;
function isValidProvider(v: string): boolean {
    return (VALID_PROVIDERS as readonly string[]).includes(v);
}

export async function GET() {
    const forbid = await checkPermission("use_agentic_qc");
    if (forbid) return forbid;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json(
            { success: false, error: "Not authenticated." },
            { status: 401 }
        );
    }
    const jobs = await listJobs(user.id);
    // Strip event log + file contents from the list view — clients pull full
    // state via GET /jobs/[id] when they open one.
    const summaries = jobs.map((j) => ({
        id: j.id,
        label: j.label,
        status: j.status,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        finishedAt: j.finishedAt,
        inputMode: j.inputMode,
        sourceFileName: j.sourceFileName,
        totalQuestions: j.questions.length,
        flaggedForReview: j.questions.filter((q) => q.aggregator.needsManualReview).length,
        agents: j.qcAgents,
        aggregator: j.aggregator,
        partial: !!j.partial,
        fatalError: j.fatalError,
    }));
    return NextResponse.json({ success: true, jobs: summaries });
}

interface StartBody {
    label?: string;
    inputMode: "combined" | "separate" | "structured";
    qcAgents: AgentConfig[];
    aggregator: AgentConfig;
    examType?: string;
    testName?: string;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    // file mode
    questionFile?: FileInput;
    answerKeyFile?: FileInput;
    solutionFile?: FileInput;
    // structured mode
    parsedQuestions?: PreparsedQuestion[];
    sourceFileName?: string;
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_agentic_qc");
    if (forbid) return forbid;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json(
            { success: false, error: "Not authenticated." },
            { status: 401 }
        );
    }
    let body: StartBody;
    try {
        body = (await req.json()) as StartBody;
    } catch {
        return NextResponse.json(
            { success: false, error: "Invalid JSON body." },
            { status: 400 }
        );
    }

    if (!Array.isArray(body.qcAgents) || body.qcAgents.length < 1 || body.qcAgents.length > 3) {
        return NextResponse.json(
            { success: false, error: "Provide 1 to 3 qcAgents." },
            { status: 400 }
        );
    }
    if (!body.aggregator?.provider || !body.aggregator?.modelId) {
        return NextResponse.json(
            { success: false, error: "aggregator (provider + modelId) is required." },
            { status: 400 }
        );
    }
    for (const a of [...body.qcAgents, body.aggregator]) {
        if (!isValidProvider(a.provider)) {
            return NextResponse.json(
                { success: false, error: `Invalid provider in ${a.label}: ${a.provider}` },
                { status: 400 }
            );
        }
        if (!a.modelId) {
            return NextResponse.json(
                { success: false, error: `Missing modelId for ${a.label}` },
                { status: 400 }
            );
        }
        if (body.inputMode !== "structured" && TEXT_ONLY_PROVIDERS.has(a.provider)) {
            return NextResponse.json(
                {
                    success: false,
                    error: `${a.label}: ${a.provider} doesn't support PDF/file input. Switch to structured CSV mode, or pick a vision-capable provider.`,
                },
                { status: 400 }
            );
        }
    }

    if (body.inputMode === "structured") {
        if (!Array.isArray(body.parsedQuestions) || body.parsedQuestions.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: "parsedQuestions array is required for structured mode.",
                },
                { status: 400 }
            );
        }
    } else {
        if (!body.questionFile?.fileBase64 || !body.questionFile?.fileName) {
            return NextResponse.json(
                { success: false, error: "questionFile is required for file modes." },
                { status: 400 }
            );
        }
    }

    const jobId = randomUUID();
    const label =
        body.label?.trim() ||
        (body.inputMode === "structured"
            ? `Structured QC · ${body.parsedQuestions?.length || 0} questions`
            : body.sourceFileName ||
              body.questionFile?.fileName ||
              "Paper QC");

    const job = await createJob({
        id: jobId,
        userId: user.id,
        label,
        inputMode: body.inputMode,
        examType: body.examType,
        testName: body.testName?.trim() || undefined,
        customQuestionTypeSequence: body.customQuestionTypeSequence,
        subjects: body.subjects,
        syllabus: body.syllabus,
        qcAgents: body.qcAgents,
        aggregator: body.aggregator,
        sourceFileName:
            body.sourceFileName ||
            body.questionFile?.fileName ||
            undefined,
        // Persist everything the executor needs so the SSE stream route can
        // (re)drive the run on connect / reconnect. API keys are NOT stored —
        // they're re-resolved server-side per connection.
        execInput: {
            parsedQuestions: body.parsedQuestions,
            files: body.questionFile
                ? {
                      questionFile: body.questionFile,
                      answerKeyFile: body.answerKeyFile,
                      solutionFile: body.solutionFile,
                  }
                : undefined,
        },
    });

    // Execution starts when the client opens GET /stream (see that route),
    // where API keys are resolved server-side from the authenticated user.
    return NextResponse.json({ success: true, jobId, job: toClientView(job) });
}
