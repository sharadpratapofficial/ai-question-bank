#!/usr/bin/env node
/**
 * Stage 02: column-level profile of every tabular source (read-only).
 * Outputs docs/data_recovery/source_profiles/<source>.{json,md}.
 *
 * Header rows are configured per sheet from direct inspection (HEADER_ROW).
 * Sheets that are forms or side-by-side blocks are profiled by column letter
 * and flagged NON_TABULAR, so no meaning is read into a filename or position.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, DOCS_DIR, readWorkbook, parseCsv, writeJson, writeText, mdTable, colLetter, pct } from "./lib/common.mjs";
import { classifyValue } from "./lib/ids.mjs";
import { SOURCES } from "./sources.mjs";

/** 0-based header row per sheet; null = non-tabular (profile by column letter). */
export const HEADER_ROW = {
    important_ids: { Sheet8: null, JRTS: 0, AITS: 0, PYQs: 1, RTS: 0, "Full length JEE Main+Advanced (": null, "Onepass Test Series": 0, "RTS Hindi": 0, "Copy of AITS": 0 },
    autocuration: { data: 0, MainCurationSheet: null, output: 0, "chapterid-classid mapping": 0, tagging: 0, Curate_Customised_Paper: 2, dropdowns: null, Sheet28: null, Sheet13: 0, ChapterSequence: null },
};

export function resolveSource(key) {
    const s = SOURCES.find((x) => x.key === key);
    const found = s?.candidates.find((c) => fs.existsSync(path.join(REPO_ROOT, c)));
    return found ? path.join(REPO_ROOT, found) : null;
}

// Profiles are committed; the workbooks they sample are not. Keep people's
// addresses out of the sample values (counts are computed before masking).
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
export function maskEmails(s) {
    return s.replace(EMAIL_RE, "$1***@$2");
}

function profileColumn(values) {
    const n = values.length;
    const nonNull = values.filter((v) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === ""));
    const counts = new Map();
    for (const v of nonNull) {
        const k = typeof v === "string" ? v.trim() : String(v);
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    const formats = new Map();
    for (const v of nonNull) {
        const f = classifyValue(v);
        formats.set(f, (formats.get(f) || 0) + 1);
    }
    const jsTypes = new Set(nonNull.map((v) => typeof v));
    const dupValues = [...counts.values()].filter((c) => c > 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
    return {
        rows: n,
        non_null: nonNull.length,
        null_pct: pct(n - nonNull.length, n),
        unique: counts.size,
        values_occurring_more_than_once: dupValues.length,
        duplicate_rows: dupValues.reduce((s, c) => s + c - 1, 0),
        inferred_type: jsTypes.size === 0 ? "EMPTY" : jsTypes.size > 1 ? `MIXED(${[...jsTypes].sort().join("+")})` : [...jsTypes][0],
        formats: Object.fromEntries([...formats.entries()].sort((a, b) => b[1] - a[1])),
        top_values: top.map(([raw, c]) => {
            const v = maskEmails(raw);
            return { value: v.length > 120 ? v.slice(0, 117) + "..." : v, count: c };
        }),
    };
}

function profileGrid(rows, headerRow) {
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const body = headerRow === null ? rows : rows.slice(headerRow + 1);
    const dataRows = body.filter((r) => r.some((v) => v !== null && v !== ""));
    const header = headerRow === null ? [] : rows[headerRow] || [];
    const columns = [];
    for (let c = 0; c < width; c++) {
        const values = dataRows.map((r) => (r[c] === undefined ? null : r[c]));
        if (values.every((v) => v === null || v === "")) continue;
        columns.push({ index: c, letter: colLetter(c), header: header[c] ?? null, ...profileColumn(values) });
    }
    const headerNames = columns.map((c) => c.header).filter((h) => h !== null);
    const repeatedHeaders = [...new Set(headerNames.filter((h, i) => headerNames.indexOf(h) !== i))];
    return { tabular: headerRow !== null, header_row_1based: headerRow === null ? null : headerRow + 1, data_rows: dataRows.length, column_count: columns.length, repeated_header_names: repeatedHeaders, columns };
}

function renderMd(title, profile) {
    const out = [`# Source profile: ${title}`, "", `File: \`${profile.path}\`  `, `SHA-256: \`${profile.sha256 || "n/a"}\``, ""];
    for (const sh of profile.sheets) {
        out.push(`## ${profile.kind === "csv" ? "CSV" : `Sheet \`${sh.name}\``}`, "");
        out.push(`${sh.tabular ? `Tabular, header on row ${sh.header_row_1based}` : "**NON_TABULAR** (form or side-by-side blocks); profiled by column letter"}. Data rows: **${sh.data_rows}**. Non-empty columns: ${sh.column_count}.`);
        if (sh.repeated_header_names.length) out.push("", `Repeated header names: ${sh.repeated_header_names.map((h) => `\`${h}\``).join(", ")} (columns are kept apart by letter).`);
        out.push("");
        out.push(mdTable(
            ["Col", "Header", "Type", "Null %", "Unique", "Dup rows", "Formats", "Top values"],
            sh.columns.map((c) => [
                c.letter, c.header ?? "", c.inferred_type, c.null_pct, c.unique, c.duplicate_rows,
                Object.entries(c.formats).map(([f, n]) => `${f}:${n}`).join(" "),
                c.top_values.slice(0, 4).map((t) => `${t.value.length > 40 ? t.value.slice(0, 37) + "..." : t.value} (${t.count})`).join("; "),
            ]),
        ));
        out.push("");
    }
    return out.join("\n");
}

export function runProfile() {
    const outDir = path.join(DOCS_DIR, "source_profiles");
    const results = {};
    for (const key of ["autocuration", "important_ids"]) {
        const file = resolveSource(key);
        if (!file) continue;
        const wb = readWorkbook(file);
        const sheets = wb.sheetNames.map((name) => ({ name, ...profileGrid(wb.sheets[name].rows, HEADER_ROW[key][name] ?? null) }));
        results[key] = { path: path.relative(REPO_ROOT, file).replace(/\\/g, "/"), kind: "xlsx", sheets };
    }
    const tagFile = resolveSource("tagging_csv");
    if (tagFile) {
        const rows = parseCsv(fs.readFileSync(tagFile, "utf8")).filter((r) => r.some((v) => v !== ""));
        const asNull = rows.map((r) => r.map((v) => (v === "" ? null : v)));
        results.tagging_csv = { path: path.relative(REPO_ROOT, tagFile).replace(/\\/g, "/"), kind: "csv", sheets: [{ name: "csv", ...profileGrid(asNull, 0) }] };
    }
    const inv = fs.existsSync(path.join(DOCS_DIR, "file_inventory.json")) ? JSON.parse(fs.readFileSync(path.join(DOCS_DIR, "file_inventory.json"), "utf8")) : { files: [] };
    for (const [key, prof] of Object.entries(results)) {
        prof.sha256 = inv.files.find((f) => f.path === prof.path)?.sha256 || null;
        writeJson(path.join(outDir, `${key}.json`), prof);
        writeText(path.join(outDir, `${key}.md`), renderMd(SOURCES.find((s) => s.key === key).label, prof));
    }
    return results;
}

if (process.argv[1]?.endsWith("02_profile.mjs")) {
    const r = runProfile();
    for (const [k, v] of Object.entries(r)) console.log(`profile ${k}: ${v.sheets.map((s) => `${s.name}=${s.data_rows}`).join(", ")}`);
}
