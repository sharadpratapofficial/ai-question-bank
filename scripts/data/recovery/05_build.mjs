#!/usr/bin/env node
/**
 * Stage 05: identity resolution, cross-match, conflicts, duplicates,
 * provenance, classification and all canonical / report / review outputs.
 *
 * Inputs : data/staging/*.jsonl, data/extracted/docx_questions.jsonl
 * Outputs: data/canonical/*, data/reports/*, data/review/*
 *
 * Rules enforced here:
 *   - identity keys come only from valid QBG ids (row id, or the id embedded in the
 *     row's own QBG page link). Rows without one each stay their own candidate
 *     (acrow:<row>); same-document-position rows are reported, never merged.
 *   - when sources disagree the canonical value is null and a conflict is written;
 *     no source "wins" by order.
 *   - nothing is fetched; external documents are UNAVAILABLE locally.
 */
import fs from "node:fs";
import path from "node:path";
import {
    STAGING_DIR, CANONICAL_DIR, REPORTS_DIR, REVIEW_DIR, DATA_DIR, REPO_ROOT, RUN_DATE,
    streamJsonl, readJsonl, readJson, writeJsonl, writeJson, writeCsv, uuidv5, pct, countBy, sha256File,
} from "./lib/common.mjs";
import { taxonomyCompareKey, OPTION_TYPES } from "./lib/normalize.mjs";
import { compareValues, conflictSeverity, classifyRecovery, importReadiness, findTextDuplicates, RECOVERY_CLASSES } from "./lib/canonical.mjs";
import { indexExportRows, matchExport } from "./lib/qbg_export.mjs";
import { analyzeConflict, categorizeDuplicate, parentChildRelationships } from "./lib/qc.mjs";

/** Drop folder for authorized source documents (DOCX/PDF) matched to the registry by file name or Drive id. */
export const DOCUMENT_DROP_DIR = "data/raw/documents";

const ok = (n) => (n && n.status === "OK" ? n.normalized_value : null);
const TAX_NAME_PRECEDENCE = ["tagging_csv", "autocuration.tagging", "autocuration.chapter_class_map", "important_ids.aits", "autocuration.data"];

// ------------------------------------------------------------------ taxonomy index
async function buildTaxonomy() {
    const ids = new Map();
    const chapterTopic = new Set(), topicSub = new Set();
    const topicChapters = new Map(), subtopicTopics = new Map(), chapterClassIds = new Map();
    const addTo = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
    for await (const t of streamJsonl(path.join(STAGING_DIR, "taxonomy_observations.jsonl"))) {
        if (t.level === "edge") {
            const e = t.edge;
            if (e.chapter && e.topic) { chapterTopic.add(`${e.chapter}>${e.topic}`); addTo(topicChapters, e.topic, e.chapter); }
            if (e.topic && e.subtopic) { topicSub.add(`${e.topic}>${e.subtopic}`); addTo(subtopicTopics, e.subtopic, e.topic); }
            if (e.chapter && e.class) addTo(chapterClassIds, e.chapter, e.class);
            continue;
        }
        if (!ids.has(t.id)) ids.set(t.id, { id: t.id, levels: new Set(), names: new Map() });
        const n = ids.get(t.id);
        n.levels.add(t.level);
        if (t.name) {
            if (!n.names.has(t.source)) n.names.set(t.source, new Map());
            const m = n.names.get(t.source);
            m.set(t.name, (m.get(t.name) || 0) + t.count);
        }
    }
    const taxConflicts = [];
    for (const n of ids.values()) {
        const src = TAX_NAME_PRECEDENCE.find((s) => n.names.has(s));
        n.canonical_name = src ? [...n.names.get(src).entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
        n.canonical_name_source = src || null;
        const keys = new Map();
        for (const [s, m] of n.names) for (const name of m.keys()) {
            const k = taxonomyCompareKey(name);
            if (!keys.has(k)) keys.set(k, []);
            keys.get(k).push({ source: s, name });
        }
        n.name_variants = keys.size;
        if (keys.size > 1) taxConflicts.push({ taxonomy_id: n.id, levels: [...n.levels], canonical_name: n.canonical_name, canonical_name_source: n.canonical_name_source, variants: [...keys.values()].map((v) => v[0].name), sources: [...keys.values()].map((v) => v.map((x) => x.source).join("+")) });
        if (n.levels.size > 1) n.level_collision = true;
    }
    // chapter id -> class NAMES ("11"/"12") via the tagging CSV's class_id column
    const chapterClassById = new Map([...chapterClassIds].map(([ch, cls]) => [ch, new Set([...cls].map((c) => ids.get(c)?.canonical_name).filter(Boolean))]));
    return { ids, chapterTopic, topicSub, taxConflicts, topicChapters, subtopicTopics, chapterClassById };
}

// ------------------------------------------------------------------ optional QBG export
async function loadQbgExport() {
    const statusFile = path.join(STAGING_DIR, "qbg_export_status.json");
    const status = fs.existsSync(statusFile) ? readJson(statusFile) : { status: "NOT_PRESENT", files: [] };
    const rows = [];
    if (status.status === "PRESENT") for await (const r of streamJsonl(path.join(STAGING_DIR, "qbg_export_rows.jsonl"))) rows.push(r);
    return { status, rows, index: indexExportRows(rows) };
}

// ------------------------------------------------------------------ local document drop folder
function scanLocalDocuments() {
    const dir = path.join(REPO_ROOT, DOCUMENT_DROP_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => ({ name: f, path: `${DOCUMENT_DROP_DIR}/${f}`, sha256: sha256File(path.join(dir, f)) }));
}

// ------------------------------------------------------------------ load AC rows (compact projection)
async function loadAutoCuration() {
    const rows = [];
    for await (const r of streamJsonl(path.join(STAGING_DIR, "autocuration_rows.jsonl"))) {
        const qbgId = ok(r.qbg_id);
        const link = ok(r.link);
        const linkQbg = link?.kind === "QBG_QUESTION_PAGE" ? link.id : null;
        const docId = link?.kind === "DRIVE_FILE" ? link.id : null;
        const qFileId = ok(r.question_file?.link)?.id || null;
        const sFile = ok(r.solution_file?.link) || null;
        const position = typeof r.source_question_number === "number" ? r.source_question_number : typeof r.row_number === "number" ? r.row_number : /^\d+$/.test(String(r.row_number ?? "")) ? Number(r.row_number) : null;
        const key = qbgId ? `qbg:${qbgId}` : linkQbg ? `qbg:${linkQbg}` : `acrow:${r.excel_row}`;
        const questionDoc = qFileId || docId;
        rows.push({
            key,
            excel_row: r.excel_row,
            qbg_id: qbgId || linkQbg,
            qbg_id_raw: r.qbg_id.raw_value,
            qbg_id_status: r.qbg_id.status,
            identity_basis: qbgId ? "QBG_ID" : linkQbg ? "QBG_ID_FROM_LINK_ONLY" : questionDoc && position !== null ? "DOCUMENT_POSITION" : "WORKBOOK_ROW",
            link, link_qbg_id_matches: r.link_qbg_id_matches, link_status: r.link.status, link_raw: r.link.raw_value,
            qtype: r.question_type, qtype_orig: r.question_type_original,
            diff: r.difficulty, diff_code: r.difficulty_code,
            source_name: r.source_name, subject: r.subject, chapter: r.chapter, topic: r.topic, subtopic: r.subtopic,
            topic_swapped: r.topic_swapped_with_code, subtopic_swapped: r.subtopic_swapped_with_code,
            codes: r.codes, class_level: r.class_level, class_name_column: r.class_name_column, class_doc_ref: r.class_column_document_ref,
            used_in_exam: r.used_in_exam, row_number: r.row_number, source_question_number: r.source_question_number, position,
            options: r.options, answer: r.answer, date: r.date, pattern: r.pattern,
            question_doc: questionDoc, question_file: r.question_file, solution_file: r.solution_file, solution_doc: sFile?.id || null, solution_doc_kind: sFile?.kind || null,
            qbg_file_name: r.qbg_file_name, chapter_from_chapter_code: r.chapter_from_chapter_code,
            date_of_exam: r.date_of_exam, exam_type: r.exam_type, paper_type: r.paper_type, video: ok(r.video_solution_link),
        });
    }
    return rows;
}

// ------------------------------------------------------------------ test instance key
function testInstanceKey(o) {
    const exam = ok(o.exam)?.exam || null;
    switch (o.test_family) {
        case "AITS": return { key: ["AITS", o.date?.iso || o.date?.raw, o.batch, exam, o.paper ?? ""].join("|"), determinate: !!(o.date?.iso || o.date?.raw) };
        case "PYQ": return { key: ["PYQ", o.test_name, o.year, o.date?.raw, o.shift ?? "", o.paper ?? "", ok(o.subject) || ""].join("|"), determinate: true };
        case "FULL_LENGTH": return { key: ["FULL_LENGTH", o.series, o.test_name].join("|"), determinate: true };
        case "ONEPASS": return { key: ["ONEPASS", o.structure, o.block?.header_cell || "", ok(o.subject) || "", ok(o.chapter) || "", o._segment ?? ""].join("|"), determinate: o.structure !== "TABULAR" || o._segment !== undefined };
        default: // JRTS/RTS: no test number/date in the sheet; tests are separated by numbering resets (INFERRED)
            return { key: [o.test_family, o.year, exam, o.paper ?? "", o._segment !== undefined ? `seg${o._segment}` : ""].join("|"), determinate: o._segment !== undefined };
    }
}

/**
 * Sheets without a test number (JRTS, RTS, Onepass tabular) list tests one after
 * another. A new test is inferred where the question number fails to increase or
 * the context (sheet/year/pattern/paper, or Onepass class/subject/chapter) changes.
 */
export function segmentByNumberingReset(occurrences) {
    const groups = new Map();
    for (const o of occurrences) {
        const tabularOnepass = o.test_family === "ONEPASS" && o.structure === "TABULAR";
        if (!["JRTS", "RTS"].includes(o.test_family) && !tabularOnepass) continue;
        if (!groups.has(o.sheet)) groups.set(o.sheet, []);
        groups.get(o.sheet).push(o);
    }
    for (const list of groups.values()) {
        list.sort((a, b) => a.source_row - b.source_row);
        let seg = 0, prevNum = null, prevCtx = null;
        for (const o of list) {
            const ctx = o.test_family === "ONEPASS" ? [o.class_raw, ok(o.subject), ok(o.chapter)].join("|") : [o.year, ok(o.exam)?.exam, o.paper].join("|");
            if (prevCtx === null || ctx !== prevCtx || (o.question_number !== null && prevNum !== null && o.question_number <= prevNum)) seg++;
            o._segment = seg;
            prevNum = o.question_number ?? prevNum;
            prevCtx = ctx;
        }
    }
}

// ------------------------------------------------------------------ main
export async function runBuild() {
    const tax = await buildTaxonomy();
    const taxName = (id) => (id && tax.ids.get(id)?.canonical_name) || null;
    const acRows = await loadAutoCuration();
    const occAll = readJsonl(path.join(STAGING_DIR, "test_occurrences.jsonl"));
    const occ = occAll.filter((o) => o.structure !== "MIRROR_OF_AITS");
    const docxQs = readJsonl(path.join(DATA_DIR, "extracted", "docx_questions.jsonl"));
    const qbgExport = await loadQbgExport();
    const exportPresent = qbgExport.status.status === "PRESENT";
    const typesById = new Map(); // qbg_id -> question types seen (duplicate evidence)

    // ---------------- group into canonical candidates
    const recs = new Map();
    const getRec = (key) => {
        if (!recs.has(key)) recs.set(key, { key, ac: [], occ: [] });
        return recs.get(key);
    };
    for (const r of acRows) getRec(r.key).ac.push(r);
    const orphanOcc = [];
    for (const o of occ) {
        const id = ok(o.qbg_id);
        if (id) getRec(`qbg:${id}`).occ.push(o);
        else orphanOcc.push(o);
    }

    // ---------------- test instances, position conflicts, within-test duplicates
    segmentByNumberingReset(occ);
    const instances = new Map();
    for (const o of occ) {
        const ti = testInstanceKey(o);
        o._instance = ti.key;
        o._instance_determinate = ti.determinate;
        if (!instances.has(ti.key)) instances.set(ti.key, { key: ti.key, family: o.test_family, determinate: ti.determinate, positions: new Map(), ids: new Map() });
        const inst = instances.get(ti.key);
        const id = ok(o.qbg_id);
        if (o.question_number !== null && o.question_number !== undefined) {
            const pk = `${ok(o.subject) || ""}#${o.question_number}`;
            if (!inst.positions.has(pk)) inst.positions.set(pk, []);
            inst.positions.get(pk).push(o);
        }
        if (id) {
            if (!inst.ids.has(id)) inst.ids.set(id, []);
            inst.ids.get(id).push(o);
        }
    }

    const conflicts = [];
    const addConflict = (c) => { c.conflict_id = `CF-${String(conflicts.length + 1).padStart(6, "0")}`; c.resolution = "UNRESOLVED"; conflicts.push(c); return c.conflict_id; };
    const duplicates = [];
    const addDup = (d) => { d.duplicate_group_id = `DG-${String(duplicates.length + 1).padStart(6, "0")}`; duplicates.push(d); return d.duplicate_group_id; };
    const recConflicts = new Map();
    const noteConflict = (key, id, sev) => { if (!recConflicts.has(key)) recConflicts.set(key, []); recConflicts.get(key).push({ id, sev }); };
    const recDups = new Map();
    const noteDup = (key, id) => { if (!recDups.has(key)) recDups.set(key, []); recDups.get(key).push(id); };

    for (const inst of instances.values()) {
        if (!inst.determinate) continue;
        for (const [pk, list] of inst.positions) {
            const ids = [...new Set(list.map((o) => ok(o.qbg_id)).filter(Boolean))];
            if (ids.length > 1) {
                const cid = addConflict({ record_keys: ids.map((i) => `qbg:${i}`), qbg_ids: ids, field: "test_position", conflict_type: "SAME_TEST_POSITION_DIFFERENT_IDS", severity: "MEDIUM", detail: `${inst.key} position ${pk}`, values: list.map((o) => ({ source: `important_ids:${o.sheet}`, location: o.source_cell, raw: o.qbg_id.raw_value, value: ok(o.qbg_id) })) });
                ids.forEach((i) => noteConflict(`qbg:${i}`, cid, "MEDIUM"));
            }
        }
        for (const [id, list] of inst.ids) {
            if (list.length > 1) {
                const nums = list.map((o) => o.question_number).filter((n) => n !== null).sort((a, b) => a - b);
                const consecutive = nums.length === list.length && nums.every((n, i) => !i || n === nums[i - 1] + 1);
                const gid = addDup({ duplicate_type: "SAME_ID_TWICE_IN_ONE_TEST", confidence: "HIGH", members: [`qbg:${id}`], canonical_candidate: `qbg:${id}`, detail: `${inst.key}: positions ${list.map((o) => o.question_number_raw).join(", ")} (${list.map((o) => o.sheet + "!" + o.source_cell).join(", ")})${consecutive ? "; consecutive positions: possibly a comprehension/passage parent id entered for each child (INFERRED)" : ""}`, action: consecutive ? "REVIEW (likely passage parent id; find child ids)" : "REVIEW (question reused inside one test, or entry error)" });
                noteDup(`qbg:${id}`, gid);
            }
        }
    }

    // ---------------- per-record comparison
    const canonical = [];
    const master = [];
    const metadataRows = [];
    const reviewMalformedAnswers = [];
    const parentChild = [];
    const lowConfidence = [];
    const taxPathIssues = [];

    const docRefs = []; // for the source document registry

    for (const rec of recs.values()) {
        const isQbg = rec.key.startsWith("qbg:");
        const qbgId = isQbg ? rec.key.slice(4) : null;
        const obs = {};
        const push = (field, source, location, raw, value) => { (obs[field] ||= []).push({ source, location, raw, value }); };

        for (const r of rec.ac) {
            const loc = `AutoCuration data row ${r.excel_row}`;
            push("question_type", "autocuration.question_type", loc, r.qtype.raw_value, ok(r.qtype));
            if (ok(r.qtype_orig)) push("question_type", "autocuration.question_type_original", loc, r.qtype_orig.raw_value, ok(r.qtype_orig));
            push("subject", "autocuration.subject", loc, r.subject.raw_value, ok(r.subject));
            if (r.codes.subject) push("subject", "autocuration.subject_code->taxonomy", loc, r.codes.subject, taxName(r.codes.subject));
            push("chapter_id", "autocuration.chapter_code", loc, r.codes.chapter, r.codes.chapter);
            push("topic_id", "autocuration.topic_code", loc, r.codes.topic, r.codes.topic);
            push("subtopic_id", "autocuration.subtopic_code", loc, r.codes.subtopic, r.codes.subtopic);
            push("chapter", "autocuration.chapter", loc, r.chapter.raw_value, ok(r.chapter));
            push("topic", r.topic_swapped ? "autocuration.topic_code(swapped)" : "autocuration.topic", loc, r.topic.raw_value, ok(r.topic));
            push("subtopic", r.subtopic_swapped ? "autocuration.subtopic_code(swapped)" : "autocuration.subtopic", loc, r.subtopic.raw_value, ok(r.subtopic));
            push("difficulty", "autocuration.difficulty_level", loc, r.diff.raw_value, ok(r.diff));
            push("difficulty", "autocuration.difficulty_level_code", loc, r.diff_code.raw_value, ok(r.diff_code));
            push("source", "autocuration.source", loc, r.source_name.raw_value, ok(r.source_name));
            push("class_level", "autocuration.class", loc, r.class_level.raw_value, ok(r.class_level));
            if (r.class_name_column !== null && r.class_name_column !== undefined) push("class_level", "autocuration.class_name", loc, r.class_name_column, String(r.class_name_column));
            if (r.answer.status === "OK") push("answer", "autocuration.Answer*", loc, r.answer.raw_value, r.answer.normalized_value);
            else if (r.answer.status === "UNRESOLVED") reviewMalformedAnswers.push({ record_key: rec.key, qbg_id: qbgId, workbook: "AutoCuration_Lovee (1).xlsx", sheet: "data", row: r.excel_row, question_type: ok(r.qtype), answer_raw: r.answer.raw_value, rule: r.answer.normalization_rule, action: "Confirm the intended answer from the source document; do not coerce." });
            if (r.link_qbg_id_matches === false) {
                const cid = addConflict({ record_keys: [rec.key], qbg_ids: [qbgId], field: "qbg_id_link", conflict_type: "QBG_ID_VS_LINK_ID", severity: "HIGH", values: [{ source: "autocuration.qbg_id", location: loc, raw: r.qbg_id_raw }, { source: "autocuration.link", location: loc, raw: r.link_raw }] });
                noteConflict(rec.key, cid, "HIGH");
            }
            // taxonomy path validity against the tagging tables
            if (r.codes.chapter && r.codes.topic && !tax.chapterTopic.has(`${r.codes.chapter}>${r.codes.topic}`)) taxPathIssues.push({ record_key: rec.key, row: r.excel_row, issue: "CHAPTER_TOPIC_PAIR_NOT_IN_TAGGING_TABLES", chapter_id: r.codes.chapter, topic_id: r.codes.topic });
            if (r.codes.topic && r.codes.subtopic && !tax.topicSub.has(`${r.codes.topic}>${r.codes.subtopic}`)) taxPathIssues.push({ record_key: rec.key, row: r.excel_row, issue: "TOPIC_SUBTOPIC_PAIR_NOT_IN_TAGGING_TABLES", topic_id: r.codes.topic, subtopic_id: r.codes.subtopic });
            // documents
            if (r.question_doc) docRefs.push({ doc: r.question_doc, kind: "DRIVE_FILE", url: `https://drive.google.com/file/d/${r.question_doc}`, via: r.question_file ? "autocuration.QuestionFileLink(hyperlink)" : "autocuration.link", name: r.question_file?.name || null, role_hint: r.question_file ? "QUESTION_PAPER" : null, workbook: "AutoCuration", sheet: "data", row: r.excel_row, record_key: rec.key, qbg_id: qbgId });
            if (r.solution_doc) docRefs.push({ doc: r.solution_doc, kind: r.solution_doc_kind, url: `https://drive.google.com/file/d/${r.solution_doc}`, via: "autocuration.SolutionFileLInk", name: r.solution_file?.name || null, role_hint: "SOLUTION", workbook: "AutoCuration", sheet: "data", row: r.excel_row, record_key: rec.key, qbg_id: qbgId });
            if (r.video?.id) docRefs.push({ doc: r.video.id, kind: r.video.kind, url: r.video.url, via: "autocuration.Video Solution Link", name: null, role_hint: "VIDEO_SOLUTION", workbook: "AutoCuration", sheet: "data", row: r.excel_row, record_key: rec.key, qbg_id: qbgId });
            if (r.class_doc_ref) docRefs.push({ doc: null, kind: "FILE_NAME_ONLY", url: null, via: "autocuration.class(column misuse)", name: r.class_doc_ref.value, role_hint: /solution/i.test(String(r.class_doc_ref.value)) ? "SOLUTION" : null, workbook: "AutoCuration", sheet: "data", row: r.excel_row, record_key: rec.key, qbg_id: qbgId });
        }
        const parentCands = new Set();
        for (const o of rec.occ) {
            const loc = `Important IDs ${o.sheet}!${o.source_cell}`;
            if (ok(o.question_type)) push("question_type", `important_ids.${o.sheet}.Q.Type`, loc, o.question_type.raw_value, ok(o.question_type));
            if (ok(o.subject)) push("subject", `important_ids.${o.sheet}.Subject`, loc, o.subject.raw_value, ok(o.subject));
            if (o.class_level && ok(o.class_level)) push("class_level", `important_ids.${o.sheet}.Class`, loc, o.class_level.raw_value, ok(o.class_level));
            const t = o.aits_taxonomy;
            if (t) {
                if (t.subject_id) push("subject", "important_ids.AITS.subject_id->taxonomy", loc, t.subject_id, taxName(t.subject_id));
                push("chapter_id", "important_ids.AITS.chapter_id", loc, t.chapter_id, t.chapter_id);
                push("topic_id", "important_ids.AITS.topic_id", loc, t.topic_id, t.topic_id);
                push("subtopic_id", "important_ids.AITS.subtopic_id", loc, t.subtopic_id, t.subtopic_id);
                push("chapter", "important_ids.AITS.chapter", loc, t.chapter, t.chapter && String(t.chapter).trim());
                push("topic", "important_ids.AITS.topic", loc, t.topic, t.topic && String(t.topic).trim());
                push("subtopic", "important_ids.AITS.subtopic", loc, t.subtopic, t.subtopic && String(t.subtopic).trim());
                const d = t.difficulty ? String(t.difficulty).trim() : null;
                if (d) push("difficulty", "important_ids.AITS.difficulty", loc, t.difficulty, d);
                if (t.difficulty_code) push("difficulty", "important_ids.AITS.difficulty_code", loc, t.difficulty_code, { 1: "Easy", 2: "Medium", 3: "Hard" }[String(t.difficulty_code)] || null);
            }
            if (o.comp_parent_candidate) parentCands.add(o.comp_parent_candidate);
            const vs = o.video_solution_link && ok(o.video_solution_link);
            if (vs?.id) docRefs.push({ doc: vs.id, kind: vs.kind, url: vs.url, via: "important_ids.AITS.VS", name: null, role_hint: "VIDEO_SOLUTION", workbook: "Important IDs", sheet: o.sheet, row: o.source_row, record_key: rec.key, qbg_id: qbgId });
            const sf = o.block?.source_file?.link && ok(o.block.source_file.link);
            if (sf?.id) docRefs.push({ doc: sf.id, kind: sf.kind, url: sf.url, via: "important_ids.FullLength.SourceFileLink", name: o.block.source_file.label, role_hint: "QUESTION_PAPER", workbook: "Important IDs", sheet: o.sheet, row: o.source_row, record_key: rec.key, qbg_id: qbgId });
            const ff = o.block?.final_file_link && ok(o.block.final_file_link);
            if (ff?.id) docRefs.push({ doc: ff.id, kind: ff.kind, url: ff.url, via: "important_ids.Onepass.FinalFile", name: null, role_hint: "FOLDER", workbook: "Important IDs", sheet: o.sheet, row: o.source_row, record_key: rec.key, qbg_id: qbgId });
        }

        // optional QBG export: metadata observations + content (joined on unique_id only)
        const exp = qbgId ? qbgExport.index.get(qbgId) : null;
        const expRow = exp?.chosen || null;
        if (expRow) {
            const loc = `${expRow.file} row ${expRow.row_number}`;
            const m = expRow.metadata;
            push("question_type", "qbg_export.question_type", loc, expRow.question_type, expRow.question_type);
            for (const [f, v] of [["subject", m.subject], ["chapter", m.chapter], ["topic", m.topic], ["subtopic", m.subtopic], ["difficulty", m.difficulty], ["source", m.source], ["class_level", m.class_level]]) push(f, `qbg_export.${f}`, loc, v, v);
            if (expRow.content.answer_key !== null) push("answer", "qbg_export.answer", loc, expRow.content.answer_rule, expRow.content.answer_key);
        }

        // compare
        const cmp = {};
        for (const f of ["question_type", "subject", "chapter_id", "topic_id", "subtopic_id", "chapter", "topic", "subtopic", "difficulty", "source", "class_level", "answer"]) cmp[f] = compareValues(f, obs[f] || []);
        if (qbgId) typesById.set(qbgId, cmp.question_type.candidates.map((c) => c.value));
        if (exp && exp.status === "DUPLICATE_ROWS_DIFFER") {
            const cid = addConflict({ record_keys: [rec.key], qbg_ids: [qbgId], field: "content", conflict_type: "EXPORT_DUPLICATE_ROWS_DIFFER", severity: "HIGH", values: exp.rows.map((r) => ({ source: "qbg_export", location: `${r.file} row ${r.row_number}`, raw: r.content_hash.slice(0, 16) })) });
            noteConflict(rec.key, cid, "HIGH");
        }
        // names that differ only as variants of an agreed taxonomy id are LOW, and the id's name is used
        for (const lvl of ["chapter", "topic", "subtopic"]) {
            const idc = cmp[`${lvl}_id`];
            if ((idc.status === "AGREE" || idc.status === "SINGLE") && taxName(idc.value)) {
                if (cmp[lvl].status === "CONFLICT") cmp[lvl] = { ...cmp[lvl], status: "NAME_VARIANTS_SAME_ID", value: taxName(idc.value) };
                else if (cmp[lvl].status === "NONE") cmp[lvl] = { status: "FROM_TAXONOMY_ID", value: taxName(idc.value), candidates: [] };
            }
        }
        for (const [field, c] of Object.entries(cmp)) {
            if (c.status !== "CONFLICT" && c.status !== "NAME_VARIANTS_SAME_ID") continue;
            const sev = c.status === "NAME_VARIANTS_SAME_ID" ? "LOW" : conflictSeverity(field, c.candidates.map((x) => x.value));
            const cid = addConflict({
                record_keys: [rec.key], qbg_ids: qbgId ? [qbgId] : [], field,
                conflict_type: c.status === "NAME_VARIANTS_SAME_ID" ? `${field.toUpperCase()}_NAME_VARIANT` : `${field.toUpperCase()}_CONFLICT`,
                severity: sev,
                values: c.candidates.map((x) => ({ value: x.value, sources: x.sources })),
            });
            noteConflict(rec.key, cid, sev);
        }
        if (parentCands.size) {
            for (const p of parentCands) parentChild.push({ record_key: rec.key, qbg_id: qbgId, parent_candidate: p, parent_known_as_record: recs.has(`qbg:${p}`), evidence: "Important IDs AITS column K header 'Comp'", confidence: "LOW", action: "Confirm whether 'Comp' means the comprehension parent; parent_question_id left null until confirmed." });
        }

        // exam (a set, not a conflict)
        const exams = new Set();
        for (const r of rec.ac) { const e = ok(r.exam_type); if (e?.exam) exams.add(e.exam); }
        for (const o of rec.occ) { const e = ok(o.exam); if (e?.exam) exams.add(e.exam); }

        // identity
        const a0 = rec.ac[0];
        let identityConf, identityBasis;
        if (isQbg) {
            const fromRowId = rec.ac.some((r) => r.identity_basis === "QBG_ID");
            identityBasis = fromRowId ? "QBG_ID" : rec.ac.length ? "QBG_ID_FROM_LINK_ONLY" : "QBG_ID_IN_TEST_MAPPING";
            identityConf = identityBasis === "QBG_ID_FROM_LINK_ONLY" ? "MEDIUM" : "HIGH";
        } else {
            identityBasis = a0.identity_basis;
            identityConf = identityBasis === "DOCUMENT_POSITION" ? "MEDIUM" : "LOW";
        }

        const answerVal = cmp.answer.status === "AGREE" || cmp.answer.status === "SINGLE" ? cmp.answer.value : null;
        const qtypeVal = ["AGREE", "SINGLE"].includes(cmp.question_type.status) ? cmp.question_type.value : null;
        const hasTaxonomy = !!(cmp.subject.value || cmp.chapter.value);
        const occCount = rec.occ.length;
        const testFamilies = [...new Set(rec.occ.map((o) => o.test_family))].sort();
        const testInstances = [...new Set(rec.occ.map((o) => o._instance))];
        const qDocs = [...new Set(rec.ac.map((r) => r.question_doc).filter(Boolean))];
        const sDocs = [...new Set(rec.ac.map((r) => r.solution_doc).filter(Boolean))];
        const hasPosition = rec.ac.some((r) => r.question_doc && r.position !== null);
        const confl = recConflicts.get(rec.key) || [];
        const high = confl.filter((c) => c.sev === "HIGH").length;
        const optionsStatus = [...new Set(rec.ac.map((r) => r.options.options_status))].filter((s) => s !== "MISSING");

        // content: only from a matched export row; otherwise null (never estimated)
        const ec = expRow?.content || null;
        const exportOptionsOk = !!ec && (!OPTION_TYPES.has(qtypeVal) || (Array.isArray(ec.options) && ec.options.length === 4));
        const clsIn = {
            identity_confidence: identityConf, question_text: ec?.question_text ?? null, question_complete: !!ec?.question_text, options_ok: exportOptionsOk,
            question_type: qtypeVal, answer_key: answerVal, solution_text: ec?.solution_text ?? null, solution_complete: !!ec?.solution_text,
            subject: cmp.subject.value, has_document_position: hasPosition, has_taxonomy: hasTaxonomy, has_test_usage: occCount > 0,
            high_conflicts: high, duplicate_of: null,
        };
        const cls = classifyRecovery(clsIn);
        const origin = isQbg ? "ORIGINAL_QBG" : "IMPORTED_EXTERNAL";
        const answerFromExport = answerVal !== null && (cmp.answer.candidates[0]?.sources || []).some((s) => s.source === "qbg_export.answer");
        const confidence = {
            identity: identityConf,
            question_content: ec?.question_text ? "HIGH (QBG export)" : "NONE",
            options: ec && Array.isArray(ec.options) && ec.options.length ? "HIGH (QBG export)" : optionsStatus.includes("OPTION_LABELS_ONLY") ? "NONE (labels only)" : "NONE",
            answer: answerVal !== null ? (answerFromExport ? "HIGH" : "MEDIUM") : cmp.answer.status === "CONFLICT" ? "LOW" : "NONE",
            solution: ec?.solution_text ? "HIGH (QBG export)" : "NONE",
            taxonomy: cmp.chapter_id.value && ["AGREE", "SINGLE"].includes(cmp.chapter_id.status) ? (cmp.chapter_id.status === "AGREE" ? "HIGH" : "MEDIUM") : cmp.chapter.value ? "MEDIUM" : "NONE",
            provenance: "HIGH",
        };
        const imp = importReadiness({ identity_confidence: identityConf, content_confidence: ec?.question_text ? "HIGH" : "NONE", open_conflicts: confl.length, origin_type: origin, chapter: cmp.chapter.value }, cls.recovery_class);
        const exportRef = (field) => (expRow ? { source: "qbg_export", file: expRow.file, file_sha256: expRow.file_sha256, row_number: expRow.row_number, column: field } : null);
        const answerRef = answerVal === null ? null : { source: cmp.answer.candidates[0].sources.map((s) => s.source).join("+"), locations: cmp.answer.candidates[0].sources.map((s) => s.location), rule: expRow?.content.answer_rule ?? "workbook Answer* column" };
        const contentSource = !qbgId ? { status: "NOT_APPLICABLE" }
            : !exportPresent ? { status: "NOT_PRESENT", note: "No QBG export available; question body not recovered." }
            : !exp ? { status: "NOT_IN_EXPORT" }
            : exp.status === "DUPLICATE_ROWS_DIFFER" ? { status: "AMBIGUOUS_DUPLICATE_ROWS", rows: exp.rows.map((r) => `${r.file} row ${r.row_number}`) }
            : { status: exp.status === "SINGLE" ? "MATCHED" : "MATCHED_DUPLICATE_ROWS_IDENTICAL", file: expRow.file, row_numbers: exp.rows.map((r) => r.row_number), schema: expRow.schema, issues: expRow.issues };
        const questionId = uuidv5(rec.key);
        if (identityConf === "LOW" || identityConf === "UNKNOWN") lowConfidence.push({ record_key: rec.key, question_id: questionId, qbg_id: qbgId, identity_basis: identityBasis, reason: "no QBG id and no document position", source_rows: rec.ac.map((r) => r.excel_row).join(" "), subject: cmp.subject.value, chapter: cmp.chapter.value, action: "Locate this question in its source document or QBG; otherwise keep as metadata only." });

        const sourceRows = [
            ...rec.ac.map((r) => ({ workbook: "AutoCuration_Lovee (1).xlsx", sheet: "data", row: r.excel_row })),
            ...rec.occ.map((o) => ({ workbook: "Important IDs REplica (1).xlsx", sheet: o.sheet, row: o.source_row, cell: o.source_cell })),
            ...(exp ? exp.rows.map((r) => ({ workbook: r.file, sheet: "qbg_export", row: r.row_number })) : []),
        ];
        const valueOf = (c) => c.value ?? null;
        const record = {
            question_id: questionId,
            record_key: rec.key,
            qbg_id: qbgId,
            origin_type: origin,
            question_text: ec?.question_text ?? null,
            options: ec ? (Array.isArray(ec.options) ? ec.options : null) : null,
            options_status: ec && Array.isArray(ec.options) ? (ec.options.length ? "OPTION_TEXTS (QBG export)" : "NOT_APPLICABLE") : optionsStatus.length ? optionsStatus.join("|") : "MISSING",
            answer_key: answerVal,
            solution_text: ec?.solution_text ?? null,
            content_source: contentSource,
            content_provenance: {
                question_text: ec?.question_text ? exportRef("content") : null,
                options: ec && Array.isArray(ec.options) && ec.options.length ? exportRef("bilingual_options") : null,
                answer: answerRef,
                solution_text: ec?.solution_text ? exportRef("solutions") : null,
            },
            question_type: qtypeVal,
            subject: valueOf(cmp.subject),
            chapter: valueOf(cmp.chapter),
            topic: valueOf(cmp.topic),
            subtopic: valueOf(cmp.subtopic),
            source: valueOf(cmp.source),
            difficulty_level: valueOf(cmp.difficulty),
            class_level: valueOf(cmp.class_level),
            exam: [...exams].sort(),
            parent_question_id: null,
            parent_question_candidates: [...parentCands],
            pyq_listings: rec.occ.filter((o) => o.test_family === "PYQ").map((o) => ({ exam: ok(o.exam)?.exam || null, year: o.year, date: o.date?.raw ?? null, shift: o.shift ?? null, paper: o.paper ?? null, question_number: o.question_number, cell: `${o.sheet}!${o.source_cell}` })),
            taxonomy_ids: { chapter: valueOf(cmp.chapter_id), topic: valueOf(cmp.topic_id), subtopic: valueOf(cmp.subtopic_id) },
            // compact per-field status; full candidates + sources live in qbg_question_metadata.jsonl
            metadata_resolution: Object.fromEntries(Object.entries(cmp).filter(([, c]) => c.status !== "NONE").map(([f, c]) => [f, { status: c.status, value: c.value ?? null, n_candidates: c.candidates.length }])),
            test_usage: { occurrence_count: occCount, test_families: testFamilies, distinct_test_instances: testInstances.length },
            documents: { question_documents: qDocs.map((d) => `gdrive:${d}`), solution_documents: sDocs.map((d) => `gdrive:${d}`), qbg_question_page: qbgId ? `https://qbg-admin.penpencil.co/question-details?question=${qbgId}` : null },
            used_in_exam_batches: [...new Set(rec.ac.flatMap((r) => r.used_in_exam))].sort(),
            conflict_ids: confl.map((c) => c.id),
            conflict_status: high ? "BLOCKING" : confl.length ? "HAS_CONFLICTS" : "NONE",
            duplicate_group_ids: recDups.get(rec.key) || [],
            recovery_class: cls.recovery_class,
            recovery_reasons: cls.reasons,
            confidence,
            import_readiness: imp.import_readiness,
            import_reasons: imp.reasons,
            provenance: {
                identity_basis: identityBasis,
                source_workbooks: [...new Set(sourceRows.map((s) => s.workbook))],
                source_rows: sourceRows,
                source_documents: [...qDocs, ...sDocs].map((d) => `gdrive:${d}`),
                extraction_method: "workbook-cell normalisation (scripts/data/recovery/03_stage.mjs, 05_build.mjs)",
                recovered_on: RUN_DATE,
            },
        };
        canonical.push(record);
        if (isQbg) {
            master.push({
                qbg_id: qbgId, question_id: questionId, identity_basis: identityBasis, identity_confidence: identityConf,
                source_files: record.provenance.source_workbooks,
                observations: [
                    ...rec.ac.map((r) => ({ source: "AutoCuration_Lovee (1).xlsx", sheet: "data", row: r.excel_row, field: r.identity_basis === "QBG_ID" ? "qbg_id" : "link(embedded id)", raw: r.identity_basis === "QBG_ID" ? r.qbg_id_raw : r.link_raw, normalized: qbgId, confidence: r.identity_basis === "QBG_ID" ? "HIGH" : "MEDIUM", link_id_matches: r.link_qbg_id_matches })),
                    ...rec.occ.map((o) => ({ source: "Important IDs REplica (1).xlsx", sheet: o.sheet, row: o.source_row, cell: o.source_cell, field: "QBG IDs", raw: o.qbg_id.raw_value, normalized: ok(o.qbg_id), confidence: o.parse_confidence, hyperlink_id_matches: o.id_hyperlink_matches })),
                ],
                ac_row_count: rec.ac.length, occurrence_count: occCount,
                in_autocuration: rec.ac.length > 0, in_important_ids: occCount > 0,
                question_metadata_present: hasTaxonomy, question_text_present: !!record.question_text, options_present: Array.isArray(record.options) && record.options.length > 0, answer_present: answerVal !== null, solution_present: !!record.solution_text,
                question_file_link: qDocs.map((d) => `gdrive:${d}`), solution_file_link: sDocs.map((d) => `gdrive:${d}`),
                linked_to_content_locally: !!record.question_text, metadata_only: answerVal === null && !record.question_text && !record.solution_text,
                content_source_status: contentSource.status,
                subjects: cmp.subject.candidates.map((c) => c.value), chapters: cmp.chapter.candidates.map((c) => c.value), topics: cmp.topic.candidates.map((c) => c.value), subtopics: cmp.subtopic.candidates.map((c) => c.value),
                question_types: cmp.question_type.candidates.map((c) => c.value), difficulty_levels: cmp.difficulty.candidates.map((c) => c.value), classes: cmp.class_level.candidates.map((c) => c.value), sources: cmp.source.candidates.map((c) => c.value),
                exam_occurrences: testFamilies, test_instances: testInstances, parent_ids: [...parentCands],
                duplicate_group: recDups.get(rec.key) || [], conflict_status: record.conflict_status, recovery_class: cls.recovery_class, confidence,
            });
        }
        metadataRows.push({
            question_id: questionId, record_key: rec.key, qbg_id: qbgId,
            fields: Object.fromEntries(Object.entries(cmp).filter(([, c]) => c.status !== "NONE").map(([f, c]) => [f, { status: c.status, value: c.value ?? null, candidates: c.candidates.map((x) => ({ value: x.value, sources: x.sources.map((s) => ({ source: s.source, location: s.location, raw: s.raw ?? null })) })) }])),
            topic_swapped_rows: rec.ac.filter((r) => r.topic_swapped).map((r) => r.excel_row),
            subtopic_swapped_rows: rec.ac.filter((r) => r.subtopic_swapped).map((r) => r.excel_row),
            class_column_document_refs: rec.ac.filter((r) => r.class_doc_ref).map((r) => ({ row: r.excel_row, value: r.class_doc_ref.value })),
        });
    }

    // ---------------- AC row-level duplicates
    const acKeyCounts = countBy(acRows.filter((r) => r.key.startsWith("qbg:")), (r) => r.key);
    for (const [key, n] of acKeyCounts) if (n > 1) {
        const rows = acRows.filter((r) => r.key === key);
        const gid = addDup({ duplicate_type: "EXACT_ID_MULTIPLE_WORKBOOK_ROWS", confidence: "HIGH", members: [key], canonical_candidate: key, detail: `AutoCuration rows ${rows.map((r) => r.excel_row).join(", ")} share this QBG id; merged into one canonical record, field disagreements recorded as conflicts`, action: "MERGED (same id)" });
        noteDup(key, gid);
    }
    // same document + position (never merged)
    const byPos = new Map();
    for (const r of acRows) {
        if (!r.question_doc || r.position === null) continue;
        const k = `${r.question_doc}#${r.position}#${ok(r.subject) || ""}`;
        if (!byPos.has(k)) byPos.set(k, []);
        byPos.get(k).push(r);
    }
    for (const [k, rows] of byPos) {
        const keys = [...new Set(rows.map((r) => r.key))];
        if (keys.length < 2) continue;
        const sig = (r) => [ok(r.qtype), ok(r.chapter), ok(r.topic), ok(r.subtopic), ok(r.diff)].join("|");
        const sameMeta = new Set(rows.map(sig)).size === 1;
        const withIds = keys.filter((x) => x.startsWith("qbg:"));
        const type = withIds.length > 1 ? "SAME_SOURCE_POSITION_DIFFERENT_QBG_IDS" : "SAME_SOURCE_POSITION";
        const gid = addDup({ duplicate_type: type, confidence: sameMeta ? "MEDIUM" : "LOW", classification: sameMeta ? "PROBABLE_DUPLICATE" : "POSSIBLE_DUPLICATE", members: keys, canonical_candidate: withIds[0] || null, detail: `document gdrive:${k.split("#")[0]} position ${k.split("#")[1]} subject ${k.split("#")[2]}; AutoCuration rows ${rows.map((r) => r.excel_row).join(", ")}; metadata ${sameMeta ? "identical" : "differs"}`, action: "REVIEW (not merged)" });
        keys.forEach((x) => noteDup(x, gid));
    }
    for (const c of canonical) c.duplicate_group_ids = recDups.get(c.record_key) || [];
    for (const m of master) m.duplicate_group = recDups.get(`qbg:${m.qbg_id}`) || [];

    // ---------------- docx questions (IMPORTED_EXTERNAL, unlinked)
    const docCanon = [];
    const textDupPairs = findTextDuplicates(docxQs.map((q) => ({ id: q.doc_question_key, key: q.dedupe_key, block: q.subject })));
    const docDupOf = new Map();
    for (const p of textDupPairs) {
        const gid = addDup({ duplicate_type: p.type, confidence: p.type === "EXACT_TEXT" ? "HIGH" : p.type === "NEAR_TEXT_PROBABLE" ? "MEDIUM" : "LOW", classification: p.type === "EXACT_TEXT" ? "EXACT_DUPLICATE" : p.type === "NEAR_TEXT_PROBABLE" ? "PROBABLE_DUPLICATE" : "POSSIBLE_DUPLICATE", members: [p.a, p.b], canonical_candidate: p.a, similarity: p.similarity, action: p.type === "EXACT_TEXT" ? "b is a duplicate of a" : "REVIEW" });
        if (p.type === "EXACT_TEXT") docDupOf.set(p.b, p.a);
        noteDup(p.a, gid); noteDup(p.b, gid);
    }
    // PYQ citation "[25 Feb, 2021 (Shift-I)]" -> QBG ids listed for that JEE Main paper + subject (candidates only)
    const MONTHS = { jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun", jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec" };
    const pyqIndex = new Map();
    for (const o of occ) {
        if (o.test_family !== "PYQ" || o.test_name !== "JEE Main PYQ" || !ok(o.qbg_id)) continue;
        const parts = String(o.date?.raw || "").split(" "); // "day month year"
        const k = [parts[0], MONTHS[String(parts[1] || "").slice(0, 3).toLowerCase()], o.year, o.shift, ok(o.subject)].join("|");
        if (!pyqIndex.has(k)) pyqIndex.set(k, []);
        pyqIndex.get(k).push(ok(o.qbg_id));
    }
    const pyqCandidates = (citation, subject) => {
        const m = String(citation || "").match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\s*\(Shift-(I{1,2})\)/);
        if (!m) return { parsed: null, candidates: [] };
        const k = [String(Number(m[1])), MONTHS[m[2].slice(0, 3).toLowerCase()], m[3], m[4], subject].join("|");
        return { parsed: { day: Number(m[1]), month: MONTHS[m[2].slice(0, 3).toLowerCase()], year: Number(m[3]), shift: m[4] }, candidates: pyqIndex.get(k) || [] };
    };

    for (const q of docxQs) {
        const qComplete = !q.equations.question_ole.length && !/\[(SYMBOL|IMAGE)\]/.test(q.question_text || "") && !q.issues.some((i) => i.startsWith("OPTION_STRUCTURE"));
        const optionsOk = q.options?.options_status === "OPTION_TEXTS" && q.options.status === "OK" && q.options_raw.length === 4;
        const solComplete = !!q.solution_text && !q.equations.solution_ole.length && !/\[SYMBOL\]/.test(q.solution_text);
        const answerKey = q.answer?.status === "OK" ? q.answer.normalized_value : null;
        const qConfl = [];
        if (q.answer_sources_agree === false) {
            const cid = addConflict({ record_keys: [q.doc_question_key], qbg_ids: [], field: "answer", conflict_type: "ANSWER_CONFLICT", severity: "HIGH", values: [{ source: "answer key", raw: q.answer_key_raw }, { source: "solution answer line", raw: q.solution_answer_line_raw }] });
            qConfl.push({ id: cid, sev: "HIGH" });
        }
        const cls = classifyRecovery({ identity_confidence: "HIGH", question_text: q.question_text, question_complete: qComplete, options_ok: optionsOk || q.question_type === "Integer", question_type: q.question_type, answer_key: answerKey, solution_text: q.solution_text, solution_complete: solComplete, subject: q.subject, has_document_position: true, has_taxonomy: !!q.subject, has_test_usage: false, high_conflicts: qConfl.filter((c) => c.sev === "HIGH").length, duplicate_of: docDupOf.get(q.doc_question_key) || null });
        const contentConf = qComplete ? "MEDIUM" : "LOW";
        const imp = importReadiness({ identity_confidence: "HIGH", content_confidence: contentConf, open_conflicts: qConfl.length, origin_type: "IMPORTED_EXTERNAL", chapter: null }, cls.recovery_class);
        docCanon.push({
            question_id: uuidv5(q.doc_question_key),
            record_key: q.doc_question_key,
            qbg_id: null,
            qbg_link_status: q.qbg_link_status,
            qbg_link_evidence: q.qbg_link_evidence,
            origin_type: "IMPORTED_EXTERNAL",
            question_text: q.question_text,
            // incomplete option sets are not exposed as options (raw fragments stay in options_raw)
            options: q.question_type === "Integer" ? [] : optionsOk ? q.options.normalized_value : null,
            options_raw: q.options_raw,
            answer_key: answerKey,
            answer_kind: q.answer?.answer_kind ?? null,
            solution_text: q.solution_text,
            content_source: { status: "LOCAL_DOCX", file: q.source_document.path },
            content_provenance: {
                question_text: q.question_text ? { source: "local_docx", file: q.source_document.path, file_sha256: q.source_document.sha256, paragraphs: q.source_document.paragraphs } : null,
                options: optionsOk ? { source: "local_docx", file: q.source_document.path, paragraphs: q.source_document.paragraphs } : null,
                answer: answerKey !== null ? { source: "local_docx answer key", file: q.solution_document?.path ?? null, paragraph: q.solution_document?.answer_key_paragraph ?? null, cross_check: q.answer_sources_agree === true ? "solution answer line agrees" : q.answer_sources_agree === false ? "solution answer line DISAGREES" : "no solution answer line" } : null,
                solution_text: q.solution_text ? { source: "local_docx", file: q.solution_document?.path ?? null, file_sha256: q.solution_document?.sha256 ?? null, paragraphs: q.solution_document?.paragraphs ?? [] } : null,
            },
            equation_placeholders: { question: q.equations.question_ole.length, solution: q.equations.solution_ole.length, unmapped_symbols: (q.issues.find((i) => i.startsWith("UNMAPPED_SYMBOL_CHARS:")) || ":0").split(":")[1] * 1 },
            question_type: q.question_type,
            subject: q.subject,
            chapter: null, topic: null, subtopic: null,
            source: "AITS",
            difficulty_level: null,
            class_level: "12",
            class_level_basis: "document header '12th JEE Main' (INFERRED from cover text)",
            exam: ["JEE Main"],
            parent_question_id: null,
            pyq_reference_text: q.pyq_reference_text,
            pyq_reference: (() => {
                const r = pyqCandidates(q.pyq_reference_text, q.subject);
                return { parsed: r.parsed, candidate_qbg_ids_count: r.candidates.length, candidate_qbg_ids: r.candidates, confidence: "LOW", note: "Candidates = every QBG id the Important IDs PYQs sheet lists for this JEE Main paper and subject. The citation gives no question number, so no single id is chosen." };
            })(),
            source_question_number: q.source_question_number,
            equations: q.equations,
            images: q.images,
            extraction_status: q.extraction_status,
            extraction_issues: q.issues,
            recovery_class: cls.recovery_class,
            recovery_reasons: cls.reasons,
            confidence: { identity: "HIGH", question_content: contentConf, options: q.question_type === "Integer" ? "NOT_APPLICABLE" : optionsOk ? "MEDIUM" : "LOW", answer: answerKey !== null ? (q.answer_sources_agree ? "HIGH" : "MEDIUM") : "NONE", solution: solComplete ? "MEDIUM" : q.solution_text ? "LOW" : "NONE", taxonomy: "LOW (subject only)", provenance: "HIGH" },
            conflict_ids: qConfl.map((c) => c.id),
            duplicate_group_ids: recDups.get(q.doc_question_key) || [],
            import_readiness: imp.import_readiness,
            import_reasons: imp.reasons,
            provenance: { source_documents: [q.source_document, q.solution_document].filter(Boolean), extraction_method: q.extraction_method, recovered_on: RUN_DATE },
        });
    }

    // ---------------- source document registry
    const docs = new Map();
    for (const d of docRefs) {
        const id = d.doc ? `${d.kind === "DRIVE_FOLDER" ? "gdrive-folder" : "gdrive"}:${d.doc}` : `filename:${d.name}`;
        if (!docs.has(id)) docs.set(id, { document_id: id, source_url: d.url, source_type: d.kind, provider: d.doc ? "Google Drive" : "unknown (file name only)", names: new Map(), vias: new Map(), role_hints: new Map(), qbg_ids: new Set(), record_keys: new Set(), origin_rows: [] });
        const x = docs.get(id);
        if (d.name) x.names.set(d.name, (x.names.get(d.name) || 0) + 1);
        x.vias.set(d.via, (x.vias.get(d.via) || 0) + 1);
        if (d.role_hint) x.role_hints.set(d.role_hint, (x.role_hints.get(d.role_hint) || 0) + 1);
        if (d.qbg_id) x.qbg_ids.add(d.qbg_id);
        x.record_keys.add(d.record_key);
        if (x.origin_rows.length < 25) x.origin_rows.push(`${d.workbook}/${d.sheet} row ${d.row}`);
    }
    // documents referenced only at sheet level (hyperlinks on headers/labels)
    const sheetLevel = [
        ["gsheet:1xe_rV1AeiJJ5P5ddtJXmVlIWRsLibiJ5tGV2q0zYxYE", "GOOGLE_SHEET", "Important IDs/JRTS B569 'Data for Question ingestion in QBG'"],
        ["gsheet:1ldJ3XIZMsiFf18GiBB5EXiN4yWpT8h8AcwlNF28vMzo", "GOOGLE_SHEET", "Important IDs/PYQs A1 'JEE M & A PYQs <> Bilingual (2021 to 2025)'"],
        ["gsheet:1hX7HWzp59_fqdCTJFQIxFqLFp0SvT5RlTWKYwkrz_JM", "GOOGLE_SHEET", "Important IDs/PYQs B1 'AdhocTracker<>JEE Main & Adv. PYP (5 Years) English 25-26'"],
    ];
    for (const [id, kind, where] of sheetLevel) if (!docs.has(id)) docs.set(id, { document_id: id, source_url: `https://docs.google.com/spreadsheets/d/${id.split(":")[1]}`, source_type: kind, provider: "Google Drive", names: new Map(), vias: new Map([[where, 1]]), role_hints: new Map([["INDEX_SHEET", 1]]), qbg_ids: new Set(), record_keys: new Set(), origin_rows: [where] });
    for (const c of readJsonl(path.join(STAGING_DIR, "curated_tests.jsonl"))) {
        const l = ok(c.sheet_link);
        if (!l?.id) continue;
        const id = `gsheet:${l.id}`;
        if (!docs.has(id)) docs.set(id, { document_id: id, source_url: l.url, source_type: l.kind, provider: "Google Drive", names: new Map(), vias: new Map([["autocuration.output.SheetLink", 1]]), role_hints: new Map([["CURATED_TEST_SHEET", 1]]), qbg_ids: new Set(), record_keys: new Set(), origin_rows: [`AutoCuration/output row ${c.excel_row}`] });
    }
    const roleOf = (x) => {
        const names = [...x.names.keys()];
        if (names.some((n) => /(_|\s)(q|ques|question|questions)\.(pdf|docx?)$/i.test(n))) return { role: "QUESTION_PAPER", basis: "file name suffix", confidence: "HIGH" };
        if (names.some((n) => /(sol|solution|solutions)\.(pdf|docx?)$/i.test(n))) return { role: "SOLUTION", basis: "file name suffix", confidence: "HIGH" };
        const hints = [...x.role_hints.entries()].sort((a, b) => b[1] - a[1]);
        if (hints.length === 1) return { role: hints[0][0], basis: `column semantics (${[...x.vias.keys()].join(", ")})`, confidence: "MEDIUM" };
        if (hints.length > 1) return { role: "AMBIGUOUS", basis: hints.map(([h, n]) => `${h}:${n}`).join(" "), confidence: "LOW" };
        return { role: "QUESTION_DOCUMENT_INFERRED", basis: "AutoCuration `link` on rows without a QBG id (booklet/source file)", confidence: "LOW" };
    };
    const registry = [...docs.values()].map((x) => {
        const r = roleOf(x);
        return {
            document_id: x.document_id,
            source_url: x.source_url,
            source_type: x.source_type,
            provider: x.provider,
            filenames: [...x.names.keys()],
            question_or_solution: r.role,
            role_basis: r.basis,
            role_confidence: r.confidence,
            referenced_via: Object.fromEntries(x.vias),
            associated_qbg_ids_count: x.qbg_ids.size,
            associated_qbg_ids: [...x.qbg_ids].slice(0, 500),
            associated_record_count: x.record_keys.size,
            contains_many_questions: x.record_keys.size > 1,
            origin_rows_sample: x.origin_rows,
            availability: x.source_type === "FILE_NAME_ONLY" ? "UNAVAILABLE (name only, no link)" : "UNAVAILABLE_LOCALLY",
            download_status: "NOT_ATTEMPTED (external; no authorization to fetch)",
            extraction_status: "NOT_EXTRACTED",
            hash: null, page_count: null,
            license_provenance: "PW internal material referenced from project workbooks; access requires authorization",
        };
    });
    // authorized documents dropped into data/raw/documents/: matched by exact file name
    // or by a "<driveId>" / "<driveId>__<anything>" file-name prefix. Registered as
    // present; not extracted (no generic paper parser exists - see SOURCE_INTAKE.md).
    const localDocs = scanLocalDocuments();
    const localDocMatches = [];
    for (const r of registry) {
        const driveId = r.document_id.startsWith("gdrive:") ? r.document_id.slice(7) : null;
        const hit = localDocs.find((f) => r.filenames.includes(f.name) || (driveId && (f.name === driveId || f.name.startsWith(`${driveId}__`) || f.name.startsWith(`${driveId}.`))));
        if (!hit) continue;
        r.availability = "LOCAL_NOT_EXTRACTED";
        r.download_status = "PROVIDED_LOCALLY";
        r.local_path = hit.path;
        r.hash = hit.sha256;
        r.local_match_basis = r.filenames.includes(hit.name) ? "exact file name" : "Drive id in file name";
        localDocMatches.push({ document_id: r.document_id, local_path: hit.path, basis: r.local_match_basis, role: r.question_or_solution, qbg_ids: r.associated_qbg_ids_count });
    }
    const localDocIds = new Set(localDocMatches.map((m) => m.document_id));
    const unmatchedLocalDocs = localDocs.filter((f) => !localDocMatches.some((m) => m.local_path === f.path));
    for (const [key, p, sha, q] of [["local:AITS_Test-03_12th_JEE_15-12-2024_Question.docx", "QUESTION_PAPER"], ["local:AITS_Test-03_12th_JEE_15-12-2024_Solutions.docx", "SOLUTION"]]) {
        const src = docxQs[0]?.[p === "QUESTION_PAPER" ? "source_document" : "solution_document"];
        registry.push({ document_id: key, source_url: null, source_type: "LOCAL_DOCX", provider: "repository", filenames: [key.slice(6)], question_or_solution: p, role_basis: "document content (cover + ANSWER KEY)", role_confidence: "HIGH", referenced_via: {}, associated_qbg_ids_count: 0, associated_qbg_ids: [], associated_record_count: docxQs.length, contains_many_questions: true, origin_rows_sample: [], availability: "LOCAL", download_status: "LOCAL_FILE", extraction_status: "EXTRACTED_PARTIAL (OLE equations unconverted)", hash: src?.sha256 || null, page_count: null, license_provenance: "PW internal test paper present in repository" });
    }
    for (const f of ["qbg modifier sample file.docx", "Batch_Test-word (2).docx"]) registry.push({ document_id: `local:${f}`, source_url: null, source_type: "LOCAL_DOCX", provider: "repository", filenames: [f], question_or_solution: "APP_FIXTURE", role_basis: "content inspection", role_confidence: "HIGH", referenced_via: {}, associated_qbg_ids_count: 0, associated_qbg_ids: [], associated_record_count: 0, contains_many_questions: true, origin_rows_sample: [], availability: "LOCAL", download_status: "LOCAL_FILE", extraction_status: "NOT_EXTRACTED (fixture; no QBG linkage)", hash: null, page_count: null, license_provenance: "app sample" });

    // ---------------- broken links
    const broken = [];
    for (const r of acRows) {
        if (r.link_status === "UNRESOLVED") broken.push({ workbook: "AutoCuration", sheet: "data", row: r.excel_row, column: "link", raw: r.link_raw, problem: "not a URL", record_key: r.key });
        else if (r.link && /STRIP_LEADING_DASH/.test(r.link?.url ? "" : "")) void 0;
        if (typeof r.link_raw === "string" && /^-https?:/.test(r.link_raw)) broken.push({ workbook: "AutoCuration", sheet: "data", row: r.excel_row, column: "link", raw: r.link_raw, problem: "malformed URL (leading '-'); id recovered from it", record_key: r.key });
    }
    for (const o of occAll) {
        if (o.structure === "MIRROR_OF_AITS") continue;
        if (o.video_solution_note) broken.push({ workbook: "Important IDs", sheet: o.sheet, row: o.source_row, column: "VS", raw: o.video_solution_note, problem: "video solution marked unavailable", record_key: ok(o.qbg_id) ? `qbg:${ok(o.qbg_id)}` : null });
    }
    const flLinkCells = occAll.filter((o) => o.sheet.startsWith("Full length")).length;
    broken.push({ workbook: "Important IDs", sheet: "Full length JEE Main+Advanced (", row: null, column: "Link (every block)", raw: "Link", problem: `${flLinkCells} cells read 'Link' but carry no hyperlink target`, record_key: null });

    // ---------------- overlap
    const acIds = new Set(acRows.filter((r) => r.qbg_id).map((r) => r.qbg_id));
    const impIds = new Set(occ.map((o) => ok(o.qbg_id)).filter(Boolean));
    const inter = [...acIds].filter((i) => impIds.has(i));
    const bySheet = new Map();
    for (const o of occ) {
        const id = ok(o.qbg_id);
        if (!id) continue;
        const k = `${o.sheet}|${o.test_family}`;
        if (!bySheet.has(k)) bySheet.set(k, new Set());
        bySheet.get(k).add(id);
    }
    const overlapRows = [...bySheet.entries()].map(([k, set]) => {
        const [sheet, family] = k.split("|");
        const both = [...set].filter((i) => acIds.has(i)).length;
        return { sheet, test_family: family, unique_qbg_ids: set.size, also_in_autocuration: both, only_in_important_ids: set.size - both, pct_in_autocuration: pct(both, set.size) };
    });
    const multiTest = master.filter((m) => m.test_instances.length > 1);
    const multiFamily = master.filter((m) => m.exam_occurrences.length > 1);
    const overlap = {
        autocuration_unique_qbg_ids: acIds.size,
        important_ids_unique_qbg_ids: impIds.size,
        union: new Set([...acIds, ...impIds]).size,
        intersection: inter.length,
        autocuration_only: acIds.size - inter.length,
        important_ids_only: impIds.size - inter.length,
        pct_of_important_ids_in_autocuration: pct(inter.length, impIds.size),
        pct_of_autocuration_in_important_ids: pct(inter.length, acIds.size),
        autocuration_rows_without_qbg_id: acRows.filter((r) => !r.qbg_id).length,
        autocuration_duplicate_id_rows: [...acKeyCounts.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0),
        ids_in_multiple_test_instances: multiTest.length,
        ids_in_multiple_test_families: multiFamily.length,
        by_sheet: overlapRows,
        intersection_by_ac_source: Object.fromEntries(countBy(acRows.filter((r) => r.qbg_id && impIds.has(r.qbg_id)), (r) => ok(r.source_name))),
        ac_only_by_source: Object.fromEntries(countBy(acRows.filter((r) => r.qbg_id && !impIds.has(r.qbg_id)), (r) => ok(r.source_name))),
    };

    // ---------------- occurrences canonical
    const idToQid = new Map(canonical.filter((c) => c.qbg_id).map((c) => [c.qbg_id, c.question_id]));
    const occCanon = occAll.map((o) => ({
        occurrence_id: o.occurrence_id,
        qbg_id: ok(o.qbg_id),
        qbg_id_raw: o.qbg_id.raw_value,
        qbg_id_status: o.qbg_id.status,
        question_id: ok(o.qbg_id) ? idToQid.get(ok(o.qbg_id)) || null : null,
        test_family: o.test_family,
        test_name: o.test_name,
        test_instance_key: o._instance ?? testInstanceKey(o).key,
        test_instance_determinate: o._instance_determinate ?? testInstanceKey(o).determinate,
        series: o.series ?? null,
        sheet: o.sheet,
        source_workbook: "Important IDs REplica (1).xlsx",
        source_row: o.source_row,
        source_cell: o.source_cell,
        year: o.year,
        date: o.date?.iso || (o.date?.raw ?? null),
        shift: o.shift ?? null,
        exam: ok(o.exam)?.exam || null,
        paper: o.paper,
        batch: o.batch,
        subject: ok(o.subject),
        subject_raw: o.subject?.raw_value ?? null,
        question_type: ok(o.question_type),
        question_type_raw: o.question_type?.raw_value ?? null,
        question_number: o.question_number,
        question_number_raw: o.question_number_raw,
        language: null,
        language_note: "not stated in the sheet",
        structure: o.structure,
        parse_confidence: o.parse_confidence,
        mirror_of: o.mirror_of ?? null,
        counts_as_usage: o.structure !== "MIRROR_OF_AITS" && !!ok(o.qbg_id),
        tagging_status: o.tagging_status ?? null,
        remarks: o.remarks ?? null,
        id_hyperlink_matches: o.id_hyperlink_matches,
    }));

    // ---------------- provenance graph edges
    const edges = [];
    for (const c of canonical) {
        for (const s of c.provenance.source_rows) edges.push({ from: c.record_key, to: `${s.workbook}#${s.sheet}!${s.cell || "row" + s.row}`, relation: s.sheet === "qbg_export" ? "CONTENT_FROM_QBG_EXPORT" : s.workbook.startsWith("Auto") ? "METADATA_FROM" : "USED_IN_TEST_ROW", confidence: c.confidence.identity });
        for (const d of c.documents.question_documents) edges.push({ from: c.record_key, to: d, relation: "QUESTION_DOCUMENT", confidence: "MEDIUM" });
        for (const d of c.documents.solution_documents) edges.push({ from: c.record_key, to: d, relation: "SOLUTION_DOCUMENT", confidence: "MEDIUM" });
        if (c.taxonomy_ids.chapter) edges.push({ from: c.record_key, to: `taxonomy:${c.taxonomy_ids.chapter}`, relation: "TAGGED_CHAPTER", confidence: c.confidence.taxonomy });
        if (c.taxonomy_ids.subtopic) edges.push({ from: c.record_key, to: `taxonomy:${c.taxonomy_ids.subtopic}`, relation: "TAGGED_SUBTOPIC", confidence: c.confidence.taxonomy });
        for (const p of c.parent_question_candidates) edges.push({ from: c.record_key, to: `qbg:${p}`, relation: "PARENT_CANDIDATE", confidence: "LOW" });
        if (c.qbg_id) edges.push({ from: c.record_key, to: c.documents.qbg_question_page, relation: "QBG_CONTENT_POINTER (authorized API only)", confidence: "HIGH" });
    }
    for (const d of docCanon) {
        edges.push({ from: d.record_key, to: "local:AITS_Test-03_12th_JEE_15-12-2024_Question.docx", relation: "EXTRACTED_FROM", confidence: "HIGH" });
        edges.push({ from: d.record_key, to: "local:AITS_Test-03_12th_JEE_15-12-2024_Solutions.docx", relation: "SOLUTION_EXTRACTED_FROM", confidence: "HIGH" });
        if (d.pyq_reference_text) edges.push({ from: d.record_key, to: `pyq-citation:${d.pyq_reference_text}`, relation: "CITES_PYQ (text only; not resolved to an id)", confidence: "LOW" });
    }

    // ---------------- QC annotations (explanations only; nothing is resolved)
    const recByKey = new Map([...canonical, ...docCanon].map((r) => [r.record_key, r]));
    for (const c of conflicts) {
        const r = recByKey.get(c.record_keys[0]);
        c.analysis = analyzeConflict(c, { chapterClassById: tax.chapterClassById, canonicalChapterId: r?.taxonomy_ids?.chapter ?? null });
    }
    for (const d of duplicates) d.analysis = categorizeDuplicate(d, { typesById });
    const passageGroups = duplicates.filter((d) => d.analysis.category === "PASSAGE_PARENT_REUSE_INFERRED").map((d) => ({ qbg_id: d.members[0].slice(4), positions: (d.detail.match(/positions ([^(]+)\(/) || [])[1]?.trim() ?? "", test: d.detail.split(":")[0] }));
    const relationships = parentChildRelationships({ compCandidates: parentChild, passageGroups });
    const tname = (id) => (id && tax.ids.get(id)?.canonical_name) || null;
    for (const t of taxPathIssues) {
        if (t.issue === "CHAPTER_TOPIC_PAIR_NOT_IN_TAGGING_TABLES") {
            const known = [...(tax.topicChapters.get(t.topic_id) || [])];
            Object.assign(t, { chapter_name: tname(t.chapter_id), topic_name: tname(t.topic_id), child_known_under: known.map((k) => `${k} (${tname(k) ?? "?"})`).join("; "), category: known.length ? "TOPIC_FILED_UNDER_OTHER_CHAPTER_IN_TAGGING" : "TOPIC_ID_ABSENT_FROM_TAGGING_EDGES" });
        } else {
            const known = [...(tax.subtopicTopics.get(t.subtopic_id) || [])];
            Object.assign(t, { topic_name: tname(t.topic_id), subtopic_name: tname(t.subtopic_id), child_known_under: known.map((k) => `${k} (${tname(k) ?? "?"})`).join("; "), category: known.length ? "SUBTOPIC_FILED_UNDER_OTHER_TOPIC_IN_TAGGING" : "SUBTOPIC_ID_ABSENT_FROM_TAGGING_EDGES" });
        }
        t.action = "Check the question's tagging in QBG; the workbook pair is kept as recorded, not corrected.";
    }

    // ---------------- write canonical outputs
    writeJsonl(path.join(CANONICAL_DIR, "qbg_questions.jsonl"), canonical);
    writeJsonl(path.join(CANONICAL_DIR, "qbg_id_master.jsonl"), master);
    writeJsonl(path.join(CANONICAL_DIR, "qbg_question_metadata.jsonl"), metadataRows);
    writeJsonl(path.join(CANONICAL_DIR, "qbg_test_occurrences.jsonl"), occCanon);
    writeJsonl(path.join(CANONICAL_DIR, "qbg_conflicts.jsonl"), conflicts);
    writeJsonl(path.join(CANONICAL_DIR, "qbg_duplicates.jsonl"), duplicates);
    writeJsonl(path.join(CANONICAL_DIR, "source_document_questions.jsonl"), docCanon);
    writeJsonl(path.join(CANONICAL_DIR, "source_documents.jsonl"), registry);
    writeJsonl(path.join(CANONICAL_DIR, "provenance_edges.jsonl"), edges);
    writeJsonl(path.join(CANONICAL_DIR, "taxonomy_nodes.jsonl"), [...tax.ids.values()].map((n) => ({ taxonomy_id: n.id, levels: [...n.levels], canonical_name: n.canonical_name, canonical_name_source: n.canonical_name_source, name_variant_count: n.name_variants, names_by_source: Object.fromEntries([...n.names].map(([s, m]) => [s, [...m.keys()]])) })));
    writeJson(path.join(CANONICAL_DIR, "sources.json"), {
        sources: [
            { source_id: "autocuration", file: "AutoCuration_Lovee (1).xlsx", role: "QBG metadata/index", status: "PRESENT" },
            { source_id: "important_ids", file: "Important IDs REplica (1).xlsx", role: "QBG id -> test occurrence", status: "PRESENT" },
            { source_id: "tagging_csv", file: "python/qbg_modification/tagging_data/qbg_tagging_table.csv", role: "taxonomy", status: "PRESENT" },
            { source_id: "aits_t03_docx", file: "AITS_Test-03_12th_JEE_15-12-2024_{Question,Solutions}.docx", role: "source document (content)", status: "PRESENT" },
            { source_id: "rankup", file: "data/raw/rankup/*", role: "RankUp registers + generated bank", status: "see rankup_status.json (optional)" },
            { source_id: "qbg_export", file: qbgExport.status.files.map((f) => f.path).join(", ") || "QBG_data*.csv | data/raw/qbg/*", role: "question bodies/options/answers/solutions by unique_id (optional)", status: qbgExport.status.status },
            { source_id: "local_documents", file: `${DOCUMENT_DROP_DIR}/*`, role: "authorized DOCX/PDF source documents matched to the registry (optional)", status: localDocs.length ? `PRESENT (${localDocs.length} files, ${localDocMatches.length} matched)` : "NOT_PRESENT" },
            { source_id: "qbg_api", file: "https://api.penpencil.co/qbg/questions/get-bulk-questions", role: "authoritative question bodies by unique_id", status: "NOT_ACCESSED (requires authorization)" },
            { source_id: "google_drive", file: "Drive documents referenced by the workbooks", role: "question/solution papers", status: "NOT_ACCESSED (requires authorization)" },
        ],
    });

    // ---------------- reports
    const all = [...canonical, ...docCanon];
    const classes = Object.keys(RECOVERY_CLASSES);
    const tally = (items, keyFn) => {
        const m = new Map();
        for (const it of items) {
            const k = keyFn(it) ?? "(unknown)";
            if (!m.has(k)) m.set(k, Object.fromEntries([["group", k], ["total", 0], ...classes.map((c) => [c, 0]), ["answer_present", 0], ["question_link_available", 0], ["solution_link_available", 0], ["with_conflicts", 0], ["in_test_mappings", 0]]));
            const row = m.get(k);
            row.total++;
            row[it.recovery_class]++;
            if (it.answer_key !== null && it.answer_key !== undefined) row.answer_present++;
            if (it.documents?.question_documents?.length) row.question_link_available++;
            if (it.documents?.solution_documents?.length) row.solution_link_available++;
            if (it.conflict_ids.length) row.with_conflicts++;
            if (it.test_usage?.occurrence_count) row.in_test_mappings++;
        }
        return [...m.values()].sort((a, b) => b.total - a.total);
    };
    const qbgOnly = canonical.filter((c) => c.qbg_id);
    const summary = {
        run_date: RUN_DATE,
        canonical_records: canonical.length,
        unique_qbg_ids: qbgOnly.length,
        curation_rows_without_qbg_id: canonical.filter((c) => !c.qbg_id).length,
        source_document_questions: docCanon.length,
        by_class_all: Object.fromEntries(classes.map((c) => [c, all.filter((x) => x.recovery_class === c).length])),
        by_class_qbg_ids: Object.fromEntries(classes.map((c) => [c, qbgOnly.filter((x) => x.recovery_class === c).length])),
        question_recovered: docCanon.filter((d) => d.question_text).length,
        question_recovered_complete: docCanon.filter((d) => ["A_FULL", "B_CONTENT_WITHOUT_SOLUTION"].includes(d.recovery_class)).length,
        options_recovered: docCanon.filter((d) => Array.isArray(d.options) && d.options.length).length,
        answer_recovered_qbg: qbgOnly.filter((c) => c.answer_key !== null).length,
        answer_recovered_docx: docCanon.filter((d) => d.answer_key !== null).length,
        solution_recovered_docx: docCanon.filter((d) => d.solution_text).length,
        question_link_available_qbg: qbgOnly.filter((c) => c.documents.question_documents.length).length,
        solution_link_available_qbg: qbgOnly.filter((c) => c.documents.solution_documents.length).length,
        qbg_ids_in_test_mappings: qbgOnly.filter((c) => c.test_usage.occurrence_count).length,
        conflicts_total: conflicts.length,
        conflicts_by_severity: Object.fromEntries(countBy(conflicts, (c) => c.severity)),
        conflicts_by_type: Object.fromEntries([...countBy(conflicts, (c) => c.conflict_type)].sort((a, b) => b[1] - a[1])),
        records_with_blocking_conflicts: all.filter((x) => x.conflict_status === "BLOCKING" || x.recovery_class === "F_CONFLICT").length,
        duplicate_groups: duplicates.length,
        duplicates_by_type: Object.fromEntries(countBy(duplicates, (d) => d.duplicate_type)),
        orphan_occurrences_invalid_id: orphanOcc.length,
        taxonomy_name_conflicts: tax.taxConflicts.length,
        taxonomy_path_issues: taxPathIssues.length,
        source_documents: registry.length,
        source_documents_by_role: Object.fromEntries(countBy(registry, (r) => r.question_or_solution)),
        import_readiness: Object.fromEntries(countBy(all, (x) => x.import_readiness)),
        import_readiness_qbg_ids: Object.fromEntries(countBy(qbgOnly, (x) => x.import_readiness)),
        qbg_export: (() => {
            const m = matchExport(new Set(qbgOnly.map((c) => c.qbg_id)), qbgExport.index);
            return {
                status: qbgExport.status.status,
                files: qbgExport.status.files.map((f) => ({ path: f.path, rows: f.rows, sha256: f.sha256 })),
                rows_total: qbgExport.status.rows_total,
                export_unique_ids: qbgExport.index.size,
                matched_known_ids: m.matched.length,
                known_ids_not_in_export: exportPresent ? m.known_not_in_export.length : null,
                export_ids_not_known: m.export_only.length,
                qbg_ids_with_question_text: qbgOnly.filter((c) => c.question_text).length,
                qbg_ids_with_solution: qbgOnly.filter((c) => c.solution_text).length,
                content_source_status: Object.fromEntries(countBy(qbgOnly, (c) => c.content_source.status)),
            };
        })(),
        local_documents: { present: localDocs.length, matched_to_registry: localDocMatches.length, unmatched: unmatchedLocalDocs.map((f) => f.path) },
        conflicts_by_category: Object.fromEntries([...countBy(conflicts, (c) => c.analysis.category)].sort((a, b) => b[1] - a[1])),
        conflicts_with_evidence_suggestion: conflicts.filter((c) => c.analysis.evidence_suggestion).length,
        duplicates_by_category: Object.fromEntries(countBy(duplicates, (d) => d.analysis.category)),
        parent_child_relationships: Object.fromEntries(countBy(relationships, (r) => r.relationship_status)),
        overlap,
    };
    writeJson(path.join(REPORTS_DIR, "recovery_summary.json"), summary);
    writeCsv(path.join(REPORTS_DIR, "recovery_summary.csv"), [{ group: "ALL", ...Object.fromEntries(Object.entries(summary).filter(([, v]) => typeof v === "number")) }]);
    const cols = ["group", "total", ...classes, "answer_present", "question_link_available", "solution_link_available", "with_conflicts", "in_test_mappings"];
    writeCsv(path.join(REPORTS_DIR, "recovery_by_subject.csv"), tally(all, (x) => x.subject), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_source.csv"), tally(all, (x) => x.source), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_chapter.csv"), tally(all, (x) => (x.subject ? `${x.subject} / ${x.chapter ?? "(unknown)"}` : null)), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_question_type.csv"), tally(all, (x) => x.question_type), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_difficulty.csv"), tally(all, (x) => x.difficulty_level), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_exam.csv"), tally(all.flatMap((x) => (x.exam?.length ? x.exam.map((e) => ({ ...x, _e: e })) : [{ ...x, _e: null }])), (x) => x._e), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_test.csv"), tally(canonical.flatMap((x) => (x.test_usage.test_families.length ? x.test_usage.test_families.map((f) => ({ ...x, _f: f })) : [{ ...x, _f: "(not in any test mapping)" }])), (x) => x._f), cols);
    writeCsv(path.join(REPORTS_DIR, "recovery_by_origin.csv"), tally(all, (x) => x.origin_type), cols);
    writeCsv(path.join(DATA_DIR, "reports", "qbg_overlap_report.csv"), overlapRows);

    // ---------------- review queues
    writeCsv(path.join(REVIEW_DIR, "missing_content.csv"), canonical.filter((c) => c.qbg_id && !c.question_text).map((c) => ({ qbg_id: c.qbg_id, question_id: c.question_id, recovery_class: c.recovery_class, content_source_status: c.content_source.status, subject: c.subject, chapter: c.chapter, question_type: c.question_type, answer_present: c.answer_key !== null, question_documents: c.documents.question_documents.join(" "), question_document_local: c.documents.question_documents.some((d) => localDocIds.has(d)), qbg_page: c.documents.qbg_question_page, where_content_lives: "QBG platform (unique_id) and/or listed Drive document", action: "Provide an authorized QBG export (data/raw/qbg/) or the listed source document (data/raw/documents/); see SOURCE_INTAKE.md" })));
    const answerConf = conflicts.filter((c) => c.field === "answer");
    const an = (c) => ({ category: c.analysis.category, why_open: c.analysis.why_open, evidence_suggestion: c.analysis.evidence_suggestion ? `${c.analysis.evidence_suggestion.value} (${c.analysis.evidence_suggestion.basis}; ${c.analysis.evidence_suggestion.strength})` : "" });
    writeCsv(path.join(REVIEW_DIR, "answer_conflicts.csv"), [...answerConf.map((c) => ({ conflict_id: c.conflict_id, record_keys: c.record_keys.join(" "), values: JSON.stringify(c.values), severity: c.severity, ...an(c), action: "Check the source solution; choose and record the answer manually" })), ...reviewMalformedAnswers.map((m) => ({ conflict_id: "MALFORMED", record_keys: m.record_key, values: JSON.stringify({ raw: m.answer_raw, rule: m.rule, question_type: m.question_type, row: m.row }), severity: "MEDIUM", category: "MALFORMED_WORKBOOK_ANSWER", why_open: "The cell cannot be read as an answer for this question type without guessing.", evidence_suggestion: "", action: m.action }))], ["conflict_id", "record_keys", "values", "severity", "category", "why_open", "evidence_suggestion", "action"]);
    writeCsv(path.join(REVIEW_DIR, "option_conflicts.csv"), docCanon.filter((d) => d.extraction_issues.some((i) => i.startsWith("OPTION_STRUCTURE"))).map((d) => ({ record_key: d.record_key, question_number: d.source_question_number, issues: d.extraction_issues.join("; "), options_raw: JSON.stringify(d.options_raw), action: "Open the question docx at the listed paragraphs and transcribe the missing options" })), ["record_key", "question_number", "issues", "options_raw", "action"]);
    writeCsv(path.join(REVIEW_DIR, "metadata_conflicts.csv"), conflicts.filter((c) => c.field !== "answer").map((c) => ({ conflict_id: c.conflict_id, severity: c.severity, conflict_type: c.conflict_type, field: c.field, record_keys: c.record_keys.join(" "), values: JSON.stringify(c.values), detail: c.detail || "", ...an(c), action: c.severity === "LOW" ? "Optional: confirm display name / label" : "Decide the correct value from the source; no automatic winner" })));
    writeCsv(path.join(REVIEW_DIR, "duplicate_candidates.csv"), duplicates.map((d) => ({ duplicate_group_id: d.duplicate_group_id, duplicate_type: d.duplicate_type, category: d.analysis.category, same_question_record: d.analysis.same_question_record, relationship_status: d.analysis.relationship_status, evidence: d.analysis.evidence.join("; "), classification: d.classification || (d.duplicate_type.startsWith("EXACT") ? "EXACT_DUPLICATE" : "REVIEW"), confidence: d.confidence, members: d.members.join(" "), canonical_candidate: d.canonical_candidate, similarity: d.similarity ?? "", detail: d.detail || "", action: d.action })));
    // same test position -> different ids: position anomalies, listed with the duplicate analysis
    writeCsv(path.join(REVIEW_DIR, "same_position_anomalies.csv"), conflicts.filter((c) => c.conflict_type === "SAME_TEST_POSITION_DIFFERENT_IDS").map((c) => ({ conflict_id: c.conflict_id, test_position: c.detail, qbg_ids: c.qbg_ids.join(" "), cells: c.values.map((v) => v.location).join(" "), category: "SAME_POSITION_ANOMALY", action: "Check which id belongs at this position (bilingual copy, re-upload, or entry error); nothing merged" })), ["conflict_id", "test_position", "qbg_ids", "cells", "category", "action"]);
    writeCsv(path.join(REVIEW_DIR, "broken_links.csv"), broken);
    writeCsv(path.join(REVIEW_DIR, "low_confidence_records.csv"), [...lowConfidence, ...orphanOcc.map((o) => ({ record_key: null, question_id: null, qbg_id: null, identity_basis: "TEST_POSITION_WITHOUT_VALID_ID", reason: `id cell holds ${JSON.stringify(o.qbg_id.raw_value)}`, source_rows: `${o.sheet}!${o.source_cell}`, subject: ok(o.subject), chapter: o.aits_taxonomy?.chapter ?? null, action: "Find the QBG id for this test position" }))]);
    writeCsv(path.join(REVIEW_DIR, "parent_child_relationships.csv"), relationships, ["child_qbg_id", "parent_candidate", "basis", "relationship_status", "parent_known_as_record", "confidence", "action"]);
    const legacyPc = path.join(REVIEW_DIR, "parent_child_conflicts.csv");
    if (fs.existsSync(legacyPc)) fs.unlinkSync(legacyPc); // superseded by parent_child_relationships.csv (generated output only)
    writeCsv(path.join(REVIEW_DIR, "taxonomy_name_conflicts.csv"), tax.taxConflicts.map((t) => ({ ...t, variants: t.variants.join(" || "), sources: t.sources.join(" || "), levels: t.levels.join(",") })));
    writeCsv(path.join(REVIEW_DIR, "taxonomy_path_issues.csv"), taxPathIssues, ["record_key", "row", "issue", "category", "chapter_id", "chapter_name", "topic_id", "topic_name", "subtopic_id", "subtopic_name", "child_known_under", "action"]);
    // optional-source queues (header-only when the source is absent)
    const expMatch = matchExport(new Set(qbgOnly.map((c) => c.qbg_id)), qbgExport.index);
    writeCsv(path.join(REVIEW_DIR, "qbg_export_unmatched_ids.csv"), expMatch.export_only.map((id) => { const e = qbgExport.index.get(id); return { unique_id: id, rows: e.rows.map((r) => `${r.file} row ${r.row_number}`).join(" "), has_question_text: !!e.chosen?.content.question_text, subject: e.chosen?.metadata.subject ?? null, action: "Not in either workbook: kept out of the canonical set; decide whether to add it" }; }), ["unique_id", "rows", "has_question_text", "subject", "action"]);
    writeCsv(path.join(REVIEW_DIR, "qbg_export_row_issues.csv"), qbgExport.rows.filter((r) => !r.unique_id || r.issues.length).map((r) => ({ file: r.file, row_number: r.row_number, unique_id: r.unique_id, unique_id_raw: r.unique_id_raw, issues: r.issues.join("; ") })), ["file", "row_number", "unique_id", "unique_id_raw", "issues"]);
    writeCsv(path.join(REVIEW_DIR, "local_documents.csv"), [...localDocMatches.map((m) => ({ ...m, status: "MATCHED (not extracted)" })), ...unmatchedLocalDocs.map((f) => ({ document_id: null, local_path: f.path, basis: null, role: null, qbg_ids: 0, status: "UNMATCHED (name matches no registry document)" }))], ["document_id", "local_path", "basis", "role", "qbg_ids", "status"]);
    writeCsv(path.join(REVIEW_DIR, "unresolved_records.csv"), all.filter((x) => x.recovery_class === "H_UNRESOLVED").map((x) => ({ record_key: x.record_key, question_id: x.question_id, reasons: x.recovery_reasons.join("; "), source_rows: x.provenance.source_rows?.map((s) => `${s.sheet} ${s.row}`).join(" ") || "" })));

    return summary;
}

if (process.argv[1]?.endsWith("05_build.mjs")) {
    const s = await runBuild();
    console.log(JSON.stringify({ ...s, overlap: { ...s.overlap, by_sheet: undefined } }, null, 1));
}
