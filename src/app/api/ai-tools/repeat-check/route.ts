import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import type { AIModelProvider } from "@/types/extraction";
import { checkPermission } from "@/lib/auth/serverAuth";
import { parseStructuredAiResponse } from "@/lib/ai/verification";

const VALID_PROVIDERS = ["gemini", "openai", "openrouter", "groq", "grok", "nvidia", "fireworks", "custom_openai", "local"] as const;
function isValidProvider(v: string): v is AIModelProvider {
    return (VALID_PROVIDERS as readonly string[]).includes(v);
}

interface RepeatCheckFileInput {
    fileBase64: string;
    fileName: string;
}

interface RepeatCheckRequestBody {
    files: RepeatCheckFileInput[];
    provider: string;
    modelId: string;
    customPrompt?: string;
}

const OPENAI_COMPATIBLE_CONFIGS: Record<string, { baseUrl: string; extraHeaders?: Record<string, string> }> = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: { "HTTP-Referer": "https://question-bank.app", "X-Title": "QBG AI Tools" },
    },
    groq: { baseUrl: "https://api.groq.com/openai/v1" },
    grok: { baseUrl: "https://api.x.ai/v1" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
};

function getMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "doc") return "application/msword";
    return "application/pdf";
}

function buildRepeatCheckPrompt(): string {
    return `You are a highly accurate duplicate-question detection AI for competitive-exam question papers.

You are given multiple uploaded PDF files. Your task is to find repeated, duplicate, copied, near-duplicate, or semantically same questions within the same PDF and across different PDFs.

Compare every question against every other question. Treat questions as repeated when they test the same statement or problem, even if numbers, option order, formatting, or minor wording changed.

For each duplicate pair, provide:
- both PDF file names,
- both page numbers,
- both question numbers if visible,
- short excerpts of both questions,
- whether the match is Exact, Near Duplicate, or Semantic,
- percentage similarity from 0 to 100,
- a short reason explaining what is same.

Return ONLY valid JSON with this exact structure:

{
  "filesAnalyzed": <number>,
  "totalQuestionsDetected": <number>,
  "duplicatePairs": <number>,
  "summary": "<short overall summary>",
  "groups": [
    {
      "groupId": 1,
      "matchType": "Exact" | "Near Duplicate" | "Semantic",
      "similarityPercent": <number>,
      "reason": "<why these questions are repeated>",
      "items": [
        {
          "fileName": "<PDF file name>",
          "pageNumber": <number or null>,
          "questionNumber": "<visible question number or null>",
          "questionText": "<question excerpt, enough to identify it>"
        }
      ]
    }
  ]
}

If no repeats are found, return duplicatePairs as 0 and groups as an empty array.`;
}

async function callAI(
    provider: AIModelProvider,
    modelId: string,
    apiKey: string,
    files: RepeatCheckFileInput[],
    prompt: string
): Promise<string> {
    if (provider === "gemini") {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: prompt }];
        files.forEach((file, index) => {
            parts.push({ text: `\n\nUploaded file ${index + 1}: ${file.fileName}` });
            parts.push({ inlineData: { mimeType: getMimeType(file.fileName), data: file.fileBase64 } });
        });

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.05, maxOutputTokens: 65536, responseMimeType: "application/json" },
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

    const config = OPENAI_COMPATIBLE_CONFIGS[provider] || OPENAI_COMPATIBLE_CONFIGS.openai;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [{ type: "text", text: prompt }];

    files.forEach((file) => {
        const mimeType = getMimeType(file.fileName);
        if (provider === "openrouter") {
            contentParts.push({
                type: "file",
                file: {
                    filename: file.fileName || "document.pdf",
                    file_data: `data:${mimeType};base64,${file.fileBase64}`,
                },
            });
        } else {
            contentParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${file.fileBase64}` } });
        }
    });

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...config.extraHeaders,
    };

    const isReasoningModel = /^(o[1-4]|o[1-4][-_])/i.test(modelId);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: contentParts }],
            ...(isReasoningModel ? {} : { temperature: 0.05 }),
            max_completion_tokens: 32768,
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

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as RepeatCheckRequestBody;
        const { files, provider, modelId, customPrompt } = body;

        if (!Array.isArray(files) || files.length < 2) {
            return NextResponse.json({ success: false, error: "Upload at least two PDF files for repeat check." }, { status: 400 });
        }
        if (files.length > 10) {
            return NextResponse.json({ success: false, error: "Please upload 10 or fewer files at once." }, { status: 400 });
        }
        if (files.some((file) => !file.fileBase64 || !file.fileName)) {
            return NextResponse.json({ success: false, error: "Every uploaded file is required." }, { status: 400 });
        }
        if (!provider || !isValidProvider(provider)) {
            return NextResponse.json({ success: false, error: "Valid AI provider is required." }, { status: 400 });
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "AI model ID is required." }, { status: 400 });
        }
        if (provider === "groq" || provider === "local" || provider === "g4f" || provider === "nvidia" || provider === "fireworks" || provider === "custom_openai") {
            const name =
                provider === "groq" ? "Groq" :
                provider === "nvidia" ? "NVIDIA NIM" :
                provider === "fireworks" ? "Fireworks AI" :
                provider === "custom_openai" ? "OpenAI-compatible providers" :
                "Local models";
            return NextResponse.json(
                { success: false, error: `${name} do not support multi-PDF repeat checking. Please use Gemini, OpenAI, or OpenRouter instead.` },
                { status: 400 }
            );
        }

        let resolvedApiKey = "";
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
            resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
        } else if (hasDevAuthCookie(req.cookies)) {
            resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
        }

        if (!resolvedApiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon.` },
                { status: 400 }
            );
        }

        const defaultPrompt = buildRepeatCheckPrompt();
        const responseFormatStart = defaultPrompt.indexOf("Return ONLY valid JSON");
        const prompt = customPrompt?.trim()
            ? `${customPrompt.trim()}\n\n${responseFormatStart >= 0 ? defaultPrompt.slice(responseFormatStart) : defaultPrompt}`
            : defaultPrompt;
        const rawResponse = await callAI(provider as AIModelProvider, modelId, resolvedApiKey, files, prompt);
        const parsed = parseStructuredAiResponse(rawResponse);

        const report = {
            filesAnalyzed: Number(parsed.filesAnalyzed) || files.length,
            totalQuestionsDetected: Number(parsed.totalQuestionsDetected) || 0,
            duplicatePairs: Number(parsed.duplicatePairs) || 0,
            summary: String(parsed.summary || ""),
            groups: Array.isArray(parsed.groups)
                ? (parsed.groups as Record<string, unknown>[]).map((group, index) => ({
                    groupId: Number(group.groupId) || index + 1,
                    matchType: String(group.matchType || "Semantic"),
                    similarityPercent: Math.max(0, Math.min(100, Number(group.similarityPercent) || 0)),
                    reason: String(group.reason || ""),
                    items: Array.isArray(group.items)
                        ? (group.items as Record<string, unknown>[]).map((item) => ({
                            fileName: String(item.fileName || ""),
                            pageNumber: item.pageNumber === null || item.pageNumber === undefined ? null : Number(item.pageNumber) || null,
                            questionNumber: item.questionNumber === null || item.questionNumber === undefined ? null : String(item.questionNumber),
                            questionText: String(item.questionText || ""),
                        }))
                        : [],
                }))
                : [],
        };

        return NextResponse.json({ success: true, report });
    } catch (err) {
        console.error("AI Repeat Check error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
