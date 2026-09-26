"use client";

/**
 * Floating toast in the bottom-right that shows in-flight PDF extractions.
 * Lets the user kick off long extractions on /upload and navigate away — the
 * notifier reassures them the job is still running and links to the saved
 * report once it completes.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    FileText,
    Loader2,
    Trash2,
    XCircle,
} from "lucide-react";
import { useExtractionQueue } from "@/context/ExtractionQueueContext";

export default function ExtractionQueueNotifier() {
    const { jobs, dismiss } = useExtractionQueue();
    const [collapsed, setCollapsed] = useState(false);

    const visible = useMemo(
        () => jobs.filter((j) => j.status !== "done" || isRecent(j.createdAt)),
        [jobs]
    );

    if (visible.length === 0) return null;

    return (
        <div
            className="no-print"
            style={{
                position: "fixed",
                right: "16px",
                bottom: "16px",
                width: "min(360px, calc(100vw - 32px))",
                zIndex: 90,
                borderRadius: "12px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-accent)",
                boxShadow: "var(--shadow-md)",
                overflow: "hidden",
            }}
        >
            <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 12px",
                    background: "var(--bg-secondary)",
                    border: "none",
                    borderBottom: collapsed ? "none" : "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                    fontSize: "0.84rem",
                    fontWeight: 700,
                    cursor: "pointer",
                    textAlign: "left",
                }}
            >
                <FileText size={14} color="var(--accent-primary, #818cf8)" />
                <span style={{ flex: 1 }}>
                    PDF extractions ({visible.length})
                </span>
                {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {!collapsed && (
                <ul style={{ listStyle: "none", margin: 0, padding: "6px", display: "grid", gap: "4px", maxHeight: "260px", overflowY: "auto" }}>
                    {visible.map((job) => (
                        <li
                            key={job.localId}
                            style={{
                                display: "grid",
                                gridTemplateColumns: "18px 1fr auto",
                                gap: "8px",
                                padding: "8px 10px",
                                borderRadius: "8px",
                                background: "var(--bg-secondary)",
                                border: "1px solid var(--border-primary)",
                                alignItems: "center",
                            }}
                        >
                            <StatusIcon status={job.status} />
                            <div style={{ minWidth: 0 }}>
                                <div
                                    style={{
                                        fontSize: "0.78rem",
                                        fontWeight: 600,
                                        color: "var(--text-primary)",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                    }}
                                    title={job.sourceName}
                                >
                                    {job.sourceName}
                                </div>
                                <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                    {labelFor(job.status)}
                                    {job.status === "done" && job.questionCount !== undefined && (
                                        <> · {job.questionCount} question{job.questionCount === 1 ? "" : "s"}</>
                                    )}
                                </div>
                                {job.status === "error" && job.error && (
                                    <div
                                        style={{
                                            fontSize: "0.68rem",
                                            color: "var(--accent-danger)",
                                            marginTop: "2px",
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                        }}
                                        title={job.error}
                                    >
                                        {job.error}
                                    </div>
                                )}
                                {job.status === "done" && job.reportId && (
                                    <Link
                                        href={`/upload/reports/${job.reportId}`}
                                        style={{
                                            fontSize: "0.7rem",
                                            color: "var(--accent-primary, #818cf8)",
                                            textDecoration: "none",
                                            fontWeight: 600,
                                            marginTop: "2px",
                                            display: "inline-block",
                                        }}
                                    >
                                        Review & save →
                                    </Link>
                                )}
                            </div>
                            {(job.status === "done" || job.status === "error") && (
                                <button
                                    type="button"
                                    onClick={() => dismiss(job.localId)}
                                    aria-label="Dismiss"
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "var(--text-tertiary)",
                                        cursor: "pointer",
                                        padding: "2px",
                                    }}
                                >
                                    <Trash2 size={12} />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function StatusIcon({ status }: { status: "queued" | "running" | "done" | "error" }) {
    switch (status) {
        case "running":
            return <Loader2 size={14} className="animate-spin" color="var(--accent-primary, #818cf8)" />;
        case "done":
            return <CheckCircle2 size={14} color="var(--accent-success, #22c55e)" />;
        case "error":
            return <XCircle size={14} color="var(--accent-danger, #ef4444)" />;
        case "queued":
        default:
            return <Loader2 size={14} color="var(--text-tertiary)" />;
    }
}

function labelFor(status: "queued" | "running" | "done" | "error"): string {
    switch (status) {
        case "queued":
            return "Waiting in queue…";
        case "running":
            return "Extracting questions…";
        case "done":
            return "Completed";
        case "error":
            return "Failed";
    }
}

function isRecent(iso: string): boolean {
    return Date.now() - new Date(iso).getTime() < 10 * 60 * 1000; // 10 min
}
