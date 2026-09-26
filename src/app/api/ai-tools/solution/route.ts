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

interface SolutionRequestBody {
    fileBase64: string;
    fileName: string;
    provider: string;
    modelId: string;
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

function buildSolutionPrompt(): string {
    return `You are a highly accurate Question Solving AI for educational content (Physics, Chemistry, Mathematics).

You are given a PDF file containing questions from a test or exam paper.

## Your Task

1. Parse and identify EVERY question in the paper (max 50 questions).
2. For each question: solve it clearly, provide the answer key, and identify chapter/topic.

## CRITICAL FORMATTING RULES for the "solution" field

You MUST follow these formatting rules exactly:

1. **NO step numbers.** Do NOT write "Step 1:", "Step 2:" etc. Just write the explanation directly.
2. **Each line of explanation must be a separate <p> tag.** Never write everything in one paragraph.
3. **Keep text VERY short.** Each <p> should be 1 short sentence (under 15 words) explaining what you're doing.
4. **Every equation MUST be on its own line** as display math using \\\\[ ... \\\\] wrapped in a <p> tag.
5. **Use LaTeX for ALL math** — even small variables like x, v, F must use \\\\( x \\\\) inline. Never write bare math.
6. **Final answer** in a separate <p> with <strong>Answer:</strong> label.

## Example of CORRECT solution format:

<p>Differentiate to find velocity:</p>
<p>\\\\[ v(t) = \\\\frac{dx}{dt} = 3t^2 - 12t + 9 \\\\]</p>
<p>Set \\\\( v(t) = 0 \\\\) to find turning points:</p>
<p>\\\\[ 3(t-1)(t-3) = 0 \\\\]</p>
<p>So \\\\( t = 1 \\\\) and \\\\( t = 3 \\\\).</p>
<p>Compute positions at these times:</p>
<p>\\\\[ x(0) = 0, \\\\quad x(1) = 4, \\\\quad x(3) = 0 \\\\]</p>
<p><strong>Answer:</strong> \\\\( \\\\boxed{4} \\\\)</p>

## BAD format (DO NOT do this):

"Compute v(t)=dx/dt=3t^2−12t+9=3(t−1)(t−3). Positions: x(0)=0, x(1)=4."

This is BAD: no line breaks, no LaTeX delimiters, raw math text, everything crammed together.

Also BAD: "Step 1: ...", "Step 2: ..." — do NOT use step numbers.

## Response Format

Return ONLY valid JSON (no markdown, no code fences):

{
  "totalQuestions": <number>,
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "<brief question summary, first 100 chars>",
      "answerKey": <correct answer — string or number or null>,
      "solution": "<HTML with LaTeX as shown above>",
      "chapter": "<chapter name>",
      "topic": "<topic name>"
    }
  ]
}

RULES:
- NO step numbers anywhere.
- Each equation on its own line with \\\\[ \\\\].
- Short text, let the math speak.
- Max 50 questions.`;
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
    } else {
        // OpenAI and others use image_url for file data
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

// ==================== SOLUTION FORMATTER ====================

/**
 * Post-process AI solution text to ensure proper formatting:
 * 1. Wraps bare text in <p> tags if no HTML structure exists
 * 2. Splits long paragraphs at sentence boundaries
 * 3. Ensures display math is on its own line
 */
function formatSolutionHtml(raw: string): string {
    let html = raw.trim();
    if (!html) return html;

    // Strip step numbers: "Step 1:", "Step 2:", etc. — keep the rest of the text
    html = html.replace(/<strong>\s*Step\s+\d+[.:]\s*<\/strong>\s*/gi, '');
    html = html.replace(/\bStep\s+\d+[.:]\s*/gi, '');

    // If the solution has no HTML tags at all, it's likely a wall of text
    const hasHtmlTags = /<(p|div|br|ol|ul|li|h[1-6]|strong|em|table)[\s>/]/i.test(html);

    if (!hasHtmlTags) {
        // Split by newlines first (the AI might use \n)
        const lines = html.split(/\n+/).map((l) => l.trim()).filter(Boolean);

        if (lines.length <= 1) {
            // Single blob of text — try to split at sentence boundaries
            html = html
                .replace(/(?<=[.!?])\s+(?=Given|Find|Therefore|Hence|Thus|So,|Answer|Now|Using|From|Substitut|Apply|We\s+have|We\s+get|We\s+know)/gi, '</p><p>')
                // Split before display math markers
                .replace(/\s*\\\[/g, '</p><p>\\[')
                .replace(/\\\]\s*/g, '\\]</p><p>')
                // Split before $$
                .replace(/\s*\$\$/g, '</p><p>$$')
                .replace(/\$\$\s*/g, '$$</p><p>');
            html = `<p>${html}</p>`;
        } else {
            html = lines.map((line) => `<p>${line}</p>`).join('');
        }
    }

    // Clean up empty <p></p> or <p> </p> tags
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Ensure display math blocks \[...\] are separated from surrounding text
    html = html.replace(/([^\n>])\\\[/g, '$1</p><p>\\[');
    html = html.replace(/\\\]([^\n<])/g, '\\]</p><p>$1');

    return html;
}

// ==================== ROUTE HANDLER ====================

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_ai_tools");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as SolutionRequestBody;
        const { fileBase64, fileName, provider, modelId, customPrompt } = body;

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
        const defaultPrompt = buildSolutionPrompt();
        const responseFormatStart = defaultPrompt.indexOf("## Response Format");
        const prompt = customPrompt?.trim()
            ? `${customPrompt.trim()}\n\n${responseFormatStart >= 0 ? defaultPrompt.slice(responseFormatStart) : defaultPrompt}`
            : defaultPrompt;
        const rawResponse = await callAI(provider as AIModelProvider, modelId, resolvedApiKey, fileBase64, fileName, prompt);
        const parsed = parseStructuredAiResponse(rawResponse);

        // Normalize the report
        const report = {
            totalQuestions: Number(parsed.totalQuestions) || 0,
            questions: Array.isArray(parsed.questions)
                ? (parsed.questions as Record<string, unknown>[]).map((q) => ({
                    questionNumber: Number(q.questionNumber) || 0,
                    questionText: String(q.questionText || ""),
                    answerKey: q.answerKey ?? null,
                    solution: formatSolutionHtml(String(q.solution || "")),
                    chapter: q.chapter ? String(q.chapter) : undefined,
                    topic: q.topic ? String(q.topic) : undefined,
                }))
                : [],
        };

        return NextResponse.json({ success: true, report });
    } catch (err) {
        console.error("AI Solution error:", err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
