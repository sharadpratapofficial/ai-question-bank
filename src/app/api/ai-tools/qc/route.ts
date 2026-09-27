import { hasDevAuthCookie } from "@/lib/auth/devAuth";
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

interface QCRequestBody {
    fileBase64: string;
    fileName: string;
    solutionFileBase64?: string;
    solutionFileName?: string;
    provider: string;
    modelId: string;
    contentType: string;
    examType?: string;
    syllabus?: Record<string, string[]>;
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
    local: { baseUrl: "http://localhost:11434/v1" },
};

// ==================== PROMPT ====================

function buildQCPrompt(contentType: string, examType?: string, syllabus?: Record<string, string[]>, hasSolutionFile?: boolean): string {
    const contentDesc =
        contentType === "questions_answer_key_solution"
            ? "questions, answer keys, AND solutions"
            : contentType === "questions_with_answer_key"
                ? "questions AND answer keys (no solutions)"
                : "questions ONLY (no answer keys or solutions)";

    let examInstructions = "";
    if (examType) {
        examInstructions = `\n\n## Exam Context\nThis paper is for exam type: ${examType.replace(/_/g, " ")}. Evaluate questions against the expected standard, difficulty, and pattern for this exam.`;
    }

    let syllabusInstructions = "";
    if (syllabus && Object.keys(syllabus).length > 0) {
        const syllabusStr = Object.entries(syllabus)
            .map(([subj, chapters]) =>
                chapters.length > 0 ? `- ${subj}: ${chapters.join(", ")}` : `- ${subj}: (all chapters)`
            )
            .join("\n");
        syllabusInstructions = `\n\n## Expected Syllabus\nThe paper should cover these subjects and chapters:\n${syllabusStr}\n\nAnalyze whether the paper covers the expected syllabus adequately. Note any missing or over-represented topics in your syllabusAnalysis field.`;
    }

    return `You are a highly accurate Question Paper Quality Check AI for educational content (Physics, Chemistry, Mathematics).

${hasSolutionFile
? `You are given TWO PDF files:
1. **Questions PDF** — contains the questions.
2. **Solutions PDF** — contains solutions/answer keys for the same questions.

The questions file contains ${contentDesc}. Use the solutions file to compare and verify answer keys.`
: `You are given a PDF file that contains ${contentDesc}.`}

## Your Task

1. Parse and identify EVERY question in the paper (max 50 questions).
2. For each question:
   a. Solve the question yourself to determine the correct answer.
   b. If an answer key is provided, compare your answer with the provided answer.
   c. Evaluate the question for: correctness, completeness, language quality, and clarity.
   d. Provide specific suggestions for improvement if any.
   e. Identify the chapter, topic, question type, and difficulty level.
3. Provide a paper-level analysis:
   a. Chapter distribution across questions.
   b. Question type distribution.
   c. Overall suggestions for the paper.
${examInstructions}${syllabusInstructions}

## Response Format

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "totalQuestions": <number>,
  "questionsAnalyzed": <number>,
  "answerKeyMatches": <number — count of questions where your answer matches the provided answer key>,
  "answerKeyMismatches": <number — count where your answer differs from provided key>,
  "chapterDistribution": { "<chapter name>": <count>, ... },
  "questionTypeDistribution": { "<question type>": <count>, ... },
  "overallSuggestions": ["<suggestion 1>", "<suggestion 2>", ...],
  "patternAnalysis": "<analysis of the overall exam pattern, difficulty curve, etc.>",
  "syllabusAnalysis": "<analysis of syllabus coverage, missing topics, etc. or empty string if no syllabus provided>",
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "<brief summary of the question — first 100 chars>",
      "aiAnswer": <your calculated answer — string or number or null>,
      "providedAnswer": <answer from the paper's key — string or number or null>,
      "answerMatch": <true if your answer matches provided, false if mismatch, null if no provided answer>,
      "correctness": "<Correct / Incorrect / Partially Correct / Cannot Determine — with brief explanation>",
      "suggestions": ["<improvement suggestion 1>", ...],
      "languageQuality": "<Good / Needs Improvement — with brief note>",
      "solutionQuality": "<Good / Needs Improvement / Not Provided — with brief note>",
      "chapter": "<identified chapter>",
      "topic": "<identified topic>",
      "questionType": "<SCQ/MCQ/Integer/Numerical/etc.>",
      "difficulty": "<Easy/Medium/Hard>"
    }
  ]
}

IMPORTANT: If the file contains more than 50 questions, only analyze the first 50 and note this in overallSuggestions.`;
}

// ==================== AI CALL ====================

async function callAI(
    provider: AIModelProvider,
    modelId: string,
    apiKey: string,
    fileBase64: string,
    fileName: string,
    prompt: string,
    solutionFileBase64?: string,
    solutionFileName?: string
): Promise<string> {
    const ext = fileName.toLowerCase().split(".").pop();
    const mimeType = ext === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : ext === "doc"
            ? "application/msword"
            : "application/pdf";
    const solExt = solutionFileName?.toLowerCase().split(".").pop();
    const solutionMimeType = solExt === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : solExt === "doc"
            ? "application/msword"
            : "application/pdf";

    if (provider === "gemini") {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        parts.push({ text: prompt });
        parts.push({ inlineData: { mimeType, data: fileBase64 } });

        if (solutionFileBase64) {
            parts.push({ text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:" });
            parts.push({ inlineData: { mimeType: solutionMimeType, data: solutionFileBase64 } });
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 65536, responseMimeType: "application/json" },
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
        // OpenRouter uses "file" content type for PDFs
        contentParts.push({
            type: "file",
            file: {
                filename: fileName || "document.pdf",
                file_data: `data:${mimeType};base64,${fileBase64}`,
            },
        });
        if (solutionFileBase64) {
            contentParts.push({ type: "text", text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:" });
            contentParts.push({
                type: "file",
                file: {
                    filename: solutionFileName || "solutions.pdf",
                    file_data: `data:${solutionMimeType};base64,${solutionFileBase64}`,
                },
            });
        }
    } else {
        // OpenAI and others use image_url for file data
        contentParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${fileBase64}` } });
        if (solutionFileBase64) {
            contentParts.push({ type: "text", text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:" });
            contentParts.push({ type: "image_url", image_url: { url: `data:${solutionMimeType};base64,${solutionFileBase64}` } });
        }
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
            ...(isReasoningModel ? {} : { temperature: 0.1 }),
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
        const body = (await req.json()) as QCRequestBody;
        const { fileBase64, fileName, solutionFileBase64, solutionFileName, provider, modelId, contentType, examType, syllabus, customPrompt } = body;

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
                { success: false, error: `${name} does not support PDF/file analysis. Please use Gemini, OpenAI, or OpenRouter instead.` },
                { status: 400 }
            );
        }

        // Resolve API key
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

        // Build prompt and call AI
        const defaultPrompt = buildQCPrompt(contentType, examType, syllabus, Boolean(solutionFileBase64));
        const responseFormatStart = defaultPrompt.indexOf("## Response Format");
        const prompt = customPrompt?.trim()
            ? `${customPrompt.trim()}\n\n${responseFormatStart >= 0 ? defaultPrompt.slice(responseFormatStart) : defaultPrompt}`
            : defaultPrompt;
        const rawResponse = await callAI(provider as AIModelProvider, modelId, resolvedApiKey, fileBase64, fileName, prompt, solutionFileBase64, solutionFileName);
        const parsed = parseStructuredAiResponse(rawResponse);

        // Normalize the report
        const report = {
            totalQuestions: Number(parsed.totalQuestions) || 0,
            questionsAnalyzed: Number(parsed.questionsAnalyzed) || 0,
            answerKeyMatches: Number(parsed.answerKeyMatches) || 0,
            answerKeyMismatches: Number(parsed.answerKeyMismatches) || 0,
            chapterDistribution: (parsed.chapterDistribution as Record<string, number>) || {},
            questionTypeDistribution: (parsed.questionTypeDistribution as Record<string, number>) || {},
            overallSuggestions: Array.isArray(parsed.overallSuggestions) ? parsed.overallSuggestions : [],
            patternAnalysis: String(parsed.patternAnalysis || ""),
            syllabusAnalysis: String(parsed.syllabusAnalysis || ""),
            questions: Array.isArray(parsed.questions)
                ? (parsed.questions as Record<string, unknown>[]).map((q) => ({
                    questionNumber: Number(q.questionNumber) || 0,
                    questionText: String(q.questionText || ""),
                    aiAnswer: q.aiAnswer ?? null,
                    providedAnswer: q.providedAnswer ?? null,
                    answerMatch: q.answerMatch === true ? true : q.answerMatch === false ? false : null,
                    correctness: String(q.correctness || ""),
                    suggestions: Array.isArray(q.suggestions) ? q.suggestions.map(String) : [],
                    languageQuality: String(q.languageQuality || ""),
                    solutionQuality: q.solutionQuality ? String(q.solutionQuality) : undefined,
                    chapter: q.chapter ? String(q.chapter) : undefined,
                    topic: q.topic ? String(q.topic) : undefined,
                    questionType: q.questionType ? String(q.questionType) : undefined,
                    difficulty: q.difficulty ? String(q.difficulty) : undefined,
                }))
                : [],
        };

        return NextResponse.json({ success: true, report });
    } catch (err) {
        console.error("AI QC error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
