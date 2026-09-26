/**
 * GET    /api/ai-tools/qbg-tasks?type=qbg_ingestion   — list the caller's tasks for one
 *        QBG feature (running + done + failed), newest first. Bulk payload omitted.
 * GET    /api/ai-tools/qbg-tasks?id=<taskId>          — one task WITH its full payload,
 *        fetched when a history entry is opened.
 * POST   /api/ai-tools/qbg-tasks                      — create a task row (status "running").
 * PATCH  /api/ai-tools/qbg-tasks                       — patch a task's data, or mark it
 *        done/failed. Used by the QBG Pipeline panel, whose stages run client-side (not
 *        behind a single server job), unlike the other QBG features' routes which call
 *        createTask/completeTask/failTask themselves at job start/end.
 * DELETE /api/ai-tools/qbg-tasks?id=<taskId>        — delete one of the caller's tasks.
 *
 * Backed by the `qbg_tasks` table (anon client + explicit user scoping, mirroring the
 * Agentic QC job store) so history works in every auth mode — including dev-auth,
 * where there is no Supabase session at all (user key "dev").
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import {
    getTask,
    listTasks,
    deleteTask,
    createTask,
    updateTaskData,
    completeTask,
    failTask,
    type QbgTaskType,
} from "@/lib/api/qbgTaskStore";

export const runtime = "nodejs";

const VALID_TYPES = new Set<QbgTaskType>([
    "qbg_modification", "qbg_ingestion", "qbg_tagging", "qbg_pipeline", "qbg_push",
]);

export async function GET(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const { userId } = await getCurrentUserWithRole();

    // ?id=<taskId> returns ONE task with its full payload. History listings
    // deliberately omit that payload (see stripHeavyData), so a panel fetches it
    // here when the user actually opens a report.
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
        const task = await getTask(userId, id);
        if (!task) {
            return NextResponse.json({ success: false, error: "Task not found." }, { status: 404 });
        }
        return NextResponse.json({ success: true, task });
    }

    const type = req.nextUrl.searchParams.get("type") as QbgTaskType | null;
    if (!type || !VALID_TYPES.has(type)) {
        return NextResponse.json({ success: false, error: "A valid type is required." }, { status: 400 });
    }
    const tasks = await listTasks(userId, type);
    return NextResponse.json({ success: true, tasks });
}

interface CreateBody {
    id?: string;
    taskType?: QbgTaskType;
    label?: string;
    provider?: string;
    modelId?: string;
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    let body: CreateBody;
    try {
        body = (await req.json()) as CreateBody;
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.id || !body.taskType || !VALID_TYPES.has(body.taskType)) {
        return NextResponse.json({ success: false, error: "id and a valid taskType are required." }, { status: 400 });
    }
    const { userId } = await getCurrentUserWithRole();
    await createTask({
        id: body.id,
        userId,
        taskType: body.taskType,
        label: body.label?.trim() || "Task",
        provider: body.provider,
        modelId: body.modelId,
    });
    return NextResponse.json({ success: true });
}

interface PatchBody {
    id?: string;
    data?: Record<string, unknown>;
    status?: "done" | "failed";
    error?: string;
}

export async function PATCH(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    let body: PatchBody;
    try {
        body = (await req.json()) as PatchBody;
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.id) {
        return NextResponse.json({ success: false, error: "id is required." }, { status: 400 });
    }
    if (body.status === "done") {
        await completeTask(body.id, body.data || {});
    } else if (body.status === "failed") {
        await failTask(body.id, body.error || "failed");
    } else if (body.data) {
        await updateTaskData(body.id, body.data);
    }
    return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
        return NextResponse.json({ success: false, error: "id is required." }, { status: 400 });
    }
    const { userId } = await getCurrentUserWithRole();
    const ok = await deleteTask(userId, id);
    return NextResponse.json({ success: ok });
}
