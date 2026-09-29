#!/usr/bin/env node
/**
 * Stage 06: RankUp knowledge + generated-question ingestion.
 *
 * Reads ONLY from data/raw/rankup/ (read-only inputs supplied by the user). Today
 * that folder does not exist, so every RankUp dataset is written EMPTY with
 * status UNAVAILABLE. Nothing is fabricated.
 *
 * Supported inputs when supplied (see docs/data_recovery/RANKUP_INGESTION_SPEC.md):
 *   *.md  registers: markdown tables whose rows carry PYQ-*, TC-*-###, PA-*-### ids;
 *                    book cards as "## <title>" sections with "- **Key:** value" lines
 *   *.csv generated bank (rankup_chem_bank.csv)
 *
 * Outputs (data/canonical/): pyq_register, concept_register, archetype_register,
 * reference_book_register, rankup_questions, rankup_provenance, rankup_qc (.jsonl)
 * and rankup_status.json.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, CANONICAL_DIR, parseCsv, writeJsonl, writeJson, sha256File, sha256Text, uuidv5, rel } from "./lib/common.mjs";
import { RANKUP_DROP_DIR } from "./sources.mjs";

export const PYQ_ID_IN_TEXT = /\bPYQ[-_][A-Z0-9]+(?:[-_][A-Z0-9]+)*\b/gi;
export const TC_ID_IN_TEXT = /\bTC-[A-Z]{2,5}-\d{2,4}\b/g;
export const PA_ID_IN_TEXT = /\bPA-[A-Z]{2,5}-\d{2,4}\b/g;
export const QC_CHECKS = {
    V1: "Independent blind re-solve", V2: "Numerical recompute", V3: "Fusion audit", V4: "Trap audit", V5: "Uniqueness",
    V6: "Originality", V7: "Wrong Answer Analysis", V8: "Ideal time", V9: "Language/formula/unit audit", V10: "Depth audit",
};
export const TRAP_TAXONOMY = {
    C1: "missing/unresolvable structure or notation", C2: "unstated/ambiguous reaction conditions", C3: "syllabus scope violation",
    C4: "n-factor / equivalent-weight ambiguity", C5: "unit / significant-figure inconsistency", C6: "arguably-correct distractor / convention-dependent key",
    C7: "internal numeric inconsistency", C8: "duplicate concept/trap within paper or sibling project",
};

/** Parse every markdown table in a document into { headers, rows: [{cells, line}] }. */
export function parseMarkdownTables(text) {
    const lines = text.split(/\r?\n/);
    const tables = [];
    for (let i = 0; i < lines.length - 1; i++) {
        if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
        const split = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const headers = split(lines[i]);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push({ cells: split(lines[j]), line: j + 1 });
        tables.push({ headers, rows, start_line: i + 1 });
        i = j - 1;
    }
    return tables;
}

export function registerRecords(file, text) {
    const out = { pyq: [], concept: [], archetype: [] };
    for (const t of parseMarkdownTables(text)) {
        for (const r of t.rows) {
            const first = r.cells.find((c) => c) || "";
            const rec = (kind, id) => ({
                [`${kind}_id`]: id,
                fields: Object.fromEntries(t.headers.map((h, i) => [h || `col${i + 1}`, r.cells[i] ?? null])),
                source_file: rel(file), source_line: r.line,
                origin_type: kind === "pyq" ? "PYQ_SOURCE" : "GENERATION_METADATA",
                raw_row: r.cells.join(" | "),
            });
            const idCell = r.cells.find((c) => /^(PYQ[-_]|TC-|PA-)/i.test(c)) || first;
            if (/^PYQ[-_]/i.test(idCell)) out.pyq.push(rec("pyq", idCell));
            else if (/^TC-/.test(idCell)) out.concept.push(rec("concept", idCell));
            else if (/^PA-/.test(idCell)) out.archetype.push(rec("archetype", idCell));
        }
    }
    return out;
}

export function bookCards(file, text) {
    const books = [];
    const sections = text.split(/^##\s+/m).slice(1);
    for (const s of sections) {
        const [title, ...body] = s.split(/\r?\n/);
        const fields = {};
        for (const l of body) { const m = l.match(/^\s*[-*]\s+\*\*([^*]+):?\*\*:?\s*(.*)$/); if (m) fields[m[1].replace(/:$/, "").trim()] = m[2].trim(); }
        books.push({ book_id: `BOOK-${sha256Text(title.trim()).slice(0, 10)}`, title: title.trim(), fields, source_file: rel(file), usage_rule: "concepts/techniques only; never copy problems or wording", origin_type: "REFERENCE_METADATA" });
    }
    return books;
}

const alias = (headers, names) => headers.findIndex((h) => names.some((n) => h.toLowerCase().replace(/[^a-z0-9]/g, "") === n));

export function generatedBank(file) {
    const rows = parseCsv(fs.readFileSync(file, "utf8")).filter((r) => r.some((c) => c !== ""));
    if (!rows.length) return { questions: [], provenance: [], qc: [] };
    const h = rows[0];
    const col = {
        id: alias(h, ["id", "rankupquestionid", "questionid", "rqid"]),
        question: alias(h, ["question", "questiontext", "stem"]),
        options: alias(h, ["options"]),
        answer: alias(h, ["answer", "answerkey", "correctanswer"]),
        solution: alias(h, ["solution", "detailedsolution", "solutiontext"]),
        difficulty: alias(h, ["difficulty", "difficultylevel"]),
        ideal: alias(h, ["idealtime", "idealtimeseconds"]),
        chapter: alias(h, ["chapter"]), topic: alias(h, ["topic"]), subtopic: alias(h, ["subtopic"]), qtype: alias(h, ["questiontype", "type"]),
        fusion: alias(h, ["fusiontype", "fusion"]), trap: alias(h, ["trap", "trapcode", "traplever"]),
        srcPdf: alias(h, ["sourcepdfid"]), srcSolPdf: alias(h, ["sourcesolutionpdfid"]), qbgFile: alias(h, ["qbgfileid"]),
        anchor: alias(h, ["anchorpyq", "pyq1", "anchor"]),
    };
    const questions = [], provenance = [], qc = [];
    rows.slice(1).forEach((r, i) => {
        const get = (k) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() || null : null);
        const rowText = r.join(" ");
        const rid = get("id") || `rankup-row-${i + 2}`;
        const qid = uuidv5(`rankup:${rel(file)}#${rid}`);
        const pyqs = [...new Set(rowText.match(PYQ_ID_IN_TEXT) || [])];
        const tcs = [...new Set(rowText.match(TC_ID_IN_TEXT) || [])];
        const pas = [...new Set(rowText.match(PA_ID_IN_TEXT) || [])];
        const anchorIds = get("anchor") ? [...new Set(get("anchor").match(PYQ_ID_IN_TEXT) || [])] : [];
        const qcCols = h.map((name, j) => ({ name, j })).filter(({ name }) => /^v(10|[1-9])\b|blind|recompute|fusion audit|trap audit|uniqueness|originality|waa|wrong answer|ideal time|language|depth/i.test(name));
        questions.push({
            rankup_question_id: rid, question_id: qid, origin_type: "RANKUP_GENERATED",
            question_text: get("question"), options_raw: get("options"), answer_raw: get("answer"), solution_text: get("solution"),
            subject: "Chemistry", chapter: get("chapter"), topic: get("topic"), subtopic: get("subtopic"), question_type: get("qtype"),
            difficulty: get("difficulty"), ideal_time_seconds: get("ideal") && /^\d+$/.test(get("ideal")) ? Number(get("ideal")) : null,
            fusion: { type: get("fusion"), anchor_pyq_ids: anchorIds, secondary_pyq_ids: pyqs.filter((p) => !anchorIds.includes(p)), concept_ids: tcs, archetype_ids: pas, role_basis: anchorIds.length ? "anchor column" : "ids found in row; roles not stated" },
            trap: { code: get("trap"), recall_answers: [], description: null },
            qbg_file_id: get("qbgFile"), qbg_file_id_semantics: "UNKNOWN (kept separate; not treated as qbg_id)",
            source_pdf_id: get("srcPdf"), source_solution_pdf_id: get("srcSolPdf"),
            source_file: rel(file), source_row: i + 2,
        });
        for (const p of anchorIds) provenance.push({ rankup_question_id: rid, relation: "ANCHOR_PYQ", target: p });
        for (const p of pyqs.filter((x) => !anchorIds.includes(x))) provenance.push({ rankup_question_id: rid, relation: "REFERENCES_PYQ", target: p });
        for (const t of tcs) provenance.push({ rankup_question_id: rid, relation: "USES_CONCEPT", target: t });
        for (const a of pas) provenance.push({ rankup_question_id: rid, relation: "USES_ARCHETYPE", target: a });
        for (const { name, j } of qcCols) qc.push({ rankup_question_id: rid, check: name, result_raw: r[j] ?? null });
    });
    return { questions, provenance, qc };
}

export function runRankup() {
    const dir = path.join(REPO_ROOT, RANKUP_DROP_DIR);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : [];
    const pyq = [], concept = [], archetype = [], books = [], questions = [], provenance = [], qc = [];
    const inputs = [];
    for (const f of files) {
        inputs.push({ file: rel(f), sha256: sha256File(f) });
        if (/\.md$/i.test(f)) {
            const text = fs.readFileSync(f, "utf8");
            if (/book|library|source_compilation|source_library/i.test(path.basename(f))) books.push(...bookCards(f, text));
            const r = registerRecords(f, text);
            pyq.push(...r.pyq); concept.push(...r.concept); archetype.push(...r.archetype);
        } else if (/\.csv$/i.test(f)) {
            const g = generatedBank(f);
            questions.push(...g.questions); provenance.push(...g.provenance); qc.push(...g.qc);
        }
    }
    writeJsonl(path.join(CANONICAL_DIR, "pyq_register.jsonl"), pyq);
    writeJsonl(path.join(CANONICAL_DIR, "concept_register.jsonl"), concept);
    writeJsonl(path.join(CANONICAL_DIR, "archetype_register.jsonl"), archetype);
    writeJsonl(path.join(CANONICAL_DIR, "reference_book_register.jsonl"), books);
    writeJsonl(path.join(CANONICAL_DIR, "rankup_questions.jsonl"), questions);
    writeJsonl(path.join(CANONICAL_DIR, "rankup_provenance.jsonl"), provenance);
    writeJsonl(path.join(CANONICAL_DIR, "rankup_qc.jsonl"), qc);
    const status = {
        drop_dir: RANKUP_DROP_DIR,
        drop_dir_exists: fs.existsSync(dir),
        inputs,
        status: files.length ? "INGESTED" : "UNAVAILABLE",
        presence: files.length ? "PRESENT" : "NOT_PRESENT",
        note: files.length ? "RankUp files ingested from the drop folder." : "No RankUp files supplied. Optional source: the pipeline continues; no RankUp record is created.",
        counts: { pyq_register: pyq.length, concept_register: concept.length, archetype_register: archetype.length, reference_books: books.length, rankup_questions: questions.length, rankup_provenance_edges: provenance.length, rankup_qc_results: qc.length },
        expected_per_brief: { pyq_register: "556 (SBC/ATM/PER/RDX) + 213 (Electrochemistry)", concept_register: 331, archetype_register: 124, reference_books: 27 },
        qc_checks_modelled: QC_CHECKS,
        trap_taxonomy_modelled: TRAP_TAXONOMY,
    };
    writeJson(path.join(CANONICAL_DIR, "rankup_status.json"), status);
    return status;
}

if (process.argv[1]?.endsWith("06_rankup.mjs")) console.log(JSON.stringify(runRankup(), null, 1).slice(0, 1500));
