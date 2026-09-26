import { NextRequest, NextResponse } from "next/server";
import {
    callStructuredAiModel,
    isSupportedAiProvider,
    parseStructuredAiResponse,
    resolveAiProviderApiKey,
} from "@/lib/ai/verification";
import {
    fetchQuestionById,
    updateQuestionById,
} from "@/lib/api/questions";
import { saveAiVerificationReportForTests } from "@/lib/api/testHistory";
import { checkPermission } from "@/lib/auth/serverAuth";
import type {
    AiMetadata,
    AiVerificationEntry,
    ExamPreset,
    GeneratedTest,
    JeeAdvancedPaper,
    Question,
    TestAiPatternCheck,
    TestAiVerificationQuestionResult,
    TestAiVerificationReport,
    TestAiVerificationWrongQuestion,
    TestGenerationConfig,
} from "@/types";
import { normalizeAnswerKey } from "@/types";

interface VerifyTestRequestBody {
    testIds: string[];
    test: GeneratedTest;
    examPreset: ExamPreset;
    generationConfig?: Partial<TestGenerationConfig>;
    provider: string;
    modelId: string;
    modelLabel?: string;
}

interface OrderedQuestionContext {
    displayNumber: number;
    subject: string;
    paper?: JeeAdvancedPaper;
    question: Question;
}

function stripHtml(html: string, maxLength = 220): string {
    const plain = String(html || "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(p|div|li)>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    return plain.length > maxLength ? `${plain.slice(0, maxLength - 3)}...` : plain;
}

function incrementCount(map: Record<string, number>, key: string) {
    const normalized = key.trim() || "Unknown";
    map[normalized] = (map[normalized] || 0) + 1;
}

function buildVerifyPrompt(question: Question): string {
    const optionsText = (question.options || [])
        .filter((option) => option.text !== null)
        .map(
            (option, index) =>
                `  ${String.fromCharCode(65 + index)}. ${option.text}${option.isCorrect ? " [marked correct]" : ""}`
        )
        .join("\n");

    const answerKey = normalizeAnswerKey(question.answer_key)
        .map((value) => String(value))
        .join(", ");

    return `You are an expert question quality checker and verifier for educational content (Physics, Chemistry, Mathematics, Biology).

## Question Details

**Subject:** ${question.subject}
**Chapter:** ${question.chapter}
**Topic:** ${question.topic}
**Question Type:** ${question.question_type}

**Question Text:**
${question.question_text}

${optionsText ? `**Options:**\n${optionsText}` : ""}

**Given Answer Key:** ${answerKey || "Not provided"}

**Given Solution:**
${question.solution_text || "No solution provided"}

## Your Task

1. Solve the question yourself from scratch.
2. Determine the correct answer.
3. Compare your answer with the given answer key.
4. Review the given solution for errors, missing steps, or quality problems.
5. Review the question language for clarity and correctness.
6. Provide specific suggestions for improvement.

## Response Format

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "answerKeyVerified": <true if your answer matches the given answer key, false if not>,
  "aiAnswer": "<your calculated answer>",
  "aiAnswerExplanation": "<brief explanation of why this is the correct answer>",
  "aiSolution": "<your complete step-by-step solution in HTML format, preserving LaTeX with \\\\( \\\\) for inline and \\\\[ \\\\] for display math>",
  "aiSuggestion": "<detailed suggestions for the existing solution, answer key, or wording. If everything is correct, say so clearly.>",
  "questionLanguageQuality": "<Good / Needs Improvement with brief note>",
  "solutionLanguageQuality": "<Good / Needs Improvement / Not Provided with brief note>",
  "overallVerdict": "<Correct / Incorrect Answer Key / Needs Review>"
}`;
}

function collectOrderedQuestions(test: GeneratedTest): OrderedQuestionContext[] {
    const ordered: OrderedQuestionContext[] = [];
    let displayNumber = 0;

    test.sections.forEach((section) => {
        section.questionTypes.forEach((group) => {
            group.questions.forEach((question) => {
                displayNumber += 1;
                ordered.push({
                    displayNumber,
                    subject: section.subject,
                    paper: section.paper,
                    question,
                });
            });
        });
    });

    return ordered;
}

function getExistingAiMetadata(rawData: unknown): AiMetadata {
    const first =
        Array.isArray(rawData) && rawData.length > 0
            ? rawData[0]
            : rawData && typeof rawData === "object" && !Array.isArray(rawData)
              ? rawData
              : null;
    const meta =
        first && typeof first === "object" && !Array.isArray(first)
            ? (first as Record<string, unknown>).ai_metadata
            : null;

    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        return { verifications: [], translations: [] };
    }

    const value = meta as Partial<AiMetadata>;
    return {
        verifications: Array.isArray(value.verifications)
            ? (value.verifications as AiVerificationEntry[])
            : [],
        translations: Array.isArray(value.translations) ? value.translations : [],
    };
}

function mergeAiMetadataIntoRawData(rawData: unknown, aiMetadata: AiMetadata): unknown {
    let firstEntry: Record<string, unknown>;
    if (Array.isArray(rawData) && rawData.length > 0 && rawData[0] && typeof rawData[0] === "object") {
        firstEntry = { ...(rawData[0] as Record<string, unknown>) };
        firstEntry.ai_metadata = aiMetadata;
        return [firstEntry, ...rawData.slice(1)];
    }

    if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
        firstEntry = { ...(rawData as Record<string, unknown>) };
        firstEntry.ai_metadata = aiMetadata;
        return firstEntry;
    }

    return {
        ai_metadata: aiMetadata,
    };
}

function getScopeExpectedRows(
    generationConfig: Partial<TestGenerationConfig> | undefined,
    scope: { subject: string; paper?: JeeAdvancedPaper }
): Array<{ type: string; count: number }> {
    if (!generationConfig) return [];

    if (generationConfig.customRows?.length) {
        const rows = generationConfig.customRows.filter(
            (row) => row.subject === scope.subject
        );
        const counts = new Map<string, number>();
        rows.forEach((row) => {
            counts.set(row.questionType, (counts.get(row.questionType) || 0) + row.numQuestions);
        });
        return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
    }

    if (scope.paper && generationConfig.questionTypeDistributionByPaper?.[scope.paper]) {
        return (generationConfig.questionTypeDistributionByPaper[scope.paper] || []).map(
            (row) => ({
                type: row.type,
                count: row.count,
            })
        );
    }

    return (generationConfig.questionTypeDistribution || []).map((row) => ({
        type: row.type,
        count: row.count,
    }));
}

function buildPatternChecks(
    test: GeneratedTest,
    generationConfig?: Partial<TestGenerationConfig>
): TestAiPatternCheck[] {
    return test.sections.map((section) => {
        const expectedRows = getScopeExpectedRows(generationConfig, {
            subject: section.subject,
            paper: section.paper,
        });
        const expectedByType = expectedRows.reduce<Record<string, number>>((acc, row) => {
            acc[row.type] = row.count;
            return acc;
        }, {});
        const actualByType = section.questionTypes.reduce<Record<string, number>>((acc, group) => {
            acc[group.type] = group.questions.length;
            return acc;
        }, {});

        const allTypes = Array.from(
            new Set([...Object.keys(expectedByType), ...Object.keys(actualByType)])
        );
        const missingByType: Record<string, number> = {};
        const extraByType: Record<string, number> = {};

        allTypes.forEach((type) => {
            const delta = (actualByType[type] || 0) - (expectedByType[type] || 0);
            if (delta < 0) {
                missingByType[type] = Math.abs(delta);
            } else if (delta > 0) {
                extraByType[type] = delta;
            }
        });

        return {
            label: section.paper ? `${section.paper} - ${section.subject}` : section.subject,
            subject: section.subject,
            paper: section.paper,
            expectedByType,
            actualByType,
            missingByType,
            extraByType,
            passed: Object.keys(missingByType).length === 0 && Object.keys(extraByType).length === 0,
        };
    });
}

function getOutOfSyllabusInfo(
    question: Question,
    generationConfig?: Partial<TestGenerationConfig>
): { outOfSyllabus: boolean; reason?: string } {
    if (!generationConfig || generationConfig.fullSyllabus !== false) {
        return { outOfSyllabus: false };
    }

    const allowedChapters = (generationConfig.selectedChapters?.[question.subject] || []).filter(Boolean);
    if (allowedChapters.length && !allowedChapters.includes(question.chapter)) {
        return {
            outOfSyllabus: true,
            reason: `Chapter "${question.chapter}" is outside the selected syllabus for ${question.subject}.`,
        };
    }

    const allowedTopics = (generationConfig.selectedTopicsByChapter?.[question.chapter] || []).filter(Boolean);
    if (allowedTopics.length && !allowedTopics.includes(question.topic)) {
        return {
            outOfSyllabus: true,
            reason: `Topic "${question.topic}" is outside the selected syllabus for chapter "${question.chapter}".`,
        };
    }

    return { outOfSyllabus: false };
}

function buildOverallReportPrompt(args: {
    examPreset: ExamPreset;
    patternChecks: TestAiPatternCheck[];
    subjectQuestionCounts: Record<string, number>;
    chapterQuestionCounts: Record<string, number>;
    questionResults: TestAiVerificationQuestionResult[];
}): string {
    const patternText = args.patternChecks
        .map((check) => {
            const expected = Object.keys(check.expectedByType).length
                ? JSON.stringify(check.expectedByType)
                : "{}";
            const actual = Object.keys(check.actualByType).length
                ? JSON.stringify(check.actualByType)
                : "{}";
            const missing = Object.keys(check.missingByType).length
                ? JSON.stringify(check.missingByType)
                : "{}";
            const extra = Object.keys(check.extraByType).length
                ? JSON.stringify(check.extraByType)
                : "{}";
            return `- ${check.label}: expected=${expected}, actual=${actual}, missing=${missing}, extra=${extra}`;
        })
        .join("\n");

    const questionLines = args.questionResults
        .map(
            (result) =>
                `Q${result.displayNumber} [${result.subject} / ${result.chapter} / ${result.questionType}]: verdict=${result.overallVerdict}; answerKeyVerified=${result.answerKeyVerified}; outOfSyllabus=${result.outOfSyllabus}; suggestion=${stripHtml(result.aiSuggestion, 220)}`
        )
        .join("\n");

    return `You are an expert academic quality auditor for test papers.

You are given the verified question-level findings for one complete ${args.examPreset.replace(/_/g, " ")} paper.

## Deterministic Pattern Checks
${patternText || "- No pattern checks available"}

## Subject Counts
${JSON.stringify(args.subjectQuestionCounts)}

## Chapter Counts
${JSON.stringify(args.chapterQuestionCounts)}

## Question Findings
${questionLines}

## Your Task

Write a concise but thorough paper-level report.

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "overallSummary": "<2-4 sentence summary of paper quality>",
  "paperStructureAssessment": "<comment on pattern compliance, missing question types, wrong compositions, etc.>",
  "syllabusBalanceAssessment": "<comment on subject/chapter balance and whether anything appears out of syllabus>",
  "topRecommendations": ["<recommendation 1>", "<recommendation 2>"],
  "wrongQuestions": [
    {
      "displayNumber": 1,
      "summary": "<what is wrong with this question>",
      "suggestion": "<best fix>"
    }
  ]
}`;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let currentIndex = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = currentIndex;
            currentIndex += 1;
            if (index >= items.length) return;
            results[index] = await handler(items[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as VerifyTestRequestBody;
        if (!body?.test || !body.test.sections?.length) {
            return NextResponse.json(
                { success: false, error: "A saved test payload is required." },
                { status: 400 }
            );
        }
        if (!Array.isArray(body.testIds) || body.testIds.length === 0) {
            return NextResponse.json(
                { success: false, error: "At least one saved test id is required." },
                { status: 400 }
            );
        }
        if (!body.provider || !isSupportedAiProvider(body.provider)) {
            return NextResponse.json(
                { success: false, error: "Valid AI provider is required." },
                { status: 400 }
            );
        }
        if (!body.modelId?.trim()) {
            return NextResponse.json(
                { success: false, error: "AI model ID is required." },
                { status: 400 }
            );
        }

        const provider = body.provider;
        const apiKey = await resolveAiProviderApiKey(req, provider);
        if (!apiKey) {
            return NextResponse.json(
                {
                    success: false,
                    error: `No API key found for ${provider}. Add it from the user icon.`,
                },
                { status: 400 }
            );
        }

        const orderedQuestions = collectOrderedQuestions(body.test);
        const patternChecks = buildPatternChecks(body.test, body.generationConfig);

        const questionResults = await mapWithConcurrency(
            orderedQuestions,
            3,
            async (context) => {
                const rawResponse = await callStructuredAiModel(
                    provider,
                    body.modelId,
                    apiKey,
                    buildVerifyPrompt(context.question)
                );
                const parsed = parseStructuredAiResponse(rawResponse);
                const outOfSyllabus = getOutOfSyllabusInfo(context.question, body.generationConfig);
                const scopeCheck = patternChecks.find(
                    (item) =>
                        item.subject === context.subject &&
                        (item.paper || "") === (context.paper || "")
                );
                const expectedForType = scopeCheck?.expectedByType?.[context.question.question_type] || 0;
                const structuralIssues: string[] = [];
                if (scopeCheck && Object.keys(scopeCheck.expectedByType).length > 0 && expectedForType === 0) {
                    structuralIssues.push(
                        `Question type "${context.question.question_type}" is not part of the configured pattern for this section.`
                    );
                }
                if (outOfSyllabus.reason) {
                    structuralIssues.push(outOfSyllabus.reason);
                }

                return {
                    questionId: context.question.question_id,
                    displayNumber: context.displayNumber,
                    subject: context.subject,
                    chapter: context.question.chapter,
                    topic: context.question.topic,
                    questionType: context.question.question_type,
                    paper: context.paper,
                    answerKeyVerified: parsed.answerKeyVerified === true,
                    aiAnswer: String(parsed.aiAnswer ?? ""),
                    aiAnswerExplanation: String(parsed.aiAnswerExplanation ?? ""),
                    aiSolution: String(parsed.aiSolution ?? ""),
                    aiSuggestion: String(parsed.aiSuggestion ?? ""),
                    questionLanguageQuality: String(parsed.questionLanguageQuality ?? ""),
                    solutionLanguageQuality: String(parsed.solutionLanguageQuality ?? ""),
                    overallVerdict: String(parsed.overallVerdict ?? ""),
                    outOfSyllabus: outOfSyllabus.outOfSyllabus,
                    outOfSyllabusReason: outOfSyllabus.reason,
                    structuralIssues,
                    verifiedAt: new Date().toISOString(),
                } satisfies TestAiVerificationQuestionResult;
            }
        );

        const updatedQuestions = await mapWithConcurrency(questionResults, 4, async (result) => {
            const currentQuestion = await fetchQuestionById(result.questionId);
            const baseQuestion =
                currentQuestion ||
                orderedQuestions.find((item) => item.question.question_id === result.questionId)?.question;

            if (!baseQuestion) {
                throw new Error(`Question not found for verification update: ${result.questionId}`);
            }

            const existingAiMetadata = getExistingAiMetadata(baseQuestion.raw_data);
            const newVerification: AiVerificationEntry = {
                index: existingAiMetadata.verifications.length + 1,
                provider,
                modelId: body.modelId,
                modelLabel: body.modelLabel?.trim() || body.modelId,
                answerKeyVerified: result.answerKeyVerified,
                aiAnswer: result.aiAnswer,
                aiAnswerExplanation: result.aiAnswerExplanation,
                aiSolution: result.aiSolution,
                aiSuggestion: result.aiSuggestion,
                questionLanguageQuality: result.questionLanguageQuality,
                solutionLanguageQuality: result.solutionLanguageQuality,
                overallVerdict: result.overallVerdict,
                verifiedAt: result.verifiedAt,
            };

            const mergedAiMetadata: AiMetadata = {
                verifications: [...existingAiMetadata.verifications, newVerification],
                translations: existingAiMetadata.translations,
            };

            return updateQuestionById(result.questionId, {
                raw_data: mergeAiMetadataIntoRawData(baseQuestion.raw_data, mergedAiMetadata),
            });
        });

        const subjectQuestionCounts: Record<string, number> = {};
        const chapterQuestionCounts: Record<string, number> = {};
        questionResults.forEach((result) => {
            incrementCount(subjectQuestionCounts, result.subject);
            incrementCount(chapterQuestionCounts, result.chapter);
        });

        const wrongQuestionsFallback: TestAiVerificationWrongQuestion[] = questionResults
            .filter(
                (result) =>
                    !result.answerKeyVerified ||
                    result.outOfSyllabus ||
                    result.structuralIssues.length > 0 ||
                    /incorrect|review/i.test(result.overallVerdict)
            )
            .map((result) => ({
                questionId: result.questionId,
                displayNumber: result.displayNumber,
                summary:
                    result.structuralIssues[0] ||
                    result.overallVerdict ||
                    "This question needs review.",
                suggestion: stripHtml(result.aiSuggestion, 240) || "Review the question and answer key.",
            }));

        let overallSummary =
            "AI verification completed for the full paper. Review flagged questions and section-level pattern mismatches before sharing the test.";
        let paperStructureAssessment =
            "Paper structure was checked against the configured question distribution.";
        let syllabusBalanceAssessment =
            "Syllabus balance was reviewed using the selected chapters/topics and the current subject/chapter mix.";
        let topRecommendations = wrongQuestionsFallback.length
            ? wrongQuestionsFallback.slice(0, 5).map((item) => item.suggestion)
            : ["No major issues were flagged by the AI verification run."];
        let wrongQuestions = wrongQuestionsFallback;

        try {
            const reportRawResponse = await callStructuredAiModel(
                provider,
                body.modelId,
                apiKey,
                buildOverallReportPrompt({
                    examPreset: body.examPreset,
                    patternChecks,
                    subjectQuestionCounts,
                    chapterQuestionCounts,
                    questionResults,
                })
            );
            const parsedReport = parseStructuredAiResponse(reportRawResponse);
            overallSummary = String(parsedReport.overallSummary || overallSummary);
            paperStructureAssessment = String(
                parsedReport.paperStructureAssessment || paperStructureAssessment
            );
            syllabusBalanceAssessment = String(
                parsedReport.syllabusBalanceAssessment || syllabusBalanceAssessment
            );
            topRecommendations = Array.isArray(parsedReport.topRecommendations)
                ? parsedReport.topRecommendations.map((item) => String(item)).filter(Boolean)
                : topRecommendations;
            wrongQuestions = Array.isArray(parsedReport.wrongQuestions)
                ? (parsedReport.wrongQuestions as Array<Record<string, unknown>>)
                      .map((item) => {
                          const displayNumber = Number(item.displayNumber);
                          const matchedQuestion = questionResults.find(
                              (result) => result.displayNumber === displayNumber
                          );
                          if (!matchedQuestion) return null;
                          return {
                              questionId: matchedQuestion.questionId,
                              displayNumber,
                              summary: String(item.summary || matchedQuestion.overallVerdict || ""),
                              suggestion: String(item.suggestion || matchedQuestion.aiSuggestion || ""),
                          } satisfies TestAiVerificationWrongQuestion;
                      })
                      .filter(
                          (
                              item
                          ): item is TestAiVerificationWrongQuestion => item !== null
                      )
                : wrongQuestionsFallback;
        } catch (reportError) {
            console.warn("Full paper AI report generation failed, using deterministic fallback.", reportError);
        }

        const report: TestAiVerificationReport = {
            provider,
            modelId: body.modelId,
            modelLabel: body.modelLabel?.trim() || body.modelId,
            verifiedAt: new Date().toISOString(),
            examPreset: body.examPreset,
            totalQuestions: questionResults.length,
            aiVerifiedCount: questionResults.filter((result) => result.answerKeyVerified).length,
            incorrectAnswerKeyCount: questionResults.filter((result) => !result.answerKeyVerified).length,
            needsReviewCount: wrongQuestions.length,
            outOfSyllabusCount: questionResults.filter((result) => result.outOfSyllabus).length,
            patternChecks,
            subjectQuestionCounts,
            chapterQuestionCounts,
            overallSummary,
            paperStructureAssessment,
            syllabusBalanceAssessment,
            topRecommendations,
            wrongQuestions,
            questions: questionResults,
        };

        await saveAiVerificationReportForTests(body.testIds, report);

        return NextResponse.json({
            success: true,
            report,
            updatedQuestions,
        });
    } catch (error) {
        console.error("POST /api/tests/verify failed:", error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
