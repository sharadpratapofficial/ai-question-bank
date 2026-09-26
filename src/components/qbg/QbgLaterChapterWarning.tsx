"use client";

import { AlertCircle, Copy } from "lucide-react";
import type { LaterChapterUseItem } from "@/lib/qbgSyllabus";

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

/**
 * Questions whose solution reaches into a chapter the student has not been
 * taught yet (see findLaterChapterUse in src/lib/qbgSyllabus.ts).
 *
 * Shown after tagging, because tagging is when we first learn what each question
 * depends on. By then the question is already in QBG, so this lists the ids to
 * open and fix, rather than a verdict nobody can act on.
 */
export default function QbgLaterChapterWarning({
    items,
    cardStyle,
    scopeLabel,
}: {
    items: LaterChapterUseItem[];
    cardStyle: React.CSSProperties;
    /** What "allowed" was measured against — shown so the user knows the rule. */
    scopeLabel: string;
}) {
    if (items.length === 0) return null;

    // Grouped by the later chapter each question needs, most-hit first.
    const byLater = new Map<string, LaterChapterUseItem[]>();
    for (const it of items) {
        for (const later of it.laterChapters) {
            const key = `${it.subject}||${later}`;
            byLater.set(key, [...(byLater.get(key) || []), it]);
        }
    }
    const groups = [...byLater.entries()].sort((a, b) => b[1].length - a[1].length);

    return (
        <div
            style={{
                ...cardStyle,
                display: "grid",
                gap: 8,
                border: "1px solid rgba(var(--accent-warning-rgb),0.45)",
                background: "rgba(var(--accent-warning-rgb),0.08)",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: "0.85rem", color: "var(--accent-warning)" }}>
                <AlertCircle size={15} />
                {items.length} question(s) use a LATER chapter than {scopeLabel}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                Their tagged chapter may look right, but the solution relies on a concept from a
                chapter that comes later in the book — a student at this point has not been taught it.
                Earlier chapters are fine. These are already in QBG: open each one and rework or drop it.
            </div>
            {groups.map(([key, qs]) => {
                const [subject, later] = key.split("||");
                return (
                    <div key={key} style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                            Needs {later}
                            {subject ? ` · ${subject}` : ""} — {qs.length} question(s)
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {qs.map((q) => (
                                <a
                                    key={q.qbgId}
                                    href={QUESTION_URL + encodeURIComponent(q.qbgId)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`Tagged under ${q.chapter}`}
                                    style={{
                                        fontFamily: "ui-monospace, monospace",
                                        fontSize: "0.72rem",
                                        color: "var(--accent-primary)",
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: 7,
                                        padding: "2px 7px",
                                        background: "var(--bg-tertiary)",
                                    }}
                                >
                                    {q.qbgId}
                                </a>
                            ))}
                        </div>
                    </div>
                );
            })}
            <button
                type="button"
                onClick={() => {
                    void navigator.clipboard?.writeText(items.map((i) => i.qbgId).join("\n")).catch(() => undefined);
                }}
                style={{
                    justifySelf: "start",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    border: "1px solid var(--border-primary)",
                    borderRadius: 8,
                    background: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    padding: "6px 12px",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                }}
            >
                <Copy size={13} /> Copy the {items.length} flagged ID(s)
            </button>
        </div>
    );
}
