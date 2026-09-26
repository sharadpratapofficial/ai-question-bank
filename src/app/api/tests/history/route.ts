import { NextRequest, NextResponse } from "next/server";
import { listFinalizedTestsHistory } from "@/lib/api/testHistory";

export async function GET(req: NextRequest) {
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
