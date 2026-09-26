"use client";

import React, { useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Globe, Loader2, ShieldCheck, X } from "lucide-react";
import { useQuestionTaskQueue, type QuestionTask } from "@/context/QuestionTaskQueueContext";

const KIND_LABEL: Record<QuestionTask["kind"], string> = {
    translate: "Translate question",
    verify: "Verify question",
    test_translate: "Translate test",
    test_verify: "Verify test",
};

function kindIcon(kind: QuestionTask["kind"], color?: string) {
    if (kind === "translate" || kind === "test_translate") return <Globe size={12} color={color} />;
    return <ShieldCheck size={12} color={color} />;
}

function statusIcon(status: QuestionTask["status"]) {
    if (status === "running") return <Loader2 size={12} className="animate-spin" color="#818cf8" />;
    if (status === "done") return <CheckCircle2 size={12} color="#22c55e" />;
    return <AlertCircle size={12} color="#ef4444" />;
}

/**
 * Bottom-left floating widget that summarises in-flight per-question
 * translate/verify tasks. Mounted globally so the user can leave the edit
 * modal and still see progress.
 *
 * We render bottom-LEFT to avoid colliding with AIJobNotifier (bottom-right).
 */
export default function QuestionTaskNotifier() {
    const { tasks, dismiss, runningCount } = useQuestionTaskQueue();
    const [collapsed, setCollapsed] = useState(false);

    if (tasks.length === 0) return null;

    const doneCount = tasks.filter((t) => t.status === "done").length;
    const errorCount = tasks.filter((t) => t.status === "error").length;

    const summary = runningCount > 0
        ? `Working on ${runningCount} question task${runningCount > 1 ? "s" : ""}…`
        : errorCount > 0
            ? `${errorCount} task${errorCount > 1 ? "s" : ""} failed`
            : `${doneCount} task${doneCount > 1 ? "s" : ""} ready`;

    const summaryColor = runningCount > 0
        ? "#818cf8"
        : errorCount > 0
            ? "#ef4444"
            : "#22c55e";

    return (
        <div
            style={{
                position: "fixed",
                bottom: "20px",
                left: "20px",
                zIndex: 9998,
                display: "grid",
                gap: 0,
                maxWidth: "360px",
                width: "100%",
            }}
        >
            {!collapsed && (
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
                    {tasks.map((t) => {
                        const color = t.status === "done"
                            ? "#22c55e"
                            : t.status === "error"
                                ? "#ef4444"
                                : "#818cf8";
                        return (
                            <div
                                key={t.id}
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
                                {statusIcon(t.status)}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            fontWeight: 600,
                                            color: "var(--text-primary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                        title={t.label}
                                    >
                                        {kindIcon(t.kind, color)}
                                        <span style={{ color }}>{KIND_LABEL[t.kind]}</span>
                                        <span style={{ color: "var(--text-secondary)" }}>· {t.label}</span>
                                    </div>
                                    <div
                                        style={{
                                            fontSize: "0.68rem",
                                            color: "var(--text-muted)",
                                            marginTop: "2px",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {t.detail}
                                    </div>
                                    {t.status === "error" && t.error && (
                                        <div
                                            style={{
                                                fontSize: "0.68rem",
                                                color: "#ef4444",
                                                marginTop: "2px",
                                                whiteSpace: "normal",
                                            }}
                                        >
                                            {t.error.slice(0, 140)}
                                        </div>
                                    )}
                                </div>
                                {t.status !== "running" && (
                                    <button
                                        type="button"
                                        onClick={() => dismiss(t.id)}
                                        style={{
                                            background: "none",
                                            border: "none",
                                            color: "var(--text-muted)",
                                            cursor: "pointer",
                                            padding: "2px",
                                            flexShrink: 0,
                                        }}
                                        title="Dismiss"
                                    >
                                        <X size={12} />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <button
                type="button"
                onClick={() => setCollapsed((prev) => !prev)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 14px",
                    borderRadius: collapsed ? "12px" : "0 0 12px 12px",
                    border: `1px solid ${summaryColor}33`,
                    background: `${summaryColor}15`,
                    backdropFilter: "blur(12px)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                    cursor: "pointer",
                    color: summaryColor,
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    width: "100%",
                    textAlign: "left",
                }}
            >
                {runningCount > 0 ? (
                    <Loader2 size={14} className="animate-spin" />
                ) : errorCount > 0 ? (
                    <AlertCircle size={14} />
                ) : (
                    <CheckCircle2 size={14} />
                )}
                <span style={{ flex: 1 }}>{summary}</span>
                {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
        </div>
    );
}
