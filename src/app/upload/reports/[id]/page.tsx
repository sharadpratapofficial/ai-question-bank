"use client";

/**
 * /upload/reports/[id]
 *
 * Review a single PDF extraction report and commit the selected questions to
 * the main qbg_questions table. Questions can be excluded via checkbox; the
 * "Save N questions" button writes only the checked rows.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    AlertCircle,
    ArrowLeft,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Database,
    FileText,
    Loader2,
    RefreshCw,
    XCircle,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import MathContent from "@/components/ui/MathContent";
import type { ExtractedQuestion, ExtractionReport } from "@/types/extraction";

export default function ExtractionReportDetailPage() {
    return (
        <RequirePermission permission="upload_pdf">
            <Inner />
        </RequirePermission>
    );
}

function Inner() {
    const params = useParams();
    const router = useRouter();
    const reportId = params.id as string;

    const [report, setReport] = useState<ExtractionReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [saving, setSaving] = useState(false);
    const [saveResult, setSaveResult] = useState<
        { savedCount: number; failedCount: number; errors: { questionNumber: number; error: string }[] } | null
    >(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/upload/extract/reports/${reportId}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `status ${res.status}`);
            const r = data.report as ExtractionReport;
            setReport(r);
            // Select all rows by default for completed reports.
            if (r.status === "completed" || r.status === "saved") {
                setSelected(new Set((r.extracted_questions ?? []).map((_, i) => i)));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [reportId]);

    useEffect(() => {
        load();
    }, [load]);

    // Auto-poll while the report is still processing.
    useEffect(() => {
        if (!report) return;
        if (report.status === "processing" || report.status === "queued") {
            const t = setTimeout(load, 4000);
            return () => clearTimeout(t);
        }
    }, [report, load]);

    const questions = report?.extracted_questions ?? [];
    const allSelected = selected.size === questions.length && questions.length > 0;
    const someSelected = selected.size > 0;

    const toggleOne = useCallback(
        (i: number) => {
            setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
            });
        },
        []
    );
    const toggleAll = useCallback(() => {
        setSelected((prev) => {
            if (prev.size === questions.length) return new Set();
            return new Set(questions.map((_, i) => i));
        });
    }, [questions]);
    const toggleExpand = useCallback((i: number) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            return next;
        });
    }, []);

    async function commit() {
        if (!report) return;
        if (selected.size === 0) return;
        setSaving(true);
        setSaveResult(null);
        try {
            const picked = Array.from(selected)
                .sort((a, b) => a - b)
                .map((i) => questions[i] as ExtractedQuestion);

            const res = await fetch(`/api/upload/extract/reports/${reportId}/save`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: picked }),
            });
            const data = await res.json();
            setSaveResult({
                savedCount: data.savedCount ?? 0,
                failedCount: (data.errors ?? []).length,
                errors: data.errors ?? [],
            });
            if (data.success) {
                // Refresh so the report shows as 'saved'
                await load();
            }
        } catch (err) {
            setSaveResult({
                savedCount: 0,
                failedCount: selected.size,
                errors: [{ questionNumber: 0, error: err instanceof Error ? err.message : String(err) }],
            });
        } finally {
            setSaving(false);
        }
    }

    const isProcessing = report?.status === "processing" || report?.status === "queued";

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
                <div style={{ maxWidth: "1080px", margin: "0 auto", padding: "24px 28px 80px" }}>
                    <header style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
                        <button
                            type="button"
                            onClick={() => router.push("/upload/reports")}
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
                            All reports
                        </button>
                        {isProcessing && (
                            <button
                                type="button"
                                onClick={load}
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
                                    cursor: "pointer",
                                }}
                            >
                                <RefreshCw size={12} />
                                Refresh
                            </button>
                        )}
                    </header>

                    {loading && !report && (
                        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-tertiary)" }}>
                            <Loader2 size={20} className="animate-spin" style={{ marginBottom: "8px" }} />
                            <div>Loading report…</div>
                        </div>
                    )}

                    {error && (
                        <div
                            style={{
                                padding: "12px",
                                borderRadius: "9px",
                                border: "1px solid #ef444455",
                                background: "#ef444410",
                                color: "#ef4444",
                                fontSize: "0.84rem",
                            }}
                        >
                            {error}
                        </div>
                    )}

                    {report && (
                        <>
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "12px",
                                    padding: "16px",
                                    background: "var(--bg-secondary)",
                                    marginBottom: "16px",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px", flexWrap: "wrap" }}>
                                    <FileText size={18} color="var(--accent-primary, #818cf8)" />
                                    <h1 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                        {report.questions_pdf_name || report.source_name}
                                    </h1>
                                    <DocTypeChip kind={report.document_type ?? "pdf"} />
                                    <StatusBadge status={report.status} />
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px", fontSize: "0.78rem" }}>
                                    <KV k="Source" v={report.source_name} />
                                    <KV k="Mode" v={report.mode} cap />
                                    <KV k="Provider" v={`${report.provider}${report.model_id ? ` · ${report.model_id}` : ""}`} />
                                    <KV k="Pages" v={String(report.total_pages ?? "—")} />
                                    <KV k="Created" v={formatDate(report.created_at)} />
                                    {report.saved_at && <KV k="Saved" v={formatDate(report.saved_at)} />}
                                </div>
                                {report.warnings && report.warnings.length > 0 && (
                                    <div
                                        style={{
                                            marginTop: "12px",
                                            padding: "8px 10px",
                                            borderRadius: "8px",
                                            background: "#f59e0b15",
                                            border: "1px solid #f59e0b55",
                                            color: "#b45309",
                                            fontSize: "0.78rem",
                                            display: "flex",
                                            gap: "6px",
                                            alignItems: "flex-start",
                                        }}
                                    >
                                        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: "2px" }} />
                                        <div>
                                            <div style={{ fontWeight: 700, marginBottom: "4px" }}>Warnings</div>
                                            <ul style={{ margin: 0, paddingLeft: "14px" }}>
                                                {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
                                            </ul>
                                        </div>
                                    </div>
                                )}
                                {report.error && (
                                    <div
                                        style={{
                                            marginTop: "12px",
                                            padding: "8px 10px",
                                            borderRadius: "8px",
                                            background: "#ef444415",
                                            border: "1px solid #ef444455",
                                            color: "#ef4444",
                                            fontSize: "0.78rem",
                                        }}
                                    >
                                        {report.error}
                                    </div>
                                )}
                            </div>

                            {isProcessing && (
                                <div
                                    style={{
                                        padding: "20px",
                                        textAlign: "center",
                                        border: "1px dashed var(--border-primary)",
                                        borderRadius: "10px",
                                        color: "var(--text-tertiary)",
                                        background: "var(--bg-secondary)",
                                    }}
                                >
                                    <Loader2 size={20} className="animate-spin" style={{ marginBottom: "8px" }} />
                                    <div>Extraction is still running. This page will refresh automatically.</div>
                                </div>
                            )}

                            {!isProcessing && questions.length > 0 && (
                                <>
                                    {/* Toolbar */}
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "10px",
                                            padding: "10px 12px",
                                            borderRadius: "10px",
                                            background: "var(--bg-secondary)",
                                            border: "1px solid var(--border-primary)",
                                            marginBottom: "10px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                                            <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                                                {allSelected ? "Unselect all" : "Select all"}
                                            </span>
                                        </label>
                                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                            {selected.size} of {questions.length} selected
                                        </span>
                                        <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
                                            <button
                                                type="button"
                                                onClick={commit}
                                                disabled={!someSelected || saving || report.status === "saved"}
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "6px",
                                                    padding: "8px 14px",
                                                    borderRadius: "8px",
                                                    border: "1px solid var(--accent-primary, #818cf8)",
                                                    background: someSelected && report.status !== "saved" ? "var(--accent-primary, #818cf8)" : "var(--bg-tertiary)",
                                                    color: someSelected && report.status !== "saved" ? "#fff" : "var(--text-tertiary)",
                                                    fontSize: "0.82rem",
                                                    fontWeight: 700,
                                                    cursor: someSelected && !saving && report.status !== "saved" ? "pointer" : "default",
                                                    opacity: saving ? 0.7 : 1,
                                                }}
                                            >
                                                {saving ? <Loader2 size={13} className="animate-spin" /> : <Database size={13} />}
                                                {report.status === "saved"
                                                    ? "Already saved"
                                                    : saving
                                                    ? "Saving…"
                                                    : `Save ${selected.size} to question bank`}
                                            </button>
                                        </div>
                                    </div>

                                    {report.document_type === "docx" && (
                                        <div
                                            style={{
                                                padding: "10px 12px",
                                                borderRadius: "10px",
                                                border: "1px solid #3b82f655",
                                                background: "#3b82f610",
                                                color: "var(--text-secondary)",
                                                fontSize: "0.78rem",
                                                marginBottom: "10px",
                                                lineHeight: 1.5,
                                            }}
                                        >
                                            <strong style={{ color: "#3b82f6" }}>Word source.</strong>{" "}
                                            The full content (paragraphs, equations as images, diagrams,
                                            OLE equation objects) is preserved verbatim and will be used
                                            when generating Word test papers. The previews below show only
                                            the AI-extracted plain text + metadata; this is intentional
                                            — these rows are not browser-renderable.
                                        </div>
                                    )}

                                    {saveResult && (
                                        <div
                                            style={{
                                                padding: "10px 12px",
                                                borderRadius: "10px",
                                                border: saveResult.failedCount === 0 ? "1px solid #22c55e55" : "1px solid #f59e0b55",
                                                background: saveResult.failedCount === 0 ? "#22c55e10" : "#f59e0b10",
                                                color: saveResult.failedCount === 0 ? "#22c55e" : "#b45309",
                                                fontSize: "0.8rem",
                                                marginBottom: "10px",
                                            }}
                                        >
                                            <strong>{saveResult.savedCount}</strong> saved
                                            {saveResult.failedCount > 0 && <>, <strong>{saveResult.failedCount}</strong> failed</>}.
                                            {saveResult.failedCount > 0 && saveResult.errors.length > 0 && (
                                                <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                                                    {saveResult.errors.slice(0, 5).map((e, i) => (
                                                        <li key={i}>Q{e.questionNumber}: {e.error}</li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    )}

                                    {/* Question list */}
                                    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                                        {questions.map((q, i) => {
                                            const isExpanded = expanded.has(i);
                                            const isSelected = selected.has(i);
                                            return (
                                                <li
                                                    key={i}
                                                    style={{
                                                        border: `1px solid ${isSelected ? "var(--accent-primary, #818cf8)55" : "var(--border-primary)"}`,
                                                        borderRadius: "10px",
                                                        background: "var(--bg-secondary)",
                                                        overflow: "hidden",
                                                    }}
                                                >
                                                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "10px", padding: "10px 12px", alignItems: "flex-start" }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => toggleOne(i)}
                                                            style={{ marginTop: "3px" }}
                                                        />
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                                                <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-tertiary)" }}>
                                                                    Q{q.questionNumber}
                                                                </span>
                                                                {q.subject && <Tag>{q.subject}</Tag>}
                                                                {q.chapter && <Tag muted>{q.chapter}</Tag>}
                                                                {q.questionType && <Tag muted>{q.questionType}</Tag>}
                                                                {q.difficultyLevel && <Tag>{q.difficultyLevel}</Tag>}
                                                                {report.document_type === "docx" && (() => {
                                                                    const sd = (q as ExtractedQuestion & { source_docx?: { ooxml_paragraphs?: unknown[]; media_refs?: unknown[]; solution_ooxml_paragraphs?: unknown[] | null } }).source_docx;
                                                                    if (!sd) return null;
                                                                    const paras = Array.isArray(sd.ooxml_paragraphs) ? sd.ooxml_paragraphs.length : 0;
                                                                    const media = Array.isArray(sd.media_refs) ? sd.media_refs.length : 0;
                                                                    const hasSol = Array.isArray(sd.solution_ooxml_paragraphs) && sd.solution_ooxml_paragraphs.length > 0;
                                                                    return (
                                                                        <>
                                                                            <Tag muted>{paras} ¶</Tag>
                                                                            {media > 0 && <Tag muted>{media} media</Tag>}
                                                                            {hasSol && <Tag muted>+ solution</Tag>}
                                                                        </>
                                                                    );
                                                                })()}
                                                            </div>
                                                            <div
                                                                style={{
                                                                    color: "var(--text-primary)",
                                                                    fontSize: "0.86rem",
                                                                    lineHeight: 1.5,
                                                                    maxHeight: isExpanded ? "none" : "4.5em",
                                                                    overflow: isExpanded ? "visible" : "hidden",
                                                                }}
                                                            >
                                                                <MathContent html={q.questionText || ""} />
                                                            </div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleExpand(i)}
                                                            style={{
                                                                border: "1px solid var(--border-primary)",
                                                                borderRadius: "7px",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-secondary)",
                                                                padding: "4px 6px",
                                                                cursor: "pointer",
                                                            }}
                                                            title={isExpanded ? "Collapse" : "Expand"}
                                                        >
                                                            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                                        </button>
                                                    </div>

                                                    {isExpanded && (
                                                        <div
                                                            style={{
                                                                padding: "0 12px 12px",
                                                                borderTop: "1px solid var(--border-primary)",
                                                                fontSize: "0.82rem",
                                                                color: "var(--text-secondary)",
                                                                display: "grid",
                                                                gap: "8px",
                                                            }}
                                                        >
                                                            {q.options && q.options.length > 0 && (
                                                                <div>
                                                                    <div style={{ fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "4px", marginTop: "8px" }}>
                                                                        Options
                                                                    </div>
                                                                    <ol style={{ margin: 0, paddingLeft: "18px", display: "grid", gap: "3px" }}>
                                                                        {q.options.map((opt, oi) => (
                                                                            <li
                                                                                key={oi}
                                                                                style={{ color: opt.isCorrect ? "var(--accent-success, #22c55e)" : "var(--text-primary)", fontWeight: opt.isCorrect ? 600 : 400 }}
                                                                            >
                                                                                <MathContent html={opt.text || ""} />
                                                                                {opt.isCorrect && <span style={{ marginLeft: "6px" }}>✓</span>}
                                                                            </li>
                                                                        ))}
                                                                    </ol>
                                                                </div>
                                                            )}
                                                            {q.solutionText && (
                                                                <div>
                                                                    <div style={{ fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "4px" }}>
                                                                        Solution
                                                                    </div>
                                                                    <MathContent html={q.solutionText} />
                                                                </div>
                                                            )}
                                                            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                                                Answer key: {Array.isArray(q.answerKey) ? q.answerKey.join(", ") : String(q.answerKey ?? "—")}
                                                            </div>
                                                        </div>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ol>

                                    <div style={{ marginTop: "16px", padding: "10px 12px", fontSize: "0.78rem", color: "var(--text-tertiary)", background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)", borderRadius: "10px" }}>
                                        Saved questions land in the main bank with status{" "}
                                        <strong>Verification Pending</strong>. You can fine-tune
                                        any of them from the <Link href="/questions" style={{ color: "var(--accent-primary, #818cf8)" }}>Questions</Link> page.
                                    </div>
                                </>
                            )}

                            {!isProcessing && questions.length === 0 && (
                                <div
                                    style={{
                                        padding: "20px",
                                        textAlign: "center",
                                        color: "var(--text-tertiary)",
                                        border: "1px dashed var(--border-primary)",
                                        borderRadius: "10px",
                                        background: "var(--bg-secondary)",
                                    }}
                                >
                                    No questions were extracted from this PDF.
                                </div>
                            )}
                        </>
                    )}
                </div>
            </main>
        </div>
    );
}

function Tag({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
    return (
        <span
            style={{
                padding: "2px 7px",
                borderRadius: "5px",
                background: muted ? "var(--bg-tertiary)" : "var(--accent-primary, #818cf8)15",
                color: muted ? "var(--text-tertiary)" : "var(--accent-primary, #818cf8)",
                border: muted ? "1px solid var(--border-primary)" : "1px solid var(--accent-primary, #818cf8)40",
                fontSize: "0.66rem",
                fontWeight: 600,
                lineHeight: 1.4,
            }}
        >
            {children}
        </span>
    );
}

function KV({ k, v, cap }: { k: string; v: string; cap?: boolean }) {
    return (
        <div style={{ display: "grid", gap: "2px" }}>
            <span style={{ fontSize: "0.66rem", color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {k}
            </span>
            <span style={{ color: "var(--text-primary)", textTransform: cap ? "capitalize" : "none" }}>{v}</span>
        </div>
    );
}

function StatusBadge({ status }: { status: ExtractionReport["status"] }) {
    const map: Record<ExtractionReport["status"], { bg: string; fg: string; label: string; icon: React.ReactNode }> = {
        queued:     { bg: "#f59e0b22", fg: "#f59e0b", label: "Queued", icon: <Loader2 size={11} /> },
        processing: { bg: "#3b82f622", fg: "#3b82f6", label: "Processing", icon: <Loader2 size={11} className="animate-spin" /> },
        completed:  { bg: "#8b5cf622", fg: "#8b5cf6", label: "Ready to review", icon: <CheckCircle2 size={11} /> },
        saved:      { bg: "#22c55e22", fg: "#22c55e", label: "Saved to bank", icon: <Database size={11} /> },
        failed:     { bg: "#ef444422", fg: "#ef4444", label: "Failed", icon: <XCircle size={11} /> },
        discarded:  { bg: "#6b728022", fg: "#6b7280", label: "Discarded", icon: <XCircle size={11} /> },
    };
    const p = map[status];
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
            }}
        >
            {p.icon}
            {p.label}
        </span>
    );
}

function DocTypeChip({ kind }: { kind: "pdf" | "docx" }) {
    const isPdf = kind === "pdf";
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: "5px",
                fontSize: "0.66rem",
                fontWeight: 700,
                letterSpacing: "0.04em",
                background: isPdf ? "#ef444415" : "#3b82f615",
                color: isPdf ? "#ef4444" : "#3b82f6",
                border: `1px solid ${isPdf ? "#ef444455" : "#3b82f655"}`,
            }}
            title={isPdf ? "PDF upload" : "Word (.docx) upload"}
        >
            {isPdf ? "PDF" : "DOCX"}
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
