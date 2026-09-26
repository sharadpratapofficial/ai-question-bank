/**
 * GET /api/agentic-qc/models?provider=<provider>
 *
 * Returns the LIVE model list for a given provider — much fresher than our
 * hardcoded curated list, which tends to lag every time a provider ships a
 * new model. Required for OpenRouter especially (300+ models, refreshed
 * almost weekly).
 *
 * Auth: needs the user to have a saved API key for the provider (server-side
 * lookup, never read from the request body).
 *
 * Per-provider endpoints used:
 *   - openrouter:  GET https://openrouter.ai/api/v1/models     (no auth)
 *   - openai:      GET https://api.openai.com/v1/models        (key in Bearer)
 *   - anthropic:   GET https://api.anthropic.com/v1/models     (key in x-api-key)
 *   - gemini:      GET https://generativelanguage.googleapis.com/v1beta/models?key=KEY
 *   - grok:        GET https://api.x.ai/v1/models              (key in Bearer)
 *
 * Returns:
 *   { success: true, models: [{ id, label }] }
 *
 * For OpenRouter we filter to models that support image/file input — text-only
 * models can't read PDFs and would just confuse the QC flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import { checkPermission } from "@/lib/auth/serverAuth";

export const runtime = "nodejs";

interface NormalizedModel {
    id: string;
    label: string;
}

// ─── Provider fetchers ──────────────────────────────────────────────────

async function fetchOpenRouterModels(): Promise<NormalizedModel[]> {
    // No auth needed for OpenRouter's listing endpoint.
    const res = await fetch("https://openrouter.ai/api/v1/models", {
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`OpenRouter /models → HTTP ${res.status}`);
    const body = (await res.json()) as {
        data?: Array<{
            id?: string;
            name?: string;
            architecture?: {
                input_modalities?: string[];
                output_modalities?: string[];
                modality?: string;
            };
            top_provider?: { max_completion_tokens?: number };
        }>;
    };
    const all = body.data || [];

    const supportsVision = (m: (typeof all)[number]): boolean => {
        const inputs = m.architecture?.input_modalities || [];
        if (inputs.includes("image") || inputs.includes("file")) return true;
        const legacy = m.architecture?.modality || "";
        return legacy.includes("image") || legacy.includes("file");
    };

    // Previously we returned ONLY vision/file models, which hid strong text
    // models like DeepSeek. But structured (CSV/Excel) QC attaches no file —
    // the paper is inline text — so text-only models work fine there. Include
    // every chat model that outputs text, and just exclude image/audio
    // generation models. Vision-capable models are sorted first (and the
    // rest tagged "(text only)") so PDF-mode users still find them easily.
    const usable = all.filter((m) => {
        const outputs = m.architecture?.output_modalities || [];
        if (outputs.length > 0) return outputs.includes("text");
        // No output_modalities field → infer from the legacy "in->out" string.
        const legacy = m.architecture?.modality || "";
        const out = legacy.includes("->") ? legacy.split("->")[1] : "text";
        return /text/.test(out) || out === "";
    });

    // Stable sort: vision-capable first, preserving OpenRouter's order within
    // each group (newest models tend to come first).
    const sorted = usable
        .map((m, i) => ({ m, i }))
        .sort((a, b) => {
            const va = supportsVision(a.m) ? 0 : 1;
            const vb = supportsVision(b.m) ? 0 : 1;
            return va - vb || a.i - b.i;
        })
        .map((x) => x.m);

    return sorted
        .map((m) => ({
            id: m.id || "",
            label: (m.name || m.id || "") + (supportsVision(m) ? "" : "  (text only)"),
        }))
        .filter((m) => m.id);
}

async function fetchOpenAIModels(apiKey: string): Promise<NormalizedModel[]> {
    const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI /models → HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data || []).map((m) => m.id || "").filter(Boolean);

    // Keep only chat/vision-capable model families — filter out embeddings,
    // audio, image generation, and other non-chat models.
    const skip = (id: string): boolean => {
        const lower = id.toLowerCase();
        return (
            lower.includes("embedding") ||
            lower.includes("whisper") ||
            lower.includes("tts") ||
            lower.includes("dall-e") ||
            lower.includes("babbage") ||
            lower.includes("davinci") ||
            lower.includes("ada") ||
            lower.includes("curie") ||
            lower.startsWith("text-") ||
            lower.startsWith("ft:")
        );
    };
    return ids.filter((id) => !skip(id)).sort().map((id) => ({ id, label: id }));
}

async function fetchAnthropicModels(apiKey: string): Promise<NormalizedModel[]> {
    const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        cache: "no-store",
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anthropic /models → HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
    };
    return (body.data || [])
        .filter((m) => m.id)
        .map((m) => ({ id: m.id!, label: m.display_name || m.id! }));
}

async function fetchGeminiModels(apiKey: string): Promise<NormalizedModel[]> {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { cache: "no-store" }
    );
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini /models → HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
        models?: Array<{
            name?: string;
            displayName?: string;
            supportedGenerationMethods?: string[];
        }>;
    };
    return (body.models || [])
        // Only models that support generateContent (skip embed-only / etc.)
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => {
            // Gemini model names come prefixed with "models/" — strip it for the id.
            const id = (m.name || "").replace(/^models\//, "");
            return { id, label: m.displayName || id };
        })
        .filter((m) => m.id);
}

async function fetchGrokModels(apiKey: string): Promise<NormalizedModel[]> {
    const res = await fetch("https://api.x.ai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Grok /models → HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data || [])
        .filter((m) => m.id)
        .map((m) => ({ id: m.id!, label: m.id! }));
}

/**
 * Generic fetcher for any OpenAI-compatible provider that exposes a
 * `GET <baseUrl>/models` endpoint returning `{ data: [{ id }] }`. Covers Groq,
 * NVIDIA NIM, Fireworks, and local Ollama / LM Studio. The endpoints all
 * accept a Bearer token (ignored by local servers).
 */
async function fetchOpenAICompatibleModels(
    providerLabel: string,
    baseUrl: string,
    apiKey: string
): Promise<NormalizedModel[]> {
    const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        cache: "no-store",
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`${providerLabel} /models → HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
        data?: Array<{ id?: string; name?: string }>;
    };
    return (body.data || [])
        .map((m) => ({ id: (m.id || m.name || "").toString(), label: (m.id || m.name || "").toString() }))
        .filter((m) => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** Base URLs for OpenAI-compatible providers' model-listing endpoints. */
const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
    groq: "https://api.groq.com/openai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    local: "http://localhost:11434/v1",
    g4f: "http://localhost:1337/v1",
};

// ─── Route ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
    const forbid = await checkPermission("use_agentic_qc");
    if (forbid) return forbid;

    const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() || "";
    if (!provider) {
        return NextResponse.json(
            { success: false, error: "provider query param is required." },
            { status: 400 }
        );
    }

    // OpenRouter's /models endpoint is public — no key needed for listing.
    if (provider === "openrouter") {
        try {
            const models = await fetchOpenRouterModels();
            return NextResponse.json({ success: true, models });
        } catch (err) {
            return NextResponse.json(
                {
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                },
                { status: 502 }
            );
        }
    }

    // Local (Ollama / LM Studio) listing needs no API key — it talks to the
    // server's own localhost. (Only meaningful in local dev.)
    if (provider === "local") {
        try {
            const models = await fetchOpenAICompatibleModels(
                "Local",
                OPENAI_COMPATIBLE_BASE_URLS.local,
                ""
            );
            return NextResponse.json({ success: true, models });
        } catch (err) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        (err instanceof Error ? err.message : String(err)) +
                        " — is your local server (Ollama / LM Studio) running on this machine?",
                },
                { status: 502 }
            );
        }
    }

    // g4f runs on the user's own machine and authenticates nothing, so — like
    // local — its model list needs no saved key.
    if (provider === "g4f") {
        try {
            const models = await fetchOpenAICompatibleModels(
                "g4f",
                OPENAI_COMPATIBLE_BASE_URLS.g4f,
                ""
            );
            return NextResponse.json({ success: true, models });
        } catch (err) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        (err instanceof Error ? err.message : String(err)) +
                        " — is the g4f server running on this machine? Start it with: g4f api",
                },
                { status: 502 }
            );
        }
    }

    // All other providers need the user's saved key.
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json(
            { success: false, error: "Not authenticated." },
            { status: 401 }
        );
    }
    const savedKeys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
    const apiKey = (savedKeys as unknown as Record<string, string>)[provider] || "";
    if (!apiKey) {
        return NextResponse.json(
            {
                success: false,
                error: `No saved API key for ${provider}. Add it from the user icon → Manage API Keys.`,
            },
            { status: 400 }
        );
    }

    try {
        let models: NormalizedModel[];
        switch (provider) {
            case "openai":
                models = await fetchOpenAIModels(apiKey);
                break;
            case "anthropic":
                models = await fetchAnthropicModels(apiKey);
                break;
            case "gemini":
                models = await fetchGeminiModels(apiKey);
                break;
            case "grok":
                models = await fetchGrokModels(apiKey);
                break;
            case "groq":
            case "nvidia":
            case "fireworks":
                models = await fetchOpenAICompatibleModels(
                    provider,
                    OPENAI_COMPATIBLE_BASE_URLS[provider],
                    apiKey
                );
                break;
            default:
                // custom_openai has no fixed endpoint — the base URL is whatever
                // the user configured, which we don't store here. Use the
                // curated list / custom model ID instead.
                return NextResponse.json(
                    {
                        success: false,
                        error: `Live-model refresh isn't available for ${provider}. Pick from the list or type a custom model ID.`,
                    },
                    { status: 400 }
                );
        }
        return NextResponse.json({ success: true, models });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 502 }
        );
    }
}
