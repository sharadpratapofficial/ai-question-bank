import { createClient } from "@supabase/supabase-js";
import { TABLE_NAME, SUPABASE_MAX_ROWS } from "@/lib/constants";
import {
    type CustomTestRowConfig,
    EXAM_PRESETS,
    JEE_ADVANCED_PATTERN_MATRIX,
    getQuestionTypeLabel,
    type DifficultyDistribution,
    type GeneratedTest,
    type JeeAdvancedPaper,
    type Question,
    type SourcePreference,
    type SubjectRequirement,
    type TestGenerationConfig,
    type TestGenerationResponse,
} from "@/types";
import {
    getBatchQuestionUsage,
    getQuestionUsageMap,
} from "@/lib/api/testHistory";
import {
    fetchDefaultTranslations,
    fetchQuestionIdsWithDefaultTranslation,
} from "@/lib/api/translations";

let supabaseInstance: ReturnType<typeof createClient> | null = null;
const ADVANCE_PAPER_ORDER: JeeAdvancedPaper[] = ["Paper 1", "Paper 2"];
const ADVANCE_SUBJECT_ORDER = ["Physics", "Chemistry", "Maths"];

function getSupabase() {
    if (!supabaseInstance) {
        supabaseInstance = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
    }
    return supabaseInstance;
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

/**
 * Swap question_text, options, solution_text on every question in `tests`
 * with its default translation in `language`. Questions without a translation
 * pass through unchanged (defensive — the candidate pool restriction should
 * already ensure every selected question has one).
 */
async function applyTranslationsToTests(
    tests: GeneratedTest[],
    language: string
): Promise<void> {
    const lang = language.trim().toLowerCase();
    if (!lang || lang === "english") return;

    const ids = new Set<string>();
    tests.forEach((t) =>
        t.sections.forEach((s) =>
            s.questionTypes.forEach((g) =>
                g.questions.forEach((q) => ids.add(q.question_id))
            )
        )
    );
    if (ids.size === 0) return;

    const translations = await fetchDefaultTranslations([...ids], lang);
    tests.forEach((t) =>
        t.sections.forEach((s) =>
            s.questionTypes.forEach((g) => {
                g.questions = g.questions.map((q) => {
                    const tr = translations.get(q.question_id);
                    if (!tr) return q;
                    return {
                        ...q,
                        question_text: tr.question_text,
                        options: Array.isArray(tr.options) ? tr.options : q.options,
                        solution_text: tr.solution_text ?? q.solution_text,
                    };
                });
            })
        )
    );
}

function subjectAliases(subject: string): string[] {
    if (subject === "Biology") return ["Biology", "Botany", "Zoology"];
    return [subject];
}

function questionTypeAliases(type: string): string[] {
    const normalized = type.trim().toLowerCase();
    if (normalized === "integer") return ["Integer", "Single_Digit_Integer"];
    if (normalized === "single_digit_integer") return ["Single_Digit_Integer", "Integer"];
    if (normalized === "passage_numerical") return ["Passage_Numerical", "passage_numerical"];
    if (normalized === "passage_scq") return ["Passage_SCQ", "passage_scq"];
    return [type];
}

function orderAdvanceSubjects(subjects: string[]): string[] {
    const seen = new Set<string>();
    const unique = subjects.filter((subject) => {
        const key = subject.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return unique.sort((a, b) => {
        const ai = ADVANCE_SUBJECT_ORDER.findIndex(
            (subject) => subject.toLowerCase() === a.toLowerCase()
        );
        const bi = ADVANCE_SUBJECT_ORDER.findIndex(
            (subject) => subject.toLowerCase() === b.toLowerCase()
        );
        const av = ai === -1 ? ADVANCE_SUBJECT_ORDER.length : ai;
        const bv = bi === -1 ? ADVANCE_SUBJECT_ORDER.length : bi;
        if (av !== bv) return av - bv;
        return a.localeCompare(b);
    });
}

function normalizeDifficultyDistribution(
    dist: DifficultyDistribution
): Record<"Easy" | "Medium" | "Hard", number> {
    let easy = clamp(dist.easyPercent || 0, 0, 100);
    let hard = clamp(dist.hardPercent || 0, 0, 100);
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

    const raw = keys.map((k) => ({
        key: k,
        exact: (clamp(percentMap[k] || 0, 0, 100) * total) / 100,
    }));
    let allocated = raw.map((r) => ({ key: r.key, value: Math.floor(r.exact), frac: r.exact % 1 }));
    let used = allocated.reduce((sum, a) => sum + a.value, 0);

    if (used > total) {
        const scale = total / used;
        allocated = allocated.map((a) => ({
            key: a.key,
            value: Math.floor(a.value * scale),
            frac: 0,
        }));
        used = allocated.reduce((sum, a) => sum + a.value, 0);
    }

    let remaining = total - used;
    allocated
        .sort((a, b) => b.frac - a.frac)
        .forEach((a) => {
            if (remaining > 0) {
                a.value += 1;
                remaining -= 1;
            }
        });

    return Object.fromEntries(allocated.map((a) => [a.key, a.value]));
}

function normalizeSourcePercentages(preferences: SourcePreference[]): Record<string, number> {
    const cleaned = preferences
        .map((p) => ({ source: p.source, percent: clamp(p.percent || 0, 0, 100) }))
        .filter((p) => p.source && p.percent > 0);
    if (!cleaned.length) return {};

    const total = cleaned.reduce((sum, p) => sum + p.percent, 0);
    const scale = total > 100 ? 100 / total : 1;
    return Object.fromEntries(cleaned.map((p) => [p.source, p.percent * scale]));
}

/** Resolve a question's class level ("11"/"12"), falling back to raw_data when
 *  the denormalized class_level column hasn't been backfilled. */
function questionClass(q: Question): string {
    const direct = (q.class_level || "").trim();
    if (direct) return direct;
    const raw = q.raw_data?.[0]?.conceptTags?.[0]?.class?.english_name;
    return (raw || "").trim() || "Unknown";
}

/** Evenly spread `requiredCount` across the distinct chapters present in `pool`
 *  (1 each when there are more chapters than slots, otherwise base + remainder). */
function balanceChaptersForPool(
    pool: Question[],
    requiredCount: number
): Record<string, number> {
    if (requiredCount <= 0 || pool.length === 0) return {};

    const uniqueChapters = [...new Set(pool.map((q) => q.chapter).filter(Boolean))];
    if (!uniqueChapters.length) return {};

    // Shuffle to avoid always favoring the same chapters for the extra remainder.
    const chapters = [...uniqueChapters];
    for (let i = chapters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
    }

    const count = Math.min(requiredCount, pool.length);
    const targets: Record<string, number> = {};

    if (count <= chapters.length) {
        chapters.slice(0, count).forEach((chapter) => {
            targets[chapter] = 1;
        });
        return targets;
    }

    const base = Math.floor(count / chapters.length);
    let remainder = count % chapters.length;

    chapters.forEach((chapter) => {
        targets[chapter] = base;
    });

    for (let i = 0; i < chapters.length && remainder > 0; i++) {
        targets[chapters[i]] += 1;
        remainder -= 1;
    }

    return targets;
}

/**
 * Build per-chapter pick targets that keep a full-syllabus paper balanced.
 *
 * When the pool spans more than one class (e.g. class 11 + class 12 selected),
 * the count is first split *evenly across classes* — so a class with many more
 * chapters can't crowd the other one out — and only then balanced across the
 * chapters within each class. With a single class present this is identical to
 * a plain even-across-chapters spread.
 */
function buildBalancedChapterTargets(
    pool: Question[],
    requiredCount: number
): Record<string, number> {
    if (requiredCount <= 0 || pool.length === 0) return {};

    const byClass = new Map<string, Question[]>();
    for (const q of pool) {
        const cls = questionClass(q);
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls)!.push(q);
    }

    // Single class (or unlabelled pool) — balance across chapters directly.
    if (byClass.size <= 1) {
        return balanceChaptersForPool(pool, requiredCount);
    }

    // Round-robin the slots across classes so the split is as even as possible
    // while respecting each class's available capacity (a depleted class spills
    // its remaining share over to the others automatically).
    const classKeys = [...byClass.keys()];
    const classCounts: Record<string, number> = {};
    classKeys.forEach((k) => (classCounts[k] = 0));
    let remaining = Math.min(requiredCount, pool.length);
    let progressed = true;
    while (remaining > 0 && progressed) {
        progressed = false;
        for (const k of classKeys) {
            if (remaining <= 0) break;
            if (classCounts[k] < byClass.get(k)!.length) {
                classCounts[k] += 1;
                remaining -= 1;
                progressed = true;
            }
        }
    }

    // Balance chapters within each class, then merge (chapters are class-unique
    // in practice, so an additive merge keeps each class's share intact).
    const targets: Record<string, number> = {};
    for (const cls of classKeys) {
        const classTargets = balanceChaptersForPool(byClass.get(cls)!, classCounts[cls]);
        for (const [chapter, n] of Object.entries(classTargets)) {
            targets[chapter] = (targets[chapter] || 0) + n;
        }
    }
    return targets;
}

interface PickOptions {
    preferredSources?: Set<string>;
    chapterTargets?: Record<string, number>;
    chapterPicked?: Record<string, number>;
}

function normalizeSubjectName(subject: string): string {
    return subject.trim().toLowerCase();
}

function subjectMatchesRequirement(selectedSubject: string, requirement: SubjectRequirement): boolean {
    const normalizedSelected = normalizeSubjectName(selectedSubject);
    const aliases = subjectAliases(requirement.subject).map(normalizeSubjectName);
    return aliases.includes(normalizedSelected);
}

function buildPoolKey(config: TestGenerationConfig, req: SubjectRequirement, type: string): string {
    const chapterKey = config.fullSyllabus
        ? "ALL"
        : (config.selectedChapters[req.subject] || []).slice().sort().join("|") || "NONE";
    const topicMap = config.selectedTopicsByChapter || {};
    const topicKey = Object.entries(topicMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([chapter, topics]) => `${chapter}:${(topics || []).slice().sort().join("|")}`)
        .join(";");
    return [req.subject, type, chapterKey, topicKey || "ALL_TOPICS"].join("::");
}

async function fetchCandidatePool(
    config: TestGenerationConfig,
    req: SubjectRequirement,
    type: string,
    eligibleQuestionIds?: Set<string> | null
): Promise<Question[]> {
    const supabase = getSupabase();
    const subjects = subjectAliases(req.subject);
    const types = questionTypeAliases(type);
    const chapters = config.fullSyllabus ? [] : config.selectedChapters[req.subject] || [];

    const requestedPassageNumerical = types.some(
        (t) => t.trim().toLowerCase() === "passage_numerical"
    );

    let query = supabase
        .from(TABLE_NAME)
        .select("*")
        .in("subject", subjects)
        .in("question_type", types)
        .is("parent_question_id", null)
        .neq("question_type", "Composite")
        .range(0, SUPABASE_MAX_ROWS - 1);

    if (!requestedPassageNumerical) {
        query = query
            .neq("question_type", "passage_numerical")
            .neq("question_type", "Passage_Numerical");
    }

    if (chapters.length) {
        query = query.in("chapter", chapters);
    }

    // wordSourceOnly restricts the candidate pool to questions that have a
    // raw-OOXML payload — needed when the user intends to download the test
    // via the native-source Word pipeline.
    if (config.wordSourceOnly) {
        query = query.not("source_docx", "is", null);
    }

    const { data, error } = await query;
    if (error) {
        throw new Error(`Failed to fetch candidate pool: ${error.message}`);
    }

    let rows = ((data as Question[]) || []).filter(Boolean);
    if (eligibleQuestionIds && eligibleQuestionIds.size > 0) {
        rows = rows.filter((q) => eligibleQuestionIds.has(q.question_id));
    } else if (eligibleQuestionIds) {
        // Empty set means "language restricted, no eligible questions"
        rows = [];
    }
    const topicMap = config.selectedTopicsByChapter || {};
    const hasTopicConstraint =
        !config.fullSyllabus && Object.values(topicMap).some((topics) => (topics || []).length > 0);
    if (!hasTopicConstraint) return rows;

    return rows.filter((q) => {
        const allowedTopics = topicMap[q.chapter] || [];
        if (!allowedTopics.length) return true;
        return allowedTopics.includes(q.topic);
    });
}

function pickQuestionsFromPool(
    pool: Question[],
    requiredCount: number,
    inTestUsed: Set<string>,
    globalUsed: Set<string>,
    sourcePercentages: Record<string, number>,
    difficultyPercentages: Record<"Easy" | "Medium" | "Hard", number>,
    options: PickOptions = {}
): Question[] {
    const available = pool.filter((q) => !inTestUsed.has(q.question_id));
    if (!available.length || requiredCount <= 0) return [];

    const count = Math.min(requiredCount, available.length);
    const sourceTargets = allocateTargets(count, sourcePercentages);
    const difficultyTargets = allocateTargets(count, difficultyPercentages);

    const selected: Question[] = [];
    const sourcePicked: Record<string, number> = {};
    const difficultyPicked: Record<string, number> = {};
    const chapterPicked = options.chapterPicked || {};
    const preferredSources = options.preferredSources;
    const chapterTargets = options.chapterTargets || {};

    for (let i = 0; i < count; i++) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        const hasPreferredSources =
            !!preferredSources &&
            preferredSources.size > 0 &&
            available.some((q) => preferredSources.has(q.source || ""));

        for (let idx = 0; idx < available.length; idx++) {
            const q = available[idx];
            if (selected.some((s) => s.question_id === q.question_id)) continue;

            const source = q.source || "";
            if (hasPreferredSources && preferredSources && !preferredSources.has(source)) {
                continue;
            }
            const difficulty = ["Easy", "Medium", "Hard"].includes(q.difficutly_level)
                ? q.difficutly_level
                : "Medium";
            const chapter = q.chapter || "";

            const sourceNeed = (sourceTargets[source] || 0) - (sourcePicked[source] || 0);
            const diffNeed = (difficultyTargets[difficulty] || 0) - (difficultyPicked[difficulty] || 0);
            const chapterNeed = (chapterTargets[chapter] || 0) - (chapterPicked[chapter] || 0);

            let score = Math.random() * 0.2;
            score += sourceNeed > 0 ? 0.9 : 0;
            score += diffNeed > 0 ? 0.45 : 0; // Keep difficulty as soft preference.
            score += chapterNeed > 0 ? 1.5 : -0.05;
            score += (sourcePercentages[source] || 0) / 200;

            // Prefer unique questions across generated tests, but allow reuse if needed.
            score += globalUsed.has(q.question_id) ? -0.6 : 0.4;

            if (score > bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        }

        if (bestIdx === -1) break;
        const pick = available.splice(bestIdx, 1)[0];
        selected.push(pick);
        sourcePicked[pick.source || ""] = (sourcePicked[pick.source || ""] || 0) + 1;
        const diffKey = ["Easy", "Medium", "Hard"].includes(pick.difficutly_level)
            ? pick.difficutly_level
            : "Medium";
        difficultyPicked[diffKey] = (difficultyPicked[diffKey] || 0) + 1;
        chapterPicked[pick.chapter || ""] = (chapterPicked[pick.chapter || ""] || 0) + 1;
    }

    return selected;
}

function buildCustomRowPoolKey(row: CustomTestRowConfig): string {
    return [
        row.subject,
        row.questionType,
        row.chapter?.trim() || "ALL_CHAPTERS",
        row.topic?.trim() || "ALL_TOPICS",
    ].join("::");
}

async function fetchCustomRowPool(
    row: CustomTestRowConfig,
    eligibleQuestionIds?: Set<string> | null
): Promise<Question[]> {
    const supabase = getSupabase();
    const subjects = subjectAliases(row.subject);
    const types = questionTypeAliases(row.questionType);
    const chapter = row.chapter?.trim();
    const topic = row.topic?.trim();

    const requestedPassageNumerical = types.some(
        (t) => t.trim().toLowerCase() === "passage_numerical"
    );

    let query = supabase
        .from(TABLE_NAME)
        .select("*")
        .in("subject", subjects)
        .in("question_type", types)
        .is("parent_question_id", null)
        .neq("question_type", "Composite")
        .range(0, SUPABASE_MAX_ROWS - 1);

    if (!requestedPassageNumerical) {
        query = query
            .neq("question_type", "passage_numerical")
            .neq("question_type", "Passage_Numerical");
    }

    if (chapter) {
        query = query.eq("chapter", chapter);
    }
    if (topic) {
        query = query.eq("topic", topic);
    }

    const { data, error } = await query;
    if (error) {
        throw new Error(`Failed to fetch custom row pool: ${error.message}`);
    }

    let rows = (data as Question[]) || [];
    if (eligibleQuestionIds) {
        rows = eligibleQuestionIds.size > 0
            ? rows.filter((q) => eligibleQuestionIds.has(q.question_id))
            : [];
    }
    return rows;
}

async function generateCustomTests(
    config: TestGenerationConfig,
    warnings: string[],
    sourcePercentages: Record<string, number>,
    options: {
        batchUsedQuestionIds: Set<string>;
        allowBatchRepeatFallback: boolean;
        eligibleQuestionIds?: Set<string> | null;
    }
): Promise<GeneratedTest[]> {
    const preferredSources =
        Object.keys(sourcePercentages).length > 0
            ? new Set(Object.keys(sourcePercentages))
            : undefined;

    type NormalizedCustomRow = Omit<CustomTestRowConfig, "subject" | "questionType"> & {
        subject: string;
        questionType: string;
    };

    const rows: NormalizedCustomRow[] = (config.customRows || [])
        .map((row): NormalizedCustomRow => ({
            ...row,
            numQuestions: Math.max(0, Math.floor(row.numQuestions || 0)),
            subject: row.subject?.trim() || "",
            questionType: row.questionType?.trim() || "",
            chapter: row.chapter?.trim() || undefined,
            topic: row.topic?.trim() || undefined,
        }))
        .filter((row) => row.numQuestions > 0 && row.subject.length > 0 && row.questionType.length > 0);

    if (!rows.length) {
        throw new Error("Customised Test requires at least one valid row.");
    }

    const pools = new Map<string, Question[]>();
    for (const row of rows) {
        const key = buildCustomRowPoolKey(row);
        if (!pools.has(key)) {
            const pool = await fetchCustomRowPool(row, options.eligibleQuestionIds);
            pools.set(key, pool);
            if (!pool.length) {
                const location = [row.subject, row.chapter, row.topic].filter(Boolean).join(" / ");
                warnings.push(`No candidate questions for ${location} / ${row.questionType}.`);
            }
        }
    }

    const tests: GeneratedTest[] = [];
    const globalUsed = new Set<string>();

    for (let testNumber = 1; testNumber <= config.numberOfTests; testNumber++) {
        const inTestUsed = new Set<string>();
        const byDifficulty: Record<string, number> = {};
        const bySource: Record<string, number> = {};
        const byChapter: Record<string, number> = {};
        const sectionMap = new Map<string, Map<string, Question[]>>();
        let testTotal = 0;

        for (const row of rows) {
            const key = buildCustomRowPoolKey(row);
            const pool = pools.get(key) || [];
            const rowDifficulty = normalizeDifficultyDistribution({
                easyPercent: row.easyPercent,
                hardPercent: row.hardPercent,
            });

            const freshPool =
                options.batchUsedQuestionIds.size > 0
                    ? pool.filter((question) => !options.batchUsedQuestionIds.has(question.question_id))
                    : pool;

            const pickedFresh = pickQuestionsFromPool(
                freshPool,
                row.numQuestions,
                inTestUsed,
                globalUsed,
                sourcePercentages,
                rowDifficulty,
                {
                    preferredSources,
                }
            );

            pickedFresh.forEach((question) => {
                inTestUsed.add(question.question_id);
                globalUsed.add(question.question_id);
            });

            let picked = [...pickedFresh];
            if (
                options.allowBatchRepeatFallback &&
                options.batchUsedQuestionIds.size > 0 &&
                picked.length < row.numQuestions
            ) {
                const needed = row.numQuestions - picked.length;
                const fallbackPool = pool.filter(
                    (question) =>
                        options.batchUsedQuestionIds.has(question.question_id) &&
                        !inTestUsed.has(question.question_id)
                );
                const pickedFallback = pickQuestionsFromPool(
                    fallbackPool,
                    needed,
                    inTestUsed,
                    globalUsed,
                    sourcePercentages,
                    rowDifficulty,
                    {
                        preferredSources,
                    }
                );

                pickedFallback.forEach((question) => {
                    inTestUsed.add(question.question_id);
                    globalUsed.add(question.question_id);
                });
                if (pickedFallback.length > 0) {
                    const location = [row.subject, row.chapter, row.topic]
                        .filter(Boolean)
                        .join(" / ");
                    warnings.push(
                        `Test ${testNumber}: reused ${pickedFallback.length} previously used questions in batch ${config.batchName} for ${location} / ${row.questionType}.`
                    );
                }
                picked = [...picked, ...pickedFallback];
            }

            picked.forEach((q) => {
                byDifficulty[q.difficutly_level || "Unknown"] =
                    (byDifficulty[q.difficutly_level || "Unknown"] || 0) + 1;
                bySource[q.source || "Unknown"] = (bySource[q.source || "Unknown"] || 0) + 1;
                byChapter[q.chapter || "Unknown"] = (byChapter[q.chapter || "Unknown"] || 0) + 1;
            });

            if (picked.length < row.numQuestions) {
                const location = [row.subject, row.chapter, row.topic].filter(Boolean).join(" / ");
                warnings.push(
                    `Test ${testNumber}: ${location} / ${row.questionType} requested ${row.numQuestions}, got ${picked.length}.`
                );
            }

            if (!sectionMap.has(row.subject)) {
                sectionMap.set(row.subject, new Map());
            }
            const typeMap = sectionMap.get(row.subject)!;
            const existing = typeMap.get(row.questionType) || [];
            typeMap.set(row.questionType, [...existing, ...picked]);

            testTotal += picked.length;
        }

        const sections = Array.from(sectionMap.entries()).map(([subject, typeMap]) => {
            const questionTypes = Array.from(typeMap.entries()).map(([type, questions]) => ({
                type,
                typeLabel: getQuestionTypeLabel(type),
                questions,
            }));
            const totalQuestions = questionTypes.reduce((sum, qt) => sum + qt.questions.length, 0);
            return { subject, questionTypes, totalQuestions };
        });

        tests.push({
            testNumber,
            batchName: config.batchName,
            testDate: config.testDate,
            examPreset: config.examPreset,
            sections,
            totalQuestions: testTotal,
            stats: {
                byDifficulty,
                bySource,
                byChapter,
            },
        });
    }

    return tests;
}

export async function generateTests(
    config: TestGenerationConfig
): Promise<TestGenerationResponse> {
    try {
        const warnings: string[] = [];
        const sourcePercentages = normalizeSourcePercentages(config.sourcePreferences || []);
        const preferredSources =
            Object.keys(sourcePercentages).length > 0
                ? new Set(Object.keys(sourcePercentages))
                : undefined;

        const avoidBatchRepeats = config.avoidBatchRepeats !== false;
        const allowBatchRepeatFallback = config.allowBatchRepeatFallback !== false;
        let batchUsedQuestionIds = new Set<string>();

        if (avoidBatchRepeats && config.batchName?.trim()) {
            const batchUsage = await getBatchQuestionUsage(config.batchName.trim());
            batchUsedQuestionIds = batchUsage.usedQuestionIds;
            if (!batchUsage.historyAvailable) {
                warnings.push(
                    "Batch history tables are not available yet. Repeat-prevention is temporarily disabled."
                );
            }
        }

        // When a non-English language is requested, restrict the candidate pool
        // to question_ids that have a default translation in that language.
        const normalizedLanguage = (config.language || "english").trim().toLowerCase();
        let eligibleQuestionIds: Set<string> | null = null;
        if (normalizedLanguage && normalizedLanguage !== "english") {
            eligibleQuestionIds = await fetchQuestionIdsWithDefaultTranslation(normalizedLanguage);
            if (eligibleQuestionIds.size === 0) {
                return {
                    success: false,
                    tests: [],
                    warnings,
                    error: `No questions have a default ${normalizedLanguage} translation yet. Translate some questions in the question bank first, or pick a different language.`,
                };
            }
            warnings.push(
                `Pool restricted to ${eligibleQuestionIds.size} question(s) with a default ${normalizedLanguage} translation.`
            );
        }

        if (config.customRows?.length) {
            const tests = await generateCustomTests(config, warnings, sourcePercentages, {
                batchUsedQuestionIds,
                allowBatchRepeatFallback,
                eligibleQuestionIds,
            });
            await applyTranslationsToTests(tests, normalizedLanguage);
            const questionIds = tests.flatMap((test) =>
                test.sections.flatMap((section) =>
                    section.questionTypes.flatMap((group) =>
                        group.questions.map((question) => question.question_id)
                    )
                )
            );
            const questionUsageById = await getQuestionUsageMap(questionIds);
            return {
                success: true,
                tests,
                warnings,
                questionUsageById,
            };
        }

        const selectedSubjects = (config.selectedSubjects || [])
            .map((s) => s.trim())
            .filter(Boolean);

        let preset:
            | {
                  label: string;
                  subjects: SubjectRequirement[];
                  totalQuestions: number;
              }
            | undefined;

        if (config.examPreset === "JEE_ADVANCE") {
            const year = (config.jeeAdvancedYear || "").trim();
            const papers = (config.jeeAdvancedPapers || []).filter(Boolean) as JeeAdvancedPaper[];
            const paperPatterns = JEE_ADVANCED_PATTERN_MATRIX[year];
            const customByPaper = config.questionTypeDistributionByPaper || {};

            if (!paperPatterns) {
                return {
                    success: false,
                    tests: [],
                    warnings: [],
                    error: `Unsupported JEE Advanced year: ${year || "not provided"}`,
                };
            }

            if (!papers.length) {
                return {
                    success: false,
                    tests: [],
                    warnings: [],
                    error: "Select at least one JEE Advanced paper.",
                };
            }

            const subjectsForAdvance =
                selectedSubjects.length > 0
                    ? orderAdvanceSubjects(selectedSubjects)
                    : [...ADVANCE_SUBJECT_ORDER];
            const selectedPapers = [...new Set(papers)].sort(
                (a, b) =>
                    ADVANCE_PAPER_ORDER.indexOf(a) - ADVANCE_PAPER_ORDER.indexOf(b)
            );
            const requirements: SubjectRequirement[] = [];

            selectedPapers.forEach((paper) => {
                const customRows = (customByPaper[paper] || [])
                    .filter((row) => row.type && row.count > 0)
                    .map((row) => ({
                        type: row.type,
                        count: Math.max(1, Math.floor(row.count)),
                        questionNumbers: row.questionNumbers,
                    }));
                const rows = customRows.length ? customRows : paperPatterns[paper];
                subjectsForAdvance.forEach((subject) => {
                    requirements.push({
                        paper,
                        subject,
                        questionTypes: rows.map((row) => ({
                            type: row.type,
                            count: row.count,
                            questionNumbers: row.questionNumbers,
                        })),
                    });
                });
            });

            const totalQuestions = requirements.reduce(
                (sum, req) =>
                    sum + req.questionTypes.reduce((reqSum, qt) => reqSum + qt.count, 0),
                0
            );

            preset = {
                label: `JEE Advance ${year} (${selectedPapers.join(" + ")})`,
                subjects: requirements,
                totalQuestions,
            };
        } else {
            const basePreset = EXAM_PRESETS[config.examPreset];
            const customDistribution = (config.questionTypeDistribution || [])
                .filter((row) => row.type && row.count > 0)
                .map((row) => ({
                    type: row.type,
                    count: Math.max(1, Math.floor(row.count)),
                    questionNumbers: row.questionNumbers,
                }));
            if (basePreset && customDistribution.length) {
                const subjects = basePreset.subjects.map((req) => ({
                    ...req,
                    questionTypes: customDistribution.map((row) => ({ ...row })),
                }));
                const perSubjectTotal = customDistribution.reduce(
                    (sum, row) => sum + row.count,
                    0
                );
                preset = {
                    label: basePreset.label,
                    subjects,
                    totalQuestions: perSubjectTotal * subjects.length,
                };
            } else {
                preset = basePreset;
            }
        }

        if (!preset) {
            return {
                success: false,
                tests: [],
                warnings: [],
                error: `Unsupported exam preset: ${config.examPreset}`,
            };
        }

        const difficultyPercentages = normalizeDifficultyDistribution(
            config.difficultyDistribution || { easyPercent: 30, hardPercent: 30 }
        );
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

        const unmatchedSelected = selectedSubjects.filter(
            (selected) => !preset.subjects.some((req) => subjectMatchesRequirement(selected, req))
        );
        if (unmatchedSelected.length) {
            warnings.push(`Ignored unsupported subjects for ${preset.label}: ${unmatchedSelected.join(", ")}.`);
        }

        // Pre-fetch pools once per requirement.
        const pools = new Map<string, Question[]>();
        for (const req of activeRequirements) {
            for (const qt of req.questionTypes) {
                const key = buildPoolKey(config, req, qt.type);
                if (!pools.has(key)) {
                    const pool = await fetchCandidatePool(config, req, qt.type, eligibleQuestionIds);
                    pools.set(key, pool);
                    if (!pool.length) {
                        warnings.push(
                            `No candidate questions for ${req.paper ? `${req.paper} / ` : ""}${req.subject} / ${qt.type}.`
                        );
                    }
                }
            }
        }

        const tests: GeneratedTest[] = [];
        const globalUsed = new Set<string>();

        for (let testNumber = 1; testNumber <= config.numberOfTests; testNumber++) {
            const inTestUsed = new Set<string>();
            const sections: GeneratedTest["sections"] = [];
            const byDifficulty: Record<string, number> = {};
            const bySource: Record<string, number> = {};
            const byChapter: Record<string, number> = {};
            let testTotal = 0;

            for (const req of activeRequirements) {
                const typeGroups: {
                    type: string;
                    typeLabel: string;
                    questions: Question[];
                }[] = [];
                let sectionTotal = 0;
                const sectionRequestedCount = req.questionTypes.reduce(
                    (sum, qt) => sum + qt.count,
                    0
                );
                const sectionPool = req.questionTypes.flatMap((qt) => {
                    const key = buildPoolKey(config, req, qt.type);
                    return pools.get(key) || [];
                });
                // Balance picks across chapters (and across classes when the
                // pool spans both class 11 & 12). Applies whether the user chose
                // full syllabus or an explicit set of chapters — either way the
                // pool already reflects their scope, so this just spreads the
                // picks evenly instead of clustering on a few chapters.
                const sectionChapterTargets = buildBalancedChapterTargets(
                    sectionPool,
                    sectionRequestedCount
                );
                const sectionChapterPicked: Record<string, number> = {};

                for (const qt of req.questionTypes) {
                    const key = buildPoolKey(config, req, qt.type);
                    const pool = pools.get(key) || [];

                    const freshPool =
                        batchUsedQuestionIds.size > 0
                            ? pool.filter(
                                  (question) =>
                                      !batchUsedQuestionIds.has(question.question_id)
                              )
                            : pool;

                    const pickedFresh = pickQuestionsFromPool(
                        freshPool,
                        qt.count,
                        inTestUsed,
                        globalUsed,
                        sourcePercentages,
                        difficultyPercentages,
                        {
                            preferredSources,
                            chapterTargets: sectionChapterTargets,
                            chapterPicked: sectionChapterPicked,
                        }
                    );

                    pickedFresh.forEach((question) => {
                        inTestUsed.add(question.question_id);
                        globalUsed.add(question.question_id);
                    });

                    let picked = [...pickedFresh];
                    if (
                        allowBatchRepeatFallback &&
                        batchUsedQuestionIds.size > 0 &&
                        picked.length < qt.count
                    ) {
                        const needed = qt.count - picked.length;
                        const fallbackPool = pool.filter(
                            (question) =>
                                batchUsedQuestionIds.has(question.question_id) &&
                                !inTestUsed.has(question.question_id)
                        );
                        const pickedFallback = pickQuestionsFromPool(
                            fallbackPool,
                            needed,
                            inTestUsed,
                            globalUsed,
                            sourcePercentages,
                            difficultyPercentages,
                            {
                                preferredSources,
                                chapterTargets: sectionChapterTargets,
                                chapterPicked: sectionChapterPicked,
                            }
                        );

                        pickedFallback.forEach((question) => {
                            inTestUsed.add(question.question_id);
                            globalUsed.add(question.question_id);
                        });
                        if (pickedFallback.length > 0) {
                            warnings.push(
                                `Test ${testNumber}: reused ${pickedFallback.length} previously used questions in batch ${config.batchName} for ${req.paper ? `${req.paper} / ` : ""}${req.subject} / ${qt.type}.`
                            );
                        }
                        picked = [...picked, ...pickedFallback];
                    }

                    picked.forEach((q) => {
                        byDifficulty[q.difficutly_level || "Unknown"] =
                            (byDifficulty[q.difficutly_level || "Unknown"] || 0) + 1;
                        bySource[q.source || "Unknown"] = (bySource[q.source || "Unknown"] || 0) + 1;
                        byChapter[q.chapter || "Unknown"] = (byChapter[q.chapter || "Unknown"] || 0) + 1;
                    });

                    if (picked.length < qt.count) {
                        warnings.push(
                            `Test ${testNumber}: ${req.paper ? `${req.paper} / ` : ""}${req.subject} / ${qt.type} requested ${qt.count}, got ${picked.length}.`
                        );
                    }

                    typeGroups.push({
                        type: qt.type,
                        typeLabel: getQuestionTypeLabel(qt.type),
                        questions: picked,
                    });
                    sectionTotal += picked.length;
                }

                sections.push({
                    paper: req.paper,
                    subject: req.subject,
                    questionTypes: typeGroups,
                    totalQuestions: sectionTotal,
                });
                testTotal += sectionTotal;
            }

            tests.push({
                testNumber,
                batchName: config.batchName,
                testDate: config.testDate,
                examPreset: config.examPreset,
                sections,
                totalQuestions: testTotal,
                stats: {
                    byDifficulty,
                    bySource,
                    byChapter,
                },
            });
        }

        await applyTranslationsToTests(tests, normalizedLanguage);

        const questionIds = tests.flatMap((test) =>
            test.sections.flatMap((section) =>
                section.questionTypes.flatMap((group) =>
                    group.questions.map((question) => question.question_id)
                )
            )
        );
        const questionUsageById = await getQuestionUsageMap(questionIds);

        return {
            success: true,
            tests,
            warnings,
            questionUsageById,
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
