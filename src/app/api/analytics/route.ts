import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_MAX_ROWS, TABLE_NAME } from "@/lib/constants";
import { checkPermission } from "@/lib/auth/serverAuth";

const TESTS_TABLE = "qbg_generated_tests";
const TEST_QUESTIONS_TABLE = "qbg_generated_test_questions";
const FINALIZED_STATUS = "FINALIZED";

type QuestionAnalyticsRow = {
    question_id: string;
    subject: string | null;
    chapter: string | null;
    topic: string | null;
    source: string | null;
    difficutly_level: string | null;
    question_type: string | null;
    solution_text: string | null;
    exam: string[] | null;
    class_level: string | null;
    subtopic: string | null;
    raw_data: unknown;
};

type GeneratedTestRow = {
    id: string;
    batch_name: string | null;
    exam_preset: string | null;
    created_at: string | null;
    total_questions: number | null;
};

type GeneratedTestQuestionRow = {
    generated_test_id: string;
    question_id: string;
};

type RecentTestItem = {
    id: string;
    batchName: string;
    examPreset: string;
    createdAt: string;
    totalQuestions: number;
};

function getSupabase() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

function asErrorMessage(error: unknown): string {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (typeof error === "object" && error && "message" in error) {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" ? message : "Unknown error";
    }
    return "Unknown error";
}

function isMissingTableError(error: unknown): boolean {
    const code =
        typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code || "")
            : "";
    const message = asErrorMessage(error).toLowerCase();
    return (
        code === "42P01" ||
        message.includes("does not exist") ||
        message.includes("relation") ||
        message.includes("could not find the table")
    );
}

async function fetchAllQuestionRows(): Promise<QuestionAnalyticsRow[]> {
    const supabase = getSupabase();
    const rows: QuestionAnalyticsRow[] = [];
    let page = 0;

    while (true) {
        const from = page * SUPABASE_MAX_ROWS;
        const to = from + SUPABASE_MAX_ROWS - 1;
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .select(
                "question_id, subject, chapter, topic, source, difficutly_level, question_type, solution_text, exam, class_level, subtopic"
            )
            .range(from, to)
            .order("question_id");

        if (error) {
            throw new Error(`Failed to load questions for analytics: ${error.message}`);
        }

        const batch = (data as QuestionAnalyticsRow[] | null) || [];
        if (!batch.length) break;
        rows.push(...batch);
        if (batch.length < SUPABASE_MAX_ROWS) break;
        page += 1;
    }

    return rows;
}

async function fetchFinalizedTests(): Promise<{
    tests: GeneratedTestRow[];
    mappings: GeneratedTestQuestionRow[];
    historyAvailable: boolean;
}> {
    const supabase = getSupabase();
    const tests: GeneratedTestRow[] = [];
    let page = 0;

    while (true) {
        const from = page * SUPABASE_MAX_ROWS;
        const to = from + SUPABASE_MAX_ROWS - 1;
        const { data, error } = await supabase
            .from(TESTS_TABLE)
            .select("id, batch_name, exam_preset, created_at, total_questions, status")
            .eq("status", FINALIZED_STATUS)
            .range(from, to)
            .order("created_at", { ascending: false });

        if (error) {
            if (isMissingTableError(error)) {
                return { tests: [], mappings: [], historyAvailable: false };
            }
            throw new Error(`Failed to load tests for analytics: ${error.message}`);
        }

        const batch = ((data as Array<GeneratedTestRow & { status?: string }> | null) || []).map(
            ({ status: _status, ...rest }) => rest
        );
        if (!batch.length) break;
        tests.push(...batch);
        if (batch.length < SUPABASE_MAX_ROWS) break;
        page += 1;
    }

    const mappings: GeneratedTestQuestionRow[] = [];
    let mappingPage = 0;
    while (true) {
        const from = mappingPage * SUPABASE_MAX_ROWS;
        const to = from + SUPABASE_MAX_ROWS - 1;
        const { data, error } = await supabase
            .from(TEST_QUESTIONS_TABLE)
            .select("generated_test_id, question_id")
            .range(from, to)
            .order("generated_test_id");

        if (error) {
            if (isMissingTableError(error)) {
                return { tests, mappings: [], historyAvailable: false };
            }
            throw new Error(`Failed to load test-question mappings for analytics: ${error.message}`);
        }

        const batch = (data as GeneratedTestQuestionRow[] | null) || [];
        if (!batch.length) break;
        mappings.push(...batch);
        if (batch.length < SUPABASE_MAX_ROWS) break;
        mappingPage += 1;
    }

    return { tests, mappings, historyAvailable: true };
}

function incrementCount(map: Record<string, number>, key: string | null | undefined) {
    const normalized = String(key || "").trim() || "Unknown";
    map[normalized] = (map[normalized] || 0) + 1;
}

function mapToSortedEntries(map: Record<string, number>) {
    return Object.entries(map)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getAiVerified(rawData: unknown): boolean {
    const first =
        Array.isArray(rawData) && rawData.length > 0
            ? rawData[0]
            : rawData && typeof rawData === "object" && !Array.isArray(rawData)
              ? rawData
              : null;
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;

    const record = first as Record<string, unknown>;
    const aiMeta = record.ai_metadata;
    if (
        aiMeta &&
        typeof aiMeta === "object" &&
        !Array.isArray(aiMeta) &&
        Array.isArray((aiMeta as { verifications?: unknown[] }).verifications)
    ) {
        return ((aiMeta as { verifications?: Array<{ answerKeyVerified?: boolean }> }).verifications || []).some(
            (item) => item?.answerKeyVerified === true
        );
    }

    return record.verification_status === 1;
}

function getHasVideoSolution(rawData: unknown): boolean {
    const first =
        Array.isArray(rawData) && rawData.length > 0
            ? rawData[0]
            : rawData && typeof rawData === "object" && !Array.isArray(rawData)
              ? rawData
              : null;
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;

    const solutions = (first as Record<string, unknown>).solutions;
    if (!Array.isArray(solutions)) return false;
    return solutions.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const english = (entry as Record<string, unknown>).english;
        if (!english || typeof english !== "object" || Array.isArray(english)) return false;
        const video = (english as Record<string, unknown>).videoSolution;
        if (!video || typeof video !== "object" || Array.isArray(video)) return false;
        return String((video as Record<string, unknown>).url || "").trim().length > 0;
    });
}

function calculateInsights(args: {
    totalQuestions: number;
    subjectDistribution: Array<{ label: string; count: number }>;
    quality: {
        solutionCoverage: number;
        aiVerifiedCoverage: number;
        metadataCompleteness: number;
        usageCoverage: number;
    };
    topChapter?: { label: string; count: number };
    historyAvailable: boolean;
    totalTests: number;
    recentTests: RecentTestItem[];
}) {
    const insights: string[] = [];
    const leader = args.subjectDistribution[0];
    if (leader && args.totalQuestions > 0) {
        const share = Math.round((leader.count / args.totalQuestions) * 100);
        insights.push(
            `${leader.label} currently leads the bank with ${leader.count} questions (${share}% of the total collection).`
        );
    }

    if (args.quality.metadataCompleteness < 85) {
        insights.push(
            `Metadata completeness is ${args.quality.metadataCompleteness}%, so improving missing exam, class level, or subtopic tags would make filtering and analytics stronger.`
        );
    } else {
        insights.push(
            `Metadata completeness is healthy at ${args.quality.metadataCompleteness}%, which means the bank is well-structured for search, test generation, and drill-down analysis.`
        );
    }

    if (args.quality.solutionCoverage < 75) {
        insights.push(
            `Solution coverage is only ${args.quality.solutionCoverage}%, so adding explanations would noticeably improve revision value and verification confidence.`
        );
    }

    if (args.quality.aiVerifiedCoverage < 35) {
        insights.push(
            `Only ${args.quality.aiVerifiedCoverage}% of questions are AI verified right now, so running verification on high-usage chapters would be a strong next step.`
        );
    }

    if (args.historyAvailable) {
        if (args.totalTests === 0) {
            insights.push("No finalized test history is available yet, so utilization analytics will become more useful after a few test cycles.");
        } else {
            insights.push(
                `${args.quality.usageCoverage}% of the bank has already appeared in finalized tests, giving a clear signal on which content is active versus untouched.`
            );
        }
    } else {
        insights.push("Test history tables are not available yet, so usage intelligence is limited to question-bank metadata only.");
    }

    if (args.topChapter) {
        insights.push(
            `${args.topChapter.label} is the heaviest chapter in the bank with ${args.topChapter.count} questions, making it a good candidate for balancing reviews.`
        );
    }

    if (args.recentTests.length > 0) {
        insights.push(
            `Recent activity shows ${args.recentTests.length} finalized papers in the latest snapshot, which can help track which batches and exam presets are being used most.`
        );
    }

    return insights.slice(0, 6);
}

export async function GET() {
    const forbid = await checkPermission("view_analytics");
    if (forbid) return forbid;
    try {
        const [questions, history] = await Promise.all([
            fetchAllQuestionRows(),
            fetchFinalizedTests(),
        ]);

        const subjectCounts: Record<string, number> = {};
        const difficultyCounts: Record<string, number> = {};
        const typeCounts: Record<string, number> = {};
        const sourceCounts: Record<string, number> = {};
        const examCounts: Record<string, number> = {};
        const classCounts: Record<string, number> = {};
        const chapterCounts: Record<string, number> = {};
        const topicCounts: Record<string, number> = {};

        const fieldCompleteness = {
            exam: 0,
            classLevel: 0,
            subtopic: 0,
            solution: 0,
            aiVerified: 0,
            videoSolution: 0,
        };

        const subjectDifficultyMatrix: Record<string, Record<string, number>> = {};
        const subjectTypeMatrix: Record<string, Record<string, number>> = {};
        const chaptersBySubject: Record<string, Record<string, number>> = {};

        const questionById = new Map<string, QuestionAnalyticsRow>();

        questions.forEach((question) => {
            questionById.set(question.question_id, question);

            const subject = String(question.subject || "").trim() || "Unknown";
            const difficulty = String(question.difficutly_level || "").trim() || "Unknown";
            const type = String(question.question_type || "").trim() || "Unknown";
            const chapter = String(question.chapter || "").trim() || "Unknown";

            incrementCount(subjectCounts, question.subject);
            incrementCount(difficultyCounts, question.difficutly_level);
            incrementCount(typeCounts, question.question_type);
            incrementCount(sourceCounts, question.source);
            incrementCount(chapterCounts, question.chapter);
            incrementCount(topicCounts, question.topic);

            (question.exam || []).forEach((exam) => incrementCount(examCounts, exam));
            incrementCount(classCounts, question.class_level);

            if (!subjectDifficultyMatrix[subject]) subjectDifficultyMatrix[subject] = {};
            subjectDifficultyMatrix[subject][difficulty] =
                (subjectDifficultyMatrix[subject][difficulty] || 0) + 1;

            if (!subjectTypeMatrix[subject]) subjectTypeMatrix[subject] = {};
            subjectTypeMatrix[subject][type] = (subjectTypeMatrix[subject][type] || 0) + 1;

            if (!chaptersBySubject[subject]) chaptersBySubject[subject] = {};
            chaptersBySubject[subject][chapter] = (chaptersBySubject[subject][chapter] || 0) + 1;

            if (Array.isArray(question.exam) && question.exam.length > 0) {
                fieldCompleteness.exam += 1;
            }
            if (String(question.class_level || "").trim()) {
                fieldCompleteness.classLevel += 1;
            }
            if (String(question.subtopic || "").trim()) {
                fieldCompleteness.subtopic += 1;
            }
            if (String(question.solution_text || "").trim()) {
                fieldCompleteness.solution += 1;
            }
            if (getAiVerified(question.raw_data)) {
                fieldCompleteness.aiVerified += 1;
            }
            if (getHasVideoSolution(question.raw_data)) {
                fieldCompleteness.videoSolution += 1;
            }
        });

        const usageCountByQuestionId: Record<string, number> = {};
        const usedQuestionIds = new Set<string>();

        history.mappings.forEach((mapping) => {
            if (!mapping.question_id) return;
            usedQuestionIds.add(mapping.question_id);
            usageCountByQuestionId[mapping.question_id] =
                (usageCountByQuestionId[mapping.question_id] || 0) + 1;
        });

        const totalQuestions = questions.length;
        const totalTests = history.tests.length;
        const uniqueBatches = new Set(
            history.tests.map((test) => String(test.batch_name || "").trim()).filter(Boolean)
        );
        const avgQuestionsPerTest =
            totalTests > 0
                ? Math.round(
                      history.tests.reduce((sum, test) => sum + Number(test.total_questions || 0), 0) /
                          totalTests
                  )
                : 0;

        const topUsedQuestions = Object.entries(usageCountByQuestionId)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([questionId, usageCount]) => {
                const question = questionById.get(questionId);
                return {
                    questionId,
                    usageCount,
                    subject: question?.subject || "Unknown",
                    chapter: question?.chapter || "Unknown",
                    questionType: question?.question_type || "Unknown",
                    summary: question ? String(question.topic || question.chapter || question.question_type) : "Question",
                };
            });

        const recentTests: RecentTestItem[] = history.tests
            .slice(0, 8)
            .map((test) => ({
                id: test.id,
                batchName: String(test.batch_name || "Unnamed Batch"),
                examPreset: String(test.exam_preset || "Unknown"),
                createdAt: String(test.created_at || ""),
                totalQuestions: Number(test.total_questions || 0),
            }));

        const metadataHealth = [
            {
                label: "Exam Tags",
                complete: fieldCompleteness.exam,
                missing: totalQuestions - fieldCompleteness.exam,
            },
            {
                label: "Class Levels",
                complete: fieldCompleteness.classLevel,
                missing: totalQuestions - fieldCompleteness.classLevel,
            },
            {
                label: "Subtopics",
                complete: fieldCompleteness.subtopic,
                missing: totalQuestions - fieldCompleteness.subtopic,
            },
            {
                label: "Solutions",
                complete: fieldCompleteness.solution,
                missing: totalQuestions - fieldCompleteness.solution,
            },
            {
                label: "AI Verified",
                complete: fieldCompleteness.aiVerified,
                missing: totalQuestions - fieldCompleteness.aiVerified,
            },
            {
                label: "Video Solutions",
                complete: fieldCompleteness.videoSolution,
                missing: totalQuestions - fieldCompleteness.videoSolution,
            },
        ].map((item) => ({
            ...item,
            percent: totalQuestions > 0 ? Math.round((item.complete / totalQuestions) * 100) : 0,
        }));

        const subjectSummaries = mapToSortedEntries(subjectCounts).map((entry) => {
            const chapterMap = chaptersBySubject[entry.label] || {};
            const chapterEntries = mapToSortedEntries(chapterMap);
            const subjectTypes = mapToSortedEntries(subjectTypeMatrix[entry.label] || {}).slice(0, 4);
            const subjectDifficulties = difficultyCounts
                ? Object.entries(subjectDifficultyMatrix[entry.label] || {}).map(([label, count]) => ({
                      label,
                      count,
                  }))
                : [];

            return {
                subject: entry.label,
                questionCount: entry.count,
                chapterCount: Object.keys(chapterMap).length,
                topChapters: chapterEntries.slice(0, 5),
                typeBreakdown: subjectTypes,
                difficultyBreakdown: subjectDifficulties.sort((a, b) => b.count - a.count),
            };
        });

        const topChapters = mapToSortedEntries(chapterCounts).slice(0, 12);
        const topTopics = mapToSortedEntries(topicCounts).slice(0, 10);

        const subjectDistribution = mapToSortedEntries(subjectCounts);
        const difficultyDistribution = mapToSortedEntries(difficultyCounts);
        const questionTypeDistribution = mapToSortedEntries(typeCounts);
        const sourceDistribution = mapToSortedEntries(sourceCounts);
        const examDistribution = mapToSortedEntries(examCounts);
        const classDistribution = mapToSortedEntries(classCounts).filter(
            (item) => item.label !== "Unknown"
        );

        const qualitySnapshot = {
            solutionCoverage:
                totalQuestions > 0 ? Math.round((fieldCompleteness.solution / totalQuestions) * 100) : 0,
            aiVerifiedCoverage:
                totalQuestions > 0 ? Math.round((fieldCompleteness.aiVerified / totalQuestions) * 100) : 0,
            metadataCompleteness:
                totalQuestions > 0
                    ? Math.round(
                          ((fieldCompleteness.exam +
                              fieldCompleteness.classLevel +
                              fieldCompleteness.subtopic) /
                              (totalQuestions * 3)) *
                              100
                      )
                    : 0,
            usageCoverage:
                totalQuestions > 0 ? Math.round((usedQuestionIds.size / totalQuestions) * 100) : 0,
        };

        const insights = calculateInsights({
            totalQuestions,
            subjectDistribution,
            quality: qualitySnapshot,
            topChapter: topChapters[0],
            historyAvailable: history.historyAvailable,
            totalTests,
            recentTests,
        });

        return NextResponse.json({
            success: true,
            generatedAt: new Date().toISOString(),
            overview: {
                totalQuestions,
                totalSubjects: Object.keys(subjectCounts).filter((key) => key !== "Unknown").length,
                totalChapters: Object.keys(chapterCounts).filter((key) => key !== "Unknown").length,
                totalTopics: Object.keys(topicCounts).filter((key) => key !== "Unknown").length,
                totalSources: Object.keys(sourceCounts).filter((key) => key !== "Unknown").length,
                finalizedTests: totalTests,
                activeBatches: uniqueBatches.size,
                avgQuestionsPerTest,
            },
            quality: {
                ...qualitySnapshot,
                usedQuestions: usedQuestionIds.size,
                unusedQuestions: Math.max(0, totalQuestions - usedQuestionIds.size),
            },
            distributions: {
                subjects: subjectDistribution,
                difficulties: difficultyDistribution,
                questionTypes: questionTypeDistribution,
                sources: sourceDistribution,
                exams: examDistribution,
                classes: classDistribution,
            },
            metadataHealth,
            subjectSummaries,
            topChapters,
            topTopics,
            matrices: {
                subjectDifficulty: subjectDifficultyMatrix,
                subjectQuestionType: subjectTypeMatrix,
            },
            usage: {
                historyAvailable: history.historyAvailable,
                recentTests,
                topUsedQuestions,
            },
            insights,
        });
    } catch (error) {
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
