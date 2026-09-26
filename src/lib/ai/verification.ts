import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
    type SupportedApiProvider,
} from "@/lib/userApiKeys";

const SUPPORTED_AI_PROVIDERS: SupportedApiProvider[] = [
    "gemini",
    "anthropic",
    "openai",
    "groq",
    "grok",
    "openrouter",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
];

const OPENAI_COMPATIBLE_CONFIGS: Record<
    Exclude<SupportedApiProvider, "gemini" | "anthropic" | "local" | "custom_openai" | "g4f" | "elevenlabs" | "qbg" | "google_drive">,
    { baseUrl: string; extraHeaders?: Record<string, string> }
> = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: {
            "HTTP-Referer": "https://question-bank.app",
            "X-Title": "QBG AI Tools",
        },
    },
    groq: { baseUrl: "https://api.groq.com/openai/v1" },
    grok: { baseUrl: "https://api.x.ai/v1" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
};

export function isSupportedAiProvider(value: string): value is SupportedApiProvider {
    return SUPPORTED_AI_PROVIDERS.includes(value as SupportedApiProvider);
}

export async function resolveAiProviderApiKey(
    req: NextRequest,
    provider: SupportedApiProvider
): Promise<string> {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (user) {
        const stored = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
        if (provider === "custom_openai") return stored;
        return getProviderApiCredential(provider, stored);
    }

    if (req.cookies.get("qbg_dev_auth")?.value === "1") {
        const stored = req.headers.get("x-dev-api-key")?.trim() || "";
        if (provider === "custom_openai") return stored;
        return getProviderApiCredential(provider, stored);
    }

    return "";
}

export async function callStructuredAiModel(
    provider: SupportedApiProvider,
    modelId: string,
    apiKey: string,
    prompt: string
): Promise<string> {
    if (provider === "elevenlabs") {
        throw new Error(
            "ElevenLabs is a TTS provider — it can't be used as an LLM for verification."
        );
    }
    if (provider === "google_drive") {
        throw new Error(
            "Google Drive is a storage connection, not an LLM provider — it can't be used for verification."
        );
    }
    if (provider === "qbg") {
        throw new Error(
            "QBG is a REST API token, not an LLM provider — it can't be used for verification."
        );
    }
    if (provider === "gemini") {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 16384,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errText}`);
        }

        const geminiRes = await response.json();
        const text = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error("Gemini returned empty response.");
        }
        return text;
    }

    if (provider === "anthropic") {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: modelId,
                max_tokens: 16384,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${errText}`);
        }

        const anthropicRes = await response.json();
        const text = anthropicRes?.content?.[0]?.text;
        if (!text) {
            throw new Error("Anthropic returned empty response.");
        }
        return text;
    }

    const actualApiKey = getProviderApiCredential(provider, apiKey);
    // A server the user runs themselves (Ollama, an OpenAI-compatible box, g4f)
    // supplies its own address and usually no credentials at all.
    const selfHosted = provider === "local" || provider === "custom_openai" || provider === "g4f";
    const config = selfHosted
        ? { baseUrl: getProviderBaseUrl(provider, apiKey), extraHeaders: undefined }
        : OPENAI_COMPATIBLE_CONFIGS[provider];
    if (!config?.baseUrl) {
        throw new Error("OpenAI-compatible base URL is required.");
    }
    const keyOptional = provider === "local" || provider === "g4f";
    if (!keyOptional && !actualApiKey) {
        throw new Error(`No API key found for ${provider}. Add it from the user icon.`);
    }
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(keyOptional ? {} : { Authorization: `Bearer ${actualApiKey}` }),
        ...(config.extraHeaders || {}),
    };

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_completion_tokens: 16384,
            response_format: { type: "json_object" },
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${errText}`);
    }

    const apiRes = await response.json();
    const text = apiRes?.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error(`${provider.toUpperCase()} returned empty response.`);
    }
    return text;
}

export function parseStructuredAiResponse(rawText: string): Record<string, unknown> {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    // Models sometimes wrap the JSON in a sentence of prose — isolate the
    // outermost { … } object before parsing.
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    // AI models (esp. Gemini) routinely emit LaTeX with single backslashes inside
    // the JSON string values — "\(", "\[", "\frac", "\sqrt", "\theta", "\times" —
    // even though the prompt asks for "\\(". Two distinct failure modes result:
    //   1. "\(" / "\sqrt"  → invalid JSON escape → JSON.parse THROWS
    //      ("Bad escaped character").
    //   2. "\frac" / "\theta" / "\times" → "\f"/"\t" are *valid* JSON escapes
    //      (form-feed / tab), so JSON.parse SUCCEEDS but silently mangles the
    //      LaTeX ("\frac" → form-feed+"rac"). A try/catch can't catch this.
    // So we normalise LaTeX backslashes BEFORE the first parse, not only on error.
    try {
        return JSON.parse(normalizeJsonLatexBackslashes(cleaned));
    } catch {
        // Fallback: if normalisation somehow broke an already-valid document,
        // try the original text unchanged.
        return JSON.parse(cleaned);
    }
}

/**
 * Walk a JSON-ish string and double any backslash that isn't a genuine JSON
 * escape, so embedded LaTeX survives `JSON.parse`. Kept as a real escape:
 *   • \" \\ \/            (structural)
 *   • \uXXXX              (unicode)
 *   • \n \t \r \b \f when NOT followed by a letter — i.e. a true control char
 *     used for whitespace. When followed by a letter it's a LaTeX command
 *     ("\nu", "\theta", "\frac", "\beta", "\rho"), so the backslash is doubled.
 * Everything else ("\(", "\[", "\sqrt", "\alpha", …) is doubled.
 */
function normalizeJsonLatexBackslashes(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== "\\") {
            out += s[i];
            continue;
        }
        const next = s[i + 1];
        if (next === '"' || next === "\\" || next === "/") {
            out += s[i] + next; // keep structural 2-char escape, skip both
            i++;
            continue;
        }
        if (next === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
            out += s.slice(i, i + 6); // keep \uXXXX
            i += 5;
            continue;
        }
        if (
            (next === "n" || next === "t" || next === "r" || next === "b" || next === "f") &&
            !/[A-Za-z]/.test(s[i + 2] || "")
        ) {
            out += s[i] + next; // genuine control char (\n, \t … not a LaTeX command)
            i++;
            continue;
        }
        out += "\\\\"; // stray / LaTeX backslash → double it
    }
    return out;
}
