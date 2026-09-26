"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft,
    Loader2,
    AlertCircle,
    BookOpen,
    Award,
    GraduationCap,
    Hash,
    Eye,
    EyeOff,
    Copy,
    ExternalLink,
    Play,
    Layers,
    Tag,
    Clock,
    Target,
    FileText,
    Link2,
    Workflow,
    History as HistoryIcon,
} from "lucide-react";
import type { Question, QuestionStatus } from "@/types";
import { normalizeAnswerKey, getQuestionTypeLabel } from "@/types";
import QuestionStatusPill from "@/components/questions/QuestionStatusPill";
import QuestionStatusPanel from "@/components/questions/QuestionStatusPanel";
import QuestionHistoryPanel from "@/components/questions/QuestionHistoryPanel";
import {
    SUBJECT_COLORS,
    DIFFICULTY_COLORS,
    QUESTION_TYPE_COLORS,
    DEFAULT_BADGE_COLOR,
} from "@/lib/constants";
import { isPassageParentQuestionType } from "@/lib/questionTypes";
import MathContent from "@/components/ui/MathContent";
import Sidebar from "@/components/layout/Sidebar";

/* ──────────────────────── API response type ──────────────────────── */

interface QuestionDetailResponse {
    question: Question;
    childQuestions: Question[] | null;
    parentQuestion: Question | null;
    siblingQuestions: Question[] | null;
}

/* ──────────────────────── Reusable components ──────────────────────── */

function Badge({
    label,
    colors,
    size = "sm",
}: {
    label: string;
    colors: { bg: string; text: string; border: string };
    size?: "sm" | "md";
}) {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                padding: size === "md" ? "4px 12px" : "2px 8px",
                borderRadius: "6px",
                fontSize: size === "md" ? "0.78rem" : "0.7rem",
                fontWeight: 600,
                letterSpacing: "0.02em",
                lineHeight: 1.5,
                whiteSpace: "nowrap",
                background: colors.bg,
                color: colors.text,
                border: `1px solid ${colors.border}`,
            }}
        >
            {label}
        </span>
    );
}

function MetadataItem({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string | null | undefined;
}) {
    if (!value) return null;
    return (
        <div
            style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "12px",
                padding: "12px 0",
                borderBottom: "1px solid var(--border-secondary)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "32px",
                    height: "32px",
                    borderRadius: "8px",
                    background: "var(--bg-tertiary)",
                    color: "var(--text-tertiary)",
                    flexShrink: 0,
                }}
            >
                {icon}
            </div>
            <div style={{ flex: 1 }}>
                <div
                    style={{
                        fontSize: "0.68rem",
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        marginBottom: "2px",
                    }}
                >
                    {label}
                </div>
                <div
                    style={{
                        fontSize: "0.85rem",
                        color: "var(--text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {value}
                </div>
            </div>
        </div>
    );
}

/* ──────────────────────── Options/Answer renderer ──────────────────────── */

function OptionsDisplay({ question }: { question: Question }) {
    const answerKey = normalizeAnswerKey(question.answer_key);

    // Integer/Numerical type answer
    if (
        question.question_type === "Integer" ||
        question.question_type === "Numerical" ||
        question.question_type === "Single_Digit_Integer"
    ) {
        return (
            <div style={{ marginTop: "12px" }}>
                <div
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "10px 18px",
                        borderRadius: "8px",
                        background: "rgba(var(--accent-success-rgb), 0.08)",
                        border: "1px solid rgba(var(--accent-success-rgb), 0.25)",
                    }}
                >
                    <Hash size={16} color="var(--accent-success)" />
                    <span
                        style={{
                            fontSize: "0.95rem",
                            fontWeight: 700,
                            color: "var(--accent-success)",
                            fontFamily: "'JetBrains Mono', monospace",
                        }}
                    >
                        {answerKey.join(", ")}
                    </span>
                </div>
            </div>
        );
    }

    // MCQ/SCQ options
    if (!question.options || !question.options.some((opt) => opt.text !== null))
        return null;

    return (
        <div
            style={{
                marginTop: "12px",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
            }}
        >
            {question.options.map((opt, i) => {
                if (!opt.text) return null;
                const isCorrect = answerKey.includes(i + 1) || opt.isCorrect;
                return (
                    <div
                        key={i}
                        style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "10px",
                            padding: "10px 14px",
                            borderRadius: "8px",
                            background: isCorrect
                                ? "rgba(var(--accent-success-rgb), 0.08)"
                                : "var(--bg-tertiary)",
                            border: `1px solid ${isCorrect
                                ? "rgba(var(--accent-success-rgb), 0.25)"
                                : "var(--border-secondary)"
                                }`,
                        }}
                    >
                        <span
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "24px",
                                height: "24px",
                                borderRadius: "6px",
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                flexShrink: 0,
                                background: isCorrect
                                    ? "rgba(var(--accent-success-rgb), 0.2)"
                                    : "rgba(100, 100, 140, 0.15)",
                                color: isCorrect
                                    ? "var(--accent-success)"
                                    : "var(--text-tertiary)",
                            }}
                        >
                            {String.fromCharCode(65 + i)}
                        </span>
                        <MathContent
                            html={opt.text}
                            className="question-html"
                            style={{ fontSize: "0.85rem", flex: 1, lineHeight: 1.6 }}
                        />
                        {isCorrect && (
                            <span
                                style={{
                                    fontSize: "0.6rem",
                                    fontWeight: 700,
                                    color: "var(--accent-success)",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.05em",
                                    flexShrink: 0,
                                    marginTop: "4px",
                                }}
                            >
                                ✓
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ──────────────────────── Child question card ──────────────────────── */

function ChildQuestionCard({
    question,
    index,
    isActive,
}: {
    question: Question;
    index: number;
    isActive: boolean;
}) {
    const [showSolution, setShowSolution] = useState(false);

    return (
        <div
            id={`child-${question.question_id}`}
            style={{
                padding: "20px 24px",
                borderRadius: "12px",
                background: isActive
                    ? "rgba(99, 102, 241, 0.06)"
                    : "rgba(26, 26, 40, 0.5)",
                border: `1px solid ${isActive
                    ? "rgba(99, 102, 241, 0.25)"
                    : "var(--border-primary)"
                    }`,
                transition: "all 0.2s ease",
            }}
        >
            {/* Question header */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    marginBottom: "12px",
                }}
            >
                <span
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "28px",
                        height: "28px",
                        borderRadius: "8px",
                        fontSize: "0.82rem",
                        fontWeight: 700,
                        background: isActive
                            ? "rgba(99, 102, 241, 0.15)"
                            : "var(--bg-tertiary)",
                        color: isActive
                            ? "var(--accent-primary-hover)"
                            : "var(--text-tertiary)",
                        border: `1px solid ${isActive
                            ? "rgba(99, 102, 241, 0.3)"
                            : "var(--border-secondary)"
                            }`,
                        flexShrink: 0,
                    }}
                >
                    {index + 1}
                </span>

                <Badge
                    label={getQuestionTypeLabel(question.question_type)}
                    colors={
                        QUESTION_TYPE_COLORS[question.question_type] ||
                        DEFAULT_BADGE_COLOR
                    }
                />
                {question.difficutly_level && (
                    <Badge
                        label={question.difficutly_level}
                        colors={
                            DIFFICULTY_COLORS[question.difficutly_level] ||
                            DEFAULT_BADGE_COLOR
                        }
                    />
                )}

                <Link
                    href={`/question/${question.question_id}`}
                    style={{
                        marginLeft: "auto",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        fontSize: "0.68rem",
                        fontFamily: "'JetBrains Mono', monospace",
                        color: "var(--text-muted)",
                        textDecoration: "none",
                    }}
                >
                    {question.question_id.slice(0, 8)}
                    <ExternalLink size={10} />
                </Link>
            </div>

            {/* Question text */}
            <MathContent
                html={question.question_text}
                className="question-html"
                style={{ fontSize: "0.9rem", lineHeight: 1.7 }}
            />

            {/* Options / Answer */}
            <OptionsDisplay question={question} />

            {/* Solution toggle */}
            {question.solution_text && (
                <div style={{ marginTop: "14px" }}>
                    <button
                        onClick={() => setShowSolution(!showSolution)}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1px solid var(--border-primary)",
                            background: showSolution
                                ? "var(--accent-glow)"
                                : "transparent",
                            color: showSolution
                                ? "var(--accent-primary-hover)"
                                : "var(--text-tertiary)",
                            cursor: "pointer",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            transition: "all 0.15s ease",
                        }}
                    >
                        {showSolution ? (
                            <EyeOff size={13} />
                        ) : (
                            <Eye size={13} />
                        )}
                        {showSolution ? "Hide Solution" : "Show Solution"}
                    </button>

                    {showSolution && (
                        <div
                            className="animate-fade-in"
                            style={{
                                marginTop: "10px",
                                padding: "14px 18px",
                                borderRadius: "10px",
                                background: "var(--bg-tertiary)",
                                border: "1px solid var(--border-secondary)",
                            }}
                        >
                            <MathContent
                                html={question.solution_text}
                                className="question-html"
                                style={{ fontSize: "0.85rem", lineHeight: 1.7 }}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/* ──────────────────────── Main page component ──────────────────────── */

type DetailTab = "view" | "status" | "history";

export default function QuestionDetailPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const questionId = params.id as string;

    const [data, setData] = useState<QuestionDetailResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showSolution, setShowSolution] = useState(false);
    const [copied, setCopied] = useState(false);

    // Tab state — initialise from ?tab=… so the edit modal can deep-link to history.
    const initialTab = useMemo<DetailTab>(() => {
        const v = searchParams.get("tab");
        return v === "status" || v === "history" ? v : "view";
    }, [searchParams]);
    const [activeTab, setActiveTab] = useState<DetailTab>(initialTab);
    const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

    const fetchQuestion = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/questions/${questionId}`);
            if (!res.ok) {
                if (res.status === 404) throw new Error("Question not found");
                throw new Error(`HTTP ${res.status}`);
            }
            const json: QuestionDetailResponse = await res.json();
            setData(json);
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    }, [questionId]);

    useEffect(() => {
        fetchQuestion();
    }, [fetchQuestion]);

    const handleCopyId = () => {
        navigator.clipboard.writeText(questionId);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const question = data?.question ?? null;
    const childQuestions = data?.childQuestions ?? null;
    const parentQuestion = data?.parentQuestion ?? null;
    const siblingQuestions = data?.siblingQuestions ?? null;

    const isComposite = isPassageParentQuestionType(question?.question_type);
    const isChild = !!question?.parent_question_id;

    const answerKey = question ? normalizeAnswerKey(question.answer_key) : [];

    // Video URL from raw_data
    const videoUrl =
        question?.raw_data?.[0]?.solutions?.[0]?.english?.videoSolution?.url ||
        null;

    const exams = question?.exam || [];
    const classLevel = question?.class_level || null;

    return (
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar activeTab="questions" onTabChange={(tab) => { if (tab === "tests") router.push("/tests"); else if (tab === "upload") router.push("/upload"); else if (tab === "ai") router.push("/ai-tools"); else if (tab === "analytics") router.push("/analytics"); else if (tab === "admin") router.push("/admin/users"); else if (tab === "agentic-qc") router.push("/agentic-qc"); else if (tab === "qbg") router.push("/qbg"); else if (tab === "video-solution") router.push("/video-solution"); else if (tab === "question-wise-videos") router.push("/question-wise-videos"); else if (tab === "circuit-designer") router.push("/circuit-designer"); else router.push("/questions"); }} />

            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                {/* Top bar */}
                <header
                    className="glass"
                    style={{
                        padding: "12px 24px",
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        borderBottom: "1px solid var(--border-primary)",
                        zIndex: 30,
                    }}
                >
                    <button
                        onClick={() => router.back()}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1px solid var(--border-primary)",
                            background: "transparent",
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                            fontSize: "0.82rem",
                            fontWeight: 500,
                            transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = "var(--bg-hover)";
                            e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = "var(--text-secondary)";
                        }}
                    >
                        <ArrowLeft size={16} />
                        Back
                    </button>

                    <div
                        style={{
                            width: "1px",
                            height: "20px",
                            background: "var(--border-primary)",
                        }}
                    />

                    <span
                        style={{
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                        }}
                    >
                        {isComposite
                            ? "Passage / Composite Question"
                            : isChild
                                ? "Sub-Question"
                                : "Question Detail"}
                    </span>

                    {question && (
                        <div
                            style={{
                                marginLeft: "auto",
                                display: "flex",
                                gap: "8px",
                                alignItems: "center",
                            }}
                        >
                            <button
                                onClick={handleCopyId}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    padding: "6px 12px",
                                    borderRadius: "8px",
                                    border: "1px solid var(--border-primary)",
                                    background: "transparent",
                                    color: copied
                                        ? "var(--accent-success)"
                                        : "var(--text-tertiary)",
                                    cursor: "pointer",
                                    fontSize: "0.72rem",
                                    fontFamily: "'JetBrains Mono', monospace",
                                    transition: "all 0.15s ease",
                                }}
                            >
                                <Copy size={12} />
                                {copied
                                    ? "Copied!"
                                    : questionId.slice(0, 12) + "…"}
                            </button>
                        </div>
                    )}
                </header>

                {/* Tab navigation: View / Status / History */}
                {question && (
                    <nav
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "8px 24px 0",
                            borderBottom: "1px solid var(--border-primary)",
                            background: "var(--bg-primary)",
                            zIndex: 20,
                        }}
                    >
                        {(
                            [
                                { id: "view", label: "View", icon: <BookOpen size={14} /> },
                                { id: "status", label: "Status", icon: <Workflow size={14} /> },
                                { id: "history", label: "History", icon: <HistoryIcon size={14} /> },
                            ] as { id: DetailTab; label: string; icon: React.ReactNode }[]
                        ).map((tab) => {
                            const active = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setActiveTab(tab.id)}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "8px 14px",
                                        borderRadius: "8px 8px 0 0",
                                        border: "none",
                                        borderBottom: `2px solid ${active ? "var(--accent-primary, #818cf8)" : "transparent"}`,
                                        background: active ? "var(--bg-secondary)" : "transparent",
                                        color: active ? "var(--accent-primary-hover, var(--text-primary))" : "var(--text-secondary)",
                                        fontSize: "0.84rem",
                                        fontWeight: active ? 700 : 600,
                                        cursor: "pointer",
                                    }}
                                >
                                    {tab.icon}
                                    {tab.label}
                                </button>
                            );
                        })}
                        <div style={{ marginLeft: "auto" }}>
                            <QuestionStatusPill status={question.status} />
                        </div>
                    </nav>
                )}

                {/* Content area */}
                <div
                    style={{
                        flex: 1,
                        overflow: "auto",
                        display: "flex",
                    }}
                >
                    {/* Loading */}
                    {loading && (
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "16px",
                            }}
                        >
                            <Loader2
                                size={32}
                                style={{
                                    animation: "spin 1s linear infinite",
                                    color: "var(--accent-primary)",
                                }}
                            />
                            <span
                                style={{
                                    fontSize: "0.85rem",
                                    color: "var(--text-tertiary)",
                                }}
                            >
                                Loading question...
                            </span>
                            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                        </div>
                    )}

                    {/* Error */}
                    {error && !loading && (
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "12px",
                            }}
                        >
                            <AlertCircle
                                size={36}
                                style={{ color: "var(--accent-danger)" }}
                            />
                            <span
                                style={{
                                    fontSize: "1rem",
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                {error.includes("not found")
                                    ? "Question Not Found"
                                    : "Error Loading Question"}
                            </span>
                            <span
                                style={{
                                    fontSize: "0.8rem",
                                    color: "var(--text-muted)",
                                    maxWidth: "400px",
                                    textAlign: "center",
                                }}
                            >
                                {error}
                            </span>
                            <div
                                style={{
                                    display: "flex",
                                    gap: "8px",
                                    marginTop: "8px",
                                }}
                            >
                                <button
                                    onClick={() => router.back()}
                                    style={{
                                        padding: "8px 20px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border-primary)",
                                        background: "transparent",
                                        color: "var(--text-secondary)",
                                        cursor: "pointer",
                                        fontSize: "0.82rem",
                                    }}
                                >
                                    Go Back
                                </button>
                                <button
                                    onClick={fetchQuestion}
                                    style={{
                                        padding: "8px 20px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--accent-primary)",
                                        background: "transparent",
                                        color: "var(--accent-primary)",
                                        cursor: "pointer",
                                        fontSize: "0.82rem",
                                        fontWeight: 500,
                                    }}
                                >
                                    Retry
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Status tab */}
                    {!loading && !error && question && activeTab === "status" && (
                        <div style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
                            <div style={{ maxWidth: "720px", margin: "0 auto" }}>
                                <QuestionStatusPanel
                                    questionId={question.question_id}
                                    status={(question.status ?? "verification_pending") as QuestionStatus}
                                    onChanged={() => {
                                        // Re-fetch so the pill in the tab bar reflects the new status
                                        // and the history tab picks up the new transition row.
                                        fetchQuestion();
                                        setHistoryRefreshKey((k) => k + 1);
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {/* History tab */}
                    {!loading && !error && question && activeTab === "history" && (
                        <div style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
                            <div style={{ maxWidth: "820px", margin: "0 auto" }}>
                                <QuestionHistoryPanel
                                    questionId={question.question_id}
                                    refreshKey={historyRefreshKey}
                                    onRestored={() => {
                                        fetchQuestion();
                                        setHistoryRefreshKey((k) => k + 1);
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Question content (View tab) */}
                    {!loading && !error && question && activeTab === "view" && (
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                overflow: "hidden",
                            }}
                        >
                            {/* Main content area */}
                            <div
                                style={{
                                    flex: 1,
                                    overflow: "auto",
                                    padding: "32px 40px",
                                }}
                            >
                                {/* Badges row */}
                                <div
                                    className="animate-fade-in"
                                    style={{
                                        display: "flex",
                                        gap: "8px",
                                        flexWrap: "wrap",
                                        marginBottom: "24px",
                                    }}
                                >
                                    <Badge
                                        label={question.subject}
                                        colors={
                                            SUBJECT_COLORS[question.subject] ||
                                            DEFAULT_BADGE_COLOR
                                        }
                                        size="md"
                                    />
                                    <Badge
                                        label={getQuestionTypeLabel(
                                            question.question_type
                                        )}
                                        colors={
                                            QUESTION_TYPE_COLORS[
                                            question.question_type
                                            ] || DEFAULT_BADGE_COLOR
                                        }
                                        size="md"
                                    />
                                    {question.difficutly_level && (
                                        <Badge
                                            label={question.difficutly_level}
                                            colors={
                                                DIFFICULTY_COLORS[
                                                question.difficutly_level
                                                ] || DEFAULT_BADGE_COLOR
                                            }
                                            size="md"
                                        />
                                    )}
                                    {question.source && (
                                        <Badge
                                            label={question.source}
                                            colors={{
                                                bg: "rgba(100, 100, 140, 0.1)",
                                                text: "var(--text-tertiary)",
                                                border: "var(--border-primary)",
                                            }}
                                            size="md"
                                        />
                                    )}
                                    {exams.map((ex) => (
                                        <Badge
                                            key={ex}
                                            label={ex}
                                            colors={{
                                                bg: "rgba(168, 85, 247, 0.1)",
                                                text: "#c084fc",
                                                border: "rgba(168, 85, 247, 0.2)",
                                            }}
                                            size="md"
                                        />
                                    ))}
                                    {classLevel && (
                                        <Badge
                                            label={`Class ${classLevel}`}
                                            colors={{
                                                bg: "rgba(14, 165, 233, 0.1)",
                                                text: "#38bdf8",
                                                border: "rgba(14, 165, 233, 0.2)",
                                            }}
                                            size="md"
                                        />
                                    )}
                                </div>

                                {/* ═══════════ CASE 1: This IS a child question — show parent passage above ═══════════ */}
                                {isChild && parentQuestion && (
                                    <div
                                        className="animate-fade-in"
                                        style={{
                                            marginBottom: "28px",
                                        }}
                                    >
                                        {/* Parent passage header */}
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "8px",
                                                marginBottom: "12px",
                                            }}
                                        >
                                            <FileText
                                                size={16}
                                                style={{
                                                    color: "var(--accent-secondary)",
                                                }}
                                            />
                                            <span
                                                style={{
                                                    fontSize: "0.72rem",
                                                    fontWeight: 700,
                                                    color: "var(--accent-secondary)",
                                                    textTransform: "uppercase",
                                                    letterSpacing: "0.08em",
                                                }}
                                            >
                                                Parent Passage
                                            </span>
                                            <Link
                                                href={`/question/${parentQuestion.question_id}`}
                                                style={{
                                                    marginLeft: "auto",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "4px",
                                                    fontSize: "0.68rem",
                                                    fontFamily:
                                                        "'JetBrains Mono', monospace",
                                                    color: "var(--accent-primary)",
                                                    textDecoration: "none",
                                                }}
                                            >
                                                View Passage
                                                <ExternalLink size={10} />
                                            </Link>
                                        </div>
                                        <div
                                            style={{
                                                padding: "18px 22px",
                                                borderRadius: "12px",
                                                background:
                                                    "rgba(139, 92, 246, 0.04)",
                                                border: "1px solid rgba(139, 92, 246, 0.15)",
                                                borderLeft:
                                                    "3px solid var(--accent-secondary)",
                                            }}
                                        >
                                            <MathContent
                                                html={
                                                    parentQuestion.question_text
                                                }
                                                className="question-html"
                                                style={{
                                                    fontSize: "0.9rem",
                                                    lineHeight: 1.75,
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}

                                {/* ═══════════ CASE 2: This IS a composite parent — show passage then children ═══════════ */}
                                {isComposite ? (
                                    <>
                                        {/* Passage text */}
                                        <div
                                            className="animate-fade-in"
                                            style={{
                                                animationDelay: "50ms",
                                                animationFillMode: "both",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    marginBottom: "12px",
                                                }}
                                            >
                                                <FileText
                                                    size={16}
                                                    style={{
                                                        color: "var(--accent-secondary)",
                                                    }}
                                                />
                                                <span
                                                    style={{
                                                        fontSize: "0.72rem",
                                                        fontWeight: 700,
                                                        color: "var(--accent-secondary)",
                                                        textTransform:
                                                            "uppercase",
                                                        letterSpacing: "0.08em",
                                                    }}
                                                >
                                                    Passage
                                                </span>
                                            </div>
                                            <div
                                                style={{
                                                    padding: "20px 24px",
                                                    borderRadius: "12px",
                                                    background:
                                                        "rgba(139, 92, 246, 0.04)",
                                                    border: "1px solid rgba(139, 92, 246, 0.15)",
                                                    borderLeft:
                                                        "3px solid var(--accent-secondary)",
                                                }}
                                            >
                                                <MathContent
                                                    html={
                                                        question.question_text
                                                    }
                                                    className="question-html"
                                                    style={{
                                                        fontSize: "0.95rem",
                                                        lineHeight: 1.75,
                                                    }}
                                                />
                                            </div>
                                        </div>

                                        {/* Child questions */}
                                        <div
                                            className="animate-fade-in"
                                            style={{
                                                marginTop: "28px",
                                                animationDelay: "100ms",
                                                animationFillMode: "both",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    marginBottom: "16px",
                                                }}
                                            >
                                                <Link2
                                                    size={16}
                                                    style={{
                                                        color: "var(--text-tertiary)",
                                                    }}
                                                />
                                                <span
                                                    style={{
                                                        fontSize: "0.72rem",
                                                        fontWeight: 700,
                                                        color: "var(--text-tertiary)",
                                                        textTransform:
                                                            "uppercase",
                                                        letterSpacing: "0.08em",
                                                    }}
                                                >
                                                    Sub-Questions (
                                                    {childQuestions?.length || 0}
                                                    )
                                                </span>
                                            </div>

                                            {childQuestions &&
                                                childQuestions.length > 0 ? (
                                                <div
                                                    style={{
                                                        display: "flex",
                                                        flexDirection: "column",
                                                        gap: "14px",
                                                    }}
                                                >
                                                    {childQuestions.map(
                                                        (child, idx) => (
                                                            <ChildQuestionCard
                                                                key={
                                                                    child.question_id
                                                                }
                                                                question={child}
                                                                index={idx}
                                                                isActive={false}
                                                            />
                                                        )
                                                    )}
                                                </div>
                                            ) : (
                                                <div
                                                    style={{
                                                        padding: "24px",
                                                        borderRadius: "10px",
                                                        background:
                                                            "var(--bg-tertiary)",
                                                        border: "1px solid var(--border-secondary)",
                                                        textAlign: "center",
                                                        color: "var(--text-muted)",
                                                        fontSize: "0.85rem",
                                                    }}
                                                >
                                                    No sub-questions found for
                                                    this passage.
                                                </div>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        {/* ═══════════ CASE 3: Regular question (or child viewed standalone) ═══════════ */}
                                        {/* Question text */}
                                        <div
                                            className="animate-fade-in"
                                            style={{
                                                animationDelay: "50ms",
                                                animationFillMode: "both",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontSize: "0.72rem",
                                                    fontWeight: 600,
                                                    color: "var(--text-muted)",
                                                    textTransform: "uppercase",
                                                    letterSpacing: "0.08em",
                                                    marginBottom: "12px",
                                                }}
                                            >
                                                Question
                                            </div>
                                            <div
                                                style={{
                                                    padding: "20px 24px",
                                                    borderRadius: "12px",
                                                    background:
                                                        "var(--bg-tertiary)",
                                                    border: "1px solid var(--border-primary)",
                                                }}
                                            >
                                                <MathContent
                                                    html={
                                                        question.question_text
                                                    }
                                                    className="question-html"
                                                    style={{
                                                        fontSize: "0.95rem",
                                                        lineHeight: 1.75,
                                                    }}
                                                />
                                            </div>
                                        </div>

                                        {/* Options */}
                                        {question.options &&
                                            question.options.some(
                                                (opt) => opt.text !== null
                                            ) && (
                                                <div
                                                    className="animate-fade-in"
                                                    style={{
                                                        marginTop: "28px",
                                                        animationDelay: "100ms",
                                                        animationFillMode:
                                                            "both",
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            fontSize: "0.72rem",
                                                            fontWeight: 600,
                                                            color: "var(--text-muted)",
                                                            textTransform:
                                                                "uppercase",
                                                            letterSpacing:
                                                                "0.08em",
                                                            marginBottom:
                                                                "12px",
                                                        }}
                                                    >
                                                        Options
                                                    </div>
                                                    <OptionsDisplay
                                                        question={question}
                                                    />
                                                </div>
                                            )}

                                        {/* Integer answer */}
                                        {(question.question_type ===
                                            "Integer" ||
                                            question.question_type ===
                                            "Numerical" ||
                                            question.question_type ===
                                            "Single_Digit_Integer") && (
                                                <div
                                                    className="animate-fade-in"
                                                    style={{
                                                        marginTop: "28px",
                                                        animationDelay: "100ms",
                                                        animationFillMode: "both",
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            fontSize: "0.72rem",
                                                            fontWeight: 600,
                                                            color: "var(--text-muted)",
                                                            textTransform:
                                                                "uppercase",
                                                            letterSpacing: "0.08em",
                                                            marginBottom: "12px",
                                                        }}
                                                    >
                                                        Answer
                                                    </div>
                                                    <div
                                                        style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "10px",
                                                            padding: "14px 24px",
                                                            borderRadius: "10px",
                                                            background:
                                                                "rgba(var(--accent-success-rgb), 0.08)",
                                                            border: "1px solid rgba(var(--accent-success-rgb), 0.25)",
                                                        }}
                                                    >
                                                        <Hash
                                                            size={18}
                                                            style={{
                                                                color: "var(--accent-success)",
                                                            }}
                                                        />
                                                        <span
                                                            style={{
                                                                fontSize: "1.1rem",
                                                                fontWeight: 700,
                                                                color: "var(--accent-success)",
                                                                fontFamily:
                                                                    "'JetBrains Mono', monospace",
                                                            }}
                                                        >
                                                            {answerKey.join(", ")}
                                                        </span>
                                                    </div>
                                                </div>
                                            )}

                                        {/* Solution toggle (for regular questions) */}
                                        {question.solution_text && (
                                            <div
                                                className="animate-fade-in"
                                                style={{
                                                    marginTop: "32px",
                                                    animationDelay: "150ms",
                                                    animationFillMode: "both",
                                                }}
                                            >
                                                <button
                                                    onClick={() =>
                                                        setShowSolution(
                                                            !showSolution
                                                        )
                                                    }
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "8px",
                                                        padding: "10px 20px",
                                                        borderRadius: "10px",
                                                        border: "1px solid var(--accent-primary)",
                                                        background: showSolution
                                                            ? "var(--accent-glow)"
                                                            : "transparent",
                                                        color: "var(--accent-primary)",
                                                        cursor: "pointer",
                                                        fontSize: "0.82rem",
                                                        fontWeight: 600,
                                                        transition:
                                                            "all 0.15s ease",
                                                    }}
                                                >
                                                    {showSolution ? (
                                                        <EyeOff size={16} />
                                                    ) : (
                                                        <Eye size={16} />
                                                    )}
                                                    {showSolution
                                                        ? "Hide Solution"
                                                        : "Show Solution"}
                                                </button>

                                                {showSolution && (
                                                    <div
                                                        className="animate-fade-in"
                                                        style={{
                                                            marginTop: "16px",
                                                            padding: "20px 24px",
                                                            borderRadius:
                                                                "12px",
                                                            background:
                                                                "var(--bg-tertiary)",
                                                            border: "1px solid var(--border-primary)",
                                                        }}
                                                    >
                                                        <MathContent
                                                            html={
                                                                question.solution_text
                                                            }
                                                            className="question-html"
                                                            style={{
                                                                fontSize:
                                                                    "0.9rem",
                                                                lineHeight: 1.75,
                                                            }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}

                                {/* Sibling questions navigation (when viewing a child) */}
                                {isChild &&
                                    siblingQuestions &&
                                    siblingQuestions.length > 1 && (
                                        <div
                                            className="animate-fade-in"
                                            style={{
                                                marginTop: "32px",
                                                animationDelay: "200ms",
                                                animationFillMode: "both",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    marginBottom: "14px",
                                                }}
                                            >
                                                <Link2
                                                    size={16}
                                                    style={{
                                                        color: "var(--text-tertiary)",
                                                    }}
                                                />
                                                <span
                                                    style={{
                                                        fontSize: "0.72rem",
                                                        fontWeight: 700,
                                                        color: "var(--text-tertiary)",
                                                        textTransform:
                                                            "uppercase",
                                                        letterSpacing: "0.08em",
                                                    }}
                                                >
                                                    Sibling Questions (
                                                    {siblingQuestions.length})
                                                </span>
                                            </div>
                                            <div
                                                style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: "12px",
                                                }}
                                            >
                                                {siblingQuestions.map(
                                                    (sib, idx) => (
                                                        <ChildQuestionCard
                                                            key={
                                                                sib.question_id
                                                            }
                                                            question={sib}
                                                            index={idx}
                                                            isActive={
                                                                sib.question_id ===
                                                                questionId
                                                            }
                                                        />
                                                    )
                                                )}
                                            </div>
                                        </div>
                                    )}

                                {/* Video Solution */}
                                {videoUrl && (
                                    <div
                                        className="animate-fade-in"
                                        style={{
                                            marginTop: "28px",
                                            animationDelay: "200ms",
                                            animationFillMode: "both",
                                        }}
                                    >
                                        <div
                                            style={{
                                                fontSize: "0.72rem",
                                                fontWeight: 600,
                                                color: "var(--text-muted)",
                                                textTransform: "uppercase",
                                                letterSpacing: "0.08em",
                                                marginBottom: "12px",
                                            }}
                                        >
                                            Video Solution
                                        </div>
                                        <a
                                            href={videoUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "10px",
                                                padding: "12px 20px",
                                                borderRadius: "10px",
                                                background:
                                                    "rgba(99, 102, 241, 0.08)",
                                                border: "1px solid rgba(99, 102, 241, 0.2)",
                                                color: "var(--accent-primary-hover)",
                                                textDecoration: "none",
                                                fontSize: "0.85rem",
                                                fontWeight: 500,
                                                transition: "all 0.15s ease",
                                            }}
                                        >
                                            <Play size={16} />
                                            Watch Video Solution
                                            <ExternalLink
                                                size={14}
                                                style={{ opacity: 0.6 }}
                                            />
                                        </a>
                                    </div>
                                )}

                                {/* Bottom spacing */}
                                <div style={{ height: "60px" }} />
                            </div>

                            {/* ═══════════ Right sidebar — metadata panel ═══════════ */}
                            <div
                                className="animate-slide-right"
                                style={{
                                    width: "320px",
                                    minWidth: "320px",
                                    borderLeft:
                                        "1px solid var(--border-primary)",
                                    background: "var(--bg-secondary)",
                                    overflow: "auto",
                                    padding: "24px 20px",
                                }}
                            >
                                {/* Title */}
                                <div
                                    style={{
                                        fontSize: "0.75rem",
                                        fontWeight: 700,
                                        color: "var(--text-tertiary)",
                                        textTransform: "uppercase",
                                        letterSpacing: "0.08em",
                                        marginBottom: "16px",
                                    }}
                                >
                                    Metadata
                                </div>

                                <MetadataItem
                                    icon={<Layers size={16} />}
                                    label="Subject"
                                    value={question.subject}
                                />
                                <MetadataItem
                                    icon={<BookOpen size={16} />}
                                    label="Chapter"
                                    value={question.chapter}
                                />
                                <MetadataItem
                                    icon={<Award size={16} />}
                                    label="Topic"
                                    value={question.topic}
                                />
                                <MetadataItem
                                    icon={<GraduationCap size={16} />}
                                    label="Subtopic"
                                    value={question.subtopic}
                                />
                                <MetadataItem
                                    icon={<Target size={16} />}
                                    label="Difficulty"
                                    value={question.difficutly_level}
                                />
                                <MetadataItem
                                    icon={<Tag size={16} />}
                                    label="Question Type"
                                    value={getQuestionTypeLabel(question.question_type)}
                                />
                                <MetadataItem
                                    icon={<BookOpen size={16} />}
                                    label="Source"
                                    value={question.source}
                                />
                                {classLevel && (
                                    <MetadataItem
                                        icon={<GraduationCap size={16} />}
                                        label="Class Level"
                                        value={`Class ${classLevel}`}
                                    />
                                )}
                                {exams.length > 0 && (
                                    <MetadataItem
                                        icon={<Clock size={16} />}
                                        label="Exams"
                                        value={exams.join(", ")}
                                    />
                                )}

                                {/* Answer Key (for non-composite questions) */}
                                {!isComposite && answerKey.length > 0 && (
                                    <div style={{ marginTop: "24px" }}>
                                        <div
                                            style={{
                                                fontSize: "0.72rem",
                                                fontWeight: 700,
                                                color: "var(--text-tertiary)",
                                                textTransform: "uppercase",
                                                letterSpacing: "0.08em",
                                                marginBottom: "12px",
                                            }}
                                        >
                                            Answer Key
                                        </div>
                                        <div
                                            style={{
                                                padding: "12px 16px",
                                                borderRadius: "10px",
                                                background:
                                                    "rgba(var(--accent-success-rgb), 0.06)",
                                                border: "1px solid rgba(var(--accent-success-rgb), 0.15)",
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "10px",
                                            }}
                                        >
                                            <Hash
                                                size={16}
                                                style={{ color: "var(--accent-success)" }}
                                            />
                                            <span
                                                style={{
                                                    fontFamily:
                                                        "'JetBrains Mono', monospace",
                                                    fontSize: "0.9rem",
                                                    fontWeight: 600,
                                                    color: "var(--accent-success)",
                                                }}
                                            >
                                                {question.question_type ===
                                                    "Integer" ||
                                                    question.question_type ===
                                                    "Numerical" ||
                                                    question.question_type ===
                                                    "Single_Digit_Integer"
                                                    ? answerKey.join(", ")
                                                    : answerKey
                                                        .map((k) =>
                                                            String.fromCharCode(
                                                                64 + k
                                                            )
                                                        )
                                                        .join(", ")}
                                            </span>
                                        </div>
                                    </div>
                                )}

                                {/* Linked Questions section (for composite/passage) */}
                                {isComposite &&
                                    childQuestions &&
                                    childQuestions.length > 0 && (
                                        <div style={{ marginTop: "24px" }}>
                                            <div
                                                style={{
                                                    fontSize: "0.72rem",
                                                    fontWeight: 700,
                                                    color: "var(--text-tertiary)",
                                                    textTransform: "uppercase",
                                                    letterSpacing: "0.08em",
                                                    marginBottom: "12px",
                                                }}
                                            >
                                                Linked Questions (
                                                {childQuestions.length})
                                            </div>
                                            <div
                                                style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: "6px",
                                                }}
                                            >
                                                {childQuestions.map(
                                                    (child, idx) => (
                                                        <Link
                                                            key={
                                                                child.question_id
                                                            }
                                                            href={`/question/${child.question_id}`}
                                                            style={{
                                                                display: "flex",
                                                                alignItems:
                                                                    "center",
                                                                gap: "10px",
                                                                padding:
                                                                    "10px 14px",
                                                                borderRadius:
                                                                    "8px",
                                                                background:
                                                                    "var(--bg-tertiary)",
                                                                border: "1px solid var(--border-secondary)",
                                                                textDecoration:
                                                                    "none",
                                                                transition:
                                                                    "all 0.15s ease",
                                                            }}
                                                        >
                                                            <span
                                                                style={{
                                                                    fontSize:
                                                                        "0.72rem",
                                                                    fontWeight: 700,
                                                                    color: "var(--text-tertiary)",
                                                                    width: "20px",
                                                                }}
                                                            >
                                                                {idx + 1}.
                                                            </span>
                                                            <span
                                                                style={{
                                                                    fontSize:
                                                                        "0.72rem",
                                                                    fontFamily:
                                                                        "'JetBrains Mono', monospace",
                                                                    color: "var(--text-secondary)",
                                                                    flex: 1,
                                                                }}
                                                            >
                                                                {child.question_id.slice(
                                                                    0,
                                                                    12
                                                                )}
                                                                …
                                                            </span>
                                                            <Badge
                                                                label={getQuestionTypeLabel(
                                                                    child.question_type
                                                                )}
                                                                colors={
                                                                    QUESTION_TYPE_COLORS[
                                                                    child
                                                                        .question_type
                                                                    ] ||
                                                                    DEFAULT_BADGE_COLOR
                                                                }
                                                            />
                                                        </Link>
                                                    )
                                                )}
                                            </div>
                                        </div>
                                    )}

                                {/* Identifiers */}
                                <div style={{ marginTop: "24px" }}>
                                    <div
                                        style={{
                                            fontSize: "0.72rem",
                                            fontWeight: 700,
                                            color: "var(--text-tertiary)",
                                            textTransform: "uppercase",
                                            letterSpacing: "0.08em",
                                            marginBottom: "12px",
                                        }}
                                    >
                                        Identifiers
                                    </div>
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "8px",
                                        }}
                                    >
                                        <div
                                            style={{
                                                padding: "10px 14px",
                                                borderRadius: "8px",
                                                background: "var(--bg-tertiary)",
                                                border: "1px solid var(--border-secondary)",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontSize: "0.65rem",
                                                    color: "var(--text-muted)",
                                                    marginBottom: "2px",
                                                }}
                                            >
                                                Question ID
                                            </div>
                                            <div
                                                style={{
                                                    fontSize: "0.72rem",
                                                    fontFamily:
                                                        "'JetBrains Mono', monospace",
                                                    color: "var(--text-secondary)",
                                                    wordBreak: "break-all",
                                                }}
                                            >
                                                {question.question_id}
                                            </div>
                                        </div>
                                        {question.qbg_id && (
                                            <div
                                                style={{
                                                    padding: "10px 14px",
                                                    borderRadius: "8px",
                                                    background:
                                                        "var(--bg-tertiary)",
                                                    border: "1px solid var(--border-secondary)",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        fontSize: "0.65rem",
                                                        color: "var(--text-muted)",
                                                        marginBottom: "2px",
                                                    }}
                                                >
                                                    QBG ID
                                                </div>
                                                <div
                                                    style={{
                                                        fontSize: "0.72rem",
                                                        fontFamily:
                                                            "'JetBrains Mono', monospace",
                                                        color: "var(--text-secondary)",
                                                        wordBreak: "break-all",
                                                    }}
                                                >
                                                    {question.qbg_id}
                                                </div>
                                            </div>
                                        )}
                                        {question.parent_question_id && (
                                            <div
                                                style={{
                                                    padding: "10px 14px",
                                                    borderRadius: "8px",
                                                    background:
                                                        "var(--bg-tertiary)",
                                                    border: "1px solid var(--border-secondary)",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        fontSize: "0.65rem",
                                                        color: "var(--text-muted)",
                                                        marginBottom: "2px",
                                                    }}
                                                >
                                                    Parent Question
                                                </div>
                                                <Link
                                                    href={`/question/${question.parent_question_id}`}
                                                    style={{
                                                        fontSize: "0.72rem",
                                                        fontFamily:
                                                            "'JetBrains Mono', monospace",
                                                        color: "var(--accent-primary)",
                                                        textDecoration:
                                                            "underline",
                                                        textUnderlineOffset:
                                                            "2px",
                                                        wordBreak: "break-all",
                                                    }}
                                                >
                                                    {
                                                        question.parent_question_id
                                                    }
                                                </Link>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
