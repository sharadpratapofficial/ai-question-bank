import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
} from "@/lib/userApiKeys";
import type { QuestionOption } from "@/types";
import { checkPermission } from "@/lib/auth/serverAuth";

type AIQuestionProvider =
    | "gemini"
    | "openrouter"
    | "anthropic"
    | "openai"
    | "grok"
    | "groq"
    | "nvidia"
    | "fireworks"
    | "custom_openai"
    | "local";

interface GenerateAIQuestionsRequest {
    provider?: string;
    modelId?: string;
    count?: number;
    questionType?: string;
    subject?: string;
    chapter?: string;
    topic?: string;
    subtopic?: string;
    difficultyLevel?: string;
    classLevel?: string;
    exams?: string[];
    source?: string;
    localBaseUrl?: string;
}

interface GeneratedQuestionDraft {
    question_text: string;
    options: QuestionOption[];
    answer_key: number | number[] | null;
    solution_text: string;
    question_type: string;
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string | null;
    source: string;
    difficutly_level: string;
    class_level: string | null;
    exam: string[] | null;
}

const OPENAI_COMPATIBLE_BASE_URLS: Record<
    Exclude<AIQuestionProvider, "gemini" | "anthropic" | "custom_openai">,
    string
> = {
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    grok: "https://api.x.ai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    local: "http://localhost:11434/v1",
};

function isProvider(value: string): value is AIQuestionProvider {
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

function isNumericalQuestionType(questionType: string): boolean {
    const normalized = String(questionType || "")
        .trim()
        .toLowerCase()
        .replace(/[\s()-]+/g, "_");
    return (
        normalized === "integer" ||
        normalized === "numerical" ||
        normalized === "single_digit_integer" ||
        normalized === "passage_numerical" ||
        normalized.includes("single_digit_integer") ||
        normalized.includes("passage_numerical")
    );
}

function extractJson(text: string): unknown {
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    return JSON.parse(cleaned.trim());
}

function parseAnswerIndex(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(1, Math.floor(value));
    }
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return Math.max(1, Math.floor(numeric));

    const upper = trimmed.toUpperCase();
    if (upper.length === 1 && upper >= "A" && upper <= "H") {
        return upper.charCodeAt(0) - 64;
    }
    return null;
}

function normalizeOptions(value: unknown): QuestionOption[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((option) => {
            if (typeof option === "string") {
                return { text: option.trim() || null, isCorrect: false };
            }
            if (typeof option === "object" && option !== null) {
                const record = option as Record<string, unknown>;
                const text =
                    record.text === null || record.text === undefined
                        ? null
                        : String(record.text);
                const isCorrect =
                    typeof record.isCorrect === "boolean" ? record.isCorrect : false;
                return { text: text?.trim() ? text : null, isCorrect };
            }
            return { text: null, isCorrect: false };
        })
        .filter((option) => option.text !== null);
}

function normalizeDraft(
    raw: unknown,
    index: number,
    input: Required<
        Pick<
            GenerateAIQuestionsRequest,
            | "questionType"
            | "subject"
            | "chapter"
            | "topic"
            | "subtopic"
            | "difficultyLevel"
            | "classLevel"
            | "source"
        >
    > &
        Pick<GenerateAIQuestionsRequest, "exams">
): GeneratedQuestionDraft {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

    const questionText = String(
        row.questionText ?? row.question_text ?? `Generated question ${index + 1}`
    ).trim();
    const solutionText = String(row.solutionText ?? row.solution_text ?? "").trim();
    const questionType = String(row.questionType ?? row.question_type ?? input.questionType).trim();

    const numerical = isNumericalQuestionType(questionType);
    const options = numerical ? [] : normalizeOptions(row.options);

    let answerKey: number | number[] | null = null;
    if (numerical) {
        const rawAnswer = row.answerKey ?? row.answer_key;
        const numericAnswer = Array.isArray(rawAnswer)
            ? Number(rawAnswer[0])
            : Number(rawAnswer);
        answerKey = Number.isFinite(numericAnswer) ? numericAnswer : null;
    } else {
        const rawAnswer = row.answerKey ?? row.answer_key;
        if (Array.isArray(rawAnswer)) {
            const parsed = rawAnswer
                .map((value) => parseAnswerIndex(value))
                .filter((value): value is number => value !== null);
            answerKey = parsed.length ? [...new Set(parsed)] : null;
        } else {
            const parsed = parseAnswerIndex(rawAnswer);
            answerKey = parsed !== null ? [parsed] : null;
        }

        if (!answerKey && options.length > 0) {
            const derived = options
                .map((opt, optionIndex) => (opt.isCorrect ? optionIndex + 1 : null))
                .filter((value): value is number => value !== null);
            answerKey = derived.length > 0 ? derived : null;
        }
    }

    const exams = Array.isArray(input.exams)
        ? input.exams.map((exam) => String(exam).trim()).filter(Boolean)
        : [];

    return {
        question_text: questionText || `Generated question ${index + 1}`,
        options,
        answer_key: answerKey,
        solution_text: solutionText,
        question_type: questionType || input.questionType,
        subject: String(row.subject ?? input.subject ?? "").trim(),
        chapter: String(row.chapter ?? input.chapter ?? "").trim(),
        topic: String(row.topic ?? input.topic ?? "").trim(),
        subtopic: String(row.subtopic ?? input.subtopic ?? "").trim() || null,
        source: String(row.source ?? input.source ?? "AI Generated").trim() || "AI Generated",
        difficutly_level:
            String(row.difficultyLevel ?? row.difficutly_level ?? input.difficultyLevel).trim() ||
            "Medium",
        class_level:
            String(row.classLevel ?? row.class_level ?? input.classLevel).trim() || null,
        exam: exams.length ? exams : null,
    };
}

function buildPrompt(args: {
    count: number;
    questionType: string;
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string;
    difficultyLevel: string;
    classLevel: string;
    exams: string[];
}): string {
    const numerical = isNumericalQuestionType(args.questionType);
    return `You are an expert exam question writer for JEE/NEET content.

Generate EXACTLY ${args.count} high-quality questions.

Metadata constraints:
- questionType: ${args.questionType}
- subject: ${args.subject}
- chapter: ${args.chapter || "Any chapter in selected subject"}
- topic: ${args.topic || "Any topic in chapter"}
- subtopic: ${args.subtopic || "Any relevant subtopic"}
- difficulty: ${args.difficultyLevel || "Medium"}
- classLevel: ${args.classLevel || "11 or 12"}
- exams: ${args.exams.length ? args.exams.join(", ") : "No fixed exam"}

Rules:
1) Return STRICT JSON only: {"questions":[...]} (no markdown).
2) Keep questionText and solutionText HTML-safe, concise, and accurate.
3) ${
        numerical
            ? 'For numerical types, return options as [] and answerKey as a number.'
            : 'For option-based types, return 4 options and answerKey as 1-indexed number or array.'
    }
4) Do not leave fields empty unless absolutely necessary.

Each question object must follow:
{
  "questionText": string,
  "options": string[] | [{ "text": string, "isCorrect": boolean }],
  "answerKey": number | number[] | string | null,
  "solutionText": string,
  "subject": string,
  "chapter": string,
  "topic": string,
  "subtopic": string,
  "difficultyLevel": "Easy" | "Medium" | "Hard",
  "classLevel": "11" | "12" | ""
}`;
}

async function runGeminiModel(modelId: string, apiKey: string, prompt: string): Promise<string> {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.5,
                    maxOutputTokens: 32768,
                    responseMimeType: "application/json",
                },
            }),
        }
    );

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty content.");
    return text;
}

async function runAnthropicModel(modelId: string, apiKey: string, prompt: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: modelId,
            max_completion_tokens: 8192,
            temperature: 0.5,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
    };
    const text = payload.content?.find((part) => part.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned empty content.");
    return text;
}

async function runOpenAICompatibleModel(
    provider: Exclude<AIQuestionProvider, "gemini" | "anthropic">,
    modelId: string,
    apiKey: string,
    prompt: string
): Promise<string> {
    const baseUrl = provider === "custom_openai"
        ? getProviderBaseUrl(provider, apiKey)
        : OPENAI_COMPATIBLE_BASE_URLS[provider];
    const actualApiKey = getProviderApiCredential(provider, apiKey);
    if (!baseUrl) throw new Error("OpenAI-compatible base URL is required.");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(provider !== "local" ? { Authorization: `Bearer ${actualApiKey}` } : {}),
    };

    if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://question-bank.app";
        headers["X-Title"] = "Question Bank";
    }

    // Reasoning models (o1, o3, o4-mini, etc.) don't support custom temperature
    const isReasoningModel = /^(o[1-4]|o[1-4][-_])/i.test(modelId);

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            ...(isReasoningModel ? {} : { temperature: 0.5 }),
            max_completion_tokens: 8192,
            response_format: { type: "json_object" },
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider.toUpperCase()} returned empty content.`);
    return text;
}

async function runAIModel(
    provider: AIQuestionProvider,
    modelId: string,
    apiKey: string,
    prompt: string
): Promise<string> {
    if (provider === "gemini") return runGeminiModel(modelId, apiKey, prompt);
    if (provider === "anthropic") return runAnthropicModel(modelId, apiKey, prompt);
    return runOpenAICompatibleModel(provider, modelId, apiKey, prompt);
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as GenerateAIQuestionsRequest;
        const provider = String(body.provider || "").trim();
        const modelId = String(body.modelId || "").trim();
        const count = Math.max(1, Math.min(25, Number(body.count || 0)));
        const questionType = String(body.questionType || "").trim();
        const subject = String(body.subject || "").trim();

        if (!isProvider(provider)) {
            return NextResponse.json(
                { success: false, questions: [], error: "Valid AI provider is required." },
                { status: 400 }
            );
        }
        if (!modelId) {
            return NextResponse.json(
                { success: false, questions: [], error: "AI model ID is required." },
                { status: 400 }
            );
        }
        if (!questionType) {
            return NextResponse.json(
                { success: false, questions: [], error: "Question type is required." },
                { status: 400 }
            );
        }
        if (!subject) {
            return NextResponse.json(
                { success: false, questions: [], error: "Subject is required." },
                { status: 400 }
            );
        }

        let resolvedApiKey = "";

        if (provider === "local") {
            // For local provider, use the localBaseUrl from the request body
            const localUrl = String(body.localBaseUrl || "").trim() || "http://localhost:11434/v1";
            OPENAI_COMPATIBLE_BASE_URLS.local = localUrl;
            resolvedApiKey = "not-needed";
        } else {
            const supabase = await createClient();
            const {
                data: { user },
            } = await supabase.auth.getUser();

            if (user) {
                resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
            } else if (hasDevAuthCookie(req.cookies)) {
                resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
            }

            if (!getProviderApiCredential(provider, resolvedApiKey)) {
                return NextResponse.json(
                    {
                        success: false,
                        questions: [],
                        error: `No saved API key found for ${provider}. Add it from the user icon.`,
                    },
                    { status: 400 }
                );
            }
        }

        const prompt = buildPrompt({
            count,
            questionType,
            subject,
            chapter: String(body.chapter || "").trim(),
            topic: String(body.topic || "").trim(),
            subtopic: String(body.subtopic || "").trim(),
            difficultyLevel: String(body.difficultyLevel || "Medium").trim(),
            classLevel: String(body.classLevel || "").trim(),
            exams: Array.isArray(body.exams)
                ? body.exams.map((exam) => String(exam).trim()).filter(Boolean)
                : [],
        });

        const rawText = await runAIModel(provider, modelId, resolvedApiKey, prompt);
        const parsed = extractJson(rawText) as { questions?: unknown[] };
        const rows = Array.isArray(parsed.questions) ? parsed.questions : [];

        const normalized = rows.map((row, index) =>
            normalizeDraft(row, index, {
                questionType,
                subject,
                chapter: String(body.chapter || "").trim(),
                topic: String(body.topic || "").trim(),
                subtopic: String(body.subtopic || "").trim(),
                difficultyLevel: String(body.difficultyLevel || "Medium").trim() || "Medium",
                classLevel: String(body.classLevel || "").trim(),
                source: String(body.source || "AI Generated").trim() || "AI Generated",
                exams: Array.isArray(body.exams) ? body.exams : [],
            })
        );

        return NextResponse.json({
            success: true,
            questions: normalized.slice(0, count),
        });
    } catch (error) {
        console.error("API Error generating AI questions:", error);
        return NextResponse.json(
            {
                success: false,
                questions: [],
                error: error instanceof Error ? error.message : "Failed to generate AI questions",
            },
            { status: 500 }
        );
    }
}
