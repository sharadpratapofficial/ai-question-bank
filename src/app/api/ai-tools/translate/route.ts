import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    providerNeedsApiKey,
    type SupportedApiProvider,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
} from "@/lib/userApiKeys";
import type { AIModelProvider } from "@/types/extraction";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { parseStructuredAiResponse } from "@/lib/ai/verification";

// ==================== TYPES ====================

const VALID_PROVIDERS = ["gemini", "openai", "openrouter", "groq", "grok", "anthropic", "nvidia", "fireworks", "custom_openai", "local", "g4f"] as const;
function isValidProvider(v: string): v is AIModelProvider | "anthropic" {
    return (VALID_PROVIDERS as readonly string[]).includes(v);
}

interface TranslateRequestBody {
    questionText: string;
    options: Array<{ text: string | null; isCorrect: boolean | null }>;
    solutionText: string;
    targetLanguage: string;
    provider: string;
    modelId: string;
    modelLabel?: string;
    localBaseUrl?: string;
    /** When provided, persists the translation to public.question_translations. */
    questionId?: string;
}

// ==================== CONFIGS ====================

const OPENAI_COMPATIBLE_CONFIGS: Record<string, { baseUrl: string; extraHeaders?: Record<string, string> }> = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: { "HTTP-Referer": "https://question-bank.app", "X-Title": "QBG AI Tools" },
    },
    groq: { baseUrl: "https://api.groq.com/openai/v1" },
    grok: { baseUrl: "https://api.x.ai/v1" },
    anthropic: { baseUrl: "https://api.anthropic.com/v1" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
    local: { baseUrl: "http://localhost:11434/v1" },
};

// ==================== PROMPT ====================

function buildTranslatePrompt(body: TranslateRequestBody): string {
    const optionsText = body.options
        .filter((o) => o.text !== null)
        .map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o.text}`)
        .join("\n");

    return `You are a professional translator specialized in educational content (Physics, Chemistry, Mathematics, Biology).

## Task

Translate the following question, its options, and its solution from English to **${body.targetLanguage}**.

## Rules

1. **Preserve all LaTeX mathematical expressions exactly as-is** — do NOT translate LaTeX commands, formulas, or symbols. Keep \\\\( \\\\), \\\\[ \\\\], and all math notation unchanged.
2. **Preserve all HTML tags** — keep <p>, <br>, <img>, <sub>, <sup>, <table> etc. exactly as-is.
3. **Only translate the natural language text** (question wording, option text, solution explanation).
4. **Maintain the same meaning and context** — do not simplify or alter the question.
5. **Keep scientific terms** that are commonly used in their original form (e.g., "pH", "DNA", element symbols).
6. **If the question contains diagrams or figures referenced by description, translate the description too.**

## Content to Translate

**Question Text:**
${body.questionText}

${optionsText ? `**Options:**\n${optionsText}` : ""}

**Solution Text:**
${body.solutionText || "No solution provided"}

## Response Format

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "translatedQuestionText": "<translated question in HTML format>",
  "translatedOptions": [
    { "text": "<translated option A>", "isCorrect": <same boolean as original> },
    { "text": "<translated option B>", "isCorrect": <same boolean as original> }
  ],
  "translatedSolutionText": "<translated solution in HTML format>",
  "targetLanguage": "${body.targetLanguage}",
  "translationNotes": "<any notes about the translation, e.g. terms kept in English>"
}`;
}

// ==================== AI CALL ====================

async function callAI(
    provider: string,
    modelId: string,
    apiKey: string,
    prompt: string,
    /** Address of a server the user runs (local / g4f); ignored for the rest. */
    selfHostedBaseUrl = ""
): Promise<string> {
    if (provider === "gemini") {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: "application/json" },
                }),
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errText}`);
        }

        const geminiRes = await response.json();
        const text = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini returned empty response.");
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
                temperature: 0.2,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${errText}`);
        }

        const anthropicRes = await response.json();
        const text = anthropicRes?.content?.[0]?.text;
        if (!text) throw new Error("Anthropic returned empty response.");
        return text;
    }

    // OpenAI-compatible providers. A server the user runs carries its own
    // address — falling through to the static table posts to api.openai.com,
    // which is where `local` was quietly going before g4f was added.
    const config = provider === "custom_openai"
        ? { baseUrl: getProviderBaseUrl("custom_openai", apiKey), extraHeaders: undefined }
        : !providerNeedsApiKey(provider as SupportedApiProvider)
            ? { baseUrl: selfHostedBaseUrl, extraHeaders: undefined }
            : OPENAI_COMPATIBLE_CONFIGS[provider] || OPENAI_COMPATIBLE_CONFIGS.openai;
    const actualApiKey = getProviderApiCredential(provider as any, apiKey);
    if (!config.baseUrl) throw new Error("OpenAI-compatible base URL is required.");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(providerNeedsApiKey(provider as SupportedApiProvider)
            ? { Authorization: `Bearer ${actualApiKey}` }
            : {}),
        ...config.extraHeaders,
    };

    // Reasoning models (o1, o3, o4-mini, etc.) don't support custom temperature
    const isReasoningModel = /^(o[1-4]|o[1-4][-_])/i.test(modelId);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            ...(isReasoningModel ? {} : { temperature: 0.2 }),
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
    if (!text) throw new Error(`${provider.toUpperCase()} returned empty response.`);
    return text;
}

// ==================== ROUTE HANDLER ====================

export async function POST(req: NextRequest) {
    const forbid = await checkAnyPermission(["use_ai_tools", "use_per_question_ai"]);
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as TranslateRequestBody;
        const { questionText, targetLanguage, provider, modelId } = body;

        if (!questionText?.trim()) {
            return NextResponse.json({ success: false, error: "Question text is required." }, { status: 400 });
        }
        if (!targetLanguage?.trim()) {
            return NextResponse.json({ success: false, error: "Target language is required." }, { status: 400 });
        }
        if (!provider || !isValidProvider(provider)) {
            return NextResponse.json({ success: false, error: "Valid AI provider is required." }, { status: 400 });
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "AI model ID is required." }, { status: 400 });
        }

        // Resolve API key
        let resolvedApiKey = "";
        let localBaseUrl = "";

        if (!providerNeedsApiKey(provider as SupportedApiProvider)) {
            localBaseUrl = provider === "g4f"
                ? (body.localBaseUrl?.trim() || "http://localhost:1337/v1")
                : (body.localBaseUrl?.trim() || "http://localhost:11434/v1");
            resolvedApiKey = "not-needed";
        } else {
            const supabase = await createClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
            } else if (req.cookies.get("qbg_dev_auth")?.value === "1") {
                resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            if (!getProviderApiCredential(provider as any, resolvedApiKey)) {
                return NextResponse.json(
                    { success: false, error: `No API key found for ${provider}. Add it from the user icon.` },
                    { status: 400 }
                );
            }
        }

        // Build prompt and call AI
        const prompt = buildTranslatePrompt(body);
        const rawResponse = await callAI(provider, modelId, resolvedApiKey, prompt, localBaseUrl);
        const parsed = parseStructuredAiResponse(rawResponse);

        const result = {
            translatedQuestionText: String(parsed.translatedQuestionText ?? ""),
            translatedOptions: Array.isArray(parsed.translatedOptions)
                ? (parsed.translatedOptions as Array<{ text?: string; isCorrect?: boolean }>).map((o) => ({
                    text: String(o.text ?? ""),
                    isCorrect: o.isCorrect === true,
                }))
                : [],
            translatedSolutionText: String(parsed.translatedSolutionText ?? ""),
            targetLanguage: String(parsed.targetLanguage ?? targetLanguage),
            translationNotes: String(parsed.translationNotes ?? ""),
        };

        // Persist to shared per-question translations table when a question_id is provided.
        let savedTranslation: Record<string, unknown> | null = null;
        let persistError: string | null = null;
        if (body.questionId) {
            try {
                const supabase = await createClient();
                const { data: { user } } = await supabase.auth.getUser();
                const insertPayload = {
                    question_id: body.questionId,
                    language: targetLanguage.toLowerCase().trim(),
                    question_text: result.translatedQuestionText,
                    options: result.translatedOptions,
                    solution_text: result.translatedSolutionText || null,
                    translation_notes: result.translationNotes || null,
                    provider,
                    model_id: modelId,
                    model_label: body.modelLabel || modelId,
                    translated_by: user?.id ?? null,
                };
                const { data: inserted, error: insertErr } = await supabase
                    .from("question_translations")
                    .insert(insertPayload)
                    .select("*")
                    .single();
                if (insertErr) {
                    persistError = insertErr.message;
                    console.warn("Persist translation failed:", insertErr.message);
                } else {
                    savedTranslation = inserted as Record<string, unknown>;
                }
            } catch (persistErr) {
                persistError = persistErr instanceof Error ? persistErr.message : String(persistErr);
                console.warn("Persist translation threw:", persistErr);
            }
        }

        return NextResponse.json({
            success: true,
            result,
            translation: savedTranslation,
            translationId: (savedTranslation as { id?: string } | null)?.id ?? null,
            persistError,
        });
    } catch (err) {
        console.error("AI Translate error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
