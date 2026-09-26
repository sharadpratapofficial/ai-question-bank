"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    BarChart3,
    BookOpen,
    Database,
    FileText,
    Layers,
    Loader2,
    RefreshCw,
    ShieldCheck,
    Sparkles,
    TrendingUp,
    Wand2,
    Clock,
    ChevronDown,
    ChevronUp,
    Zap,
} from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";

/* ───────── Types ───────── */

type CountItem = { label: string; count: number };
type SubjectSummary = {
    subject: string;
    questionCount: number;
    chapterCount: number;
    topChapters: CountItem[];
    typeBreakdown: CountItem[];
    difficultyBreakdown: CountItem[];
};
type MetadataHealthItem = { label: string; complete: number; missing: number; percent: number };
type RecentTestItem = { id: string; batchName: string; examPreset: string; createdAt: string; totalQuestions: number };
type TopUsedQuestion = { questionId: string; usageCount: number; subject: string; chapter: string; questionType: string; summary: string };
type AnalyticsPayload = {
    success: boolean;
    generatedAt: string;
    overview: { totalQuestions: number; totalSubjects: number; totalChapters: number; totalTopics: number; finalizedTests: number; activeBatches: number; avgQuestionsPerTest: number };
    quality: { solutionCoverage: number; aiVerifiedCoverage: number; metadataCompleteness: number; usageCoverage: number; usedQuestions: number; unusedQuestions: number };
    distributions: { subjects: CountItem[]; difficulties: CountItem[]; questionTypes: CountItem[]; sources: CountItem[]; exams: CountItem[]; classes: CountItem[] };
    metadataHealth: MetadataHealthItem[];
    subjectSummaries: SubjectSummary[];
    topChapters: CountItem[];
    topTopics: CountItem[];
    matrices: { subjectDifficulty: Record<string, Record<string, number>> };
    usage: { historyAvailable: boolean; recentTests: RecentTestItem[]; topUsedQuestions: TopUsedQuestion[] };
    insights: string[];
    error?: string;
};

/* ───────── Cache ───────── */

const CACHE_KEY = "qbg_analytics_cache";

function readCache(): { data: AnalyticsPayload; cachedAt: string } | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeCache(data: AnalyticsPayload) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, cachedAt: new Date().toISOString() }));
    } catch { /* ignore quota errors */ }
}

/* ───────── Utils ───────── */

function fmt(v: number) { return new Intl.NumberFormat("en-IN").format(v); }

function fmtDate(v: string) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v || "—" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function timeAgo(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function pct(count: number, total: number) { return total > 0 ? Math.round((count / total) * 100) : 0; }

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#38bdf8", "#f97316", "#f472b6", "#8b5cf6", "#22d3ee"];
function clr(i: number) { return COLORS[i % COLORS.length]; }

/* ───────── Sub-components ───────── */

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
    return (
        <div style={{
            borderRadius: "16px",
            border: "1px solid var(--border-primary)",
            background: "var(--glass-card-bg)",
            padding: "20px",
            ...style,
        }}>
            {children}
        </div>
    );
}

function SectionTitle({ icon, title, actions }: { icon: ReactNode; title: string; actions?: ReactNode }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{ color: "var(--accent-primary)" }}>{icon}</div>
                <div style={{ fontSize: "1rem", fontWeight: 800, color: "var(--text-primary)" }}>{title}</div>
            </div>
            {actions}
        </div>
    );
}

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: ReactNode; color: string }) {
    return (
        <div style={{
            borderRadius: "14px",
            border: "1px solid var(--border-primary)",
            background: `linear-gradient(145deg, ${color}10, transparent 60%), var(--bg-secondary)`,
            padding: "18px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            transition: "transform 0.2s ease, box-shadow 0.2s ease",
        }}
        className="analytics-stat-card"
        >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
                <div style={{ width: "34px", height: "34px", borderRadius: "10px", display: "grid", placeItems: "center", background: `${color}18`, color }}>{icon}</div>
            </div>
            <div style={{ fontSize: "1.8rem", fontWeight: 900, letterSpacing: "-0.04em", color: "var(--text-primary)" }}>{value}</div>
        </div>
    );
}

function ProgressBar({ value, color, height = 8 }: { value: number; color: string; height?: number }) {
    return (
        <div style={{ height, borderRadius: "999px", background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div style={{
                width: `${Math.min(100, value)}%`,
                height: "100%",
                borderRadius: "999px",
                background: `linear-gradient(90deg, ${color}, ${color}88)`,
                transition: "width 0.6s ease",
            }} />
        </div>
    );
}

function BarList({ items, total, offset = 0 }: { items: CountItem[]; total: number; offset?: number }) {
    return (
        <div style={{ display: "grid", gap: "12px" }}>
            {items.map((item, i) => {
                const color = clr(i + offset);
                return (
                    <div key={item.label} style={{ display: "grid", gap: "6px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.8rem" }}>
                            <span style={{ color: "var(--text-secondary)" }}>{item.label}</span>
                            <span style={{ color: "var(--text-primary)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(item.count)}</span>
                        </div>
                        <ProgressBar value={pct(item.count, total)} color={color} />
                    </div>
                );
            })}
        </div>
    );
}

/* ───────── Main page ───────── */

export default function AnalyticsPage() {
    const router = useRouter();
    const [data, setData] = useState<AnalyticsPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [focusSubject, setFocusSubject] = useState("All");
    const [cachedAt, setCachedAt] = useState<string | null>(null);
    const [showInsights, setShowInsights] = useState(true);

    /* Load cached data immediately on mount, then optionally fetch fresh */
    useEffect(() => {
        const cached = readCache();
        if (cached) {
            setData(cached.data);
            setCachedAt(cached.cachedAt);
        } else {
            // No cache — must fetch
            void fetchAnalytics("initial");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchAnalytics = useCallback(async (mode: "initial" | "refresh" = "initial") => {
        if (mode === "initial") setLoading(true);
        else setRefreshing(true);
        setError(null);
        try {
            const response = await fetch("/api/analytics", { cache: "no-store" });
            const payload = (await response.json()) as AnalyticsPayload;
            if (!response.ok || !payload.success) throw new Error(payload.error || "Failed to load analytics.");
            setData(payload);
            writeCache(payload);
            setCachedAt(new Date().toISOString());
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (mode === "initial") setLoading(false);
            else setRefreshing(false);
        }
    }, []);

    const focusSummary = useMemo(() => {
        if (!data || focusSubject === "All") return null;
        return data.subjectSummaries.find((s) => s.subject === focusSubject) || null;
    }, [data, focusSubject]);

    const noData = !data && !loading;

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar activeTab="analytics" onTabChange={(tab) => {
                if (tab === "questions") router.push("/questions");
                else if (tab === "tests") router.push("/tests");
                else if (tab === "upload") router.push("/upload");
                else if (tab === "ai") router.push("/ai-tools");
                else if (tab === "admin") router.push("/admin/users");
                else if (tab === "agentic-qc") router.push("/agentic-qc");
                else if (tab === "qbg") router.push("/qbg");
                else if (tab === "video-solution") router.push("/video-solution");
                else if (tab === "question-wise-videos") router.push("/question-wise-videos");
                else if (tab === "circuit-designer") router.push("/circuit-designer");
            }} />

            <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
                <div style={{ maxWidth: "1360px", margin: "0 auto", padding: "28px 28px 48px", display: "grid", gap: "24px" }}>

                    {/* ─── Header ─── */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
                        <div style={{ display: "grid", gap: "6px" }}>
                            <div style={{ fontSize: "1.6rem", fontWeight: 900, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Analytics</div>
                            <div style={{ fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                                Question bank intelligence & content health overview
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            {cachedAt && (
                                <div style={{
                                    display: "inline-flex", alignItems: "center", gap: "6px",
                                    padding: "7px 12px", borderRadius: "10px",
                                    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
                                    fontSize: "0.74rem", color: "var(--text-tertiary)",
                                }}>
                                    <Clock size={12} />
                                    Updated {timeAgo(cachedAt)}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => void fetchAnalytics("refresh")}
                                disabled={refreshing || loading}
                                style={{
                                    display: "inline-flex", alignItems: "center", gap: "8px",
                                    padding: "9px 16px", borderRadius: "10px",
                                    border: "1px solid var(--accent-primary)",
                                    background: "var(--accent-glow)",
                                    color: "var(--accent-primary-hover)",
                                    fontWeight: 800, fontSize: "0.82rem",
                                    cursor: refreshing || loading ? "default" : "pointer",
                                    opacity: refreshing || loading ? 0.65 : 1,
                                    fontFamily: "inherit",
                                    transition: "all 0.2s ease",
                                }}
                            >
                                {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                {refreshing ? "Refreshing…" : "Refresh"}
                            </button>
                        </div>
                    </div>

                    {/* ─── Loading state (only when no cached data) ─── */}
                    {loading && !data && (
                        <Card>
                            <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "var(--text-secondary)", padding: "12px 0" }}>
                                <Loader2 size={18} className="animate-spin" />
                                <span style={{ fontSize: "0.9rem" }}>Loading analytics…</span>
                            </div>
                        </Card>
                    )}

                    {/* ─── Error ─── */}
                    {error && noData && (
                        <div style={{
                            border: "1px solid rgba(var(--accent-danger-rgb), 0.28)",
                            background: "rgba(var(--accent-danger-rgb), 0.08)",
                            borderRadius: "14px", padding: "16px",
                            color: "var(--accent-danger)",
                            display: "flex", gap: "10px", alignItems: "flex-start",
                        }}>
                            <AlertCircle size={16} style={{ marginTop: "1px" }} />
                            <div style={{ display: "grid", gap: "4px" }}>
                                <div style={{ fontWeight: 800 }}>Unable to load analytics</div>
                                <div style={{ fontSize: "0.84rem", color: "var(--text-secondary)" }}>{error}</div>
                            </div>
                        </div>
                    )}

                    {/* ─── Refresh error banner (when we have cached data but refresh failed) ─── */}
                    {error && data && (
                        <div style={{
                            border: "1px solid rgba(var(--accent-warning-rgb), 0.3)",
                            background: "rgba(var(--accent-warning-rgb), 0.06)",
                            borderRadius: "12px", padding: "12px 16px",
                            display: "flex", gap: "8px", alignItems: "center",
                            fontSize: "0.82rem", color: "var(--accent-warning)",
                        }}>
                            <AlertCircle size={14} />
                            Refresh failed — showing cached data. {error}
                        </div>
                    )}

                    {data && <>
                        {/* ─── Stat cards ─── */}
                        <div className="analytics-stats-grid">
                            <StatCard label="Total Questions" value={fmt(data.overview.totalQuestions)} icon={<Database size={16} />} color="#6366f1" />
                            <StatCard label="Subjects / Chapters" value={`${data.overview.totalSubjects} / ${data.overview.totalChapters}`} icon={<Layers size={16} />} color="#10b981" />
                            <StatCard label="Topics" value={fmt(data.overview.totalTopics)} icon={<BookOpen size={16} />} color="#f59e0b" />
                            <StatCard label="Finalized Tests" value={fmt(data.overview.finalizedTests)} icon={<FileText size={16} />} color="#38bdf8" />
                            <StatCard label="Active Batches" value={fmt(data.overview.activeBatches)} icon={<BarChart3 size={16} />} color="#f97316" />
                            <StatCard label="Avg Q/Test" value={fmt(data.overview.avgQuestionsPerTest)} icon={<TrendingUp size={16} />} color="#f472b6" />
                        </div>

                        {/* ─── Quality + Insights row ─── */}
                        <div className="analytics-two-col">
                            {/* Quality Snapshot */}
                            <Card>
                                <SectionTitle icon={<ShieldCheck size={18} />} title="Quality Snapshot" />
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "14px" }}>
                                    {[
                                        { label: "Metadata", value: data.quality.metadataCompleteness, color: "#6366f1", icon: <Database size={14} /> },
                                        { label: "Solutions", value: data.quality.solutionCoverage, color: "#10b981", icon: <ShieldCheck size={14} /> },
                                        { label: "AI Verified", value: data.quality.aiVerifiedCoverage, color: "#f59e0b", icon: <Wand2 size={14} /> },
                                        { label: "Utilization", value: data.quality.usageCoverage, color: "#38bdf8", icon: <TrendingUp size={14} /> },
                                    ].map((q) => (
                                        <div key={q.label} style={{
                                            borderRadius: "12px", padding: "16px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-secondary)",
                                            display: "grid", gap: "10px",
                                        }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                <span style={{ fontSize: "0.8rem", fontWeight: 800 }}>{q.label}</span>
                                                <span style={{ color: q.color }}>{q.icon}</span>
                                            </div>
                                            <ProgressBar value={q.value} color={q.color} height={10} />
                                            <div style={{ fontSize: "1.1rem", fontWeight: 900, color: q.color }}>{q.value}%</div>
                                        </div>
                                    ))}
                                </div>
                            </Card>

                            {/* Insights */}
                            <Card>
                                <SectionTitle
                                    icon={<Zap size={18} />}
                                    title="Key Insights"
                                    actions={
                                        <button
                                            type="button"
                                            onClick={() => setShowInsights((s) => !s)}
                                            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-tertiary)", padding: "4px" }}
                                        >
                                            {showInsights ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                        </button>
                                    }
                                />
                                {showInsights && (
                                    <div style={{ display: "grid", gap: "8px" }}>
                                        {data.insights.map((insight, i) => (
                                            <div key={`${i}-${insight.slice(0, 20)}`} style={{
                                                display: "flex", gap: "12px", alignItems: "flex-start",
                                                padding: "12px 14px", borderRadius: "12px",
                                                background: "var(--bg-secondary)",
                                                border: "1px solid var(--border-primary)",
                                            }}>
                                                <div style={{
                                                    width: "24px", height: "24px", borderRadius: "8px",
                                                    display: "grid", placeItems: "center", flexShrink: 0,
                                                    background: `${clr(i)}18`, color: clr(i),
                                                    fontWeight: 900, fontSize: "0.7rem",
                                                }}>
                                                    {i + 1}
                                                </div>
                                                <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>{insight}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Card>
                        </div>

                        {/* ─── Subject Lens ─── */}
                        <Card>
                            <SectionTitle icon={<Sparkles size={18} />} title="Subject Lens" />
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "18px" }}>
                                {["All", ...data.subjectSummaries.map((s) => s.subject)].map((subj) => (
                                    <button
                                        key={subj}
                                        type="button"
                                        onClick={() => setFocusSubject(subj)}
                                        style={{
                                            padding: "7px 14px", borderRadius: "999px",
                                            border: "1px solid " + (focusSubject === subj ? "var(--accent-primary)" : "var(--border-primary)"),
                                            background: focusSubject === subj ? "var(--accent-glow)" : "var(--bg-secondary)",
                                            color: focusSubject === subj ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                            cursor: "pointer", fontSize: "0.78rem", fontWeight: 700, fontFamily: "inherit",
                                            transition: "all 0.15s ease",
                                        }}
                                    >
                                        {subj}
                                    </button>
                                ))}
                            </div>
                            <div className="analytics-three-col">
                                <div style={{ borderRadius: "14px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "16px", display: "grid", gap: "14px" }}>
                                    <div style={{ fontSize: "0.82rem", fontWeight: 800 }}>{focusSubject === "All" ? "Subject Distribution" : `${focusSubject}`}</div>
                                    <BarList
                                        items={(focusSubject === "All"
                                            ? data.distributions.subjects
                                            : data.subjectSummaries.filter((s) => s.subject === focusSubject).map((s) => ({ label: s.subject, count: s.questionCount }))
                                        ).slice(0, 6)}
                                        total={data.overview.totalQuestions || 1}
                                    />
                                </div>
                                <div style={{ borderRadius: "14px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "16px", display: "grid", gap: "14px" }}>
                                    <div style={{ fontSize: "0.82rem", fontWeight: 800 }}>Chapter Hotspots</div>
                                    <BarList items={(focusSummary?.topChapters || data.topChapters).slice(0, 6)} total={focusSummary?.questionCount || data.overview.totalQuestions || 1} offset={1} />
                                </div>
                                <div style={{ display: "grid", gap: "14px" }}>
                                    <div style={{ borderRadius: "14px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "16px", display: "grid", gap: "14px" }}>
                                        <div style={{ fontSize: "0.82rem", fontWeight: 800 }}>Type Mix</div>
                                        <BarList items={(focusSummary?.typeBreakdown || data.distributions.questionTypes).slice(0, 5)} total={focusSummary?.questionCount || data.overview.totalQuestions || 1} offset={2} />
                                    </div>
                                    <div style={{ borderRadius: "14px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "16px", display: "grid", gap: "14px" }}>
                                        <div style={{ fontSize: "0.82rem", fontWeight: 800 }}>Difficulty Balance</div>
                                        <BarList items={focusSummary?.difficultyBreakdown || data.distributions.difficulties} total={focusSummary?.questionCount || data.overview.totalQuestions || 1} offset={3} />
                                    </div>
                                </div>
                            </div>
                        </Card>

                        {/* ─── Bottom row: Metadata + Coverage Matrix + Usage ─── */}
                        <div className="analytics-three-col">
                            {/* Metadata Health */}
                            <Card>
                                <SectionTitle icon={<Database size={18} />} title="Metadata Health" />
                                <BarList items={data.metadataHealth.map((h) => ({ label: h.label, count: h.percent }))} total={100} />
                            </Card>

                            {/* Coverage Matrix */}
                            <Card>
                                <SectionTitle icon={<Layers size={18} />} title="Coverage Matrix" />
                                <div style={{ display: "grid", gridTemplateColumns: "140px repeat(3, 1fr)", gap: "6px", alignItems: "center" }}>
                                    <div />
                                    {["Easy", "Medium", "Hard"].map((d) => (
                                        <div key={d} style={{ fontSize: "0.72rem", fontWeight: 800, color: "var(--text-tertiary)", textAlign: "center" }}>{d}</div>
                                    ))}
                                    {Object.keys(data.matrices.subjectDifficulty).map((subj) => {
                                        const row = data.matrices.subjectDifficulty[subj] || {};
                                        const max = Math.max(1, ...Object.values(row));
                                        return (
                                            <div key={subj} style={{ display: "contents" }}>
                                                <div style={{ padding: "8px 10px", borderRadius: "8px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", fontSize: "0.76rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subj}</div>
                                                {["Easy", "Medium", "Hard"].map((dif, di) => {
                                                    const c = row[dif] || 0;
                                                    const color = clr(di + 1);
                                                    const opacity = Math.round(12 + (c / max) * 38).toString(16);
                                                    return (
                                                        <div key={`${subj}-${dif}`} style={{
                                                            padding: "10px 6px", borderRadius: "8px", textAlign: "center",
                                                            border: "1px solid var(--border-primary)",
                                                            background: `${color}${opacity}`,
                                                            fontSize: "0.78rem", fontWeight: 800,
                                                        }}>
                                                            {fmt(c)}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}
                                </div>
                            </Card>

                            {/* Usage Intelligence */}
                            <Card>
                                <SectionTitle icon={<TrendingUp size={18} />} title="Usage Intelligence" />
                                {data.usage.historyAvailable ? (
                                    <div style={{ display: "grid", gap: "14px" }}>
                                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                            <div style={{ borderRadius: "12px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "14px", display: "grid", gap: "4px" }}>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Used</div>
                                                <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "var(--accent-success)" }}>{fmt(data.quality.usedQuestions)}</div>
                                            </div>
                                            <div style={{ borderRadius: "12px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "14px", display: "grid", gap: "4px" }}>
                                                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Unused</div>
                                                <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "var(--text-secondary)" }}>{fmt(data.quality.unusedQuestions)}</div>
                                            </div>
                                        </div>
                                        {data.usage.topUsedQuestions.length > 0 ? (
                                            <div style={{ display: "grid", gap: "8px" }}>
                                                {data.usage.topUsedQuestions.slice(0, 4).map((q, i) => (
                                                    <div key={q.questionId} style={{
                                                        padding: "10px 12px", borderRadius: "10px",
                                                        border: "1px solid var(--border-primary)",
                                                        background: "var(--bg-secondary)",
                                                        display: "grid", gap: "3px",
                                                    }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                                                            <span style={{ fontSize: "0.76rem", fontWeight: 800 }}>#{i + 1} {q.subject}</span>
                                                            <span style={{ fontSize: "0.7rem", color: "var(--accent-warning)", fontWeight: 800 }}>{q.usageCount} uses</span>
                                                        </div>
                                                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{q.chapter} • {q.questionType}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>No usage mapping available yet.</div>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{
                                        padding: "14px", borderRadius: "12px",
                                        background: "rgba(var(--accent-warning-rgb), 0.06)",
                                        border: "1px solid rgba(var(--accent-warning-rgb), 0.2)",
                                        color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.6,
                                    }}>
                                        Test history is not available yet. Usage insights will appear after tests are finalized.
                                    </div>
                                )}
                            </Card>
                        </div>

                        {/* ─── Recent Papers ─── */}
                        {data.usage.recentTests.length > 0 && (
                            <Card>
                                <SectionTitle icon={<FileText size={18} />} title="Recent Papers" />
                                <div className="analytics-papers-grid">
                                    {data.usage.recentTests.slice(0, 6).map((test, i) => (
                                        <div key={test.id} style={{
                                            padding: "14px 16px", borderRadius: "12px",
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-secondary)",
                                            display: "grid", gap: "6px",
                                        }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                                                <span style={{ fontSize: "0.82rem", fontWeight: 800 }}>{test.batchName}</span>
                                                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{fmtDate(test.createdAt)}</span>
                                            </div>
                                            <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                                                {test.examPreset.replace(/_/g, " ")} • {fmt(test.totalQuestions)} questions
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </Card>
                        )}
                    </>}
                </div>
            </main>

            <style>{`
                .analytics-stats-grid {
                    display: grid;
                    grid-template-columns: repeat(6, 1fr);
                    gap: 14px;
                }
                .analytics-stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
                }
                .analytics-two-col {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }
                .analytics-three-col {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 20px;
                }
                .analytics-papers-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 10px;
                }

                @media (max-width: 1280px) {
                    .analytics-stats-grid { grid-template-columns: repeat(3, 1fr); }
                }
                @media (max-width: 1100px) {
                    .analytics-three-col { grid-template-columns: 1fr; }
                    .analytics-papers-grid { grid-template-columns: repeat(2, 1fr); }
                }
                @media (max-width: 900px) {
                    .analytics-two-col { grid-template-columns: 1fr; }
                    .analytics-stats-grid { grid-template-columns: repeat(2, 1fr); }
                    .analytics-papers-grid { grid-template-columns: 1fr; }
                }
                @media (max-width: 600px) {
                    .analytics-stats-grid { grid-template-columns: 1fr; }
                }
            `}</style>
        </div>
    );
}
