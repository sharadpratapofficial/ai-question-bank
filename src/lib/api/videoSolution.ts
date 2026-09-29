/**
 * Server-side helpers for the AI Video Solution feature.
 *
 * The actual rendering pipeline lives in `python/video_solution/` and is
 * invoked as a subprocess. This module:
 *   - Resolves the Python interpreter (overridable via QBG_PYTHON)
 *   - Stages uploaded PDFs to a job-scoped temp directory
 *   - Spawns `slides_cli.py` (sync, fast) or `generate_videos.py` (async, slow)
 *   - Captures stderr line-by-line for live progress
 *   - Tracks async jobs in memory keyed by jobId so the polling endpoint can
 *     return state + accumulated log + the eventual ZIP path
 *
 * State is intentionally process-local — Next.js serverless deploys would
 * need a different store, but for the long-running compute path this feature
 * already requires a persistent Node process anyway.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { resolvePythonBin } from "@/lib/pythonBin";
import { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase/env";

const ARTIFACT_BUCKET = "ai-video-artifacts";

/** Token/user/user_id for QBG's own API — same shape the rest of the app's
 *  QBG features read from the caller's saved "qbg" vault key. */
export interface QbgCreds {
    token: string;
    user: string;
    userId: string;
}

interface PersistArgs {
    userId: string;
    supabaseAccessToken: string;
    jobId: string;
    zipPath: string;
    questionPdfName?: string;
    solutionsPdfName?: string;
    qbgIds?: string[];
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    voice: string;
    ttsEngine: string;
    language: string;
    aiProvider: string;
    aiModelId: string;
    videoCount: number;
}

/** Upload the rendered ZIP to Storage and insert an ai_reports row. Returns
 *  the storage path on success; logs and swallows errors otherwise so a
 *  storage hiccup never kills the user's render (they can still download
 *  the in-memory ZIP). */
async function persistArtifact(p: PersistArgs): Promise<string | null> {
    const url = getSupabaseUrl();
    const anon = getSupabasePublishableKey();
    if (!url || !anon) return null;
    const supabase = createSupabaseClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${p.supabaseAccessToken}` } },
    });

    const storagePath = `${p.userId}/${p.jobId}/${path.basename(p.zipPath)}`;
    try {
        const bytes = await fs.readFile(p.zipPath);
        const { error } = await supabase.storage
            .from(ARTIFACT_BUCKET)
            .upload(storagePath, bytes, {
                contentType: "application/zip",
                upsert: true,
            });
        if (error) {
            console.error("[videoSolution] storage upload failed:", error.message);
            return null;
        }
        const reportData = {
            jobId: p.jobId,
            storagePath,
            artifactBytes: bytes.length,
            questionPdfName: p.questionPdfName,
            solutionsPdfName: p.solutionsPdfName,
            qbgIds: p.qbgIds,
            missingIds: p.missingIds,
            skippedUnsupported: p.skippedUnsupported,
            voice: p.voice,
            ttsEngine: p.ttsEngine,
            language: p.language,
            videoCount: p.videoCount,
        };
        const { error: insertError } = await supabase
            .from("ai_reports")
            .insert({
                user_id: p.userId,
                report_type: "video",
                file_name: p.questionPdfName || `qbg_${p.qbgIds?.length ?? 0}_ids`,
                provider: p.aiProvider,
                model_id: p.aiModelId,
                report_data: reportData,
            });
        if (insertError) {
            console.error("[videoSolution] ai_reports insert failed:", insertError.message);
        }
        return storagePath;
    } catch (err) {
        console.error("[videoSolution] persistArtifact unexpected error:", err);
        return null;
    }
}

// Resolved lazily and cached — see src/lib/pythonBin.ts for why the old
// `process.env.QBG_PYTHON || "python"` was unreliable.
const PYTHON_BIN = (): string => resolvePythonBin();
const PYTHON_DIR = path.resolve(process.cwd(), "python", "video_solution");

const JOB_ROOT = path.join(tmpdir(), "qbg-video-jobs");

export type VideoJobState = "queued" | "running" | "done" | "error";

export interface VideoJobInfo {
    jobId: string;
    state: VideoJobState;
    createdAt: string;
    /** PDF-source jobs only. */
    questionPdfName?: string;
    solutionsPdfName?: string;
    /** QBG-id-source jobs only. */
    qbgIds?: string[];
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    log: string;
    error?: string;
    videoCount?: number;
    zipPath?: string;
    /** Set once the ZIP is uploaded to the ai-video-artifacts bucket.
     *  Format: `<userId>/<jobId>/<filename>.zip` */
    storagePath?: string;
}

interface InternalJob extends VideoJobInfo {
    /** Holds the spawned child process so we can detach safely on completion. */
    cleanupOnDone: () => Promise<void>;
}

// Use a process-global map so job state is shared across ALL module instances
// in the same Node.js process. Next.js App Router compiles each route handler
// into its own module bundle — a plain module-level Map is NOT shared between
// the POST route (which creates the job) and the GET status route (which reads
// it). Using globalThis is the standard Next.js pattern for this (see the
// Prisma best-practices guide). The disk-based _state files remain as a backup
// for process restarts / hot-reloads that wipe globalThis.
const _g = globalThis as typeof globalThis & { __qbgVideoJobs?: Map<string, InternalJob> };
if (!_g.__qbgVideoJobs) _g.__qbgVideoJobs = new Map<string, InternalJob>();
const jobs: Map<string, InternalJob> = _g.__qbgVideoJobs;

function newJobId(): string {
    return crypto.randomBytes(8).toString("hex");
}

// ----- On-disk job state -------------------------------------------------
// The in-memory `jobs` map gets wiped on every Next.js hot-reload (dev) and
// every server restart (prod). Without a persistent backup the user sees
// "Job not found" within seconds — even though their Python render is still
// running and writing files. We mirror the public part of the job record to
// `${JOB_ROOT}/_state/${jobId}.json` on every state change and fall back to
// it in getJob() so polling survives reloads.

const JOB_STATE_DIR = path.join(JOB_ROOT, "_state");

async function persistJobState(job: InternalJob, throwOnError = false): Promise<void> {
    try {
        await fs.mkdir(JOB_STATE_DIR, { recursive: true });
        const filePath = path.join(JOB_STATE_DIR, `${job.jobId}.json`);
        const data: VideoJobInfo = {
            jobId: job.jobId,
            state: job.state,
            createdAt: job.createdAt,
            questionPdfName: job.questionPdfName,
            solutionsPdfName: job.solutionsPdfName,
            qbgIds: job.qbgIds,
            missingIds: job.missingIds,
            skippedUnsupported: job.skippedUnsupported,
            log: job.log,
            error: job.error,
            videoCount: job.videoCount,
            zipPath: job.zipPath,
            storagePath: job.storagePath,
        };
        await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    } catch (err) {
        console.error("[videoSolution] persistJobState failed for", job.jobId, err);
        if (throwOnError) throw err;
    }
}

async function loadJobState(jobId: string): Promise<VideoJobInfo | undefined> {
    try {
        const filePath = path.join(JOB_STATE_DIR, `${jobId}.json`);
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw) as VideoJobInfo;
    } catch (err) {
        // ENOENT is expected for unknown job IDs; log anything else.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
            console.error("[videoSolution] loadJobState failed for", jobId, err);
        }
        return undefined;
    }
}

/** Read the latest known state of a job. Hits the global in-memory map first,
 *  falls back to disk if the process was restarted since the job started.
 *  Returns undefined only if the job genuinely doesn't exist. */
export async function getJob(jobId: string): Promise<VideoJobInfo | undefined> {
    const j = jobs.get(jobId);
    if (j) {
        const { cleanupOnDone: _cleanup, ...info } = j;
        void _cleanup;
        return info;
    }
    // Process restart fallback: rehydrate from disk so the next read hits the
    // fast path (and so status polling works after a dev-server hot-reload).
    const persisted = await loadJobState(jobId);
    if (persisted) {
        // Reconstruct a minimal InternalJob with a no-op cleanup so the map
        // entry is valid for future reads. The Python subprocess won't be
        // tracked (it was in the old process), but state + log are restored.
        const restored: InternalJob = {
            ...persisted,
            cleanupOnDone: async () => {},
        };
        jobs.set(jobId, restored);
    }
    return persisted;
}

// =========================================================================
//  SLIDES  —  synchronous (PDF question paper -> PPTX)
// =========================================================================

export interface SlidesResult {
    pptxBuffer: Buffer;
    pptxName: string;
    questionCount: number;
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
}

export type SlidesArgs =
    | { source: "pdf"; questionPdfBuffer: Buffer; questionPdfName: string }
    | { source: "qbg"; qbgIds: string[]; qbgCreds: QbgCreds };

export async function generateSlides(args: SlidesArgs): Promise<SlidesResult> {
    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(JOB_ROOT, "slides-"));
    try {
        let cliArgs: string[];
        let outPath: string;
        let outName: string;
        let env: NodeJS.ProcessEnv | undefined;

        if (args.source === "qbg") {
            outName = `${sanitiseBaseName(args.qbgIds[0] || "questions")}.pptx`;
            outPath = path.join(workDir, outName);
            cliArgs = [
                path.join(PYTHON_DIR, "slides_cli.py"),
                "--qbg-ids",
                args.qbgIds.join("\n"),
                outPath,
            ];
            env = {
                ...process.env,
                QBG_TOKEN: args.qbgCreds.token,
                QBG_USER: args.qbgCreds.user,
                QBG_USER_ID: args.qbgCreds.userId,
            };
        } else {
            // slides_cli.py dispatches on the input file's extension (.pdf vs
            // .docx/.doc), so the staged file must keep the original suffix.
            const ext = path.extname(args.questionPdfName) || ".pdf";
            const inputPath = path.join(workDir, `input${ext}`);
            const baseName = sanitiseBaseName(args.questionPdfName).replace(/\.(pdf|docx?)$/i, "");
            outName = `${baseName}.pptx`;
            outPath = path.join(workDir, outName);
            await fs.writeFile(inputPath, args.questionPdfBuffer);
            cliArgs = [path.join(PYTHON_DIR, "slides_cli.py"), inputPath, outPath];
        }

        const { stdout, stderr, code } = await runPython(cliArgs, { cwd: PYTHON_DIR, env });
        if (code !== 0) {
            throw new Error(
                `slides_cli exited ${code}. stderr:\n${stderr.slice(0, 4000)}`
            );
        }
        let report: {
            ok?: boolean;
            report?: {
                question_count?: number;
                missing_ids?: string[];
                skipped_unsupported?: { qbg_id: string; reason: string }[];
            };
        } = {};
        try {
            const line = stdout.trim().split("\n").pop() || "{}";
            report = JSON.parse(line) as typeof report;
        } catch {
            // ignore parse error; we still return the file
        }
        const pptxBuffer = await fs.readFile(outPath);
        return {
            pptxBuffer,
            pptxName: outName,
            questionCount: report.report?.question_count ?? 0,
            missingIds: report.report?.missing_ids,
            skippedUnsupported: report.report?.skipped_unsupported?.map((s) => ({
                qbgId: s.qbg_id,
                reason: s.reason,
            })),
        };
    } finally {
        // The PPTX bytes are already in memory; safe to clean the work dir.
        await rmDirQuiet(workDir);
    }
}

// =========================================================================
//  VIDEOS  —  asynchronous (PDF + solutions PDF -> ZIP of MP4s)
// =========================================================================

export type TTSEngine = "edge" | "elevenlabs" | "chatterbox";

export interface StartVideoJobArgs {
    source: "pdf" | "qbg";
    /** PDF source only. */
    questionPdfBuffer?: Buffer;
    questionPdfName?: string;
    solutionsPdfBuffer?: Buffer;
    solutionsPdfName?: string;
    /** QBG-id source only — token/user/user_id read from the caller's saved
     *  "qbg" vault key, same as the rest of the app's QBG features. */
    qbgIds?: string[];
    qbgCreds?: QbgCreds;
    /** LLM provider used for narration. Mirrors src/lib/userApiKeys.ts
     *  provider keys ("anthropic" | "gemini" | "openai" | "groq" | "grok" |
     *  "openrouter" | "nvidia" | "fireworks" | "custom_openai" | "local" | "g4f").
     *  Defaults to "anthropic" for backward compat. */
    aiProvider?: string;
    /** Model id for the chosen provider (e.g. "claude-sonnet-4-6",
     *  "gemini-2.0-flash", "gpt-4o"). Empty falls back to a hardcoded
     *  default per provider in the Python sidecar. */
    aiModelId?: string;
    /** API key for the chosen provider. Forwarded as AI_API_KEY env var so
     *  it doesn't show up in process listings. */
    aiApiKey?: string;
    /** Base URL for custom_openai / local / g4f providers. */
    aiBaseUrl?: string;
    /** Legacy: Anthropic key fallback (kept for backward compat with the
     *  earlier single-provider implementation). If `aiProvider` is set, the
     *  new flow takes precedence. */
    anthropicApiKey?: string;
    /** TTS engine.
     *  "edge"        — free Microsoft Edge TTS (default).
     *  "elevenlabs"  — premium multilingual TTS incl. Hindi (needs key + voice id).
     *  "chatterbox"  — external OpenAI-compatible HTTP server the user runs
     *                  themselves (e.g. http://localhost:8004). */
    ttsEngine?: TTSEngine;
    /** Voice name (edge-tts, e.g. hi-IN-SwaraNeural), voice id (ElevenLabs),
     *  or voice name for chatterbox (from server's /v1/audio/voices). */
    voice?: string;
    /** ElevenLabs model id. Defaults to eleven_multilingual_v2 in Python. */
    elevenModel?: string;
    /** ElevenLabs API key, forwarded to subprocess as ELEVEN_API_KEY env. */
    elevenApiKey?: string;
    /** Base URL of the external Chatterbox TTS HTTP server (OpenAI-compatible).
     *  e.g. "http://localhost:8004". Only used when ttsEngine === "chatterbox". */
    chatterboxUrl?: string;
    /** Model id to request from the Chatterbox server (see /v1/models).
     *  Empty → server default. Only used when ttsEngine === "chatterbox". */
    chatterboxModel?: string;
    /** Narration language as a 2-letter ISO-639 code (e.g. "en", "hi",
     *  "fr", "es"). The narrator has special handling for "hi" (Devanagari);
     *  any other non-"en" code is passed through to the LLM as "narrate in
     *  <code>" and forwarded to Chatterbox-multilingual as its `language`
     *  field so the right phonemizer is used. */
    language?: string;
    /** Optional cap so the user can try one or two videos before committing
     *  to a 25-minute render. 0 or undefined means "all questions". */
    maxQuestions?: number;
    /** Supabase auth context — used after the job completes to upload the
     *  ZIP to the ai-video-artifacts bucket and persist an ai_reports row.
     *  Both are required for persistence; if omitted, the artifact stays
     *  in the Node temp dir and is downloadable only until restart. */
    userId?: string;
    supabaseAccessToken?: string;
}

export async function startVideoJob(args: StartVideoJobArgs): Promise<{ jobId: string }> {
    const jobId = newJobId();
    const createdAt = new Date().toISOString();
    await fs.mkdir(JOB_ROOT, { recursive: true });
    const workDir = path.join(JOB_ROOT, `videos-${jobId}`);
    await fs.mkdir(workDir, { recursive: true });
    const outDir = path.join(workDir, "videos");
    await fs.mkdir(outDir, { recursive: true });

    let prefix: string;
    let cliArgs: string[];
    let cleanupOnDone: () => Promise<void>;

    if (args.source === "qbg") {
        if (!args.qbgIds?.length || !args.qbgCreds) {
            throw new Error('qbgIds and qbgCreds are required when source is "qbg".');
        }
        prefix =
            "qbg_" + sanitiseBaseName(args.qbgIds[0]) +
            (args.qbgIds.length > 1 ? `_plus${args.qbgIds.length - 1}` : "");
        cliArgs = [
            path.join(PYTHON_DIR, "generate_videos.py"),
            "--qbg-ids",
            args.qbgIds.join("\n"),
            outDir,
            "--prefix",
            prefix,
        ];
        cleanupOnDone = async () => {}; // nothing staged on disk to clean up
    } else {
        if (!args.questionPdfBuffer || !args.questionPdfName || !args.solutionsPdfBuffer || !args.solutionsPdfName) {
            throw new Error(
                "questionPdfBuffer/questionPdfName/solutionsPdfBuffer/solutionsPdfName are required when source is \"pdf\"."
            );
        }
        const qPath = path.join(workDir, "question.pdf");
        const sPath = path.join(workDir, "solutions.pdf");
        await fs.writeFile(qPath, args.questionPdfBuffer);
        await fs.writeFile(sPath, args.solutionsPdfBuffer);
        prefix = sanitiseBaseName(args.questionPdfName).replace(/\.pdf$/i, "") || "Test";
        cliArgs = [
            path.join(PYTHON_DIR, "generate_videos.py"),
            qPath,
            sPath,
            outDir,
            "--prefix",
            prefix,
        ];
        cleanupOnDone = async () => {
            // Leave the videos+zip in place until they're downloaded; only
            // delete the source PDFs immediately for privacy/disk.
            await rmFileQuiet(qPath);
            await rmFileQuiet(sPath);
        };
    }

    const ttsEngine: TTSEngine = args.ttsEngine || "edge";
    const defaultVoice = ttsEngine === "edge" ? "en-IN-PrabhatNeural" : "";
    const voice = (args.voice || defaultVoice).trim();
    if (ttsEngine === "elevenlabs" && !voice) {
        throw new Error("ElevenLabs requires a voice id.");
    }
    if (ttsEngine === "elevenlabs" && !args.elevenApiKey) {
        throw new Error(
            "ElevenLabs requires an API key. Save one in Manage API Keys → ElevenLabs (TTS)."
        );
    }
    cliArgs.push("--tts-engine", ttsEngine, "--voice", voice || "en-IN-PrabhatNeural");
    if (ttsEngine === "elevenlabs" && args.elevenModel) {
        cliArgs.push("--eleven-model", args.elevenModel);
    }
    if (ttsEngine === "chatterbox") {
        cliArgs.push("--chatterbox-url", args.chatterboxUrl || "http://localhost:8004");
        if (args.chatterboxModel) {
            cliArgs.push("--chatterbox-model", args.chatterboxModel);
        }
    }
    if (args.language) {
        cliArgs.push("--language", args.language);
    }
    if (args.aiProvider) {
        cliArgs.push("--ai-provider", args.aiProvider);
    }
    if (args.aiModelId) {
        cliArgs.push("--ai-model", args.aiModelId);
    }
    if (args.aiBaseUrl) {
        cliArgs.push("--ai-base-url", args.aiBaseUrl);
    }
    if (args.maxQuestions && args.maxQuestions > 0) {
        cliArgs.push("--max-questions", String(args.maxQuestions));
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    // The Python narrator reads AI_API_KEY (preferred) or ANTHROPIC_API_KEY
    // (legacy). We populate both for backwards compatibility.
    if (args.aiApiKey) env.AI_API_KEY = args.aiApiKey;
    if (args.anthropicApiKey) env.ANTHROPIC_API_KEY = args.anthropicApiKey;
    if (args.elevenApiKey) env.ELEVEN_API_KEY = args.elevenApiKey;
    if (args.source === "qbg" && args.qbgCreds) {
        env.QBG_TOKEN = args.qbgCreds.token;
        env.QBG_USER = args.qbgCreds.user;
        env.QBG_USER_ID = args.qbgCreds.userId;
    }

    const child = spawn(PYTHON_BIN(), cliArgs, {
        cwd: PYTHON_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const job: InternalJob = {
        jobId,
        state: "running",
        createdAt,
        questionPdfName: args.questionPdfName,
        solutionsPdfName: args.solutionsPdfName,
        qbgIds: args.source === "qbg" ? args.qbgIds : undefined,
        log: "",
        cleanupOnDone,
    };
    jobs.set(jobId, job);
    // Await the FIRST state write so the on-disk record exists before this
    // function returns the jobId. The status endpoint may run in a different
    // module instance (Next.js bundles route handlers separately) whose only
    // source of truth is this file — if it isn't there yet, the client's first
    // polls 404 and, after 20 retries, give up with "Job not found" even though
    // the render is running fine. throwOnError=true so a disk failure surfaces
    // as a POST 500 rather than returning a jobId that will never resolve.
    await persistJobState(job, true);

    let stdoutBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
    });

    child.stderr?.setEncoding("utf8");
    let stderrBuf = "";
    // Throttle disk writes: log updates are frequent (many lines/sec); only
    // flush to disk every ~1 s. State transitions write immediately.
    let lastLogWrite = 0;
    child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk;
        // Limit log size to ~50KB in memory.
        if (stderrBuf.length > 50 * 1024) {
            stderrBuf = stderrBuf.slice(-50 * 1024);
        }
        const j = jobs.get(jobId);
        if (j) {
            j.log = stderrBuf;
            const now = Date.now();
            if (now - lastLogWrite > 1000) {
                lastLogWrite = now;
                void persistJobState(j);
            }
        }
    });

    child.on("error", (err) => {
        const j = jobs.get(jobId);
        if (j) {
            j.state = "error";
            j.error = `spawn failed: ${err.message}`;
            void persistJobState(j);
        }
    });

    child.on("exit", async (code) => {
        const j = jobs.get(jobId);
        if (!j) return;
        try {
            await j.cleanupOnDone();
        } catch {
            // ignore
        }
        if (code !== 0) {
            j.state = "error";
            j.error = j.error || `python exited with code ${code}`;
            await persistJobState(j);
            return;
        }
        // Successful run — parse the JSON summary from stdout, zip the MP4s
        // (plus, for a QBG-sourced job, the generated question/solutions
        // docs alongside them so the run can be spot-checked).
        let videoPaths: string[] = [];
        let extraPaths: string[] = [];
        try {
            const summary = JSON.parse(stdoutBuf || "{}") as {
                videos?: string[];
                missing_ids?: string[];
                skipped_unsupported?: { qbg_id: string; reason: string }[];
                question_doc?: string;
                solutions_doc?: string;
            };
            videoPaths = Array.isArray(summary.videos) ? summary.videos : [];
            j.missingIds = summary.missing_ids;
            j.skippedUnsupported = summary.skipped_unsupported?.map((s) => ({
                qbgId: s.qbg_id,
                reason: s.reason,
            }));
            extraPaths = [summary.question_doc, summary.solutions_doc].filter(
                (p): p is string => !!p
            );
        } catch (err) {
            j.state = "error";
            j.error = `failed to parse python stdout: ${err instanceof Error ? err.message : String(err)}`;
            await persistJobState(j);
            return;
        }
        if (videoPaths.length === 0) {
            j.state = "error";
            j.error = "Python produced no videos (see log).";
            await persistJobState(j);
            return;
        }
        try {
            const zipPath = path.join(workDir, `${prefix}_videos.zip`);
            await zipFiles([...videoPaths, ...extraPaths], zipPath, prefix);
            j.zipPath = zipPath;
            j.videoCount = videoPaths.length;
            j.state = "done";
        } catch (err) {
            j.state = "error";
            j.error = `zip failed: ${err instanceof Error ? err.message : String(err)}`;
            await persistJobState(j);
            return;
        }
        // Persist to Supabase Storage + ai_reports so the user can find this
        // run later under AI Reports. If either step fails, the in-memory job
        // is still downloadable until restart (graceful degradation).
        if (args.userId && args.supabaseAccessToken && j.zipPath) {
            const storagePath = await persistArtifact({
                userId: args.userId,
                supabaseAccessToken: args.supabaseAccessToken,
                jobId,
                zipPath: j.zipPath,
                questionPdfName: args.questionPdfName,
                solutionsPdfName: args.solutionsPdfName,
                qbgIds: j.qbgIds,
                missingIds: j.missingIds,
                skippedUnsupported: j.skippedUnsupported,
                voice,
                ttsEngine,
                language: args.language || "en",
                aiProvider: args.aiProvider || "anthropic",
                aiModelId: args.aiModelId || "",
                videoCount: j.videoCount ?? videoPaths.length,
            });
            if (storagePath) j.storagePath = storagePath;
        }
        await persistJobState(j);
    });

    return { jobId };
}

// =========================================================================
//  Helpers
// =========================================================================

function runPython(
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn(PYTHON_BIN(), args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (b) => (stdout += b.toString()));
        child.stderr?.on("data", (b) => (stderr += b.toString()));
        child.on("error", (err) => {
            resolve({ stdout, stderr: stderr + `\nspawn failed: ${err.message}`, code: -1 });
        });
        child.on("exit", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    });
}

async function zipFiles(filePaths: string[], outPath: string, _prefix: string) {
    // Use Node's built-in zlib via the `jszip` dep already added to the project.
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

function sanitiseBaseName(name: string): string {
    return name
        .split(/[/\\]/)
        .pop()!
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 100);
}

async function rmFileQuiet(p: string): Promise<void> {
    try {
        await fs.unlink(p);
    } catch {
        // ignore
    }
}

async function rmDirQuiet(p: string): Promise<void> {
    try {
        await fs.rm(p, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

export async function readJobZip(jobId: string): Promise<{ buffer: Buffer; name: string } | null> {
    // Try in-memory job first, fall back to disk-persisted state (survives
    // Next.js hot-reload and process restart).
    let zipPath: string | undefined;
    const j = jobs.get(jobId);
    if (j && j.state === "done" && j.zipPath) {
        zipPath = j.zipPath;
    } else {
        const persisted = await loadJobState(jobId);
        if (persisted && persisted.state === "done" && persisted.zipPath) {
            zipPath = persisted.zipPath;
        }
    }
    if (!zipPath) return null;
    try {
        const buffer = await fs.readFile(zipPath);
        return { buffer, name: path.basename(zipPath) };
    } catch {
        return null;
    }
}
