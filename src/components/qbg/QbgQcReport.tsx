"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, ShieldCheck } from "lucide-react";
import type { QcResult, QcSummary } from "@/lib/api/qbgModification";

/**
 * What QC found, and what it changed.
 *
 * The before/after is the whole point: a QC pass that silently rewrites
 * questions is impossible to trust or to test. Every changed field is shown as
 * it was and as it now is, so a run can be inspected for whether the model
 * actually did anything — and whether what it did was right.
 */

function partsToText(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        // A parts list, or a list of option parts lists.
        return value
            .map((p) => {
                if (Array.isArray(p)) return partsToText(p);
                if (p && typeof p === "object") {
                    const o = p as Record<string, unknown>;
                    if ("t" in o) return String(o.t);
                    if ("m" in o) return `$${String(o.m)}$`;
                    if ("img" in o) return `[image: ${String(o.img)}]`;
                    if ("h" in o) return "[markup]";
                }
                return String(p);
            })
            .join(Array.isArray(value[0]) ? "\n" : " ");
    }
    return String(value);
}

const SEVERITY_COLOR: Record<string, string> = {
    MAJOR: "var(--accent-danger)",
    MODERATE: "var(--accent-warning)",
    MINOR: "var(--text-tertiary)",
};

export default function QbgQcReport({
    results,
    summary,
    cardStyle,
}: {
    results: QcResult[];
    summary?: QcSummary;
    cardStyle: React.CSSProperties;
}) {
    const [showClean, setShowClean] = useState(false);
    if (!results || results.length === 0) return null;

    const changed = results.filter((r) => r.status === "changed");
    const failed = results.filter((r) => r.status === "failed");
    const clean = results.filter((r) => r.status === "clean");
    const sawFigure = results.filter((r) => r.saw_figure).length;
    const shown = showClean ? results : results.filter((r) => r.status !== "clean");

    return (
        <div style={{ ...cardStyle, padding: "12px 14px", display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <ShieldCheck size={15} color="var(--accent-primary)" />
                <span style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-primary)" }}>
                    QC before push — {changed.length} of {summary?.checked ?? results.length} question(s) corrected
                </span>
                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    {clean.length} clean
                    {failed.length > 0 ? ` · ${failed.length} could not be checked` : ""}
                    {` · ${sawFigure} checked with their figure`}
                </span>
                {clean.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowClean((v) => !v)}
                        style={{
                            marginLeft: "auto",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            border: "1px solid var(--border-primary)",
                            borderRadius: 7,
                            background: "var(--bg-tertiary)",
                            color: "var(--text-secondary)",
                            fontSize: "0.72rem",
                            padding: "3px 9px",
                            cursor: "pointer",
                        }}
                    >
                        {showClean ? <EyeOff size={12} /> : <Eye size={12} />}
                        {showClean ? "Hide clean questions" : "Show clean questions"}
                    </button>
                )}
            </div>

            {sawFigure === 0 && results.length > 0 && (
                <div style={{ fontSize: "0.74rem", color: "var(--accent-warning)" }}>
                    No question was checked with its figure — either none had one, or the QC model
                    could not be sent images. A diagram that contradicts its question cannot be
                    caught this way; choose a model marked &ldquo;reads diagrams&rdquo;.
                </div>
            )}

            <div style={{ display: "grid", gap: 8 }}>
                {shown.map((r, i) => {
                    const isChanged = r.status === "changed";
                    const isFailed = r.status === "failed";
                    return (
                        <div
                            key={`${r.num}-${i}`}
                            style={{
                                border: "1px solid var(--border-secondary)",
                                borderRadius: 9,
                                padding: "8px 10px",
                                background: isChanged
                                    ? "rgba(var(--accent-warning-rgb),0.06)"
                                    : "var(--bg-tertiary)",
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                                {isFailed ? (
                                    <AlertCircle size={13} color="var(--accent-danger)" />
                                ) : isChanged ? (
                                    <AlertCircle size={13} color="var(--accent-warning)" />
                                ) : (
                                    <CheckCircle2 size={13} color="var(--accent-success)" />
                                )}
                                <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                    Q{r.num}
                                </span>
                                {r.verdict && (
                                    <span
                                        style={{
                                            fontSize: "0.7rem",
                                            fontWeight: 700,
                                            color: SEVERITY_COLOR[r.verdict.toUpperCase()] || "var(--text-tertiary)",
                                        }}
                                    >
                                        {r.verdict}
                                    </span>
                                )}
                                {typeof r.confidence === "number" && (
                                    <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                        {r.confidence}% confident
                                    </span>
                                )}
                                <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                    {r.saw_figure ? "figure read" : "no figure"}
                                </span>
                                {isChanged && (r.changed_fields || []).length > 0 && (
                                    <span style={{ fontSize: "0.7rem", color: "var(--accent-warning)", fontWeight: 600 }}>
                                        changed: {(r.changed_fields || []).join(", ")}
                                    </span>
                                )}
                                {isFailed && (
                                    <span style={{ fontSize: "0.72rem", color: "var(--accent-danger)" }}>
                                        not checked — left exactly as it was{r.detail ? `: ${r.detail}` : ""}
                                    </span>
                                )}
                            </div>

                            {(r.defects || []).length > 0 && (
                                <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 3 }}>
                                    {(r.defects || []).map((d, di) => (
                                        <li key={di} style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                                            <b style={{ color: SEVERITY_COLOR[(d.severity || "").toUpperCase()] || "var(--text-secondary)" }}>
                                                {d.category}
                                                {d.severity ? ` · ${d.severity}` : ""}
                                            </b>
                                            {d.evidence ? ` — ${d.evidence}` : ""}
                                            {d.fix ? (
                                                <span style={{ color: "var(--text-tertiary)" }}> → {d.fix}</span>
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {r.fig_edit && (
                                <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    <b>Diagram redraw asked for:</b> {r.fig_edit}
                                </div>
                            )}

                            {isChanged && r.before && r.after && (
                                <details style={{ marginTop: 7 }}>
                                    <summary style={{ cursor: "pointer", fontSize: "0.74rem", color: "var(--accent-primary)" }}>
                                        Compare before and after
                                    </summary>
                                    <div style={{ display: "grid", gap: 8, marginTop: 7 }}>
                                        {(r.changed_fields || [])
                                            .filter((f) => f !== "figure")
                                            .map((field) => (
                                                <div
                                                    key={field}
                                                    style={{
                                                        display: "grid",
                                                        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                                                        gap: 8,
                                                    }}
                                                >
                                                    <div>
                                                        <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 3 }}>
                                                            {field} — before QC
                                                        </div>
                                                        <div style={diffBox("var(--accent-danger-rgb)")}>
                                                            {partsToText((r.before as Record<string, unknown>)[field]) || "(empty)"}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 3 }}>
                                                            {field} — after QC
                                                        </div>
                                                        <div style={diffBox("var(--accent-success-rgb)")}>
                                                            {partsToText((r.after as Record<string, unknown>)[field]) || "(empty)"}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        {r.solved?.working && (
                                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                <b>QC solved it itself as</b> {r.solved.answer || "?"} — {r.solved.working}
                                            </div>
                                        )}
                                    </div>
                                </details>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function diffBox(rgbVar: string): React.CSSProperties {
    return {
        border: `1px solid rgba(${rgbVar},0.3)`,
        background: `rgba(${rgbVar},0.06)`,
        borderRadius: 7,
        padding: "6px 8px",
        fontSize: "0.74rem",
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        maxHeight: 220,
        overflow: "auto",
    };
}
