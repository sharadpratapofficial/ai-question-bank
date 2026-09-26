/**
 * Server-side helper for the QBG Modification feature (the MCQ Reframer).
 *
 * Stages an uploaded Word test, shells out to python/qbg_modification/cli.py
 * (extract -> AI reframe -> build interactive HTML + CSV), and reads every
 * artifact back into memory so the API route can return them and optionally
 * inject the reframed questions into the Supabase question bank.
 *
 * The Python interpreter is resolved from QBG_PYTHON (same env var the video
 * pipeline uses); the provider API key is forwarded as QBG_MOD_API_KEY so it
 * never appears in a process listing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { resolvePythonBin } from "@/lib/pythonBin";

// Resolved lazily and cached — see src/lib/pythonBin.ts for why the old
// `process.env.QBG_PYTHON || "python"` was unreliable.
const PYTHON_BIN = (): string => resolvePythonBin();
const PYTHON_DIR = path.resolve(process.cwd(), "python", "qbg_modification");
const JOB_ROOT = path.join(tmpdir(), "qbg-modification-jobs");

// ---------------------------------------------------------------------------
// Async job store — the reframe pipeline (extract + LLM + build, sometimes a
// QBG fetch/push too) routinely runs longer than an edge proxy's ~100s request
// window, which returns an HTML error page and breaks res.json() on the client.
// So the POST starts a job and returns a jobId immediately; the client polls.
// State is process-global (this feature already needs a persistent Node process).
// ---------------------------------------------------------------------------
export type QbgModJobState = "running" | "done" | "error";

/** A single progress event streamed from the sidecar (`@@PROGRESS@@` lines). */
export interface ProgressEvent {
    stage: string;
    msg: string;
    done?: number;
    total?: number;
    /** ISO time the event was recorded (added on ingest). */
    at?: string;
}

interface QbgModJob {
    state: QbgModJobState;
    result?: unknown;
    error?: string;
    createdAt: number;
    /** Live progress log while running — surfaced by the poll GET for the UI. */
    progress: ProgressEvent[];
}
const _jg = globalThis as typeof globalThis & { __qbgModJobs?: Map<string, QbgModJob> };
if (!_jg.__qbgModJobs) _jg.__qbgModJobs = new Map<string, QbgModJob>();
const qbgModJobs = _jg.__qbgModJobs;

function cleanupOldJobs(): void {
    const now = Date.now();
    for (const [id, j] of qbgModJobs) {
        if (now - j.createdAt > 30 * 60 * 1000) qbgModJobs.delete(id);
    }
}

export function createReframeJob(): string {
    cleanupOldJobs();
    const id = crypto.randomBytes(9).toString("hex");
    qbgModJobs.set(id, { state: "running", createdAt: Date.now(), progress: [] });
    return id;
}

/** Append a progress event to a running job (capped). Used by the routes' onProgress. */
export function appendJobProgress(id: string, ev: ProgressEvent): void {
    const j = qbgModJobs.get(id);
    if (!j) return;
    j.progress.push({ ...ev, at: new Date().toISOString() });
    if (j.progress.length > 300) j.progress.splice(0, j.progress.length - 300);
}

/** Current progress log for a job (for the poll GET). */
export function getJobProgress(id: string): ProgressEvent[] {
    return qbgModJobs.get(id)?.progress ?? [];
}

export function completeReframeJob(id: string, result: unknown): void {
    const j = qbgModJobs.get(id);
    if (j) { j.state = "done"; j.result = result; }
}

export function failReframeJob(id: string, error: string): void {
    const j = qbgModJobs.get(id);
    if (j) { j.state = "error"; j.error = error; }
}

export function getReframeJob(id: string): QbgModJob | undefined {
    return qbgModJobs.get(id);
}

export function deleteReframeJob(id: string): void {
    qbgModJobs.delete(id);
}

/** Providers the sidecar (llm.py) supports — the same set the rest of the app uses. */
export const QBG_MOD_PROVIDERS = [
    "gemini", "anthropic", "openai", "openrouter", "groq", "grok",
    "nvidia", "fireworks", "custom_openai", "local", "g4f",
] as const;
export type QbgModProvider = (typeof QBG_MOD_PROVIDERS)[number];

export interface ReframedOption {
    /** true = correct, false = wrong, null = no option (numeric question). */
    isCorrect: boolean | null;
    /** Option HTML (may be null for numeric questions). */
    text: string | null;
}

export interface ReframedRecord {
    content: string;
    options: Array<[boolean | null, string | null]>; // [isCorrect, html]
    solution: string;
    /** Present only when `options` is empty (Numerical/no-option question) — the
     *  AI's plain numeric answer, e.g. "42". See csvbuild.py's modified_records(). */
    answer?: string | null;
}

export interface ReframedQuestion {
    chapter?: string;
    answer?: string;
    fig?: string | null;
    // plus stem/options/solution parts — not needed server-side beyond preview
    [k: string]: unknown;
}

export interface QbgPushResult {
    num: number;
    unique_id: string | null;
    ok: boolean;
    error?: string;
}

export interface OriginalQuestion {
    content: string;
    answer: string;
    solution: string;
}

export interface DiagramResult {
    num: number;
    /**
     * "needs review" = the redraw ran, but reading the finished image back showed
     * it still disagrees with the question (python/qbg_modification/figcheck.py).
     * The picture is kept — it is usually closer than the original — but the
     * question must be looked at before it is used.
     */
    status: "regenerated" | "failed" | "needs review" | "generated";
    detail: string;
}

/** One question's QC verdict, and what QC changed about it. */
export interface QcResult {
    num: number | string;
    status: "clean" | "changed" | "failed";
    verdict?: string;
    confidence?: number;
    /** False when the question had no figure, or the QC model could not be sent one. */
    saw_figure?: boolean;
    defects?: { category?: string; severity?: string; evidence?: string; fix?: string }[];
    /** Which of stem / options / answer / solution / figure QC rewrote. */
    changed_fields?: string[];
    /** The question as it was before QC, for the fields QC changed. */
    before?: Record<string, unknown>;
    /** And after — this pair is how a run is checked for whether QC did anything. */
    after?: Record<string, unknown>;
    fig_edit?: string;
    solved?: { answer?: string; working?: string };
    detail?: string;
}

export interface QcSummary {
    checked: number;
    changed: number;
    failed: number;
    major: number;
    changed_nums: (number | string)[];
    with_figure: number;
}

/** How far a question's options were allowed to move. A numeric ladder is
 *  reversed rather than shuffled, so it stays a ladder but the key still moves. */
export type KeyBalanceTier = "free" | "mirror" | "fixed";

/** What the answer-key balancer did (python/qbg_modification/answerkey.py). */
export interface KeyBalanceReport {
    /** Questions whose options were permuted, with the letter before and after. */
    moved: { num: number | string; from: string; to: string; tier?: KeyBalanceTier }[];
    /** Questions not freely shuffled, and why (ordered options, self-reference…). */
    skipped: { num: number | string; reason: string; tier?: KeyBalanceTier }[];
    before: { counts: Record<string, number>; longest_run: number };
    after: { counts: Record<string, number>; longest_run: number };
    /** Stretches of consecutive questions that STILL share a correct letter after
     *  balancing — the thing the balancer exists to prevent. Non-empty means the
     *  paper needs a content change, because no reordering could break the run. */
    residual_runs?: {
        letter: string;
        length: number;
        nums: (number | string)[];
        unavoidable: boolean;
        tiers?: KeyBalanceTier[];
    }[];
}

export interface ReframeReport {
    ok: boolean;
    source_name: string;
    question_count: number;
    /** How many original questions were sent in — lets the UI show "16 of 20"
     *  rather than just "16" when a chunk came back short. */
    requested_count?: number;
    questions: ReframedQuestion[];
    modified_records: ReframedRecord[];
    originals?: OriginalQuestion[];
    zip_path: string;
    modified_csv_path: string;
    original_csv_path?: string;
    figdir: string;
    folder: string;
    qbg_results?: QbgPushResult[];
    qbg_results_html_path?: string;
    qbg_error?: string;
    missing_ids?: string[];
    /** Questions of a type this pipeline doesn't reframe (e.g. Subjective/Assertion_Reason/
     *  Comprehension) — excluded from the batch instead of being silently mis-tagged. */
    skipped_unsupported?: { qbg_id: string; reason: string }[];
    /** Seeds rewritten as another type (python cli._apply_target_types). */
    type_conversions?: { qbg_id: string; num: number; from: string; to: string }[];
    diagram_results?: DiagramResult[];
    /** Newly-generated solution diagrams (opt-in — see genSolutionDiagrams). */
    solution_diagram_results?: DiagramResult[];
    /** Brand-new stem diagrams drawn for questions that had none (opt-in — see addFigures). */
    new_figure_results?: DiagramResult[];
    /** Per-question QC verdicts + corrections (see python/qbg_modification/qcfix.py). */
    qc_results?: QcResult[];
    qc_summary?: QcSummary;
    /** Diagrams redrawn because QC asked for it. */
    qc_diagram_results?: DiagramResult[];
    key_balance?: KeyBalanceReport;
    /** Per-chunk issues from the batched reframe (e.g. a chunk the model came back
     *  short on, or a figure that had to be restored) — surfaced to the UI so a
     *  smaller-than-expected result is never silent. */
    warnings?: string[];
}

/** One subject's slice of the test syllabus (see src/lib/qbgSyllabus.ts). */
export interface SyllabusScopeEntry {
    subject: string;
    /** The chapters chosen for this test — what a question must be ABOUT. */
    chapters: string[];
    /** Those plus every earlier chapter in the book — usable as prerequisites. */
    permitted: string[];
}

export interface QbgCreds {
    token: string;
    user: string;
    userId: string;
}

export interface ReframeResult {
    sourceName: string;
    questionCount: number;
    requestedCount?: number;
    questions: ReframedQuestion[];
    records: ReframedRecord[];
    originals: OriginalQuestion[];
    zipBuffer: Buffer;
    zipName: string;
    modifiedCsv: string;
    originalCsv: string;
    /** figure filename -> data: URL, for embedding diagrams when injecting to DB. */
    figures: Record<string, string>;
    /** External-QBG push outcome (present only when qbgPush was requested). */
    qbgResults?: QbgPushResult[];
    qbgError?: string;
    qbgResultsHtml?: string;
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    diagramResults?: DiagramResult[];
    solutionDiagramResults?: DiagramResult[];
    newFigureResults?: DiagramResult[];
    qcResults?: QcResult[];
    qcSummary?: QcSummary;
    qcDiagramResults?: DiagramResult[];
    keyBalance?: KeyBalanceReport;
    /** Seeds the reframe was told to rewrite as another type. */
    typeConversions?: { qbgId: string; num: number; from: string; to: string }[];
    warnings?: string[];
}

const PROGRESS_PREFIX = "@@PROGRESS@@";

/** Split incoming stderr into lines; route @@PROGRESS@@ lines to onProgress and keep
 *  the rest as real stderr (so error messages stay clean). Returns the leftover buffer. */
function consumeStderr(
    buf: string,
    onProgress: ((ev: ProgressEvent) => void) | undefined,
    pushStderr: (s: string) => void
): string {
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.startsWith(PROGRESS_PREFIX)) {
            if (onProgress) {
                try {
                    onProgress(JSON.parse(line.slice(PROGRESS_PREFIX.length)) as ProgressEvent);
                } catch {
                    /* ignore malformed progress line */
                }
            }
        } else {
            pushStderr(line + "\n");
        }
    }
    return buf;
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
            errBuf = consumeStderr(errBuf, opts.onProgress, (s) => (stderr += s));
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

export interface ReframeArgs {
    /** Input source: an uploaded .docx, or QBG unique_ids fetched from the API. */
    source: "docx" | "qbg";
    docxBuffer?: Buffer;
    docxName?: string;
    qbgIds?: string;
    provider: QbgModProvider;
    modelId: string;
    apiKey: string;
    /** Endpoint for custom_openai / local providers. */
    baseUrl?: string;
    sendImages: boolean;
    /** When true, also POST the reframed questions to the external QBG API. */
    qbgPush?: boolean;
    category?: string;
    /** QBG REST credentials — required for source "qbg" and/or qbgPush. */
    qbgCreds?: QbgCreds;
    /** When true, let an image model redraw figures whose data the reframe changed. */
    regenDiagrams?: boolean;
    /** With regenDiagrams: redraw EVERY figure so it matches the reframed numbers, not just
     *  the ones the AI flagged as changed. Without this, a question whose numbers changed can
     *  keep an original diagram still showing the ORIGINAL values. */
    redrawAllFigures?: boolean;
    /**
     * With regenDiagrams: read every redrawn figure back with a vision model and
     * check it against the question, redrawing when it disagrees. Defaults to ON —
     * an image editor renders digits unreliably, so this is what stops a diagram
     * that contradicts its own question from shipping. Costs one vision call per
     * redrawn figure (plus retries), which is the only reason to turn it off.
     */
    verifyDiagrams?: boolean;
    /**
     * Quality-check every reframed question with an AI model before pushing, and
     * apply its corrections. The question's figure is sent as an image, so this
     * wants a model that can READ DIAGRAMS — a text-only model cannot see the
     * commonest defect (the picture disagreeing with the words).
     */
    qc?: boolean;
    qcProvider?: string;
    qcModel?: string;
    /** Key for the QC provider when it differs from the reframe provider. */
    qcApiKey?: string;
    /** When true, let the AI request a brand-new diagram for a question that has none but
     *  would be clearer with one (the model decides per-question, see extract.py). */
    addFigures?: boolean;
    /** When true, let the AI request a NEW diagram for a solution that genuinely
     *  needs one (rare — the model decides per-question, see extract.py). */
    genSolutionDiagrams?: boolean;
    imgProvider?: "gemini" | "openai";
    imgModel?: string;
    /** API key for the image model (reused from the vault's gemini/openai key). */
    imgApiKey?: string;
    /** How aggressively to rewrite: "paraphrase" (same numbers, reword only),
     *  "vary_numbers" (new numbers, same physical quantity, same difficulty), or
     *  "full_rewrite" (default — full freedom, slightly harder). */
    mode?: "paraphrase" | "vary_numbers" | "full_rewrite";
    /** Difficulty of the reframed questions, independent of `mode`: "auto" keeps the mode's
     *  own difficulty, "harder" / "much_harder" explicitly raise it. */
    difficulty?: "auto" | "harder" | "much_harder";
    /** Keep every reframed question inside this test's syllabus. */
    syllabus?: SyllabusScopeEntry[];
    /** Write every question so it can be solved by hand — clean numbers, no
     *  calculator-grade arithmetic. */
    noCalculator?: boolean;
    /** Make most questions conceptual: theory, or light arithmetic where the hard
     *  part is recognising which concept applies. */
    conceptual?: boolean;
    /** QBG source only: {qbg_id: reframe type} for seed questions that must be
     *  rewritten as a different type (see TypeConversion in qbgPoolSelection.ts). */
    targetTypes?: Record<string, string>;
    /** Live progress callback (sidecar @@PROGRESS@@ events). */
    onProgress?: (ev: ProgressEvent) => void;
}

/**
 * Run the full reframe pipeline (docx or QBG-unique_id source), optionally
 * pushing the result to the external QBG API. Throws Error on any failure with
 * the sidecar's stderr attached.
 */
export async function reframe(args: ReframeArgs): Promise<ReframeResult> {
    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(JOB_ROOT, "reframe-"));
    const outDir = path.join(workDir, "out");
    let extractWorkDir: string | null = null;
    try {
        await fs.mkdir(outDir, { recursive: true });
        const cli = path.join(PYTHON_DIR, "cli.py");

        let cliArgs: string[];
        if (args.source === "qbg") {
            cliArgs = [cli, "qbg-reframe", outDir, "--qbg-ids", args.qbgIds || "",
                "--provider", args.provider, "--model", args.modelId];
        } else {
            const inputPath = path.join(workDir, "input.docx");
            await fs.writeFile(inputPath, args.docxBuffer!);
            cliArgs = [cli, "reframe", inputPath, outDir,
                "--provider", args.provider, "--model", args.modelId];
        }
        if (!args.sendImages) cliArgs.push("--no-images");
        if (args.qbgPush) {
            cliArgs.push("--qbg-push");
            if (args.category) cliArgs.push("--category", args.category);
        }
        if (args.regenDiagrams) cliArgs.push("--regen-diagrams");
        if (args.regenDiagrams && args.redrawAllFigures) cliArgs.push("--redraw-all-figures");
        if (args.regenDiagrams && args.verifyDiagrams === false) cliArgs.push("--no-fig-check");
        if (args.qc) {
            cliArgs.push("--qc");
            if (args.qcProvider) cliArgs.push("--qc-provider", args.qcProvider);
            if (args.qcModel) cliArgs.push("--qc-model", args.qcModel);
        }
        if (args.genSolutionDiagrams) cliArgs.push("--gen-solution-diagrams");
        if (args.addFigures) cliArgs.push("--add-figures");
        if (args.regenDiagrams || args.genSolutionDiagrams || args.addFigures) {
            cliArgs.push("--img-provider", args.imgProvider || "gemini");
            if (args.imgModel) cliArgs.push("--img-model", args.imgModel);
        }
        if (args.mode) cliArgs.push("--mode", args.mode);
        if (args.syllabus && args.syllabus.length > 0) {
            // Passed as a file, not on argv: a full-syllabus scope is a few hundred
            // chapter names and would blow past the command-line length limit.
            const sylPath = path.join(workDir, "syllabus.json");
            await fs.writeFile(sylPath, JSON.stringify(args.syllabus), "utf8");
            cliArgs.push("--syllabus-json", sylPath);
        }
        if (args.difficulty && args.difficulty !== "auto") cliArgs.push("--difficulty", args.difficulty);
        if (args.noCalculator) cliArgs.push("--no-calculator");
        if (args.conceptual) cliArgs.push("--conceptual");
        if (args.source === "qbg" && args.targetTypes && Object.keys(args.targetTypes).length > 0) {
            // A file for the same reason as the syllabus: one entry per seed can run long.
            const ttPath = path.join(workDir, "target_types.json");
            await fs.writeFile(ttPath, JSON.stringify(args.targetTypes), "utf8");
            cliArgs.push("--target-types-json", ttPath);
        }

        const env: Record<string, string> = { QBG_MOD_API_KEY: args.apiKey, PYTHONIOENCODING: "utf-8" };
        // Never on the command line: an argv is visible to anything that can list
        // processes, and this is a provider credential.
        if (args.qc && args.qcApiKey) env.QBG_MOD_QC_API_KEY = args.qcApiKey;
        if (args.baseUrl) env.QBG_MOD_BASE_URL = args.baseUrl;
        if (args.imgApiKey) env.QBG_MOD_IMG_API_KEY = args.imgApiKey;
        if (args.qbgCreds) {
            env.QBG_TOKEN = args.qbgCreds.token;
            env.QBG_USER = args.qbgCreds.user;
            env.QBG_USER_ID = args.qbgCreds.userId;
        }

        const { stdout, stderr, code } = await runPython(cliArgs, { cwd: PYTHON_DIR, env, onProgress: args.onProgress });
        if (code !== 0) {
            throw new Error(`reframe exited ${code}. ${stderr.slice(0, 4000).trim()}`);
        }

        const line = stdout.trim().split("\n").pop() || "{}";
        let report: ReframeReport;
        try {
            report = JSON.parse(line) as ReframeReport;
        } catch {
            throw new Error(`could not parse sidecar output: ${line.slice(0, 500)}`);
        }
        extractWorkDir = report.figdir ? path.dirname(report.figdir) : null;

        const zipBuffer = await fs.readFile(report.zip_path);
        const modifiedCsv = await fs.readFile(report.modified_csv_path, "utf8").catch(() => "");
        const originalCsv = report.original_csv_path
            ? await fs.readFile(report.original_csv_path, "utf8").catch(() => "")
            : "";
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
            originals: report.originals || [],
            zipBuffer,
            zipName: `${report.source_name}.zip`,
            modifiedCsv,
            originalCsv,
            figures,
            qbgResults: report.qbg_results,
            qbgError: report.qbg_error,
            qbgResultsHtml: qbgResultsHtml || undefined,
            missingIds: report.missing_ids,
            skippedUnsupported: report.skipped_unsupported?.map((s) => ({ qbgId: s.qbg_id, reason: s.reason })),
            diagramResults: report.diagram_results,
            qcResults: report.qc_results,
            qcSummary: report.qc_summary,
            qcDiagramResults: report.qc_diagram_results,
            keyBalance: report.key_balance,
            typeConversions: report.type_conversions?.map((c) => ({ qbgId: c.qbg_id, num: c.num, from: c.from, to: c.to })),
            solutionDiagramResults: report.solution_diagram_results,
            newFigureResults: report.new_figure_results,
            warnings: report.warnings,
        };
    } finally {
        await rmDirQuiet(workDir);
        if (extractWorkDir) await rmDirQuiet(extractWorkDir);
    }
}

/**
 * Embed diagram images into a reframed record's HTML: the sidecar emits
 * `<img ... src="" title="qN_figure.png" />`; replace the empty src with the
 * figure's data: URL so the question renders standalone in the DB / UI.
 */
export function embedFigures(html: string, figures: Record<string, string>): string {
    if (!html) return html;
    return html.replace(
        /<img\b([^>]*?)\btitle="([^"]+)"([^>]*?)\bsrc=""([^>]*?)>/gi,
        (match, pre, title, mid, post) => {
            const url = figures[title];
            return url ? `<img${pre}title="${title}"${mid}src="${url}"${post}>` : match;
        }
    );
}
