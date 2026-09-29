#!/usr/bin/env node
/**
 * Stage 03b: OPTIONAL QBG bulk export (QBG_data.csv or an equivalent authorized
 * CSV / JSON / JSONL export). See lib/qbg_export.mjs for accepted formats and
 * the evidence behind them, and docs/data_recovery/SOURCE_INTAKE.md.
 *
 * Looks in (first match order): $QBG_EXPORT_FILE, <repo>/QBG_data*.csv,
 * data/raw/qbg/*.{csv,json,jsonl}. Read-only on inputs; no database, no network.
 *
 * Outputs:
 *   data/staging/qbg_export_rows.jsonl   one normalised record per data row (empty when absent)
 *   data/staging/qbg_export_status.json  status NOT_PRESENT | PRESENT, per-file stats
 *
 * When no export exists this stage succeeds with status NOT_PRESENT and every
 * downstream stage keeps its metadata-only classifications.
 */
import fs from "node:fs";
import path from "node:path";
import { STAGING_DIR, REPO_ROOT, ensureDir, sha256File, stableStringify, writeJson } from "./lib/common.mjs";
import { findQbgExportFiles, exportFormat, readExportRecords, mapHeaders, normalizeExportRecord, QBG_EXPORT_DROP_DIR } from "./lib/qbg_export.mjs";

export const EXPORT_ROWS_FILE = path.join(STAGING_DIR, "qbg_export_rows.jsonl");
export const EXPORT_STATUS_FILE = path.join(STAGING_DIR, "qbg_export_status.json");

/** Stage the given files (defaults to discovery). Returns the status object. */
export async function runQbgExport({ files = findQbgExportFiles(REPO_ROOT), rowsFile = EXPORT_ROWS_FILE, statusFile = EXPORT_STATUS_FILE, repoRoot = REPO_ROOT } = {}) {
    ensureDir(path.dirname(rowsFile));
    const fd = fs.openSync(rowsFile, "w");
    const fileStats = [];
    const relp = (f) => path.relative(repoRoot, f).split(path.sep).join("/");
    try {
        for (const file of files) {
            const st = { path: relp(file), format: exportFormat(file), bytes: fs.statSync(file).size, sha256: sha256File(file), rows: 0, rows_with_valid_id: 0, rows_invalid_id: 0, rows_with_question_text: 0, rows_with_answer: 0, rows_with_solution: 0, schema: {}, header: null, parse_errors: 0, issues: {} };
            let keysByHeader = new Map();
            for await (const item of readExportRecords(file)) {
                if (item.header) {
                    const m = mapHeaders(item.header);
                    keysByHeader = new Map(item.header.map((h, i) => [h, m.keys[i]]).filter(([, k]) => k));
                    st.header = { recognised: m.recognised, unrecognised: m.unrecognised, duplicate_columns: m.duplicate_columns, qbg_file_id_column_present: m.recognised.includes("qbg_file_id") };
                    if (item.parse_error) { st.parse_errors++; st.issues[item.parse_error] = 1; }
                    continue;
                }
                st.rows++;
                if (!item.record || typeof item.record !== "object") { st.parse_errors++; st.issues[item.parse_error || "NOT_AN_OBJECT"] = (st.issues[item.parse_error || "NOT_AN_OBJECT"] || 0) + 1; continue; }
                if (st.format !== "CSV") keysByHeader = new Map(Object.keys(item.record).map((h) => [h, mapHeaders([h]).keys[0]]).filter(([, k]) => k));
                const n = normalizeExportRecord(item.record, keysByHeader);
                const staged = { file: st.path, file_sha256: st.sha256, row_number: item.row_number, ...n };
                fs.writeSync(fd, stableStringify(staged) + "\n");
                st.schema[n.schema] = (st.schema[n.schema] || 0) + 1;
                if (n.unique_id) st.rows_with_valid_id++; else st.rows_invalid_id++;
                if (n.content.question_text) st.rows_with_question_text++;
                if (n.content.answer_key !== null) st.rows_with_answer++;
                if (n.content.solution_text) st.rows_with_solution++;
                for (const i of n.issues) { const k = i.replace(/\(.*$/, ""); st.issues[k] = (st.issues[k] || 0) + 1; }
            }
            fileStats.push(st);
        }
    } finally {
        fs.closeSync(fd);
    }
    const status = {
        status: files.length ? "PRESENT" : "NOT_PRESENT",
        searched: ["$QBG_EXPORT_FILE", "QBG_data*.csv (repository root)", `${QBG_EXPORT_DROP_DIR}/*.{csv,json,jsonl}`],
        files: fileStats,
        rows_total: fileStats.reduce((s, f) => s + f.rows, 0),
        note: files.length
            ? "Rows staged; joined to known QBG ids on unique_id in 05_build."
            : "No QBG export found. Historical question bodies remain missing; all QBG records keep their metadata-only classification.",
    };
    writeJson(statusFile, status);
    return status;
}

if (process.argv[1]?.endsWith("03b_qbg_export.mjs")) {
    const s = await runQbgExport();
    console.log(`QBG export status = ${s.status}${s.files.length ? ` (${s.files.map((f) => `${f.path}: ${f.rows} rows`).join(", ")})` : ""}`);
}
