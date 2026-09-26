"use client";

/**
 * Admin → Chapters. Finds chapters that are the same thing under different
 * spellings and merges them, so a split chapter can be fixed without a DB query.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Layers, Loader2, RefreshCw, Search } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";

interface ChapterRow {
    subject: string | null;
    chapter: string;
    classLevels: string[];
    pool: number;
    questions: number;
    total: number;
}
interface DuplicateGroup {
    key: string;
    subject: string | null;
    variants: ChapterRow[];
    total: number;
}

export default function AdminChaptersPage() {
    return (
        <RequirePermission permission="manage_users">
            <Inner />
        </RequirePermission>
    );
}

function Inner() {
    const router = useRouter();
    const [chapters, setChapters] = useState<ChapterRow[]>([]);
    const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [search, setSearch] = useState("");
    /** Chosen canonical spelling per duplicate group. */
    const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/chapters", { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
            setChapters(data.chapters as ChapterRow[]);
            setDuplicates(data.duplicates as DuplicateGroup[]);
        } catch (err) {
            setFlash({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const merge = useCallback(
        async (group: DuplicateGroup, keep: string) => {
            const from = group.variants.map((v) => v.chapter).filter((c) => c !== keep);
            if (from.length === 0) return;
            setBusyKey(group.key);
            setFlash(null);
            try {
                const res = await fetch("/api/admin/chapters", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ from, to: keep, subject: group.subject }),
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
                setFlash({
                    kind: "ok",
                    text: `Merged ${from.length} spelling${from.length > 1 ? "s" : ""} into “${keep}” — ${data.totalRows} question${data.totalRows === 1 ? "" : "s"} updated.`,
                });
                await load();
            } catch (err) {
                setFlash({ kind: "err", text: err instanceof Error ? err.message : String(err) });
            } finally {
                setBusyKey(null);
            }
        },
        [load]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return chapters;
        return chapters.filter(
            (c) => c.chapter.toLowerCase().includes(q) || (c.subject || "").toLowerCase().includes(q)
        );
    }, [chapters, search]);

    const card: React.CSSProperties = {
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-primary)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 14,
    };
    const btn: React.CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 12px",
        borderRadius: 9,
        border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        color: "var(--text-primary)",
        fontSize: "0.8rem",
        fontWeight: 600,
        cursor: "pointer",
    };

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar
                activeTab="admin"
                onTabChange={(t) => {
                    if (t === "questions") router.push("/questions");
                    else if (t === "tests") router.push("/tests");
                    else if (t === "analytics") router.push("/analytics");
                    else if (t === "upload") router.push("/upload");
                    else if (t === "ai") router.push("/ai-tools");
                    else if (t === "agentic-qc") router.push("/agentic-qc");
                    else if (t === "qbg") router.push("/qbg");
                    else if (t === "video-solution") router.push("/video-solution");
                    else if (t === "question-wise-videos") router.push("/question-wise-videos");
                    else if (t === "circuit-designer") router.push("/circuit-designer");
                    else if (t === "admin") router.push("/admin/users");
                }}
            />

            <main style={{ flex: 1, padding: "28px 32px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                    <div
                        style={{
                            width: 40, height: 40, borderRadius: 11,
                            background: "linear-gradient(135deg,#0ea5e9,#6366f1)",
                            display: "grid", placeItems: "center", color: "#fff",
                        }}
                    >
                        <Layers size={20} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800, color: "var(--text-primary)" }}>
                            Chapters
                        </h1>
                        <p style={{ margin: "2px 0 0", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                            Merge chapters that are the same thing spelled differently.
                        </p>
                    </div>
                    <button type="button" style={btn} onClick={() => void load()} disabled={loading}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "12px 0 16px" }}>
                    <button type="button" style={btn} onClick={() => router.push("/admin/users")}>
                        Users
                    </button>
                    <span style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
                        {chapters.length} chapters · {duplicates.length} needing attention
                    </span>
                </div>

                {flash && (
                    <div
                        style={{
                            ...card,
                            display: "flex", alignItems: "center", gap: 9, marginBottom: 14,
                            borderColor: flash.kind === "ok" ? "var(--accent-success)" : "var(--accent-danger)",
                            color: flash.kind === "ok" ? "var(--accent-success)" : "var(--accent-danger)",
                            fontSize: "0.85rem",
                        }}
                    >
                        {flash.kind === "ok" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                        {flash.text}
                    </div>
                )}

                {loading && (
                    <div style={{ ...card, display: "flex", alignItems: "center", gap: 9, color: "var(--text-tertiary)" }}>
                        <Loader2 size={15} className="spin" /> Scanning chapters…
                    </div>
                )}

                {!loading && duplicates.length === 0 && (
                    <div style={{ ...card, color: "var(--accent-success)", fontSize: "0.88rem" }}>
                        No duplicate chapters — every chapter has a single spelling.
                    </div>
                )}

                {duplicates.map((g) => {
                    const suggested = g.variants[0].chapter;
                    const keep = keepChoice[g.key] || suggested;
                    return (
                        <div key={g.key} style={card}>
                            <div style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginBottom: 8 }}>
                                {g.subject || "no subject"} · {g.variants.length} spellings · {g.total} questions
                            </div>
                            <div style={{ display: "grid", gap: 7, marginBottom: 12 }}>
                                {g.variants.map((v) => (
                                    <label
                                        key={v.chapter}
                                        style={{
                                            display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                                            borderRadius: 9, cursor: "pointer",
                                            border: `1px solid ${keep === v.chapter ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                            background: keep === v.chapter ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                        }}
                                    >
                                        <input
                                            type="radio"
                                            name={g.key}
                                            checked={keep === v.chapter}
                                            onChange={() => setKeepChoice((p) => ({ ...p, [g.key]: v.chapter }))}
                                        />
                                        <span style={{ flex: 1, fontSize: "0.86rem", color: "var(--text-primary)", fontWeight: 600 }}>
                                            {v.chapter}
                                        </span>
                                        <span style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                                            {v.total} question{v.total === 1 ? "" : "s"}
                                            {v.classLevels.length ? ` · class ${v.classLevels.join(", ")}` : ""}
                                        </span>
                                    </label>
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={() => void merge(g, keep)}
                                disabled={busyKey === g.key}
                                style={{
                                    ...btn,
                                    background: "var(--accent-primary)",
                                    borderColor: "var(--accent-primary)",
                                    color: "#fff",
                                }}
                            >
                                {busyKey === g.key ? <Loader2 size={14} className="spin" /> : null}
                                Merge the rest into “{keep}”
                            </button>
                        </div>
                    );
                })}

                <div style={{ ...card, marginTop: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <strong style={{ fontSize: "0.95rem", color: "var(--text-primary)" }}>All chapters</strong>
                        <div style={{ position: "relative", marginLeft: "auto" }}>
                            <Search
                                size={13}
                                style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-tertiary)" }}
                            />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Filter…"
                                style={{
                                    padding: "6px 10px 6px 27px", borderRadius: 8,
                                    border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
                                    color: "var(--text-primary)", fontSize: "0.8rem",
                                }}
                            />
                        </div>
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                        <thead style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                            <tr>
                                <th style={{ textAlign: "left", padding: "7px 10px" }}>Subject</th>
                                <th style={{ textAlign: "left", padding: "7px 10px" }}>Chapter</th>
                                <th style={{ textAlign: "left", padding: "7px 10px" }}>Class</th>
                                <th style={{ textAlign: "right", padding: "7px 10px" }}>Questions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.slice(0, 400).map((c) => (
                                <tr key={`${c.subject}|${c.chapter}`} style={{ borderTop: "1px solid var(--border-primary)" }}>
                                    <td style={{ padding: "6px 10px", color: "var(--text-tertiary)" }}>{c.subject || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: "var(--text-primary)" }}>{c.chapter}</td>
                                    <td style={{ padding: "6px 10px", color: "var(--text-tertiary)" }}>
                                        {c.classLevels.length ? c.classLevels.join(", ") : "—"}
                                    </td>
                                    <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--text-secondary)" }}>{c.total}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {filtered.length > 400 && (
                        <div style={{ marginTop: 8, fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                            Showing the first 400 of {filtered.length} — narrow the filter to see more.
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
