"use client";

/**
 * /upload/reports
 *
 * Lists every PDF extraction the user has run. Each row links to a detailed
 * review page where the user can edit the extracted questions and commit them
 * to qbg_questions.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowLeft,
    CheckCircle2,
    Database,
    Eye,
    FileText,
    Loader2,
    RefreshCw,
    Search,
    Trash2,
    XCircle,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import type { ExtractionReportStatus, ExtractionReportSummary } from "@/types/extraction";

export default function ExtractionReportsPage() {
    return (
        <RequirePermission permission="upload_pdf">
            <Inner />
        </RequirePermission>
    );
}

function Inner() {
    const router = useRouter();
    const [reports, setReports] = useState<ExtractionReportSummary[]>([]);
    // `loading` is the first-paint state only — it blanks the table and shows
    // "Loading…". Background polls / manual refreshes use `refreshing` instead so
    // the existing rows stay put (no flicker).
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<"all" | ExtractionReportStatus>("all");
    const [search, setSearch] = useState("");
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const load = useCallback(async (opts?: { background?: boolean }) => {
        const background = opts?.background ?? false;
        if (background) setRefreshing(true);
        else setLoading(true);
        if (!background) setError(null);
        try {
            const res = await fetch("/api/upload/extract/reports", { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
            setReports(data.reports as ExtractionReportSummary[]);
            setError(null);
        } catch (err) {
            // A transient blip during a background poll shouldn't replace the
            // already-rendered list with an error — only surface foreground errors.
            if (!background) setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (background) setRefreshing(false);
            else setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Auto-refresh only while an extraction is still in-flight, and do it in the
    // background so the table never blanks. Once everything has settled
    // (completed/saved/failed), polling stops entirely.
    const hasInFlight = useMemo(
        () => reports.some((r) => r.status === "processing" || r.status === "queued"),
        [reports]
    );
    useEffect(() => {
        if (!hasInFlight) return;
        const t = setInterval(() => load({ background: true }), 8000);
        return () => clearInterval(t);
    }, [hasInFlight, load]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return reports.filter((r) => {
            if (filter !== "all" && r.status !== filter) return false;
            if (q) {
                const hay = `${r.source_name} ${r.questions_pdf_name ?? ""} ${r.user_email ?? ""}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }, [reports, filter, search]);

    async function discard(id: string) {
        if (!confirm("Discard this extraction report? It will be hidden from the list.")) return;
        setDeletingId(id);
        try {
            const res = await fetch(`/api/upload/extract/reports/${id}`, { method: "DELETE" });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `status ${res.status}`);
            }
            setReports((prev) => prev.filter((r) => r.id !== id));
        } catch (err) {
            alert(err instanceof Error ? err.message : String(err));
        } finally {
            setDeletingId(null);
        }
    }

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar
                activeTab="questions"
                onTabChange={(tab) => {
                    if (tab === "tests") router.push("/tests");
                    else if (tab === "analytics") router.push("/analytics");
                    else if (tab === "upload") router.push("/upload");
                    else if (tab === "ai") router.push("/ai-tools");
                    else if (tab === "admin") router.push("/admin/users");
                    else if (tab === "agentic-qc") router.push("/agentic-qc");
                    else if (tab === "qbg") router.push("/qbg");
                    else if (tab === "video-solution") router.push("/video-solution");
                    else if (tab === "question-wise-videos") router.push("/question-wise-videos");
                    else if (tab === "circuit-designer") router.push("/circuit-designer");
                    else router.push("/questions");
                }}
            />

            <main style={{ flex: 1, overflowY: "auto", background: "var(--bg-primary)" }}>
                <div style={{ maxWidth: "1180px", margin: "0 auto", padding: "28px 28px 64px" }}>
                    <header
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            marginBottom: "16px",
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => router.push("/upload")}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "6px 12px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "8px",
                                background: "transparent",
                                color: "var(--text-secondary)",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                            }}
                        >
                            <ArrowLeft size={14} />
                            Back to Upload
                        </button>
                        <div style={{ marginLeft: "auto" }}>
                            <button
                                type="button"
                                onClick={() => load({ background: true })}
                                disabled={loading || refreshing}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    padding: "6px 12px",
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-secondary)",
                                    fontSize: "0.78rem",
                                    fontWeight: 600,
                                    cursor: loading || refreshing ? "default" : "pointer",
                                    opacity: loading || refreshing ? 0.6 : 1,
                                }}
                            >
                                <RefreshCw size={12} className={loading || refreshing ? "animate-spin" : undefined} />
                                Refresh
                            </button>
                        </div>
                    </header>

                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                        <FileText size={20} color="var(--accent-primary, #818cf8)" />
                        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
                            PDF Extraction Reports
                        </h1>
                    </div>
                    <p style={{ fontSize: "0.84rem", color: "var(--text-secondary)", margin: "0 0 18px" }}>
                        Every PDF you extract is saved here. Open a report to review, edit, and
                        commit the extracted questions into the question bank.
                    </p>

                    {/* Search + filter */}
                    <div style={{ display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
                        <div
                            style={{
                                flex: "1 1 240px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "9px",
                                background: "var(--bg-secondary)",
                                padding: "8px 12px",
                            }}
                        >
                            <Search size={14} color="var(--text-muted)" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by file name, source, or user"
                                style={{
                                    flex: 1,
                                    background: "transparent",
                                    border: "none",
                                    outline: "none",
                                    color: "var(--text-primary)",
                                    fontSize: "0.84rem",
                                }}
                            />
                        </div>
                        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                            {(["all", "completed", "saved", "failed", "processing", "queued"] as const).map((f) => {
                                const active = filter === f;
                                return (
                                    <button
                                        key={f}
                                        type="button"
                                        onClick={() => setFilter(f as typeof filter)}
                                        style={{
                                            padding: "7px 10px",
                                            borderRadius: "8px",
                                            border: `1px solid ${active ? "var(--accent-primary, #818cf8)" : "var(--border-primary)"}`,
                                            background: active ? "var(--accent-primary, #818cf8)" : "var(--bg-secondary)",
                                            color: active ? "#fff" : "var(--text-secondary)",
                                            fontSize: "0.76rem",
                                            fontWeight: 600,
                                            cursor: "pointer",
                                            textTransform: "capitalize",
                                        }}
                                    >
                                        {f}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {error && (
                        <div
                            style={{
                                padding: "10px 12px",
                                borderRadius: "9px",
                                border: "1px solid #ef444455",
                                background: "#ef444410",
                                color: "#ef4444",
                                fontSize: "0.8rem",
                                marginBottom: "12px",
                            }}
                        >
                            {error}
                        </div>
                    )}

                    <div
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "12px",
                            overflow: "hidden",
                            background: "var(--bg-secondary)",
                        }}
                    >
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                            <thead style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                                <tr>
                                    <th style={th()}>File / Source</th>
                                    <th style={th()}>Status</th>
                                    <th style={th()}>Questions</th>
                                    <th style={th()}>Mode</th>
                                    <th style={th()}>Created</th>
                                    <th style={th()}>By</th>
                                    <th style={th({ width: "140px" })}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading && (
                                    <tr>
                                        <td colSpan={7} style={td({ textAlign: "center", color: "var(--text-muted)" })}>
                                            Loading…
                                        </td>
                                    </tr>
                                )}
                                {!loading && filtered.length === 0 && (
                                    <tr>
                                        <td colSpan={7} style={td({ textAlign: "center", color: "var(--text-muted)" })}>
                                            No extraction reports yet — kick off a PDF upload from{" "}
                                            <Link href="/upload" style={{ color: "var(--accent-primary, #818cf8)" }}>
                                                Upload
                                            </Link>
                                            .
                                        </td>
                                    </tr>
                                )}
                                {!loading &&
                                    filtered.map((r) => (
                                        <tr
                                            key={r.id}
                                            style={{ borderTop: "1px solid var(--border-primary)" }}
                                        >
                                            <td style={td()}>
                                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                    <DocTypeChip kind={r.document_type ?? "pdf"} />
                                                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                                        {r.questions_pdf_name || r.source_name}
                                                    </div>
                                                </div>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "2px" }}>
                                                    {r.source_name}
                                                </div>
                                            </td>
                                            <td style={td()}>
                                                <StatusBadge status={r.status} />
                                            </td>
                                            <td style={td()}>{r.question_count}</td>
                                            <td style={td({ textTransform: "capitalize" })}>{r.mode}</td>
                                            <td style={td({ color: "var(--text-muted)", fontSize: "0.74rem" })}>
                                                {formatDate(r.created_at)}
                                            </td>
                                            <td style={td({ color: "var(--text-muted)", fontSize: "0.74rem" })}>
                                                {r.user_email ?? "—"}
                                            </td>
                                            <td style={td()}>
                                                <div style={{ display: "flex", gap: "6px" }}>
                                                    <Link
                                                        href={`/upload/reports/${r.id}`}
                                                        style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            padding: "5px 10px",
                                                            borderRadius: "7px",
                                                            border: "1px solid var(--accent-primary, #818cf8)",
                                                            background: "var(--accent-primary, #818cf8)",
                                                            color: "#fff",
                                                            fontSize: "0.74rem",
                                                            fontWeight: 700,
                                                            textDecoration: "none",
                                                        }}
                                                    >
                                                        <Eye size={11} />
                                                        Review
                                                    </Link>
                                                    {r.status !== "saved" && (
                                                        <button
                                                            type="button"
                                                            onClick={() => discard(r.id)}
                                                            disabled={deletingId === r.id}
                                                            style={{
                                                                border: "1px solid var(--border-primary)",
                                                                borderRadius: "7px",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--accent-danger, #ef4444)",
                                                                padding: "5px 8px",
                                                                cursor: deletingId === r.id ? "default" : "pointer",
                                                            }}
                                                            title="Discard"
                                                        >
                                                            {deletingId === r.id ? (
                                                                <Loader2 size={11} className="animate-spin" />
                                                            ) : (
                                                                <Trash2 size={11} />
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </div>
    );
}

function StatusBadge({ status }: { status: ExtractionReportStatus }) {
    const palette: Record<ExtractionReportStatus, { bg: string; fg: string; icon: React.ReactNode; label: string }> = {
        queued:     { bg: "#f59e0b22", fg: "#f59e0b", icon: <Loader2 size={11} />, label: "Queued" },
        processing: { bg: "#3b82f622", fg: "#3b82f6", icon: <Loader2 size={11} className="animate-spin" />, label: "Processing" },
        completed:  { bg: "#8b5cf622", fg: "#8b5cf6", icon: <CheckCircle2 size={11} />, label: "Ready to review" },
        saved:      { bg: "#22c55e22", fg: "#22c55e", icon: <Database size={11} />, label: "Saved" },
        failed:     { bg: "#ef444422", fg: "#ef4444", icon: <XCircle size={11} />, label: "Failed" },
        discarded:  { bg: "#6b728022", fg: "#6b7280", icon: <Trash2 size={11} />, label: "Discarded" },
    };
    const p = palette[status];
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: p.bg,
                color: p.fg,
                border: `1px solid ${p.fg}55`,
                fontSize: "0.7rem",
                fontWeight: 700,
                lineHeight: 1.4,
            }}
        >
            {p.icon}
            {p.label}
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

function DocTypeChip({ kind }: { kind: "pdf" | "docx" }) {
    const isPdf = kind === "pdf";
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "1px 6px",
                borderRadius: "5px",
                fontSize: "0.62rem",
                fontWeight: 700,
                letterSpacing: "0.04em",
                background: isPdf ? "#ef444415" : "#3b82f615",
                color: isPdf ? "#ef4444" : "#3b82f6",
                border: `1px solid ${isPdf ? "#ef444455" : "#3b82f655"}`,
                whiteSpace: "nowrap",
            }}
            title={isPdf ? "PDF upload" : "Word (.docx) upload"}
        >
            {isPdf ? "PDF" : "DOCX"}
        </span>
    );
}

function th(extra: React.CSSProperties = {}): React.CSSProperties {
    return {
        textAlign: "left",
        padding: "10px 14px",
        fontWeight: 600,
        fontSize: "0.74rem",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        ...extra,
    };
}

function td(extra: React.CSSProperties = {}): React.CSSProperties {
    return {
        padding: "12px 14px",
        verticalAlign: "top",
        ...extra,
    };
}
