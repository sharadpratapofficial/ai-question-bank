/**
 * Push already-built questions to the external QBG API — no AI, no extraction.
 *
 * The "push to QBG" tick used to be a decision you could only make BEFORE a run:
 * forgetting it meant re-running the whole (slow, paid) AI extraction just to get
 * the questions into QBG. This runs `cli.py push` against work that already
 * exists, from either:
 *
 *   * records  — the questions a finished job returned. Their diagrams are inlined
 *                as base64 data: URLs (the job's figdir is deleted with the job),
 *                and the sidecar uploads those to QBG's S3 before posting.
 *   * csv      — a QBG-format CSV downloaded earlier. The "Modified CSV" keeps its
 *                diagrams inline too; an "Original CSV" has them stripped, which
 *                comes back as a warning rather than silently-imageless questions.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolvePythonBin } from "@/lib/pythonBin";
import type { QbgCreds, QbgPushResult, ProgressEvent } from "./qbgModification";

const PROGRESS_PREFIX = "@@PROGRESS@@";
const PYTHON_DIR = path.resolve(process.cwd(), "python", "qbg_modification");
const JOB_ROOT = path.join(tmpdir(), "qbg-push-jobs");

export type QbgPushQuestionType = "SCQ" | "MCQ" | "Numerical";

/** One question to push: the rendered HTML plus what QBG needs to type it. */
export interface QbgPushQuestion {
    num?: number;
    type?: QbgPushQuestionType;
    /** SCQ -> "A".."D"; MCQ -> ["A","C"]; Numerical -> the value string. */
    answer?: string | string[] | null;
    content: string;
    /** [isCorrect, html] per option; empty for Numerical. */
    options: Array<[boolean | null, string | null]>;
    solution: string;
}

export interface QbgPushOutcome {
    count: number;
    pushed: number;
    results: QbgPushResult[];
    /** <img> tags that reached QBG with no picture data (see the CSV note above). */
    blankImages: number;
    warnings: string[];
}

interface PushReport {
    ok: boolean;
    count?: number;
    pushed?: number;
    qbg_results?: QbgPushResult[];
    blank_images?: number;
    warnings?: string[];
}

function runPython(
    args: string[],
    opts: { env?: Record<string, string>; onProgress?: (ev: ProgressEvent) => void }
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn(resolvePythonBin(), args, {
            cwd: PYTHON_DIR,
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
                            /* ignore a malformed progress line */
                        }
                    }
                } else {
                    stderr += line + "\n";
                }
            }
        });
        child.on("error", (err) =>
            resolve({ stdout, stderr: `${stderr}${errBuf}\nspawn failed: ${err.message}`, code: -1 })
        );
        child.on("exit", (code) => resolve({ stdout, stderr: stderr + errBuf, code: code ?? -1 }));
    });
}

export interface QbgPushArgs {
    /** Push these questions (from a finished job / history). */
    questions?: QbgPushQuestion[];
    /** …or push the rows of this QBG-format CSV. */
    csv?: string;
    /** Type applied to every CSV row — a CSV carries no type column. */
    csvType?: QbgPushQuestionType;
    category: string;
    creds: QbgCreds;
    onProgress?: (ev: ProgressEvent) => void;
}

/** Push to QBG. Throws with the sidecar's stderr attached on failure. */
export async function pushToQbg(args: QbgPushArgs): Promise<QbgPushOutcome> {
    if (!args.category) throw new Error("A QBG category is required.");
    const hasQuestions = Array.isArray(args.questions) && args.questions.length > 0;
    const hasCsv = typeof args.csv === "string" && args.csv.trim().length > 0;
    if (!hasQuestions && !hasCsv) throw new Error("Nothing to push — no questions and no CSV.");

    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(JOB_ROOT, "push-"));
    try {
        const cli = path.join(PYTHON_DIR, "cli.py");
        const cliArgs = [cli, "push", "--category", args.category];

        if (hasQuestions) {
            const file = path.join(workDir, "records.json");
            await fs.writeFile(file, JSON.stringify({ questions: args.questions }), "utf8");
            cliArgs.push("--records-json", file);
        } else {
            const file = path.join(workDir, "questions.csv");
            await fs.writeFile(file, args.csv!, "utf8");
            cliArgs.push("--csv", file, "--csv-type", args.csvType || "SCQ");
        }

        const { stdout, stderr, code } = await runPython(cliArgs, {
            env: {
                QBG_TOKEN: args.creds.token,
                QBG_USER: args.creds.user,
                QBG_USER_ID: args.creds.userId,
                PYTHONIOENCODING: "utf-8",
            },
            onProgress: args.onProgress,
        });
        if (code !== 0) throw new Error(`push exited ${code}. ${stderr.slice(0, 4000).trim()}`);

        const line = stdout.trim().split("\n").pop() || "{}";
        let report: PushReport;
        try {
            report = JSON.parse(line) as PushReport;
        } catch {
            throw new Error(`could not parse sidecar output: ${line.slice(0, 500)}`);
        }
        const results = report.qbg_results || [];
        return {
            count: report.count ?? results.length,
            pushed: report.pushed ?? results.filter((r) => r.ok).length,
            results,
            blankImages: report.blank_images ?? 0,
            warnings: report.warnings || [],
        };
    } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}
