"use client";

import { Loader2 } from "lucide-react";

export interface ProgressEvent {
    stage: string;
    msg: string;
    done?: number;
    total?: number;
    at?: string;
}

/**
 * Live progress panel for a running QBG job. Shows the current stage/message with
 * a spinner, a progress bar when the stage reports done/total, and a scrolling log
 * of recent events — fed by the `progress` array the poll GET returns while running.
 */
export default function QbgProgressLog({ progress }: { progress: ProgressEvent[] }) {
    const latest = progress.length > 0 ? progress[progress.length - 1] : null;
    const pct =
        latest && typeof latest.done === "number" && typeof latest.total === "number" && latest.total > 0
            ? Math.round((latest.done / latest.total) * 100)
            : null;
    // Show the last ~8 events, newest first.
    const recent = progress.slice(-8).reverse();

    return (
        <div
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: 12,
                background: "var(--bg-secondary)",
                padding: 14,
                display: "grid",
                gap: 10,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Loader2 size={15} className="animate-spin" color="var(--accent-primary)" />
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                    {latest ? latest.msg : "Starting…"}
                </span>
                {pct !== null && (
                    <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
                        {latest?.done}/{latest?.total}
                    </span>
                )}
            </div>

            {pct !== null && (
                <div style={{ height: 6, borderRadius: 999, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                    <div
                        style={{
                            width: `${pct}%`,
                            height: "100%",
                            borderRadius: 999,
                            background: "linear-gradient(90deg,#6366f1,#8b5cf6)",
                            transition: "width 0.4s ease",
                        }}
                    />
                </div>
            )}

            {recent.length > 1 && (
                <div
                    style={{
                        display: "grid",
                        gap: 3,
                        maxHeight: 132,
                        overflowY: "auto",
                        fontSize: "0.74rem",
                        color: "var(--text-tertiary)",
                        fontFamily: "ui-monospace, monospace",
                        borderTop: "1px dashed var(--border-primary)",
                        paddingTop: 8,
                    }}
                >
                    {recent.map((e, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, opacity: i === 0 ? 1 : 0.65 }}>
                            <span style={{ color: "var(--accent-primary)", minWidth: 58 }}>[{e.stage}]</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.msg}</span>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                Live status — this can take several minutes on large papers or slow models. You can leave this
                page; it keeps running and the finished run appears under history.
            </div>
        </div>
    );
}
