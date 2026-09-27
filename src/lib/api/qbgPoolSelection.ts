/**
 * Pool-selection logic for the QBG Pipeline feature ("QBG Pipeline" tab under
 * /qbg). Mirrors the *structure* of `generateTests()` / `pickQuestionsFromPool()`
 * (`src/lib/api/testGeneration.ts`) — same difficulty/source-percent weighted
 * picking, same per-chapter balancing — but targets the new
 * `public.qbg_question_pool` table (an imported reference dataset, see
 * `python/qbg_pool_import/import_pool.py`) instead of the app's own
 * `qbg_questions` Supabase table, and adds filter dimensions that table didn't
 * need: class level, category_name, a subtopic cascade level, and multi-batch
 * exclusion via `used_in_exam` (a text[] column, unlike the existing Tests
 * feature's single-batch-name-only repeat check).
 *
 * `generateTests()` itself is NOT modified — the existing Tests feature stays
 * fully decoupled from this table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_MAX_ROWS } from "@/lib/constants";
import { compareChaptersBySubject } from "@/lib/chapterOrder";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
    resolvePlanRequirements,
    subjectAliases,
    type PlanSlot,
} from "@/lib/api/qbgPaperPlan";
import {
    type ExamPreset,
    type JeeAdvancedPaper,
    type QuestionTypeDistributionRow,
    type SourcePreference,
    type DifficultyDistribution,
    type SubjectRequirement,
} from "@/types";

function db(): SupabaseClient {
        return getSupabaseAdmin(); // itself a process-wide singleton
}

const POOL_TABLE = "qbg_question_pool";

/**
 * One row of public.qbg_question_pool as fetched for selection.
 *
 * The bulk content fields below are optional because POOL_SELECT_COLUMNS does
 * not fetch them — selection, the pipeline panel and the QC adapter only use the
 * metadata. Anything that genuinely needs question HTML should read it from QBG
 * rather than widening this query.
 */
export interface PoolQuestion {
    unique_id: string;
    qbg_id: string | null;
    question_type: string | null;
    difficulty_level: string | null;
    difficulty: number | null;
    source: string | null;
    subject: string | null;
    chapter: string | null;
    topic: string | null;
    subtopic: string | null;
    class_level: string | null;
    category_name: string | null;
    used_in_exam: string[] | null;
    has_video_solution: boolean | null;
    has_text_solution: boolean | null;
    verification_status: number | null;
    is_int_answer: boolean | null;
    is_range_numerical: boolean | null;
    exam_year: string | null;
    qc_status: string | null;
    content?: { english?: string } | null;
    bilingual_options?: { english?: { isCorrect: boolean | null; text: string | null }[] } | null;
    solutions?: { english?: { text?: string } }[] | null;
    bilingual_solutions?: unknown;
    answer?: { english?: string } | null;
    concept_tags?: unknown;
    readiness_tags?: unknown;
    x_category_tags?: unknown;
    languages?: unknown;
    exam_details?: unknown;
    sources: unknown;
    child_questions?: unknown;
    link: string | null;
    slug: string | null;
    parent_question_id: string | null;
    organization_id: string | null;
    category_configuration_id: string | null;
}

export interface PoolSelectionConfig {
    examPreset: ExamPreset;
    jeeAdvancedYear?: string;
    jeeAdvancedPapers?: JeeAdvancedPaper[];
    questionTypeDistribution?: QuestionTypeDistributionRow[];
    questionTypeDistributionByPaper?: Partial<Record<JeeAdvancedPaper, QuestionTypeDistributionRow[]>>;
    /** Optional — written to used_in_exam for every selected question. Omit
     *  or leave empty to run the pipeline without touching used_in_exam at all. */
    batchNames?: string[];
    /** Past batch names to exclude questions already used in (any overlap excludes). */
    avoidBatchNames?: string[];
    /** Any-of match — empty/undefined means any class. */
    classLevels?: string[];
    categoryName?: string;
    /** Require an English video solution / English text solution to be present. */
    hasVideoSolution?: boolean;
    hasTextSolution?: boolean;
    fullSyllabus: boolean;
    selectedSubjects?: string[];
    selectedChapters: Record<string, string[]>;
    /**
     * subject -> chapter -> how many questions to take from that chapter.
     *
     * Absent (or all zero) for a subject means AUTO: spread the subject's quota
     * evenly across whatever chapters the pool offers, which is the long-standing
     * behaviour. Present means the blueprint is the user's — "8 from Rotational
     * Motion, 4 from Gravitation" — and it is honoured across that subject's
     * question types rather than per type, since a chapter quota is about the
     * paper, not about SCQ-vs-Numerical.
     */
    chapterCounts?: Record<string, Record<string, number>>;
    /**
     * The approved manual paper plan — one entry per question, already ordered.
     *
     * Present means the user reviewed and edited the blueprint before the run,
     * so each question is picked to fill a specific slot (this chapter, this
     * topic, this difficulty, this source) and the result comes back in the
     * plan's order. Absent means automatic balancing, which is unchanged.
     */
    paperPlan?: PlanSlot[];
    selectedTopicsByChapter?: Record<string, string[]>;
    selectedSubtopicsByTopic?: Record<string, string[]>;
    sourcePreferences: SourcePreference[];
    difficultyDistribution: DifficultyDistribution;
    /**
     * Fill a type shortfall with questions of OTHER types, to be rewritten into
     * the wanted type by the Modify stage.
     *
     * Only meaningful when Modify runs: the AI writes a new question anyway, so
     * the source is a seed for its concept, not something to be kept — an SCQ can
     * become a Numerical as easily as it can be reworded. Without Modify a seed
     * would reach the paper as the wrong type, so the pipeline leaves this off.
     */
    allowTypeSeeds?: boolean;
}

/** A question picked as a seed: it must be rewritten as `toType`. */
export interface TypeConversion {
    uniqueId: string;
    /** Pool type of the source question, e.g. "Single_Choice(SCQ)". */
    fromType: string;
    /** Pool type the paper asked for, e.g. "Numerical". */
    toType: string;
    /** The same, in the reframe's vocabulary (SCQ / MCQ / NUMERICAL / ...). */
    reframeType: ReframeType;
}

export interface PoolSelectionResult {
    uniqueIds: string[];
    rows: PoolQuestion[];
    poolMeta: {
        requested: number;
        selected: number;
        byRequirement: { subject: string; type: string; requested: number; selected: number; seeded?: number }[];
    };
    warnings: string[];
    /** Seeds that must change type. Empty unless allowTypeSeeds filled a shortfall. */
    typeConversions?: TypeConversion[];
}

/** The five types the reframe can write (python/qbg_modification/extract.py). */
export type ReframeType = "SCQ" | "MCQ" | "NUMERICAL" | "MATCHING_LIST" | "ASSERTION_REASON";

/** Pool type -> reframe type, or null for a type the reframe cannot write
 *  (Comprehension passages, Subjective). */
export function toReframeType(poolType: string): ReframeType | null {
    const t = (poolType || "").toLowerCase();
    if (t.includes("assertion")) return "ASSERTION_REASON";
    if (t.includes("matching")) return "MATCHING_LIST";
    if (t.includes("multi") || t.includes("(mcq)")) return "MCQ";
    if (t.includes("single_choice") || t.includes("(scq)")) return "SCQ";
    if (t.includes("integer") || t.includes("numerical")) return "NUMERICAL";
    return null;
}

/**
 * Types a seed may be taken from, most useful first. A single-correct question
 * carries the cleanest concept (one right answer, one method) and is by far the
 * most plentiful, so it is tried first; a Numerical is next. Assertion-Reason and
 * Matching-List are last — their shape is furthest from a plain question.
 * Comprehension and Subjective never seed: a passage child has no stand-alone
 * concept, and a subjective question has no answer to check the rewrite against.
 */
const SEED_SOURCE_TYPES = [
    "Single_Choice(SCQ)",
    "Numerical",
    "Multi_Choice(MCQ)",
    "Assertion_Reason(AR)",
    "Matching_List(ML)",
];

/** Seed types to try for a wanted type — never the wanted type itself. */
function seedTypesFor(wanted: string): string[] {
    const target = toReframeType(wanted);
    return SEED_SOURCE_TYPES.filter((t) => toReframeType(t) !== target);
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
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

/** Pool's difficulty_level is Easy/Medium/Difficult/'0' — bucket into the
 *  Easy/Medium/Hard vocabulary the rest of the app's distribution UI uses. */
function bucketDifficulty(level: string | null): "Easy" | "Medium" | "Hard" {
    const v = (level || "").trim();
    if (v === "Easy") return "Easy";
    if (v === "Difficult") return "Hard";
    return "Medium"; // "Medium", "0" (unset), blank
}

function allocateTargets(total: number, percentMap: Record<string, number>): Record<string, number> {
    const keys = Object.keys(percentMap);
    if (total <= 0 || keys.length === 0) return {};
    const raw = keys.map((k) => ({ key: k, exact: (clamp(percentMap[k] || 0, 0, 100) * total) / 100 }));
    let allocated = raw.map((r) => ({ key: r.key, value: Math.floor(r.exact), frac: r.exact % 1 }));
    let used = allocated.reduce((sum, a) => sum + a.value, 0);
    if (used > total) {
        const scale = total / used;
        allocated = allocated.map((a) => ({ key: a.key, value: Math.floor(a.value * scale), frac: 0 }));
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

/**
 * The user's own chapter blueprint for a subject, or null to fall back to the
 * automatic even spread.
 *
 * Only counts greater than zero are kept: a chapter left at 0 means "none from
 * here", and an all-zero map is indistinguishable from not having filled the
 * form in, so it is treated as auto rather than as "a paper of no questions".
 */
function manualChapterTargets(
    config: PoolSelectionConfig,
    subject: string
): Record<string, number> | null {
    const raw = config.chapterCounts?.[subject];
    if (!raw) return null;
    const out: Record<string, number> = {};
    for (const [chapter, n] of Object.entries(raw)) {
        const count = Math.floor(Number(n));
        if (Number.isFinite(count) && count > 0) out[chapter] = count;
    }
    return Object.keys(out).length > 0 ? out : null;
}

function balanceChaptersForPool(pool: PoolQuestion[], requiredCount: number): Record<string, number> {
    if (requiredCount <= 0 || pool.length === 0) return {};
    const uniqueChapters = [...new Set(pool.map((q) => q.chapter).filter(Boolean))] as string[];
    if (!uniqueChapters.length) return {};
    const chapters = [...uniqueChapters];
    for (let i = chapters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
    }
    const count = Math.min(requiredCount, pool.length);
    const targets: Record<string, number> = {};
    if (count <= chapters.length) {
        chapters.slice(0, count).forEach((chapter) => (targets[chapter] = 1));
        return targets;
    }
    const base = Math.floor(count / chapters.length);
    let remainder = count % chapters.length;
    chapters.forEach((chapter) => (targets[chapter] = base));
    for (let i = 0; i < chapters.length && remainder > 0; i++) {
        targets[chapters[i]] += 1;
        remainder -= 1;
    }
    return targets;
}

function questionTypeAliases(type: string): string[] {
    const normalized = type.trim().toLowerCase();
    if (normalized === "integer") return ["Integer", "Numerical", "Single_Digit_Integer"];
    if (normalized === "single_digit_integer") return ["Single_Digit_Integer", "Numerical", "Integer"];
    return [type];
}

/** Resolve which SubjectRequirement[] to iterate for this config. The logic
 *  itself lives in qbgPaperPlan so the manual planner in the browser and the
 *  picker on the server can never disagree about what the paper asks for. */
function resolveRequirements(config: PoolSelectionConfig): SubjectRequirement[] {
    return resolvePlanRequirements(config);
}

// qbg_question_pool routinely has several thousand candidates for a single
// subject/question-type pair (unlike the app's own live qbg_questions table,
// which the equivalent testGeneration.ts query is sized for) — a single
// unordered SUPABASE_MAX_ROWS-capped page would silently truncate to
// whatever 1000 rows Postgres returns first in physical order, which can
// exclude entire sources from the candidate pool and break source-percentage
// weighting. Page through the full candidate set instead (bounded so a
// pathological filter can't page forever).
const MAX_CANDIDATE_ROWS = 20000;

/**
 * Columns the pool selection actually reads.
 *
 * This used to be `select("*")`. qbg_question_pool is ~49k rows / 214 MB, and a
 * single requirement (e.g. Physics + Single_Choice(SCQ), 25k rows) paged through
 * 72 MB of question HTML, solutions and concept tags that nothing here — or in
 * the pipeline panel, or the QC adapter — ever looks at. Several requirements in
 * one run pushed the request past the proxy's ~100s ceiling, and the browser got
 * an HTML error page where it expected JSON ("Unexpected token '<'").
 *
 * The same page is 602 kB instead of 3784 kB with this list, and the full
 * candidate set 12 MB instead of 72 MB.
 */
const POOL_SELECT_COLUMNS = [
    "unique_id", "qbg_id", "question_type", "difficulty_level", "difficulty",
    "source", "subject", "chapter", "topic", "subtopic", "class_level",
    "category_name", "used_in_exam", "has_video_solution", "has_text_solution",
    "verification_status", "is_int_answer", "is_range_numerical", "exam_year",
    "qc_status", "sources", "link", "slug", "parent_question_id",
].join(",");

async function fetchCandidatePool(
    config: PoolSelectionConfig,
    req: SubjectRequirement,
    type: string
): Promise<PoolQuestion[]> {
    const subjects = subjectAliases(req.subject);
    const types = questionTypeAliases(type);
    const chapters = config.fullSyllabus ? [] : config.selectedChapters[req.subject] || [];

    const buildQuery = (offset: number) => {
        let query = db()
            .from(POOL_TABLE)
            .select(POOL_SELECT_COLUMNS)
            .in("subject", subjects)
            .in("question_type", types)
            .is("parent_question_id", null)
            .order("unique_id", { ascending: true })
            .range(offset, offset + SUPABASE_MAX_ROWS - 1);

        if (chapters.length) query = query.in("chapter", chapters);
        if (config.classLevels?.length) query = query.in("class_level", config.classLevels);
        if (config.categoryName) query = query.eq("category_name", config.categoryName);
        if (config.hasVideoSolution) query = query.eq("has_video_solution", true);
        if (config.hasTextSolution) query = query.eq("has_text_solution", true);
        return query;
    };

    let rows: PoolQuestion[] = [];
    for (let offset = 0; offset < MAX_CANDIDATE_ROWS; offset += SUPABASE_MAX_ROWS) {
        const { data, error } = await buildQuery(offset);
        if (error) throw new Error(`Failed to fetch candidate pool: ${error.message}`);
        const page = ((data as unknown as PoolQuestion[]) || []).filter(Boolean);
        rows = rows.concat(page);
        if (page.length < SUPABASE_MAX_ROWS) break;
    }

    const topicMap = config.selectedTopicsByChapter || {};
    const hasTopicConstraint = !config.fullSyllabus && Object.values(topicMap).some((t) => (t || []).length > 0);
    if (hasTopicConstraint) {
        rows = rows.filter((q) => {
            const allowed = topicMap[q.chapter || ""] || [];
            return !allowed.length || allowed.includes(q.topic || "");
        });
    }

    const subtopicMap = config.selectedSubtopicsByTopic || {};
    const hasSubtopicConstraint = Object.values(subtopicMap).some((t) => (t || []).length > 0);
    if (hasSubtopicConstraint) {
        rows = rows.filter((q) => {
            const allowed = subtopicMap[q.topic || ""] || [];
            return !allowed.length || allowed.includes(q.subtopic || "");
        });
    }

    if (config.avoidBatchNames?.length) {
        const avoid = new Set(config.avoidBatchNames);
        rows = rows.filter((q) => !(q.used_in_exam || []).some((b) => avoid.has(b)));
    }

    return rows;
}

interface PickOptions {
    preferredSources?: Set<string>;
    chapterTargets?: Record<string, number>;
    chapterPicked?: Record<string, number>;
    /**
     * Treat chapterTargets as a hard cap rather than a preference.
     *
     * The automatic balance only nudges (a chapter over its share scores lower but
     * can still be picked, which is what keeps a paper full when the pool is thin).
     * A blueprint the user typed is different: "4 from Gravitation" must not
     * quietly become 6, and a chapter they set to 0 — or never listed — must not
     * appear at all.
     */
    strictChapters?: boolean;
}

function pickQuestionsFromPool(
    pool: PoolQuestion[],
    requiredCount: number,
    globalUsed: Set<string>,
    sourcePercentages: Record<string, number>,
    difficultyPercentages: Record<"Easy" | "Medium" | "Hard", number>,
    options: PickOptions = {}
): PoolQuestion[] {
    const available = pool.filter((q) => !globalUsed.has(q.unique_id));
    if (!available.length || requiredCount <= 0) return [];

    const count = Math.min(requiredCount, available.length);
    const sourceTargets = allocateTargets(count, sourcePercentages);
    const difficultyTargets = allocateTargets(count, difficultyPercentages);

    const selected: PoolQuestion[] = [];
    const sourcePicked: Record<string, number> = {};
    const difficultyPicked: Record<string, number> = {};
    const chapterPicked = options.chapterPicked || {};
    const preferredSources = options.preferredSources;
    const chapterTargets = options.chapterTargets || {};
    const strictChapters = options.strictChapters === true;

    for (let i = 0; i < count; i++) {
        let bestIdx = -1;
        let bestScore = -Infinity;
        const hasPreferredSources =
            !!preferredSources && preferredSources.size > 0 && available.some((q) => preferredSources.has(q.source || ""));

        for (let idx = 0; idx < available.length; idx++) {
            const q = available[idx];
            if (selected.some((s) => s.unique_id === q.unique_id)) continue;
            const source = q.source || "";
            if (hasPreferredSources && preferredSources && !preferredSources.has(source)) continue;
            const difficulty = bucketDifficulty(q.difficulty_level);
            const chapter = q.chapter || "";

            const sourceNeed = (sourceTargets[source] || 0) - (sourcePicked[source] || 0);
            const diffNeed = (difficultyTargets[difficulty] || 0) - (difficultyPicked[difficulty] || 0);
            const chapterNeed = (chapterTargets[chapter] || 0) - (chapterPicked[chapter] || 0);
            // A typed blueprint is a cap, not a hint: skip anything from a chapter
            // that is full, or from one the user didn't ask for at all.
            if (strictChapters && chapterNeed <= 0) continue;

            let score = Math.random() * 0.2;
            score += sourceNeed > 0 ? 0.9 : 0;
            score += diffNeed > 0 ? 0.45 : 0;
            score += chapterNeed > 0 ? 1.5 : -0.05;
            score += (sourcePercentages[source] || 0) / 200;

            if (score > bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        }

        if (bestIdx === -1) break;
        const pick = available.splice(bestIdx, 1)[0];
        selected.push(pick);
        sourcePicked[pick.source || ""] = (sourcePicked[pick.source || ""] || 0) + 1;
        const diffKey = bucketDifficulty(pick.difficulty_level);
        difficultyPicked[diffKey] = (difficultyPicked[diffKey] || 0) + 1;
        chapterPicked[pick.chapter || ""] = (chapterPicked[pick.chapter || ""] || 0) + 1;
    }

    return selected;
}

/**
 * Fill an approved manual plan, one slot at a time.
 *
 * A slot names an exact combination, and the pool does not always hold one. So
 * rather than returning nothing, each slot relaxes in the order the user would:
 * source first (least important to what the question tests), then topic, then
 * difficulty — never the chapter, which is the syllabus and is not negotiable.
 * Every relaxation is reported, so the paper that comes back is never quietly
 * different from the plan that was approved.
 */
function pickByPlan(
    pool: PoolQuestion[],
    slots: PlanSlot[],
    globalUsed: Set<string>
): { picks: { slot: PlanSlot; question: PoolQuestion }[]; notes: string[]; unfilled: PlanSlot[] } {
    const picks: { slot: PlanSlot; question: PoolQuestion }[] = [];
    const notes: string[] = [];
    // Returned rather than reported here: the caller may still fill these with a
    // seed of another type, and only a slot that stays empty deserves a note.
    const unfilled: PlanSlot[] = [];
    const available = pool.filter((q) => !globalUsed.has(q.unique_id));

    const take = (idx: number) => available.splice(idx, 1)[0];

    for (const slot of slots) {
        const inChapter = available
            .map((q, idx) => ({ q, idx }))
            .filter((c) => (c.q.chapter || "") === slot.chapter);
        if (inChapter.length === 0) {
            unfilled.push(slot);
            continue;
        }

        const matchesTopic = (q: PoolQuestion) => !slot.topic || (q.topic || "") === slot.topic;
        const matchesDiff = (q: PoolQuestion) => bucketDifficulty(q.difficulty_level) === slot.difficulty;
        const matchesSource = (q: PoolQuestion) => !slot.source || (q.source || "") === slot.source;

        const levels: { test: (q: PoolQuestion) => boolean; note: string }[] = [
            { test: (q) => matchesTopic(q) && matchesDiff(q) && matchesSource(q), note: "" },
            { test: (q) => matchesTopic(q) && matchesDiff(q), note: "a different source" },
            { test: (q) => matchesDiff(q), note: "a different topic" },
            { test: () => true, note: "a different difficulty" },
        ];

        let chosen: { q: PoolQuestion; idx: number } | null = null;
        let note = "";
        for (const level of levels) {
            const hits = inChapter.filter((c) => level.test(c.q));
            if (hits.length === 0) continue;
            chosen = hits[Math.floor(Math.random() * hits.length)];
            note = level.note;
            break;
        }
        if (!chosen) continue;

        if (note) {
            const wanted = [slot.topic, slot.difficulty, slot.source].filter(Boolean).join(" / ");
            notes.push(
                `Q${slot.index} (${slot.subject} / ${slot.chapter}): asked for ${wanted} but the pool had none — ` +
                    `filled with ${note} from the same chapter.`
            );
        }
        picks.push({ slot, question: chosen.q });
        take(chosen.idx);
    }

    return { picks, notes, unfilled };
}

function unfilledNote(slot: PlanSlot): string {
    return (
        `Q${slot.index} (${slot.subject} / ${slot.questionType} / ${slot.chapter}): no question left in ` +
        `that chapter after the other filters — the slot is unfilled.`
    );
}

/**
 * Select a pool of qbg_question_pool rows matching `config`, and WRITE
 * `used_in_exam` immediately (append config.batchName) for every selected id —
 * per the confirmed decision, there is no separate "finalize" step in this
 * feature; pool selection is itself one of the pipeline's stages.
 */
export async function selectPool(config: PoolSelectionConfig): Promise<PoolSelectionResult> {
    const warnings: string[] = [];
    const sourcePercentages = normalizeSourcePercentages(config.sourcePreferences || []);
    const preferredSources = Object.keys(sourcePercentages).length ? new Set(Object.keys(sourcePercentages)) : undefined;
    const difficultyPercentages = normalizeDifficultyDistribution(config.difficultyDistribution);

    const requirements = resolveRequirements(config);
    if (!requirements.length) {
        return { uniqueIds: [], rows: [], poolMeta: { requested: 0, selected: 0, byRequirement: [] }, warnings: ["No subject/question-type requirements resolved from the given exam preset/config."] };
    }

    const globalUsed = new Set<string>();
    const allSelected: PoolQuestion[] = [];
    const byRequirement: PoolSelectionResult["poolMeta"]["byRequirement"] = [];
    const typeConversions: TypeConversion[] = [];
    // A seed can only become a type the reframe knows how to write.
    const canSeed = (wanted: string) => !!config.allowTypeSeeds && toReframeType(wanted) !== null;
    const seedPools = new Map<string, PoolQuestion[]>();
    const seedPool = async (req: SubjectRequirement, type: string) => {
        const key = `${req.subject}||${req.paper || ""}||${type}`;
        if (!seedPools.has(key)) seedPools.set(key, await fetchCandidatePool(config, req, type));
        return seedPools.get(key)!;
    };
    const noteConversion = (q: PoolQuestion, wanted: string) => {
        typeConversions.push({
            uniqueId: q.unique_id,
            fromType: q.question_type || "",
            toType: wanted,
            reframeType: toReframeType(wanted)!,
        });
    };

    // An approved manual plan replaces the weighted picker entirely: each slot
    // is filled on its own terms and the paper comes back in the planned order.
    const plan = (config.paperPlan || []).filter((sl) => sl && sl.subject && sl.chapter);
    if (plan.length > 0) {
        const planned: { index: number; question: PoolQuestion }[] = [];
        for (const req of requirements) {
            for (const qt of req.questionTypes) {
                const slots = plan.filter(
                    (sl) =>
                        sl.subject === req.subject &&
                        (sl.paper || "") === (req.paper || "") &&
                        sl.questionType === qt.type
                );
                if (slots.length === 0) continue;
                const pool = await fetchCandidatePool(config, req, qt.type);
                const { picks, notes, unfilled } = pickByPlan(pool, slots, globalUsed);
                picks.forEach((pk) => {
                    globalUsed.add(pk.question.unique_id);
                    planned.push({ index: pk.slot.index, question: pk.question });
                });
                warnings.push(...notes);

                // A slot the pool holds no question of this TYPE for can still be
                // filled from the same chapter with another type, as a seed the
                // Modify stage rewrites into the type the plan asked for.
                let left = unfilled;
                let seeded = 0;
                if (left.length && canSeed(qt.type)) {
                    for (const seedType of seedTypesFor(qt.type)) {
                        if (!left.length) break;
                        const res = pickByPlan(await seedPool(req, seedType), left, globalUsed);
                        res.picks.forEach((pk) => {
                            globalUsed.add(pk.question.unique_id);
                            planned.push({ index: pk.slot.index, question: pk.question });
                            noteConversion(pk.question, qt.type);
                        });
                        seeded += res.picks.length;
                        warnings.push(...res.notes);
                        left = res.unfilled;
                    }
                    if (seeded) {
                        warnings.push(
                            `${req.subject} / ${qt.type}: ${seeded} planned slot(s) had no ${qt.type} question in ` +
                                `their chapter — filled with other-type questions as seeds, which Modify rewrites as ${qt.type}.`
                        );
                    }
                }
                if (!pool.length && !seeded) {
                    warnings.push(
                        `No candidates found for ${req.subject} / ${qt.type} — ${slots.length} planned slot(s) unfilled.`
                    );
                } else {
                    warnings.push(...left.map(unfilledNote));
                }
                byRequirement.push({
                    subject: req.subject,
                    type: qt.type,
                    requested: slots.length,
                    selected: picks.length + seeded,
                    ...(seeded ? { seeded } : {}),
                });
            }
        }
        planned.sort((a, b) => a.index - b.index);
        const plannedRows = planned.map((p) => p.question);
        const plannedIds = plannedRows.map((q) => q.unique_id);
        if (plannedIds.length < plan.length) {
            warnings.push(
                `The plan asked for ${plan.length} question(s); ${plannedIds.length} could be filled from the pool.`
            );
        }
        const names = (config.batchNames || []).map((n) => n.trim()).filter(Boolean);
        if (plannedIds.length && names.length) await writeUsedInExam(plannedIds, names);
        return {
            uniqueIds: plannedIds,
            rows: plannedRows,
            poolMeta: {
                requested: plan.length,
                selected: plannedIds.length,
                byRequirement,
            },
            warnings,
            typeConversions,
        };
    }

    for (const req of requirements) {
        // A manual chapter blueprint is a property of the SUBJECT's paper, not of
        // one question type, so the running tally is shared across this subject's
        // types: "8 from Rotational Motion" means 8 in total, however they split
        // between SCQ and Numerical.
        const manual = manualChapterTargets(config, req.subject);
        const subjectChapterPicked: Record<string, number> = {};
        const subjectQuota = req.questionTypes.reduce((s, qt) => s + Math.max(0, qt.count), 0);
        if (manual) {
            const asked = Object.values(manual).reduce((s, n) => s + n, 0);
            if (asked !== subjectQuota) {
                warnings.push(
                    `${req.subject}: your per-chapter counts add up to ${asked}, but this paper asks for ` +
                        `${subjectQuota} question(s) from ${req.subject}. The chapter counts are used as the ` +
                        `blueprint and the paper size follows the preset, so some chapters may come up short or over.`
                );
            }
        }

        // Every type takes its OWN questions first. Seeds for a short type are only
        // picked after that, so a seed never takes a question some other type of
        // this subject needed for its own quota.
        const perType: { qt: { type: string; count: number }; picked: PoolQuestion[]; poolEmpty: boolean }[] = [];
        for (const qt of req.questionTypes) {
            if (qt.count <= 0) continue;
            const pool = await fetchCandidatePool(config, req, qt.type);
            let picked: PoolQuestion[] = [];
            if (pool.length) {
                const chapterTargets = manual || balanceChaptersForPool(pool, qt.count);
                picked = pickQuestionsFromPool(pool, qt.count, globalUsed, sourcePercentages, difficultyPercentages, {
                    preferredSources,
                    chapterTargets,
                    strictChapters: !!manual,
                    // Auto keeps its per-type tally (each type spread evenly on its own);
                    // manual shares one tally so a chapter's quota isn't spent twice.
                    chapterPicked: manual ? subjectChapterPicked : {},
                });
                picked.forEach((q) => globalUsed.add(q.unique_id));
            }
            perType.push({ qt, picked, poolEmpty: !pool.length });
        }

        for (const { qt, picked, poolEmpty } of perType) {
            const seeds: PoolQuestion[] = [];
            let short = qt.count - picked.length;
            if (short > 0 && canSeed(qt.type)) {
                // Same chapter / class / category / batch filters, any other type —
                // the question is rewritten, so what it contributes is its concept.
                for (const seedType of seedTypesFor(qt.type)) {
                    if (short <= 0) break;
                    const avail = (await seedPool(req, seedType)).filter((q) => !globalUsed.has(q.unique_id));
                    if (!avail.length) continue;
                    const got = pickQuestionsFromPool(avail, short, globalUsed, sourcePercentages, difficultyPercentages, {
                        preferredSources,
                        chapterTargets: manual || balanceChaptersForPool(avail, short),
                        strictChapters: !!manual,
                        chapterPicked: manual ? subjectChapterPicked : {},
                    });
                    got.forEach((q) => {
                        globalUsed.add(q.unique_id);
                        noteConversion(q, qt.type);
                    });
                    seeds.push(...got);
                    short -= got.length;
                }
            }

            // Seeds sit right after their type's own questions, so the paper keeps
            // its subject -> type order.
            allSelected.push(...picked, ...seeds);
            const selected = picked.length + seeds.length;
            byRequirement.push({
                subject: req.subject,
                type: qt.type,
                requested: qt.count,
                selected,
                ...(seeds.length ? { seeded: seeds.length } : {}),
            });
            if (poolEmpty && !seeds.length) {
                warnings.push(`No candidates found for ${req.subject} / ${qt.type} (chapter/topic/class/category filters may be too narrow).`);
            } else if (selected < qt.count) {
                warnings.push(`${req.subject} / ${qt.type}: only found ${selected} of ${qt.count} requested (pool exhausted after filters).`);
            }
            if (seeds.length) {
                warnings.push(
                    `${req.subject} / ${qt.type}: the pool had ${picked.length} of ${qt.count} — ${seeds.length} more ` +
                        `taken from other question types as seeds, which Modify rewrites as ${qt.type}.`
                );
            }
        }

        // Report any chapter the pool couldn't satisfy — silently returning fewer
        // questions from a chapter the user explicitly asked for would misrepresent
        // the blueprint they built.
        if (manual) {
            for (const [chapter, want] of Object.entries(manual)) {
                const got = subjectChapterPicked[chapter] || 0;
                if (got < want) {
                    warnings.push(
                        `${req.subject} / ${chapter}: asked for ${want} question(s) but only ${got} matched ` +
                            `the other filters (class, source, difficulty, avoided batches).`
                    );
                }
            }
        }
    }

    const uniqueIds = allSelected.map((q) => q.unique_id);
    const batchNames = (config.batchNames || []).map((n) => n.trim()).filter(Boolean);
    if (uniqueIds.length && batchNames.length) {
        await writeUsedInExam(uniqueIds, batchNames);
    }

    return {
        uniqueIds,
        rows: allSelected,
        poolMeta: {
            requested: byRequirement.reduce((s, r) => s + r.requested, 0),
            selected: uniqueIds.length,
            byRequirement,
        },
        warnings,
        typeConversions,
    };
}

/** Append every name in `batchNames` to used_in_exam for every id (dedup,
 *  idempotent, one read+write pass per row regardless of how many names). */
async function writeUsedInExam(uniqueIds: string[], batchNames: string[]): Promise<void> {
    for (const chunk of chunkArray(uniqueIds, 200)) {
        const { data, error } = await db().from(POOL_TABLE).select("unique_id, used_in_exam").in("unique_id", chunk);
        if (error) throw new Error(`Failed to read used_in_exam before write: ${error.message}`);
        const rows = (data as unknown as { unique_id: string; used_in_exam: string[] | null }[]) || [];
        await Promise.all(
            rows.map((r) => {
                const current = r.used_in_exam || [];
                const missing = batchNames.filter((n) => !current.includes(n));
                if (!missing.length) return null;
                return db()
                    .from(POOL_TABLE)
                    .update({ used_in_exam: [...current, ...missing] })
                    .eq("unique_id", r.unique_id);
            })
        );
    }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export interface PoolFilterOptions {
    subjects: string[];
    classLevels: string[];
    categories: string[];
    sources: string[];
    questionTypes: string[];
    chaptersBySubject: Record<string, string[]>;
    /** class_level -> subject -> chapters, for the class-aware chapter picker
     *  (only chapters that actually exist for the selected class). */
    chaptersBySubjectClass: Record<string, Record<string, string[]>>;
    topicsByChapter: Record<string, string[]>;
    subtopicsByTopic: Record<string, string[]>;
    batchNames: string[];
}

/** Cascading distinct-value lookups for the pool config UI's filter menu,
 *  computed server-side via the qbg_pool_filter_options() SQL function
 *  (scripts/sql/create_qbg_pool_filters_fn.sql) rather than paginating the
 *  whole ~27k-row table into Node on every request. */
/**
 * Put one subject's chapters into textbook order.
 *
 * The SQL function returns them alphabetically, which put "Alternating Current"
 * (a class-12 chapter) above "Mathematical Tools and Vectors" (the first chapter
 * of class 11) and made the picker impossible to read against a syllabus
 * (2026-08-31 bug report). compareChaptersBySubject places every chapter the
 * book sequence knows in its real position and leaves the rest alphabetical
 * after them — unlike sortChaptersForSubject it never invents chapters the pool
 * has no questions for, which in a FILTER list would be a dead option.
 */
function inBookOrder(subject: string, chapters: string[]): string[] {
    return [...chapters].sort((a, b) => compareChaptersBySubject(subject, a, b));
}

export async function getPoolFilterOptions(): Promise<PoolFilterOptions> {
    const { data, error } = await db().rpc("qbg_pool_filter_options");
    if (error) throw new Error(`Failed to load pool filter options: ${error.message}`);
    const d = (data as Record<string, unknown>) || {};

    const bySubject = (d.chaptersBySubject as Record<string, string[]>) || {};
    const orderedBySubject: Record<string, string[]> = {};
    for (const [subject, chapters] of Object.entries(bySubject)) {
        orderedBySubject[subject] = inBookOrder(subject, chapters || []);
    }

    const byClass = (d.chaptersBySubjectClass as Record<string, Record<string, string[]>>) || {};
    const orderedByClass: Record<string, Record<string, string[]>> = {};
    for (const [cls, subjects] of Object.entries(byClass)) {
        orderedByClass[cls] = {};
        for (const [subject, chapters] of Object.entries(subjects || {})) {
            orderedByClass[cls][subject] = inBookOrder(subject, chapters || []);
        }
    }

    return {
        subjects: (d.subjects as string[]) || [],
        classLevels: (d.classLevels as string[]) || [],
        categories: (d.categories as string[]) || [],
        sources: (d.sources as string[]) || [],
        questionTypes: (d.questionTypes as string[]) || [],
        chaptersBySubject: orderedBySubject,
        chaptersBySubjectClass: orderedByClass,
        topicsByChapter: (d.topicsByChapter as Record<string, string[]>) || {},
        subtopicsByTopic: (d.subtopicsByTopic as Record<string, string[]>) || {},
        batchNames: (d.batchNames as string[]) || [],
    };
}
