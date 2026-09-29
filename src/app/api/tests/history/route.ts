import { NextRequest, NextResponse } from "next/server";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { listFinalizedTestsHistory } from "@/lib/api/testHistory";

export async function GET(req: NextRequest) {
    // Reads through the server-only client, so this route is the access check.
    const forbid = await checkAnyPermission(["generate_tests"]);
    if (forbid) return forbid;
    try {
        const { searchParams } = new URL(req.url);
        const batchName = searchParams.get("batch") || undefined;
        const limitRaw = searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;

        const tests = await listFinalizedTestsHistory({
            batchName,
            limit: Number.isFinite(limit || NaN) ? limit : undefined,
        });
        return NextResponse.json({ success: true, tests });
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
