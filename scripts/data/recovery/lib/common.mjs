/**
 * Shared IO helpers for the local data-recovery pipeline.
 *
 * Everything here is local-only: no network, no database. Source files are
 * opened read-only; every output goes under data/ or docs/data_recovery/.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const STAGING_DIR = path.join(DATA_DIR, "staging");
export const CANONICAL_DIR = path.join(DATA_DIR, "canonical");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");
export const REVIEW_DIR = path.join(DATA_DIR, "review");
export const DOCS_DIR = path.join(REPO_ROOT, "docs", "data_recovery");

/** Fixed "as of" stamp so re-runs produce byte-identical outputs. Override with RECOVERY_RUN_DATE. */
export const RUN_DATE = process.env.RECOVERY_RUN_DATE || "2026-09-27";

export function rel(p) {
    return path.relative(REPO_ROOT, p).split(path.sep).join("/");
}

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

export function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function sha256Text(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * RFC 4122 v5 UUID. Used to derive a stable question_id from a QBG id so that
 * re-running the pipeline (and any later import) is idempotent. These UUIDs are
 * NEW identifiers minted by this pipeline, not recovered historical values.
 */
export const RECOVERY_UUID_NAMESPACE = "6f1c2a7e-9b1d-5c3e-8a4f-2d7b9e0c1a55";
export function uuidv5(name, namespace = RECOVERY_UUID_NAMESPACE) {
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const hash = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(String(name), "utf8")])).digest();
    const b = Buffer.from(hash.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const wbCache = new Map();
/**
 * Read a workbook read-only into
 *   { sheetNames, sheets: { name: { rows, ref, merges, links } } }
 * rows are 0-based arrays anchored at A1 (so rows[r][c] is cell (r,c)), and
 * links maps "r,c" -> hyperlink target. Hyperlinks matter here: several
 * columns show a file name or the word "Link" while the real Drive/QBG target
 * lives only in the cell's hyperlink.
 */
export function readWorkbook(file) {
    if (wbCache.has(file)) return wbCache.get(file);
    const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", cellDates: false });
    const out = { sheetNames: wb.SheetNames, sheets: {} };
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const links = new Map();
        for (const addr of Object.keys(ws)) {
            if (addr[0] === "!" || !ws[addr].l?.Target) continue;
            const { r, c } = XLSX.utils.decode_cell(addr);
            links.set(`${r},${c}`, ws[addr].l.Target.replace(/&amp;/g, "&"));
        }
        let rows = [];
        if (ws["!ref"]) {
            const range = XLSX.utils.decode_range(ws["!ref"]);
            // Anchor at A1 so row/column indexes equal spreadsheet coordinates.
            range.s.r = 0;
            range.s.c = 0;
            rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true, range });
        }
        out.sheets[name] = { rows, ref: ws["!ref"] || null, merges: (ws["!merges"] || []).length, links };
    }
    wbCache.set(file, out);
    return out;
}

/** Minimal RFC 4180 CSV parser (handles quoted fields, embedded newlines and "" escapes). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let i = 0;
    let inQuotes = false;
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    for (; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); rows.push(row); row = []; field = "";
        } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
}

export function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(file, rows, columns) {
    ensureDir(path.dirname(file));
    const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
    const lines = [cols.map(csvCell).join(",")];
    for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

/** JSON with object keys sorted, so output is deterministic across runs. */
export function stableStringify(value) {
    return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
        const o = {};
        for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
        return o;
    }
    return v;
}

export function writeJsonl(file, records) {
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, "w");
    try {
        for (const r of records) fs.writeSync(fd, stableStringify(r) + "\n");
    } finally {
        fs.closeSync(fd);
    }
}

/** Stream a JSONL file record by record (large staging files are never fully materialised as text). */
export async function* streamJsonl(file) {
    if (!fs.existsSync(file)) return;
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield JSON.parse(line);
}

export function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function writeJson(file, value) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(sortKeys(value), null, 2) + "\n", "utf8");
}

export function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeText(file, text) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
}

export function isBlank(v) {
    return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export function cellStr(v) {
    if (isBlank(v)) return null;
    return String(v).trim();
}

/** Excel column letter for a 0-based index. */
export function colLetter(i) {
    let s = "";
    let n = i + 1;
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** Markdown table from rows of plain values. */
export function mdTable(headers, rows) {
    const esc = (v) => (v === null || v === undefined ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
    return [
        `| ${headers.map(esc).join(" | ")} |`,
        `|${headers.map(() => "---").join("|")}|`,
        ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
    ].join("\n");
}

export function countBy(items, keyFn) {
    const m = new Map();
    for (const it of items) {
        const k = keyFn(it);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
}

export function pct(n, d) {
    return d ? Math.round((n / d) * 10000) / 100 : 0;
}
