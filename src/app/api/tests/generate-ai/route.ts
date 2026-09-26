import { NextRequest, NextResponse } from "next/server";
import type { TestGenerationConfig } from "@/types";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    sanitizeUserApiKeys,
} from "@/lib/userApiKeys";
import { generateAITests, type AITestProvider } from "@/lib/api/testAiGeneration";
import { checkPermission } from "@/lib/auth/serverAuth";

function isAITestProvider(value: string): value is AITestProvider {
    return (
        value === "gemini" ||
        value === "openrouter" ||
        value === "anthropic" ||
        value === "openai" ||
        value === "grok" ||
        value === "groq" ||
        value === "nvidia" ||
        value === "fireworks" ||
        value === "custom_openai" ||
        value === "local" ||
        value === "g4f"
    );
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as TestGenerationConfig;
        const provider = body.aiGeneration?.provider;
        const modelId = String(body.aiGeneration?.modelId || "").trim();

        if (!provider || !isAITestProvider(provider)) {
            return NextResponse.json(
                { success: false, tests: [], warnings: [], error: "Valid AI provider is required." },
                { status: 400 }
            );
        }
        if (!modelId) {
            return NextResponse.json(
                { success: false, tests: [], warnings: [], error: "AI model ID is required." },
                { status: 400 }
            );
        }

        let resolvedApiKey = "";
        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();

        if (user) {
            resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
        } else if (req.cookies.get("qbg_dev_auth")?.value === "1") {
            resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
        }

        if (!getProviderApiCredential(provider, resolvedApiKey)) {
            return NextResponse.json(
                {
                    success: false,
                    tests: [],
                    warnings: [],
                    error: `No saved API key found for ${provider}. Add it from the user icon.`,
                },
                { status: 400 }
            );
        }

        const config: TestGenerationConfig = {
            ...body,
            batchName: String(body.batchName || "").trim() || "Batch Test",
            aiGeneration: {
                enabled: true,
                provider,
                modelId,
            },
        };

        const result = await generateAITests({
            config,
            provider,
            modelId,
            apiKey: resolvedApiKey,
        });

        if (!result.success) {
            return NextResponse.json(result, { status: 500 });
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error("API Error generating AI tests:", error);
        return NextResponse.json(
            { success: false, tests: [], warnings: [], error: "Internal server error" },
            { status: 500 }
        );
    }
}
