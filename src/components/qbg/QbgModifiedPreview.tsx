"use client";

/**
 * Preview of reframed questions with a "Compare with original" panel.
 *
 * Lives here rather than inside QBG Modification because the QBG Pipeline runs
 * the very same reframe job (POST /api/ai-tools/qbg-modification) and gets the
 * same `records` / `originals` back — so both panels show one identical preview
 * instead of two drifting copies.
 *
 * `content`, option text and `solution` are question HTML produced by the
 * sidecar (mathconv.py) with figures already inlined as data: URLs — rendered,
 * not escaped, exactly as the modification panel has always done.
 */

import { CheckCircle2 } from "lucide-react";

export interface PreviewOption {
    isCorrect: boolean | null;
    text: string | null;
}
export interface PreviewRecord {
    content: string;
    options: PreviewOption[];
    solution: string;
    /** Set only for Numerical questions (no options) — the plain numeric answer. */
    answer?: string | null;
}
export interface PreviewOriginal {
    content: string;
    answer: string;
    solution: string;
}

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};

const optionLetter = (i: number) => "ABCD"[i] || String(i + 1);

export default function QbgModifiedPreview({
    records,
    originals,
    heading = "Preview — always spot-check the new answer key.",
}: {
    records: PreviewRecord[];
    originals?: PreviewOriginal[];
    heading?: string;
}) {
    if (!records || records.length === 0) return null;

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)" }}>{heading}</div>
            {records.map((rec, qi) => (
                <div key={qi} style={card}>
                    <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--accent-primary)", marginBottom: 6 }}>
                        Question {qi + 1}
                    </div>
                    <div
                        style={{ fontSize: "0.9rem", color: "var(--text-primary)" }}
                        dangerouslySetInnerHTML={{ __html: rec.content }}
                    />
                    <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
                        {rec.options
                            .filter((o) => o.text !== null)
                            .map((o, oi) => (
                                <div
                                    key={oi}
                                    style={{
                                        display: "flex",
                                        gap: 8,
                                        alignItems: "baseline",
                                        fontSize: "0.85rem",
                                        color: o.isCorrect ? "var(--accent-success)" : "var(--text-secondary)",
                                        fontWeight: o.isCorrect ? 700 : 400,
                                    }}
                                >
                                    <span>({optionLetter(oi)})</span>
                                    <span dangerouslySetInnerHTML={{ __html: o.text || "" }} />
                                    {o.isCorrect && <CheckCircle2 size={13} />}
                                </div>
                            ))}
                    </div>
                    {rec.solution && (
                        <details style={{ marginTop: 8 }}>
                            <summary style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", cursor: "pointer" }}>
                                Solution
                            </summary>
                            <div
                                style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: 4 }}
                                dangerouslySetInnerHTML={{ __html: rec.solution }}
                            />
                        </details>
                    )}
                    {(() => {
                        const orig = originals?.[qi];
                        if (!orig || (!orig.content && !orig.solution)) return null;
                        return (
                            <details
                                style={{
                                    marginTop: 8,
                                    borderLeft: "3px solid var(--border-accent)",
                                    paddingLeft: 10,
                                }}
                            >
                                <summary style={{ fontSize: "0.78rem", color: "var(--accent-primary)", cursor: "pointer", fontWeight: 600 }}>
                                    Compare with original
                                </summary>
                                <div style={{ marginTop: 6 }}>
                                    <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
                                        ORIGINAL QUESTION
                                    </div>
                                    <div
                                        style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 3 }}
                                        dangerouslySetInnerHTML={{ __html: orig.content }}
                                    />
                                    {orig.answer && (
                                        <div style={{ fontSize: "0.8rem", color: "var(--accent-success)", marginTop: 4 }}>
                                            Original answer: ({orig.answer})
                                        </div>
                                    )}
                                    {orig.solution && (
                                        <>
                                            <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.04em", marginTop: 8 }}>
                                                ORIGINAL SOLUTION
                                            </div>
                                            <div
                                                style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: 3 }}
                                                dangerouslySetInnerHTML={{ __html: orig.solution }}
                                            />
                                        </>
                                    )}
                                </div>
                            </details>
                        );
                    })()}
                </div>
            ))}
        </div>
    );
}
