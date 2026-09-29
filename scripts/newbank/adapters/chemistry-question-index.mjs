#!/usr/bin/env node
/**
 * Per-source adapter: "Chemistry_question_index.csv" -> canonical new-bank JSONL
 * (docs/NEW_QUESTION_BANK_FORMAT.md). The source file is only read, never written.
 *
 *   node scripts/newbank/adapters/chemistry-question-index.mjs --input=<csv> [--out-dir=data/newbank/in]
 *
 * Writes <out-dir>/chemistry_question_index.jsonl and chemistry_question_index.adapter-report.json
 * (every excluded row with its reason). Then run the importer on the JSONL as usual.
 *
 * Mapping rules (nothing is invented):
 *   - source_key = "chemidx:<question_id>"; legacy_qbg_id is NOT set (these are the source's own ids).
 *   - question_text = statement, HTML-escaped outside LaTeX delimiters, newlines -> <br>.
 *   - options: "(A) x | (B) y | ..." with labels checked A, B, C...; unlabeled "x | y | z | w" only
 *     when there are exactly 4 parts (a bare " | " can occur inside option text, e.g. cell notation).
 *   - answer = verified_answer if present, else answer_printed. Both present and different -> excluded.
 *   - question_type: MCQ -> Single_Choice(SCQ) ONLY when the answer has one letter (in this source
 *     "MCQ" also labels multi-correct rows, so a multi-letter MCQ is excluded as ambiguous);
 *     STATEMENTS_MCQ -> SCQ under the same rule; MSQ -> Multi_Choice(MCQ); NUMERICAL -> Numerical;
 *     INTEGER -> Integer; ASSERTION -> Assertion_Reason(AR); MATCH_MCQ / MATCH -> Matching_List(ML).
 *     SUBJECTIVE, MATRIX, PARA_MCQ, PARA_MSQ (no passage parent rows) and STATEMENT are excluded.
 *   - difficulty: DIRECT -> Easy, MODERATE -> Medium, DIFFICULT / VERY_DIFFICULT -> Hard
 *     (the original label is kept in provenance).
 *   - exam: "JEE Main" / "JEE Advanced" / "Both" -> both / "Neither" -> not set. class_level is not set.
 *   - source = book_file. No solution exists in the source, so none is stored.
 *   - Excluded: has_figure=true (no figure files), non-empty defects, within_syllabus=false,
 *     active!=true, answer_ok=false.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_BASENAME = "chemistry_question_index";

/** RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsv(text) {
    const rows = [];
    let row = [], field = "", i = 0, quoted = false;
    const s = text.replace(/^﻿/, "");
    while (i < s.length) {
        const c = s[i];
        if (quoted) {
            if (c === '"') {
                if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
                quoted = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"' && field === "") { quoted = true; i++; continue; }
        if (c === ",") { row.push(field); field = ""; i++; continue; }
        if (c === "\r" && s[i + 1] === "\n") { i++; continue; }
        if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
        field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const [header, ...body] = rows;
    return body.filter((r) => r.length > 1 || r[0] !== "").map((r, n) => {
        if (r.length !== header.length) throw new Error(`CSV data row ${n + 1}: ${r.length} fields, header has ${header.length}`);
        return Object.fromEntries(header.map((h, k) => [h, r[k]]));
    });
}

const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Escape text for HTML but leave LaTeX spans untouched (the app renders them from the raw string). */
export function textToHtml(text) {
    const MATH = /(\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|(?<!\$)\$(?!\$)[^$\n]+?\$(?!\$))/g;
    return text.trim().split(MATH).map((part, i) => (i % 2 ? part : escapeHtml(part).replace(/\r?\n/g, "<br>"))).join("");
}

export function parseOptions(raw) {
    if (!raw.trim()) return { options: null };
    if (/^\s*\(A\)/.test(raw)) {
        const parts = raw.split(/\s*\|\s*(?=\([A-J]\))/);
        const options = [];
        for (let k = 0; k < parts.length; k++) {
            const m = parts[k].match(/^\s*\(([A-J])\)\s*([\s\S]*)$/);
            if (!m || m[1] !== String.fromCharCode(65 + k)) return { error: `option labels are not A, B, C... in order: ${raw.slice(0, 80)}` };
            options.push(m[2].trim());
        }
        return { options };
    }
    const parts = raw.split(" | ");
    if (parts.length !== 4) return { error: `unlabeled options split into ${parts.length} parts (only exactly 4 is unambiguous)` };
    return { options: parts.map((p) => p.trim()) };
}

/** "(A), (B)" / "A, B" / "(A) | (B)" / "(A, B)" -> ["A","B"]; anything else -> null. */
export function answerLetters(raw) {
    const t = raw.trim().toUpperCase();
    if (!/^[\s(),|&AND]*$/.test(t.replace(/\b[A-J]\b/g, ""))) return null;
    const letters = t.match(/\b[A-J]\b/g);
    return letters && letters.length ? [...new Set(letters)].sort() : null;
}

const TYPE_MAP = {
    MCQ: "Single_Choice(SCQ)", STATEMENTS_MCQ: "Single_Choice(SCQ)", MSQ: "Multi_Choice(MCQ)",
    NUMERICAL: "Numerical", INTEGER: "Integer", ASSERTION: "Assertion_Reason(AR)",
    MATCH_MCQ: "Matching_List(ML)", MATCH: "Matching_List(ML)",
};
const DIFFICULTY = { DIRECT: "Easy", MODERATE: "Medium", DIFFICULT: "Hard", VERY_DIFFICULT: "Hard" };
const EXAM = { "JEE Main": ["JEE Main"], "JEE Advanced": ["JEE Advanced"], Both: ["JEE Main", "JEE Advanced"] };

/** Returns { record } or { exclude: reason }. */
export function adaptRow(r) {
    const type = TYPE_MAP[r.question_type];
    if (!type) return { exclude: `unsupported source question_type ${r.question_type || "(empty)"}` };
    if (r.active !== "true") return { exclude: "active is not true" };
    if (r.has_figure === "true") return { exclude: "has_figure=true and no figure file is available" };
    if (r.defects.trim()) return { exclude: `source lists defects: ${r.defects.trim()}` };
    if (r.within_syllabus !== "true") return { exclude: "within_syllabus is not true" };
    if (r.answer_ok === "false") return { exclude: "answer_ok=false" };

    const optionType = !["Numerical", "Integer"].includes(type);
    const printed = r.answer_printed.trim(), verified = r.verified_answer.trim();
    let answer;
    if (printed || verified) {
        if (optionType) {
            const p = printed ? answerLetters(printed) : null, v = verified ? answerLetters(verified) : null;
            if ((printed && !p) || (verified && !v)) return { exclude: `answer is not option letters: printed "${printed}", verified "${verified}"` };
            if (p && v && p.join() !== v.join()) return { exclude: `printed answer ${p.join(",")} differs from verified answer ${v.join(",")}` };
            const letters = v ?? p;
            if (type === "Single_Choice(SCQ)" && letters.length !== 1) return { exclude: `source type ${r.question_type} has ${letters.length} answer letters (ambiguous single/multi-correct)` };
            answer = type === "Multi_Choice(MCQ)" ? letters : letters[0];
        } else {
            if (printed && verified && Number(printed) !== Number(verified)) return { exclude: `printed answer "${printed}" differs from verified answer "${verified}"` };
            answer = verified || printed; // as given; the importer validates it is a number
        }
    }

    const rec = {
        source_key: `chemidx:${r.question_id}`,
        question_type: type,
        question_text: textToHtml(r.statement),
        subject: r.subject,
        chapter: r.chapter,
        source: r.book_file,
    };
    if (optionType) {
        const o = parseOptions(r.options);
        if (o.error) return { exclude: o.error };
        if (o.options) rec.options = o.options.map(textToHtml);
    } else if (r.options.trim()) return { exclude: `${r.question_type} row has options` };
    if (answer !== undefined) rec.answer = answer;
    if (r.topic.trim()) rec.topic = r.topic.trim();
    if (r.subtopic.trim()) rec.subtopic = r.subtopic.trim();
    if (DIFFICULTY[r.difficulty]) rec.difficulty = DIFFICULTY[r.difficulty];
    if (EXAM[r.exam_fit]) rec.exam = EXAM[r.exam_fit];
    rec.provenance = {
        adapter: "chemistry-question-index-v1",
        source_question_id: r.question_id, book_file: r.book_file, book_hash: r.book_hash,
        page_from: r.page_from, page_to: r.page_to, branch: r.branch,
        original_question_type: r.question_type, original_difficulty: r.difficulty, exam_fit: r.exam_fit,
        answer_printed: printed || null, verified_answer: verified || null, answer_ok: r.answer_ok || null,
        seed_strength: r.seed_strength, reasoning_stages: r.reasoning_stages,
        taxonomy_version: r.taxonomy_version, tagged_at: r.tagged_at, migrated_at: r.migrated_at,
        legacy_chapter: r.legacy_chapter || null, legacy_topic: r.legacy_topic || null, legacy_subtopic: r.legacy_subtopic || null,
    };
    return { record: rec };
}

function main() {
    const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)]; }));
    if (!args["--input"]) throw new Error("--input=<Chemistry_question_index.csv> is required");
    const input = path.resolve(args["--input"]);
    const outDir = path.resolve(args["--out-dir"] || path.join(REPO_ROOT, "data", "newbank", "in"));
    const buf = fs.readFileSync(input);
    const rows = parseCsv(buf.toString("utf8"));
    const records = [], excluded = [], reasons = {};
    for (const r of rows) {
        const res = adaptRow(r);
        if (res.record) { records.push(res.record); continue; }
        excluded.push({ question_id: r.question_id, question_type: r.question_type, reason: res.exclude });
        const k = res.exclude.split(":")[0].replace(/"[^"]*"|\d+/g, "…");
        reasons[k] = (reasons[k] || 0) + 1;
    }
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = path.join(outDir, `${OUT_BASENAME}.jsonl`);
    fs.writeFileSync(jsonl, records.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const report = {
        input_file: path.basename(input), input_sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        rows: rows.length, records_written: records.length, excluded: excluded.length,
        excluded_by_reason: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])), excluded_rows: excluded,
    };
    fs.writeFileSync(path.join(outDir, `${OUT_BASENAME}.adapter-report.json`), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, excluded_rows: undefined, output: jsonl }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
