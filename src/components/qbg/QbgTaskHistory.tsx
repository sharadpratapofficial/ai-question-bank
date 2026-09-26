"use client";

import { AlertCircle, CheckCircle2, History, Loader2, Trash2 } from "lucide-react";

export interface HistoryReport {
    id: string;
    file_name?: string;
    provider?: string;
    model_id?: string;
    created_at: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    report_data: { status?: "running" | "done" | "failed"; error?: string; sourceName?: string;[k: string]: any };
}

interface Props {
    /** Persisted tasks (newest first) from ai_reports. */
    reports: HistoryReport[];
    /** Labels of tasks currently running in the background (from the async tracker). */
    activeLabels: string[];
    /** Plural noun for the header, e.g. "ingestions". */
    noun: string;
    /** Short one-line summary for a completed task's row. */
    summary: (rd: HistoryReport["report_data"]) => string;
    loading?: boolean;
    onView: (r: HistoryReport) => void;
    onDelete: (id: string) => void;
}

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};

function StatusBadge({ status }: { status: "running" | "done" | "failed" }) {
    const map = {
        running: { bg: "var(--accent-glow)", fg: "var(--accent-primary-hover)", label: "Running", icon: <Loader2 size={11} className="animate-spin" /> },
        done: { bg: "rgba(var(--accent-success-rgb),0.15)", fg: "var(--accent-success)", label: "Done", icon: <CheckCircle2 size={11} /> },
        failed: { bg: "rgba(var(--accent-danger-rgb),0.15)", fg: "var(--accent-danger)", label: "Failed", icon: <AlertCircle size={11} /> },
    }[status];
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: "0.62rem",
                fontWeight: 700,
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                padding: "2px 7px",
                borderRadius: 999,
                background: map.bg,
                color: map.fg,
            }}
        >
            {map.icon}
            {map.label}
        </span>
    );
}

/**
 * Unified "Previous tasks" panel for a QBG feature: shows tasks running in the
 * background (from the cross-navigation tracker) at the top, then every persisted
 * task — done OR failed — so nothing ever silently disappears. Mirrors the Agentic
 * QC jobs list. Only completed tasks are clickable (to reopen the report).
 */
export default function QbgTaskHistory({ reports, activeLabels, noun, summary, loading, onView, onDelete }: Props) {
    const total = reports.length + activeLabels.length;
    if (total === 0) return null;

    return (
        <details open style={{ ...card, marginTop: 18 }}>
            <summary
                style={{
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontWeight: 700,
                    fontSize: "0.85rem",
                    color: "var(--text-primary)",
                }}
            >
                <History size={15} color="var(--accent-primary)" />
                Previous {noun} ({total})
                {loading && <Loader2 size={13} className="animate-spin" />}
            </summary>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                {/* Currently running (background) */}
                {activeLabels.map((label, i) => (
                    <div
                        key={`active-${i}`}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            border: "1px solid var(--border-accent)",
                            borderRadius: 8,
                            background: "var(--bg-tertiary)",
                            padding: "8px 12px",
                        }}
                    >
                        <StatusBadge status="running" />
                        <span style={{ fontWeight: 600, fontSize: "0.82rem", color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {label}
                        </span>
                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>in progress…</span>
                    </div>
                ))}

                {/* Persisted tasks (running / done / failed — status lives on the DB row) */}
                {reports.map((r) => {
                    const raw = r.report_data?.status;
                    const status: "running" | "done" | "failed" =
                        raw === "failed" ? "failed" : raw === "running" ? "running" : "done";
                    // Clickable whenever there's real progress to show, not just
                    // when the task reached "done" — a run interrupted mid-way
                    // (e.g. a browser reload) can be stuck at "running" forever
                    // since nothing ever patches it to "done", but whatever
                    // stages DID complete before the interruption are still
                    // worth recovering instead of being permanently unreachable.
                    const hasData = Object.keys(r.report_data || {}).some((k) => k !== "status" && k !== "error");
                    const clickable = status === "done" || hasData;
                    return (
                        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <button
                                type="button"
                                onClick={() => clickable && onView(r)}
                                disabled={!clickable}
                                style={{
                                    flex: 1,
                                    textAlign: "left",
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: 8,
                                    background: "var(--bg-tertiary)",
                                    padding: "8px 12px",
                                    cursor: clickable ? "pointer" : "default",
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 8,
                                    alignItems: "center",
                                }}
                            >
                                <StatusBadge status={status} />
                                <span style={{ fontWeight: 600, fontSize: "0.82rem", color: "var(--text-primary)" }}>
                                    {r.report_data?.sourceName || r.file_name || "Task"}
                                </span>
                                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    {status === "failed"
                                        ? // A failed/interrupted run can still have real partial
                                          // progress worth surfacing (e.g. Modify already pushed
                                          // ids before a later stage died) — show both.
                                          `${(r.report_data?.error || "failed").slice(0, 90)}${hasData ? " · " + summary(r.report_data) : ""}`
                                        : status === "running"
                                            ? `in progress…${hasData ? " · " + summary(r.report_data) : ""}`
                                            : summary(r.report_data)}
                                    {" · "}
                                    {r.provider || "—"} · {new Date(r.created_at).toLocaleString()}
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => onDelete(r.id)}
                                title="Delete this task"
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: 8,
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-tertiary)",
                                    padding: "8px 10px",
                                    cursor: "pointer",
                                    display: "grid",
                                    placeItems: "center",
                                }}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    );
                })}
            </div>
        </details>
    );
}
