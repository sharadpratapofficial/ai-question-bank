"use client";

import { useMemo, useState } from "react";
import { Upload } from "lucide-react";

/**
 * "Pushed to QBG" — the ids a push minted, in a form that can actually be
 * pasted somewhere.
 *
 * The per-question list below is for reading (it shows which question failed);
 * selecting it to copy dragged the "Q1"/"Q2" labels along with the ids, which is
 * not what anyone wants in a spreadsheet (2026-09-06 report). The box at the top
 * is the copyable form, and it can carry the question links too — tab-separated,
 * so it lands in Excel as two columns with the URL live.
 *
 * Shared by QBG Ingestion and QBG Modification, which had two copies of this
 * block that were already drifting apart.
 */

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

export interface PushedRow {
    num: number | string;
    unique_id: string | null;
    ok: boolean;
    error?: string;
}

type Shape = "both" | "ids" | "links";

const SHAPES: { key: Shape; label: string; hint: string }[] = [
    { key: "both", label: "ID + link", hint: "two columns in Excel — the id, then its question link" },
    { key: "ids", label: "IDs only", hint: "one unique_id per line" },
    { key: "links", label: "Links only", hint: "one question link per line" },
];

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* falls through to the textarea method below */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

export default function QbgPushedIds({
    results,
    cardStyle,
}: {
    results: PushedRow[];
    /** The host panel's card style, so this looks native in both panels. */
    cardStyle: React.CSSProperties;
}) {
    const [shape, setShape] = useState<Shape>("both");
    const [copied, setCopied] = useState(false);

    const okIds = useMemo(
        () => results.filter((r) => r.ok && r.unique_id).map((r) => r.unique_id as string),
        [results]
    );

    const text = useMemo(() => {
        if (shape === "ids") return okIds.join("\n");
        if (shape === "links") return okIds.map((id) => QUESTION_URL + encodeURIComponent(id)).join("\n");
        return okIds.map((id) => `${id}\t${QUESTION_URL + encodeURIComponent(id)}`).join("\n");
    }, [okIds, shape]);

    if (results.length === 0) return null;
    const succeeded = results.filter((r) => r.ok).length;
    const hint = SHAPES.find((s) => s.key === shape)?.hint || "";

    return (
        <div style={{ ...cardStyle, padding: "12px 14px" }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontWeight: 700,
                    fontSize: "0.82rem",
                    color: "var(--text-primary)",
                    marginBottom: 8,
                }}
            >
                <Upload size={14} color="var(--accent-primary)" />
                Pushed to QBG — {succeeded} of {results.length} succeeded
            </div>

            {okIds.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                            marginBottom: 5,
                        }}
                    >
                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            {okIds.length} question(s) — {hint}
                        </span>
                        <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
                            {SHAPES.map((s) => (
                                <button
                                    key={s.key}
                                    type="button"
                                    onClick={() => setShape(s.key)}
                                    style={{
                                        border:
                                            shape === s.key
                                                ? "1px solid var(--border-accent)"
                                                : "1px solid var(--border-primary)",
                                        borderRadius: 7,
                                        background: shape === s.key ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                        color: shape === s.key ? "var(--text-primary)" : "var(--text-tertiary)",
                                        fontSize: "0.72rem",
                                        fontWeight: shape === s.key ? 600 : 500,
                                        padding: "3px 9px",
                                        cursor: "pointer",
                                    }}
                                >
                                    {s.label}
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={async () => {
                                    if (await copyText(text)) {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1500);
                                    }
                                }}
                                style={{
                                    border: "1px solid var(--border-accent)",
                                    borderRadius: 7,
                                    background: copied
                                        ? "rgba(var(--accent-success-rgb),0.15)"
                                        : "var(--bg-secondary)",
                                    color: copied ? "var(--accent-success)" : "var(--text-primary)",
                                    fontSize: "0.74rem",
                                    fontWeight: 600,
                                    padding: "4px 10px",
                                    cursor: "pointer",
                                }}
                            >
                                {copied ? "Copied!" : "Copy"}
                            </button>
                        </span>
                    </div>
                    <textarea
                        readOnly
                        value={text}
                        onFocus={(e) => e.currentTarget.select()}
                        rows={Math.min(Math.max(okIds.length, 2), 8)}
                        style={{
                            width: "100%",
                            borderRadius: 8,
                            border: "1px solid var(--border-primary)",
                            background: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            fontFamily: "ui-monospace, monospace",
                            fontSize: "0.76rem",
                            padding: "8px 10px",
                            resize: "vertical",
                            whiteSpace: "pre",
                        }}
                    />
                </div>
            )}

            {/* Per-question view: for reading, not for copying — which is why the
                box above exists. */}
            <div style={{ display: "grid", gap: 3 }}>
                {results.map((r, i) => (
                    <div
                        key={`${r.num}-${i}`}
                        style={{ fontSize: "0.78rem", display: "flex", gap: 8, alignItems: "center" }}
                    >
                        <span style={{ color: "var(--text-tertiary)", minWidth: 34 }}>Q{r.num}</span>
                        {r.ok && r.unique_id ? (
                            <a
                                href={QUESTION_URL + encodeURIComponent(r.unique_id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontFamily: "ui-monospace, monospace", color: "var(--accent-primary)" }}
                            >
                                {r.unique_id}
                            </a>
                        ) : (
                            <span style={{ color: "var(--accent-danger)" }}>
                                failed{r.error ? `: ${r.error}` : ""}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
