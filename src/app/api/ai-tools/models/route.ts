import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
} from "@/lib/userApiKeys";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const provider = searchParams.get("provider");

        if (provider === "openrouter") {
            const response = await fetch("https://openrouter.ai/api/v1/models", {
                headers: {
                    "HTTP-Referer": "https://question-bank.app",
                    "X-Title": "QBG AI Tools",
                },
                next: { revalidate: 3600 }, // Cache for 1 hour
            });

            if (!response.ok) {
                throw new Error(`OpenRouter returned ${response.status}`);
            }

            const data = await response.json();
            
            // Map the response to our ModelOption format
            if (data && Array.isArray(data.data)) {
                // Return models sorted by ID or name
                const models = data.data.map((m: any) => ({
                    id: m.id,
                    label: m.name || m.id,
                }));

                // Sort alphabetically by label
                models.sort((a: any, b: any) => a.label.localeCompare(b.label));

                return NextResponse.json({ success: true, models });
            }
            
            throw new Error("Invalid response format from OpenRouter");
        }

        if (provider === "groq" || provider === "openai" || provider === "nvidia" || provider === "fireworks" || provider === "custom_openai") {
            let resolvedApiKey = "";
            const supabase = await createClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
            } else if (hasDevAuthCookie(req.cookies)) {
                resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            if (!resolvedApiKey) {
                return NextResponse.json(
                    { success: false, error: `No API key found for ${provider}. Add it from the user settings.` },
                    { status: 400 }
                );
            }

            const apiKey = getProviderApiCredential(provider as any, resolvedApiKey);
            const baseUrl = provider === "groq"
                ? "https://api.groq.com/openai/v1/models"
                : provider === "nvidia"
                    ? "https://integrate.api.nvidia.com/v1/models"
                    : provider === "fireworks"
                        ? "https://api.fireworks.ai/inference/v1/models"
                        : provider === "custom_openai"
                            ? `${getProviderBaseUrl("custom_openai", resolvedApiKey)}/models`
                            : "https://api.openai.com/v1/models";
            if (!apiKey) {
                return NextResponse.json(
                    { success: false, error: `No API key found for ${provider}. Add it from the user settings.` },
                    { status: 400 }
                );
            }
            if (provider === "custom_openai" && !getProviderBaseUrl("custom_openai", resolvedApiKey)) {
                return NextResponse.json(
                    { success: false, error: "OpenAI-compatible base URL is required." },
                    { status: 400 }
                );
            }

            const response = await fetch(baseUrl, {
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
                next: { revalidate: 3600 }, 
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`${provider.toUpperCase()} returned ${response.status}: ${err}`);
            }

            const data = await response.json();

            if (data && Array.isArray(data.data)) {
                // Return models
                const models = data.data.map((m: any) => ({
                    id: m.id,
                    label: m.id, 
                }));

                // Sort alphabetically
                models.sort((a: any, b: any) => a.label.localeCompare(b.label));

                return NextResponse.json({ success: true, models });
            }

            throw new Error(`Invalid response format from ${provider}`);
        }

        if (provider === "gemini") {
            let resolvedApiKey = "";
            const supabase = await createClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
            } else if (hasDevAuthCookie(req.cookies)) {
                resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            if (!resolvedApiKey) {
                return NextResponse.json(
                    { success: false, error: `No API key found for gemini. Add it from the user settings.` },
                    { status: 400 }
                );
            }

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${resolvedApiKey}`, {
                next: { revalidate: 3600 }, 
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Gemini returned ${response.status}: ${err}`);
            }

            const data = await response.json();

            if (data && Array.isArray(data.models)) {
                // Gemini returns a 'models' array. 
                const models = data.models.map((m: any) => {
                    const id = m.name.replace('models/', '');
                    return {
                        id,
                        label: m.displayName || id, 
                    };
                });

                models.sort((a: any, b: any) => a.label.localeCompare(b.label));

                return NextResponse.json({ success: true, models });
            }

            throw new Error("Invalid response format from Gemini");
        }

        if (provider === "local") {
            // Get the base URL from user settings (stored where API key normally goes)
            let baseUrl = "";
            const supabase = await createClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (user) {
                baseUrl = sanitizeUserApiKeys(user.user_metadata?.api_keys)["local" as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
            } else if (hasDevAuthCookie(req.cookies)) {
                baseUrl = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            if (!baseUrl) baseUrl = "http://localhost:11434/v1";

            // Try Ollama /api/tags first
            try {
                const ollamaBase = baseUrl.replace(/\/v1\/?$/, "");
                const ollamaRes = await fetch(`${ollamaBase}/api/tags`, { cache: "no-store" });
                if (ollamaRes.ok) {
                    const ollamaData = await ollamaRes.json();
                    if (ollamaData?.models && Array.isArray(ollamaData.models) && ollamaData.models.length > 0) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const models = ollamaData.models.map((m: any) => ({
                            id: m.name || m.model || "",
                            label: m.name || m.model || "",
                        }));
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        models.sort((a: any, b: any) => a.label.localeCompare(b.label));
                        return NextResponse.json({ success: true, models });
                    }
                }
            } catch {
                // Ollama not available, try OpenAI-compatible
            }

            // Try OpenAI-compatible /models
            const response = await fetch(`${baseUrl}/models`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Local server returned ${response.status}. Is your server running at ${baseUrl}?`);
            }
            const data = await response.json();
            if (data && Array.isArray(data.data)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const models = data.data.map((m: any) => ({
                    id: m.id || "",
                    label: m.name || m.id || "",
                }));
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                models.sort((a: any, b: any) => a.label.localeCompare(b.label));
                return NextResponse.json({ success: true, models });
            }

            throw new Error("No models found on local server.");
        }

        if (provider === "g4f") {
            // g4f brokers whatever upstream providers are reachable right now, so
            // the hardcoded short-list in AI_PROVIDER_MODELS goes stale fast and
            // asking the running server is the only accurate answer. Its API
            // server speaks OpenAI, so /models is all we need — and no key, since
            // g4f does not authenticate by default.
            let baseUrl = "";
            const supabase = await createClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (user) {
                baseUrl = sanitizeUserApiKeys(user.user_metadata?.api_keys)["g4f" as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
            } else if (hasDevAuthCookie(req.cookies)) {
                baseUrl = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            baseUrl = getProviderBaseUrl("g4f", baseUrl);

            // A refused connection throws rather than returning a status, and the
            // bare "fetch failed" that surfaces tells the user nothing about why.
            let response: Response;
            try {
                response = await fetch(`${baseUrl}/models`, { cache: "no-store" });
            } catch {
                throw new Error(
                    `Could not reach a g4f server at ${baseUrl}. Start one with "g4f api", ` +
                    `or set the address under Manage API Keys → gpt4free.`
                );
            }
            if (!response.ok) {
                throw new Error(
                    `g4f server at ${baseUrl} returned ${response.status}.`
                );
            }
            const data = await response.json();
            if (data && Array.isArray(data.data)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const models = data.data.map((m: any) => ({
                    id: m.id || "",
                    label: m.id || "",
                }));
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const named = models.filter((m: any) => m.id);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                named.sort((a: any, b: any) => a.label.localeCompare(b.label));
                if (named.length > 0) return NextResponse.json({ success: true, models: named });
            }

            throw new Error(`No models reported by the g4f server at ${baseUrl}.`);
        }

        // Feature for other providers can be added here
        return NextResponse.json(
            { success: false, error: `Refreshing models for ${provider} is not supported yet.` },
            { status: 400 }
        );
    } catch (err) {
        console.error("Fetch models error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
