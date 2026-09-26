/**
 * The taxonomy the AI tagger picks from, read straight out of the bundled table
 * (python/qbg_modification/tagging_data/qbg_tagging_table.csv).
 *
 * Served to the UI rather than hardcoded, because that file is rebuilt by
 * qbg_tag_crawl.py whenever a QBG category's concept tree is (re)crawled — a
 * copy of the category/subject list in the panel would silently drift out of
 * date the first time a category was added.
 *
 * The file is ~8 MB, so it is parsed once per server process and cached. Only
 * the first four columns matter here; topics and subtopics are the sidecar's
 * business.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const TABLE = path.resolve(
    process.cwd(),
    "python",
    "qbg_modification",
    "tagging_data",
    "qbg_tagging_table.csv"
);

export interface TaxonomySummary {
    /** Category slices the table covers, widest first. */
    categories: string[];
    /** Subject names per category, in descending row count. */
    subjectsByCategory: Record<string, string[]>;
    /** Every subject across every category, descending by row count. */
    allSubjects: string[];
    /**
     * "subject||chapter" -> the topics QBG lists under that chapter.
     *
     * This is the concept inventory a syllabus check needs. Knowing a paper is
     * limited to "Electric Charges and Fields" is not enough to judge a question
     * about capacitance — you need to know which concepts that chapter actually
     * contains, and capacitance is not one of them.
     */
    topicsByChapter: Record<string, string[]>;
}

/** Key for topicsByChapter. Case/spacing-insensitive so lookups are forgiving. */
export function chapterTopicKey(subject: string, chapter: string): string {
    return `${(subject || "").trim().toLowerCase()}||${(chapter || "").trim().toLowerCase()}`;
}

let cached: TaxonomySummary | null = null;
let cachedAt = 0;
const CACHE_MS = 10 * 60 * 1000;

/**
 * Parse the whole table into rows.
 *
 * Deliberately NOT "split on newlines, then split each line on commas": ten
 * fields in this table contain a literal newline inside their quotes (a topic
 * whose QBG name was pasted across two lines), and splitting on newlines first
 * cut each of those records in half. The tail half was then read as a fresh
 * record whose "category" was really the middle of a topic name — which is why
 * the tagging panel's taxonomy dropdown listed entries like
 * "Action of Transistor,1sbv7f523uuk45rfs9uorq0tt" and "(X-Y)^2=X^2+Y^2-2Xy"
 * under the seven real categories (2026-09-05 report).
 *
 * A newline only ends a record when it is outside quotes, which is what this
 * scan tracks.
 */
function parseCsvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else inQ = false;
            } else cur += c;
            continue;
        }
        if (c === '"') {
            inQ = true;
        } else if (c === ",") {
            row.push(cur);
            cur = "";
        } else if (c === "\n") {
            row.push(cur);
            rows.push(row);
            row = [];
            cur = "";
        } else if (c !== "\r") {
            cur += c;
        }
    }
    if (cur !== "" || row.length > 0) {
        row.push(cur);
        rows.push(row);
    }
    return rows;
}

export async function readTaxonomySummary(): Promise<TaxonomySummary> {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;

    const text = await fs.readFile(TABLE, "utf8");
    const rows = parseCsvRows(text);
    const header = (rows[0] || []).map((h, i) => (i === 0 ? h.replace(/^﻿/, "") : h));
    const iCat = header.indexOf("category");
    const iSub = header.indexOf("subject");
    const iChap = header.indexOf("chapter");
    const iTopic = header.indexOf("topic");
    if (iCat < 0 || iSub < 0) {
        throw new Error("tagging table is missing its category/subject columns");
    }

    const catCounts = new Map<string, number>();
    const subCounts = new Map<string, number>();
    const perCat = new Map<string, Map<string, number>>();
    const topics = new Map<string, Set<string>>();

    for (let i = 1; i < rows.length; i++) {
        const cells = rows[i];
        // A row whose width doesn't match the header is malformed — with a
        // well-formed table this never fires, and if the file is ever rebuilt
        // badly it keeps the damage out of the pickers instead of listing it.
        if (cells.length !== header.length) continue;
        const cat = (cells[iCat] || "").trim();
        const sub = (cells[iSub] || "").trim();
        if (!cat) continue;
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
        if (!sub) continue;
        subCounts.set(sub, (subCounts.get(sub) || 0) + 1);
        let m = perCat.get(cat);
        if (!m) {
            m = new Map();
            perCat.set(cat, m);
        }
        m.set(sub, (m.get(sub) || 0) + 1);

        if (iChap >= 0 && iTopic >= 0) {
            const chap = (cells[iChap] || "").trim();
            const topic = (cells[iTopic] || "").trim();
            if (chap && topic) {
                const key = chapterTopicKey(sub, chap);
                let set = topics.get(key);
                if (!set) {
                    set = new Set();
                    topics.set(key, set);
                }
                set.add(topic);
            }
        }
    }

    const byCountDesc = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

    const subjectsByCategory: Record<string, string[]> = {};
    for (const [cat, m] of perCat) subjectsByCategory[cat] = byCountDesc(m);

    const topicsByChapter: Record<string, string[]> = {};
    for (const [key, set] of topics) topicsByChapter[key] = [...set].sort();

    cached = {
        categories: byCountDesc(catCounts),
        subjectsByCategory,
        allSubjects: byCountDesc(subCounts),
        topicsByChapter,
    };
    cachedAt = Date.now();
    return cached;
}

/** Testing/ops hook: forget the parsed table (e.g. after a re-crawl). */
export function resetTaxonomyCache(): void {
    cached = null;
    cachedAt = 0;
}
