/**
 * Server-side helper for the QBG Tagging feature.
 *
 * Two modes, both shelling out to python/qbg_modification/cli.py `tag`:
 *   * AI mode  — qbg_ids in; the sidecar fetches each question, AI-matches the nearest
 *                subject/chapter/topic/subtopic from the bundled tagging table + a
 *                difficulty (1/2/3), then PUTs the tags to QBG.
 *   * CSV mode — a ready tagging CSV (ids + difficulty already) is PUT directly, no AI.
 *
 * The write itself replicates the n8n "sheet tagging" flow inside qbg.py (GET question →
 * override conceptTags + difficulty → PUT). Reuses the modification lib's async job store.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { resolvePythonBin } from "@/lib/pythonBin";
import {
    QBG_MOD_PROVIDERS,
    type QbgModProvider,
    type QbgCreds,
    type ProgressEvent,
} from "./qbgModification";

const PROGRESS_PREFIX = "@@PROGRESS@@";

// Resolved lazily and cached — see src/lib/pythonBin.ts for why the old
// `process.env.QBG_PYTHON || "python"` was unreliable.
const PYTHON_BIN = (): string => resolvePythonBin();
const PYTHON_DIR = path.resolve(process.cwd(), "python", "qbg_modification");
const JOB_ROOT = path.join(tmpdir(), "qbg-tagging-jobs");

export const QBG_TAG_PROVIDERS = QBG_MOD_PROVIDERS;
export type QbgTagProvider = QbgModProvider;

export interface TagFields {
    class_id: string;
    subject_id: string;
    chapter_id: string;
    topic_id: string;
    subtopic_id: string;
    difficulty: number | string;
}
export interface TagMeta {
    class_name?: string;
    subject_name?: string;
    chapter_name?: string;
    topic_name?: string;
    subtopic_name?: string;
    difficulty_name?: string;
    category?: string;
    /** Other chapters the question relies on — read by the syllabus audit. */
    chapters_used?: string[];
}
export interface TagResultItem {
    qbg_id: string | null;
    ok: boolean;
    detail?: string;
    error?: string;
    tags?: TagFields;
    meta?: TagMeta;
}
interface TagReport {
    ok: boolean;
    mode: "ai" | "csv";
    count: number;
    tagged: number;
    results: TagResultItem[];
}
export interface TagResult {
    mode: "ai" | "csv";
    count: number;
    tagged: number;
    results: TagResultItem[];
}

function runPython(
    args: string[],
    opts: {
        cwd?: string;
        env?: Record<string, string>;
        onProgress?: (ev: ProgressEvent) => void;
        /** Fired synchronously right after spawn, so a caller (e.g. the tagging
         *  queue) can stash the handle somewhere reachable for a later kill(). */
        onChild?: (child: ChildProcess) => void;
    } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn(PYTHON_BIN(), args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        opts.onChild?.(child);
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

export interface TagArgs {
    mode: "ai" | "csv";
    /** AI mode: QBG unique_ids (comma/space/newline separated). */
    qbgIds?: string;
    /** CSV mode: the uploaded tagging CSV text (sample format). */
    tagCsv?: string;
    provider?: QbgTagProvider;
    modelId?: string;
    /** AI mode: match against THIS category's slice of the tagging table instead of
     *  the question's own category. Needed for a QBG category the bundled taxonomy
     *  doesn't cover yet (e.g. RankUp Test Series) — subject/chapter/topic ids are
     *  global across categories, so the tags stay valid. Blank = the question's own. */
    taxonomyCategory?: string;
    /** Subject names the tagger may pick from; empty/undefined = all. Stops a
     *  question being filed under a subject that merely shares a chapter name
     *  (Physics "Mathematical Tools and Vectors" landing in Maths). */
    subjects?: string[];
    apiKey?: string;
    baseUrl?: string;
    /** QBG REST creds — required for both modes (the write is a PUT to QBG). */
    qbgCreds: QbgCreds;
    /** Live progress callback (sidecar @@PROGRESS@@ events). */
    onProgress?: (ev: ProgressEvent) => void;
    /** Fired with the spawned ChildProcess right after spawn — lets a caller
     *  (the tagging queue) cancel a running job by killing this handle. */
    onChild?: (child: ChildProcess) => void;
}

/** Run the tagging pipeline. Throws Error on any failure with the sidecar's stderr. */
export async function runTagging(args: TagArgs): Promise<TagResult> {
    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(JOB_ROOT, "tag-"));
    try {
        const cli = path.join(PYTHON_DIR, "cli.py");
        const cliArgs = [cli, "tag"];
        if (args.mode === "csv") {
            const csvPath = path.join(workDir, "tags.csv");
            await fs.writeFile(csvPath, args.tagCsv || "", "utf8");
            cliArgs.push("--tag-csv", csvPath);
        } else {
            cliArgs.push("--qbg-ids", args.qbgIds || "");
            if (args.provider) cliArgs.push("--provider", args.provider);
            if (args.modelId) cliArgs.push("--model", args.modelId);
            if (args.taxonomyCategory) cliArgs.push("--taxonomy-category", args.taxonomyCategory);
            if (args.subjects && args.subjects.length > 0) {
                cliArgs.push("--subjects", args.subjects.join(","));
            }
        }

        const env: Record<string, string> = { PYTHONIOENCODING: "utf-8" };
        if (args.apiKey) env.QBG_MOD_API_KEY = args.apiKey;
        if (args.baseUrl) env.QBG_MOD_BASE_URL = args.baseUrl;
        env.QBG_TOKEN = args.qbgCreds.token;
        env.QBG_USER = args.qbgCreds.user;
        env.QBG_USER_ID = args.qbgCreds.userId;

        const { stdout, stderr, code } = await runPython(cliArgs, {
            cwd: PYTHON_DIR,
            env,
            onProgress: args.onProgress,
            onChild: args.onChild,
        });
        if (code !== 0) {
            throw new Error(`tag exited ${code}. ${stderr.slice(0, 4000).trim()}`);
        }
        const line = stdout.trim().split("\n").pop() || "{}";
        let report: TagReport;
        try {
            report = JSON.parse(line) as TagReport;
        } catch {
            throw new Error(`could not parse sidecar output: ${line.slice(0, 500)}`);
        }
        return {
            mode: report.mode,
            count: report.count,
            tagged: report.tagged,
            results: report.results || [],
        };
    } finally {
        await rmDirQuiet(workDir);
    }
}
