import { NextRequest, NextResponse } from "next/server";
import {
    callStructuredAiModel,
    isSupportedAiProvider,
    parseStructuredAiResponse,
    resolveAiProviderApiKey,
} from "@/lib/ai/verification";
import { checkAnyPermission } from "@/lib/auth/serverAuth";

// ==================== TYPES ====================

interface VerifyRequestBody {
    questionText: string;
    options: Array<{ text: string | null; isCorrect: boolean | null }>;
    answerKey: number | number[] | null;
    solutionText: string;
    questionType: string;
    subject: string;
    chapter: string;
    topic: string;
    provider: string;
    modelId: string;
}

// ==================== PROMPT ====================

function buildVerifyPrompt(body: VerifyRequestBody): string {
    const optionsText = body.options
        .filter((o) => o.text !== null)
        .map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o.text}${o.isCorrect ? " [marked correct]" : ""}`)
        .join("\n");

    const answerKeyStr = body.answerKey !== null
        ? (Array.isArray(body.answerKey) ? body.answerKey.join(", ") : String(body.answerKey))
        : "Not provided";

    return `You are an expert question quality checker and verifier for educational content (Physics, Chemistry, Mathematics, Biology).

## Question Details

**Subject:** ${body.subject}
**Chapter:** ${body.chapter}
**Topic:** ${body.topic}
**Question Type:** ${body.questionType}

**Question Text:**
${body.questionText}

${optionsText ? `**Options:**\n${optionsText}` : ""}

**Given Answer Key:** ${answerKeyStr}

**Given Solution:**
${body.solutionText || "No solution provided"}

## Your Task

1. **Solve the question yourself** from scratch. Show your complete working.
2. **Determine the correct answer** based on your solution.
3. **Compare your answer with the given answer key** — do they match?
4. **Review the given solution** for errors, gaps, or improvements.
5. **Review the question text** for language quality, clarity, and correctness.
6. **Provide suggestions** for improving the question, solution, or answer key.

## Response Format

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "answerKeyVerified": <true if your answer matches the given answer key, false if not>,
  "aiAnswer": "<your calculated answer — e.g. 'B' for MCQ, '42' for integer, etc.>",
  "aiAnswerExplanation": "<brief explanation of why this is the correct answer>",
  "aiSolution": "<your complete step-by-step solution in HTML format, preserving LaTeX with \\\\( \\\\) for inline and \\\\[ \\\\] for display math>",
  "aiSuggestion": "<detailed suggestions for the existing solution — corrections needed in question language, solution language, answer key errors, missing steps, etc. If everything is correct, say so.>",
  "questionLanguageQuality": "<Good / Needs Improvement — with brief note>",
  "solutionLanguageQuality": "<Good / Needs Improvement / Not Provided — with brief note>",
  "overallVerdict": "<Correct / Incorrect Answer Key / Needs Review — summary>"
}`;
}

// ==================== ROUTE HANDLER ====================

export async function POST(req: NextRequest) {
    const forbid = await checkAnyPermission(["use_ai_tools", "use_per_question_ai"]);
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as VerifyRequestBody;
        const { questionText, provider, modelId } = body;

        if (!questionText?.trim()) {
            return NextResponse.json({ success: false, error: "Question text is required." }, { status: 400 });
        }
        if (!provider || !isSupportedAiProvider(provider)) {
            return NextResponse.json({ success: false, error: "Valid AI provider is required." }, { status: 400 });
        }
        if (!modelId) {
            return NextResponse.json({ success: false, error: "AI model ID is required." }, { status: 400 });
        }

        const resolvedApiKey = await resolveAiProviderApiKey(req, provider);
        if (!resolvedApiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon.` },
                { status: 400 }
            );
        }

        // Build prompt and call AI
        const prompt = buildVerifyPrompt(body);
        const rawResponse = await callStructuredAiModel(provider, modelId, resolvedApiKey, prompt);
        const parsed = parseStructuredAiResponse(rawResponse);

        const result = {
            answerKeyVerified: parsed.answerKeyVerified === true,
            aiAnswer: String(parsed.aiAnswer ?? ""),
            aiAnswerExplanation: String(parsed.aiAnswerExplanation ?? ""),
            aiSolution: String(parsed.aiSolution ?? ""),
            aiSuggestion: String(parsed.aiSuggestion ?? ""),
            questionLanguageQuality: String(parsed.questionLanguageQuality ?? ""),
            solutionLanguageQuality: String(parsed.solutionLanguageQuality ?? ""),
            overallVerdict: String(parsed.overallVerdict ?? ""),
        };

        return NextResponse.json({ success: true, result });
    } catch (err) {
        console.error("AI Verify error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
