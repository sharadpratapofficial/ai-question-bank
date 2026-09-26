"use client";

/**
 * ExtractionQueueContext
 *
 * Background queue for PDF extraction jobs. Lives in the root layout so the
 * user can kick off an extraction from /upload, navigate to /questions or
 * /tests, and the request keeps running. The server persists each result
 * into public.pdf_extraction_reports, so the user can later open
 * /upload/reports to review and save.
 *
 * Processing model: one extraction at a time (FIFO). PDF extraction is
 * AI-heavy; running them sequentially keeps memory + API rate-limits sane.
 */

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type {
    ExtractionRequest,
    ExtractionResponse,
} from "@/types/extraction";

export type ExtractionJobStatus = "queued" | "running" | "done" | "error";
export type ExtractionJobKind = "pdf" | "docx";

export interface ExtractionJob {
    /** Local-only ID for the in-flight queue */
    localId: string;
    /** Picks the API endpoint — defaults to "pdf". */
    kind?: ExtractionJobKind;
    sourceName: string;
    questionsPdfName?: string;
    solutionsPdfName?: string;
    mode: "single" | "dual";
    provider: string;
    modelId: string;
    status: ExtractionJobStatus;
    createdAt: string;
    /** Set once the server returns: the persisted pdf_extraction_reports.id */
    reportId?: string;
    error?: string;
    questionCount?: number;
    /** Body we send to /api/upload/extract or /api/upload/extract-docx */
    requestBody: ExtractionRequest;
}

interface ContextValue {
    jobs: ExtractionJob[];
    activeJobCount: number;
    enqueue: (
        job: Omit<ExtractionJob, "localId" | "status" | "createdAt" | "reportId" | "error" | "questionCount">
    ) => string;
    dismiss: (localId: string) => void;
    /** Returns true if there's at least one queued / running job. */
    hasActive: boolean;
}

/**
 * Read an extraction API response defensively. The route itself always replies
 * with JSON, so a non-JSON body means an infrastructure layer in front of it
 * answered instead — typically the Cloudflare tunnel returning an HTML error
 * page (524 timeout after ~100s, 502/503, or 413 for an oversized upload).
 * Without this, `res.json()` throws the opaque `Unexpected token '<'` error and
 * hides what actually happened.
 */
async function readExtractionResponse(res: Response): Promise<ExtractionResponse> {
    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();
    if (contentType.includes("application/json")) {
        try {
            return JSON.parse(raw) as ExtractionResponse;
        } catch {
            /* fall through to the friendly gateway message */
        }
    }
    // Non-JSON (usually an HTML error page from the proxy/tunnel).
    let error: string;
    if (res.status === 504 || res.status === 524 || res.status === 408) {
        error =
            "The upload took longer than the gateway allows (~100s) and the connection was cut. " +
            "The extraction may still be finishing on the server — check the PDF Extraction Reports page in a minute before retrying.";
    } else if (res.status === 413) {
        error =
            "The file is too large for the server/proxy to accept. Try a smaller Word file, or raise the upload size limit on the reverse proxy / Cloudflare.";
    } else if (res.status === 502 || res.status === 503) {
        error = `The server was temporarily unavailable (status ${res.status}). Please retry in a moment.`;
    } else {
        const snippet = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
        error = `Server returned a non-JSON response (status ${res.status}).${snippet ? ` ${snippet}` : ""}`;
    }
    return { success: false, questions: [], pdfType: "questions_only", totalPages: 0, warnings: [], error } as ExtractionResponse;
}

const ExtractionQueueContext = createContext<ContextValue | null>(null);

export function useExtractionQueue(): ContextValue {
    const ctx = useContext(ExtractionQueueContext);
    if (!ctx) throw new Error("useExtractionQueue must be used inside ExtractionQueueProvider");
    return ctx;
}

export function ExtractionQueueProvider({ children }: { children: React.ReactNode }) {
    const [jobs, setJobs] = useState<ExtractionJob[]>([]);
    const runningRef = useRef<string | null>(null);

    const enqueue = useCallback(
        (
            input: Omit<ExtractionJob, "localId" | "status" | "createdAt" | "reportId" | "error" | "questionCount">
        ) => {
            const localId = `exq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const job: ExtractionJob = {
                ...input,
                localId,
                status: "queued",
                createdAt: new Date().toISOString(),
            };
            setJobs((prev) => [job, ...prev]);
            return localId;
        },
        []
    );

    const dismiss = useCallback((localId: string) => {
        setJobs((prev) => prev.filter((j) => j.localId !== localId));
    }, []);

    // Worker effect — picks the next queued job and runs it. Sequential.
    useEffect(() => {
        if (runningRef.current) return;
        const next = jobs.find((j) => j.status === "queued");
        if (!next) return;

        runningRef.current = next.localId;
        setJobs((prev) =>
            prev.map((j) => (j.localId === next.localId ? { ...j, status: "running" } : j))
        );

        (async () => {
            try {
                const endpoint = next.kind === "docx"
                    ? "/api/upload/extract-docx"
                    : "/api/upload/extract";
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(next.requestBody),
                });
                const data = await readExtractionResponse(res);
                if (!res.ok || !data.success) {
                    throw new Error(data.error || `Extraction failed (status ${res.status})`);
                }
                setJobs((prev) =>
                    prev.map((j) =>
                        j.localId === next.localId
                            ? {
                                  ...j,
                                  status: "done",
                                  reportId: data.reportId,
                                  questionCount: data.questions?.length ?? 0,
                              }
                            : j
                    )
                );
            } catch (err) {
                setJobs((prev) =>
                    prev.map((j) =>
                        j.localId === next.localId
                            ? {
                                  ...j,
                                  status: "error",
                                  error: err instanceof Error ? err.message : String(err),
                              }
                            : j
                    )
                );
            } finally {
                runningRef.current = null;
                // Re-trigger the worker by bumping state; the next render will pick up the
                // next queued job.
                setJobs((prev) => [...prev]);
            }
        })();
    }, [jobs]);

    const activeJobCount = useMemo(
        () => jobs.filter((j) => j.status === "queued" || j.status === "running").length,
        [jobs]
    );

    const value = useMemo<ContextValue>(
        () => ({
            jobs,
            activeJobCount,
            enqueue,
            dismiss,
            hasActive: activeJobCount > 0,
        }),
        [jobs, activeJobCount, enqueue, dismiss]
    );

    return (
        <ExtractionQueueContext.Provider value={value}>
            {children}
        </ExtractionQueueContext.Provider>
    );
}
