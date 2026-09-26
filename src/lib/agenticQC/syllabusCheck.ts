/**
 * Per-question syllabus enforcement for Agentic QC.
 *
 * The paper-level path already asked a model for a "syllabusAnalysis" paragraph.
 * The per-question path did not check syllabus at all — it set syllabusAnalysis
 * to "" — so a paper limited to "Electric Charges and Fields" could contain a
 * capacitance question and QC would pass it (2026-09-03 request).
 *
 * Two halves, and they do different jobs:
 *
 *   buildSyllabusPromptBlock  gives the agent the CONCEPT inventory of each
 *                             allowed chapter, so it can judge a question by what
 *                             it actually tests rather than by its label. Chapter
 *                             names alone are not enough: "Electric Charges and
 *                             Fields" does not tell a model that capacitance
 *                             belongs to the NEXT chapter.
 *
 *   findSyllabusViolations    checks the chapter the question is TAGGED with, and
 *                             the chapter the agents say it actually tests,
 *                             against the allowed list — deterministic, so a
 *                             violation cannot be talked away.
 */
import { chapterKey } from "@/lib/chapterOrder";

export interface SyllabusScope {
    /** subject -> chapters the paper is allowed to cover. Empty = unrestricted. */
    chaptersBySubject: Record<string, string[]>;
    /** "subject||chapter" (lowercased) -> topics inside that chapter. */
    topicsByChapter?: Record<string, string[]>;
}

export interface SyllabusViolation {
    questionNumber: number;
    /** The chapter the question was found to belong to. */
    chapter: string;
    subject: string;
    /** "tagged" = the source metadata; "detected" = what the QC agents concluded. */
    basis: "tagged" | "detected";
    message: string;
}

function norm(s: string | null | undefined): string {
    return chapterKey(String(s || ""));
}

/** True when this scope actually restricts anything. */
export function hasRestriction(scope: SyllabusScope | null | undefined): boolean {
    if (!scope) return false;
    return Object.values(scope.chaptersBySubject || {}).some((c) => (c || []).length > 0);
}

/**
 * The syllabus section of the agent prompt: every allowed chapter with the
 * concepts it contains, plus the instruction to judge by concept, not by label.
 *
 * Topic lists are capped per chapter — the point is to convey the chapter's
 * scope, and an unbounded dump would crowd out the question itself.
 */
export function buildSyllabusPromptBlock(scope: SyllabusScope, maxTopicsPerChapter = 18): string {
    if (!hasRestriction(scope)) return "";
    const lines: string[] = [
        "## SYLLABUS — HARD CONSTRAINT",
        "This paper may ONLY test the chapters listed below. A question whose core concept",
        "belongs to any other chapter is OUT OF SYLLABUS, even if it is well written and",
        "even if its printed tag claims otherwise. Judge by the concept the question",
        "actually requires, not by its label.",
    ];
    for (const [subject, chapters] of Object.entries(scope.chaptersBySubject || {})) {
        const list = (chapters || []).filter(Boolean);
        if (list.length === 0) continue;
        lines.push("", `${subject} — allowed chapters and the concepts inside them:`);
        for (const chapter of list) {
            const topics = scope.topicsByChapter?.[`${subject.toLowerCase()}||${chapter.toLowerCase()}`] || [];
            if (topics.length > 0) {
                const shown = topics.slice(0, maxTopicsPerChapter);
                const more = topics.length > shown.length ? `, …(+${topics.length - shown.length} more)` : "";
                lines.push(`  • ${chapter}: ${shown.join("; ")}${more}`);
            } else {
                lines.push(`  • ${chapter}`);
            }
        }
    }
    lines.push(
        "",
        "Anything NOT covered by the concepts above is out of syllabus. Report it as an",
        'error item beginning "MAJOR: out of syllabus —" and name the chapter the question',
        "really belongs to. Also fill outOfSyllabus and detectedChapter in your JSON."
    );
    return lines.join("\n");
}

/** All allowed chapters, keyed for spelling-insensitive comparison. */
function allowedKeys(scope: SyllabusScope): { bySubject: Map<string, Set<string>>; any: Set<string> } {
    const bySubject = new Map<string, Set<string>>();
    const any = new Set<string>();
    for (const [subject, chapters] of Object.entries(scope.chaptersBySubject || {})) {
        const set = new Set<string>();
        for (const c of chapters || []) {
            if (!c) continue;
            set.add(norm(c));
            any.add(norm(c));
        }
        if (set.size > 0) bySubject.set(subject.trim().toLowerCase(), set);
    }
    return { bySubject, any };
}

export interface SyllabusCandidate {
    questionNumber: number;
    subject?: string;
    /** Chapter from the source metadata. */
    taggedChapter?: string;
    /** Chapter the QC agents concluded the question really tests, if any. */
    detectedChapter?: string;
}

/**
 * Questions outside the allowed chapters.
 *
 * A question is judged on BOTH what it is tagged as and what QC decided it
 * actually tests, because the two fail differently: a wrong tag hides an
 * in-syllabus question, and a right tag can hide an out-of-syllabus question.
 * Either being outside the list is reported.
 */
export function findSyllabusViolations(
    scope: SyllabusScope,
    rows: SyllabusCandidate[]
): SyllabusViolation[] {
    if (!hasRestriction(scope)) return [];
    const { bySubject, any } = allowedKeys(scope);

    const out: SyllabusViolation[] = [];
    for (const r of rows) {
        const subjKey = (r.subject || "").trim().toLowerCase();
        const allowed = bySubject.get(subjKey) || any;

        // Prefer what QC concluded; fall back to the printed tag.
        const detected = (r.detectedChapter || "").trim();
        const tagged = (r.taggedChapter || "").trim();
        const chapter = detected || tagged;
        if (!chapter) continue;
        if (allowed.has(norm(chapter))) continue;

        const basis: "tagged" | "detected" = detected ? "detected" : "tagged";
        out.push({
            questionNumber: r.questionNumber,
            chapter,
            subject: r.subject || "",
            basis,
            message:
                `MAJOR: Q${r.questionNumber} is OUT OF SYLLABUS — it belongs to "${chapter}"` +
                `${r.subject ? ` (${r.subject})` : ""}, which is not among this paper's chapters` +
                `${basis === "detected" ? " (identified from the question's own content)" : " (per its tag)"}.`,
        });
    }
    return out;
}

/** Group violations by the offending chapter, worst first. */
export function groupViolations(
    items: SyllabusViolation[]
): { chapter: string; subject: string; questionNumbers: number[] }[] {
    const by = new Map<string, { chapter: string; subject: string; questionNumbers: number[] }>();
    for (const v of items) {
        const key = `${v.subject}||${norm(v.chapter)}`;
        const row = by.get(key) || { chapter: v.chapter, subject: v.subject, questionNumbers: [] };
        row.questionNumbers.push(v.questionNumber);
        by.set(key, row);
    }
    return [...by.values()].sort((a, b) => b.questionNumbers.length - a.questionNumbers.length);
}
