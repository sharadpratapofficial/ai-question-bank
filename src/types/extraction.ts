// Types for PDF question extraction feature

import type { QuestionType, DifficultyLevel } from "./index";

// ==================== AI MODEL CONFIG ====================

export type AIModelProvider =
    | "gemini"
    | "anthropic"
    | "openai"
    | "openrouter"
    | "groq"
    | "grok"
    | "nvidia"
    | "fireworks"
    | "custom_openai"
    | "local"
    | "g4f";

export interface AIModelConfig {
    provider: AIModelProvider;
    modelId: string;
    apiKey: string;
}

export const AI_PROVIDER_LABELS: Record<AIModelProvider, string> = {
    gemini: "Google Gemini",
    anthropic: "Anthropic (Claude)",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    groq: "Groq",
    grok: "Grok (xAI)",
    nvidia: "NVIDIA NIM",
    fireworks: "Fireworks AI",
    custom_openai: "OpenAI Compatible",
    local: "Local (Ollama / LM Studio)",
    g4f: "gpt4free (local g4f server)",
};

export interface ModelOption {
    id: string;
    label: string;
}

/** Available models per provider — user can also type a custom model ID */
export const AI_PROVIDER_MODELS: Record<AIModelProvider, ModelOption[]> = {
    gemini: [
        // First entry is what a picker falls back to before the provider's live
        // model list arrives; keep it aligned with DEFAULT_AI_MODEL in
        // src/lib/qbgAiDefaults.ts.
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
        { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro-preview-05-06", label: "Gemini 2.5 Pro" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
        { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
    anthropic: [
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fast)" },
        { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (Oct 2024)" },
        { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    ],
    openai: [
        // GPT-5 family (latest as of late 2025 / 2026)
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.3", label: "GPT-5.3" },
        { id: "gpt-5.2", label: "GPT-5.2" },
        { id: "gpt-5", label: "GPT-5" },
        { id: "gpt-5-mini", label: "GPT-5 Mini" },
        // Reasoning models
        { id: "o4", label: "o4 (Reasoning)" },
        { id: "o4-mini", label: "o4-mini (Reasoning)" },
        { id: "o3", label: "o3 (Reasoning)" },
        { id: "o3-mini", label: "o3-mini (Reasoning)" },
        { id: "o1", label: "o1 (Reasoning)" },
        // GPT-4 family (still solid, cheaper)
        { id: "gpt-4.1", label: "GPT-4.1" },
        { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
        { id: "gpt-4o", label: "GPT-4o" },
        { id: "gpt-4o-mini", label: "GPT-4o Mini" },
    ],
    openrouter: [
        // ─── Frontier (premium, best for vision + JEE-level reasoning) ───
        // Note: this is a curated short-list. Click "↻ Refresh" next to the
        // provider to pull the full live list (300+ models) from OpenRouter.
        { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
        { id: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1" },
        { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (fast)" },
        { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
        { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
        // OpenAI via OpenRouter
        { id: "openai/gpt-5.5", label: "GPT-5.5" },
        { id: "openai/gpt-5", label: "GPT-5" },
        { id: "openai/gpt-5-mini", label: "GPT-5 Mini" },
        { id: "openai/o4", label: "o4 (Reasoning)" },
        { id: "openai/o3", label: "o3 (Reasoning)" },
        { id: "openai/gpt-4.1", label: "GPT-4.1" },
        { id: "openai/gpt-4o", label: "GPT-4o" },
        // Google via OpenRouter
        { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
        { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        // xAI
        { id: "x-ai/grok-4", label: "Grok 4" },
        { id: "x-ai/grok-3", label: "Grok 3" },
        // Meta — Llama 4 family (vision-capable)
        { id: "meta-llama/llama-4-behemoth", label: "Llama 4 Behemoth" },
        { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
        { id: "meta-llama/llama-4-scout", label: "Llama 4 Scout" },
        // DeepSeek (reasoning, very cheap)
        { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
        { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
        // Mistral
        { id: "mistralai/mistral-large-2", label: "Mistral Large 2" },
        // Qwen
        { id: "qwen/qwen3-235b", label: "Qwen3 235B" },
        // Z.AI
        { id: "z-ai/glm-4.7", label: "GLM 4.7" },
    ],
    groq: [
        { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
        { id: "llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
        { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
        { id: "gemma2-9b-it", label: "Gemma 2 9B" },
    ],
    grok: [
        { id: "grok-3", label: "Grok 3" },
        { id: "grok-3-mini", label: "Grok 3 Mini" },
        { id: "grok-2", label: "Grok 2" },
    ],
    nvidia: [
        { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
        { id: "meta/llama-3.1-405b-instruct", label: "Llama 3.1 405B Instruct" },
        { id: "nvidia/llama-3.1-nemotron-70b-instruct", label: "Nemotron 70B Instruct" },
        { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1" },
        { id: "google/gemma-2-27b-it", label: "Gemma 2 27B" },
        { id: "mistralai/mistral-large-2-instruct", label: "Mistral Large 2" },
        { id: "qwen/qwen2.5-72b-instruct", label: "Qwen 2.5 72B Instruct" },
    ],
    fireworks: [
        { id: "accounts/fireworks/models/deepseek-r1-0528", label: "DeepSeek R1 0528" },
        { id: "accounts/fireworks/models/deepseek-v3p2", label: "DeepSeek V3.2" },
        { id: "accounts/fireworks/models/glm-4p7", label: "GLM 4.7" },
        { id: "accounts/fireworks/models/minimax-m2p1", label: "MiniMax M2.1" },
        { id: "accounts/fireworks/models/qwen3-235b-a22b", label: "Qwen3 235B A22B" },
        { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B Instruct" },
    ],
    custom_openai: [
        { id: "gpt-4o-mini", label: "Custom model ID..." },
    ],
    local: [
        { id: "llama3.1:8b", label: "Llama 3.1 8B (Ollama)" },
        { id: "qwen2.5:7b", label: "Qwen 2.5 7B (Ollama)" },
        { id: "gemma2:9b", label: "Gemma 2 9B (Ollama)" },
        { id: "mistral:7b", label: "Mistral 7B (Ollama)" },
        { id: "deepseek-r1:8b", label: "DeepSeek R1 8B (Ollama)" },
    ],
    g4f: [
        // g4f brokers whatever upstream providers happen to be reachable, so this
        // is only a starting short-list — hit "↻ Refresh" next to the provider to
        // pull the live /v1/models list off your own running g4f server, which is
        // the only accurate answer for a given day.
        { id: "gpt-4o", label: "GPT-4o" },
        { id: "gpt-4o-mini", label: "GPT-4o Mini" },
        { id: "gpt-4", label: "GPT-4" },
        { id: "o1", label: "o1 (Reasoning)" },
        { id: "o1-mini", label: "o1-mini (Reasoning)" },
        { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
        { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
        { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
        { id: "llama-3.1-70b", label: "Llama 3.1 70B" },
        { id: "deepseek-r1", label: "DeepSeek R1" },
        { id: "qwen-2.5-72b", label: "Qwen 2.5 72B" },
    ],
};

// ==================== UPLOAD CONFIG ====================

export type UploadMode = "single" | "dual";

export interface UploadConfig {
    mode: UploadMode;
    aiModel: AIModelConfig;
    sourceName: string; // defaults to PDF filename
}

// ==================== EXTRACTED QUESTION ====================

export interface ExtractedDiagram {
    /** base64 data URL of the extracted image */
    dataUrl: string;
    /** AI-generated alt text for accessibility */
    description: string;
}

export interface ExtractedOption {
    text: string; // HTML string, may contain LaTeX/images
    isCorrect: boolean | null;
}

export interface ExtractedQuestion {
    /** Sequential number from the PDF */
    questionNumber: number;
    /** Question text as HTML (with LaTeX wrapped in KaTeX spans) */
    questionText: string;
    /** Detected language of the question */
    questionLanguage: string;
    /** Options array — empty for integer/numerical types */
    options: ExtractedOption[];
    /** Answer key: option index(es) or numeric value */
    answerKey: number | number[] | null;
    /** Solution text as HTML */
    solutionText: string;
    /** Detected language of the solution */
    solutionLanguage: string;
    /** AI-classified question type */
    questionType: QuestionType;
    /** AI-classified metadata */
    subject: string;
    chapter: string;
    topic: string;
    subtopic: string;
    difficultyLevel: DifficultyLevel;
    classLevel: string;
    /** Exam associations e.g. ["JEE Mains"] */
    exam: string[];
    /** Extracted figures/diagrams */
    diagrams: ExtractedDiagram[];
    /** AI confidence score 0-1 for the overall extraction quality */
    confidence: number;
    /** Any notes from AI about extraction issues */
    aiNotes: string;
}

// ==================== EXTRACTION API ====================

export interface ExtractionRequest {
    /** Document type — drives which API endpoint the queue posts to. */
    kind?: "pdf" | "docx";
    /** Base64-encoded questions PDF (pdf kind) */
    questionsPdfBase64?: string;
    /** Base64-encoded solutions PDF (pdf kind, dual mode) */
    solutionsPdfBase64?: string;
    /** Base64-encoded questions DOCX (docx kind) */
    questionsDocxBase64?: string;
    /** Base64-encoded solutions DOCX (docx kind, dual mode) */
    solutionsDocxBase64?: string;
    /** Upload mode */
    mode: UploadMode;
    /** AI provider to use */
    provider: AIModelProvider;
    /** Specific model ID (e.g. "gemini-2.5-flash", "gpt-4o") */
    modelId: string;
    /** API key for the selected model (optional if stored server-side) */
    apiKey?: string;
    /** Source name for the questions */
    sourceName: string;
    /** Original file name of the questions document — displayed in the report. */
    questionsPdfName?: string;
    /** Original file name of the solutions document (dual mode only). */
    solutionsPdfName?: string;
}

export interface ExtractionResponse {
    success: boolean;
    /** Extracted questions array */
    questions: ExtractedQuestion[];
    /** Detected PDF type */
    pdfType: "questions_only" | "questions_and_solutions";
    /** Total pages processed */
    totalPages: number;
    /** Non-fatal warnings */
    warnings: string[];
    /** Error message if success is false */
    error?: string;
    /** ID of the persisted pdf_extraction_reports row (so the client can navigate to it). */
    reportId?: string;
}

// ==================== EXTRACTION REPORTS ====================

export type ExtractionReportStatus =
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    | "saved"
    | "discarded";

export interface ExtractionReport {
    id: string;
    user_id: string | null;
    user_email: string | null;
    source_name: string;
    mode: "single" | "dual";
    /** "pdf" or "docx" — defaults to "pdf" for backward compatibility */
    document_type: "pdf" | "docx";
    provider: string;
    model_id: string | null;
    questions_pdf_name: string | null;
    questions_pdf_size: number | null;
    solutions_pdf_name: string | null;
    solutions_pdf_size: number | null;
    status: ExtractionReportStatus;
    pdf_type: string | null;
    total_pages: number | null;
    warnings: string[] | null;
    error: string | null;
    extracted_questions: ExtractedQuestion[];
    saved_question_ids: string[] | null;
    saved_at: string | null;
    created_at: string;
    updated_at: string;
}

/** Summary row shape returned by the list endpoint — same as ExtractionReport
 *  but with extracted_questions stripped for payload size. */
export type ExtractionReportSummary = Omit<ExtractionReport, "extracted_questions"> & {
    question_count: number;
};

// ==================== DOCX INGEST ====================

/** Reference to a single media binary that lives in Supabase Storage. */
export interface DocxMediaRef {
    /** Original Word relationship id (e.g. "rId7"). Preserved so we can rewire
     *  it inside an output .docx when generating test papers. */
    rId: string;
    /** Original target path inside the .docx, e.g. "media/image100.wmf". */
    original_target: string;
    /** Content type (e.g. "image/x-wmf", "image/png", "application/vnd.openxmlformats-officedocument.oleObject"). */
    mime: string;
    /** Path inside the docx-media Supabase bucket. */
    storage_path: string;
    /** Byte size after upload (for cost / size reporting in the UI). */
    bytes: number;
    /** Kind of media — "image" for visual, "ole" for editable equation objects. */
    kind: "image" | "ole";
}

/** Raw OOXML payload for one question, stored as `qbg_questions.source_docx`. */
export interface DocxQuestionPayload {
    /** Paragraph XML strings, in document order. Concatenated verbatim into
     *  the body of any generated output Word document. */
    ooxml_paragraphs: string[];
    /** Every media binary the paragraphs above reference. */
    media_refs: DocxMediaRef[];
    /** "1.", "2." etc. — the number that appeared in the source file. */
    original_q_number: number;
    /** File name of the source questions .docx. */
    original_file_name: string;
    /** Paragraph XML for the matched solution (dual mode), or null. */
    solution_ooxml_paragraphs?: string[] | null;
    /** Media binaries for the matched solution. */
    solution_media_refs?: DocxMediaRef[] | null;
}

/** A question after the docx ingester has split + tagged it. Mirrors
 *  ExtractedQuestion just enough for the existing report-storage path to
 *  consume it, with the extra `source_docx` blob the save route copies into
 *  qbg_questions.source_docx. */
export interface DocxExtractedQuestion extends ExtractedQuestion {
    /** Raw OOXML payload — exact source content. */
    source_docx: DocxQuestionPayload;
}

// ==================== SAVE API ====================

export interface SaveQuestionsRequest {
    /** The reviewed/edited questions to save */
    questions: ExtractedQuestion[];
    /** Source name override */
    sourceName: string;
}

export interface SaveQuestionsResponse {
    success: boolean;
    /** Number of questions saved */
    savedCount: number;
    /** Generated question IDs */
    questionIds: string[];
    /** Any errors per question */
    errors: { questionNumber: number; error: string }[];
}
