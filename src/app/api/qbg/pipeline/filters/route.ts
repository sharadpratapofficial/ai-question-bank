import { NextResponse } from "next/server";
import { getPoolFilterOptions } from "@/lib/api/qbgPoolSelection";
import { checkPermission } from "@/lib/auth/serverAuth";

export async function GET() {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;
    try {
        const options = await getPoolFilterOptions();
        return NextResponse.json({ success: true, ...options });
    } catch (error: any) {
        console.error("API Error fetching QBG pool filters:", error);
        return NextResponse.json(
            { success: false, error: error?.message || "Internal server error" },
            { status: 500 }
        );
    }
}
