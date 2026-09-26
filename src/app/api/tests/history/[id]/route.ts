import { NextRequest, NextResponse } from "next/server";
import {
    deleteFinalizedTestHistory,
    getFinalizedTestHistoryDetail,
} from "@/lib/api/testHistory";
import { checkPermission } from "@/lib/auth/serverAuth";

type RouteContext = {
    params: Promise<{ id: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
    try {
        const { id } = await context.params;
        const detail = await getFinalizedTestHistoryDetail(id);
        if (!detail) {
            return NextResponse.json(
                { success: false, error: "History test not found." },
                { status: 404 }
            );
        }
        return NextResponse.json({ success: true, test: detail });
    } catch (error) {
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const { id } = await context.params;
        await deleteFinalizedTestHistory(id);
        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
            {
                success: false,
                error: message,
            },
            { status: message.includes("not found") ? 404 : 500 }
        );
    }
}
