import { createClient } from "@supabase/supabase-js";
import { TABLE_NAME } from "@/lib/constants";
import type {
    BatchOption,
    ExamPreset,
    FinalizedQuestionUsage,
    GeneratedTest,
    JeeAdvancedPaper,
    Question,
    TestAiVerificationReport,
    TestGenerationConfig,
    TestHistoryDetail,
    TestHistorySummary,
} from "@/types";
import { getQuestionTypeLabel } from "@/types";
import { fetchDefaultTranslations } from "@/lib/api/translations";

const BATCHES_TABLE = "qbg_batches";
const TESTS_TABLE = "qbg_generated_tests";
const TEST_QUESTIONS_TABLE = "qbg_generated_test_questions";
const FINALIZED_STATUS = "FINALIZED";

let supabaseInstance: ReturnType<typeof createClient> | null = null;

interface BatchRow {
    id: string | number;
    name: string;
    created_at?: string;
}

interface GeneratedTestRow {
    id: string;
    batch_id?: string | number | null;
    batch_name: string;
    test_number: number;
    exam_preset: ExamPreset;
    test_date?: string | null;
    test_name?: string | null;
    language?: string | null;
    created_at: string;
    total_questions?: number | null;
    status: string;
    output_config?: Record<string, unknown> | null;
    generation_config?: Partial<TestGenerationConfig> | null;
}

interface GeneratedTestQuestionRow {
    generated_test_id: string;
    question_id: string;
    question_order?: number | null;
    paper?: string | null;
    subject?: string | null;
    question_type?: string | null;
}

interface FinalizeGeneratedTestsInput {
    batchNames: string[];
    examPreset: ExamPreset;
    testDate?: string;
    testName?: string;
    /** Lower-cased language identifier (e.g. "english", "hindi"). */
    language?: string;
    outputConfig?: Record<string, unknown>;
    generationConfig?: Partial<TestGenerationConfig>;
    tests: GeneratedTest[];
}

interface FinalizeGeneratedTestsResult {
    savedTestIds: string[];
    warnings: string[];
}

interface BatchQuestionUsageResult {
    usedQuestionIds: Set<string>;
    usageByQuestionId: Record<string, FinalizedQuestionUsage[]>;
    historyAvailable: boolean;
}

function getSupabase(): any {
    if (!supabaseInstance) {
        supabaseInstance = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
    }
    return supabaseInstance;
}

function asErrorMessage(error: unknown): string {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (typeof error === "object" && error && "message" in error) {
        const msg = (error as { message?: unknown }).message;
        return typeof msg === "string" ? msg : "Unknown error";
    }
    return "Unknown error";
}

function isMissingTableError(error: unknown): boolean {
    const msg = asErrorMessage(error).toLowerCase();
    const code =
        typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code || "")
            : "";
    return (
        code === "42P01" ||
        msg.includes("does not exist") ||
        msg.includes("relation") ||
        msg.includes("could not find the table")
    );
}

function isHistoryTablesUnavailableError(error: unknown): boolean {
    return (
        isMissingTableError(error) ||
        asErrorMessage(error)
            .toLowerCase()
            .includes("history tables are missing")
    );
}

function chunk<T>(items: T[], size: number): T[][];
function chunk<T>(items: T[], size: number): T[][] {
    if (size <= 0) return [items];
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
}

function normalizeBatchName(name: string): string {
    return name.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function extractAiVerificationReport(
    outputConfig: unknown
): TestAiVerificationReport | null {
    const output = asRecord(outputConfig);
    if (!output) return null;
    const report = output.aiVerificationReport;
    return asRecord(report) ? (report as TestAiVerificationReport) : null;
}

async function getOrCreateBatch(name: string): Promise<BatchRow> {
    const supabase = getSupabase();
    const normalized = normalizeBatchName(name);
    if (!normalized) {
        throw new Error("Batch name is required");
    }

    const { data: existing, error: fetchError } = await supabase
        .from(BATCHES_TABLE)
        .select("id, name, created_at")
        .eq("name", normalized)
        .limit(1);
    if (fetchError) {
        if (isMissingTableError(fetchError)) {
            throw new Error(
                "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
            );
        }
        throw new Error(`Failed to fetch batch: ${fetchError.message}`);
    }
    const existingBatch = (existing as BatchRow[] | null)?.[0];
    if (existingBatch) return existingBatch;

    const { data: inserted, error: insertError } = await supabase
        .from(BATCHES_TABLE)
        .insert({ name: normalized })
        .select("id, name, created_at")
        .single();
    if (insertError) {
        if (isMissingTableError(insertError)) {
            throw new Error(
                "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
            );
        }
        throw new Error(`Failed to create batch: ${insertError.message}`);
    }
    return inserted as BatchRow;
}

export async function listBatchOptions(): Promise<BatchOption[]> {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(BATCHES_TABLE)
        .select("id, name, created_at")
        .order("name", { ascending: true });
    if (error) {
        if (isMissingTableError(error)) return [];
        throw new Error(`Failed to list batches: ${error.message}`);
    }

    return ((data as BatchRow[] | null) || []).map((row) => ({
        id: String(row.id),
        name: row.name,
        createdAt: row.created_at,
    }));
}

export async function createBatchOption(name: string): Promise<BatchOption> {
    const row = await getOrCreateBatch(name);
    return {
        id: String(row.id),
        name: row.name,
        createdAt: row.created_at,
    };
}

export async function deleteBatchOption(name: string): Promise<void> {
    const normalized = normalizeBatchName(name);
    if (!normalized) return;
    const supabase = getSupabase();
    const { error } = await supabase.from(BATCHES_TABLE).delete().eq("name", normalized);
    if (error) {
        if (isMissingTableError(error)) return;
        throw new Error(`Failed to delete batch: ${error.message}`);
    }
}

export async function deleteFinalizedTestHistory(testId: string): Promise<void> {
    const id = testId.trim();
    if (!id) {
        throw new Error("Test ID is required.");
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(TESTS_TABLE)
        .delete()
        .eq("id", id)
        .eq("status", FINALIZED_STATUS)
        .select("id")
        .maybeSingle();

    if (error) {
        if (isMissingTableError(error)) {
            throw new Error(
                "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
            );
        }
        throw new Error(`Failed to delete saved test: ${error.message}`);
    }

    if (!data) {
        throw new Error("Saved test not found.");
    }
}

export async function getQuestionUsageMap(
    questionIds: string[]
): Promise<Record<string, FinalizedQuestionUsage[]>> {
    const uniqueQuestionIds = Array.from(
        new Set(questionIds.map((id) => id.trim()).filter(Boolean))
    );
    if (!uniqueQuestionIds.length) return {};

    const supabase = getSupabase();
    const mappingRows: GeneratedTestQuestionRow[] = [];
    for (const ids of chunk(uniqueQuestionIds, 500)) {
        const { data, error } = await supabase
            .from(TEST_QUESTIONS_TABLE)
            .select("generated_test_id, question_id")
            .in("question_id", ids);
        if (error) {
            if (isMissingTableError(error)) return {};
            throw new Error(`Failed to load question usage mapping: ${error.message}`);
        }
        mappingRows.push(...(((data as GeneratedTestQuestionRow[] | null) || [])));
    }
    if (!mappingRows.length) return {};

    const testIds = Array.from(
        new Set(mappingRows.map((row) => row.generated_test_id).filter(Boolean))
    );
    const testsById = new Map<string, GeneratedTestRow>();
    for (const ids of chunk(testIds, 500)) {
        const { data, error } = await supabase
            .from(TESTS_TABLE)
            .select("id, batch_name, test_number, exam_preset, test_date, created_at, status")
            .in("id", ids)
            .eq("status", FINALIZED_STATUS);
        if (error) {
            if (isMissingTableError(error)) return {};
            throw new Error(`Failed to load question usage tests: ${error.message}`);
        }
        (((data as GeneratedTestRow[] | null) || [])).forEach((row) =>
            testsById.set(row.id, row)
        );
    }

    const result: Record<string, FinalizedQuestionUsage[]> = {};
    mappingRows.forEach((row) => {
        const test = testsById.get(row.generated_test_id);
        if (!test) return;
        if (!result[row.question_id]) result[row.question_id] = [];
        result[row.question_id].push({
            testId: test.id,
            batchName: test.batch_name,
            testNumber: test.test_number,
            examPreset: test.exam_preset,
            testDate: test.test_date || undefined,
            createdAt: test.created_at,
        });
    });

    Object.values(result).forEach((items) =>
        items.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
    );

    return result;
}

export async function getBatchQuestionUsage(
    batchName: string
): Promise<BatchQuestionUsageResult> {
    const normalizedBatch = normalizeBatchName(batchName);
    if (!normalizedBatch) {
        return {
            usedQuestionIds: new Set<string>(),
            usageByQuestionId: {},
            historyAvailable: true,
        };
    }

    const supabase = getSupabase();
    const { data: testsData, error: testsError } = await supabase
        .from(TESTS_TABLE)
        .select("id, batch_name, test_number, exam_preset, test_date, created_at, status")
        .eq("batch_name", normalizedBatch)
        .eq("status", FINALIZED_STATUS);
    if (testsError) {
        if (isMissingTableError(testsError)) {
            return {
                usedQuestionIds: new Set<string>(),
                usageByQuestionId: {},
                historyAvailable: false,
            };
        }
        throw new Error(`Failed to load batch history tests: ${testsError.message}`);
    }

    const tests = ((testsData as GeneratedTestRow[] | null) || []).filter(Boolean);
    if (!tests.length) {
        return {
            usedQuestionIds: new Set<string>(),
            usageByQuestionId: {},
            historyAvailable: true,
        };
    }

    const testIds = tests.map((test) => test.id);
    const mappingRows: GeneratedTestQuestionRow[] = [];
    for (const ids of chunk(testIds, 500)) {
        const { data, error } = await supabase
            .from(TEST_QUESTIONS_TABLE)
            .select("generated_test_id, question_id")
            .in("generated_test_id", ids);
        if (error) {
            if (isMissingTableError(error)) {
                return {
                    usedQuestionIds: new Set<string>(),
                    usageByQuestionId: {},
                    historyAvailable: false,
                };
            }
            throw new Error(`Failed to load batch question usage: ${error.message}`);
        }
        mappingRows.push(...(((data as GeneratedTestQuestionRow[] | null) || [])));
    }

    const testsById = new Map(tests.map((test) => [test.id, test]));
    const usageByQuestionId: Record<string, FinalizedQuestionUsage[]> = {};
    const usedQuestionIds = new Set<string>();

    mappingRows.forEach((row) => {
        const test = testsById.get(row.generated_test_id);
        if (!test) return;
        usedQuestionIds.add(row.question_id);
        if (!usageByQuestionId[row.question_id]) usageByQuestionId[row.question_id] = [];
        usageByQuestionId[row.question_id].push({
            testId: test.id,
            batchName: test.batch_name,
            testNumber: test.test_number,
            examPreset: test.exam_preset,
            testDate: test.test_date || undefined,
            createdAt: test.created_at,
        });
    });

    Object.values(usageByQuestionId).forEach((items) =>
        items.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
    );

    return { usedQuestionIds, usageByQuestionId, historyAvailable: true };
}

export async function finalizeGeneratedTests(
    input: FinalizeGeneratedTestsInput
): Promise<FinalizeGeneratedTestsResult> {
    const batchNames = Array.from(
        new Set(input.batchNames.map(normalizeBatchName).filter(Boolean))
    );
    if (!batchNames.length) {
        throw new Error("At least one batch is required to finalise tests.");
    }
    if (!input.tests.length) {
        throw new Error("No tests to finalise.");
    }

    const supabase = getSupabase();
    const savedTestIds: string[] = [];
    const warnings: string[] = [];
    try {
        for (const batchName of batchNames) {
            const batch = await getOrCreateBatch(batchName);
            for (const test of input.tests) {
                const { data: insertedTest, error: insertTestError } = await supabase
                    .from(TESTS_TABLE)
                    .insert({
                        batch_id: batch.id,
                        batch_name: batchName,
                        test_number: test.testNumber,
                        exam_preset: input.examPreset,
                        test_date: input.testDate || null,
                        test_name: input.testName || null,
                        language: (input.language || "english").toLowerCase(),
                        total_questions: test.totalQuestions,
                        status: FINALIZED_STATUS,
                        output_config: input.outputConfig || null,
                        generation_config: input.generationConfig || null,
                    })
                    .select("id")
                    .single();
                if (insertTestError) {
                    if (isMissingTableError(insertTestError)) {
                        throw new Error(
                            "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
                        );
                    }
                    throw new Error(`Failed to save finalised test: ${insertTestError.message}`);
                }

                const generatedTestId = String((insertedTest as { id: string }).id);
                savedTestIds.push(generatedTestId);

                const questionRows: Array<{
                    generated_test_id: string;
                    question_id: string;
                    question_order: number;
                    paper: string | null;
                    subject: string;
                    question_type: string;
                }> = [];
                let questionOrder = 1;

                test.sections.forEach((section) => {
                    section.questionTypes.forEach((group) => {
                        group.questions.forEach((question) => {
                            questionRows.push({
                                generated_test_id: generatedTestId,
                                question_id: question.question_id,
                                question_order: questionOrder,
                                paper: section.paper || null,
                                subject: section.subject,
                                question_type: group.type,
                            });
                            questionOrder += 1;
                        });
                    });
                });

                if (!questionRows.length) {
                    warnings.push(
                        `Skipped saving question rows for test ${test.testNumber} in batch ${batchName} because no questions were selected.`
                    );
                    continue;
                }

                const { error: insertQuestionsError } = await supabase
                    .from(TEST_QUESTIONS_TABLE)
                    .insert(questionRows);
                if (insertQuestionsError) {
                    if (isMissingTableError(insertQuestionsError)) {
                        throw new Error(
                            "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
                        );
                    }
                    throw new Error(
                        `Failed to save finalised test questions: ${insertQuestionsError.message}`
                    );
                }
            }
        }
    } catch (error) {
        if (isHistoryTablesUnavailableError(error)) {
            warnings.push(
                "History tables are missing, so this final test was not saved to history. Run scripts/sql/create_test_history_tables.sql in Supabase to enable saving."
            );
            return { savedTestIds, warnings };
        }
        throw error;
    }

    return { savedTestIds, warnings };
}

export async function listFinalizedTestsHistory(params?: {
    batchName?: string;
    limit?: number;
}): Promise<TestHistorySummary[]> {
    const supabase = getSupabase();
    const limit = Math.max(1, Math.min(params?.limit || 100, 500));

    let query = supabase
        .from(TESTS_TABLE)
        .select(
            "id, batch_name, test_number, exam_preset, test_date, test_name, language, created_at, total_questions, status"
        )
        .eq("status", FINALIZED_STATUS)
        .order("created_at", { ascending: false })
        .limit(limit);

    const batchName = params?.batchName?.trim();
    if (batchName) {
        query = query.eq("batch_name", batchName);
    }

    const { data, error } = await query;
    if (error) {
        if (isMissingTableError(error)) return [];
        throw new Error(`Failed to load finalised tests history: ${error.message}`);
    }

    const tests = ((data as GeneratedTestRow[] | null) || []).filter(Boolean);
    if (!tests.length) return [];

    const testIds = tests.map((test) => test.id);
    const mappingRows: GeneratedTestQuestionRow[] = [];
    for (const ids of chunk(testIds, 500)) {
        const { data: rows, error: mapError } = await supabase
            .from(TEST_QUESTIONS_TABLE)
            .select("generated_test_id, question_id")
            .in("generated_test_id", ids);
        if (mapError) {
            if (isMissingTableError(mapError)) return [];
            throw new Error(`Failed to load history question counts: ${mapError.message}`);
        }
        mappingRows.push(...(((rows as GeneratedTestQuestionRow[] | null) || [])));
    }

    const questionCountByTestId = mappingRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.generated_test_id] = (acc[row.generated_test_id] || 0) + 1;
        return acc;
    }, {});

    return tests.map((test) => ({
        id: test.id,
        batchName: test.batch_name,
        testNumber: test.test_number,
        examPreset: test.exam_preset,
        testDate: test.test_date || undefined,
        testName: test.test_name || undefined,
        language: (test.language || "english").toLowerCase(),
        createdAt: test.created_at,
        totalQuestions:
            questionCountByTestId[test.id] || Math.max(0, Number(test.total_questions || 0)),
    }));
}

export async function getFinalizedTestHistoryDetail(
    testId: string
): Promise<TestHistoryDetail | null> {
    const id = testId.trim();
    if (!id) return null;

    const supabase = getSupabase();
    const { data: testData, error: testError } = await supabase
        .from(TESTS_TABLE)
        .select(
            "id, batch_name, test_number, exam_preset, test_date, test_name, language, created_at, total_questions, status, output_config, generation_config"
        )
        .eq("id", id)
        .eq("status", FINALIZED_STATUS)
        .maybeSingle();
    if (testError) {
        if (isMissingTableError(testError)) return null;
        throw new Error(`Failed to load test history detail: ${testError.message}`);
    }
    if (!testData) return null;
    const test = testData as GeneratedTestRow;

    const { data: mappingData, error: mappingError } = await supabase
        .from(TEST_QUESTIONS_TABLE)
        .select("generated_test_id, question_id, question_order, paper, subject, question_type")
        .eq("generated_test_id", id)
        .order("question_order", { ascending: true });
    if (mappingError) {
        if (isMissingTableError(mappingError)) return null;
        throw new Error(`Failed to load history test questions: ${mappingError.message}`);
    }
    const mappings = ((mappingData as GeneratedTestQuestionRow[] | null) || []).filter(Boolean);
    const questionIds = mappings.map((row) => row.question_id).filter(Boolean);

    let questions: Question[] = [];
    if (questionIds.length) {
        const { data: questionRows, error: questionError } = await supabase
            .from(TABLE_NAME)
            .select("*")
            .in("question_id", questionIds);
        if (questionError) {
            throw new Error(`Failed to load history question content: ${questionError.message}`);
        }
        const byQuestionId = new Map(
            (((questionRows as Question[] | null) || [])).map((question) => [
                question.question_id,
                question,
            ])
        );
        questions = questionIds
            .map((questionId) => byQuestionId.get(questionId))
            .filter((question): question is Question => Boolean(question));
    }

    // If the test is in a non-English language, swap question_text / options /
    // solution_text with the default translation in that language.
    const testLanguage = (test.language || "english").toLowerCase();
    if (testLanguage && testLanguage !== "english" && questions.length > 0) {
        const translationsByQuestionId = await fetchDefaultTranslations(
            questions.map((q) => q.question_id),
            testLanguage
        );
        questions = questions.map((q) => {
            const t = translationsByQuestionId.get(q.question_id);
            if (!t) return q;
            return {
                ...q,
                question_text: t.question_text,
                options: Array.isArray(t.options) ? t.options : q.options,
                solution_text: t.solution_text ?? q.solution_text,
            };
        });
    }

    const questionsById = new Map(questions.map((question) => [question.question_id, question]));
    const questionItems = mappings
        .map((row, index) => {
            const question = questionsById.get(row.question_id);
            if (!question) return null;
            const questionType = row.question_type || question.question_type || "";
            return {
                question,
                questionOrder: Number(row.question_order || index + 1),
                paper: row.paper === "Paper 1" || row.paper === "Paper 2"
                    ? (row.paper as JeeAdvancedPaper)
                    : undefined,
                subject: row.subject || question.subject || "General",
                questionType,
                typeLabel: getQuestionTypeLabel(questionType),
            };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return {
        id: test.id,
        batchName: test.batch_name,
        testNumber: test.test_number,
        examPreset: test.exam_preset,
        testDate: test.test_date || undefined,
        testName: test.test_name || undefined,
        language: testLanguage,
        createdAt: test.created_at,
        totalQuestions: questionIds.length || Math.max(0, Number(test.total_questions || 0)),
        questions,
        questionItems,
        outputConfig: test.output_config || null,
        generationConfig: test.generation_config || null,
        aiVerificationReport: extractAiVerificationReport(test.output_config),
    };
}

export async function saveAiVerificationReportForTests(
    testIds: string[],
    report: TestAiVerificationReport
): Promise<void> {
    const normalizedIds = Array.from(new Set(testIds.map((id) => id.trim()).filter(Boolean)));
    if (!normalizedIds.length) return;

    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(TESTS_TABLE)
        .select("id, output_config")
        .in("id", normalizedIds);

    if (error) {
        if (isMissingTableError(error)) {
            throw new Error(
                "History tables are missing. Run scripts/sql/create_test_history_tables.sql in Supabase first."
            );
        }
        throw new Error(`Failed to load saved tests for report update: ${error.message}`);
    }

    const rows = (data as Array<{ id: string; output_config?: unknown }> | null) || [];
    for (const row of rows) {
        const outputConfig = asRecord(row.output_config) || {};
        const nextOutputConfig = {
            ...outputConfig,
            aiVerificationReport: report,
        };

        const { error: updateError } = await supabase
            .from(TESTS_TABLE)
            .update({ output_config: nextOutputConfig })
            .eq("id", row.id);

        if (updateError) {
            throw new Error(`Failed to save AI verification report: ${updateError.message}`);
        }
    }
}
