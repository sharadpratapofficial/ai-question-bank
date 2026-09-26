"use client";

/**
 * Self-contained content for /question-wise-videos: submit one or more
 * Google Drive lecture-recording links, watch each move through
 * detect -> review -> crop, edit the detected boundaries before committing,
 * then download the result. Job state lives in the question_video_jobs
 * table (not just component state), so a job started in an earlier session
 * can be resumed from the History list below even after a tab close.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Clock,
    Download,
    ExternalLink,
    History,
    Loader2,
    Plus,
    Scissors,
    Trash2,
    UploadCloud,
    Video as VideoIcon,
    X,
} from "lucide-react";
import { parseGoogleDriveProviderConfig } from "@/lib/userApiKeys";

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    padding: 20,
    background: "var(--bg-secondary)",
    display: "grid",
    gap: 14,
};
const label: React.CSSProperties = { fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" };
const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.85rem",
    padding: "8px 10px",
    outline: "none",
};

type JobStatus =
    | "queued"
    | "downloading"
    | "detecting"
    | "ready_for_review"
    | "cropping"
    | "done"
    | "failed"
    | "discarded";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["done", "failed", "discarded"]);

const STATUS_LABELS: Record<JobStatus, string> = {
    queued: "Queued",
    downloading: "Downloading from Drive",
    detecting: "Detecting question boundaries",
    ready_for_review: "Ready for review",
    cropping: "Cropping clips",
    done: "Done",
    failed: "Failed",
    discarded: "Discarded",
};

interface QuestionRow {
    index: number;
    startSec: number;
    endSec: number;
    thumbPath?: string;
    thumbUrl?: string | null;
}

interface JobStatusResponse {
    jobId: string;
    sourceUrl: string;
    wantClips: boolean;
    status: JobStatus;
    log: string;
    error?: string | null;
    videoDurationSec?: number | null;
    questions: QuestionRow[];
    cropResult?: { storagePath?: string; clipCount?: number } | null;
    createdAt: string;
    updatedAt: string;
}

interface HistoryEntry {
    jobId: string;
    sourceUrl: string;
    videoLabel?: string | null;
    wantClips: boolean;
    status: JobStatus;
    error?: string | null;
    videoDurationSec?: number | null;
    questionCount: number;
    cropResult?: { storagePath?: string; clipCount?: number } | null;
    createdAt: string;
    updatedAt: string;
}

function fmtMMSS(totalSeconds: number): string {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function parseMMSS(text: string): number | null {
    const parts = text.trim().split(":");
    if (parts.length === 0 || parts.length > 3) return null;
    const nums = parts.map((p) => Number(p.trim()));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    let sec = 0;
    if (nums.length === 3) sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
    else if (nums.length === 2) sec = nums[0] * 60 + nums[1];
    else sec = nums[0];
    return sec;
}

function EditableTime({ seconds, onCommit }: { seconds: number; onCommit: (sec: number) => void }) {
    const [text, setText] = useState(fmtMMSS(seconds));
    useEffect(() => setText(fmtMMSS(seconds)), [seconds]);
    return (
        <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
                const parsed = parseMMSS(text);
                if (parsed == null) {
                    setText(fmtMMSS(seconds));
                    return;
                }
                onCommit(parsed);
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{ ...input, width: 84, textAlign: "center", fontFamily: "ui-monospace, monospace" }}
        />
    );
}

export default function QuestionWiseVideosPageContent() {
    // ---- submission form ----
    const [driveUrls, setDriveUrls] = useState<string[]>([""]);
    // Clip cutting is disabled for now — timestamps only. Kept as a constant
    // (not a toggle) so re-enabling later is a one-line change plus restoring
    // the checkbox below.
    const wantClips = false;
    const [highAccuracy, setHighAccuracy] = useState(false);
    const [computeMode, setComputeMode] = useState<"server" | "colab">("server");
    const [submitting, setSubmitting] = useState(false);
    const [submitErrors, setSubmitErrors] = useState<{ url: string; error: string }[]>([]);

    // ---- tracked jobs (freshly submitted this session, or pulled in from history) ----
    const [jobIds, setJobIds] = useState<string[]>([]);
    const [jobsById, setJobsById] = useState<Record<string, JobStatusResponse>>({});
    const [draftRowsByJob, setDraftRowsByJob] = useState<Record<string, QuestionRow[]>>({});
    const initializedDrafts = useRef<Set<string>>(new Set());
    const [confirming, setConfirming] = useState<Record<string, boolean>>({});
    const [confirmErrors, setConfirmErrors] = useState<Record<string, string>>({});

    // ---- history ----
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyExpanded, setHistoryExpanded] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);

    // ---- Google Drive connection + per-job upload state ----
    const [driveConnected, setDriveConnected] = useState(false);
    const [driveBanner, setDriveBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
    const [uploadingToDrive, setUploadingToDrive] = useState<Record<string, boolean>>({});
    const [uploadResults, setUploadResults] = useState<Record<string, { folderUrl?: string; error?: string }>>({});

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const res = await fetch("/api/user/api-keys", { cache: "no-store" });
                const payload = (await res.json()) as { success?: boolean; apiKeys?: { google_drive?: string } };
                if (mounted && payload.success) {
                    setDriveConnected(!!parseGoogleDriveProviderConfig(payload.apiKeys?.google_drive).refreshToken);
                }
            } catch {
                // ignore — Upload to Drive buttons just stay disabled
            }
        })();
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const connected = params.get("driveConnected");
        const err = params.get("driveError");
        if (connected) {
            setDriveBanner({ type: "success", message: "Google Drive connected." });
            setDriveConnected(true);
        } else if (err) {
            setDriveBanner({ type: "error", message: err });
        }
        if (connected || err) {
            window.history.replaceState({}, "", window.location.pathname);
        }
    }, []);

    const uploadToDrive = async (jobId: string) => {
        setUploadingToDrive((prev) => ({ ...prev, [jobId]: true }));
        setUploadResults((prev) => ({ ...prev, [jobId]: {} }));
        try {
            const res = await fetch(`/api/question-wise-videos/${jobId}/upload-to-drive`, { method: "POST" });
            const payload = (await res.json()) as { success?: boolean; error?: string; folderUrl?: string };
            if (!res.ok || !payload.success) {
                setUploadResults((prev) => ({ ...prev, [jobId]: { error: payload.error || "Upload failed." } }));
                return;
            }
            setUploadResults((prev) => ({ ...prev, [jobId]: { folderUrl: payload.folderUrl } }));
        } catch (err) {
            setUploadResults((prev) => ({
                ...prev,
                [jobId]: { error: err instanceof Error ? err.message : String(err) },
            }));
        } finally {
            setUploadingToDrive((prev) => ({ ...prev, [jobId]: false }));
        }
    };

    const loadHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const res = await fetch("/api/question-wise-videos", { cache: "no-store" });
            const payload = (await res.json()) as { success?: boolean; jobs?: HistoryEntry[] };
            if (res.ok && payload.success) setHistory(payload.jobs || []);
        } catch {
            // ignore — history is best-effort
        } finally {
            setHistoryLoading(false);
        }
    }, []);
    useEffect(() => {
        void loadHistory();
    }, [loadHistory]);

    const pollJob = useCallback(async (jobId: string) => {
        try {
            const res = await fetch(`/api/question-wise-videos/${jobId}/status`, { cache: "no-store" });
            const payload = (await res.json()) as { success?: boolean } & Partial<JobStatusResponse>;
            if (!res.ok || !payload.success) return;
            const job = payload as JobStatusResponse;
            setJobsById((prev) => ({ ...prev, [jobId]: job }));
            if (job.status === "ready_for_review" && !initializedDrafts.current.has(jobId)) {
                initializedDrafts.current.add(jobId);
                setDraftRowsByJob((prev) => ({ ...prev, [jobId]: job.questions.map((q) => ({ ...q })) }));
            }
            if (job.status === "done" || job.status === "failed") {
                void loadHistory();
            }
        } catch {
            // ignore — next poll tick will retry
        }
    }, [loadHistory]);

    // Poll every active (non-terminal) tracked job every 3s.
    useEffect(() => {
        if (jobIds.length === 0) return;
        const tick = () => {
            for (const id of jobIds) {
                const known = jobsById[id];
                if (!known || !TERMINAL_STATUSES.has(known.status)) void pollJob(id);
            }
        };
        tick();
        const interval = setInterval(tick, 3000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobIds]);

    const trackJob = (jobId: string) => {
        setJobIds((prev) => (prev.includes(jobId) ? prev : [jobId, ...prev]));
    };

    // ---- submission ----
    const addUrlRow = () => setDriveUrls((prev) => [...prev, ""]);
    const removeUrlRow = (i: number) => setDriveUrls((prev) => prev.filter((_, idx) => idx !== i));
    const updateUrlRow = (i: number, value: string) =>
        setDriveUrls((prev) => prev.map((u, idx) => (idx === i ? value : u)));

    const handleSubmit = async () => {
        const urls = driveUrls.map((u) => u.trim()).filter(Boolean);
        if (urls.length === 0) return;
        setSubmitting(true);
        setSubmitErrors([]);
        try {
            const res = await fetch("/api/question-wise-videos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ driveUrls: urls, wantClips, accuracy: highAccuracy ? "high" : "fast" }),
            });
            const payload = (await res.json()) as {
                success?: boolean;
                error?: string;
                jobs?: { url: string; jobId?: string; error?: string }[];
            };
            if (!res.ok && !payload.jobs) {
                setSubmitErrors([{ url: urls.join(", "), error: payload.error || "Request failed." }]);
                return;
            }
            const errs: { url: string; error: string }[] = [];
            for (const j of payload.jobs || []) {
                if (j.jobId) trackJob(j.jobId);
                else errs.push({ url: j.url, error: j.error || "Failed to start." });
            }
            setSubmitErrors(errs);
            if ((payload.jobs || []).some((j) => j.jobId)) {
                setDriveUrls([""]);
            }
        } catch (err) {
            setSubmitErrors([{ url: urls.join(", "), error: err instanceof Error ? err.message : String(err) }]);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDownloadNotebooks = async () => {
        const urls = driveUrls.map((u) => u.trim()).filter(Boolean);
        if (urls.length === 0) return;
        setSubmitting(true);
        setSubmitErrors([]);
        const errs: { url: string; error: string }[] = [];
        for (const url of urls) {
            try {
                const res = await fetch(
                    `/api/question-wise-videos/colab-notebook?driveUrl=${encodeURIComponent(url)}&accuracy=${highAccuracy ? "high" : "fast"}`
                );
                const contentType = res.headers.get("content-type") || "";
                if (contentType.includes("application/json")) {
                    const payload = (await res.json()) as { success?: boolean; error?: string; colabUrl?: string };
                    if (!res.ok || !payload.success || !payload.colabUrl) {
                        errs.push({ url, error: payload.error || "Failed to generate notebook." });
                        continue;
                    }
                    window.open(payload.colabUrl, "_blank");
                } else {
                    if (!res.ok) {
                        errs.push({ url, error: `Failed to generate notebook (HTTP ${res.status}).` });
                        continue;
                    }
                    const blob = await res.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = objectUrl;
                    a.download = "question-wise-videos.ipynb";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(objectUrl);
                }
            } catch (err) {
                errs.push({ url, error: err instanceof Error ? err.message : String(err) });
            }
        }
        setSubmitErrors(errs);
        setSubmitting(false);
    };

    // ---- review-row editing ----
    const setRows = (jobId: string, rows: QuestionRow[]) => {
        const sorted = [...rows].sort((a, b) => a.startSec - b.startSec);
        setDraftRowsByJob((prev) => ({ ...prev, [jobId]: sorted }));
    };

    const updateRowStart = (jobId: string, rowIdx: number, sec: number) => {
        const rows = draftRowsByJob[jobId] || [];
        const next = rows.map((r, i) => (i === rowIdx ? { ...r, startSec: sec } : r));
        setRows(jobId, next);
    };

    const deleteRow = (jobId: string, rowIdx: number) => {
        const rows = draftRowsByJob[jobId] || [];
        if (rows.length <= 1) return;
        setRows(jobId, rows.filter((_, i) => i !== rowIdx));
    };

    const insertSplit = (jobId: string, afterIdx: number) => {
        const rows = draftRowsByJob[jobId] || [];
        const a = rows[afterIdx];
        const b = rows[afterIdx + 1];
        if (!a || !b) return;
        const mid = Math.round((a.startSec + b.startSec) / 2);
        if (mid <= a.startSec || mid >= b.startSec) return; // no room to split
        setRows(jobId, [...rows, { index: 0, startSec: mid, endSec: b.startSec }]);
    };

    const confirmJob = async (jobId: string) => {
        const job = jobsById[jobId];
        const rows = draftRowsByJob[jobId];
        if (!job || !rows || rows.length === 0) return;
        const duration = job.videoDurationSec ?? rows[rows.length - 1].startSec;
        const questions = rows.map((r, i) => {
            // Keep each question's detected end — it already stops when the
            // teacher finishes and trims the silent gap before the next
            // question — only clamping it so it can't spill past the next
            // question's start. The last question keeps its own end.
            const cap = i + 1 < rows.length ? rows[i + 1].startSec : duration;
            const endSec = Math.max(r.startSec, Math.min(r.endSec ?? cap, cap));
            return { index: i + 1, startSec: r.startSec, endSec, thumbPath: r.thumbPath };
        });
        setConfirming((prev) => ({ ...prev, [jobId]: true }));
        setConfirmErrors((prev) => ({ ...prev, [jobId]: "" }));
        try {
            const res = await fetch(`/api/question-wise-videos/${jobId}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions }),
            });
            const payload = (await res.json()) as { success?: boolean; error?: string };
            if (!res.ok || !payload.success) {
                setConfirmErrors((prev) => ({ ...prev, [jobId]: payload.error || "Confirm failed." }));
                return;
            }
            void pollJob(jobId);
        } catch (err) {
            setConfirmErrors((prev) => ({ ...prev, [jobId]: err instanceof Error ? err.message : String(err) }));
        } finally {
            setConfirming((prev) => ({ ...prev, [jobId]: false }));
        }
    };

    const downloadJob = (jobId: string) => {
        window.open(`/api/question-wise-videos/${jobId}/download`, "_blank");
    };

    return (
        <div style={{ display: "grid", gap: 16, maxWidth: 900 }}>
            {driveBanner && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: `1px solid ${driveBanner.type === "success" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`,
                        background: driveBanner.type === "success" ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                        color: driveBanner.type === "success" ? "#22c55e" : "#ef4444",
                        fontSize: "0.82rem",
                    }}
                >
                    <span style={{ flex: 1 }}>{driveBanner.message}</span>
                    <button
                        type="button"
                        onClick={() => setDriveBanner(null)}
                        style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", display: "grid" }}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

            {/* Input */}
            <div style={card}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                    Lecture Recording Link(s)
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                    {driveUrls.map((url, i) => (
                        <div key={i} style={{ display: "flex", gap: 8 }}>
                            <input
                                type="text"
                                value={url}
                                onChange={(e) => updateUrlRow(i, e.target.value)}
                                placeholder="https://drive.google.com/file/d/.../view?usp=sharing"
                                style={input}
                            />
                            {driveUrls.length > 1 && (
                                <button
                                    type="button"
                                    onClick={() => removeUrlRow(i)}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: 8,
                                        background: "var(--bg-tertiary)",
                                        color: "var(--text-secondary)",
                                        width: 36,
                                        cursor: "pointer",
                                        display: "grid",
                                        placeItems: "center",
                                    }}
                                >
                                    <Trash2 size={14} />
                                </button>
                            )}
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={addUrlRow}
                        style={{
                            justifySelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            border: "1px dashed var(--border-primary)",
                            borderRadius: 8,
                            background: "transparent",
                            color: "var(--text-secondary)",
                            fontSize: "0.78rem",
                            fontWeight: 600,
                            padding: "6px 10px",
                            cursor: "pointer",
                        }}
                    >
                        <Plus size={13} /> Add another link
                    </button>
                </div>

                <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                    Produces per-question timestamps (a CSV). Each question ends 1s before the next begins, so the
                    next question isn&rsquo;t included at the boundary. Clip cutting is turned off for now.
                </div>

                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input
                        type="checkbox"
                        checked={highAccuracy}
                        onChange={(e) => setHighAccuracy(e.target.checked)}
                        style={{ marginTop: 3 }}
                    />
                    <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                        High accuracy (slower)
                        <span style={{ display: "block", fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            Reads each frame&rsquo;s question number individually — better on videos with 2-digit
                            numbers, but detection takes several minutes longer.
                        </span>
                    </span>
                </label>

                <div style={{ display: "grid", gap: 6 }}>
                    <span style={label}>Compute</span>
                    <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)", width: "fit-content" }}>
                        {(["server", "colab"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setComputeMode(m)}
                                style={{
                                    border: "none",
                                    borderRadius: 8,
                                    padding: "7px 14px",
                                    fontSize: "0.8rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    background: computeMode === m ? "var(--accent-glow)" : "transparent",
                                    color: computeMode === m ? "var(--accent-primary-hover)" : "var(--text-tertiary)",
                                }}
                            >
                                {m === "server" ? "Run on this server" : "Run on Google Colab"}
                            </button>
                        ))}
                    </div>
                    {computeMode === "colab" && (
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            Downloads a ready-to-run notebook — open it in Colab and run all cells. Uses your own
                            free Colab compute and Drive; no job is created here, and nothing to review on this page
                            for this run.
                        </div>
                    )}
                </div>

                {submitErrors.length > 0 && (
                    <div style={{ display: "grid", gap: 4 }}>
                        {submitErrors.map((e, i) => (
                            <div key={i} style={{ fontSize: "0.75rem", color: "#ef4444" }}>
                                {e.url}: {e.error}
                            </div>
                        ))}
                    </div>
                )}

                <button
                    type="button"
                    onClick={() => void (computeMode === "colab" ? handleDownloadNotebooks() : handleSubmit())}
                    disabled={submitting || driveUrls.every((u) => !u.trim())}
                    style={{
                        justifySelf: "start",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        border: "none",
                        borderRadius: 9,
                        padding: "9px 18px",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        color: "#fff",
                        background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                        cursor: submitting ? "default" : "pointer",
                        opacity: submitting ? 0.7 : 1,
                    }}
                >
                    {submitting ? <Loader2 size={14} className="animate-spin" /> : <VideoIcon size={14} />}
                    {computeMode === "colab" ? "Get Colab Notebook" : "Detect Question Boundaries"}
                </button>
            </div>

            {/* Tracked jobs */}
            {jobIds.map((jobId) => {
                const job = jobsById[jobId];
                if (!job) {
                    return (
                        <div key={jobId} style={card}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-tertiary)" }}>
                                <Loader2 size={14} className="animate-spin" /> Loading job…
                            </div>
                        </div>
                    );
                }
                return (
                    <JobCard
                        key={jobId}
                        job={job}
                        draftRows={draftRowsByJob[jobId]}
                        confirming={!!confirming[jobId]}
                        confirmError={confirmErrors[jobId]}
                        driveConnected={driveConnected}
                        uploadingToDrive={!!uploadingToDrive[jobId]}
                        uploadResult={uploadResults[jobId]}
                        onUpdateStart={(rowIdx, sec) => updateRowStart(jobId, rowIdx, sec)}
                        onDeleteRow={(rowIdx) => deleteRow(jobId, rowIdx)}
                        onInsertSplit={(afterIdx) => insertSplit(jobId, afterIdx)}
                        onConfirm={() => void confirmJob(jobId)}
                        onDownload={() => downloadJob(jobId)}
                        onUploadToDrive={() => void uploadToDrive(jobId)}
                    />
                );
            })}

            {/* History */}
            <div style={{ ...card, padding: 0, gap: 0, overflow: "hidden" }}>
                <button
                    type="button"
                    onClick={() => setHistoryExpanded((prev) => !prev)}
                    style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "16px 20px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--text-primary)",
                        textAlign: "left",
                    }}
                >
                    <div
                        style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            background: "rgba(99,102,241,0.12)",
                            color: "#818cf8",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        <History size={14} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "0.88rem", fontWeight: 700 }}>Job History</div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                            {historyLoading ? "Loading…" : `${history.length} job${history.length !== 1 ? "s" : ""}`}
                        </div>
                    </div>
                    {historyExpanded ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
                </button>

                {historyExpanded && (
                    <div style={{ padding: "0 20px 20px", display: "grid", gap: 6 }}>
                        {history.length === 0 ? (
                            <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                                No jobs yet. Submit a Drive link above to get started.
                            </div>
                        ) : (
                            history.map((entry) => {
                                const date = new Date(entry.createdAt);
                                const timeStr =
                                    date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) +
                                    " · " +
                                    date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
                                return (
                                    <div
                                        key={entry.jobId}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "10px 12px",
                                            borderRadius: 9,
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                        }}
                                    >
                                        <StatusPill status={entry.status} />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div
                                                style={{
                                                    fontSize: "0.8rem",
                                                    fontWeight: 600,
                                                    color: "var(--text-primary)",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {entry.videoLabel || entry.sourceUrl}
                                            </div>
                                            <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
                                                <Clock size={10} />
                                                {timeStr}
                                                {entry.questionCount > 0 && (
                                                    <>
                                                        <span style={{ opacity: 0.5 }}>·</span>
                                                        <span>{entry.questionCount} questions</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        {entry.status === "done" ? (
                                            <button
                                                type="button"
                                                onClick={() => downloadJob(entry.jobId)}
                                                title="Download"
                                                style={{
                                                    width: 26,
                                                    height: 26,
                                                    borderRadius: 6,
                                                    border: "1px solid var(--border-primary)",
                                                    background: "var(--bg-elevated)",
                                                    color: "var(--text-secondary)",
                                                    cursor: "pointer",
                                                    display: "grid",
                                                    placeItems: "center",
                                                    flexShrink: 0,
                                                }}
                                            >
                                                <Download size={13} />
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => trackJob(entry.jobId)}
                                                style={{
                                                    border: "1px solid var(--border-primary)",
                                                    borderRadius: 6,
                                                    background: "var(--bg-elevated)",
                                                    color: "var(--text-secondary)",
                                                    fontSize: "0.72rem",
                                                    fontWeight: 600,
                                                    padding: "5px 10px",
                                                    cursor: "pointer",
                                                    flexShrink: 0,
                                                }}
                                            >
                                                View
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function StatusPill({ status }: { status: JobStatus }) {
    const colors: Record<JobStatus, { bg: string; fg: string; border: string }> = {
        queued: { bg: "rgba(148,163,184,0.1)", fg: "#94a3b8", border: "rgba(148,163,184,0.25)" },
        downloading: { bg: "rgba(245,158,11,0.1)", fg: "#f59e0b", border: "rgba(245,158,11,0.25)" },
        detecting: { bg: "rgba(245,158,11,0.1)", fg: "#f59e0b", border: "rgba(245,158,11,0.25)" },
        ready_for_review: { bg: "rgba(99,102,241,0.1)", fg: "#818cf8", border: "rgba(99,102,241,0.25)" },
        cropping: { bg: "rgba(245,158,11,0.1)", fg: "#f59e0b", border: "rgba(245,158,11,0.25)" },
        done: { bg: "rgba(34,197,94,0.1)", fg: "#22c55e", border: "rgba(34,197,94,0.25)" },
        failed: { bg: "rgba(239,68,68,0.1)", fg: "#ef4444", border: "rgba(239,68,68,0.25)" },
        discarded: { bg: "rgba(148,163,184,0.1)", fg: "#94a3b8", border: "rgba(148,163,184,0.25)" },
    };
    const c = colors[status];
    return (
        <span
            style={{
                padding: "3px 8px",
                borderRadius: 6,
                fontSize: "0.66rem",
                fontWeight: 700,
                background: c.bg,
                color: c.fg,
                border: `1px solid ${c.border}`,
                whiteSpace: "nowrap",
                flexShrink: 0,
            }}
        >
            {STATUS_LABELS[status]}
        </span>
    );
}

function JobCard({
    job,
    draftRows,
    confirming,
    confirmError,
    driveConnected,
    uploadingToDrive,
    uploadResult,
    onUpdateStart,
    onDeleteRow,
    onInsertSplit,
    onConfirm,
    onDownload,
    onUploadToDrive,
}: {
    job: JobStatusResponse;
    draftRows?: QuestionRow[];
    confirming: boolean;
    confirmError?: string;
    driveConnected: boolean;
    uploadingToDrive: boolean;
    uploadResult?: { folderUrl?: string; error?: string };
    onUpdateStart: (rowIdx: number, sec: number) => void;
    onDeleteRow: (rowIdx: number) => void;
    onInsertSplit: (afterIdx: number) => void;
    onConfirm: () => void;
    onDownload: () => void;
    onUploadToDrive: () => void;
}) {
    const duration = job.videoDurationSec ?? 0;

    return (
        <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <StatusPill status={job.status} />
                <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {job.sourceUrl}
                </div>
            </div>

            {(job.status === "queued" || job.status === "downloading" || job.status === "detecting" || job.status === "cropping") && (
                <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-tertiary)", fontSize: "0.8rem" }}>
                        <Loader2 size={14} className="animate-spin" />
                        {STATUS_LABELS[job.status]}
                    </div>
                    {job.log && (
                        <pre
                            style={{
                                margin: 0,
                                maxHeight: 160,
                                overflow: "auto",
                                fontSize: "0.7rem",
                                lineHeight: 1.5,
                                background: "var(--bg-tertiary)",
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                padding: "8px 10px",
                                color: "var(--text-tertiary)",
                                whiteSpace: "pre-wrap",
                            }}
                        >
                            {job.log.slice(-2000)}
                        </pre>
                    )}
                </div>
            )}

            {job.status === "failed" && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid rgba(239,68,68,0.3)",
                        background: "rgba(239,68,68,0.08)",
                        color: "#ef4444",
                        fontSize: "0.8rem",
                    }}
                >
                    <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{job.error || "Job failed."}</span>
                </div>
            )}

            {job.status === "ready_for_review" && draftRows && (
                <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                        {draftRows.length} question{draftRows.length !== 1 ? "s" : ""} detected. Review and adjust
                        start times below — each question&rsquo;s end is where the teacher finishes it, with the
                        silent gap before the next question trimmed off.
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                        {draftRows.map((row, i) => {
                            const cap = i + 1 < draftRows.length ? draftRows[i + 1].startSec : duration;
                            const end = Math.max(row.startSec, Math.min(row.endSec ?? cap, cap));
                            return (
                                <div key={i}>
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "8px 10px",
                                            borderRadius: 8,
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                        }}
                                    >
                                        {row.thumbUrl ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={row.thumbUrl}
                                                alt={`Q${i + 1}`}
                                                style={{ width: 56, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                                            />
                                        ) : (
                                            <div style={{ width: 56, height: 32, borderRadius: 4, background: "var(--bg-elevated)", flexShrink: 0 }} />
                                        )}
                                        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-primary)", width: 30 }}>
                                            Q{i + 1}
                                        </div>
                                        <EditableTime seconds={row.startSec} onCommit={(sec) => onUpdateStart(i, sec)} />
                                        <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>→</span>
                                        <div style={{ ...input, width: 84, textAlign: "center", opacity: 0.7, fontFamily: "ui-monospace, monospace" }}>
                                            {fmtMMSS(end)}
                                        </div>
                                        <div style={{ flex: 1 }} />
                                        <button
                                            type="button"
                                            onClick={() => onDeleteRow(i)}
                                            disabled={draftRows.length <= 1}
                                            title="Delete (merges into neighboring question)"
                                            style={{
                                                border: "1px solid var(--border-primary)",
                                                borderRadius: 6,
                                                background: "var(--bg-elevated)",
                                                color: draftRows.length <= 1 ? "var(--text-muted)" : "#ef4444",
                                                width: 28,
                                                height: 28,
                                                cursor: draftRows.length <= 1 ? "default" : "pointer",
                                                display: "grid",
                                                placeItems: "center",
                                                flexShrink: 0,
                                            }}
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                    {i < draftRows.length - 1 && (
                                        <div style={{ display: "flex", justifyContent: "center", padding: "2px 0" }}>
                                            <button
                                                type="button"
                                                onClick={() => onInsertSplit(i)}
                                                title="Insert a split here (fixes a missed boundary)"
                                                style={{
                                                    border: "1px dashed var(--border-primary)",
                                                    borderRadius: 6,
                                                    background: "transparent",
                                                    color: "var(--text-muted)",
                                                    fontSize: "0.68rem",
                                                    padding: "2px 8px",
                                                    cursor: "pointer",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: 4,
                                                }}
                                            >
                                                <Scissors size={10} /> Split
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {confirmError && (
                        <div style={{ fontSize: "0.75rem", color: "#ef4444" }}>{confirmError}</div>
                    )}

                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={confirming}
                        style={{
                            justifySelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            border: "none",
                            borderRadius: 9,
                            padding: "9px 18px",
                            fontSize: "0.85rem",
                            fontWeight: 700,
                            color: "#fff",
                            background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                            cursor: confirming ? "default" : "pointer",
                            opacity: confirming ? 0.7 : 1,
                        }}
                    >
                        {confirming ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                        {job.wantClips ? "Confirm & Crop Clips" : "Confirm Timestamps"}
                    </button>
                </div>
            )}

            {job.status === "done" && (
                <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            {job.wantClips
                                ? `${job.cropResult?.clipCount ?? 0} clip(s) ready.`
                                : "Timestamps ready."}
                        </div>
                        <button
                            type="button"
                            onClick={onDownload}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                background: "var(--bg-elevated)",
                                color: "var(--text-primary)",
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                padding: "7px 12px",
                                cursor: "pointer",
                            }}
                        >
                            <Download size={13} /> Download
                        </button>
                        <button
                            type="button"
                            onClick={onUploadToDrive}
                            disabled={!driveConnected || uploadingToDrive}
                            title={driveConnected ? undefined : "Connect Google Drive first (user icon → Manage API Keys → Google Drive)"}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                background: "var(--bg-elevated)",
                                color: driveConnected ? "var(--text-primary)" : "var(--text-muted)",
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                padding: "7px 12px",
                                cursor: !driveConnected || uploadingToDrive ? "default" : "pointer",
                                opacity: !driveConnected || uploadingToDrive ? 0.6 : 1,
                            }}
                        >
                            {uploadingToDrive ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
                            Upload to Drive
                        </button>
                    </div>
                    {uploadResult?.error && (
                        <div style={{ fontSize: "0.75rem", color: "#ef4444" }}>{uploadResult.error}</div>
                    )}
                    {uploadResult?.folderUrl && (
                        <a
                            href={uploadResult.folderUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: "0.75rem",
                                color: "#818cf8",
                                textDecoration: "none",
                                width: "fit-content",
                            }}
                        >
                            Uploaded — open in Google Drive <ExternalLink size={11} />
                        </a>
                    )}
                </div>
            )}
        </div>
    );
}
