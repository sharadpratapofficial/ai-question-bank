/**
 * Server-side helper for the QBG Ingestion feature.
 *
 * Stages an uploaded question Word file (and an optional separate solutions file),
 * shells out to python/qbg_modification/cli.py `ingest` (AI extract question +
 * correct answer + type + worked solution, solving/authoring/drawing anything
 * missing -> build interactive HTML + CSV), and reads the artifacts back so the
 * API route can return them and optionally push to QBG / inject into the bank.
 *
 * Reuses the modification lib's async job store (createReframeJob et al.) — jobs
 * are keyed by a random id and store an opaque payload, so the same map serves
 * both features — and its embedFigures() / provider list.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolvePythonBin } from "@/lib/pythonBin";
import {
    QBG_MOD_PROVIDERS,
    type QbgModProvider,
    type QbgCreds,
    type ReframedRecord,
    type QbgPushResult,
    type ProgressEvent,
} from "./qbgModification";

const PROGRESS_PREFIX = "@@PROGRESS@@";

// Resolved lazily and cached — see src/lib/pythonBin.ts for why the old
// `process.env.QBG_PYTHON || "python"` was unreliable.
const PYTHON_BIN = (): string => resolvePythonBin();
const PYTHON_DIR = path.resolve(process.cwd(), "python", "qbg_modification");
const JOB_ROOT = path.join(tmpdir(), "qbg-ingestion-jobs");

export const QBG_INGEST_PROVIDERS = QBG_MOD_PROVIDERS;
export type QbgIngestProvider = QbgModProvider;

export type QbgQuestionType = "SCQ" | "MCQ" | "Numerical";

export interface IngestQuestionMeta {
    num: number | null;
    type: QbgQuestionType;
    /** SCQ -> "A".."D"; MCQ -> ["A","C"]; Numerical -> the value string. */
    answer: string | string[] | null;
    /** Where the answer came from: "stated" | "answer-key" | "ai-solved" | null. */
    answer_source: string | null;
    /** Where the solution came from: "matched" | "ai-authored" | null. */
    solution_source: string | null;
    diagram_generated: boolean;
}

export interface IngestQuestion {
    num?: number;
    type?: QbgQuestionType;
    answer?: string | string[] | null;
    chapter?: string;
    fig?: string | null;
    [k: string]: unknown;
}

interface IngestReport {
    ok: boolean;
    source_name: string;
    question_count: number;
    requested_count?: number;
    questions: IngestQuestion[];
    modified_records: ReframedRecord[];
    ingestion_meta: IngestQuestionMeta[];
    zip_path: string;
    modified_csv_path: string;
    figdir: string;
    folder: string;
    qbg_results?: QbgPushResult[];
    qbg_results_html_path?: string;
    qbg_error?: string;
    warnings?: string[];
    /** Learned-format id used to extract WITHOUT the AI model (null = AI was used). */
    pattern_used?: string | null;
    /** Format id newly learned from this AI run (future uploads skip the AI). */
    pattern_learned?: string | null;
}

export interface IngestResult {
    sourceName: string;
    questionCount: number;
    requestedCount?: number;
    questions: IngestQuestion[];
    records: ReframedRecord[];
    meta: IngestQuestionMeta[];
    zipBuffer: Buffer;
    zipName: string;
    modifiedCsv: string;
    /** figure filename -> data: URL, for embedding diagrams in the DB / UI. */
    figures: Record<string, string>;
    qbgResults?: QbgPushResult[];
    qbgError?: string;
    qbgResultsHtml?: string;
    warnings?: string[];
    patternUsed?: string | null;
    patternLearned?: string | null;
}

function runPython(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; onProgress?: (ev: ProgressEvent) => void } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn(PYTHON_BIN(), args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let errBuf = "";
        child.stdout?.on("data", (b) => (stdout += b.toString()));
        child.stderr?.on("data", (b) => {
            errBuf += b.toString();
            let idx: number;
            while ((idx = errBuf.indexOf("\n")) >= 0) {
                const line = errBuf.slice(0, idx);
                errBuf = errBuf.slice(idx + 1);
                if (line.startsWith(PROGRESS_PREFIX)) {
                    if (opts.onProgress) {
                        try {
                            opts.onProgress(JSON.parse(line.slice(PROGRESS_PREFIX.length)) as ProgressEvent);
                        } catch {
                            /* ignore */
                        }
                    }
                } else {
                    stderr += line + "\n";
                }
            }
        });
        child.on("error", (err) => {
            resolve({ stdout, stderr: stderr + errBuf + `\nspawn failed: ${err.message}`, code: -1 });
        });
        child.on("exit", (code) => resolve({ stdout, stderr: stderr + errBuf, code: code ?? -1 }));
    });
}

async function rmDirQuiet(dir: string): Promise<void> {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

function mimeForExt(ext: string): string {
    const e = ext.toLowerCase().replace(/^\./, "");
    if (e === "png") return "image/png";
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "gif") return "image/gif";
    if (e === "webp") return "image/webp";
    return "application/octet-stream";
}

async function readFiguresAsDataUrls(figdir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let names: string[] = [];
    try {
        names = await fs.readdir(figdir);
    } catch {
        return out;
    }
    for (const name of names) {
        try {
            const buf = await fs.readFile(path.join(figdir, name));
            out[name] = `data:${mimeForExt(path.extname(name))};base64,${buf.toString("base64")}`;
        } catch {
            /* skip unreadable file */
        }
    }
    return out;
}

export interface IngestArgs {
    questionBuffer: Buffer;
    /** Drives the sidecar's route: .doc/.docx go to the AI extractor, .html is
     *  parsed deterministically (see python/qbg_modification/html_ingest.py). */
    questionName: string;
    /** Optional separate solutions file (omit if solutions live in the question file). */
    solutionBuffer?: Buffer;
    solutionName?: string;
    provider: QbgIngestProvider;
    modelId: string;
    apiKey: string;
    baseUrl?: string;
    /** Let the AI solve questions whose answer is absent (default true). */
    solveMissing: boolean;
    /** Let the AI author a solution when none is present (default true). */
    authorMissing: boolean;
    /**
     * TEMPORARY (RankUp Test Series, 2026-09-05): keep the whole solution —
     * Effective Approach, Detailed Solution, Physical and Consistency Checks and
     * Wrong Answer Analysis — instead of the worked solution alone. Off for every
     * other paper, and removable in one piece when that series is done.
     */
    richSolution?: boolean;
    /**
     * For an .html paper: skip the structural reader and go straight to the AI.
     *
     * Off by default, because the structural reader COPIES the document while the
     * AI re-writes it — and a model asked to extract a solution tidies it, adding
     * entries a teacher never wrote. The structural read falls back to the AI on
     * its own when the layout does not match, so this is only for forcing the
     * issue.
     */
    htmlAi?: boolean;
    /** Draw a figure with an image model when one is described but absent. */
    genDiagrams?: boolean;
    imgProvider?: "gemini" | "openai";
    imgModel?: string;
    imgApiKey?: string;
    /** When true, POST each extracted question to the external QBG API. */
    qbgPush?: boolean;
    category?: string;
    qbgCreds?: QbgCreds;
    /** Live progress callback (sidecar @@PROGRESS@@ events). */
    onProgress?: (ev: ProgressEvent) => void;
}

const EXT_RE = /\.(docx?|html?|xhtml)$/i;
function safeInputName(name: string, fallbackBase: string): string {
    // Preserve the real extension — it decides the whole path: .doc means a
    // LibreOffice pre-conversion, .html means the sidecar parses the file
    // directly instead of calling a model — but don't trust the client's
    // path/name for the on-disk file.
    const m = name.match(EXT_RE);
    const ext = m ? m[0].toLowerCase() : ".docx";
    return fallbackBase + ext;
}

/**
 * Run the full ingestion pipeline. Throws Error on any failure with the sidecar's
 * stderr attached.
 */
export async function ingestWordFile(args: IngestArgs): Promise<IngestResult> {
    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(JOB_ROOT, "ingest-"));
    const outDir = path.join(workDir, "out");
    let extractWorkDir: string | null = null;
    try {
        await fs.mkdir(outDir, { recursive: true });
        const cli = path.join(PYTHON_DIR, "cli.py");

        const qPath = path.join(workDir, safeInputName(args.questionName, "question"));
        await fs.writeFile(qPath, args.questionBuffer);

        const cliArgs = [cli, "ingest", qPath, outDir,
            "--provider", args.provider, "--model", args.modelId];

        if (args.solutionBuffer) {
            const sPath = path.join(workDir, safeInputName(args.solutionName || "solution.docx", "solution"));
            await fs.writeFile(sPath, args.solutionBuffer);
            cliArgs.push("--solution-docx", sPath);
        }
        if (!args.solveMissing) cliArgs.push("--no-solve");
        if (!args.authorMissing) cliArgs.push("--no-author");
        if (args.richSolution) cliArgs.push("--rich-solution");
        if (args.htmlAi) cliArgs.push("--html-ai");
        if (args.genDiagrams) {
            cliArgs.push("--gen-diagrams", "--img-provider", args.imgProvider || "gemini");
            if (args.imgModel) cliArgs.push("--img-model", args.imgModel);
        }
        if (args.qbgPush) {
            cliArgs.push("--qbg-push");
            if (args.category) cliArgs.push("--category", args.category);
        }

        const env: Record<string, string> = { QBG_MOD_API_KEY: args.apiKey, PYTHONIOENCODING: "utf-8" };
        if (args.baseUrl) env.QBG_MOD_BASE_URL = args.baseUrl;
        if (args.imgApiKey) env.QBG_MOD_IMG_API_KEY = args.imgApiKey;
        if (args.qbgCreds) {
            env.QBG_TOKEN = args.qbgCreds.token;
            env.QBG_USER = args.qbgCreds.user;
            env.QBG_USER_ID = args.qbgCreds.userId;
        }

        const { stdout, stderr, code } = await runPython(cliArgs, { cwd: PYTHON_DIR, env, onProgress: args.onProgress });
        if (code !== 0) {
            throw new Error(`ingest exited ${code}. ${stderr.slice(0, 4000).trim()}`);
        }

        const line = stdout.trim().split("\n").pop() || "{}";
        let report: IngestReport;
        try {
            report = JSON.parse(line) as IngestReport;
        } catch {
            throw new Error(`could not parse sidecar output: ${line.slice(0, 500)}`);
        }
        extractWorkDir = report.figdir ? path.dirname(report.figdir) : null;

        const zipBuffer = await fs.readFile(report.zip_path);
        const modifiedCsv = await fs.readFile(report.modified_csv_path, "utf8").catch(() => "");
        const figures = await readFiguresAsDataUrls(report.figdir);
        const qbgResultsHtml = report.qbg_results_html_path
            ? await fs.readFile(report.qbg_results_html_path, "utf8").catch(() => "")
            : "";

        return {
            sourceName: report.source_name,
            questionCount: report.question_count,
            requestedCount: report.requested_count,
            questions: report.questions || [],
            records: report.modified_records || [],
            meta: report.ingestion_meta || [],
            zipBuffer,
            zipName: `${report.source_name}.zip`,
            modifiedCsv,
            figures,
            qbgResults: report.qbg_results,
            qbgError: report.qbg_error,
            qbgResultsHtml: qbgResultsHtml || undefined,
            warnings: report.warnings,
            patternUsed: report.pattern_used ?? null,
            patternLearned: report.pattern_learned ?? null,
        };
    } finally {
        await rmDirQuiet(workDir);
        if (extractWorkDir) await rmDirQuiet(extractWorkDir);
    }
}
