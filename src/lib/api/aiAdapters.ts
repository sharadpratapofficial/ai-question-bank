// AI Model Adapters for PDF Question Extraction
// Supports: Google Gemini, OpenAI, OpenRouter, Groq, Grok (xAI), NVIDIA NIM, Fireworks AI, custom OpenAI-compatible providers
// All providers that use OpenAI-compatible API format share a common adapter.

import type {
    AIModelProvider,
    ExtractedQuestion,
    UploadMode,
} from "@/types/extraction";
import {
    getProviderApiCredential,
    getProviderBaseUrl,
} from "@/lib/userApiKeys";

// ==================== ADAPTER INTERFACE ====================

export interface AIExtractionParams {
    questionsPdfBase64: string;
    solutionsPdfBase64?: string;
    apiKey: string;
    modelId: string;
    mode: UploadMode;
    sourceName: string;
}

export interface AIExtractionResult {
    questions: ExtractedQuestion[];
    pdfType: "questions_only" | "questions_and_solutions";
    totalPages: number;
    warnings: string[];
}

// ==================== STRUCTURED EXTRACTION PROMPT ====================

function buildExtractionPrompt(mode: UploadMode, sourceName: string): string {
    const modeInstructions =
        mode === "dual"
            ? `You are given TWO PDF files:
1. **Questions PDF** — contains questions only
2. **Solutions PDF** — contains solutions/answers for the same questions

Match each solution to its corresponding question by question number.`
            : `You are given a single PDF file that may contain:
- Questions only, OR
- Questions with solutions/answers included

Detect which format is used and extract accordingly.`;

    return `You are a highly accurate question extraction AI for educational content (Physics, Chemistry, Mathematics, Biology).

${modeInstructions}

## Your Task

Extract EVERY question from the PDF(s) and return structured JSON.

## Critical Rules for Mathematical Content

1. **LaTeX equations** must be preserved exactly. Wrap inline math in \\( ... \\) and display math in \\[ ... \\]
2. **DO NOT** convert equations to plain text. Keep them in LaTeX format.
3. **Chemical formulas** like H₂SO₄ should use LaTeX: \\(H_2SO_4\\)
4. **Fractions, roots, integrals, matrices** — all must be LaTeX
5. **Superscripts and subscripts** must use LaTeX notation

## Critical Rules for Diagrams/Figures

1. If the question or solution contains a diagram, figure, or graph, describe it in the "diagrams" array
2. Set the "dataUrl" field to an empty string (we'll handle image extraction separately)
3. Provide a detailed "description" of what the diagram shows

## Classification Guidelines

- **subject**: One of "Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"
- **chapter**: The specific chapter name (e.g., "Kinematics", "Chemical Bonding", "Trigonometry")
- **topic**: The specific topic within the chapter
- **subtopic**: More specific sub-topic if identifiable, otherwise empty string
- **difficultyLevel**: "Easy", "Medium", or "Hard"
- **questionType**: One of:
  - "Single_Choice(SCQ)" — single correct answer from options
  - "Multi_Choice(MCQ)" — multiple correct answers from options
  - "Integer" — answer is an integer value
  - "Numerical" — answer is a numerical value (possibly decimal)
  - "Single_Digit_Integer" — answer is a single digit (0-9)
  - "Assertion_Reason(AR)" — assertion and reason type
  - "Matching_List(ML)" — matching/matrix match type
  - "Passage_Numerical" — passage-based with numerical answer
  - "Composite" — passage-based with multiple sub-questions (if you detect this, still extract each sub-question separately)
- **classLevel**: "11" or "12"
- **exam**: Array of exam names like ["JEE Mains", "JEE Advanced", "NEET"]
- **confidence**: Your confidence in the extraction accuracy (0.0 to 1.0)

## For Options (SCQ/MCQ type)

- Extract each option text (preserve LaTeX)
- Set isCorrect to true for the correct option(s), false for others
- If you cannot determine which is correct, set all isCorrect to null

## Answer Key

- For SCQ: a single number (1-indexed option number)
- For MCQ: an array of numbers (1-indexed)
- For Integer/Numerical: the numeric answer value
- If unknown: null

## Source

Default source name: "${sourceName}"

## Response Format

Return ONLY a valid JSON object with this exact structure (no markdown, no code fences):

{
  "pdfType": "questions_only" | "questions_and_solutions",
  "totalPages": <number>,
  "warnings": ["<any issues encountered>"],
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "<HTML with LaTeX>",
      "questionLanguage": "English",
      "options": [
        { "text": "<HTML with LaTeX>", "isCorrect": true|false|null }
      ],
      "answerKey": <number|number[]|null>,
      "solutionText": "<HTML with LaTeX or empty string>",
      "solutionLanguage": "English",
      "questionType": "<type string>",
      "subject": "<subject>",
      "chapter": "<chapter>",
      "topic": "<topic>",
      "subtopic": "<subtopic or empty>",
      "difficultyLevel": "Easy|Medium|Hard",
      "classLevel": "11|12",
      "exam": ["<exam names>"],
      "diagrams": [{ "dataUrl": "", "description": "<desc>" }],
      "confidence": 0.95,
      "aiNotes": "<any notes about this question>"
    }
  ]
}`;
}

// ==================== GEMINI ADAPTER ====================
// Uses the Google Generative AI REST API with native PDF support

async function extractWithGemini(params: AIExtractionParams): Promise<AIExtractionResult> {
    const { questionsPdfBase64, solutionsPdfBase64, apiKey, modelId, mode, sourceName } = params;
    const prompt = buildExtractionPrompt(mode, sourceName);

    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    parts.push({ text: prompt });
    parts.push({
        inlineData: {
            mimeType: "application/pdf",
            data: questionsPdfBase64,
        },
    });

    if (mode === "dual" && solutionsPdfBase64) {
        parts.push({ text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:" });
        parts.push({
            inlineData: {
                mimeType: "application/pdf",
                data: solutionsPdfBase64,
            },
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
        const errorBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
    }

    const geminiResponse = await response.json();
    const textContent = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textContent) {
        throw new Error("Gemini returned empty response. The PDF may be too large or unreadable.");
    }

    return parseAIResponse(textContent);
}

// ==================== OPENAI-COMPATIBLE ADAPTER ====================
// Works for: OpenAI, OpenRouter, Groq, Grok (xAI)
// All use the same /v1/chat/completions format

interface OpenAICompatibleConfig {
    baseUrl: string;
    extraHeaders?: Record<string, string>;
}

const OPENAI_COMPATIBLE_CONFIGS: Record<string, OpenAICompatibleConfig> = {
    openai: {
        baseUrl: "https://api.openai.com/v1",
    },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: {
            "HTTP-Referer": "https://question-bank.app",
            "X-Title": "Question Bank PDF Extractor",
        },
    },
    groq: {
        baseUrl: "https://api.groq.com/openai/v1",
    },
    grok: {
        baseUrl: "https://api.x.ai/v1",
    },
    nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
    },
    fireworks: {
        baseUrl: "https://api.fireworks.ai/inference/v1",
    },
};

/** Providers whose endpoint is not a constant — the user supplies it, and the
 *  stored "key" is (or wraps) the URL. `getProviderBaseUrl` knows each shape and
 *  each default. */
const USER_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(["custom_openai", "local", "g4f"]);

/**
 * The OpenAI-compatible endpoint to call for a provider.
 *
 * Needed because a user-hosted provider has no entry in the table above, and the
 * old `CONFIGS[provider] || CONFIGS.openai` fallback quietly sent those requests
 * to api.openai.com with the user's own key attached — a local g4f or Ollama
 * server would never have seen them.
 */
function resolveOpenAICompatibleConfig(
    provider: AIModelProvider,
    storedKeyValue: string
): OpenAICompatibleConfig {
    if (USER_HOSTED_PROVIDERS.has(provider)) {
        return { baseUrl: getProviderBaseUrl(provider, storedKeyValue) };
    }
    return OPENAI_COMPATIBLE_CONFIGS[provider] || OPENAI_COMPATIBLE_CONFIGS.openai;
}

async function extractWithOpenAICompatible(
    params: AIExtractionParams,
    provider: AIModelProvider
): Promise<AIExtractionResult> {
    if (provider === "groq" || provider === "openai" || provider === "fireworks" || provider === "custom_openai") {
        const name =
            provider === "groq" ? "Groq" :
            provider === "openai" ? "OpenAI" :
            provider === "fireworks" ? "Fireworks AI" :
            "OpenAI-compatible providers";
        throw new Error(`${name} does not support direct PDF file analysis via this base64 API method. Please use Gemini or OpenRouter instead.`);
    }
    const { questionsPdfBase64, solutionsPdfBase64, apiKey, modelId, mode, sourceName } = params;
    const prompt = buildExtractionPrompt(mode, sourceName);
    const config = resolveOpenAICompatibleConfig(provider, apiKey);
    const actualApiKey = getProviderApiCredential(provider, apiKey);
    if (!config.baseUrl) {
        throw new Error("OpenAI-compatible base URL is required.");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [];
    contentParts.push({ type: "text", text: prompt });

    if (provider === "openrouter") {
        // OpenRouter uses "file" content type for PDFs
        contentParts.push({
            type: "file",
            file: {
                filename: "questions.pdf",
                file_data: `data:application/pdf;base64,${questionsPdfBase64}`,
            },
        });

        if (mode === "dual" && solutionsPdfBase64) {
            contentParts.push({
                type: "text",
                text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:",
            });
            contentParts.push({
                type: "file",
                file: {
                    filename: "solutions.pdf",
                    file_data: `data:application/pdf;base64,${solutionsPdfBase64}`,
                },
            });
        }
    } else {
        // OpenAI and others use image_url for file data
        contentParts.push({
            type: "image_url",
            image_url: {
                url: `data:application/pdf;base64,${questionsPdfBase64}`,
            },
        });

        if (mode === "dual" && solutionsPdfBase64) {
            contentParts.push({
                type: "text",
                text: "\n\nThe above was the Questions PDF. Below is the Solutions PDF:",
            });
            contentParts.push({
                type: "image_url",
                image_url: {
                    url: `data:application/pdf;base64,${solutionsPdfBase64}`,
                },
            });
        }
    }

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${actualApiKey}`,
        ...config.extraHeaders,
    };

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: contentParts }],
            temperature: 0.1,
            max_completion_tokens: 16384,
            response_format: { type: "json_object" },
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${errorBody}`);
    }

    const apiResponse = await response.json();
    const textContent = apiResponse?.choices?.[0]?.message?.content;

    if (!textContent) {
        throw new Error(`${provider.toUpperCase()} returned empty response. The PDF may be too large or unreadable.`);
    }

    return parseAIResponse(textContent);
}

// ==================== RESPONSE PARSER ====================

function parseAIResponse(rawText: string): AIExtractionResult {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) {
        cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    let parsed: {
        pdfType?: string;
        totalPages?: number;
        warnings?: string[];
        questions?: ExtractedQuestion[];
    };

    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        throw new Error(`Failed to parse AI response as JSON: ${String(err)}\nRaw response start: ${cleaned.slice(0, 500)}`);
    }

    const questions: ExtractedQuestion[] = (parsed.questions || []).map((q, index) => ({
        questionNumber: q.questionNumber ?? index + 1,
        questionText: q.questionText || "",
        questionLanguage: q.questionLanguage || "English",
        options: Array.isArray(q.options)
            ? q.options.map((opt) => ({
                  text: typeof opt === "string" ? opt : opt?.text || "",
                  isCorrect: typeof opt === "string" ? null : opt?.isCorrect ?? null,
              }))
            : [],
        answerKey: q.answerKey ?? null,
        solutionText: q.solutionText || "",
        solutionLanguage: q.solutionLanguage || "English",
        questionType: q.questionType || "Single_Choice(SCQ)",
        subject: q.subject || "",
        chapter: q.chapter || "",
        topic: q.topic || "",
        subtopic: q.subtopic || "",
        difficultyLevel: q.difficultyLevel || "Medium",
        classLevel: q.classLevel || "",
        exam: Array.isArray(q.exam) ? q.exam : [],
        diagrams: Array.isArray(q.diagrams) ? q.diagrams : [],
        confidence: typeof q.confidence === "number" ? q.confidence : 0.5,
        aiNotes: q.aiNotes || "",
    }));

    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    if (questions.length === 0) {
        warnings.push("No questions were extracted from the PDF. The document may not contain recognizable questions.");
    }

    return {
        questions,
        pdfType:
            parsed.pdfType === "questions_and_solutions"
                ? "questions_and_solutions"
                : "questions_only",
        totalPages: typeof parsed.totalPages === "number" ? parsed.totalPages : 0,
        warnings,
    };
}

// ==================== PUBLIC API ====================

/**
 * Extract questions from PDF(s) using the specified AI model.
 */
export async function extractQuestionsFromPDF(
    provider: AIModelProvider,
    params: AIExtractionParams
): Promise<AIExtractionResult> {
    if (provider === "gemini") {
        return extractWithGemini(params);
    }

    // All other providers use OpenAI-compatible API format
    if (OPENAI_COMPATIBLE_CONFIGS[provider] || USER_HOSTED_PROVIDERS.has(provider)) {
        return extractWithOpenAICompatible(params, provider);
    }

    throw new Error(`Unsupported AI model provider: ${provider}`);
}

// =====================================================================
//  METADATA TAGGING FOR DOCX-INGESTED QUESTIONS
// =====================================================================
//
// For the Word-upload flow, the deterministic ingester has already split the
// document into raw OOXML question chunks. The AI's only job here is metadata
// tagging — given a short plain-text snippet of each question, return
// subject / chapter / topic / difficulty / question type / class level / exam.

export interface MetadataTagInput {
    q_number: number;
    snippet: string;
}

export interface MetadataTagOutput {
    q_number: number;
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string;
    difficultyLevel: string;
    classLevel: string;
    exam: string[];
    questionType: string;
    confidence: number;
}

function buildMetadataPrompt(items: MetadataTagInput[]): string {
    return `You are a metadata-tagging assistant for an Indian JEE/NEET question bank.
For each question snippet below, classify it. Return ONLY a valid JSON object — no markdown, no commentary.

Allowed values:
- subject: "Physics" | "Chemistry" | "Maths" | "Biology" | "Botany" | "Zoology"
- difficultyLevel: "Easy" | "Medium" | "Hard"
- classLevel: "11" | "12"
- questionType: one of "Single_Choice(SCQ)", "Multi_Choice(MCQ)", "Integer", "Numerical", "Single_Digit_Integer", "Assertion_Reason(AR)", "Matching_List(ML)", "Passage_Numerical", "Composite"
- exam: zero or more of ["JEE Mains", "JEE Advanced", "NEET", "BITSAT"]
- chapter / topic / subtopic: free-text (specific chapter/topic names — e.g. "Kinematics", "Newton's Laws"). Leave empty string if unknown.
- confidence: 0.0 - 1.0

Some equations and diagrams appear as image placeholders — that's fine. Classify from the surrounding text + your knowledge of typical JEE/NEET content. If you genuinely can't tell, lower confidence and leave fields empty.

Return shape:
{
  "items": [
    { "q_number": 1, "subject": "...", "chapter": "...", "topic": "...", "subtopic": "...", "difficultyLevel": "Medium", "classLevel": "12", "exam": ["JEE Mains"], "questionType": "Single_Choice(SCQ)", "confidence": 0.9 }
  ]
}

SNIPPETS:
${items.map((it) => `--- Q${it.q_number} ---\n${it.snippet}`).join("\n\n")}`;
}

export async function tagDocxQuestionsMetadata(
    provider: AIModelProvider,
    items: MetadataTagInput[],
    apiKey: string,
    modelId: string
): Promise<MetadataTagOutput[]> {
    if (items.length === 0) return [];
    const prompt = buildMetadataPrompt(items);

    if (provider === "gemini") {
        const actualApiKey = getProviderApiCredential(provider, apiKey);
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${actualApiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 32768,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini metadata-tag error (${response.status}): ${errorBody}`);
        }
        const apiResponse = await response.json();
        const text = apiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
        return parseMetadataResponse(text ?? "", items);
    }

    const config = resolveOpenAICompatibleConfig(provider, apiKey);
    const actualApiKey = getProviderApiCredential(provider, apiKey);
    if (!config.baseUrl) throw new Error("OpenAI-compatible base URL is required for metadata tagging.");
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${actualApiKey}`,
            ...config.extraHeaders,
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_completion_tokens: 16384,
            response_format: { type: "json_object" },
        }),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${provider.toUpperCase()} metadata-tag error (${response.status}): ${errorBody}`);
    }
    const apiResponse = await response.json();
    const text = apiResponse?.choices?.[0]?.message?.content;
    return parseMetadataResponse(text ?? "", items);
}

// =====================================================================
//  AI-DRIVEN DOCX STRUCTURE DETECTION
// =====================================================================
//
// The AI receives a numbered list of paragraph snippets from the source .docx
// and returns, for each real question, the index range of paragraphs that
// belong to it PLUS the metadata classification. The AI is told to skip
// instructions, page headers/footers, section banners, and any other
// non-question content.
//
// We send only short plain-text excerpts — the AI never sees the OOXML.
// Content extraction then uses the returned indices to slice the original
// paragraph spans verbatim, preserving equations + diagrams byte-exact.

export interface ParagraphSnippet {
    idx: number;
    text: string;
}

export interface DocxStructureBoundary {
    q_number: number;
    /** Inclusive start index into the paragraph list. */
    paragraph_start_idx: number;
    /** Exclusive end index (the next question's start, or one past the last paragraph). */
    paragraph_end_idx: number;
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string;
    difficultyLevel: string;
    classLevel: string;
    exam: string[];
    questionType: string;
    confidence: number;
}

export interface DocxStructureResult {
    boundaries: DocxStructureBoundary[];
    warnings: string[];
}

function buildStructurePrompt(
    snippets: ParagraphSnippet[],
    kind: "questions" | "solutions",
    sourceName: string
): string {
    const lines = snippets.map((s) => `[${s.idx}] ${s.text}`).join("\n");
    const sourceHint =
        kind === "questions"
            ? `This is a QUESTIONS document from a JEE / NEET exam paper. Each item starts with a number marker like "1.", "2.", "3.", followed by the question statement, options (A)/(B)/(C)/(D) or numerical answer, and may span multiple paragraphs.`
            : `This is a SOLUTIONS document. Each item typically starts with "<n>.(<answer>)" (e.g. "1.(2)" meaning "Q1 → answer (2)") followed by the worked solution which may span many paragraphs and include "Step 1.", "Case 1.", etc. — those step / case markers are NOT new questions.`;

    return `You are a strict question-paper structure detector for an Indian JEE / NEET question bank.

${sourceHint}

## Input
You receive the source as a list of paragraph snippets, each prefixed with its absolute paragraph index in square brackets. Source name: "${sourceName}".

## Your job — return the structure ONLY

For each REAL question (or worked solution, depending on the source kind), return:

- \`q_number\`: the displayed question number from the source (e.g. 1, 2, 51).
- \`paragraph_start_idx\`: index of the FIRST paragraph that belongs to this item.
- \`paragraph_end_idx\`: index of the FIRST paragraph that does NOT belong (exclusive). For the last item, this is one past the last relevant paragraph.
- Classification: \`subject\` (Physics | Chemistry | Maths | Biology | Botany | Zoology), \`chapter\`, \`topic\`, \`subtopic\` (free text), \`difficultyLevel\` (Easy | Medium | Hard), \`classLevel\` ("11" | "12"), \`exam\` (array of "JEE Mains" | "JEE Advanced" | "NEET" | "BITSAT"), \`questionType\` (Single_Choice(SCQ) | Multi_Choice(MCQ) | Integer | Numerical | Single_Digit_Integer | Assertion_Reason(AR) | Matching_List(ML) | Passage_Numerical | Composite), \`confidence\` (0.0–1.0).

## Rules — read carefully

1. SKIP everything that is NOT a real question: cover page, OMR instructions ("Use blue/black pens", "Darken bubbles", "Never use pencils", "Do not fold"…), exam-info headers, page numbers, section banners ("SECTION-I (PHYSICS)"), syllabus listings, and footers.
2. The QUESTION's content covers EVERY paragraph from its start marker through the paragraph immediately before the NEXT question's start. Include the question statement, options, any "Statement-I / Statement-II" framing, etc.
3. For SOLUTIONS: the solution covers EVERY paragraph from "${kind === "solutions" ? "<n>.(<ans>)" : "<n>."}" through the paragraph immediately before the NEXT "<k>.(...)" marker. Step / case markers inside ("Step 1.", "Case 1.", "1. Using Newton's law") are NOT new questions — they are part of the current solution.
4. NEVER include a paragraph whose text is clearly an instruction, footer, watermark, or repeated header.
5. If you see the same numbering twice (e.g. two paragraphs both starting "1.") treat the second as either a step inside the current solution or noise — do NOT create a duplicate question.
6. Boundary indices must come from the input list, and \`paragraph_start_idx\` < \`paragraph_end_idx\` for every entry. Entries must be in document order and must not overlap.
7. If a snippet has been truncated with "…", judge from the available text.

## Response format

Return ONLY valid JSON, no markdown, no commentary:

{
  "boundaries": [
    {
      "q_number": 1,
      "paragraph_start_idx": 97,
      "paragraph_end_idx": 102,
      "subject": "Physics",
      "chapter": "Magnetism",
      "topic": "Motion in magnetic field",
      "subtopic": "",
      "difficultyLevel": "Medium",
      "classLevel": "12",
      "exam": ["JEE Mains"],
      "questionType": "Single_Choice(SCQ)",
      "confidence": 0.9
    }
  ],
  "warnings": ["any structural anomaly worth flagging"]
}

PARAGRAPHS:
${lines}`;
}

/** Run the structure-detection prompt through the chosen provider. */
export async function detectDocxStructure(
    provider: AIModelProvider,
    args: {
        snippets: ParagraphSnippet[];
        kind: "questions" | "solutions";
        sourceName: string;
        apiKey: string;
        modelId: string;
    }
): Promise<DocxStructureResult> {
    if (args.snippets.length === 0) return { boundaries: [], warnings: ["No paragraphs to analyse."] };

    const prompt = buildStructurePrompt(args.snippets, args.kind, args.sourceName);

    if (provider === "gemini") {
        const actualApiKey = getProviderApiCredential(provider, args.apiKey);
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${args.modelId}:generateContent?key=${actualApiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.05,
                        maxOutputTokens: 65536,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini structure-detect error (${response.status}): ${errorBody}`);
        }
        const apiResponse = await response.json();
        const text = apiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
        return parseStructureResponse(text ?? "");
    }

    const config = resolveOpenAICompatibleConfig(provider, args.apiKey);
    const actualApiKey = getProviderApiCredential(provider, args.apiKey);
    if (!config.baseUrl) throw new Error("OpenAI-compatible base URL is required for structure detection.");
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${actualApiKey}`,
            ...config.extraHeaders,
        },
        body: JSON.stringify({
            model: args.modelId,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.05,
            max_completion_tokens: 32768,
            response_format: { type: "json_object" },
        }),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${provider.toUpperCase()} structure-detect error (${response.status}): ${errorBody}`);
    }
    const apiResponse = await response.json();
    const text = apiResponse?.choices?.[0]?.message?.content;
    return parseStructureResponse(text ?? "");
}

function parseStructureResponse(rawText: string): DocxStructureResult {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
    try {
        const parsed = JSON.parse(cleaned) as { boundaries?: DocxStructureBoundary[]; warnings?: string[] };
        return {
            boundaries: Array.isArray(parsed.boundaries) ? parsed.boundaries : [],
            warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        };
    } catch (err) {
        return {
            boundaries: [],
            warnings: [`Failed to parse AI structure response: ${err instanceof Error ? err.message : String(err)}`],
        };
    }
}

function parseMetadataResponse(rawText: string, fallbackItems: MetadataTagInput[]): MetadataTagOutput[] {
    const defaultFor = (q: number): MetadataTagOutput => ({
        q_number: q,
        subject: "",
        chapter: "",
        topic: "",
        subtopic: "",
        difficultyLevel: "Medium",
        classLevel: "",
        exam: [],
        questionType: "Single_Choice(SCQ)",
        confidence: 0,
    });

    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    let parsed: { items?: MetadataTagOutput[] };
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return fallbackItems.map((it) => defaultFor(it.q_number));
    }
    const items = parsed?.items ?? [];
    const byNum = new Map<number, MetadataTagOutput>(items.map((x) => [x.q_number, x]));
    return fallbackItems.map((it) => byNum.get(it.q_number) ?? defaultFor(it.q_number));
}
