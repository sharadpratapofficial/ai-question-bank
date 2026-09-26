/**
 * POST /api/agentic-qc/run
 *
 * Orchestrates a multi-agent QC pass over a competitive-exam paper.
 *
 * Flow:
 *   1. Receives question file (required) + optional answer-key file + optional
 *      solutions file. Supports "single combined file" mode (everything in one
 *      PDF/DOCX) and "separate files" mode.
 *   2. Receives 1–3 parallel QC agent configs (provider + model each) and a
 *      required Aggregator agent config.
 *   3. Fires the QC agents in parallel via Promise.allSettled. Each agent
 *      reads the file(s) and returns a structured per-question QC verdict.
 *   4. Feeds the agent outputs (plus the original question file) into the
 *      Aggregator, which re-derives each answer and produces the final report.
 *   5. Returns the consolidated report — also includes per-agent raw output
 *      so the UI can show "what each model thought" alongside the final call.
 *
 * Notes:
 *   - API keys are resolved server-side from the authenticated user's saved
 *     keys (user_metadata.api_keys). Never read from the request body.
 *   - All file inputs are sent to LLMs as base64 PDFs (matches the existing
 *     /api/ai-tools/qc pattern).
 *   - Providers without PDF/file vision support (groq / nvidia / fireworks /
 *     custom_openai / local) are rejected at validation time with a clear
 *     message, mirroring the existing AI QC route.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";
import { checkPermission } from "@/lib/auth/serverAuth";
import type { AIModelProvider } from "@/types/extraction";

export const runtime = "nodejs";
// Up to 4 LLM calls in series (parallel internally, then aggregator). Worst-
// case latency is ~aggregator-call + ~slowest-parallel-call. Keep generous.
export const maxDuration = 300;

// ============================================================================
//  TYPES
// ============================================================================

const VALID_PROVIDERS = [
    "gemini",
    "anthropic",
    "openai",
    "openrouter",
    "groq",
    "grok",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
] as const;

function isValidProvider(v: string): v is AIModelProvider {
    return (VALID_PROVIDERS as readonly string[]).includes(v);
}

// Providers that do NOT support PDF/file vision. We block these for the QC
// flow because the agent needs to actually read the paper.
const TEXT_ONLY_PROVIDERS: Set<string> = new Set([
    "groq",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
]);

interface AgentConfig {
    label: string; // "QC1" | "QC2" | "QC3" | "Aggregator"
    provider: string;
    modelId: string;
}

interface FileInput {
    fileBase64: string;
    fileName: string;
}

interface AgenticQCRequestBody {
    /**
     * Input mode:
     *   - "combined":   one file holds questions + answer key + solutions
     *   - "separate":   separate question / answer-key / solution files
     *   - "structured": parsed CSV / Excel rows in `structuredPaperText` —
     *                   no file attached. The agent reads the synthetic paper
     *                   directly from the prompt.
     */
    inputMode: "combined" | "separate" | "structured";
    questionFile?: FileInput;
    answerKeyFile?: FileInput;
    solutionFile?: FileInput;
    /**
     * Pre-built plain-text paper from a CSV / XLSX upload. Provided when
     * inputMode === "structured". Already includes the question text, options,
     * answer key, solution, and any image-URL references per question.
     */
    structuredPaperText?: string;
    /**
     * Optional metadata derived from the structured upload — used purely for
     * agent prompts (e.g. so the agent knows which questions had image URLs).
     */
    structuredMeta?: {
        totalQuestions: number;
        questionsWithFigures: number[];
        subjectsDetected: string[];
    };

    /** 1–3 parallel QC agents (at least one is required). */
    qcAgents: AgentConfig[];
    /** Required final-decision agent. */
    aggregator: AgentConfig;

    examType?: "JEE_MAINS" | "NEET" | "JEE_ADVANCED" | "CUSTOM";
    /** Free-text question-type sequence the user provided for custom exams. */
    customQuestionTypeSequence?: string;
    /** Subjects actually present in the uploaded paper (e.g. ["Physics"] for a
     *  single-subject mock, or ["Physics", "Chemistry"] for a 2-subject combined
     *  paper). Tells the agents which subjects to expect — helps with
     *  out-of-syllabus / wrong-subject detection. Defaults to JEE Mains set if
     *  not provided. */
    subjects?: string[];
    /** Optional syllabus filter: { Physics: ["Kinematics", "Laws of Motion"], … } */
    syllabus?: Record<string, string[]>;
}

interface AgentVerdictPerQuestion {
    questionNumber: number;
    questionSummary: string;
    hasFigure: boolean;
    questionType: string;
    aiAnswer: string | number | null;
    providedAnswer: string | number | null;
    answerMatch: boolean | null;
    correctness: string;
    errorsFound: string[];
    solutionFeedback: string;
    syllabusMatch: boolean | null;
    questionTypeMatch: boolean | null;
    suggestions: string[];
}

interface AgentRawReport {
    totalQuestions: number;
    overallSuggestions: string[];
    patternAnalysis: string;
    syllabusAnalysis: string;
    questions: AgentVerdictPerQuestion[];
}

interface AggregatedQuestion {
    questionNumber: number;
    questionSummary: string;
    hasFigure: boolean;
    questionType: string;
    providedAnswerKey: string | number | null;
    /** What each parallel agent said about this question. */
    agentAnswers: {
        agentLabel: string;
        provider: string;
        modelId: string;
        answer: string | number | null;
        correctness: string;
        errorsFound: string[];
        solutionFeedback: string;
    }[];
    /** Aggregator's independent re-derivation. */
    finalAnswer: string | number | null;
    finalAnswerConfidence: "high" | "medium" | "low";
    agreementWithProvidedKey: boolean | null;
    needsManualReview: boolean;
    manualReviewReason: string | null;
    consolidatedErrors: string[];
    consolidatedSolutionFeedback: string;
    aggregatorRationale: string;
}

interface FinalAgenticQCReport {
    runId: string;
    createdAt: string;
    examType: string;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    agents: AgentConfig[];
    aggregator: AgentConfig;
    summary: {
        totalQuestions: number;
        flaggedForReview: number;
        answerKeyMismatches: number;
        questionsWithFigures: number;
        questionsWithErrors: number;
    };
    questions: AggregatedQuestion[];
    /** Per-agent raw outputs (for transparency / debugging). */
    perAgentReports: { agent: AgentConfig; report: AgentRawReport | null; error?: string }[];
    /** Aggregator's overall paper-level analysis. */
    aggregatorAnalysis: {
        patternAnalysis: string;
        syllabusAnalysis: string;
        overallSuggestions: string[];
    };
}

// ============================================================================
//  PROVIDER CALL
// ============================================================================

const OPENAI_COMPATIBLE_CONFIGS: Record<
    string,
    { baseUrl: string; extraHeaders?: Record<string, string> }
> = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: {
            "HTTP-Referer": "https://question-bank.app",
            "X-Title": "QBG Agentic QC",
        },
    },
    groq: { baseUrl: "https://api.groq.com/openai/v1" },
    grok: { baseUrl: "https://api.x.ai/v1" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
    local: { baseUrl: "http://localhost:11434/v1" },
};

function mimeFor(fileName: string): string {
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "docx") {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (ext === "doc") {
        return "application/msword";
    }
    return "application/pdf";
}

/**
 * Call an LLM provider with a prompt + 1-N attached files. Returns the raw
 * text response (caller is responsible for JSON parsing).
 *
 * Designed to mirror the existing /api/ai-tools/qc handler's `callAI` —
 * keeping behaviour identical for shared params (reasoning-model detection,
 * temperature override, response_format).
 */
async function callAI(
    provider: AIModelProvider,
    modelId: string,
    apiKey: string,
    prompt: string,
    files: FileInput[]
): Promise<string> {
    // ─── Anthropic (Claude) ──────────────────────────────────────────────
    if (provider === "anthropic") {
        const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
        for (const f of files) {
            content.push({
                type: "document",
                source: {
                    type: "base64",
                    media_type: mimeFor(f.fileName),
                    data: f.fileBase64,
                },
            });
        }
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: modelId,
                // 50-question aggregator outputs can hit 25-40k output tokens.
                // Claude Sonnet 4.x supports 64k output, Haiku 4.5 supports 32k.
                // 32768 is a safe upper bound for current Claude-4 family.
                max_tokens: 32768,
                // System message forces JSON-only output. We previously used
                // assistant-prefill `{`, but newer Claude models (Sonnet 4.6+)
                // reject that with "model does not support assistant message
                // prefill. The conversation must end with a user message."
                system:
                    "You are a JSON-only response generator. Your entire response MUST be a single valid JSON object. Do NOT include any preamble, explanation, markdown fences, or trailing commentary. Begin your response with `{` and end it with `}` — nothing else.",
                messages: [{ role: "user", content }],
            }),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${err}`);
        }
        const data = await response.json();
        const blocks = data?.content || [];
        const text = Array.isArray(blocks)
            ? blocks
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text)
                  .join("")
            : "";
        if (!text) throw new Error("Anthropic returned empty response.");
        return text;
    }

    // ─── Gemini ──────────────────────────────────────────────────────────
    if (provider === "gemini") {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        parts.push({ text: prompt });
        for (const f of files) {
            parts.push({
                inlineData: { mimeType: mimeFor(f.fileName), data: f.fileBase64 },
            });
        }
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 65536,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${err}`);
        }
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini returned empty response.");
        return text;
    }

    // ─── OpenAI-compatible (OpenAI, OpenRouter, etc.) ────────────────────
    const config = OPENAI_COMPATIBLE_CONFIGS[provider] ?? OPENAI_COMPATIBLE_CONFIGS.openai;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [{ type: "text", text: prompt }];
    for (const f of files) {
        const mime = mimeFor(f.fileName);
        const isPdf = mime === "application/pdf";
        // PDFs / docx → use the `file` content type (OpenAI + OpenRouter both
        // support this shape). Image URLs reject PDFs with "Invalid MIME type".
        // Plain images can still go through `image_url`, but here every input
        // is a document, so always use `file`.
        if (isPdf || mime.includes("officedocument") || mime === "application/msword") {
            contentParts.push({
                type: "file",
                file: {
                    filename: f.fileName || "document.pdf",
                    file_data: `data:${mime};base64,${f.fileBase64}`,
                },
            });
        } else {
            contentParts.push({
                type: "image_url",
                image_url: { url: `data:${mime};base64,${f.fileBase64}` },
            });
        }
    }
    const isReasoningModel = /^(o[1-4]|gpt-5)/i.test(modelId);
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...config.extraHeaders,
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: contentParts }],
            ...(isReasoningModel ? {} : { temperature: 0.1 }),
            // 50-question aggregator JSON can hit 25-40k tokens. 32k is safe
            // across GPT-5 / GPT-4o / OpenRouter Sonnet / Gemini-via-OR.
            max_completion_tokens: 32768,
            response_format: { type: "json_object" },
        }),
    });
    if (!response.ok) {
        const err = await response.text();
        // Common case: OpenRouter routes to a downstream provider that doesn't
        // accept PDFs (e.g. some Xiaomi / DeepSeek / Llama variants). Add a hint.
        const hint =
            provider === "openrouter" && /file type is not supported/i.test(err)
                ? " — this OpenRouter model doesn't accept PDF input. Pick a vision/file-capable model (Claude Sonnet 4.5, GPT-5.x, Gemini 3.x, or any model whose architecture lists `file` input)."
                : provider === "openai" && /Invalid MIME type|invalid_image_format/i.test(err)
                ? " — this OpenAI model doesn't accept PDFs via chat-completions. Use gpt-4o / gpt-5.x family which support the `file` content type."
                : "";
        throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${err}${hint}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider.toUpperCase()} returned empty response.`);
    return text;
}

// ============================================================================
//  PROMPTS
// ============================================================================

/** Hardcoded patterns for known exams — used to flag question-type mismatches. */
function buildExamPatternHint(examType?: string, customSeq?: string): string {
    if (examType === "JEE_MAINS") {
        return (
            "JEE Mains pattern (2024+): 75 questions total. Physics, Chemistry, " +
            "Mathematics — 25 each. Each subject: 20 Single Correct (SCQ) + " +
            "5 Numerical/Integer. Total 75 marks each subject (300 max)."
        );
    }
    if (examType === "NEET") {
        return (
            "NEET pattern: 180 questions, all Single Correct (SCQ). " +
            "Physics 45, Chemistry 45, Botany 45, Zoology 45."
        );
    }
    if (examType === "JEE_ADVANCED") {
        return (
            "JEE Advanced pattern: Two papers, each ~54 questions. Mix of " +
            "Single Correct (SCQ), Multiple Correct (MCQ), Integer/Numerical, " +
            "and Matching List types. Exact split varies year-to-year."
        );
    }
    if (examType === "CUSTOM" && customSeq) {
        return `Custom exam pattern provided by user: ${customSeq}`;
    }
    return "";
}

function buildSyllabusHint(syllabus?: Record<string, string[]>): string {
    if (!syllabus || Object.keys(syllabus).length === 0) return "";
    const lines = Object.entries(syllabus)
        .map(([subj, chs]) =>
            chs.length > 0 ? `- ${subj}: ${chs.join(", ")}` : `- ${subj}: (all chapters)`
        )
        .join("\n");
    return (
        "\n\n## Expected Syllabus\nThis paper should cover:\n" +
        lines +
        "\nFor each question, set syllabusMatch=true if it falls within the listed " +
        "chapters for its subject, false if it doesn't, null if unsure."
    );
}

function buildSubjectsHint(subjects?: string[]): string {
    if (!subjects || subjects.length === 0) return "";
    return (
        `\n\n## Subjects in this paper\nThis paper covers ONLY these subjects: ${subjects.join(", ")}.\n` +
        `If you find any question that doesn't belong to one of these subjects, treat that as ` +
        `a major error — list it in errorsFound (e.g. "Out-of-scope subject: question belongs to ` +
        `<X> but this paper is supposed to be ${subjects.join(" / ")} only").`
    );
}

/**
 * Prompt for one QC agent. Returns structured per-question JSON.
 *
 * Each agent does:
 *   - Read the paper
 *   - Solve each question independently
 *   - Compare to provided answer key (if available)
 *   - Flag errors (academic, language, repetition, missing data, missing figure)
 *   - Critique the solution (if provided)
 *   - Mark whether the question contains a figure
 */
function buildAgentPrompt(args: {
    inputMode: "combined" | "separate" | "structured";
    hasAnswerKey: boolean;
    hasSolutions: boolean;
    examType?: string;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    /** Pre-built synthetic paper text for inputMode='structured'. */
    structuredPaperText?: string;
    structuredMeta?: AgenticQCRequestBody["structuredMeta"];
}): string {
    const filesDesc =
        args.inputMode === "structured"
            ? "the synthetic paper text embedded BELOW (no file attachment). " +
              "The questions, options, provided answer keys, and provided solutions " +
              "are all inlined per-question. Some questions also include a " +
              "'[Diagram references]' block with image URLs — those questions " +
              "must have hasFigure=true and you must note in errorsFound or " +
              "solutionFeedback that a diagram was referenced but you could not " +
              "view it directly. The Hindi / regional-language fields from the " +
              "source CSV have been intentionally dropped — review the English " +
              "content only."
            : args.inputMode === "combined"
            ? "ONE combined file containing the questions" +
              (args.hasAnswerKey ? ", the answer key" : "") +
              (args.hasSolutions ? ", and the solutions" : "")
            : `MULTIPLE files:
  1. Questions paper (questions only)
  ${args.hasAnswerKey ? "2. Answer key file" : ""}
  ${args.hasSolutions ? `${args.hasAnswerKey ? "3" : "2"}. Solutions file` : ""}`;

    const examPattern = buildExamPatternHint(args.examType, args.customQuestionTypeSequence);
    const examClause = examPattern
        ? `\n\n## Expected Exam Pattern\n${examPattern}\n\nFor each question set questionTypeMatch=true if the type fits the expected pattern, false if not.`
        : "";
    const subjectsClause = buildSubjectsHint(args.subjects);
    const syllabusClause = buildSyllabusHint(args.syllabus);

    return `You are an independent quality-control reviewer for a competitive-exam question paper (JEE / NEET / similar). You are ONE OF SEVERAL parallel reviewers — give your own honest, careful analysis. The aggregator that reads all reviewer outputs will reconcile differences.

You are given ${filesDesc}.

## Your Task — for EVERY question in the paper (up to 60 questions)

1. **Solve the question yourself** from first principles. Determine your own correct answer.
2. **Detect if the question contains a figure / diagram / graph** — this is critical because diagrams often render poorly in PDFs and AI accuracy drops on visual questions. Set hasFigure=true if any visual is referenced (even if not actually visible).
3. **Compare your answer to the provided answer key**${args.hasAnswerKey ? "" : " (no answer key provided — set providedAnswer=null and answerMatch=null)"}.
4. **Find errors** in the question:
   - Missing data needed to solve
   - Internal contradictions
   - Repeated questions / repeated options in the same question
   - Spelling / grammar issues (list each one — even minor ones)
   - Unclear or ambiguous language
   - Figure referenced but not provided / unclear
5. **Critique the solution** (if provided):
   - Data in solution doesn't match question
   - Wrong final answer in solution
   - Solution too short / steps missing
   - Solution too verbose
   - Math errors in the working
${args.hasSolutions ? "" : "   - (No solution file provided — set solutionFeedback to empty string)"}
6. **Classify the question type**: SCQ / MCQ / Integer / Numerical / Single_Digit_Integer / Assertion_Reason / Matching_List / Passage / Comprehension.${examClause}${subjectsClause}${syllabusClause}

## Response Format

Return ONLY a valid JSON object — no markdown, no code fences:

{
  "totalQuestions": <number>,
  "overallSuggestions": ["<paper-level suggestion>", ...],
  "patternAnalysis": "<analysis of the paper's overall difficulty curve, balance, etc.>",
  "syllabusAnalysis": "<syllabus coverage analysis — empty string if no syllabus given>",
  "questions": [
    {
      "questionNumber": 1,
      "questionSummary": "<first 80-120 chars of the question, plain text>",
      "hasFigure": <true|false — does this question reference a figure/diagram/graph?>,
      "questionType": "<SCQ|MCQ|Integer|Numerical|Single_Digit_Integer|Assertion_Reason|Matching_List|Passage|Comprehension>",
      "aiAnswer": <your computed answer — string or number>,
      "providedAnswer": <provided answer key — string|number|null>,
      "answerMatch": <true if your answer matches the provided key, false if mismatch, null if no key>,
      "correctness": "<Correct | Incorrect | Partially Correct | Cannot Determine — followed by 1-line reasoning>",
      "errorsFound": ["<error description>", ...],
      "solutionFeedback": "<your critique of the provided solution OR empty string>",
      "syllabusMatch": <true|false|null>,
      "questionTypeMatch": <true|false|null>,
      "suggestions": ["<improvement suggestion>", ...]
    }
  ]
}

IMPORTANT: Be thorough. Even minor spelling / grammar issues should appear in errorsFound. If the paper has more than 60 questions, analyze the first 60 and note it in overallSuggestions.${
        args.inputMode === "structured" && args.structuredPaperText
            ? `\n\n## SYNTHETIC PAPER (from CSV/Excel upload)\n\n${args.structuredPaperText}`
            : ""
    }`;
}

/**
 * Prompt for the aggregator. Receives the original question file PLUS the
 * per-agent JSON outputs. Re-derives each answer independently and produces
 * the final reconciled report.
 */
function buildAggregatorPrompt(args: {
    agentReports: { label: string; provider: string; modelId: string; report: AgentRawReport }[];
    hasAnswerKey: boolean;
    hasSolutions: boolean;
    examType?: string;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    /** Pre-built synthetic paper text for inputMode='structured'. */
    structuredPaperText?: string;
    inputMode?: "combined" | "separate" | "structured";
}): string {
    const agentSummaries = args.agentReports.map((a, idx) =>
        `── Agent ${idx + 1} (${a.label}: ${a.provider} / ${a.modelId}) ──\n` +
        JSON.stringify(a.report, null, 2)
    ).join("\n\n");

    const examPattern = buildExamPatternHint(args.examType, args.customQuestionTypeSequence);
    const examClause = examPattern ? `\n\n## Expected Exam Pattern\n${examPattern}` : "";
    const subjectsClause = buildSubjectsHint(args.subjects);
    const syllabusClause = buildSyllabusHint(args.syllabus);

    return `You are the FINAL AGGREGATOR for a multi-agent QC pass on a competitive-exam paper. ${args.agentReports.length} parallel agents have already reviewed the paper independently. Your job:

1. Independently re-derive the correct answer for EACH question by reading the original paper yourself (don't just vote — actually solve the question).
2. Compare your answer with each agent's answer AND with the provided answer key (if available).
3. If your answer agrees with the majority → high confidence. If agents disagree among themselves OR your answer disagrees with all of them → flag the question for manual human review with a specific reason.
4. Consolidate all errors / suggestions / solution feedback from the agents (de-duplicate similar items, preserve unique insights).
5. Preserve the hasFigure flag from the agents — if any agent marked it true, treat it as true. Flag figure-containing questions as needing human attention (AI accuracy drops on visual questions).
${examClause}${subjectsClause}${syllabusClause}

## Parallel Agent Reports

${agentSummaries}

## Response Format

Return ONLY a valid JSON object:

{
  "summary": {
    "totalQuestions": <number>,
    "flaggedForReview": <number — questions where needsManualReview=true>,
    "answerKeyMismatches": <number — questions where your finalAnswer differs from providedAnswerKey>,
    "questionsWithFigures": <number>,
    "questionsWithErrors": <number — questions where consolidatedErrors is non-empty>
  },
  "patternAnalysis": "<your independent paper-level analysis>",
  "syllabusAnalysis": "<your independent syllabus coverage analysis or empty string>",
  "overallSuggestions": ["<paper-wide suggestion>", ...],
  "questions": [
    {
      "questionNumber": 1,
      "questionSummary": "<short summary, max 80 chars>",
      "hasFigure": <true|false>,
      "questionType": "<the question type>",
      "providedAnswerKey": <string|number|null>,
      "agentAnswers": [
        { "agentLabel": "QC1", "answer": <agent's answer> }
      ],
      "finalAnswer": <your own re-derived answer, string|number>,
      "finalAnswerConfidence": "<high|medium|low>",
      "agreementWithProvidedKey": <true|false|null>,
      "needsManualReview": <true|false>,
      "manualReviewReason": <"<specific reason>" or null — REQUIRED when needsManualReview=true, omit field otherwise>,
      "consolidatedErrors": ["<merged errors>"],
      "consolidatedSolutionFeedback": "<merged critique>",
      "aggregatorRationale": "<ONE sentence, max ~25 words>"
    }
  ]
}

TOKEN-SAVING RULES (your output gets truncated if too long):
- agentAnswers: include ONLY { agentLabel, answer } per agent. The server already has the full per-agent data — do NOT repeat provider, modelId, correctness, errorsFound, or solutionFeedback there.
- aggregatorRationale: ONE sentence, ≤25 words. Be specific but terse.
- consolidatedErrors: include ONLY genuine errors. If a question is clean, use [] — don't pad with "no errors found" entries.
- consolidatedSolutionFeedback: empty string "" if no notable feedback. Don't write "solution looks fine".
- Omit manualReviewReason entirely (don't include the key) when needsManualReview=false.

CORRECTNESS RULES:
- Your finalAnswer must be your OWN independent derivation, not just a vote.
- Set needsManualReview=true whenever ANY of these hold: (a) agents disagree among themselves, (b) your answer differs from the provided key, (c) the question has a figure AND any agent flagged an issue, (d) consolidatedErrors is non-empty.${
        args.inputMode === "structured" && args.structuredPaperText
            ? `\n\n## SYNTHETIC PAPER (from CSV/Excel upload — same source the agents read)\n\n${args.structuredPaperText}`
            : ""
    }`;
}

// ============================================================================
//  RESPONSE PARSING
// ============================================================================

/**
 * Robust JSON extractor. Handles:
 *   - clean JSON
 *   - JSON wrapped in ```json ... ``` fences
 *   - Models that emit a preamble ("I'll systematically...") before the JSON
 *   - Models that emit trailing commentary after the closing brace
 *
 * Strategy:
 *   1. Strip leading/trailing whitespace and code fences.
 *   2. If still not JSON-parseable, locate the first `{` and walk forward
 *      tracking brace depth (respecting strings + escapes) to find the matching
 *      closing `}`. Slice that range and parse.
 */
function parseJSONResponse(rawText: string): Record<string, unknown> {
    let cleaned = rawText.trim();

    // Strip code fences if present.
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7).trim();
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3).trim();
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trim();

    // Fast path — already parseable.
    try {
        return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
        // Fall through to brace-matching extractor.
    }

    // Find first `{` and walk forward to its matching `}`.
    const start = cleaned.indexOf("{");
    if (start === -1) {
        throw new Error(
            `Model did not return JSON. First 200 chars: ${cleaned.slice(0, 200)}`
        );
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\" && inString) {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) {
        // Truncated mid-output. Try to repair: close any open strings, then
        // close every remaining open `[` and `{` in stack order. This typically
        // recovers everything up to the last complete element + best-effort tail.
        const repaired = repairTruncatedJSON(cleaned.slice(start));
        try {
            return JSON.parse(repaired) as Record<string, unknown>;
        } catch (e) {
            throw new Error(
                `Model returned truncated JSON and repair failed. Likely hit max_tokens. ` +
                    `Try a smaller paper or fewer agents. ` +
                    `Repair error: ${e instanceof Error ? e.message : String(e)}. ` +
                    `Tail of output: ...${cleaned.slice(-200)}`
            );
        }
    }
    const candidate = cleaned.slice(start, end + 1);
    return JSON.parse(candidate) as Record<string, unknown>;
}

/**
 * Best-effort repair for JSON truncated mid-output (e.g. model hit max_tokens).
 *
 * Strategy:
 *   1. Walk the string, tracking string-state and a stack of open brackets.
 *   2. If we end inside a string, drop the partial trailing value (cut back to
 *      the last `,` or `[` / `{` that's not inside a string).
 *   3. Close any open string with `"`, then close every open bracket in stack
 *      order (reversed) with the matching closer.
 *
 * Output is parseable JSON containing as much of the original structure as
 * survived. Trailing commas are also handled.
 */
function repairTruncatedJSON(input: string): string {
    let s = input;
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    let lastSafeBreakIdx = -1; // index just after the last `,`, `{`, or `[` outside strings

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (ch === "\\") escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "{" || ch === "[") {
            stack.push(ch);
            lastSafeBreakIdx = i + 1;
        } else if (ch === "}" || ch === "]") {
            stack.pop();
            // After a closer, we're between values — also a safe break point.
            lastSafeBreakIdx = i + 1;
        } else if (ch === "," && stack.length > 0) {
            lastSafeBreakIdx = i + 1;
        }
    }

    // If we ended inside a string, cut back to the last safe break to drop the
    // partial value.
    if (inString && lastSafeBreakIdx >= 0) {
        s = s.slice(0, lastSafeBreakIdx);
        inString = false;
        // Recompute the stack on the trimmed string.
        stack.length = 0;
        let s2InString = false;
        let s2Escape = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (s2Escape) {
                s2Escape = false;
                continue;
            }
            if (s2InString) {
                if (ch === "\\") s2Escape = true;
                else if (ch === '"') s2InString = false;
                continue;
            }
            if (ch === '"') {
                s2InString = true;
                continue;
            }
            if (ch === "{" || ch === "[") stack.push(ch);
            else if (ch === "}" || ch === "]") stack.pop();
        }
    }

    // Drop dangling trailing comma — invalid in standard JSON.
    s = s.replace(/,\s*$/, "");
    // Drop dangling `"key":` with no value.
    s = s.replace(/,\s*"[^"]*"\s*:\s*$/, "");
    s = s.replace(/{\s*"[^"]*"\s*:\s*$/, "{");

    // Close anything still open, in reverse order.
    let out = s;
    while (stack.length > 0) {
        const opener = stack.pop()!;
        out += opener === "{" ? "}" : "]";
    }
    return out;
}

function normalizeAgentReport(raw: Record<string, unknown>): AgentRawReport {
    const questions = Array.isArray(raw.questions) ? (raw.questions as Record<string, unknown>[]) : [];
    return {
        totalQuestions: Number(raw.totalQuestions) || questions.length,
        overallSuggestions: Array.isArray(raw.overallSuggestions)
            ? (raw.overallSuggestions as unknown[]).map(String)
            : [],
        patternAnalysis: String(raw.patternAnalysis || ""),
        syllabusAnalysis: String(raw.syllabusAnalysis || ""),
        questions: questions.map((q): AgentVerdictPerQuestion => ({
            questionNumber: Number(q.questionNumber) || 0,
            questionSummary: String(q.questionSummary || ""),
            hasFigure: q.hasFigure === true,
            questionType: String(q.questionType || ""),
            aiAnswer: (q.aiAnswer ?? null) as string | number | null,
            providedAnswer: (q.providedAnswer ?? null) as string | number | null,
            answerMatch:
                q.answerMatch === true ? true : q.answerMatch === false ? false : null,
            correctness: String(q.correctness || ""),
            errorsFound: Array.isArray(q.errorsFound) ? (q.errorsFound as unknown[]).map(String) : [],
            solutionFeedback: String(q.solutionFeedback || ""),
            syllabusMatch:
                q.syllabusMatch === true ? true : q.syllabusMatch === false ? false : null,
            questionTypeMatch:
                q.questionTypeMatch === true ? true : q.questionTypeMatch === false ? false : null,
            suggestions: Array.isArray(q.suggestions) ? (q.suggestions as unknown[]).map(String) : [],
        })),
    };
}

// ============================================================================
//  PARTIAL REPORT (when aggregator fails but QC agents succeeded)
// ============================================================================

/**
 * Build a best-effort "partial" report from per-agent outputs only. Used when
 * the aggregator call fails but at least one QC agent succeeded — we still
 * want the user to be able to download what they have.
 *
 * For each question, we synthesise an aggregated row by:
 *   - taking the question summary / type / hasFigure from the first agent that
 *     reported on it
 *   - listing all agent answers
 *   - voting on finalAnswer (majority among non-null agent answers; null if
 *     no majority)
 *   - flagging needsManualReview=true whenever agents disagree, the question
 *     has a figure, or any agent reported errors
 *
 * The aggregator's independent re-derivation is missing — the report makes
 * that clear via a partial-flag at the top level and an aggregatorRationale
 * of "(aggregator failed — answer derived by voting only)".
 */
function buildPartialReport(args: {
    body: AgenticQCRequestBody;
    perAgentReports: FinalAgenticQCReport["perAgentReports"];
    aggregatorError: string;
}): FinalAgenticQCReport & { partial: true; partialReason: string } {
    const { body, perAgentReports, aggregatorError } = args;
    const successful = perAgentReports.filter(
        (p): p is { agent: AgentConfig; report: AgentRawReport } => p.report !== null
    );

    // Collect every question number any agent reported on.
    const allQNums = new Set<number>();
    for (const { report } of successful) {
        for (const q of report.questions) allQNums.add(q.questionNumber);
    }
    const sortedQNums = Array.from(allQNums).sort((a, b) => a - b);

    const aggregatedQuestions: AggregatedQuestion[] = sortedQNums.map((qNum) => {
        // Gather every agent's verdict for this question.
        const verdicts: {
            agent: AgentConfig;
            v: AgentVerdictPerQuestion;
        }[] = [];
        for (const { agent, report } of successful) {
            const v = report.questions.find((q) => q.questionNumber === qNum);
            if (v) verdicts.push({ agent, v });
        }

        const first = verdicts[0]?.v;
        const hasFigure = verdicts.some((x) => x.v.hasFigure);
        const providedAnswerKey = first?.providedAnswer ?? null;

        // Vote on the answer.
        const counts = new Map<string, number>();
        for (const { v } of verdicts) {
            if (v.aiAnswer === null || v.aiAnswer === undefined) continue;
            const key = String(v.aiAnswer).trim();
            if (!key) continue;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        let finalAnswer: string | number | null = null;
        let topCount = 0;
        let tied = false;
        for (const [k, c] of counts) {
            if (c > topCount) {
                topCount = c;
                finalAnswer = k;
                tied = false;
            } else if (c === topCount) {
                tied = true;
            }
        }
        if (tied) finalAnswer = null;

        // Agreement check with provided key.
        let agreementWithKey: boolean | null = null;
        if (providedAnswerKey !== null && finalAnswer !== null) {
            agreementWithKey =
                String(finalAnswer).trim().toLowerCase() ===
                String(providedAnswerKey).trim().toLowerCase();
        }

        // Consolidate errors / solution feedback (de-dupe roughly).
        const allErrs = new Set<string>();
        for (const { v } of verdicts) for (const e of v.errorsFound) allErrs.add(e);
        const solnFeedback = verdicts
            .map((x) => x.v.solutionFeedback)
            .filter((s) => s && s.trim())
            .join(" | ");

        const needsReview =
            tied ||
            (agreementWithKey === false) ||
            hasFigure ||
            allErrs.size > 0 ||
            verdicts.length < 2; // single-agent rows can't be cross-checked

        const reviewReason = !needsReview
            ? null
            : tied
            ? `Agents disagreed: ${verdicts
                  .map((x) => `${x.agent.label}=${x.v.aiAnswer ?? "?"}`)
                  .join(", ")}`
            : agreementWithKey === false
            ? `Voted answer (${finalAnswer}) differs from provided key (${providedAnswerKey})`
            : hasFigure
            ? "Question contains a figure — verify visually"
            : allErrs.size > 0
            ? "Errors flagged by agents — see consolidatedErrors"
            : "Only one agent reported — no cross-check";

        return {
            questionNumber: qNum,
            questionSummary: first?.questionSummary || "",
            hasFigure,
            questionType: first?.questionType || "",
            providedAnswerKey,
            agentAnswers: verdicts.map(({ agent, v }) => ({
                agentLabel: agent.label,
                provider: agent.provider,
                modelId: agent.modelId,
                answer: v.aiAnswer,
                correctness: v.correctness,
                errorsFound: v.errorsFound,
                solutionFeedback: v.solutionFeedback,
            })),
            finalAnswer,
            finalAnswerConfidence: tied
                ? "low"
                : topCount >= 2
                ? "medium"
                : "low",
            agreementWithProvidedKey: agreementWithKey,
            needsManualReview: needsReview,
            manualReviewReason: reviewReason,
            consolidatedErrors: Array.from(allErrs),
            consolidatedSolutionFeedback: solnFeedback,
            aggregatorRationale:
                "(Aggregator failed — answer derived by majority vote across QC agents, not by independent re-derivation.)",
        };
    });

    // Roll up paper-level analysis from agents (concatenated, de-duped).
    const allPatternAnalyses = successful
        .map((s) => s.report.patternAnalysis)
        .filter((x) => x && x.trim());
    const allSyllabusAnalyses = successful
        .map((s) => s.report.syllabusAnalysis)
        .filter((x) => x && x.trim());
    const allSuggestions = new Set<string>();
    for (const { report } of successful) {
        for (const s of report.overallSuggestions) allSuggestions.add(s);
    }

    return {
        partial: true,
        partialReason: `Aggregator failed: ${aggregatorError}`,
        runId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        examType: body.examType || "CUSTOM",
        customQuestionTypeSequence: body.customQuestionTypeSequence,
        subjects: body.subjects,
        syllabus: body.syllabus,
        agents: body.qcAgents,
        aggregator: body.aggregator,
        summary: {
            totalQuestions: aggregatedQuestions.length,
            flaggedForReview: aggregatedQuestions.filter((q) => q.needsManualReview).length,
            answerKeyMismatches: aggregatedQuestions.filter(
                (q) => q.agreementWithProvidedKey === false
            ).length,
            questionsWithFigures: aggregatedQuestions.filter((q) => q.hasFigure).length,
            questionsWithErrors: aggregatedQuestions.filter(
                (q) => q.consolidatedErrors.length > 0
            ).length,
        },
        questions: aggregatedQuestions,
        perAgentReports,
        aggregatorAnalysis: {
            patternAnalysis: allPatternAnalyses.join("\n\n— — —\n\n"),
            syllabusAnalysis: allSyllabusAnalyses.join("\n\n— — —\n\n"),
            overallSuggestions: Array.from(allSuggestions),
        },
    };
}

// ============================================================================
//  ROUTE HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_agentic_qc");
    if (forbid) return forbid;

    let body: AgenticQCRequestBody;
    try {
        body = (await req.json()) as AgenticQCRequestBody;
    } catch {
        return NextResponse.json(
            { success: false, error: "Invalid JSON body." },
            { status: 400 }
        );
    }

    // ─── Validation ──────────────────────────────────────────────────────
    // Two input shapes: file-based (combined / separate) OR structured
    // (CSV / Excel parsed client-side into a synthetic paper string).
    if (body.inputMode === "structured") {
        if (!body.structuredPaperText || !body.structuredPaperText.trim()) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "structuredPaperText is required when inputMode='structured'. " +
                        "Parse your CSV / Excel client-side and pass the synthetic paper text.",
                },
                { status: 400 }
            );
        }
    } else {
        if (!body.questionFile?.fileBase64 || !body.questionFile?.fileName) {
            return NextResponse.json(
                { success: false, error: "questionFile is required (fileBase64 + fileName)." },
                { status: 400 }
            );
        }
    }
    if (!Array.isArray(body.qcAgents) || body.qcAgents.length < 1 || body.qcAgents.length > 3) {
        return NextResponse.json(
            { success: false, error: "Provide 1 to 3 qcAgents." },
            { status: 400 }
        );
    }
    if (!body.aggregator?.provider || !body.aggregator?.modelId) {
        return NextResponse.json(
            { success: false, error: "aggregator agent (provider + modelId) is required." },
            { status: 400 }
        );
    }
    const allAgents = [...body.qcAgents, body.aggregator];
    for (const a of allAgents) {
        if (!a.provider || !isValidProvider(a.provider)) {
            return NextResponse.json(
                { success: false, error: `Invalid provider in agent ${a.label}: ${a.provider}` },
                { status: 400 }
            );
        }
        if (!a.modelId) {
            return NextResponse.json(
                { success: false, error: `Missing modelId for agent ${a.label}` },
                { status: 400 }
            );
        }
        // Text-only providers can't read PDFs / DOCX, so block them when the
        // user uploaded a file. In "structured" mode the synthetic paper is
        // pure text in the prompt — no file attached — so any provider works.
        if (body.inputMode !== "structured" && TEXT_ONLY_PROVIDERS.has(a.provider)) {
            return NextResponse.json(
                {
                    success: false,
                    error: `${a.label}: ${a.provider} does not support PDF/file analysis. Use Gemini, OpenAI, OpenRouter, Grok, or Anthropic for Agentic QC — or switch to "Structured (CSV / Excel)" input mode which works with any provider.`,
                },
                { status: 400 }
            );
        }
    }

    // ─── Resolve API keys from the user's saved keys ─────────────────────
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
    const keyForProvider = (p: string): string => {
        // sanitizeUserApiKeys returns a typed UserApiKeys object; index it
        // safely (provider strings come from a validated whitelist above).
        return (savedKeys as unknown as Record<string, string>)[p] || "";
    };

    // Build the agent-input file list (depends on inputMode).
    // For "structured" we attach NO file — the synthetic paper text is part of
    // the prompt itself. This works on every provider including text-only ones,
    // but we still block them at validation so the user picks a vision model
    // (in case any individual question references a diagram URL that the model
    // could potentially fetch / reason about visually in a follow-up).
    const agentFiles: FileInput[] =
        body.inputMode === "structured"
            ? []
            : body.questionFile
                ? [body.questionFile]
                : [];
    if (body.inputMode === "separate") {
        if (body.answerKeyFile) agentFiles.push(body.answerKeyFile);
        if (body.solutionFile) agentFiles.push(body.solutionFile);
    }

    // For structured mode, both answer key + solutions are inlined into the
    // synthetic paper text per question — so always treat them as present.
    const hasAnswerKey =
        body.inputMode === "combined" ||
        body.inputMode === "structured" ||
        Boolean(body.answerKeyFile?.fileBase64);
    const hasSolutions =
        body.inputMode === "combined" ||
        body.inputMode === "structured" ||
        Boolean(body.solutionFile?.fileBase64);

    const agentPrompt = buildAgentPrompt({
        inputMode: body.inputMode,
        hasAnswerKey,
        hasSolutions,
        examType: body.examType,
        customQuestionTypeSequence: body.customQuestionTypeSequence,
        subjects: body.subjects,
        syllabus: body.syllabus,
        structuredPaperText: body.structuredPaperText,
        structuredMeta: body.structuredMeta,
    });

    // ─── Stream progress events back to the client via SSE ──────────────
    // Format: `data: <json>\n\n` per event. The client's stream reader splits
    // on `\n\n` and parses each chunk. Final event is { type: "complete",
    // report } or { type: "fatal_error", error }.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (event: Record<string, unknown>) => {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
            };

            try {
                send({
                    type: "started",
                    agents: body.qcAgents,
                    aggregator: body.aggregator,
                    inputMode: body.inputMode,
                    hasAnswerKey,
                    hasSolutions,
                    timestamp: new Date().toISOString(),
                });

                // ─── Parallel QC agents — emit progress as each completes ───
                const t0Map = new Map<string, number>();
                const agentResults = await Promise.allSettled(
                    body.qcAgents.map(async (agent) => {
                        t0Map.set(agent.label, Date.now());
                        send({
                            type: "agent_started",
                            label: agent.label,
                            provider: agent.provider,
                            modelId: agent.modelId,
                        });
                        const apiKey = keyForProvider(agent.provider);
                        if (!apiKey) {
                            throw new Error(
                                `No saved API key for ${agent.provider} — save one from the user icon.`
                            );
                        }
                        try {
                            const raw = await callAI(
                                agent.provider as AIModelProvider,
                                agent.modelId,
                                apiKey,
                                agentPrompt,
                                agentFiles
                            );
                            const parsed = parseJSONResponse(raw);
                            const report = normalizeAgentReport(parsed);
                            const failedQuestions = report.questions
                                .filter((q) => /Cannot Determine/i.test(q.correctness))
                                .map((q) => q.questionNumber);
                            send({
                                type: "agent_completed",
                                label: agent.label,
                                provider: agent.provider,
                                modelId: agent.modelId,
                                elapsedMs: Date.now() - (t0Map.get(agent.label) || Date.now()),
                                totalQuestions: report.totalQuestions,
                                failedQuestions,
                                errorsFoundCount: report.questions.reduce(
                                    (n, q) => n + q.errorsFound.length,
                                    0
                                ),
                            });
                            return { agent, report };
                        } catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            send({
                                type: "agent_failed",
                                label: agent.label,
                                provider: agent.provider,
                                modelId: agent.modelId,
                                elapsedMs: Date.now() - (t0Map.get(agent.label) || Date.now()),
                                error: errMsg,
                            });
                            throw err;
                        }
                    })
                );

                const perAgentReports: FinalAgenticQCReport["perAgentReports"] = [];
                const successfulAgentReports: {
                    label: string;
                    provider: string;
                    modelId: string;
                    report: AgentRawReport;
                }[] = [];
                for (let i = 0; i < agentResults.length; i++) {
                    const r = agentResults[i];
                    const agent = body.qcAgents[i];
                    if (r.status === "fulfilled") {
                        perAgentReports.push({ agent, report: r.value.report });
                        successfulAgentReports.push({
                            label: agent.label,
                            provider: agent.provider,
                            modelId: agent.modelId,
                            report: r.value.report,
                        });
                    } else {
                        const errMsg =
                            r.reason instanceof Error ? r.reason.message : String(r.reason);
                        perAgentReports.push({ agent, report: null, error: errMsg });
                    }
                }

                if (successfulAgentReports.length === 0) {
                    send({
                        type: "fatal_error",
                        error: "All QC agents failed. See per-agent errors above.",
                    });
                    controller.close();
                    return;
                }

                // ─── Aggregator ─────────────────────────────────────────
                send({
                    type: "aggregator_started",
                    provider: body.aggregator.provider,
                    modelId: body.aggregator.modelId,
                    inputAgents: successfulAgentReports.map((a) => a.label),
                });
                const tAgg = Date.now();
                const aggregatorPrompt = buildAggregatorPrompt({
                    agentReports: successfulAgentReports,
                    hasAnswerKey,
                    hasSolutions,
                    examType: body.examType,
                    customQuestionTypeSequence: body.customQuestionTypeSequence,
                    subjects: body.subjects,
                    syllabus: body.syllabus,
                    inputMode: body.inputMode,
                    structuredPaperText: body.structuredPaperText,
                });
                const aggApiKey = keyForProvider(body.aggregator.provider);
                if (!aggApiKey) {
                    send({
                        type: "fatal_error",
                        error: `No saved API key for aggregator provider ${body.aggregator.provider}.`,
                    });
                    controller.close();
                    return;
                }

                let aggregatorParsed: Record<string, unknown>;
                try {
                    const aggRaw = await callAI(
                        body.aggregator.provider as AIModelProvider,
                        body.aggregator.modelId,
                        aggApiKey,
                        aggregatorPrompt,
                        agentFiles
                    );
                    aggregatorParsed = parseJSONResponse(aggRaw);
                } catch (err) {
                    // Aggregator failed but the QC agents already produced
                    // useful output. Emit a `partial` event so the UI can
                    // offer a download of what we have so far.
                    const partialReport = buildPartialReport({
                        body,
                        perAgentReports,
                        aggregatorError:
                            err instanceof Error ? err.message : String(err),
                    });
                    send({
                        type: "partial",
                        reason: "aggregator_failed",
                        error: `Aggregator failed: ${err instanceof Error ? err.message : String(err)}`,
                        report: partialReport,
                    });
                    send({
                        type: "fatal_error",
                        error: `Aggregator failed: ${err instanceof Error ? err.message : String(err)}`,
                    });
                    controller.close();
                    return;
                }
                send({
                    type: "aggregator_completed",
                    elapsedMs: Date.now() - tAgg,
                });

                // ─── Normalise the aggregator response ──────────────────
                const summary = (aggregatorParsed.summary || {}) as Record<string, unknown>;
                const questions = Array.isArray(aggregatorParsed.questions)
                    ? (aggregatorParsed.questions as Record<string, unknown>[])
                    : [];

                const aggregatedQuestions: AggregatedQuestion[] = questions.map((q) => {
                    const qNum = Number(q.questionNumber) || 0;
                    // The aggregator only echoes back { agentLabel, answer }
                    // for each agent (token-saving). Backfill provider, model,
                    // correctness, errorsFound, solutionFeedback from the
                    // original per-agent reports the server already holds.
                    const agentAnswers = successfulAgentReports
                        .map((a) => {
                            const v = a.report.questions.find(
                                (qq) => qq.questionNumber === qNum
                            );
                            if (!v) return null;
                            return {
                                agentLabel: a.label,
                                provider: a.provider,
                                modelId: a.modelId,
                                answer: v.aiAnswer,
                                correctness: v.correctness,
                                errorsFound: v.errorsFound,
                                solutionFeedback: v.solutionFeedback,
                            };
                        })
                        .filter((x): x is NonNullable<typeof x> => x !== null);
                    return {
                        questionNumber: qNum,
                        questionSummary: String(q.questionSummary || ""),
                        hasFigure: q.hasFigure === true,
                        questionType: String(q.questionType || ""),
                        providedAnswerKey:
                            (q.providedAnswerKey ?? null) as string | number | null,
                        agentAnswers,
                        finalAnswer: (q.finalAnswer ?? null) as string | number | null,
                        finalAnswerConfidence:
                            q.finalAnswerConfidence === "high" ||
                            q.finalAnswerConfidence === "low"
                                ? (q.finalAnswerConfidence as "high" | "low")
                                : "medium",
                        agreementWithProvidedKey:
                            q.agreementWithProvidedKey === true
                                ? true
                                : q.agreementWithProvidedKey === false
                                ? false
                                : null,
                        needsManualReview: q.needsManualReview === true,
                        manualReviewReason: q.manualReviewReason
                            ? String(q.manualReviewReason)
                            : null,
                        consolidatedErrors: Array.isArray(q.consolidatedErrors)
                            ? (q.consolidatedErrors as unknown[]).map(String)
                            : [],
                        consolidatedSolutionFeedback: String(
                            q.consolidatedSolutionFeedback || ""
                        ),
                        aggregatorRationale: String(q.aggregatorRationale || ""),
                    };
                });

                const finalReport: FinalAgenticQCReport = {
                    runId: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    examType: body.examType || "CUSTOM",
                    customQuestionTypeSequence: body.customQuestionTypeSequence,
                    subjects: body.subjects,
                    syllabus: body.syllabus,
                    agents: body.qcAgents,
                    aggregator: body.aggregator,
                    summary: {
                        totalQuestions:
                            Number(summary.totalQuestions) || aggregatedQuestions.length,
                        flaggedForReview:
                            Number(summary.flaggedForReview) ||
                            aggregatedQuestions.filter((q) => q.needsManualReview).length,
                        answerKeyMismatches:
                            Number(summary.answerKeyMismatches) ||
                            aggregatedQuestions.filter(
                                (q) => q.agreementWithProvidedKey === false
                            ).length,
                        questionsWithFigures:
                            Number(summary.questionsWithFigures) ||
                            aggregatedQuestions.filter((q) => q.hasFigure).length,
                        questionsWithErrors:
                            Number(summary.questionsWithErrors) ||
                            aggregatedQuestions.filter(
                                (q) => q.consolidatedErrors.length > 0
                            ).length,
                    },
                    questions: aggregatedQuestions,
                    perAgentReports,
                    aggregatorAnalysis: {
                        patternAnalysis: String(aggregatorParsed.patternAnalysis || ""),
                        syllabusAnalysis: String(aggregatorParsed.syllabusAnalysis || ""),
                        overallSuggestions: Array.isArray(aggregatorParsed.overallSuggestions)
                            ? (aggregatorParsed.overallSuggestions as unknown[]).map(String)
                            : [],
                    },
                };

                send({ type: "complete", report: finalReport });
                controller.close();
            } catch (err) {
                send({
                    type: "fatal_error",
                    error: err instanceof Error ? err.message : String(err),
                });
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
            Connection: "keep-alive",
        },
    });
}
