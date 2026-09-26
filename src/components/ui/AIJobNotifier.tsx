"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAIJobQueue, type AIJob } from "@/context/AIJobQueueContext";
import { Loader2, CheckCircle2, AlertCircle, X, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * A floating notification widget that shows the status of background AI jobs.
 * Renders in the bottom-right corner across all pages.
 */
export default function AIJobNotifier() {
    const { jobs, dismissJob, activeJobCount, activeAsyncJobs } = useAIJobQueue();
    const router = useRouter();
    const [collapsed, setCollapsed] = useState(false);
    const prevDoneCountRef = useRef(0);

    // Track newly completed jobs to pulse the badge
    const doneJobs = jobs.filter((j) => j.status === "done");
    const hasNewDone = doneJobs.length > prevDoneCountRef.current;

    useEffect(() => {
        prevDoneCountRef.current = doneJobs.length;
    }, [doneJobs.length]);

    // Don't render if nothing is queued/running/tracked
    if (jobs.length === 0 && activeAsyncJobs.length === 0) return null;

    const visibleJobs = jobs.filter((j) => j.status !== "done" || true); // show all
    const runningJobs = jobs.filter((j) => j.status === "running");
    const queuedJobs = jobs.filter((j) => j.status === "queued");
    const errorJobs = jobs.filter((j) => j.status === "error");
    // Tracked QBG async jobs count as "running" for the summary.
    const runningCount = runningJobs.length + activeAsyncJobs.length;

    const statusLabel = runningCount > 0
        ? `Processing ${runningCount} job${runningCount > 1 ? "s" : ""}...`
        : queuedJobs.length > 0
            ? `${queuedJobs.length} job${queuedJobs.length > 1 ? "s" : ""} queued`
            : doneJobs.length > 0
                ? `${doneJobs.length} report${doneJobs.length > 1 ? "s" : ""} ready`
                : errorJobs.length > 0
                    ? `${errorJobs.length} job${errorJobs.length > 1 ? "s" : ""} failed`
                    : "";

    const statusIcon = runningCount > 0 ? (
        <Loader2 size={14} className="animate-spin" />
    ) : doneJobs.length > 0 ? (
        <CheckCircle2 size={14} />
    ) : errorJobs.length > 0 ? (
        <AlertCircle size={14} />
    ) : (
        <Sparkles size={14} />
    );

    const statusColor = runningCount > 0
        ? "#818cf8"
        : doneJobs.length > 0
            ? "#22c55e"
            : errorJobs.length > 0
                ? "#ef4444"
                : "var(--text-muted)";

    function getJobIcon(job: AIJob) {
        switch (job.status) {
            case "queued": return <Sparkles size={12} color="var(--text-muted)" />;
            case "running": return <Loader2 size={12} className="animate-spin" color="#818cf8" />;
            case "done": return <CheckCircle2 size={12} color="#22c55e" />;
            case "error": return <AlertCircle size={12} color="#ef4444" />;
        }
    }

    function getTypeLabel(type: string) {
        switch (type) {
            case "qc": return "QC";
            case "solution": return "Solution";
            case "modification": return "Modification";
            case "extraction": return "Extraction";
            default: return type;
        }
    }

    return (
        <div
            style={{
                position: "fixed",
                bottom: "20px",
                right: "20px",
                zIndex: 9999,
                display: "grid",
                gap: "0px",
                maxWidth: "340px",
                width: "100%",
            }}
        >
            {/* Expanded job list */}
            {!collapsed && (visibleJobs.length > 0 || activeAsyncJobs.length > 0) && (
                <div
                    style={{
                        borderRadius: "12px 12px 0 0",
                        border: "1px solid var(--border-primary)",
                        borderBottom: "none",
                        background: "var(--bg-secondary)",
                        backdropFilter: "blur(12px)",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                        maxHeight: "280px",
                        overflowY: "auto",
                        padding: "8px",
                        display: "grid",
                        gap: "4px",
                    }}
                >
                    {/* Tracked QBG async jobs (running in the background across navigation) */}
                    {activeAsyncJobs.map((aj) => (
                        <div
                            key={aj.jobId}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "8px 10px",
                                borderRadius: "8px",
                                background: "var(--bg-tertiary)",
                                fontSize: "0.76rem",
                            }}
                        >
                            <Loader2 size={12} className="animate-spin" color="#818cf8" />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontWeight: 600,
                                        color: "var(--text-primary)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {aj.label}
                                </div>
                                <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: "2px" }}>
                                    Running in the background — you can leave this page.
                                </div>
                            </div>
                        </div>
                    ))}
                    {visibleJobs.map((job) => (
                        <div
                            key={job.id}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "8px 10px",
                                borderRadius: "8px",
                                background: "var(--bg-tertiary)",
                                fontSize: "0.76rem",
                            }}
                        >
                            {getJobIcon(job)}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontWeight: 600,
                                        color: "var(--text-primary)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {getTypeLabel(job.type)} — {job.fileName}
                                </div>
                                {job.error && (
                                    <div style={{ fontSize: "0.68rem", color: "#ef4444", marginTop: "2px" }}>
                                        {job.error.slice(0, 80)}
                                    </div>
                                )}
                                {job.status === "done" && (
                                    <div style={{ fontSize: "0.68rem", color: "#22c55e", marginTop: "2px" }}>
                                        {job.type === "extraction" ? "Extraction ready — view in Report History" : "Report ready — view in AI Tools"}
                                    </div>
                                )}
                            </div>
                            {(job.status === "done" || job.status === "error") && (
                                <button
                                    type="button"
                                    onClick={() => dismissJob(job.id)}
                                    style={{
                                        background: "none",
                                        border: "none",
                                        color: "var(--text-muted)",
                                        cursor: "pointer",
                                        padding: "2px",
                                        flexShrink: 0,
                                    }}
                                >
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Status bar / collapse toggle */}
            <button
                type="button"
                onClick={() => {
                    if (activeJobCount === 0 && doneJobs.length > 0) {
                        // Navigate to AI tools to view reports
                        router.push("/ai-tools");
                        // Dismiss done jobs
                        doneJobs.forEach((j) => dismissJob(j.id));
                    } else {
                        setCollapsed((prev) => !prev);
                    }
                }}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 14px",
                    borderRadius: collapsed || visibleJobs.length === 0 ? "12px" : "0 0 12px 12px",
                    border: `1px solid ${statusColor}33`,
                    background: `${statusColor}15`,
                    backdropFilter: "blur(12px)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                    cursor: "pointer",
                    color: statusColor,
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    width: "100%",
                    textAlign: "left",
                    transition: "all 0.2s ease",
                    animation: hasNewDone ? "pulse 0.5s ease" : undefined,
                }}
            >
                {statusIcon}
                <span style={{ flex: 1 }}>{statusLabel}</span>
                {activeJobCount + activeAsyncJobs.length > 0 && (
                    <span
                        style={{
                            width: "20px",
                            height: "20px",
                            borderRadius: "6px",
                            background: statusColor,
                            color: "#fff",
                            fontSize: "0.68rem",
                            fontWeight: 800,
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        {activeJobCount + activeAsyncJobs.length}
                    </span>
                )}
            </button>
        </div>
    );
}
