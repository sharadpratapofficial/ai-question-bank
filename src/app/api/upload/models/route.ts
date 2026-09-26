import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { AIModelProvider, ModelOption } from "@/types/extraction";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
} from "@/lib/userApiKeys";

interface ModelsResponse {
    success: boolean;
    models: ModelOption[];
    error?: string;
}

type ModelListProvider = AIModelProvider | "anthropic";

const OPENAI_COMPATIBLE_BASE_URLS: Record<
    Exclude<ModelListProvider, "gemini" | "anthropic" | "local" | "custom_openai" | "g4f">,
    string
> = {
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    grok: "https://api.x.ai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
};

function isModelListProvider(value: string): value is ModelListProvider {
    return (
        value === "gemini" ||
        value === "openai" ||
        value === "openrouter" ||
        value === "groq" ||
        value === "grok" ||
        value === "anthropic" ||
        value === "nvidia" ||
        value === "fireworks" ||
        value === "custom_openai" ||
        value === "local" ||
        value === "g4f"
    );
}

function pickProviderSettings(
    provider: ModelListProvider,
    userMetadataApiKeys: unknown,
    devApiKey: string | null
): { apiKey: string; baseUrl?: string } {
    const fromUser = sanitizeUserApiKeys(userMetadataApiKeys)[provider] || "";
    const stored = fromUser.trim() ? fromUser : (devApiKey?.trim() || "");
    return {
        apiKey: getProviderApiCredential(provider, stored),
        baseUrl: getProviderBaseUrl(provider, stored),
    };
}

function normalizeModels(models: ModelOption[]): ModelOption[] {
    const dedup = new Map<string, ModelOption>();
    for (const model of models) {
        const id = model.id?.trim();
        if (!id) continue;
        if (!dedup.has(id)) {
            dedup.set(id, {
                id,
                label: model.label?.trim() || id,
            });
        }
    }
    return Array.from(dedup.values()).sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchGeminiModels(apiKey: string): Promise<ModelOption[]> {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { method: "GET", cache: "no-store" }
    );
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini model list failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        models?: Array<{
            name?: string;
            displayName?: string;
            supportedGenerationMethods?: string[];
        }>;
    };

    const rows = (payload.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => {
            const rawName = m.name || "";
            const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
            return {
                id,
                label: m.displayName || id,
            };
        });

    return normalizeModels(rows);
}

async function fetchOpenAICompatibleModels(
    provider: Exclude<ModelListProvider, "gemini" | "anthropic" | "local">,
    apiKey: string,
    customBaseUrl?: string
): Promise<ModelOption[]> {
    // custom_openai and g4f are servers the user runs; their address arrives with
    // the request rather than from the table above, and g4f takes no credentials.
    const userHosted = provider === "custom_openai" || provider === "g4f";
    const baseUrl = userHosted ? customBaseUrl : OPENAI_COMPATIBLE_BASE_URLS[provider];
    if (!baseUrl) throw new Error("OpenAI-compatible base URL is required.");
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://question-bank.app";
        headers["X-Title"] = "Question Bank";
    }

    const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers,
        cache: "no-store",
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${provider} model list failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        data?: Array<{ id?: string; name?: string; display_name?: string }>;
    };
    const rows = (payload.data || []).map((m) => ({
        id: m.id || "",
        label: m.name || m.display_name || m.id || "",
    }));

    return normalizeModels(rows);
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
    const response = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        cache: "no-store",
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`anthropic model list failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
    };
    const rows = (payload.data || []).map((m) => ({
        id: m.id || "",
        label: m.display_name || m.id || "",
    }));
    return normalizeModels(rows);
}

async function fetchLocalModels(baseUrl: string): Promise<ModelOption[]> {
    // Try Ollama-style /api/tags first, then fall back to OpenAI-compatible /models
    try {
        const ollamaBase = baseUrl.replace(/\/v1\/?$/, "");
        const response = await fetch(`${ollamaBase}/api/tags`, {
            method: "GET",
            cache: "no-store",
        });
        if (response.ok) {
            const payload = (await response.json()) as {
                models?: Array<{ name?: string; model?: string }>;
            };
            const rows = (payload.models || []).map((m) => ({
                id: m.name || m.model || "",
                label: m.name || m.model || "",
            }));
            if (rows.length > 0) return normalizeModels(rows);
        }
    } catch {
        // Ollama API not available, try OpenAI-compatible
    }

    // OpenAI-compatible /models (LM Studio, etc.)
    const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        cache: "no-store",
    });
    if (!response.ok) {
        throw new Error(`Local server model list failed (${response.status}). Is your server running at ${baseUrl}?`);
    }
    const payload = (await response.json()) as {
        data?: Array<{ id?: string; name?: string }>;
    };
    const rows = (payload.data || []).map((m) => ({
        id: m.id || "",
        label: m.name || m.id || "",
    }));
    return normalizeModels(rows);
}

async function fetchProviderModels(provider: ModelListProvider, apiKey: string, customBaseUrl?: string): Promise<ModelOption[]> {
    if (provider === "gemini") {
        return fetchGeminiModels(apiKey);
    }
    if (provider === "anthropic") {
        return fetchAnthropicModels(apiKey);
    }
    if (provider === "local") {
        return fetchLocalModels(apiKey || "http://localhost:11434/v1");
    }
    return fetchOpenAICompatibleModels(provider, apiKey, customBaseUrl);
}

export async function GET(request: NextRequest) {
    try {
        const providerParam = request.nextUrl.searchParams.get("provider") || "";
        if (!isModelListProvider(providerParam)) {
            return NextResponse.json(
                { success: false, models: [], error: "Invalid provider" } as ModelsResponse,
                { status: 400 }
            );
        }

        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();

        const hasDevAuth = request.cookies.get("qbg_dev_auth")?.value === "1";
        const devApiKey = hasDevAuth ? request.headers.get("x-dev-api-key") : null;
        const { apiKey, baseUrl } = pickProviderSettings(providerParam, user?.user_metadata?.api_keys, devApiKey);

        if (!apiKey) {
            return NextResponse.json(
                {
                    success: false,
                    models: [],
                    error: `No saved API key found for ${providerParam}.`,
                } as ModelsResponse,
                { status: 400 }
            );
        }

        const models = await fetchProviderModels(providerParam, apiKey, baseUrl);
        return NextResponse.json({
            success: true,
            models,
        } as ModelsResponse);
    } catch (err) {
        console.error("GET /api/upload/models failed:", err);
        return NextResponse.json(
            {
                success: false,
                models: [],
                error: err instanceof Error ? err.message : "Failed to fetch live models",
            } as ModelsResponse,
            { status: 500 }
        );
    }
}
