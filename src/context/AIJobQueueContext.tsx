"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";

// ==================== TYPES ====================

export type AIJobType = "qc" | "solution" | "modification" | "repeat_check" | "extraction" | "translate" | "video";
export type AIJobStatus = "queued" | "running" | "done" | "error";

export interface AIJob {
    id: string;
    type: AIJobType;
    fileName: string;
    provider: string;
    modelId: string;
    status: AIJobStatus;
    createdAt: string;
    error?: string;
    /** The fetch body to POST */
    requestBody: Record<string, unknown>;
    /** The API endpoint */
    endpoint: string;
}

export interface CompletedReport {
    id: string;
    report_type: AIJobType;
    file_name: string;
    provider: string;
    model_id: string;
    created_at: string;
    report_data?: unknown;
}

type NewCompletedReport = Omit<CompletedReport, "id" | "created_at">;

// ==================== CONTEXT ====================

interface AIJobQueueContextValue {
    /** Currently active/queued jobs */
    jobs: AIJob[];
    /** Number of running/queued jobs */
    activeJobCount: number;
    /** Push a new job — it will be processed automatically */
    enqueueJob: (job: Omit<AIJob, "id" | "status" | "createdAt">) => void;
    /** Dismiss a completed/errored job from the list */
    dismissJob: (id: string) => void;
    /** Read from the persistent report store */
    savedReports: CompletedReport[];
    /** Read from the persistent report store */
    reloadReports: () => Promise<void>;
    /** Save a completed report to the persistent report store */
    saveReport: (report: NewCompletedReport) => Promise<CompletedReport | null>;
    /** Delete a saved report */
    deleteReport: (id: string) => Promise<void>;
    /** Active video jobs being polled in the background across navigation. */
    activeVideoJobs: TrackedVideoJob[];
    /** Register a new video job to be tracked + polled until done/error. */
    trackVideoJob: (job: TrackedVideoJob) => void;
    /** Stop tracking + forget a video job (e.g. after manual dismiss). */
    forgetVideoJob: (jobId: string) => void;
    /** Generic async (jobId + poll) jobs tracked across navigation — QBG modifier /
     *  ingestion / tagging. Polled in the background; on completion the report store is
     *  reloaded so the finished run shows up wherever history is rendered. */
    activeAsyncJobs: TrackedAsyncJob[];
    /** Register a new async job (its poll URL already includes ?jobId=...). */
    trackAsyncJob: (job: TrackedAsyncJob) => void;
    /** Stop tracking + forget an async job. */
    forgetAsyncJob: (jobId: string) => void;
}

const AIJobQueueContext = createContext<AIJobQueueContextValue | null>(null);

export function useAIJobQueue(): AIJobQueueContextValue {
    const ctx = useContext(AIJobQueueContext);
    if (!ctx) throw new Error("useAIJobQueue must be used inside AIJobQueueProvider");
    return ctx;
}

// ==================== STORAGE ====================

const REPORT_STORAGE_KEY = "qbg_ai_report_history";
const MAX_SAVED_REPORTS = 50;

// Active video jobs that are rendering server-side. The Python sidecar can
// take 10-20 minutes for a full paper; we persist their jobIds to
// localStorage so polling resumes if the user navigates away or refreshes.
const VIDEO_JOBS_STORAGE_KEY = "qbg_active_video_jobs_v1";

export interface TrackedVideoJob {
    jobId: string;
    fileName: string;
    /** ISO timestamp — used to GC stale entries (>24h). */
    startedAt: string;
}

// Generic async jobs (QBG modifier/ingestion/tagging) that run server-side and are
// polled by jobId. Persisted so tracking resumes across navigation / refresh.
const ASYNC_JOBS_STORAGE_KEY = "qbg_active_async_jobs_v1";

export interface TrackedAsyncJob {
    jobId: string;
    /** e.g. "qbg_tagging" — used only for the display label/icon. */
    kind: string;
    /** Human label, e.g. "AI tagging · 12 IDs". */
    label: string;
    /** Full GET URL including ?jobId=... that returns {state:"running"|"done"|"error"}. */
    pollUrl: string;
    /** ISO timestamp — used to GC stale entries (>24h). */
    startedAt: string;
}

function readActiveAsyncJobs(): TrackedAsyncJob[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(ASYNC_JOBS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        return parsed.filter(
            (j) =>
                j && typeof j === "object" &&
                typeof j.jobId === "string" && j.jobId.length > 0 &&
                typeof j.pollUrl === "string" && j.pollUrl.length > 0 &&
                typeof j.startedAt === "string" &&
                Date.parse(j.startedAt) >= cutoff
        );
    } catch {
        return [];
    }
}

function writeActiveAsyncJobs(jobs: TrackedAsyncJob[]) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(ASYNC_JOBS_STORAGE_KEY, JSON.stringify(jobs));
    } catch {
        // ignore localStorage failure
    }
}

function readActiveVideoJobs(): TrackedVideoJob[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(VIDEO_JOBS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        return parsed.filter((j) => {
            const ok =
                j && typeof j === "object" &&
                typeof j.jobId === "string" && j.jobId.length > 0 &&
                typeof j.fileName === "string" &&
                typeof j.startedAt === "string";
            if (!ok) return false;
            return Date.parse(j.startedAt) >= cutoff;
        });
    } catch {
        return [];
    }
}

function writeActiveVideoJobs(jobs: TrackedVideoJob[]) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(VIDEO_JOBS_STORAGE_KEY, JSON.stringify(jobs));
    } catch {
        // ignore localStorage failure
    }
}

function readReports(): CompletedReport[] {
    try {
        if (typeof window === "undefined") return [];
        const raw = localStorage.getItem(REPORT_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeReports(reports: CompletedReport[]) {
    try {
        localStorage.setItem(
            REPORT_STORAGE_KEY,
            JSON.stringify(reports.slice(0, MAX_SAVED_REPORTS))
        );
    } catch {
        // localStorage full or unavailable
    }
}

async function getReportAuthHeaders(): Promise<HeadersInit> {
    const supabase = createSupabaseBrowserClient();
    const {
        data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};
}

async function fetchSavedReports(): Promise<CompletedReport[]> {
    const headers = await getReportAuthHeaders();
    const response = await fetch("/api/ai-tools/reports", {
        method: "GET",
        headers,
        cache: "no-store",
    });
    const payload = (await response.json()) as {
        success?: boolean;
        reports?: CompletedReport[];
        error?: string;
    };
    if (!response.ok || !payload.success || !Array.isArray(payload.reports)) {
        throw new Error(payload.error || "Failed to load AI report history.");
    }
    return payload.reports;
}

// ==================== PROVIDER ====================

export function AIJobQueueProvider({ children }: { children: React.ReactNode }) {
    const [jobs, setJobs] = useState<AIJob[]>([]);
    const [savedReports, setSavedReports] = useState<CompletedReport[]>([]);
    const [activeVideoJobs, setActiveVideoJobs] = useState<TrackedVideoJob[]>([]);
    const [activeAsyncJobs, setActiveAsyncJobs] = useState<TrackedAsyncJob[]>([]);
    const processingRef = useRef<Set<string>>(new Set());
    const videoPollingRef = useRef<Set<string>>(new Set());
    const asyncPollingRef = useRef<Set<string>>(new Set());

    const saveReportFallback = useCallback((report: CompletedReport) => {
        setSavedReports((prev) => {
            const updated = [report, ...prev.filter((r) => r.id !== report.id)].slice(0, MAX_SAVED_REPORTS);
            writeReports(updated);
            return updated;
        });
    }, []);

    const reloadReports = useCallback(async () => {
        try {
            const reports = await fetchSavedReports();
            setSavedReports(reports);
            writeReports(reports);
        } catch {
            setSavedReports(readReports());
        }
    }, []);

    useEffect(() => {
        void reloadReports();
    }, [reloadReports]);

    const deleteReport = useCallback(async (id: string) => {
        const previousReports = savedReports;
        setSavedReports((prev) => {
            const updated = prev.filter((r) => r.id !== id);
            writeReports(updated);
            return updated;
        });
        try {
            const headers = await getReportAuthHeaders();
            const response = await fetch(`/api/ai-tools/reports?id=${encodeURIComponent(id)}`, {
                method: "DELETE",
                headers,
            });
            const payload = (await response.json()) as { success?: boolean; error?: string };
            if (!response.ok || !payload.success) {
                throw new Error(payload.error || "Failed to delete AI report.");
            }
        } catch {
            setSavedReports(previousReports);
            writeReports(previousReports);
        }
    }, [savedReports]);

    const saveReport = useCallback(async (report: NewCompletedReport): Promise<CompletedReport | null> => {
        const localReport: CompletedReport = {
            ...report,
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
        };

        try {
            const authHeaders = await getReportAuthHeaders();
            const response = await fetch("/api/ai-tools/reports", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify(report),
            });
            const payload = (await response.json()) as {
                success?: boolean;
                report?: CompletedReport;
                error?: string;
            };
            if (!response.ok || !payload.success || !payload.report) {
                throw new Error(payload.error || "Failed to save AI report.");
            }
            const savedReport = {
                ...payload.report,
                report_data: report.report_data,
            };
            saveReportFallback(savedReport);
            return savedReport;
        } catch {
            saveReportFallback(localReport);
            return localReport;
        }
    }, [saveReportFallback]);

    const saveGeneratedReport = useCallback(async (report: NewCompletedReport) => {
        const savedReport = await saveReport(report);
        if (!savedReport) {
            throw new Error("AI report was generated but could not be written to the database.");
        }
        return savedReport;
    }, [saveReport]);

    // Process a single job
    const processJob = useCallback(
        async (job: AIJob) => {
            if (processingRef.current.has(job.id)) return;
            processingRef.current.add(job.id);

            // Mark as running
            setJobs((prev) =>
                prev.map((j) => (j.id === job.id ? { ...j, status: "running" as const } : j))
            );

            try {
                const headers: Record<string, string> = { "Content-Type": "application/json" };
                // Extract dev API key from request body if present
                const bodyToSend = { ...job.requestBody };
                if (bodyToSend._devApiKey) {
                    headers["x-dev-api-key"] = String(bodyToSend._devApiKey);
                    delete bodyToSend._devApiKey;
                }

                const response = await fetch(job.endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(bodyToSend),
                });

                const result = await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(result.error || "AI processing failed.");
                }

                // Save the completed report/extraction
                const reportData = job.type === "extraction"
                    ? { questions: result.questions, warnings: result.warnings, pdfType: result.pdfType }
                    : job.type === "translate"
                        ? result.result
                        : result.report;
                await saveGeneratedReport({
                    report_type: job.type,
                    file_name: job.fileName,
                    provider: job.provider,
                    model_id: job.modelId,
                    report_data: reportData,
                });

                // Mark job as done
                setJobs((prev) =>
                    prev.map((j) => (j.id === job.id ? { ...j, status: "done" as const } : j))
                );
            } catch (err) {
                setJobs((prev) =>
                    prev.map((j) =>
                        j.id === job.id
                            ? { ...j, status: "error" as const, error: err instanceof Error ? err.message : String(err) }
                            : j
                    )
                );
            } finally {
                processingRef.current.delete(job.id);
            }
        },
        [saveGeneratedReport]
    );

    // Auto-process queued jobs (one at a time)
    useEffect(() => {
        const queued = jobs.find((j) => j.status === "queued" && !processingRef.current.has(j.id));
        const runningCount = jobs.filter((j) => j.status === "running").length;

        // Process up to 1 job at a time to avoid API rate limits
        if (queued && runningCount < 1) {
            void processJob(queued);
        }
    }, [jobs, processJob]);

    const enqueueJob = useCallback((jobInput: Omit<AIJob, "id" | "status" | "createdAt">) => {
        const newJob: AIJob = {
            ...jobInput,
            id: crypto.randomUUID(),
            status: "queued",
            createdAt: new Date().toISOString(),
        };
        setJobs((prev) => [...prev, newJob]);
    }, []);

    const dismissJob = useCallback((id: string) => {
        setJobs((prev) => prev.filter((j) => j.id !== id));
    }, []);

    const activeJobCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;

    // ============ Video job tracker (persists across navigation) ============

    // Re-hydrate the tracked-video-job list from localStorage on mount.
    useEffect(() => {
        setActiveVideoJobs(readActiveVideoJobs());
    }, []);

    const trackVideoJob = useCallback((job: TrackedVideoJob) => {
        setActiveVideoJobs((prev) => {
            // Replace any existing entry with the same jobId (defensive).
            const next = [job, ...prev.filter((j) => j.jobId !== job.jobId)];
            writeActiveVideoJobs(next);
            return next;
        });
    }, []);

    const forgetVideoJob = useCallback((jobId: string) => {
        setActiveVideoJobs((prev) => {
            const next = prev.filter((j) => j.jobId !== jobId);
            writeActiveVideoJobs(next);
            return next;
        });
        videoPollingRef.current.delete(jobId);
    }, []);

    // Background poller — for each tracked video job, hit the status endpoint
    // every 5 s. On terminal state, reload the report list (so the new row
    // shows up wherever AI Reports is rendered) and stop tracking.
    useEffect(() => {
        if (activeVideoJobs.length === 0) return;

        let cancelled = false;
        const interval = setInterval(async () => {
            if (cancelled) return;
            const toCheck = [...activeVideoJobs];
            for (const j of toCheck) {
                if (videoPollingRef.current.has(j.jobId)) continue; // already in-flight
                videoPollingRef.current.add(j.jobId);
                try {
                    const res = await fetch(
                        `/api/ai-tools/video-solution/videos/${j.jobId}/status`,
                        { cache: "no-store" }
                    );
                    if (!res.ok) {
                        // 404 likely means the in-memory job is gone (server
                        // restart). Stop tracking; if the server persisted a
                        // report, the reloadReports below will surface it.
                        if (res.status === 404) {
                            forgetVideoJob(j.jobId);
                            void reloadReports();
                        }
                        continue;
                    }
                    const data = (await res.json()) as { state?: string; success?: boolean };
                    if (!data.success) continue;
                    if (data.state === "done" || data.state === "error") {
                        forgetVideoJob(j.jobId);
                        if (data.state === "done") void reloadReports();
                    }
                } catch {
                    // network blip — try again next tick
                } finally {
                    videoPollingRef.current.delete(j.jobId);
                }
            }
        }, 5000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [activeVideoJobs, reloadReports, forgetVideoJob]);

    // ============ Generic async job tracker (QBG features) ============
    useEffect(() => {
        setActiveAsyncJobs(readActiveAsyncJobs());
    }, []);

    const trackAsyncJob = useCallback((job: TrackedAsyncJob) => {
        setActiveAsyncJobs((prev) => {
            const next = [job, ...prev.filter((j) => j.jobId !== job.jobId)];
            writeActiveAsyncJobs(next);
            return next;
        });
    }, []);

    const forgetAsyncJob = useCallback((jobId: string) => {
        setActiveAsyncJobs((prev) => {
            const next = prev.filter((j) => j.jobId !== jobId);
            writeActiveAsyncJobs(next);
            return next;
        });
        asyncPollingRef.current.delete(jobId);
    }, []);

    // Background poller: hit each tracked job's poll URL every 4s. A terminal state
    // (done/error) — or a 404 because another poller on the page already consumed the
    // in-memory job — stops tracking and reloads the report list so the finished run
    // surfaces in history.
    useEffect(() => {
        if (activeAsyncJobs.length === 0) return;
        let cancelled = false;
        const interval = setInterval(async () => {
            if (cancelled) return;
            for (const j of [...activeAsyncJobs]) {
                if (asyncPollingRef.current.has(j.jobId)) continue;
                asyncPollingRef.current.add(j.jobId);
                try {
                    const res = await fetch(j.pollUrl, { cache: "no-store" });
                    if (!res.ok) {
                        if (res.status === 404) {
                            forgetAsyncJob(j.jobId);
                            void reloadReports();
                        }
                        continue;
                    }
                    const data = (await res.json()) as { state?: string };
                    if (data.state && data.state !== "running") {
                        forgetAsyncJob(j.jobId);
                        void reloadReports();
                    }
                } catch {
                    // network blip — retry next tick
                } finally {
                    asyncPollingRef.current.delete(j.jobId);
                }
            }
        }, 4000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [activeAsyncJobs, reloadReports, forgetAsyncJob]);

    return (
        <AIJobQueueContext.Provider
            value={{
                jobs,
                activeJobCount,
                enqueueJob,
                dismissJob,
                savedReports,
                reloadReports,
                deleteReport,
                saveReport,
                activeVideoJobs,
                trackVideoJob,
                forgetVideoJob,
                activeAsyncJobs,
                trackAsyncJob,
                forgetAsyncJob,
            }}
        >
            {children}
        </AIJobQueueContext.Provider>
    );
}
