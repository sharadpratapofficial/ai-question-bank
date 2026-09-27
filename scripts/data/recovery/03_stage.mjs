#!/usr/bin/env node
/**
 * Stage 03: parse every source into row-level staging JSONL (read-only on sources).
 *
 *   data/staging/autocuration_rows.jsonl   one record per AutoCuration `data` row
 *   data/staging/test_occurrences.jsonl    one record per QBG-id cell in Important IDs Replica
 *   data/staging/taxonomy_observations.jsonl  (level, id, name) seen in any source
 *   data/staging/curated_tests.jsonl       AutoCuration `output` sheet (emails dropped)
 *   data/staging/stage_summary.json
 *
 * Raw cell values are kept next to every normalised value. Personal data
 * (e-mail addresses, DTP operator names) is not copied into staging.
 */
import path from "node:path";
import fs from "node:fs";
import { STAGING_DIR, REPO_ROOT, readWorkbook, parseCsv, writeJsonl, writeJson, colLetter, isBlank, cellStr, rel } from "./lib/common.mjs";
import { QBG_CUID25_RE, normalizeQuestionNumber } from "./lib/ids.mjs";
import {
    normalizeQbgIdValue, normalizeLink, normalizeQuestionType, normalizeDifficulty, normalizeSubject,
    normalizeClassLevel, normalizeExam, normalizeTaxonomyName, normalizeAnswer, normalizeOptions, cleanWhitespace,
} from "./lib/normalize.mjs";
import { resolveSource } from "./02_profile.mjs";

// ------------------------------------------------------------------ helpers
/** Excel 1900-system serial -> ISO date. */
export function excelSerialToIso(n) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 20000 || n > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
}
/** Date cell -> { raw, iso, rule }. Accepts serials and dd-mm-yyyy strings; anything else stays unparsed. */
export function normalizeDateCell(v) {
    if (isBlank(v)) return { raw: null, iso: null, rule: "EMPTY" };
    if (typeof v === "number") { const iso = excelSerialToIso(v); return { raw: v, iso, rule: iso ? "EXCEL_SERIAL" : "UNPARSED" }; }
    const m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return { raw: v, iso: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, rule: "DD_MM_YYYY" };
    return { raw: v, iso: null, rule: "UNPARSED" };
}
const nv = (r) => (r && r.status === "OK" ? r.normalized_value : null);
const isId = (v) => typeof v === "string" && QBG_CUID25_RE.test(v.trim());
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const redact = (v) => (typeof v === "string" ? v.replace(EMAIL_RE, "<email>") : v);

// ------------------------------------------------------------------ taxonomy observations
const taxObs = [];
function observeTax(level, id, name, source, where) {
    if (!isId(id)) return;
    taxObs.push({ level, id: id.trim(), name: cleanWhitespace(name), source, where });
}

// ------------------------------------------------------------------ AutoCuration
function stageAutoCuration(file) {
    const wb = readWorkbook(file);
    const sh = wb.sheets.data;
    const header = sh.rows[0];
    const L = (c) => colLetter(c);
    const rows = [];
    for (let r = 1; r < sh.rows.length; r++) {
        const row = sh.rows[r];
        if (!row || !row.some((v) => !isBlank(v))) continue;
        const cell = (c) => (row[c] === undefined ? null : row[c]);
        const link = (c) => sh.links.get(`${r},${c}`) || null;
        const excelRow = r + 1;

        const raw = {};
        header.forEach((h, c) => { if (!isBlank(cell(c))) raw[`${L(c)}:${h}`] = cell(c); });
        const hyperlinks = {};
        header.forEach((h, c) => { const l = link(c); if (l && l !== cell(c)) hyperlinks[`${L(c)}:${h}`] = l; });

        const qbg = normalizeQbgIdValue(cell(0));
        const lk = normalizeLink(cell(1));
        const lkv = nv(lk);
        const qtype = normalizeQuestionType(cell(2));
        const diff = normalizeDifficulty(cell(3));
        const diffCode = normalizeDifficulty(cell(16));
        const subject = normalizeSubject(cell(5));

        // topic / subtopic: detect the name<->code swap seen in 1,820 / 190 rows
        const swap = (nameCol, codeCol) => {
            const name = cell(nameCol), code = cell(codeCol);
            if (isId(name) && !isBlank(code) && !isId(code)) return { name: normalizeTaxonomyName(code), code: String(name).trim(), swapped: true };
            return { name: normalizeTaxonomyName(name), code: isId(code) ? String(code).trim() : null, code_raw_if_not_id: !isBlank(code) && !isId(code) ? code : null, swapped: false };
        };
        const topic = swap(7, 14);
        const subtopic = swap(8, 15);
        const chapter = normalizeTaxonomyName(cell(6));
        const classCell = normalizeClassLevel(cell(9));
        const classDocRef = classCell.normalization_rule === "NOT_A_CLASS_DOCUMENT_REF" ? { value: cell(9), hyperlink: link(9) } : null;

        const answer = normalizeAnswer(cell(19), nv(qtype));
        const options = normalizeOptions(cell(18), Array.isArray(answer.normalized_value) ? answer.normalized_value : null, nv(qtype));

        const qFileName = cellStr(cell(23));
        const qFileLink = normalizeLink(link(23));
        const sFileRaw = cell(24);
        const sFileIsUrl = typeof sFileRaw === "string" && /^https?:/i.test(sFileRaw.trim());
        const sFileLink = normalizeLink(sFileIsUrl ? sFileRaw : link(24));

        let recordKey, identityBasis, identityConfidence;
        if (qbg.status === "OK") { recordKey = `qbg:${qbg.normalized_value}`; identityBasis = "QBG_ID"; identityConfidence = "HIGH"; }
        else if (lkv?.kind === "QBG_QUESTION_PAGE") { recordKey = `qbg:${lkv.id}`; identityBasis = "QBG_ID_FROM_LINK_ONLY"; identityConfidence = "MEDIUM"; }
        else if (lkv?.id && normalizeQuestionNumber(cell(11)) !== null) { recordKey = `acdoc:${lkv.id}#${normalizeQuestionNumber(cell(11))}`; identityBasis = "DOCUMENT_POSITION"; identityConfidence = "MEDIUM"; }
        else { recordKey = `acrow:${excelRow}`; identityBasis = "WORKBOOK_ROW"; identityConfidence = "LOW"; }

        if (isId(cell(12))) observeTax("subject", cell(12), cell(5), "autocuration.data", `row ${excelRow}`);
        if (isId(cell(13))) observeTax("chapter", cell(13), cell(6), "autocuration.data", `row ${excelRow}`);
        if (topic.code) observeTax("topic", topic.code, nv(topic.name), "autocuration.data", `row ${excelRow}`);
        if (subtopic.code) observeTax("subtopic", subtopic.code, nv(subtopic.name), "autocuration.data", `row ${excelRow}`);
        if (isId(cell(33))) observeTax("class", cell(33), cell(34) == null ? null : String(cell(34)), "autocuration.data", `row ${excelRow}`);

        rows.push({
            source: "autocuration.data",
            excel_row: excelRow,
            record_key: recordKey,
            identity_basis: identityBasis,
            identity_confidence: identityConfidence,
            qbg_id: qbg,
            link: lk,
            link_qbg_id_matches: lkv?.kind === "QBG_QUESTION_PAGE" && qbg.status === "OK" ? lkv.id === qbg.normalized_value : null,
            question_type: qtype,
            question_type_original: normalizeQuestionType(cell(30)),
            difficulty: diff,
            difficulty_code: diffCode,
            source_name: { raw_value: cell(4), normalized_value: cleanWhitespace(cell(4)), normalization_rule: "WHITESPACE", confidence: "high", status: isBlank(cell(4)) ? "EMPTY" : "OK" },
            subject,
            chapter,
            topic: topic.name,
            subtopic: subtopic.name,
            topic_swapped_with_code: topic.swapped,
            subtopic_swapped_with_code: subtopic.swapped,
            codes: {
                subject: isId(cell(12)) ? cell(12).trim() : null,
                chapter: isId(cell(13)) ? cell(13).trim() : null,
                topic: topic.code,
                subtopic: subtopic.code,
                class: isId(cell(33)) ? cell(33).trim() : null,
                non_id_code_values: [topic.code_raw_if_not_id, subtopic.code_raw_if_not_id].filter((x) => x !== null && x !== undefined),
            },
            class_level: classCell,
            class_name_column: cell(34),
            class_column_document_ref: classDocRef,
            used_in_exam: isBlank(cell(10)) ? [] : String(cell(10)).split(",").map((s) => s.trim()).filter(Boolean),
            row_number: cell(11),
            source_question_number: cell(17),
            options,
            answer,
            date: normalizeDateCell(cell(20)),
            pattern: cell(21),
            question_file_label: cell(22),
            question_file: qFileName || qFileLink.status === "OK" ? { name: qFileName, link: qFileLink } : null,
            solution_file: !isBlank(sFileRaw) ? { name: sFileIsUrl ? null : cellStr(sFileRaw), link: sFileLink } : null,
            qbg_file_name: cellStr(cell(25)),
            chapter_from_chapter_code: cellStr(cell(26)),
            original_row_number: cell(27),
            date_of_exam: normalizeDateCell(cell(28)),
            exam_type: normalizeExam(cell(29)),
            paper_type: cell(31),
            video_solution_link: normalizeLink(cell(32)),
            raw,
            hyperlinks,
        });
    }

    // taxonomy + class map sheets
    const tg = wb.sheets.tagging;
    for (let r = 1; r < tg.rows.length; r++) {
        const x = tg.rows[r];
        if (!x || !x.some((v) => !isBlank(v))) continue;
        const where = `tagging row ${r + 1}`;
        observeTax("subject", x[0], x[1], "autocuration.tagging", where);
        observeTax("chapter", x[2], x[3], "autocuration.tagging", where);
        observeTax("topic", x[4], x[5], "autocuration.tagging", where);
        observeTax("subtopic", x[6], x[7], "autocuration.tagging", where);
        taxObs.push({ level: "edge", id: `${x[2]}>${x[4]}>${x[6]}`, name: null, source: "autocuration.tagging", where, edge: { subject: x[0], chapter: x[2], topic: x[4], subtopic: x[6] } });
    }
    const cm = wb.sheets["chapterid-classid mapping"];
    for (let r = 1; r < cm.rows.length; r++) {
        const x = cm.rows[r];
        if (!x || !isId(x[0])) continue;
        observeTax("chapter", x[0], x[1], "autocuration.chapter_class_map", `row ${r + 1}`);
        observeTax("class", x[2], x[3] == null ? null : String(x[3]), "autocuration.chapter_class_map", `row ${r + 1}`);
    }

    const out = wb.sheets.output;
    const curated = [];
    for (let r = 1; r < out.rows.length; r++) {
        const x = out.rows[r];
        if (!x || !x.some((v) => !isBlank(v))) continue;
        curated.push({ source: "autocuration.output", excel_row: r + 1, test_number: x[0], user_email_present: !isBlank(x[1]), exam_type: normalizeExam(x[2]), batch_name: x[3], test_date: normalizeDateCell(x[4]), subjects: x[5], chapters: x[6], sheet_link: normalizeLink(x[7]) });
    }
    return { rows, curated };
}

// ------------------------------------------------------------------ Important IDs
function stageImportantIds(file) {
    const wb = readWorkbook(file);
    const occ = [];
    const claimed = new Set(); // "sheet|r,c" of id cells consumed by a structured parser

    const baseOcc = (sheet, r, c, idRaw, extra) => {
        const id = normalizeQbgIdValue(idRaw);
        const sh = wb.sheets[sheet];
        const hl = sh.links.get(`${r},${c}`) || null;
        const hlNorm = hl ? normalizeLink(hl) : null;
        claimed.add(`${sheet}|${r},${c}`);
        return {
            occurrence_id: `impids:${sheet}!${colLetter(c)}${r + 1}`,
            source: "important_ids",
            sheet,
            source_row: r + 1,
            source_cell: `${colLetter(c)}${r + 1}`,
            qbg_id: id,
            id_cell_hyperlink: hlNorm,
            id_hyperlink_matches: hlNorm?.normalized_value?.kind === "QBG_QUESTION_PAGE" ? hlNorm.normalized_value.id === id.normalized_value : null,
            test_family: null, test_name: null, year: null, date: null, exam: null, paper: null, batch: null,
            subject: null, question_type: null, question_number: null, question_number_raw: null,
            language: null, structure: "TABULAR", parse_confidence: "HIGH",
            ...extra,
        };
    };
    const qnum = (v) => ({ question_number: normalizeQuestionNumber(v), question_number_raw: v });
    const sub = (v) => (isBlank(v) ? null : normalizeSubject(v));
    const qt = (v) => (isBlank(v) ? null : normalizeQuestionType(v));

    // JRTS / RTS: Year, Test Name, Pattern, Paper Number, Subject, Q. Type, Question Number, QBG IDs
    for (const [sheet, family] of [["JRTS", "JRTS"], ["RTS", "RTS"]]) {
        const rows = wb.sheets[sheet].rows;
        for (let r = 1; r < rows.length; r++) {
            const x = rows[r];
            if (!x || isBlank(x[7])) continue;
            occ.push(baseOcc(sheet, r, 7, x[7], {
                test_family: family, test_name: cellStr(x[1]), year: cellStr(x[0]), exam: isBlank(x[2]) ? null : normalizeExam(x[2]),
                paper: isBlank(x[3]) ? null : x[3], subject: sub(x[4]), question_type: qt(x[5]), ...qnum(x[6]),
            }));
        }
    }

    // AITS and its copy: A..L headed, M..W unlabeled taxonomy block
    const aitsRowSig = new Map();
    for (const sheet of ["AITS", "Copy of AITS"]) {
        const sh = wb.sheets[sheet];
        for (let r = 1; r < sh.rows.length; r++) {
            const x = sh.rows[r];
            if (!x || isBlank(x[9])) continue;
            const where = `${sheet} row ${r + 1}`;
            observeTax("subject", x[13], x[14], "important_ids.aits", where);
            observeTax("chapter", x[15], x[16], "important_ids.aits", where);
            observeTax("topic", x[17], x[18], "important_ids.aits", where);
            observeTax("subtopic", x[19], x[20], "important_ids.aits", where);
            // A non-id value (e.g. "Paper-02") in the id cell of an otherwise complete question row is a
            // data-entry gap: the occurrence is kept, with an invalid qbg_id, so the position is not lost.
            const sig = JSON.stringify([x[0], x[1], x[3], x[4], x[5], x[6], x[8], x[9]]);
            const rec = baseOcc(sheet, r, 9, x[9], {
                test_family: "AITS", test_name: cellStr(x[2]), year: cellStr(x[0]), date: normalizeDateCell(x[1]),
                exam: isBlank(x[3]) ? null : normalizeExam(x[3]), batch: cellStr(x[4]), paper: isBlank(x[5]) ? null : x[5],
                subject: sub(x[6]), question_type: qt(x[7]), ...qnum(x[8]),
                comp_parent_candidate: isId(x[10]) ? x[10].trim() : null,
                video_solution_link: isBlank(x[11]) ? null : normalizeLink(x[11]),
                video_solution_note: typeof x[11] === "string" && !/^https?:/.test(x[11]) ? x[11] : null,
                aits_unlabeled_col_M: x[12] ?? null,
                aits_taxonomy: {
                    subject_id: isId(x[13]) ? x[13] : null, subject: x[14] ?? null,
                    chapter_id: isId(x[15]) ? x[15] : null, chapter: x[16] ?? null,
                    topic_id: isId(x[17]) ? x[17] : null, topic: x[18] ?? null,
                    subtopic_id: isId(x[19]) ? x[19] : null, subtopic: x[20] ?? null,
                    difficulty_code: x[21] ?? null, difficulty: x[22] ?? null,
                },
            });
            if (!isId(x[9])) rec.structure = "INVALID_ID_CELL";
            if (sheet === "Copy of AITS") {
                const twin = aitsRowSig.get(`${r}|${sig}`) || aitsRowSig.get(`${r}|${JSON.stringify([x[0], x[1], x[3], x[4], x[5], x[6], x[8], x[9]])}`);
                rec.mirror_of = twin || null;
                if (twin) rec.structure = "MIRROR_OF_AITS";
            } else aitsRowSig.set(`${r}|${sig}`, rec.occurrence_id);
            if (isId(x[13])) claimed.add(`${sheet}|${r},13`);
            for (const c of [10, 15, 17, 19]) if (isId(x[c])) claimed.add(`${sheet}|${r},${c}`);
            occ.push(rec);
        }
    }

    // PYQs: Main table A..H (header row 2), Advanced table K..Q
    const py = wb.sheets.PYQs.rows;
    for (let r = 2; r < py.length; r++) {
        const x = py[r];
        if (!x) continue;
        if (!isBlank(x[7])) occ.push(baseOcc("PYQs", r, 7, x[7], {
            test_family: "PYQ", test_name: "JEE Main PYQ", year: cellStr(x[0]), exam: normalizeExam(x[3] || "Main"),
            date: { raw: [x[2], x[1], x[0]].filter((v) => !isBlank(v)).join(" "), iso: null, rule: "DAY_MONTH_YEAR_PARTS" },
            shift: cellStr(x[4]), subject: sub(x[5]), ...qnum(x[6]),
        }));
        if (!isBlank(x[16])) occ.push(baseOcc("PYQs", r, 16, x[16], {
            test_family: "PYQ", test_name: "JEE Advanced PYQ", year: cellStr(x[10]), exam: normalizeExam(x[11] || "Advanced"),
            paper: x[12] ?? null, subject: sub(x[13]), question_type: qt(x[14]), ...qnum(x[15]),
        }));
    }

    // Onepass: tabular A..F until the first block header ("S.No."), then 5-column blocks
    const op = wb.sheets["Onepass Test Series"].rows;
    let firstBlock = op.findIndex((x) => x && x.some((v) => typeof v === "string" && v.trim() === "S.No."));
    if (firstBlock < 0) firstBlock = op.length;
    for (let r = 1; r < firstBlock - 1; r++) {
        const x = op[r];
        if (!x || isBlank(x[4])) continue;
        if (!isId(x[4])) continue; // remarks rows are picked up (not as ids) by the safety net report
        occ.push(baseOcc("Onepass Test Series", r, 4, x[4], {
            test_family: "ONEPASS", test_name: "Onepass Test Series", class_raw: x[0], class_level: normalizeClassLevel(x[0]),
            subject: sub(x[1]), chapter: normalizeTaxonomyName(x[2]), ...qnum(x[3]), tagging_status: cellStr(x[5]),
        }));
    }
    occ.push(...parseBlocks(wb, "Onepass Test Series", firstBlock - 1, 5, { idOffset: 2, nameOffset: 1, snoOffset: 0, tagOffset: 3, remarkOffset: 4, family: "ONEPASS" }, baseOcc));

    // Full length: 6-column blocks from row 0 (title), row 1 test, row 2 header, row 3 meta, data from row 4
    occ.push(...parseBlocks(wb, "Full length JEE Main+Advanced (", 0, 6, { idOffset: 1, snoOffset: 0, tagOffset: 3, sourceOffset: 4, family: "FULL_LENGTH", fullLength: true }, baseOcc));

    // Safety net: every remaining id-shaped cell in any sheet (except taxonomy columns already claimed).
    const unclaimed = [];
    for (const sheet of wb.sheetNames) {
        const rows = wb.sheets[sheet].rows;
        rows.forEach((x, r) => x && x.forEach((v, c) => {
            if (isId(v) && !claimed.has(`${sheet}|${r},${c}`)) unclaimed.push({ sheet, cell: `${colLetter(c)}${r + 1}`, value: v.trim() });
        }));
    }
    for (const u of unclaimed) {
        const [, col, row] = u.cell.match(/^([A-Z]+)(\d+)$/);
        const c = col.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        occ.push({ ...baseOcc(u.sheet, Number(row) - 1, c, u.value, {}), structure: "UNSTRUCTURED_CELL_SCAN", parse_confidence: "LOW" });
    }
    return { occ, unclaimed: unclaimed.length };
}

/**
 * Side-by-side blocks. A block starts at a column where a header cell reads
 * "S.No." (Onepass) or "MAIN" (Full length). Title rows above the header give
 * subject / test context. Data rows continue until the next header or blank run.
 */
function parseBlocks(wb, sheet, startRow, width, o, baseOcc) {
    const sh = wb.sheets[sheet];
    const rows = sh.rows;
    const out = [];
    const isHeaderCell = (v) => typeof v === "string" && (o.fullLength ? v.trim() === "MAIN" : v.trim() === "S.No.");
    for (let r = Math.max(0, startRow); r < rows.length; r++) {
        const x = rows[r];
        if (!x) continue;
        for (let c = 0; c < x.length; c++) {
            if (!isHeaderCell(x[c])) continue;
            const ctx = {};
            if (o.fullLength) {
                ctx.series = cellStr(rows[r - 2]?.[c]);
                ctx.test_name = cellStr(rows[r - 1]?.[c]);
                ctx.subject_label = cellStr(rows[r + 1]?.[c]);
                const sf = rows[r + 1]?.[c + o.sourceOffset];
                ctx.source_file = isBlank(sf) ? null : { label: sf, link: normalizeLink(sh.links.get(`${r + 1},${c + o.sourceOffset}`)) };
            } else {
                ctx.subject_label = cellStr(rows[r - 1]?.[c]);
                const hdr = rows[r]?.[c + 1];
                ctx.name_header = cellStr(hdr);
                const hl = sh.links.get(`${r},${c + 1}`);
                ctx.final_file_link = hl ? normalizeLink(hl) : null;
            }
            for (let d = r + 1 + (o.fullLength ? 1 : 0); d < rows.length; d++) {
                const y = rows[d];
                if (!y) break;
                if (isHeaderCell(y[c])) break;
                const idv = y[c + o.idOffset];
                if (isBlank(idv) && isBlank(y[c])) { if (isBlank(rows[d + 1]?.[c])) break; continue; }
                if (!isId(idv)) continue;
                const subjectNorm = ctx.subject_label ? normalizeSubject(ctx.subject_label) : null;
                out.push(baseOcc(sheet, d, c + o.idOffset, idv, {
                    structure: "SIDE_BY_SIDE_BLOCK",
                    parse_confidence: "MEDIUM",
                    test_family: o.family,
                    test_name: o.fullLength ? ctx.test_name : "Onepass Test Series",
                    series: ctx.series || null,
                    exam: o.fullLength && ctx.series ? normalizeExam(/advanced/i.test(ctx.series) ? "Advanced" : "Main") : null,
                    subject: subjectNorm,
                    chapter: !o.fullLength ? normalizeTaxonomyName(y[c + o.nameOffset]) : null,
                    ...{ question_number: normalizeQuestionNumber(y[c + o.snoOffset]), question_number_raw: y[c + o.snoOffset] },
                    tagging_status: cellStr(y[c + o.tagOffset]),
                    remarks: o.remarkOffset !== undefined ? redact(cellStr(y[c + o.remarkOffset])) : null,
                    block: { header_cell: `${colLetter(c)}${r + 1}`, source_file: ctx.source_file || null, final_file_link: ctx.final_file_link || null },
                }));
            }
        }
    }
    return out;
}

// ------------------------------------------------------------------ tagging CSV
function stageTaggingCsv(file) {
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    const h = rows[0];
    const ix = Object.fromEntries(h.map((k, i) => [k, i]));
    let n = 0;
    for (let r = 1; r < rows.length; r++) {
        const x = rows[r];
        if (!x || x.length < h.length) continue;
        n++;
        const where = `csv line ${r + 1}`;
        const src = "tagging_csv";
        observeTax("class", x[ix.class_id], x[ix.class], src, where);
        observeTax("subject", x[ix.subject_id], x[ix.subject], src, where);
        observeTax("chapter", x[ix.chapter_id], x[ix.chapter], src, where);
        observeTax("topic", x[ix.topic_id], x[ix.topic], src, where);
        observeTax("subtopic", x[ix.subtopic_id], x[ix.subtopic], src, where);
        taxObs.push({ level: "edge", id: `${x[ix.chapter_id]}>${x[ix.topic_id]}>${x[ix.subtopic_id]}`, name: null, source: src, where, edge: { category: x[ix.category], class: x[ix.class_id], subject: x[ix.subject_id], chapter: x[ix.chapter_id], topic: x[ix.topic_id], subtopic: x[ix.subtopic_id] } });
    }
    return n;
}

export function runStage() {
    taxObs.length = 0;
    const acFile = resolveSource("autocuration");
    const idFile = resolveSource("important_ids");
    const tgFile = resolveSource("tagging_csv");
    const summary = { sources: {} };
    if (acFile) {
        const { rows, curated } = stageAutoCuration(acFile);
        writeJsonl(path.join(STAGING_DIR, "autocuration_rows.jsonl"), rows);
        writeJsonl(path.join(STAGING_DIR, "curated_tests.jsonl"), curated);
        summary.sources.autocuration = { file: rel(acFile), rows: rows.length, curated_tests: curated.length };
    }
    if (idFile) {
        const { occ, unclaimed } = stageImportantIds(idFile);
        writeJsonl(path.join(STAGING_DIR, "test_occurrences.jsonl"), occ);
        const byStruct = {};
        for (const o of occ) byStruct[`${o.sheet}|${o.structure}`] = (byStruct[`${o.sheet}|${o.structure}`] || 0) + 1;
        summary.sources.important_ids = { file: rel(idFile), occurrence_records: occ.length, unclaimed_id_cells: unclaimed, by_sheet_structure: byStruct };
    }
    if (tgFile) summary.sources.tagging_csv = { file: rel(tgFile), rows: stageTaggingCsv(tgFile) };
    // Aggregate to distinct (level, id, name, source) with a count and the first location seen.
    const agg = new Map();
    for (const t of taxObs) {
        const k = t.level === "edge" ? `edge|${t.id}|${t.source}` : `${t.level}|${t.id}|${t.name}|${t.source}`;
        const a = agg.get(k);
        if (a) a.count++;
        else agg.set(k, { ...t, first_seen: t.where, where: undefined, count: 1 });
    }
    writeJsonl(path.join(STAGING_DIR, "taxonomy_observations.jsonl"), [...agg.values()]);
    summary.taxonomy_observations = { raw: taxObs.length, distinct: agg.size };
    writeJson(path.join(STAGING_DIR, "stage_summary.json"), summary);
    return summary;
}

if (process.argv[1]?.endsWith("03_stage.mjs")) {
    console.log(JSON.stringify(runStage(), null, 1));
}
