import { NextRequest, NextResponse } from "next/server";
import { selectPool, type PoolSelectionConfig } from "@/lib/api/qbgPoolSelection";
import { checkPermission } from "@/lib/auth/serverAuth";

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;
    try {
        const body = await req.json();
        const incoming = body as PoolSelectionConfig;
        const config: PoolSelectionConfig = {
            ...incoming,
            batchNames: (incoming.batchNames || []).map((n) => String(n || "").trim()).filter(Boolean),
        };

        if (!config.examPreset) {
            return NextResponse.json({ success: false, error: "Exam preset is required." }, { status: 400 });
        }

        const result = await selectPool(config);
        return NextResponse.json({ success: true, ...result });
    } catch (error: any) {
        console.error("API Error selecting QBG pool:", error);
        return NextResponse.json(
            { success: false, error: error?.message || "Internal server error" },
            { status: 500 }
        );
    }
}
