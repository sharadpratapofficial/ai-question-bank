import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import type { AIModelProvider } from "@/types/extraction";
import { checkPermission } from "@/lib/auth/serverAuth";
import { parseStructuredAiResponse } from "@/lib/ai/verification";

// ==================== TYPES ====================

const VALID_PROVIDERS = ["gemini", "openai", "openrouter", "groq", "grok", "nvidia", "fireworks", "custom_openai", "local"] as const;
function isValidProvider(v: string): v is AIModelProvider {
    return (VALID_PROVIDERS as readonly string[]).includes(v);
}

type ModificationMode = "light" | "hard";

interface ModificationRequestBody {
    fileBase64: string;
    fileName: string;
    provider: string;
    modelId: string;
    mode: ModificationMode;
    customPrompt?: string;
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
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
};

// ==================== PROMPT ====================

function buildModificationPrompt(mode: ModificationMode): string {
    const modeInstructions =
        mode === "light"
            ? `## Light Modification Mode

Your task is to LIGHTLY modify each question so the core concept stays the same but the question appears different:
- **Change numerical values** (coefficients, constants, distances, masses, speeds, etc.) — use realistic, solvable values.
- **Rephrase the question text** to use different wording, sentence structure, and phrasing.
- **Swap / rearrange options** for multiple-choice questions — change their text slightly but keep the same conceptual options.
- **The answer KEY MUST CHANGE** — the correct answer should map to a different option number/letter after modification.
- **Change proper nouns** in word problems (names, places, objects) while keeping the physics/chemistry/math scenario identical.
- **DO NOT change** the underlying concept, chapter, topic, difficulty, or question type.
- **DO NOT make the question harder or easier** — maintain the same difficulty level.
- The modified question MUST be solvable and have a definitive correct answer.`
            : `## Hard Modification Mode

Your task is to create a SUBSTANTIALLY new question inspired by each original, making it very hard to find the original via search:
- **Create a NEW question** based on the same chapter and a closely related concept. The question should test a similar skill but use a completely different scenario, setup, or context.
- **Change ALL nouns, proper names, objects, and scenarios** — make it impossible to Google the original question.
- **Change the mathematical setup** — use different values, different configurations, different given/unknown quantities, but test the same underlying physics/chemistry/math principle.
- **Make the question HARDER (conceptually deeper)** than the original — add an extra reasoning step, combine two sub-concepts, or require more careful analysis.
- **Keep the same question type** (SCQ→SCQ, MCQ→MCQ, Integer→Integer, Numerical→Numerical, etc.).
- **Keep the same subject and chapter** as the original.
- **DO NOT use overly complicated or graduate-level terminology** — these questions are for JEE and NEET aspirants (class 11-12 level).
- **DO NOT make the question confusing or ambiguous** — it must be clearly solvable with a definitive answer.
- **Avoid technical jargon that would be inappropriate** for competitive exam preparation at the 11th-12th standard level.
- The question should feel fresh and original while testing the same competency area.
- For SCQ/MCQ type questions, ensure all options are plausible and well-crafted.`;

    return `You are an expert educational content creator specializing in Physics, Chemistry, and Mathematics for competitive exams (JEE Mains, JEE Advanced, NEET).

You are given a PDF file containing a question paper with questions from grade 11 and 12.

${modeInstructions}

## Critical Rules

1. **Maintain the EXACT same number of questions** as in the original paper.
2. **Maintain the EXACT same question type** for each question (SCQ→SCQ, MCQ→MCQ, Integer→Integer, Numerical→Numerical, Assertion-Reason→Assertion-Reason, etc.).
3. **Maintain the SAME subject and chapter** for each question.
4. **Use LaTeX notation** for all mathematical expressions: \\\\( ... \\\\) for inline and \\\\[ ... \\\\] for display math.
5. **Format question text and options as HTML** with embedded LaTeX for rendering.
6. **Each modified question MUST have a correct, verifiable answer.**
7. **Chemical formulas** must use LaTeX: e.g., \\\\(H_2SO_4\\\\)
8. For SCQ type, provide exactly 4 options with exactly 1 correct.
9. For MCQ type, provide exactly 4 options with 1 or more correct.
10. For Integer/Numerical type, provide the numerical answer.

## Response Format

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "totalQuestions": <number>,
  "modificationMode": "${mode}",
  "questions": [
    {
      "questionNumber": 1,
      "originalQuestionSummary": "<brief summary of the original question — first 80 chars>",
      "modifiedQuestionText": "<full modified question text as HTML with LaTeX>",
      "options": [
        { "text": "<option HTML with LaTeX>", "isCorrect": true|false }
      ],
      "answerKey": <correct answer — for SCQ: option number (1-indexed), for Integer/Numerical: the number, for MCQ: array of correct option numbers>,
      "solutionText": "<brief solution/explanation for the modified question as HTML with LaTeX>",
      "questionType": "<SCQ/MCQ/Integer/Numerical/Assertion_Reason/Matching_List/Passage>",
      "subject": "<Physics/Chemistry/Maths>",
      "chapter": "<identified chapter>",
      "topic": "<identified topic>",
      "difficulty": "<Easy/Medium/Hard>",
      "changesSummary": "<brief description of what was changed from the original>"
    }
  ]
}

IMPORTANT:
- If the file contains more than 50 questions, only modify the first 50 and note this.
- Every question must be solvable and have a clear, verifiable answer.
- DO NOT skip any question — modify ALL questions in the paper.`;
}

// ==================== AI CALL ====================

async function callAI(
    provider: AIModelProvider,
    modelId: string,
    apiKey: string,
    fileBase64: string,
    fileName: string,
    prompt: string
): Promise<string> {
    const ext = fileName.toLowerCase().split(".").pop();
    const mimeType = ext === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : ext === "doc"
            ? "application/msword"
            : "application/pdf";

    if (provider === "gemini") {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        parts.push({ text: prompt });
        parts.push({ inlineData: { mimeType, data: fileBase64 } });

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 65536, responseMimeType: "application/json" },
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

    // OpenAI-compatible providers
    const config = OPENAI_COMPATIBLE_CONFIGS[provider] || OPENAI_COMPATIBLE_CONFIGS.openai;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [];
    contentParts.push({ type: "text", text: prompt });

    if (provider === "openrouter") {
        contentParts.push({
            type: "file",
            file: {
                filename: fileName || "document.pdf",
                file_data: `data:${mimeType};base64,${fileBase64}`,
            },
        });
    } else {
        contentParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${fileBase64}` } });
    }

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...config.extraHeaders,
    };

    // Reasoning models (o1, o3, o4-mini, etc.) don't support custom temperature
    const isReasoningModel = /^(o[1-4]|o[1-4][-_])/i.test(modelId);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: contentParts }],
            ...(isReasoningModel ? {} : { temperature: 0.7 }),
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
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as ModificationRequestBody;
        const { fileBase64, fileName, provider, modelId, mode, customPrompt } = body;

        if (!fileBase64 || !fileName) {
            return NextResponse.json({ success: false, error: "File is required." }, { status: 400 });
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
                { success: false, error: `${name} do not support PDF/file analysis. Please use Gemini, OpenAI, or OpenRouter instead.` },
                { status: 400 }
            );
        }
        if (!mode || !["light", "hard"].includes(mode)) {
            return NextResponse.json({ success: false, error: "Valid modification mode (light/hard) is required." }, { status: 400 });
        }

        // Resolve API key
        let resolvedApiKey = "";
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
            resolvedApiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
        } else if (req.cookies.get("qbg_dev_auth")?.value === "1") {
            resolvedApiKey = req.headers.get("x-dev-api-key")?.trim() || "";
        }

        if (!resolvedApiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon.` },
                { status: 400 }
            );
        }

        // Build prompt and call AI
        const defaultPrompt = buildModificationPrompt(mode);
        const responseFormatStart = defaultPrompt.indexOf("## Response Format");
        const prompt = customPrompt?.trim()
            ? `${customPrompt.trim()}\n\n${responseFormatStart >= 0 ? defaultPrompt.slice(responseFormatStart) : defaultPrompt}`
            : defaultPrompt;
        const rawResponse = await callAI(provider as AIModelProvider, modelId, resolvedApiKey, fileBase64, fileName, prompt);
        const parsed = parseStructuredAiResponse(rawResponse);

        // Normalize the report
        const report = {
            totalQuestions: Number(parsed.totalQuestions) || 0,
            modificationMode: String(parsed.modificationMode || mode),
            questions: Array.isArray(parsed.questions)
                ? (parsed.questions as Record<string, unknown>[]).map((q) => ({
                    questionNumber: Number(q.questionNumber) || 0,
                    originalQuestionSummary: String(q.originalQuestionSummary || ""),
                    modifiedQuestionText: String(q.modifiedQuestionText || ""),
                    options: Array.isArray(q.options)
                        ? (q.options as Array<{ text?: string; isCorrect?: boolean }>).map((opt) => ({
                            text: String(opt.text || ""),
                            isCorrect: opt.isCorrect === true,
                        }))
                        : [],
                    answerKey: q.answerKey ?? null,
                    solutionText: String(q.solutionText || ""),
                    questionType: String(q.questionType || "SCQ"),
                    subject: String(q.subject || ""),
                    chapter: String(q.chapter || ""),
                    topic: q.topic ? String(q.topic) : undefined,
                    difficulty: String(q.difficulty || "Medium"),
                    changesSummary: String(q.changesSummary || ""),
                }))
                : [],
        };

        return NextResponse.json({ success: true, report });
    } catch (err) {
        console.error("AI Modification error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
