/**
 * Server-side helpers for the Question Wise Videos feature.
 *
 * python/question_wise_videos/ does the actual work (Drive download,
 * classical-CV boundary detection, clip cropping) as two subprocess phases
 * invoked via cli.py ("detect" then "crop"). Unlike videoSolution.ts's
 * in-memory job map, this feature's job state lives entirely in the
 * question_video_jobs table: the detect -> review -> crop workflow must
 * survive the user closing the tab and coming back later (possibly after a
 * long review session), so an in-memory map wiped by hot-reload/restart
 * isn't sufficient on its own — the DB row is the single source of truth.
 *
 * The downloaded video + intermediate frames/thumbs/clips are kept in a
 * job-scoped temp dir (deterministic path, keyed by jobId) between the
 * detect and crop phases, since cropping re-uses the same source video file
 * detection downloaded.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolvePythonBin } from "@/lib/pythonBin";
import { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase/env";

const ARTIFACT_BUCKET = "question-video-artifacts";
const JOBS_TABLE = "question_video_jobs";

// Resolved lazily and cached — see src/lib/pythonBin.ts for why the old
// `process.env.QBG_PYTHON || "python"` was unreliable.
const PYTHON_BIN = (): string => resolvePythonBin();
const PYTHON_DIR = path.resolve(process.cwd(), "python", "question_wise_videos");
const JOB_ROOT = path.join(tmpdir(), "qbg-question-wise-video-jobs");

export type QuestionVideoJobStatus =
    | "queued"
    | "downloading"
    | "detecting"
    | "ready_for_review"
    | "cropping"
    | "done"
    | "failed"
    | "discarded";

export interface QuestionBoundary {
    index: number;
    startSec: number;
    endSec: number;
    /** Storage path of the review thumbnail, once uploaded. */
    thumbPath?: string;
}

/** A Drive link/id, or an existing local file path (only ever used for
 *  developer testing against a video already on disk — the UI always
 *  submits a Drive link). */
export function looksLikeDriveUrl(value: string): boolean {
    const v = value.trim();
    return /drive\.google\.com/i.test(v) || /^[a-zA-Z0-9_-]{20,}$/.test(v);
}

function supabaseForToken(token?: string): SupabaseClient | null {
    const url = getSupabaseUrl();
    const anon = getSupabasePublishableKey();
    if (!url || !anon) return null;
    return createSupabaseClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
}

export function workDirFor(jobId: string): string {
    return path.join(JOB_ROOT, jobId);
}

// =========================================================================
//  DISK HOUSEKEEPING
// =========================================================================
// A job downloads the whole source video (routinely 1.5-2 GB) and writes one
// corner-crop JPG per second of runtime. None of that was ever deleted, so
// every run leaked its working set into temp until the disk filled and a run
// died mid-OCR with a raw `OSError: [Errno 28] No space left on device`
// traceback (2026-08-30 bug report: a 1.6 GB / 6741-frame job).
//
// Three rules now keep it bounded:
//   * the crops go as soon as detection has read them (the crop phase needs
//     only source.mp4),
//   * a job's whole directory goes when it reaches a terminal state — every
//     artifact worth keeping is in Supabase Storage by then,
//   * anything older than a day is swept before a new job starts, which also
//     clears leftovers from runs that died before this existed.

/** Keep a day's worth: enough to retry/inspect a recent job, not enough to fill a disk. */
const JOB_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Refuse to start a download with less than this free — a partial download that
 *  fills the disk takes the rest of the machine down with it. */
const MIN_FREE_BYTES_TO_START = 8 * 1024 * 1024 * 1024;

export async function freeBytesForJobs(): Promise<number | null> {
    try {
        await fs.mkdir(JOB_ROOT, { recursive: true });
        const s = await fs.statfs(JOB_ROOT);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;   // unsupported platform — skip the check rather than block work
    }
}

function gb(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
}

/** Delete one job's working directory. Never throws — housekeeping must not
 *  fail a job that otherwise succeeded. */
export async function cleanupJobDir(jobId: string): Promise<void> {
    try {
        await fs.rm(workDirFor(jobId), { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

/** Drop the per-second corner crops once detection has finished with them. */
async function cleanupDetectionScratch(jobId: string): Promise<void> {
    try {
        await fs.rm(path.join(workDirFor(jobId), "number_crops"), { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

/** Remove job directories older than `maxAgeMs`. Returns how many went. */
export async function pruneOldJobDirs(maxAgeMs = JOB_DIR_MAX_AGE_MS): Promise<number> {
    let removed = 0;
    try {
        const entries = await fs.readdir(JOB_ROOT, { withFileTypes: true });
        const cutoff = Date.now() - maxAgeMs;
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const dir = path.join(JOB_ROOT, e.name);
            try {
                const st = await fs.stat(dir);
                if (st.mtimeMs < cutoff) {
                    await fs.rm(dir, { recursive: true, force: true });
                    removed++;
                }
            } catch {
                /* skip an entry we can't stat/remove */
            }
        }
    } catch {
        /* no job root yet */
    }
    return removed;
}

/** True when `text` is the filesystem telling us it ran out of room. */
export function looksLikeDiskFull(text: string): boolean {
    return /ENOSPC|No space left on device|Errno 28|not enough space/i.test(text || "");
}

/** Replace a disk-full traceback with something a user can act on. */
function explainFailure(raw: string): string {
    if (!looksLikeDiskFull(raw)) return raw;
    return (
        "The server ran out of disk space while processing this video. The working " +
        "files have been cleaned up — free some space on the machine and try again. " +
        "(A 3-hour video needs roughly 2-3 GB of temporary space.)\n\n" +
        raw.slice(-1500)
    );
}

// =========================================================================
//  DETECTION  —  Drive link -> boundary list + review thumbnails
// =========================================================================

export interface StartDetectionArgs {
    driveUrl: string;
    wantClips: boolean;
    /** "fast" (default, batched OCR) or "high" (per-frame OCR — slower but
     *  better on dense 2-digit question numbers). */
    accuracy?: "fast" | "high";
    userId?: string;
    supabaseAccessToken?: string;
}

export async function startDetectionJob(args: StartDetectionArgs): Promise<{ jobId: string }> {
    const supabase = supabaseForToken(args.supabaseAccessToken);
    if (!supabase) throw new Error("Supabase is not configured.");

    // Sweep yesterday's jobs first — that alone often recovers the space this
    // one needs — then refuse to start if the disk still can't take a video.
    // Failing here is far kinder than dying halfway through a 3-hour OCR pass.
    await pruneOldJobDirs();
    const free = await freeBytesForJobs();
    if (free !== null && free < MIN_FREE_BYTES_TO_START) {
        throw new Error(
            `Not enough disk space to process a video: ${gb(free)} GB free, ` +
                `${gb(MIN_FREE_BYTES_TO_START)} GB needed. Free some space and try again.`
        );
    }

    const { data: row, error } = await supabase
        .from(JOBS_TABLE)
        .insert({
            user_id: args.userId || null,
            source_url: args.driveUrl,
            want_clips: args.wantClips,
            status: "downloading",
        })
        .select("id")
        .single();
    if (error || !row) {
        throw new Error(`Failed to create job row: ${error?.message || "unknown error"}`);
    }
    const jobId = row.id as string;

    const workDir = workDirFor(jobId);
    await fs.mkdir(workDir, { recursive: true });

    const cliArgs = [path.join(PYTHON_DIR, "cli.py"), "detect", args.driveUrl, workDir];
    if (args.accuracy === "high") cliArgs.push("--accuracy", "high");
    const child = spawn(PYTHON_BIN(), cliArgs, { cwd: PYTHON_DIR, stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
    });

    let stderrBuf = "";
    let lastWrite = 0;
    let sawDetecting = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 50 * 1024) stderrBuf = stderrBuf.slice(-50 * 1024);
        const patch: Record<string, unknown> = { log: stderrBuf };
        if (!sawDetecting && /video duration/i.test(chunk)) {
            sawDetecting = true;
            patch.status = "detecting";
        }
        const now = Date.now();
        if (now - lastWrite > 1000) {
            lastWrite = now;
            void supabase.from(JOBS_TABLE).update(patch).eq("id", jobId);
        }
    });

    child.on("error", (err) => {
        void supabase
            .from(JOBS_TABLE)
            .update({ status: "failed", error: `spawn failed: ${err.message}` })
            .eq("id", jobId);
    });

    child.on("exit", async (code) => {
        if (code !== 0) {
            // A failed detection has nothing worth keeping — and when the cause
            // WAS a full disk, holding on to the partial download is the last
            // thing that helps.
            await cleanupJobDir(jobId);
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "failed",
                    error: explainFailure(stderrBuf.slice(-4000) || `python exited with code ${code}`),
                    log: stderrBuf,
                })
                .eq("id", jobId);
            return;
        }

        // Detection is done with the per-second crops; only source.mp4 is needed
        // from here (the crop phase re-cuts from it).
        await cleanupDetectionScratch(jobId);

        let result: {
            videoDurationSec?: number;
            questions?: { index: number; startSec: number; endSec: number; thumb: string }[];
        } = {};
        try {
            result = JSON.parse(stdoutBuf) as typeof result;
        } catch (err) {
            await cleanupJobDir(jobId);
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "failed",
                    error: `failed to parse python stdout: ${err instanceof Error ? err.message : String(err)}`,
                    log: stderrBuf,
                })
                .eq("id", jobId);
            return;
        }

        const questions: QuestionBoundary[] = [];
        for (const q of result.questions || []) {
            let thumbPath: string | undefined;
            try {
                const bytes = await fs.readFile(q.thumb);
                const candidatePath = `${args.userId || "anon"}/${jobId}/thumbs/q${String(q.index).padStart(3, "0")}.jpg`;
                const { error: upErr } = await supabase.storage
                    .from(ARTIFACT_BUCKET)
                    .upload(candidatePath, bytes, { contentType: "image/jpeg", upsert: true });
                if (!upErr) thumbPath = candidatePath;
            } catch {
                // No thumbnail is not fatal — the review UI just shows a blank swatch.
            }
            questions.push({ index: q.index, startSec: q.startSec, endSec: q.endSec, thumbPath });
        }

        await supabase
            .from(JOBS_TABLE)
            .update({
                status: "ready_for_review",
                video_duration_sec: result.videoDurationSec ?? null,
                questions,
                log: stderrBuf,
                error: null,
            })
            .eq("id", jobId);
    });

    return { jobId };
}

// =========================================================================
//  CROP  —  (possibly user-edited) boundary list -> clips ZIP + timestamps.csv
// =========================================================================

export interface StartCropArgs {
    jobId: string;
    questions: QuestionBoundary[];
    userId?: string;
    supabaseAccessToken?: string;
}

export async function startCropJob(args: StartCropArgs): Promise<void> {
    const supabase = supabaseForToken(args.supabaseAccessToken);
    if (!supabase) throw new Error("Supabase is not configured.");

    const { data: row, error } = await supabase
        .from(JOBS_TABLE)
        .select("id, want_clips")
        .eq("id", args.jobId)
        .maybeSingle();
    if (error || !row) throw new Error("Job not found.");

    const workDir = workDirFor(args.jobId);
    const videoPath = path.join(workDir, "source.mp4");
    try {
        await fs.access(videoPath);
    } catch {
        await supabase
            .from(JOBS_TABLE)
            .update({
                status: "failed",
                error:
                    "The downloaded source video is no longer available on the server (temp files were cleared, e.g. by a restart). Please resubmit the Drive link.",
            })
            .eq("id", args.jobId);
        return;
    }

    const csv = buildTimestampsCsv(args.questions);
    const csvPath = path.join(workDir, "timestamps.csv");
    await fs.writeFile(csvPath, csv, "utf8");

    if (!row.want_clips) {
        const storagePath = `${args.userId || "anon"}/${args.jobId}/timestamps.csv`;
        const bytes = await fs.readFile(csvPath);
        await supabase.storage
            .from(ARTIFACT_BUCKET)
            .upload(storagePath, bytes, { contentType: "text/csv", upsert: true });
        await supabase
            .from(JOBS_TABLE)
            .update({
                status: "done",
                questions: args.questions,
                crop_result: { storagePath, clipCount: 0 },
                error: null,
            })
            .eq("id", args.jobId);
        // Timestamps-only: nothing further will be cut from the source video.
        await cleanupJobDir(args.jobId);
        return;
    }

    await supabase
        .from(JOBS_TABLE)
        .update({ status: "cropping", questions: args.questions, error: null })
        .eq("id", args.jobId);

    const cropOutDir = path.join(workDir, "clips");
    await fs.mkdir(cropOutDir, { recursive: true });
    const questionsJsonPath = path.join(workDir, "crop_questions.json");
    await fs.writeFile(questionsJsonPath, JSON.stringify(args.questions), "utf8");

    const cliArgs = [path.join(PYTHON_DIR, "cli.py"), "crop", videoPath, questionsJsonPath, cropOutDir];
    const child = spawn(PYTHON_BIN(), cliArgs, { cwd: PYTHON_DIR, stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
    });

    let stderrBuf = "";
    let lastWrite = 0;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 50 * 1024) stderrBuf = stderrBuf.slice(-50 * 1024);
        const now = Date.now();
        if (now - lastWrite > 1000) {
            lastWrite = now;
            void supabase.from(JOBS_TABLE).update({ log: stderrBuf }).eq("id", args.jobId);
        }
    });

    child.on("error", (err) => {
        void supabase
            .from(JOBS_TABLE)
            .update({ status: "failed", error: `spawn failed: ${err.message}` })
            .eq("id", args.jobId);
    });

    child.on("exit", async (code) => {
        if (code !== 0) {
            await cleanupJobDir(args.jobId);
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "failed",
                    error: explainFailure(stderrBuf.slice(-4000) || `python exited with code ${code}`),
                    log: stderrBuf,
                })
                .eq("id", args.jobId);
            return;
        }
        let clips: string[] = [];
        try {
            const parsed = JSON.parse(stdoutBuf) as { clips?: string[] };
            clips = parsed.clips || [];
        } catch (err) {
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "failed",
                    error: `failed to parse python stdout: ${err instanceof Error ? err.message : String(err)}`,
                    log: stderrBuf,
                })
                .eq("id", args.jobId);
            return;
        }
        try {
            const zipPath = path.join(workDir, "clips.zip");
            await zipFiles([...clips, csvPath], zipPath);
            const storagePath = `${args.userId || "anon"}/${args.jobId}/clips.zip`;
            const bytes = await fs.readFile(zipPath);
            const { error: upErr } = await supabase.storage
                .from(ARTIFACT_BUCKET)
                .upload(storagePath, bytes, { contentType: "application/zip", upsert: true });
            if (upErr) throw new Error(upErr.message);
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "done",
                    crop_result: { storagePath, clipCount: clips.length },
                    log: stderrBuf,
                    error: null,
                })
                .eq("id", args.jobId);
            // The clips ZIP is in Storage now — the source video, the clips and
            // the zip are all recoverable from there, so the local copies go.
            await cleanupJobDir(args.jobId);
        } catch (err) {
            await supabase
                .from(JOBS_TABLE)
                .update({
                    status: "failed",
                    error: `zip/upload failed: ${err instanceof Error ? err.message : String(err)}`,
                    log: stderrBuf,
                })
                .eq("id", args.jobId);
        }
    });
}

// =========================================================================
//  Helpers
// =========================================================================

function fmtTs(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function buildTimestampsCsv(questions: QuestionBoundary[]): string {
    // Each question's `end` is the detected end, which already stops when the
    // teacher finishes and trims the silent transition gap before the next
    // question's slide appears — so the next frame isn't included at the
    // boundary (a downstream cutter uses these times). Guard against any end
    // spilling into the next question's start.
    const sorted = [...questions].sort((a, b) => a.startSec - b.startSec);
    const lines = ["index,start,end,start_seconds,end_seconds"];
    for (let i = 0; i < sorted.length; i++) {
        const q = sorted[i];
        const start = Math.round(q.startSec);
        let end = Math.round(q.endSec);
        if (i + 1 < sorted.length) {
            end = Math.min(end, Math.round(sorted[i + 1].startSec) - 1);
        }
        end = Math.max(start, end);
        lines.push(`${q.index},${fmtTs(start)},${fmtTs(end)},${start},${end}`);
    }
    return lines.join("\n") + "\n";
}

async function zipFiles(filePaths: string[], outPath: string): Promise<void> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const p of filePaths) {
        const name = path.basename(p);
        const data = await fs.readFile(p);
        zip.file(name, data);
    }
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.writeFile(outPath, buf);
}
