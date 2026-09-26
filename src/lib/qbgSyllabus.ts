/**
 * What "the syllabus of this test" means, and how to check work against it.
 *
 * A pipeline run picks chapters in the pool config. Two things then need that
 * same set:
 *
 *   * the REFRAME, which must not invent a question that needs a chapter the
 *     student hasn't been taught (picking "Motion in a Plane" and getting back a
 *     question about force is wrong — Laws of Motion comes later);
 *   * the AUDIT after tagging, which is the only *evidence* of where a question
 *     actually landed: the tagger reports a real chapter per question, so a
 *     question that drifted out of the syllabus shows up there.
 *
 * Chapter order comes from chapterOrder.ts (NCERT sequence), and matching is
 * done through chapterKey() so a spelling difference never counts as a
 * different chapter.
 */
import { chapterKey, SUBJECT_CHAPTER_SEQUENCE } from "@/lib/chapterOrder";

export interface SyllabusScope {
    /** subject -> the chapters the test is drawn from (empty = whole subject). */
    chaptersBySubject: Record<string, string[]>;
    /** True when the run put no chapter restriction on at all. */
    fullSyllabus: boolean;
}

export interface OutOfSyllabusItem {
    qbgId: string;
    /** Where the tagger actually filed it. */
    chapter: string;
    subject: string;
}

/**
 * Chapters a reframed question may legitimately draw on: the selected chapters
 * themselves, PLUS everything before the last of them in the book sequence.
 *
 * That prerequisite tail is the point. A test on Rotational Motion is allowed to
 * use Laws of Motion — students have covered it — but a test that stops at
 * Motion in a Plane is not allowed to use force at all. Chapters the sequence
 * doesn't know are passed through unchanged rather than dropped.
 */
export function permittedChaptersForSubject(subject: string, selected: string[]): string[] {
    const sequence = SUBJECT_CHAPTER_SEQUENCE[subject];
    if (!sequence || sequence.length === 0 || selected.length === 0) return [...selected];

    const orderByKey = new Map(sequence.map((c, i) => [chapterKey(c), i]));
    let furthest = -1;
    for (const c of selected) {
        const idx = orderByKey.get(chapterKey(c));
        if (idx !== undefined && idx > furthest) furthest = idx;
    }
    if (furthest < 0) return [...selected];

    const upTo = sequence.slice(0, furthest + 1);
    const extras = selected.filter((c) => orderByKey.get(chapterKey(c)) === undefined);
    return [...upTo, ...extras];
}

/** The selected chapters themselves — what a question is expected to BE about. */
export function primaryChaptersForSubject(scope: SyllabusScope, subject: string): string[] {
    return scope.chaptersBySubject[subject] || [];
}

/**
 * Questions the tagger filed outside the chapters this test selected.
 *
 * Deliberately judged on the SELECTED chapters, not the prerequisite tail: a
 * question may *use* an earlier chapter, but if it is tagged as belonging to one
 * it has drifted off the syllabus and someone needs to look at it.
 *
 * A run with no chapter restriction, or a question the tagger gave no chapter,
 * is never flagged — there is nothing to compare against.
 */
export function findOutOfSyllabus(
    scope: SyllabusScope,
    tagged: { qbg_id: string | null; ok: boolean; meta?: { chapter_name?: string; subject_name?: string } }[]
): OutOfSyllabusItem[] {
    if (scope.fullSyllabus) return [];

    const allowedBySubject = new Map<string, Set<string>>();
    let anyRestriction = false;
    for (const [subject, chapters] of Object.entries(scope.chaptersBySubject)) {
        if (!chapters || chapters.length === 0) continue;
        anyRestriction = true;
        allowedBySubject.set(subject, new Set(chapters.map(chapterKey)));
    }
    if (!anyRestriction) return [];

    // Any selected chapter, whichever subject it was chosen under — the tagger's
    // subject name can differ from the pool's (Botany/Zoology vs Biology), and a
    // subject mismatch is not what this check is about.
    const allowedAnywhere = new Set<string>();
    for (const set of allowedBySubject.values()) for (const k of set) allowedAnywhere.add(k);

    const out: OutOfSyllabusItem[] = [];
    for (const r of tagged) {
        if (!r.ok || !r.qbg_id) continue;
        const chapter = (r.meta?.chapter_name || "").trim();
        if (!chapter) continue;
        const subject = (r.meta?.subject_name || "").trim();
        const forSubject = allowedBySubject.get(subject);
        const allowed = forSubject ? forSubject.has(chapterKey(chapter)) : allowedAnywhere.has(chapterKey(chapter));
        if (!allowed) out.push({ qbgId: r.qbg_id, chapter, subject });
    }
    return out;
}

export interface LaterChapterUseItem {
    qbgId: string;
    subject: string;
    /** The chapter the tagger filed it under. */
    chapter: string;
    /** Chapters its solution needs that come AFTER what the test allows. */
    laterChapters: string[];
}

/**
 * Questions whose SOLUTION needs a chapter that comes later in the book than the
 * test allows — the case findOutOfSyllabus() cannot see.
 *
 * A question is filed under the chapter it is about, so a spring-and-string
 * problem reframed for a Laws of Motion test is tagged "Laws of Motion" and
 * passes the filed-chapter check — while its solution finds the maximum
 * extension with the work-energy theorem, a chapter the student has not reached
 * (2026-09-22 report). The tagger now lists the chapters a question relies on
 * (meta.chapters_used); this checks each of those against the permitted set,
 * which is the selected chapters plus everything EARLIER in the book. Earlier
 * chapters are fine — that is what "prerequisite" means.
 *
 * `selectedFor` says which chapters count as selected for a question: the
 * pipeline passes the test's chosen chapters, a tool with no chapter selection
 * passes the question's own filed chapter (so "needs something later than what
 * it is filed under" is the rule there). Returning null skips the question.
 *
 * A chapter that is not in the book sequence cannot be placed as earlier or
 * later, so it is never flagged — an unplaceable name is not evidence.
 */
export function findLaterChapterUse(
    tagged: {
        qbg_id: string | null;
        ok: boolean;
        meta?: { chapter_name?: string; subject_name?: string; chapters_used?: string[] };
    }[],
    selectedFor: (subject: string, filedChapter: string) => string[] | null
): LaterChapterUseItem[] {
    const out: LaterChapterUseItem[] = [];
    for (const r of tagged) {
        if (!r.ok || !r.qbg_id) continue;
        const used = r.meta?.chapters_used || [];
        if (used.length === 0) continue;
        const subject = (r.meta?.subject_name || "").trim();
        const chapter = (r.meta?.chapter_name || "").trim();
        const sequence = SUBJECT_CHAPTER_SEQUENCE[subject];
        if (!sequence || sequence.length === 0) continue;
        const selected = selectedFor(subject, chapter);
        if (!selected || selected.length === 0) continue;

        const inBook = new Set(sequence.map(chapterKey));
        const permitted = new Set(permittedChaptersForSubject(subject, selected).map(chapterKey));
        // Nothing selected could be placed in the book: there is no "later" to judge by.
        if (![...permitted].some((k) => inBook.has(k))) continue;

        const later = used.filter((c) => inBook.has(chapterKey(c)) && !permitted.has(chapterKey(c)));
        if (later.length > 0) out.push({ qbgId: r.qbg_id, subject, chapter, laterChapters: later });
    }
    return out;
}

/** Group the flagged questions by the chapter they landed in, worst first. */
export function groupOutOfSyllabus(items: OutOfSyllabusItem[]): { chapter: string; subject: string; ids: string[] }[] {
    const byChapter = new Map<string, { chapter: string; subject: string; ids: string[] }>();
    for (const it of items) {
        const key = `${it.subject}||${it.chapter}`;
        const row = byChapter.get(key) || { chapter: it.chapter, subject: it.subject, ids: [] };
        row.ids.push(it.qbgId);
        byChapter.set(key, row);
    }
    return [...byChapter.values()].sort((a, b) => b.ids.length - a.ids.length);
}
