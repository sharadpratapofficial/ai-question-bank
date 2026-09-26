"use client";

/**
 * Merged chronological timeline of:
 *   - status_transitions (workflow QC steps)
 *   - edit_history (full-row snapshots from every save)
 *
 * Admins can click "Restore" on an edit row to roll the question back to that
 * snapshot (status is preserved).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Loader2,
    Pencil,
    RefreshCw,
    RotateCcw,
    Sparkles,
} from "lucide-react";
import { useCurrentUser } from "@/context/UserProfileContext";
import {
    ROLE_LABELS,
    type UserRole,
} from "@/lib/auth/permissions";
import {
    QUESTION_STATUS_LABELS,
    type QuestionEditSnapshot,
    type QuestionStatusTransition,
} from "@/types";
import QuestionStatusPill from "./QuestionStatusPill";

type TimelineEntry =
    | { kind: "transition"; entry: QuestionStatusTransition }
    | { kind: "edit"; entry: QuestionEditSnapshot };

interface Props {
    questionId: string;
    /** Re-render trigger when the parent knows history may have changed (e.g. after a save). */
    refreshKey?: number;
    /** Called after a successful restore so the parent can re-fetch the question. */
    onRestored?: () => void;
}

export default function QuestionHistoryPanel({
    questionId,
    refreshKey,
    onRestored,
}: Props) {
    const { can } = useCurrentUser();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [transitions, setTransitions] = useState<QuestionStatusTransition[]>([]);
    const [edits, setEdits] = useState<QuestionEditSnapshot[]>([]);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [restoreError, setRestoreError] = useState<string | null>(null);
    const [restoreOk, setRestoreOk] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/questions/${questionId}/history`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
            setTransitions(data.status_transitions as QuestionStatusTransition[]);
            setEdits(data.edit_history as QuestionEditSnapshot[]);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [questionId]);

    useEffect(() => {
        load();
    }, [load, refreshKey]);

    const timeline = useMemo<TimelineEntry[]>(() => {
        const merged: TimelineEntry[] = [
            ...transitions.map((t) => ({ kind: "transition" as const, entry: t })),
            ...edits.map((e) => ({ kind: "edit" as const, entry: e })),
        ];
        merged.sort((a, b) => {
            const ta = new Date(a.entry.created_at).getTime();
            const tb = new Date(b.entry.created_at).getTime();
            return tb - ta; // newest first
        });
        return merged;
    }, [transitions, edits]);

    async function restore(snapshot: QuestionEditSnapshot) {
        setRestoreError(null);
        setRestoreOk(null);
        const note = window.prompt(
            `Restore this question to the version from ${formatDate(snapshot.created_at)}? (optional note)`,
            ""
        );
        if (note === null) return; // user cancelled

        setRestoringId(snapshot.id);
        try {
            const res = await fetch(
                `/api/questions/${questionId}/restore/${snapshot.id}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ note }),
                }
            );
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
            setRestoreOk("Question restored from history.");
            await load();
            onRestored?.();
        } catch (err) {
            setRestoreError(err instanceof Error ? err.message : String(err));
        } finally {
            setRestoringId(null);
        }
    }

    return (
        <div style={{ display: "grid", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
                    Timeline
                </h2>
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "9px",
                        background: "var(--bg-tertiary)",
                        color: "var(--text-secondary)",
                        padding: "6px 10px",
                        fontSize: "0.76rem",
                        fontWeight: 600,
                        cursor: loading ? "default" : "pointer",
                        opacity: loading ? 0.6 : 1,
                    }}
                >
                    <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
                    Refresh
                </button>
            </div>

            {restoreOk && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 12px",
                        borderRadius: "9px",
                        border: "1px solid #22c55e55",
                        background: "#22c55e10",
                        color: "#22c55e",
                        fontSize: "0.78rem",
                    }}
                >
                    <CheckCircle2 size={14} />
                    <span>{restoreOk}</span>
                </div>
            )}
            {restoreError && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 12px",
                        borderRadius: "9px",
                        border: "1px solid #ef444455",
                        background: "#ef444410",
                        color: "#ef4444",
                        fontSize: "0.78rem",
                    }}
                >
                    <AlertCircle size={14} />
                    <span>{restoreError}</span>
                </div>
            )}

            {loading && (
                <div
                    style={{
                        padding: "20px",
                        textAlign: "center",
                        color: "var(--text-tertiary)",
                        fontSize: "0.8rem",
                    }}
                >
                    Loading history…
                </div>
            )}
            {error && !loading && (
                <div
                    style={{
                        padding: "12px",
                        borderRadius: "9px",
                        border: "1px solid #ef444455",
                        background: "#ef444410",
                        color: "#ef4444",
                        fontSize: "0.8rem",
                    }}
                >
                    {error}
                </div>
            )}
            {!loading && !error && timeline.length === 0 && (
                <div
                    style={{
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--text-tertiary)",
                        fontSize: "0.8rem",
                        border: "1px dashed var(--border-primary)",
                        borderRadius: "10px",
                    }}
                >
                    No history yet — edits and status changes will appear here.
                </div>
            )}

            {!loading && timeline.length > 0 && (
                <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                    {timeline.map((item) => {
                        const e = item.entry;
                        const isEdit = item.kind === "edit";
                        const isExpanded = !!expanded[e.id];

                        if (item.kind === "transition") {
                            const t = item.entry;
                            return (
                                <li
                                    key={t.id}
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "20px 1fr",
                                        gap: "10px",
                                        padding: "10px 12px",
                                        borderRadius: "10px",
                                        background: "var(--bg-secondary)",
                                        border: "1px solid var(--border-primary)",
                                    }}
                                >
                                    <div style={{ paddingTop: "2px", color: "var(--accent-primary, #818cf8)" }}>
                                        <Sparkles size={14} />
                                    </div>
                                    <div>
                                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                                            <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                                                Status:
                                            </span>
                                            {t.from_status && <QuestionStatusPill status={t.from_status} short />}
                                            <span style={{ color: "var(--text-muted)" }}>→</span>
                                            <QuestionStatusPill status={t.to_status} short />
                                        </div>
                                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: "4px" }}>
                                            <ActorLabel
                                                email={t.actor_email}
                                                display_name={t.actor_display_name}
                                                role={t.actor_role}
                                            />
                                            <span> · {formatDate(t.created_at)}</span>
                                        </div>
                                        {t.note && (
                                            <div
                                                style={{
                                                    marginTop: "6px",
                                                    padding: "6px 10px",
                                                    borderRadius: "6px",
                                                    background: "var(--bg-tertiary)",
                                                    fontSize: "0.78rem",
                                                    color: "var(--text-primary)",
                                                    fontStyle: "italic",
                                                }}
                                            >
                                                “{t.note}”
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        }

                        // Edit snapshot
                        const s = item.entry;
                        const showRestore =
                            isEdit && can("restore_question_version") && s.change_type !== "create";
                        const changedCount = s.changed_fields?.filter((f) => !f.startsWith("__")).length ?? 0;

                        return (
                            <li
                                key={s.id}
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "20px 1fr",
                                    gap: "10px",
                                    padding: "10px 12px",
                                    borderRadius: "10px",
                                    background: "var(--bg-secondary)",
                                    border: "1px solid var(--border-primary)",
                                }}
                            >
                                <div style={{ paddingTop: "2px", color: "var(--text-tertiary)" }}>
                                    <Pencil size={14} />
                                </div>
                                <div>
                                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
                                        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                            {s.change_type === "create"
                                                ? "Created"
                                                : s.change_type === "restore"
                                                ? "Restored from earlier version"
                                                : changedCount > 0
                                                ? `Edited (${changedCount} field${changedCount === 1 ? "" : "s"})`
                                                : "Edited"}
                                        </span>
                                        {showRestore && (
                                            <button
                                                type="button"
                                                onClick={() => restore(s)}
                                                disabled={restoringId !== null}
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "5px",
                                                    border: "1px solid var(--accent-primary, #818cf8)",
                                                    borderRadius: "9px",
                                                    background: "transparent",
                                                    color: "var(--accent-primary, #818cf8)",
                                                    padding: "3px 8px",
                                                    fontSize: "0.7rem",
                                                    fontWeight: 700,
                                                    cursor: restoringId === s.id ? "default" : "pointer",
                                                    opacity: restoringId && restoringId !== s.id ? 0.4 : 1,
                                                }}
                                            >
                                                {restoringId === s.id ? (
                                                    <Loader2 size={12} className="animate-spin" />
                                                ) : (
                                                    <RotateCcw size={12} />
                                                )}
                                                Restore
                                            </button>
                                        )}
                                    </div>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", marginTop: "4px" }}>
                                        <ActorLabel
                                            email={s.editor_email}
                                            display_name={s.editor_display_name}
                                            role={s.editor_role}
                                        />
                                        <span> · {formatDate(s.created_at)}</span>
                                    </div>
                                    {changedCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setExpanded((p) => ({ ...p, [s.id]: !p[s.id] }))
                                            }
                                            style={{
                                                marginTop: "6px",
                                                background: "transparent",
                                                border: "none",
                                                padding: 0,
                                                color: "var(--text-secondary)",
                                                fontSize: "0.74rem",
                                                cursor: "pointer",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "4px",
                                            }}
                                        >
                                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                            {isExpanded ? "Hide" : "Show"} changed fields
                                        </button>
                                    )}
                                    {isExpanded && (
                                        <div
                                            style={{
                                                marginTop: "6px",
                                                padding: "8px 10px",
                                                borderRadius: "6px",
                                                background: "var(--bg-tertiary)",
                                                fontSize: "0.74rem",
                                                color: "var(--text-secondary)",
                                                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                            }}
                                        >
                                            {(s.changed_fields ?? [])
                                                .filter((f) => !f.startsWith("__"))
                                                .map((f) => (
                                                    <div key={f}>· {f}</div>
                                                ))}
                                            {(s.changed_fields ?? [])
                                                .filter((f) => f.startsWith("__restore_note__:"))
                                                .map((f) => (
                                                    <div
                                                        key={f}
                                                        style={{
                                                            marginTop: "6px",
                                                            fontStyle: "italic",
                                                            color: "var(--text-primary)",
                                                        }}
                                                    >
                                                        Note: {f.replace("__restore_note__:", "")}
                                                    </div>
                                                ))}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}

function ActorLabel({
    email,
    display_name,
    role,
}: {
    email: string | null;
    display_name: string | null;
    role: UserRole | null;
}) {
    const name = display_name || email || "(unknown user)";
    const roleStr = role ? ROLE_LABELS[role] : null;
    return (
        <span>
            <strong style={{ color: "var(--text-secondary)" }}>{name}</strong>
            {roleStr && (
                <span
                    style={{
                        marginLeft: "6px",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: "var(--bg-tertiary)",
                        color: "var(--text-tertiary)",
                        fontSize: "0.66rem",
                        fontWeight: 600,
                    }}
                >
                    {roleStr}
                </span>
            )}
        </span>
    );
}

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}
