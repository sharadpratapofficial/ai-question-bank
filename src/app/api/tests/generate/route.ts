
import { NextRequest, NextResponse } from "next/server";
import { generateTests } from "@/lib/api/testGeneration";
import { TestGenerationConfig } from "@/types";
import { checkPermission } from "@/lib/auth/serverAuth";

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const body = await req.json();
        const incoming = body as TestGenerationConfig;
        const config: TestGenerationConfig = {
            ...incoming,
            batchName: String(incoming.batchName || "").trim() || "NA",
        };

        if (config.numberOfTests < 1 || config.numberOfTests > 10) {
            return NextResponse.json(
                { success: false, error: "Number of tests must be between 1 and 10" },
                { status: 400 }
            );
        }

        const result = await generateTests(config);

        if (!result.success) {
            return NextResponse.json(result, { status: 500 });
        }

        return NextResponse.json(result);
    } catch (error: any) {
        console.error("API Error generating tests:", error);
        return NextResponse.json(
            { success: false, error: "Internal server error" },
            { status: 500 }
        );
    }
}
