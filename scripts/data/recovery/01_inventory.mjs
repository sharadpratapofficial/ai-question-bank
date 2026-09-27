#!/usr/bin/env node
/**
 * Stage 01: inventory every relevant file in the repository (read-only).
 * Outputs docs/data_recovery/file_inventory.{json,md}.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { REPO_ROOT, DOCS_DIR, rel, sha256File, readWorkbook, parseCsv, writeJson, writeText, mdTable, RUN_DATE } from "./lib/common.mjs";
import { SOURCES, RANKUP_DROP_DIR } from "./sources.mjs";
import { parseCsvChunks } from "./lib/qbg_export.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".next-dev", "__pycache__", "data"]);
const SKIP_PREFIXES = ["scripts/data/"]; // this pipeline's own code is not a source
const DATA_EXT = new Set([".xlsx", ".xls", ".csv", ".docx", ".pdf", ".pptx", ".html", ".json", ".md", ".sql", ".txt"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".py"]);

function walk(dir, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (SKIP_PREFIXES.some((pre) => rel(p).startsWith(pre))) continue;
        if (ent.isDirectory()) walk(p, out);
        else out.push(p);
    }
}

function categorize(relPath, ext) {
    const known = SOURCES.find((s) => s.candidates.includes(relPath));
    if (known) return { category: known.category, purpose: known.purpose, source_key: known.key };
    if (relPath.startsWith("scripts/sql/")) return { category: "SCHEMA", purpose: "SQL migration / schema / validation" };
    if (relPath === "docs/SCHEMA_REBUILD_AUDIT.md") return { category: "SCHEMA", purpose: "Evidence audit for the reconstructed schema" };
    if (CODE_EXT.has(ext)) return { category: "APPLICATION_CODE", purpose: "Application / sidecar code" };
    if (relPath.startsWith("python/qbg_modification/patterns_data/")) return { category: "APPLICATION_CODE", purpose: "QBG modification pattern specs (app config data)" };
    if (/\.(docx|pdf)$/i.test(relPath)) return { category: "SOURCE_DOCUMENT", purpose: "Document (not linked to QBG ids by content)" };
    return { category: "UNKNOWN", purpose: "Not a question-bank data source (presentation, doc, config or asset)" };
}

async function describeDocx(file) {
    const z = await JSZip.loadAsync(fs.readFileSync(file));
    const names = Object.keys(z.files);
    const xml = (await z.file("word/document.xml")?.async("string")) || "";
    const text = xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
    return {
        text_chars: text.length,
        paragraphs: (xml.match(/<w:p[ >]/g) || []).length,
        media_files: names.filter((n) => n.startsWith("word/media/")).length,
        ole_objects: names.filter((n) => n.startsWith("word/embeddings/")).length,
        omml_equations: (xml.match(/<m:oMath[ >]/g) || []).length,
    };
}

async function describePptx(file) {
    const z = await JSZip.loadAsync(fs.readFileSync(file));
    return { slides: Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length };
}

function describePdf(file) {
    const buf = fs.readFileSync(file).toString("latin1");
    return { pdf_page_count_heuristic: (buf.match(/\/Type\s*\/Page(?!s)/g) || []).length };
}

function describeWorkbook(file) {
    const wb = readWorkbook(file);
    return {
        sheets: wb.sheetNames.map((name) => {
            const s = wb.sheets[name];
            const nonEmpty = s.rows.filter((r) => r.some((v) => v !== null && v !== "")).length;
            const cols = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
            return { name, ref: s.ref, row_count_including_header: nonEmpty, grid_rows: s.rows.length, column_count: cols, merged_ranges: s.merges };
        }),
    };
}

/** Row/column counts. Streamed, so a large export (e.g. a ~190 MB QBG_data.csv) is never held in memory. */
async function describeCsv(file) {
    let header = null, rows = 0;
    const chunks = (async function* () { for await (const c of fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })) yield c; })();
    for await (const r of parseCsvChunks(chunks)) {
        if (!r.some((v) => v !== "")) continue;
        if (!header) header = r; else rows++;
    }
    return { row_count: rows, column_count: header?.length || 0, columns: header || [] };
}

export async function runInventory() {
    const files = [];
    walk(REPO_ROOT, files);
    // data/ holds generated output and is skipped, except data/raw/: human-supplied inputs
    // (QBG export, RankUp files, documents, other backups) are inventoried with their hashes.
    const rawDir = path.join(REPO_ROOT, "data", "raw");
    if (fs.existsSync(rawDir)) walk(rawDir, files);
    const entries = [];
    for (const f of files.sort()) {
        const r = rel(f);
        const ext = path.extname(f).toLowerCase();
        const isRelevantData = DATA_EXT.has(ext) || /\.(pptx|xlsx)$/i.test(f);
        const isCode = CODE_EXT.has(ext) && (r.startsWith("src/") || r.startsWith("python/") || r.startsWith("scripts/") || r.startsWith("MCQ_Reframer_App/"));
        if (!isRelevantData && !isCode) continue;
        if (ext === ".json" && !r.startsWith("python/")) continue; // package/tsconfig/launch json are not data sources
        const stat = fs.statSync(f);
        const cat = categorize(r, ext);
        const entry = { path: r, filename: path.basename(f), extension: ext, size_bytes: stat.size, sha256: sha256File(f), source_category: cat.category, likely_purpose: cat.purpose, source_key: cat.source_key || null, status: "PRESENT" };
        try {
            if (ext === ".xlsx" || ext === ".xls") Object.assign(entry, describeWorkbook(f));
            else if (ext === ".csv") Object.assign(entry, await describeCsv(f));
            else if (ext === ".docx") Object.assign(entry, await describeDocx(f));
            else if (ext === ".pptx") Object.assign(entry, await describePptx(f));
            else if (ext === ".pdf") Object.assign(entry, describePdf(f));
            else if ([".md", ".txt", ".sql", ".html"].includes(ext)) entry.text_chars = fs.readFileSync(f, "utf8").length;
        } catch (e) {
            entry.describe_error = String(e.message || e);
        }
        entries.push(entry);
    }

    // Expected sources that are absent are listed explicitly (never silently dropped).
    const missing = [];
    for (const s of SOURCES) {
        const found = s.candidates.find((c) => fs.existsSync(path.join(REPO_ROOT, c)));
        if (!found) missing.push({ path: null, filename: s.label, source_category: s.category, likely_purpose: s.purpose, source_key: s.key, status: "MISSING", searched: s.candidates });
    }
    const dropDir = path.join(REPO_ROOT, RANKUP_DROP_DIR);
    const extraRankup = fs.existsSync(dropDir) ? fs.readdirSync(dropDir) : [];

    const inventory = {
        generated_for: RUN_DATE,
        scope: "Repository folder only (S:\\Projects\\ai-question-bank), per user instruction. node_modules/.git/.next/.next-dev/data/ excluded, except data/raw/ (supplied inputs).",
        files: entries,
        missing_expected_sources: missing,
        rankup_drop_dir: { path: RANKUP_DROP_DIR, exists: fs.existsSync(dropDir), files: extraRankup },
    };
    writeJson(path.join(DOCS_DIR, "file_inventory.json"), inventory);

    const dataRows = entries.filter((e) => e.source_category !== "APPLICATION_CODE");
    const codeCount = entries.length - dataRows.length;
    const md = [
        "# File inventory",
        "",
        `Generated by \`scripts/data/recovery/01_inventory.mjs\`. Scope: ${inventory.scope}`,
        "",
        "Machine-readable version (with SHA-256 for every file, including code): [`file_inventory.json`](file_inventory.json).",
        "",
        "## Data, document and schema files",
        "",
        mdTable(
            ["Path", "Category", "Size", "Detail", "SHA-256 (first 12)"],
            dataRows.map((e) => [
                e.path,
                e.source_category,
                e.size_bytes,
                e.sheets ? e.sheets.map((s) => `${s.name}: ${s.row_count_including_header}r x ${s.column_count}c`).join("; ")
                    : e.row_count !== undefined ? `${e.row_count} rows x ${e.column_count} cols`
                    : e.ole_objects !== undefined ? `${e.paragraphs} paras, ${e.media_files} media, ${e.ole_objects} OLE (MathType) objects, ${e.omml_equations} OMML`
                    : e.slides !== undefined ? `${e.slides} slides`
                    : e.pdf_page_count_heuristic !== undefined ? `~${e.pdf_page_count_heuristic} pages (heuristic)`
                    : e.text_chars !== undefined ? `${e.text_chars} chars` : "",
                e.sha256.slice(0, 12),
            ]),
        ),
        "",
        `Plus ${codeCount} application-code files (category APPLICATION_CODE; listed with hashes in the JSON).`,
        "",
        "## Expected sources that are MISSING from the repository",
        "",
        missing.length ? mdTable(["Expected file", "Category", "Purpose", "Paths searched"], missing.map((m) => [m.filename, m.source_category, m.likely_purpose, m.searched.join(", ")])) : "None.",
        "",
        `RankUp drop folder \`${RANKUP_DROP_DIR}/\`: ${inventory.rankup_drop_dir.exists ? `${extraRankup.length} file(s)` : "does not exist"}. Copy RankUp files there and re-run the pipeline to ingest them.`,
    ].join("\n");
    writeText(path.join(DOCS_DIR, "file_inventory.md"), md);
    return inventory;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("01_inventory.mjs")) {
    const inv = await runInventory();
    console.log(`inventory: ${inv.files.length} files, ${inv.missing_expected_sources.length} expected sources missing`);
}
