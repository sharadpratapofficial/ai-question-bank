/**
 * Repetition detection across a paper.
 *
 * Four things a reviewer cares about, in descending severity:
 *
 *   EXACT      the same question twice, word for word
 *   TEMPLATE   the same question with only the numbers swapped — the classic
 *              "changed the data and called it a new question"
 *   NEAR       heavily overlapping wording (a reworded twin)
 *   CONCEPT    different wording, same chapter+topic and the same ask — over-
 *              testing one concept at the cost of syllabus coverage
 *
 * Deliberately deterministic. An LLM reviewing one question at a time cannot see
 * that Q7 and Q31 are the same question with different numbers; that is a
 * whole-paper property, and comparing every pair is cheap here (n² on a few
 * hundred short strings) while an extra LLM pass over the cross-product is not.
 */

export interface DupInput {
    questionNumber: number;
    questionText: string;
    subject?: string;
    chapter?: string;
    topic?: string;
    options?: { text: string }[];
}

export type DuplicateKind = "EXACT" | "TEMPLATE" | "NEAR" | "CONCEPT";

export interface DuplicateFinding {
    kind: DuplicateKind;
    questionNumbers: number[];
    similarity: number;
    /** Present for TEMPLATE: the values that differ between the twins. */
    changedValues?: string[];
    message: string;
}

/** Strip markup and collapse whitespace. */
function plain(html: string): string {
    return String(html || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Words only, lowercased — the comparison unit for wording similarity. */
function words(text: string): string[] {
    return plain(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s.]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
}

const NUMBER = /-?\d+(?:\.\d+)?/g;

/**
 * The question with every number replaced by a placeholder.
 *
 * Two questions sharing a skeleton are the same question template — this is what
 * catches "only the data changed", which no amount of wording similarity will
 * reliably separate from a genuinely different question.
 */
export function skeleton(text: string): string {
    return plain(text).toLowerCase().replace(NUMBER, "#").replace(/\s+/g, " ").trim();
}

function numbersIn(text: string): string[] {
    return plain(text).match(NUMBER) || [];
}

/** Jaccard overlap of the two word sets — 0 (nothing shared) to 1 (identical). */
function similarity(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const sa = new Set(a);
    const sb = new Set(b);
    let shared = 0;
    for (const w of sa) if (sb.has(w)) shared++;
    return shared / (sa.size + sb.size - shared);
}

/** Wording overlap high enough to call two questions twins. */
const NEAR_THRESHOLD = 0.75;
/** Overlap at which two questions on the same topic are "the same ask". */
const CONCEPT_THRESHOLD = 0.5;
/** A skeleton shorter than this is too generic to prove anything. */
const MIN_SKELETON_WORDS = 6;

function label(q: DupInput): string {
    const bits = [q.chapter, q.topic].filter(Boolean);
    return bits.length ? ` (${bits.join(" › ")})` : "";
}

/**
 * Compare every pair once and report the strongest relationship for each.
 * A pair is reported under one kind only — the most severe that applies.
 */
export function detectDuplicates(rows: DupInput[]): DuplicateFinding[] {
    const prepared = rows.map((r) => {
        const full = [plain(r.questionText), ...(r.options || []).map((o) => plain(o.text))]
            .filter(Boolean)
            .join(" ");
        return {
            row: r,
            full,
            words: words(full),
            skeleton: skeleton(full),
            skeletonWords: skeleton(full).split(" ").filter(Boolean).length,
            numbers: numbersIn(full),
            norm: plain(full).toLowerCase(),
        };
    });

    const findings: DuplicateFinding[] = [];

    for (let i = 0; i < prepared.length; i++) {
        for (let j = i + 1; j < prepared.length; j++) {
            const a = prepared[i];
            const b = prepared[j];
            if (!a.norm || !b.norm) continue;

            const nums = [a.row.questionNumber, b.row.questionNumber];
            const sim = similarity(a.words, b.words);

            if (a.norm === b.norm) {
                findings.push({
                    kind: "EXACT",
                    questionNumbers: nums,
                    similarity: 1,
                    message:
                        `MAJOR: Q${nums[0]} and Q${nums[1]} are the SAME question, word for word` +
                        `${label(a.row)}. Replace one of them.`,
                });
                continue;
            }

            // Same skeleton = same question, different numbers.
            if (
                a.skeletonWords >= MIN_SKELETON_WORDS &&
                a.skeleton === b.skeleton &&
                a.numbers.join(",") !== b.numbers.join(",")
            ) {
                const changed: string[] = [];
                for (let k = 0; k < Math.max(a.numbers.length, b.numbers.length); k++) {
                    const x = a.numbers[k];
                    const y = b.numbers[k];
                    if (x !== y) changed.push(`${x ?? "—"} → ${y ?? "—"}`);
                }
                findings.push({
                    kind: "TEMPLATE",
                    questionNumbers: nums,
                    similarity: sim,
                    changedValues: changed,
                    message:
                        `MAJOR: Q${nums[0]} and Q${nums[1]} are the same question with only the data ` +
                        `changed${label(a.row)} — identical wording and structure, differing values: ` +
                        `${changed.slice(0, 5).join("; ")}. They test nothing new; replace one.`,
                });
                continue;
            }

            if (sim >= NEAR_THRESHOLD) {
                findings.push({
                    kind: "NEAR",
                    questionNumbers: nums,
                    similarity: sim,
                    message:
                        `MODERATE: Q${nums[0]} and Q${nums[1]} are near-duplicates ` +
                        `(${Math.round(sim * 100)}% wording overlap)${label(a.row)} — reworded twins ` +
                        `rather than distinct questions.`,
                });
                continue;
            }

            // Same concept: same chapter AND topic, and the wording still overlaps
            // enough that they are asking the same thing a second time. Requiring
            // BOTH keeps legitimate repeated practice of a chapter from being
            // flagged just for sharing a chapter.
            const sameChapter =
                !!a.row.chapter &&
                a.row.chapter.trim().toLowerCase() === (b.row.chapter || "").trim().toLowerCase();
            const sameTopic =
                !!a.row.topic &&
                a.row.topic.trim().toLowerCase() === (b.row.topic || "").trim().toLowerCase();
            if (sameChapter && sameTopic && sim >= CONCEPT_THRESHOLD) {
                findings.push({
                    kind: "CONCEPT",
                    questionNumbers: nums,
                    similarity: sim,
                    message:
                        `MINOR: Q${nums[0]} and Q${nums[1]} test the same concept in the same way ` +
                        `${label(a.row)} (${Math.round(sim * 100)}% overlap) — consider replacing one ` +
                        `to widen coverage.`,
                });
            }
        }
    }

    const order: Record<DuplicateKind, number> = { EXACT: 0, TEMPLATE: 1, NEAR: 2, CONCEPT: 3 };
    return findings.sort(
        (x, y) => order[x.kind] - order[y.kind] || y.similarity - x.similarity
    );
}
