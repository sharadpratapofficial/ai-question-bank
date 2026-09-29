import { hasDevAuthCookie } from "@/lib/auth/devAuth";
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
import { checkPermission } from "@/lib/auth/serverAuth";

const VALID_PROVIDERS = ["gemini", "openai", "openrouter", "groq", "grok", "anthropic", "nvidia", "fireworks", "custom_openai", "local", "g4f"] as const;

type Provider = AIModelProvider | "anthropic";

interface TranslateDocumentBody {
    mode: "pdf" | "test";
    provider: string;
    modelId: string;
    targetLanguage: string;
    customPrompt: string;
    documents?: Array<{
        label: string;
        fileName: string;
        mimeType: string;
        fileBase64: string;
    }>;
    items?: Array<{
        id: string;
        questionText: string;
        options: Array<{ text: string | null; isCorrect: boolean | null }>;
        solutionText: string;
    }>;
}

function isValidProvider(value: string): value is Provider {
    return (VALID_PROVIDERS as readonly string[]).includes(value);
}

function stripCodeFence(rawText: string): string {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    return cleaned.trim();
}

function parseJsonObject(rawText: string): Record<string, unknown> {
    return JSON.parse(stripCodeFence(rawText));
}

async function resolveApiKey(req: NextRequest, provider: string): Promise<string> {
    if (!providerNeedsApiKey(provider as SupportedApiProvider)) return "not-needed";

    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    let resolvedApiKey = "";
    if (user) {
        resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider as keyof ReturnType<typeof sanitizeUserApiKeys>] || "";
    } else if (hasDevAuthCookie(req.cookies)) {
        resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
    }

    if (!getProviderApiCredential(provider as any, resolvedApiKey)) {
        throw new Error(`No API key found for ${provider}. Add it from the user icon.`);
    }

    return resolvedApiKey;
}

function buildPdfPrompt(body: TranslateDocumentBody): string {
    return `${body.customPrompt}

Target language: ${body.targetLanguage}

Return ONLY valid JSON with this exact shape:
{
  "translatedHtml": "<complete translated document as semantic HTML>",
  "plainText": "<same translated content as readable plain text>",
  "notes": "<brief notes about preserved math, diagrams, or unreadable parts>"
}

Preserve mathematical notation, LaTeX, symbols, tables, question numbers, option labels, answer keys, and solution structure. Do not summarize. Translate every readable natural-language sentence from the attached PDF document(s).`;
}

function buildTestPrompt(body: TranslateDocumentBody): string {
    return `${body.customPrompt}

Target language: ${body.targetLanguage}

Translate each question item below. Preserve all HTML tags, LaTeX/math notation, option order, option correctness, answer meaning, and solution structure. Do not solve or modify the questions.

Return ONLY valid JSON with this exact shape:
{
  "translations": [
    {
      "id": "<same id>",
      "translatedQuestionText": "<translated question HTML>",
      "translatedOptions": [{ "text": "<translated option HTML or null>", "isCorrect": true }],
      "translatedSolutionText": "<translated solution HTML>"
    }
  ],
  "notes": "<brief notes>"
}

Items:
${JSON.stringify(body.items || [])}`;
}

async function callGeminiWithDocuments(
    modelId: string,
    apiKey: string,
    prompt: string,
    documents: NonNullable<TranslateDocumentBody["documents"]>
): Promise<string> {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    documents.forEach((doc) => {
        parts.push({
            inlineData: {
                mimeType: doc.mimeType || "application/pdf",
                data: doc.fileBase64,
            },
        });
    });

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 32768,
                    responseMimeType: "application/json",
                },
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`Gemini API error (${response.status}): ${await response.text()}`);
    }

    const json = await response.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned an empty translation.");
    return text;
}

async function callTextModel(provider: string, modelId: string, apiKey: string, prompt: string,
                            /** Address of a server the user runs (local / g4f). */
                            selfHostedBaseUrl = ""): Promise<string> {
    if (provider === "gemini") {
        return callGeminiWithDocuments(modelId, apiKey, prompt, []);
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
                max_tokens: 32768,
                temperature: 0.2,
                messages: [{ role: "user", content: prompt }],
            }),
        });
        if (!response.ok) throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
        const json = await response.json();
        const text = json?.content?.[0]?.text;
        if (!text) throw new Error("Anthropic returned an empty translation.");
        return text;
    }

    const baseUrl =
        provider === "custom_openai"
            ? getProviderBaseUrl("custom_openai", apiKey)
            : !providerNeedsApiKey(provider as SupportedApiProvider)
            ? selfHostedBaseUrl
            : provider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : provider === "groq"
                    ? "https://api.groq.com/openai/v1"
                    : provider === "grok"
                        ? "https://api.x.ai/v1"
                        : provider === "nvidia"
                            ? "https://integrate.api.nvidia.com/v1"
                            : provider === "fireworks"
                                ? "https://api.fireworks.ai/inference/v1"
                                : provider === "local"
                                    ? "http://localhost:11434/v1"
                                    : "https://api.openai.com/v1";

    if (!baseUrl) throw new Error("OpenAI-compatible base URL is required.");

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(providerNeedsApiKey(provider as SupportedApiProvider)
                ? { Authorization: `Bearer ${getProviderApiCredential(provider as any, apiKey)}` }
                : {}),
            ...(provider === "openrouter" ? { "HTTP-Referer": "https://question-bank.app", "X-Title": "QBG AI Tools" } : {}),
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            max_completion_tokens: 32768,
            response_format: { type: "json_object" },
        }),
    });

    if (!response.ok) throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${await response.text()}`);
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider.toUpperCase()} returned an empty translation.`);
    return text;
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as TranslateDocumentBody;
        const provider = body.provider;
        const modelId = body.modelId?.trim();
        const targetLanguage = body.targetLanguage?.trim();

        if (!isValidProvider(provider)) {
            return NextResponse.json({ success: false, error: "Valid AI provider is required." }, { status: 400 });
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "AI model is required." }, { status: 400 });
        }
        if (!targetLanguage) {
            return NextResponse.json({ success: false, error: "Target language is required." }, { status: 400 });
        }

        const apiKey = await resolveApiKey(req, provider);

        if (body.mode === "pdf") {
            const documents = (body.documents || []).filter((doc) => doc.fileBase64);
            if (!documents.length) {
                return NextResponse.json({ success: false, error: "Upload at least one PDF to translate." }, { status: 400 });
            }
            if (provider !== "gemini") {
                return NextResponse.json(
                    { success: false, error: "PDF translation currently requires Gemini because it can read PDF files directly." },
                    { status: 400 }
                );
            }
            const parsed = parseJsonObject(await callGeminiWithDocuments(modelId, apiKey, buildPdfPrompt(body), documents));
            return NextResponse.json({
                success: true,
                result: {
                    targetLanguage,
                    translatedHtml: String(parsed.translatedHtml || ""),
                    plainText: String(parsed.plainText || ""),
                    notes: String(parsed.notes || ""),
                },
            });
        }

        const items = body.items || [];
        if (!items.length) {
            return NextResponse.json({ success: false, error: "No test questions were provided for translation." }, { status: 400 });
        }
        const selfHostedBaseUrl = provider === "g4f"
            ? "http://localhost:1337/v1"
            : provider === "local"
                ? "http://localhost:11434/v1"
                : "";
        const parsed = parseJsonObject(await callTextModel(provider, modelId, apiKey, buildTestPrompt(body), selfHostedBaseUrl));
        return NextResponse.json({
            success: true,
            result: {
                targetLanguage,
                translations: Array.isArray(parsed.translations) ? parsed.translations : [],
                notes: String(parsed.notes || ""),
            },
        });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
