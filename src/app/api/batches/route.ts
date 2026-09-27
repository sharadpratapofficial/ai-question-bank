import { NextRequest, NextResponse } from "next/server";
import {
    createBatchOption,
    deleteBatchOption,
    listBatchOptions,
} from "@/lib/api/testHistory";
import { checkPermission, checkAnyPermission } from "@/lib/auth/serverAuth";

function isMissingHistoryTablesError(error: unknown): boolean {
    const msg =
        error instanceof Error
            ? error.message.toLowerCase()
            : String(error || "").toLowerCase();
    return msg.includes("history tables are missing");
}

export async function GET() {
    // Reads through the server-only client, so this route is the access check.
    const forbid = await checkAnyPermission(["generate_tests", "create_batch"]);
    if (forbid) return forbid;
    try {
        const batches = await listBatchOptions();
        return NextResponse.json({ success: true, batches });
    } catch (error) {
        if (isMissingHistoryTablesError(error)) {
            return NextResponse.json({
                success: false,
                batches: [],
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("create_batch");
    if (forbid) return forbid;
    try {
        const body = await req.json();
        const name = String(body?.name || "").trim();
        if (!name) {
            return NextResponse.json(
                { success: false, error: "Batch name is required." },
                { status: 400 }
            );
        }

        const batch = await createBatchOption(name);
        const batches = await listBatchOptions();
        return NextResponse.json({ success: true, batch, batches });
    } catch (error) {
        if (isMissingHistoryTablesError(error)) {
            return NextResponse.json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}

export async function DELETE(req: NextRequest) {
    const forbid = await checkPermission("create_batch");
    if (forbid) return forbid;
    try {
        const { searchParams } = new URL(req.url);
        const name = String(searchParams.get("name") || "").trim();
        if (!name) {
            return NextResponse.json(
                { success: false, error: "Batch name is required." },
                { status: 400 }
            );
        }

        await deleteBatchOption(name);
        const batches = await listBatchOptions();
        return NextResponse.json({ success: true, batches });
    } catch (error) {
        if (isMissingHistoryTablesError(error)) {
            return NextResponse.json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
