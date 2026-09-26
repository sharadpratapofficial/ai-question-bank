"use client";

/**
 * Status workflow panel — current status pill + transition buttons gated by permission.
 * Submits to POST /api/questions/[id]/status.
 */
import React, { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useCurrentUser } from "@/context/UserProfileContext";
import {
    QUESTION_STATUS_LABELS,
    type QuestionStatus,
} from "@/types";
import type { Permission } from "@/lib/auth/permissions";
import QuestionStatusPill from "./QuestionStatusPill";

interface Action {
    to: QuestionStatus;
    label: string;
    perm: Permission;
    style: "primary" | "danger";
}

/** Map current status to the actions a user might take from here. */
function actionsForStatus(current: QuestionStatus): Action[] {
    const actions: Action[] = [];
    if (current === "verification_pending") {
        actions.push({ to: "verified", label: "Mark Verified (1st QC)", perm: "verify_qc1", style: "primary" });
    }
    if (current === "verified") {
        actions.push({ to: "double_verified", label: "Mark Double Verified (2nd QC)", perm: "verify_qc2", style: "primary" });
    }
    if (current === "double_verified") {
        actions.push({ to: "uat_passed", label: "Mark UAT Passed", perm: "verify_uat", style: "primary" });
    }
    if (current === "rejected") {
        actions.push({ to: "verification_pending", label: "Resubmit for Verification", perm: "submit_for_verification", style: "primary" });
    }
    if (current !== "rejected") {
        actions.push({ to: "rejected", label: "Reject", perm: "reject_question", style: "danger" });
    }
    return actions;
}

interface Props {
    questionId: string;
    status: QuestionStatus;
    onChanged?: (newStatus: QuestionStatus) => void;
}

export default function QuestionStatusPanel({ questionId, status, onChanged }: Props) {
    const { can, role, roleLabel, loading: permLoading } = useCurrentUser();
    const [note, setNote] = useState("");
    const [submitting, setSubmitting] = useState<QuestionStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState<string | null>(null);

    const availableActions = useMemo(() => actionsForStatus(status), [status]);
    const allowedActions = useMemo(
        () => availableActions.filter((a) => can(a.perm)),
        [availableActions, can]
    );

    async function transition(to: QuestionStatus) {
        setSubmitting(to);
        setError(null);
        setOk(null);
        try {
            const res = await fetch(`/api/questions/${questionId}/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to_status: to, note: note.trim() || undefined }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `status ${res.status}`);
            }
            setOk(`Status updated to ${QUESTION_STATUS_LABELS[to]}.`);
            setNote("");
            onChanged?.(to);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(null);
        }
    }

    return (
        <div style={{ display: "grid", gap: "16px" }}>
            <header
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "12px",
                    padding: "16px",
                    background: "var(--bg-secondary)",
                }}
            >
                <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", marginBottom: "6px" }}>
                    Current status
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <QuestionStatusPill status={status} />
                    <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                        You are signed in as <strong>{roleLabel}</strong> ({role}).
                    </span>
                </div>
            </header>

            <section
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "12px",
                    padding: "16px",
                    background: "var(--bg-secondary)",
                    display: "grid",
                    gap: "10px",
                }}
            >
                <div
                    style={{
                        fontSize: "0.82rem",
                        fontWeight: 700,
                        color: "var(--text-primary)",
                    }}
                >
                    Take action
                </div>

                <label style={{ display: "grid", gap: "5px" }}>
                    <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                        Optional note (visible in history)
                    </span>
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={2}
                        placeholder="Why are you changing the status? (optional)"
                        style={{
                            width: "100%",
                            borderRadius: "8px",
                            border: "1px solid var(--border-primary)",
                            background: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            fontSize: "0.82rem",
                            padding: "8px 10px",
                            outline: "none",
                            resize: "vertical",
                            minHeight: "40px",
                        }}
                    />
                </label>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                    {permLoading && (
                        <div style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
                            Loading your permissions…
                        </div>
                    )}
                    {!permLoading && allowedActions.length === 0 && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 12px",
                                borderRadius: "8px",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-tertiary)",
                                fontSize: "0.78rem",
                            }}
                        >
                            <AlertCircle size={14} />
                            <span>You don&apos;t have permission to change this status.</span>
                        </div>
                    )}
                    {!permLoading &&
                        allowedActions.map((action) => {
                            const isDanger = action.style === "danger";
                            const isBusy = submitting === action.to;
                            return (
                                <button
                                    key={action.to}
                                    type="button"
                                    onClick={() => transition(action.to)}
                                    disabled={isBusy || submitting !== null}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "8px 14px",
                                        borderRadius: "9px",
                                        border: `1px solid ${isDanger ? "#ef4444" : "var(--accent-primary, #818cf8)"}`,
                                        background: isDanger ? "#ef444415" : "var(--accent-primary, #818cf8)",
                                        color: isDanger ? "#ef4444" : "#fff",
                                        fontSize: "0.8rem",
                                        fontWeight: 700,
                                        cursor: isBusy ? "default" : "pointer",
                                        opacity: submitting && !isBusy ? 0.4 : 1,
                                    }}
                                >
                                    {isBusy ? <Loader2 size={14} className="animate-spin" /> : isDanger ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                                    {action.label}
                                </button>
                            );
                        })}
                </div>

                {ok && (
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
                        <span>{ok}</span>
                    </div>
                )}
                {error && (
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
                        <span>{error}</span>
                    </div>
                )}
            </section>
        </div>
    );
}
