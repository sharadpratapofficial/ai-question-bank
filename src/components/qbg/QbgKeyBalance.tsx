"use client";

import { Shuffle, AlertTriangle } from "lucide-react";
import type { KeyBalanceReport } from "@/lib/api/qbgModification";

/**
 * What the answer-key balancer did.
 *
 * Shown because the change is invisible in the questions themselves — the same
 * options, the same answer, in a different order — so the only way to see it
 * worked is the distribution before and after.
 */
export default function QbgKeyBalance({
    report,
    cardStyle,
}: {
    report: KeyBalanceReport;
    cardStyle: React.CSSProperties;
}) {
    const moved = report.moved || [];
    const skipped = report.skipped || [];
    const before = report.before?.counts || {};
    const after = report.after?.counts || {};
    const residual = report.residual_runs || [];
    const letters = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    if (letters.length === 0) return null;

    // A numeric ladder is listed as "not freely shuffled" yet still moves — it gets
    // reversed. Only the ones that truly did not move belong under "left as they were".
    const movedNums = new Set(moved.map((m) => String(m.num)));
    const leftAlone = skipped.filter((s) => !movedNums.has(String(s.num)));

    const total = Object.values(after).reduce((s, n) => s + n, 0);
    const ideal = letters.length > 0 ? total / letters.length : 0;

    return (
        <div style={{ ...cardStyle, padding: "12px 14px", display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <Shuffle size={14} color="var(--accent-primary)" />
                <span style={{ fontWeight: 700, fontSize: "0.82rem", color: "var(--text-primary)" }}>
                    Answer key — {moved.length === 0 ? "already balanced" : `${moved.length} question(s) reordered`}
                </span>
                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    longest run of the same option: {report.before?.longest_run ?? "?"} →{" "}
                    <b style={{ color: (report.after?.longest_run ?? 9) > 1 ? "var(--accent-warning)" : "var(--accent-success)" }}>
                        {report.after?.longest_run ?? "?"}
                    </b>
                </span>
            </div>

            {residual.length > 0 && (
                <div
                    style={{
                        display: "grid",
                        gap: 5,
                        padding: "9px 11px",
                        borderRadius: 8,
                        border: "1px solid var(--accent-warning)",
                        background: "color-mix(in srgb, var(--accent-warning) 10%, transparent)",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <AlertTriangle size={13} color="var(--accent-warning)" />
                        <span style={{ fontWeight: 700, fontSize: "0.78rem", color: "var(--text-primary)" }}>
                            Still {residual.length === 1 ? "a run" : `${residual.length} runs`} of the same
                            answer
                        </span>
                    </div>
                    {residual.map((r, i) => (
                        <div key={i} style={{ fontSize: "0.74rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
                            <b>
                                {r.length} in a row answer ({r.letter})
                            </b>
                            {" — "}
                            {r.nums.map((n) => `Q${n}`).join(", ")}
                            {r.unavoidable && (
                                <span style={{ color: "var(--text-tertiary)" }}>
                                    {" "}
                                    · their options cannot be reordered far enough to break the run, so
                                    this needs a content change, not a reshuffle
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {letters.map((l) => {
                    const b = before[l] || 0;
                    const a = after[l] || 0;
                    const off = ideal > 0 && Math.abs(a - ideal) > Math.max(1, ideal * 0.5);
                    return (
                        <span key={l} style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                            <b>{l}</b>{" "}
                            <span style={{ color: "var(--text-tertiary)" }}>{b}</span>
                            {" → "}
                            <b style={{ color: off ? "var(--accent-warning)" : "var(--accent-success)" }}>{a}</b>
                        </span>
                    );
                })}
                {total > 0 && (
                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        (an even split would be about {ideal.toFixed(1)} each)
                    </span>
                )}
            </div>

            {moved.length > 0 && (
                <details>
                    <summary style={{ cursor: "pointer", fontSize: "0.74rem", color: "var(--accent-primary)" }}>
                        Which questions moved
                    </summary>
                    <div style={{ marginTop: 6, fontSize: "0.74rem", color: "var(--text-secondary)", lineHeight: 1.7 }}>
                        {moved.map((m, i) => (
                            <span key={i} style={{ marginRight: 12, whiteSpace: "nowrap" }}>
                                Q{m.num}: {m.from} → <b>{m.to}</b>
                                {m.tier === "mirror" && (
                                    <span style={{ color: "var(--text-tertiary)" }} title="ladder reversed">
                                        {" ⇅"}
                                    </span>
                                )}
                            </span>
                        ))}
                    </div>
                    <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        Only the ORDER of the options changed — the same options, the same correct
                        answer, printed in a different position. A ⇅ marks a numeric ladder that was
                        reversed end to end rather than shuffled, so it stays a ladder.
                    </div>
                </details>
            )}

            {leftAlone.length > 0 && (
                <details>
                    <summary style={{ cursor: "pointer", fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                        {leftAlone.length} question(s) left as they were
                    </summary>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: "0.73rem", color: "var(--text-tertiary)" }}>
                        {leftAlone.map((sk, i) => (
                            <li key={i}>
                                Q{sk.num} — {sk.reason}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}
