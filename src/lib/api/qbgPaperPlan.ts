/**
 * The paper blueprint: one row per question the paper will contain, decided
 * BEFORE any question is picked.
 *
 * Auto mode selects questions straight from the pool and the user sees the
 * result. Manual mode shows this plan first — question 1, its type, subject,
 * chapter, topic, difficulty, source, and how many questions the database
 * actually holds for that exact combination — so a slot with zero candidates can
 * be fixed by changing the topic, difficulty or source before the run starts,
 * instead of discovering the shortfall in a warning afterwards.
 *
 * Everything here is deterministic and testable. The DB only supplies the
 * availability counts (see /api/qbg/pipeline/plan-availability).
 */
import { compareChaptersBySubject } from "@/lib/chapterOrder";
import {
    EXAM_PRESETS,
    JEE_ADVANCED_PATTERN_MATRIX,
    type DifficultyDistribution,
    type ExamPreset,
    type JeeAdvancedPaper,
    type QuestionTypeDistributionRow,
    type SourcePreference,
    type SubjectRequirement,
} from "@/types";

export type PlanDifficulty = "Easy" | "Medium" | "Hard";

export interface PlanSlot {
    /** 1-based position in the finished paper. */
    index: number;
    subject: string;
    /** JEE Advanced only — which paper this slot belongs to. */
    paper?: string;
    questionType: string;
    chapter: string;
    /** null = any topic within the chapter. */
    topic: string | null;
    difficulty: PlanDifficulty;
    /** null = any source. */
    source: string | null;
    /** Candidates in the pool for this exact combination; -1 until looked up. */
    available: number;
}

export interface PlanRequirement {
    subject: string;
    paper?: string;
    questionTypes: { type: string; count: number }[];
}

export interface BuildPlanArgs {
    requirements: PlanRequirement[];
    /** subject -> chapters chosen for the paper. */
    chaptersBySubject: Record<string, string[]>;
    /** chapter -> chosen topics (empty = any topic in that chapter). */
    topicsByChapter?: Record<string, string[]>;
    difficultyDistribution: DifficultyDistribution;
    sourcePreferences?: SourcePreference[];
    /** Optional manual per-chapter counts (subject -> chapter -> count). */
    chapterCounts?: Record<string, Record<string, number>>;
}

function clampPct(n: number): number {
    return Math.max(0, Math.min(100, Number(n) || 0));
}

/**
 * Split `total` across `keys` by percentage, giving the leftover to the largest
 * remainders so the parts always sum back to `total`.
 */
export function allocateByPercent(total: number, weights: Record<string, number>): Record<string, number> {
    const keys = Object.keys(weights).filter((k) => weights[k] > 0);
    if (total <= 0 || keys.length === 0) return {};
    const sum = keys.reduce((s, k) => s + weights[k], 0) || 1;
    const exact = keys.map((k) => ({ k, v: (weights[k] / sum) * total }));
    const out: Record<string, number> = {};
    let used = 0;
    for (const e of exact) {
        out[e.k] = Math.floor(e.v);
        used += out[e.k];
    }
    const rest = exact
        .map((e) => ({ k: e.k, frac: e.v - Math.floor(e.v) }))
        .sort((a, b) => b.frac - a.frac);
    let i = 0;
    while (used < total && rest.length > 0) {
        out[rest[i % rest.length].k] += 1;
        used++;
        i++;
    }
    return out;
}

/**
 * Spread `total` questions across `chapters` as evenly as possible.
 *
 * Three chapters and 20 SCQs gives 7/7/6, not 20 from whichever chapter the pool
 * happened to offer first — the point of an equal chapter split. The remainder
 * rotates by `offset` so it doesn't always land on the same chapter across
 * question types (20 SCQ + 5 integer would otherwise both favour chapter 1).
 */
export function splitEvenly(total: number, chapters: string[], offset = 0): Record<string, number> {
    const out: Record<string, number> = {};
    if (total <= 0 || chapters.length === 0) return out;
    const base = Math.floor(total / chapters.length);
    let remainder = total % chapters.length;
    chapters.forEach((c) => (out[c] = base));
    for (let i = 0; i < chapters.length && remainder > 0; i++) {
        out[chapters[(i + offset) % chapters.length]] += 1;
        remainder--;
    }
    return out;
}

function difficultyWeights(d: DifficultyDistribution): Record<PlanDifficulty, number> {
    const easy = clampPct(d?.easyPercent ?? 0);
    const hard = clampPct(d?.hardPercent ?? 0);
    const medium = Math.max(0, 100 - easy - hard);
    return { Easy: easy, Medium: medium, Hard: hard };
}

/** Build the unordered slot list from the paper's configuration. */
export function buildPlanSlots(args: BuildPlanArgs): PlanSlot[] {
    const slots: PlanSlot[] = [];
    const diffW = difficultyWeights(args.difficultyDistribution);
    const srcW: Record<string, number> = {};
    for (const p of args.sourcePreferences || []) {
        if (p.source && p.percent > 0) srcW[p.source] = clampPct(p.percent);
    }

    let typeIndex = 0;
    for (const req of args.requirements) {
        const chapters = [...(args.chaptersBySubject[req.subject] || [])]
            .filter(Boolean)
            .sort((a, b) => compareChaptersBySubject(req.subject, a, b));
        if (chapters.length === 0) continue;

        const manual = args.chapterCounts?.[req.subject];
        const manualTotal = manual
            ? Object.values(manual).reduce((s, n) => s + (Number(n) || 0), 0)
            : 0;

        for (const qt of req.questionTypes) {
            if (qt.count <= 0) continue;
            typeIndex++;

            // Manual per-chapter counts scale to this question type's share;
            // otherwise every chapter gets an equal slice.
            let perChapter: Record<string, number>;
            if (manual && manualTotal > 0) {
                perChapter = allocateByPercent(qt.count, manual);
            } else {
                perChapter = splitEvenly(qt.count, chapters, typeIndex);
            }

            for (const chapter of chapters) {
                const n = perChapter[chapter] || 0;
                if (n <= 0) continue;

                const diffs = allocateByPercent(n, diffW);
                const srcs = Object.keys(srcW).length > 0 ? allocateByPercent(n, srcW) : {};
                const topics = (args.topicsByChapter?.[chapter] || []).filter(Boolean);

                // Expand the per-difficulty and per-source counts into concrete
                // slots, cycling topics so one chapter's questions don't all land
                // on the same topic.
                const diffQueue: PlanDifficulty[] = [];
                (Object.keys(diffs) as PlanDifficulty[]).forEach((d) => {
                    for (let i = 0; i < diffs[d]; i++) diffQueue.push(d);
                });
                while (diffQueue.length < n) diffQueue.push("Medium");

                const srcQueue: (string | null)[] = [];
                Object.keys(srcs).forEach((sname) => {
                    for (let i = 0; i < srcs[sname]; i++) srcQueue.push(sname);
                });
                while (srcQueue.length < n) srcQueue.push(null);

                for (let i = 0; i < n; i++) {
                    slots.push({
                        index: 0, // assigned by orderSlots
                        subject: req.subject,
                        paper: req.paper,
                        questionType: qt.type,
                        chapter,
                        topic: topics.length > 0 ? topics[i % topics.length] : null,
                        difficulty: diffQueue[i],
                        source: srcQueue[i] ?? null,
                        available: -1,
                    });
                }
            }
        }
    }
    return slots;
}

/**
 * Order the slots into the paper the student actually sees.
 *
 * Three rules, in priority order:
 *   1. Open with one or two of the harder questions — a paper that starts on its
 *      easiest question sets the wrong pace.
 *   2. Never place two questions from the same chapter next to each other.
 *   3. Where that is unavoidable (one chapter, or a long tail), at least avoid
 *      putting the same TOPIC together.
 *
 * Subjects and, for JEE Advanced, papers stay in their own blocks: interleaving
 * Physics with Chemistry would not be a real paper.
 */
export function orderSlots(slots: PlanSlot[], openingHardCount = 2): PlanSlot[] {
    const rank: Record<PlanDifficulty, number> = { Hard: 0, Medium: 1, Easy: 2 };

    /**
     * Interleave one block so no two neighbours share a chapter.
     *
     * Always taking the chapter with the MOST remaining slots (never the one just
     * used) is the standard rearrangement strategy, and unlike picking whatever
     * looks best right now it cannot strand a chapter's leftovers at the end —
     * greedy scoring produced six same-chapter neighbours on a 25-question paper
     * purely by exhausting the other chapters too early.
     *
     * Where a chapter must repeat (it holds more than half the block), the tie is
     * broken on topic so at least the concept changes.
     */
    /**
     * Deal `items` out so consecutive picks differ on `keyOf` wherever possible,
     * always drawing from the key with the most remaining. Used twice: once over
     * chapters, then again over topics inside a chapter that has to repeat.
     */
    function spreadBy<T>(items: T[], keyOf: (t: T) => string, prevKey: string | null): T[] {
        const buckets = new Map<string, T[]>();
        for (const it of items) {
            const k = keyOf(it);
            const arr = buckets.get(k) || [];
            arr.push(it);
            buckets.set(k, arr);
        }
        const out: T[] = [];
        let last = prevKey;
        while (out.length < items.length) {
            const live = [...buckets.entries()].filter(([, arr]) => arr.length > 0);
            if (live.length === 0) break;
            let pickable = live.filter(([k]) => k !== last);
            if (pickable.length === 0) pickable = live;
            pickable.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
            const [key, arr] = pickable[0];
            out.push(arr.shift() as T);
            last = key;
        }
        return out;
    }

    function interleave(block: PlanSlot[], prevSlot: PlanSlot | null): PlanSlot[] {
        // Within one chapter, spread its own slots across topics first, so that a
        // chapter forced to repeat at least changes concept between neighbours.
        const byChapter = new Map<string, PlanSlot[]>();
        for (const s of block) {
            const arr = byChapter.get(s.chapter) || [];
            arr.push(s);
            byChapter.set(s.chapter, arr);
        }
        for (const [chapter, arr] of byChapter) {
            byChapter.set(chapter, spreadBy(arr, (s) => String(s.topic || ""), null));
        }

        const out: PlanSlot[] = [];
        let prev: PlanSlot | null = prevSlot;
        while (out.length < block.length) {
            const live = [...byChapter.entries()].filter(([, arr]) => arr.length > 0);
            if (live.length === 0) break;

            // A different chapter to the last one wherever one exists.
            let pickable = live.filter(([chapter]) => !prev || chapter !== prev.chapter);
            if (pickable.length === 0) pickable = live;

            pickable.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
            const topCount = pickable[0][1].length;
            const tied = pickable.filter(([, arr]) => arr.length === topCount);

            // Among equally-loaded chapters prefer one whose next slot also changes
            // topic, so neither dimension repeats when it doesn't have to.
            const chosen =
                tied.find(([, arr]) => !prev || !prev.topic || arr[0].topic !== prev.topic) || tied[0];

            const arr = chosen[1];
            let idx = 0;
            if (prev && prev.chapter === chosen[0] && arr.length > 1) {
                const alt = arr.findIndex((s) => !prev!.topic || s.topic !== prev!.topic);
                if (alt >= 0) idx = alt;
            }
            const next = arr.splice(idx, 1)[0];
            out.push(next);
            prev = next;
        }
        return out;
    }

    // Subject (and, for Advanced, paper) blocks stay intact — interleaving Physics
    // with Chemistry would not be a real paper. Question types stay grouped inside
    // each subject, which is how papers are actually laid out.
    const groups = new Map<string, PlanSlot[]>();
    for (const s of slots) {
        const key = `${s.paper || ""}||${s.subject}`;
        const arr = groups.get(key) || [];
        arr.push(s);
        groups.set(key, arr);
    }

    const out: PlanSlot[] = [];
    let firstGroup = true;
    for (const [, group] of groups) {
        const types: string[] = [];
        for (const s of group) if (!types.includes(s.questionType)) types.push(s.questionType);

        let firstBlock = true;
        for (const type of types) {
            const block = interleave(
                group.filter((s) => s.questionType === type),
                out.length > 0 ? out[out.length - 1] : null
            );

            // The paper opens on its harder questions. Applied only to the very
            // first block of the first subject — pulling a hard question to the
            // front of every block would just re-sort the whole paper by difficulty.
            if (firstGroup && firstBlock && openingHardCount > 0) {
                const hardIdx: number[] = [];
                for (let i = 0; i < block.length && hardIdx.length < openingHardCount; i++) {
                    if (rank[block[i].difficulty] === 0) hardIdx.push(i);
                }
                // Nothing marked Hard? Use the hardest present instead.
                if (hardIdx.length === 0) {
                    const best = block
                        .map((s, i) => ({ i, r: rank[s.difficulty] }))
                        .sort((a, b) => a.r - b.r)
                        .slice(0, openingHardCount)
                        .map((x) => x.i);
                    hardIdx.push(...best);
                }
                const opening = hardIdx.map((i) => block[i]);
                const rest = block.filter((_, i) => !hardIdx.includes(i));
                // Re-interleave the remainder so lifting the opening questions out
                // cannot create a same-chapter neighbour behind them.
                const tail = interleave(rest, opening[opening.length - 1] || null);
                block.length = 0;
                block.push(...opening, ...tail);
            }

            out.push(...block);
            firstBlock = false;
        }
        firstGroup = false;
    }

    return out.map((s, i) => ({ ...s, index: i + 1 }));
}

/** Build and order in one call. */
export function buildPaperPlan(args: BuildPlanArgs): PlanSlot[] {
    return orderSlots(buildPlanSlots(args));
}

// ─── Answer-key balance ────────────────────────────────────────────────

export interface AnswerKeyIssue {
    kind: "run" | "skew";
    message: string;
    /** Question numbers involved. */
    questionNumbers: number[];
}

/**
 * Check the finished paper's answer key.
 *
 * Two faults a student can exploit: a long run of the same option (four Cs in a
 * row reads as a pattern), and an overall skew (half the paper answering B).
 * Three in a row is explicitly allowed — the user's stated tolerance.
 */
export function checkAnswerKeyBalance(
    answers: { questionNumber: number; answer: string | null }[],
    opts: { maxRun?: number; skewTolerance?: number } = {}
): AnswerKeyIssue[] {
    const maxRun = opts.maxRun ?? 3;
    const tolerance = opts.skewTolerance ?? 1.6;
    const issues: AnswerKeyIssue[] = [];

    const clean = answers
        .map((a) => ({ n: a.questionNumber, v: String(a.answer ?? "").trim().toUpperCase() }))
        .filter((a) => a.v !== "");
    if (clean.length === 0) return issues;

    // Runs.
    let runStart = 0;
    for (let i = 1; i <= clean.length; i++) {
        if (i < clean.length && clean[i].v === clean[runStart].v) continue;
        const len = i - runStart;
        if (len > maxRun) {
            const nums = clean.slice(runStart, i).map((a) => a.n);
            issues.push({
                kind: "run",
                questionNumbers: nums,
                message:
                    `MODERATE: option ${clean[runStart].v} is the answer ${len} times in a row ` +
                    `(Q${nums[0]}–Q${nums[nums.length - 1]}). Up to ${maxRun} together is fine; ` +
                    `re-order or swap one of these so the key doesn't read as a pattern.`,
            });
        }
        runStart = i;
    }

    // Overall skew — only meaningful for lettered options.
    const letters = clean.filter((a) => /^[A-D]$/.test(a.v));
    if (letters.length >= 8) {
        const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
        for (const a of letters) counts[a.v]++;
        const expected = letters.length / 4;
        for (const k of ["A", "B", "C", "D"]) {
            if (counts[k] > expected * tolerance) {
                issues.push({
                    kind: "skew",
                    questionNumbers: letters.filter((a) => a.v === k).map((a) => a.n),
                    message:
                        `MINOR: option ${k} is correct ${counts[k]} of ${letters.length} times ` +
                        `(expected about ${Math.round(expected)}). The key is skewed toward ${k}.`,
                });
            }
        }
    }

    return issues;
}

// ─── Requirements (shared with pool selection) ─────────────────────────

const ADVANCE_SUBJECT_ORDER = ["Physics", "Chemistry", "Maths"];

/** The subset of the pool config that decides WHAT the paper must contain. */
export interface RequirementConfig {
    examPreset: ExamPreset;
    jeeAdvancedYear?: string;
    jeeAdvancedPapers?: JeeAdvancedPaper[];
    questionTypeDistribution?: QuestionTypeDistributionRow[];
    questionTypeDistributionByPaper?: Partial<Record<JeeAdvancedPaper, QuestionTypeDistributionRow[]>>;
    selectedSubjects?: string[];
}

/** Dataset subject names that stand in for one canonical preset subject. */
export function subjectAliases(subject: string): string[] {
    if (subject === "Biology") return ["Biology", "Botany", "Zoology"];
    return [subject];
}

function normalizeSubjectName(subject: string): string {
    return subject.trim().toLowerCase();
}

function subjectMatchesRequirement(selectedSubjects: string[], requirement: SubjectRequirement): boolean {
    const aliases = subjectAliases(requirement.subject).map(normalizeSubjectName);
    return selectedSubjects.some((s) => aliases.includes(normalizeSubjectName(s)));
}

function orderAdvanceSubjects(subjects: string[]): string[] {
    const seen = new Set<string>();
    const unique = subjects.filter((s) => {
        const key = s.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return unique.sort((a, b) => {
        const ai = ADVANCE_SUBJECT_ORDER.findIndex((s) => s.toLowerCase() === a.toLowerCase());
        const bi = ADVANCE_SUBJECT_ORDER.findIndex((s) => s.toLowerCase() === b.toLowerCase());
        const av = ai === -1 ? ADVANCE_SUBJECT_ORDER.length : ai;
        const bv = bi === -1 ? ADVANCE_SUBJECT_ORDER.length : bi;
        return av !== bv ? av - bv : a.localeCompare(b);
    });
}

/**
 * Which subject / question-type counts this configuration asks for.
 *
 * Lives here rather than in qbgPoolSelection because BOTH the server (when
 * picking questions) and the browser (when showing the manual plan before the
 * run) need the same answer, and the planner must not drag a database client
 * into the client bundle. qbgPoolSelection re-exports it.
 */
export function resolvePlanRequirements(config: RequirementConfig): SubjectRequirement[] {
    if (config.examPreset === "JEE_ADVANCE") {
        const year = config.jeeAdvancedYear || Object.keys(JEE_ADVANCED_PATTERN_MATRIX)[0];
        const yearPattern = JEE_ADVANCED_PATTERN_MATRIX[year];
        const papers = (config.jeeAdvancedPapers?.length
            ? config.jeeAdvancedPapers
            : ["Paper 1", "Paper 2"]) as JeeAdvancedPaper[];
        const subjects = orderAdvanceSubjects(
            config.selectedSubjects?.length ? config.selectedSubjects : ADVANCE_SUBJECT_ORDER
        );
        const reqs: SubjectRequirement[] = [];
        for (const paper of papers) {
            const override = config.questionTypeDistributionByPaper?.[paper];
            const pattern = override?.length ? override : yearPattern?.[paper] || [];
            for (const subject of subjects) {
                reqs.push({
                    subject,
                    paper,
                    questionTypes: pattern.map((p) => ({ type: p.type, count: p.count })),
                });
            }
        }
        return reqs;
    }

    const basePreset = EXAM_PRESETS[config.examPreset];
    if (!basePreset) return [];

    const presetSubjects: SubjectRequirement[] = config.questionTypeDistribution?.length
        ? basePreset.subjects.map((req) => ({
              ...req,
              questionTypes: config.questionTypeDistribution!.map((row) => ({ type: row.type, count: row.count })),
          }))
        : basePreset.subjects;

    if (!config.selectedSubjects?.length) return presetSubjects;
    return presetSubjects.filter((req) => subjectMatchesRequirement(config.selectedSubjects!, req));
}

// ─── Answer-key rebalancing ────────────────────────────────────────────

/** How one finished question looks to the rebalancer. */
export interface KeyFacts {
    /** "A".."D" for optioned questions; null for numerical ones (not balanced). */
    answer: string | null;
    chapter: string;
    /** Questions may only trade places within the same group (subject + type). */
    group: string;
}

/**
 * Reorder a finished paper so the answer key stops reading as a pattern.
 *
 * Detection alone was not what was asked for: a key with five Cs together has
 * to be FIXED. Shuffling each question's own options would be the other way to
 * do it, but the questions are already pushed to QBG by this point, so the
 * honest lever left is the order they appear in.
 *
 * Only questions of the same subject AND question type ever swap, so the paper
 * keeps its sections; among the candidates, one that also avoids putting two
 * questions from the same chapter together is preferred. Numerical answers are
 * carried along untouched — there is no option letter to balance.
 */
export function rebalanceAnswerKey<T>(
    items: T[],
    read: (item: T) => KeyFacts,
    opts: { maxRun?: number } = {}
): T[] {
    const maxRun = Math.max(1, opts.maxRun ?? 3);
    const out = [...items];

    /** Length of the identical-answer run ending just before `pos`. */
    function runBefore(pos: number, answer: string | null): number {
        if (!answer) return 0;
        let n = 0;
        for (let i = pos - 1; i >= 0; i--) {
            const f = read(out[i]);
            if (f.answer !== answer) break;
            n++;
        }
        return n;
    }

    for (let i = 1; i < out.length; i++) {
        const here = read(out[i]);
        if (!here.answer) continue;
        if (runBefore(i, here.answer) < maxRun) continue;

        // This question would be the (maxRun + 1)th of its option in a row.
        // Look for a later question of the same subject and type that breaks the
        // run, preferring one that also changes chapter from the previous slot.
        const prevChapter = read(out[i - 1]).chapter;
        let fallback = -1;
        let chosen = -1;
        for (let j = i + 1; j < out.length; j++) {
            const cand = read(out[j]);
            if (cand.group !== here.group) continue;
            if (!cand.answer || cand.answer === here.answer) continue;
            if (fallback === -1) fallback = j;
            if (!prevChapter || cand.chapter !== prevChapter) {
                chosen = j;
                break;
            }
        }
        const pick = chosen !== -1 ? chosen : fallback;
        if (pick === -1) continue; // nothing left to trade with — reported, not forced
        const tmp = out[i];
        out[i] = out[pick];
        out[pick] = tmp;
    }

    return out;
}

/** The option letter of a question's correct choice, or null if it has none. */
export function answerLetter(options: { isCorrect?: boolean | null }[]): string | null {
    const idx = options.findIndex((o) => o?.isCorrect === true);
    if (idx < 0 || idx > 25) return null;
    return String.fromCharCode(65 + idx);
}
