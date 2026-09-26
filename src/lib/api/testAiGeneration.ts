import type {
    GeneratedTest,
    JeeAdvancedPaper,
    Question,
    QuestionOption,
    SubjectRequirement,
    TestGenerationConfig,
    TestGenerationResponse,
} from "@/types";
import { EXAM_PRESETS, JEE_ADVANCED_PATTERN_MATRIX, getQuestionTypeLabel } from "@/types";
import {
    getProviderApiCredential,
    providerNeedsApiKey,
    getProviderBaseUrl,
} from "@/lib/userApiKeys";

export type AITestProvider =
    | "gemini"
    | "openrouter"
    | "anthropic"
    | "openai"
    | "grok"
    | "groq"
    | "nvidia"
    | "fireworks"
    | "custom_openai"
    | "local"
    | "g4f";

const AI_SOURCE_LABEL = "AI Generated";
const ADVANCE_SUBJECT_ORDER = ["Physics", "Chemistry", "Maths"];
const ADVANCE_PAPER_ORDER: JeeAdvancedPaper[] = ["Paper 1", "Paper 2"];

interface AITestRequirement {
    paper?: JeeAdvancedPaper;
    subject: string;
    questionType: string;
    count: number;
    easyPercent: number;
    hardPercent: number;
    selectedChapters: string[];
    selectedTopicsByChapter: Record<string, string[]>;
}

interface AITestGenerationInput {
    config: TestGenerationConfig;
    provider: AITestProvider;
    modelId: string;
    apiKey: string;
}

interface GeneratedQuestionDraft {
    questionText?: string;
    options?: Array<string | { text?: string }>;
    answerKey?: unknown;
    solutionText?: string;
    chapter?: string;
    topic?: string;
    subtopic?: string;
    classLevel?: string;
}

const OPENAI_COMPATIBLE_BASE_URLS: Record<
    Exclude<AITestProvider, "gemini" | "anthropic" | "custom_openai" | "g4f">,
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

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeDifficulty(
    easyPercent: number,
    hardPercent: number
): { Easy: number; Medium: number; Hard: number } {
    let easy = clamp(easyPercent || 0, 0, 100);
    let hard = clamp(hardPercent || 0, 0, 100);
    const total = easy + hard;
    if (total > 100) {
        const scale = 100 / total;
        easy *= scale;
        hard *= scale;
    }
    const medium = Math.max(0, 100 - easy - hard);
    return { Easy: easy, Medium: medium, Hard: hard };
}

function allocateTargets(total: number, percentMap: Record<string, number>): Record<string, number> {
    const keys = Object.keys(percentMap);
    if (total <= 0 || keys.length === 0) return {};

    const raw = keys.map((key) => ({
        key,
        exact: (clamp(percentMap[key] || 0, 0, 100) * total) / 100,
    }));

    const allocated = raw.map((item) => ({
        key: item.key,
        value: Math.floor(item.exact),
        fraction: item.exact % 1,
    }));
    let used = allocated.reduce((sum, item) => sum + item.value, 0);
    let remaining = total - used;

    allocated
        .sort((a, b) => b.fraction - a.fraction)
        .forEach((item) => {
            if (remaining > 0) {
                item.value += 1;
                remaining -= 1;
            }
        });

    return Object.fromEntries(allocated.map((item) => [item.key, item.value]));
}

function buildDifficultyPlan(
    count: number,
    easyPercent: number,
    hardPercent: number
): Array<"Easy" | "Medium" | "Hard"> {
    const normalized = normalizeDifficulty(easyPercent, hardPercent);
    const targets = allocateTargets(count, normalized);
    const plan: Array<"Easy" | "Medium" | "Hard"> = [];
    (["Easy", "Medium", "Hard"] as const).forEach((level) => {
        const n = targets[level] || 0;
        for (let i = 0; i < n; i++) plan.push(level);
    });
    while (plan.length < count) plan.push("Medium");
    return plan.slice(0, count);
}

function buildChapterPlan(count: number, chapters: string[]): string[] {
    if (count <= 0) return [];
    const cleaned = chapters.map((chapter) => chapter.trim()).filter(Boolean);
    if (!cleaned.length) return Array.from({ length: count }, () => "");

    const targets = allocateTargets(
        count,
        Object.fromEntries(cleaned.map((chapter) => [chapter, 100 / cleaned.length]))
    );
    const plan: string[] = [];
    cleaned.forEach((chapter) => {
        const n = targets[chapter] || 0;
        for (let i = 0; i < n; i++) plan.push(chapter);
    });
    while (plan.length < count) plan.push(cleaned[plan.length % cleaned.length]);
    return plan.slice(0, count);
}

function buildSectionPrompt(args: {
    examPreset: string;
    subject: string;
    paper?: string;
    questionType: string;
    count: number;
    chapterPlan: string[];
    difficultyPlan: Array<"Easy" | "Medium" | "Hard">;
    topicMap: Record<string, string[]>;
}): string {
    const chapterInstructions = args.chapterPlan.some(Boolean)
        ? args.chapterPlan
              .map((chapter, index) => `${index + 1}. ${chapter}`)
              .join("\n")
        : "Model may choose syllabus-aligned chapters.";
    const difficultyInstructions = args.difficultyPlan
        .map((level, index) => `${index + 1}. ${level}`)
        .join("\n");

    const topicInstructions =
        Object.keys(args.topicMap).length > 0
            ? Object.entries(args.topicMap)
                  .map(([chapter, topics]) =>
                      topics.length
                          ? `${chapter}: ${topics.join(", ")}`
                          : `${chapter}: any topic`
                  )
                  .join("\n")
            : "No topic restriction.";

    return `You are an expert exam question writer.

Create EXACTLY ${args.count} high-quality ${args.questionType} questions for ${args.examPreset}${args.paper ? ` (${args.paper})` : ""}, Subject: ${args.subject}.

Rules:
1) Return STRICT JSON object only (no markdown): {"questions":[...]}.
2) Keep language concise, exam-style, and mathematically correct.
3) Use HTML-safe text; if math is needed, use inline LaTeX like \\(x^2\\).
4) Provide full solution in "solutionText".
5) Use this chapter plan per question index:
${chapterInstructions}
6) Use this difficulty plan per question index:
${difficultyInstructions}
7) Topic preferences:
${topicInstructions}
8) For option-based types, provide 4 options in "options" and valid "answerKey".
9) For Integer/Numerical/Single_Digit_Integer/Passage_Numerical, keep options empty and answerKey numeric.

Each question object must include:
{
  "questionText": string,
  "options": string[] | [],
  "answerKey": number | number[] | string,
  "solutionText": string,
  "chapter": string,
  "topic": string,
  "subtopic": string,
  "classLevel": "11" | "12" | ""
}`;
}

function extractJson(text: string): unknown {
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
    return JSON.parse(cleaned);
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
    provider: Exclude<AITestProvider, "gemini" | "anthropic">,
    modelId: string,
    apiKey: string,
    prompt: string
): Promise<string> {
    const baseUrl = (provider === "custom_openai" || provider === "g4f")
        ? getProviderBaseUrl(provider, apiKey)
        : OPENAI_COMPATIBLE_BASE_URLS[provider];
    const actualApiKey = getProviderApiCredential(provider, apiKey);
    if (!baseUrl) throw new Error("OpenAI-compatible base URL is required.");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (providerNeedsApiKey(provider)) {
        headers["Authorization"] = `Bearer ${actualApiKey}`;
    }
    if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://question-bank.app";
        headers["X-Title"] = "Question Bank";
    }
    const isReasoningModel = modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4-mini");
    const bodyPayload: any = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
    };
    if (!isReasoningModel) {
        bodyPayload.temperature = 0.5;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
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
    provider: AITestProvider,
    modelId: string,
    apiKey: string,
    prompt: string
): Promise<string> {
    if (provider === "gemini") return runGeminiModel(modelId, apiKey, prompt);
    if (provider === "anthropic") return runAnthropicModel(modelId, apiKey, prompt);
    return runOpenAICompatibleModel(provider, modelId, apiKey, prompt);
}

function requiresOptions(questionType: string): boolean {
    const normalized = questionType.trim().toLowerCase();
    if (
        normalized === "integer" ||
        normalized === "numerical" ||
        normalized === "single_digit_integer" ||
        normalized === "passage_numerical"
    ) {
        return false;
    }
    return true;
}

function normalizeOptions(raw: GeneratedQuestionDraft["options"], questionType: string): QuestionOption[] {
    if (!requiresOptions(questionType)) return [];
    const values = Array.isArray(raw) ? raw : [];
    const normalized = values
        .map((item) => (typeof item === "string" ? item.trim() : String(item?.text || "").trim()))
        .filter(Boolean)
        .slice(0, 4);

    while (normalized.length < 4) {
        normalized.push(`Option ${String.fromCharCode(65 + normalized.length)}`);
    }

    return normalized.map((text) => ({ text, isCorrect: null }));
}

function normalizeAnswerKey(
    raw: unknown,
    questionType: string,
    optionsLength: number
): number | number[] {
    if (!requiresOptions(questionType)) {
        const numeric = Number(
            Array.isArray(raw) ? raw[0] : typeof raw === "string" ? raw.trim() : raw
        );
        return Number.isFinite(numeric) ? numeric : 0;
    }

    const toOptionNumber = (value: unknown): number | null => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        const rounded = Math.floor(numeric);
        if (rounded < 1 || rounded > Math.max(1, optionsLength)) return null;
        return rounded;
    };

    const normalizedType = questionType.trim().toLowerCase();
    if (normalizedType === "multi_choice(mcq)") {
        const values = Array.isArray(raw) ? raw : [raw];
        const indices = values.map(toOptionNumber).filter((value): value is number => value !== null);
        return indices.length ? indices : [1];
    }

    if (Array.isArray(raw)) {
        const first = toOptionNumber(raw[0]);
        return [first ?? 1];
    }
    const single = toOptionNumber(raw);
    return [single ?? 1];
}

function normalizeClassLevel(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "11" || trimmed === "12" ? trimmed : null;
}

function createQuestionFromDraft(params: {
    draft: GeneratedQuestionDraft;
    requirement: AITestRequirement;
    examPreset: TestGenerationConfig["examPreset"];
    chapterFallback: string;
    difficulty: "Easy" | "Medium" | "Hard";
}): Question {
    const questionId = crypto.randomUUID();
    const options = normalizeOptions(params.draft.options, params.requirement.questionType);
    const answerKey = normalizeAnswerKey(
        params.draft.answerKey,
        params.requirement.questionType,
        options.length
    );

    const questionText = String(params.draft.questionText || "").trim();
    const solutionText = String(params.draft.solutionText || "").trim();
    const chapter = String(params.draft.chapter || "").trim() || params.chapterFallback;
    const topic = String(params.draft.topic || "").trim();
    const subtopic = String(params.draft.subtopic || "").trim();

    const examLabel =
        params.examPreset === "JEE_ADVANCE"
            ? "JEE Advanced"
            : params.examPreset === "JEE_MAINS"
                ? "JEE Mains"
                : "NEET";

    return {
        question_id: questionId,
        qbg_id: questionId,
        question_text: questionText || "Generated question text unavailable.",
        options,
        answer_key: answerKey,
        solution_text: solutionText,
        question_type: params.requirement.questionType,
        subject: params.requirement.subject,
        chapter: chapter || "General",
        topic,
        source: AI_SOURCE_LABEL,
        difficutly_level: params.difficulty,
        parent_question_id: null,
        raw_data: null,
        exam: [examLabel],
        class_level: normalizeClassLevel(params.draft.classLevel),
        subtopic: subtopic || null,
    };
}

function buildCustomRequirements(config: TestGenerationConfig): AITestRequirement[] {
    const selectedTopicsByChapter = config.selectedTopicsByChapter || {};
    return (config.customRows || [])
        .map((row) => ({
            row,
            subject: row.subject?.trim() || "",
            questionType: row.questionType?.trim() || "",
            count: Math.max(0, Math.floor(row.numQuestions || 0)),
        }))
        .filter((item) => item.subject && item.questionType && item.count > 0)
        .map(({ row, subject, questionType, count }) => {
            const chapter = row.chapter?.trim();
            const chapters = chapter
                ? [chapter]
                : config.fullSyllabus
                    ? []
                    : config.selectedChapters?.[subject] || [];

            const topicMap: Record<string, string[]> = {};
            if (chapter) {
                topicMap[chapter] = row.topic?.trim() ? [row.topic.trim()] : [];
            } else {
                chapters.forEach((ch) => {
                    topicMap[ch] = selectedTopicsByChapter[ch] || [];
                });
            }

            return {
                subject,
                questionType,
                count,
                easyPercent: row.easyPercent,
                hardPercent: row.hardPercent,
                selectedChapters: chapters,
                selectedTopicsByChapter: topicMap,
            };
        });
}

function subjectAliases(subject: string): string[] {
    if (subject === "Biology") return ["Biology", "Botany", "Zoology"];
    return [subject];
}

function subjectMatchesRequirement(selectedSubject: string, requirement: SubjectRequirement): boolean {
    const normalizedSelected = selectedSubject.trim().toLowerCase();
    return subjectAliases(requirement.subject)
        .map((name) => name.toLowerCase())
        .includes(normalizedSelected);
}

function buildRequirements(config: TestGenerationConfig): {
    requirements: AITestRequirement[];
    warnings: string[];
} {
    const warnings: string[] = [];

    if (config.customRows?.length) {
        const requirements = buildCustomRequirements(config);
        if (!requirements.length) {
            warnings.push("Custom mode had no valid rows; falling back to preset generation.");
        } else {
            return { requirements, warnings };
        }
    }

    if (config.examPreset === "JEE_ADVANCE") {
        const year = String(config.jeeAdvancedYear || "").trim();
        const matrix = JEE_ADVANCED_PATTERN_MATRIX[year];
        if (!matrix) {
            throw new Error(`Unsupported JEE Advanced year: ${year || "not provided"}`);
        }

        const papers = (config.jeeAdvancedPapers || []).filter(Boolean) as JeeAdvancedPaper[];
        if (!papers.length) {
            throw new Error("Select at least one JEE Advanced paper.");
        }

        const selectedSubjects = (config.selectedSubjects || [])
            .map((subject) => subject.trim())
            .filter(Boolean);
        const subjects =
            selectedSubjects.length > 0
                ? [...new Set(selectedSubjects)].sort((a, b) => {
                      const ai = ADVANCE_SUBJECT_ORDER.indexOf(a);
                      const bi = ADVANCE_SUBJECT_ORDER.indexOf(b);
                      const av = ai === -1 ? ADVANCE_SUBJECT_ORDER.length : ai;
                      const bv = bi === -1 ? ADVANCE_SUBJECT_ORDER.length : bi;
                      if (av !== bv) return av - bv;
                      return a.localeCompare(b);
                  })
                : [...ADVANCE_SUBJECT_ORDER];

        const byPaper = config.questionTypeDistributionByPaper || {};
        const selectedPapers = [...new Set(papers)].sort(
            (a, b) => ADVANCE_PAPER_ORDER.indexOf(a) - ADVANCE_PAPER_ORDER.indexOf(b)
        );
        const requirements: AITestRequirement[] = [];

        selectedPapers.forEach((paper) => {
            const customRows = (byPaper[paper] || [])
                .filter((row) => row.type && row.count > 0)
                .map((row) => ({ type: row.type, count: Math.max(1, Math.floor(row.count)) }));
            const rows = customRows.length ? customRows : matrix[paper];
            subjects.forEach((subject) => {
                rows.forEach((row) => {
                    const chapters = config.fullSyllabus
                        ? []
                        : config.selectedChapters?.[subject] || [];
                    const topicMap: Record<string, string[]> = {};
                    chapters.forEach((chapter) => {
                        topicMap[chapter] = config.selectedTopicsByChapter?.[chapter] || [];
                    });
                    requirements.push({
                        paper,
                        subject,
                        questionType: row.type,
                        count: row.count,
                        easyPercent: config.difficultyDistribution?.easyPercent ?? 30,
                        hardPercent: config.difficultyDistribution?.hardPercent ?? 30,
                        selectedChapters: chapters,
                        selectedTopicsByChapter: topicMap,
                    });
                });
            });
        });

        return { requirements, warnings };
    }

    const preset = EXAM_PRESETS[config.examPreset];
    if (!preset) {
        throw new Error(`Unsupported exam preset: ${config.examPreset}`);
    }

    const customDistribution = (config.questionTypeDistribution || [])
        .filter((row) => row.type && row.count > 0)
        .map((row) => ({ type: row.type, count: Math.max(1, Math.floor(row.count)) }));
    const selectedSubjects = (config.selectedSubjects || [])
        .map((subject) => subject.trim())
        .filter(Boolean);

    const filteredRequirements = selectedSubjects.length
        ? preset.subjects.filter((req) =>
              selectedSubjects.some((selected) => subjectMatchesRequirement(selected, req))
          )
        : preset.subjects;
    const activeRequirements = filteredRequirements.length ? filteredRequirements : preset.subjects;

    if (selectedSubjects.length && filteredRequirements.length === 0) {
        warnings.push(
            `Selected subjects (${selectedSubjects.join(", ")}) are not available for ${preset.label}. Using default preset subjects.`
        );
    }

    const requirements: AITestRequirement[] = [];
    activeRequirements.forEach((requirement) => {
        const rows = customDistribution.length ? customDistribution : requirement.questionTypes;
        rows.forEach((row) => {
            const chapters = config.fullSyllabus
                ? []
                : config.selectedChapters?.[requirement.subject] || [];
            const topicMap: Record<string, string[]> = {};
            chapters.forEach((chapter) => {
                topicMap[chapter] = config.selectedTopicsByChapter?.[chapter] || [];
            });
            requirements.push({
                paper: requirement.paper,
                subject: requirement.subject,
                questionType: row.type,
                count: row.count,
                easyPercent: config.difficultyDistribution?.easyPercent ?? 30,
                hardPercent: config.difficultyDistribution?.hardPercent ?? 30,
                selectedChapters: chapters,
                selectedTopicsByChapter: topicMap,
            });
        });
    });

    return { requirements, warnings };
}

function buildStatsFromSections(sections: GeneratedTest["sections"]) {
    const byDifficulty: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byChapter: Record<string, number> = {};

    sections.forEach((section) => {
        section.questionTypes.forEach((group) => {
            group.questions.forEach((question) => {
                const difficulty = question.difficutly_level || "Unknown";
                const source = question.source || "Unknown";
                const chapter = question.chapter || "Unknown";
                byDifficulty[difficulty] = (byDifficulty[difficulty] || 0) + 1;
                bySource[source] = (bySource[source] || 0) + 1;
                byChapter[chapter] = (byChapter[chapter] || 0) + 1;
            });
        });
    });

    return { byDifficulty, bySource, byChapter };
}

async function generateQuestionsForRequirement(args: {
    config: TestGenerationConfig;
    provider: AITestProvider;
    modelId: string;
    apiKey: string;
    requirement: AITestRequirement;
}): Promise<{ questions: Question[]; warning?: string }> {
    const requirement = args.requirement;
    if (requirement.count <= 0) {
        return { questions: [] };
    }

    const chapterPlan = buildChapterPlan(requirement.count, requirement.selectedChapters);
    const difficultyPlan = buildDifficultyPlan(
        requirement.count,
        requirement.easyPercent,
        requirement.hardPercent
    );

    const chunkSize = 8;
    const questions: Question[] = [];

    for (let offset = 0; offset < requirement.count; offset += chunkSize) {
        const chunkCount = Math.min(chunkSize, requirement.count - offset);
        const chunkChapters = chapterPlan.slice(offset, offset + chunkCount);
        const chunkDifficulty = difficultyPlan.slice(offset, offset + chunkCount);
        const prompt = buildSectionPrompt({
            examPreset:
                args.config.examPreset === "JEE_ADVANCE"
                    ? "JEE Advanced"
                    : args.config.examPreset === "JEE_MAINS"
                        ? "JEE Mains"
                        : "NEET",
            subject: requirement.subject,
            paper: requirement.paper,
            questionType: requirement.questionType,
            count: chunkCount,
            chapterPlan: chunkChapters,
            difficultyPlan: chunkDifficulty,
            topicMap: requirement.selectedTopicsByChapter,
        });

        const raw = await runAIModel(args.provider, args.modelId, args.apiKey, prompt);
        const parsed = extractJson(raw) as { questions?: GeneratedQuestionDraft[] };
        const drafts = Array.isArray(parsed.questions) ? parsed.questions : [];

        for (let index = 0; index < chunkCount; index++) {
            const draft = drafts[index] || {};
            const chapterFallback = chunkChapters[index] || requirement.selectedChapters[0] || "General";
            const difficulty = chunkDifficulty[index] || "Medium";
            questions.push(
                createQuestionFromDraft({
                    draft,
                    requirement,
                    examPreset: args.config.examPreset,
                    chapterFallback,
                    difficulty,
                })
            );
        }
    }

    if (questions.length < requirement.count) {
        return {
            questions,
            warning: `${requirement.paper ? `${requirement.paper} / ` : ""}${requirement.subject} / ${requirement.questionType}: requested ${requirement.count}, generated ${questions.length}.`,
        };
    }

    return { questions: questions.slice(0, requirement.count) };
}

export async function generateAITests(
    input: AITestGenerationInput
): Promise<TestGenerationResponse> {
    try {
        const { config, provider, modelId, apiKey } = input;
        const { requirements, warnings } = buildRequirements(config);

        if (!requirements.length) {
            return {
                success: false,
                tests: [],
                warnings,
                error: "No valid generation requirements were found.",
            };
        }

        const totalTests = Math.max(1, Math.min(10, Math.floor(config.numberOfTests || 1)));
        const tests: GeneratedTest[] = [];

        for (let testNumber = 1; testNumber <= totalTests; testNumber++) {
            const sectionMap = new Map<
                string,
                {
                    paper?: JeeAdvancedPaper;
                    subject: string;
                    questionTypes: Map<string, Question[]>;
                }
            >();

            for (const requirement of requirements) {
                const generated = await generateQuestionsForRequirement({
                    config,
                    provider,
                    modelId,
                    apiKey,
                    requirement,
                });
                if (generated.warning) warnings.push(`Test ${testNumber}: ${generated.warning}`);

                const sectionKey = `${requirement.paper || "NO_PAPER"}::${requirement.subject}`;
                if (!sectionMap.has(sectionKey)) {
                    sectionMap.set(sectionKey, {
                        paper: requirement.paper,
                        subject: requirement.subject,
                        questionTypes: new Map(),
                    });
                }
                const section = sectionMap.get(sectionKey)!;
                const existing = section.questionTypes.get(requirement.questionType) || [];
                section.questionTypes.set(requirement.questionType, [...existing, ...generated.questions]);
            }

            const sections = Array.from(sectionMap.values())
                .map((section) => {
                    const questionTypes = Array.from(section.questionTypes.entries()).map(
                        ([type, questions]) => ({
                            type,
                            typeLabel: getQuestionTypeLabel(type),
                            questions,
                        })
                    );
                    const totalQuestions = questionTypes.reduce(
                        (sum, group) => sum + group.questions.length,
                        0
                    );
                    return {
                        paper: section.paper,
                        subject: section.subject,
                        questionTypes,
                        totalQuestions,
                    };
                })
                .sort((a, b) => {
                    const paperA = a.paper ? ADVANCE_PAPER_ORDER.indexOf(a.paper) : -1;
                    const paperB = b.paper ? ADVANCE_PAPER_ORDER.indexOf(b.paper) : -1;
                    if (paperA !== paperB) return paperA - paperB;
                    return a.subject.localeCompare(b.subject);
                });

            const totalQuestions = sections.reduce((sum, section) => sum + section.totalQuestions, 0);
            tests.push({
                testNumber,
                batchName: config.batchName,
                testDate: config.testDate,
                examPreset: config.examPreset,
                sections,
                totalQuestions,
                stats: buildStatsFromSections(sections),
            });
        }

        return {
            success: true,
            tests,
            warnings,
            questionUsageById: {},
        };
    } catch (error) {
        return {
            success: false,
            tests: [],
            warnings: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
