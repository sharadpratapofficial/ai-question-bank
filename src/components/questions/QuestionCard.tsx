"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Eye, Hash, BookOpen, Award, GraduationCap } from "lucide-react";
import type { Question } from "@/types";
import { normalizeAnswerKey, getQuestionTypeLabel } from "@/types";
import {
    SUBJECT_COLORS,
    DIFFICULTY_COLORS,
    QUESTION_TYPE_COLORS,
    DEFAULT_BADGE_COLOR,
} from "@/lib/constants";
import MathContent from "@/components/ui/MathContent";
import QuestionStatusPill from "@/components/questions/QuestionStatusPill";

interface QuestionCardProps {
    question: Question;
    index: number;
    expandForDetailsOnly?: boolean;
    displayNumber?: number;
    leadingControl?: ReactNode;
    trailingControl?: ReactNode;
    hideExamBadges?: boolean;
}

function Badge({
    label,
    colors,
}: {
    label: string;
    colors: { bg: string; text: string; border: string };
}) {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: "6px",
                fontSize: "0.7rem",
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

function isNumericalQuestionType(questionType: string): boolean {
    const normalized = String(questionType || "")
        .trim()
        .toLowerCase()
        .replace(/[\s()-]+/g, "_");
    return (
        normalized === "integer" ||
        normalized === "numerical" ||
        normalized === "single_digit_integer" ||
        normalized === "passage_numerical" ||
        normalized.includes("single_digit_integer") ||
        normalized.includes("passage_numerical")
    );
}

export default function QuestionCard({
    question,
    index,
    expandForDetailsOnly = false,
    displayNumber,
    leadingControl,
    trailingControl,
    hideExamBadges = false,
}: QuestionCardProps) {
    const [expanded, setExpanded] = useState(false);

    const subjectColor = SUBJECT_COLORS[question.subject] || DEFAULT_BADGE_COLOR;
    const diffColor = DIFFICULTY_COLORS[question.difficutly_level] || DEFAULT_BADGE_COLOR;
    const typeColor = QUESTION_TYPE_COLORS[question.question_type] || DEFAULT_BADGE_COLOR;

    const answerKey = normalizeAnswerKey(question.answer_key);
    const isNumericalType = isNumericalQuestionType(question.question_type);

    // Strip HTML for preview
    const plainText = question.question_text
        ?.replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();

    const previewText = plainText?.slice(0, 180);
    const showFullQuestion = expandForDetailsOnly || expanded;

    return (
        <div
            className="glass-card animate-fade-in"
            style={{
                animationDelay: `${index * 30}ms`,
                animationFillMode: "both",
            }}
        >
            {/* Header: always visible */}
            <div
                onClick={() => setExpanded(!expanded)}
                style={{
                    padding: "14px 16px",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                }}
            >
                {/* Top row: badges + expand icon */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                    }}
                >
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                        {leadingControl && (
                            <span
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    marginRight: "2px",
                                }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                {leadingControl}
                            </span>
                        )}
                        {displayNumber !== undefined && (
                            <span
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    padding: "2px 8px",
                                    borderRadius: "6px",
                                    fontSize: "0.72rem",
                                    fontWeight: 700,
                                    lineHeight: 1.5,
                                    whiteSpace: "nowrap",
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-secondary)",
                                    border: "1px solid var(--border-primary)",
                                }}
                            >
                                Q{displayNumber}
                            </span>
                        )}
                        {(() => {
                            let isAiVerified = false;
                            if (question.raw_data && Array.isArray(question.raw_data) && question.raw_data.length > 0) {
                                const rd = question.raw_data[0] as any;
                                if (rd?.ai_metadata?.verifications && Array.isArray(rd.ai_metadata.verifications)) {
                                    isAiVerified = rd.ai_metadata.verifications.some((v: any) => v.answerKeyVerified === true);
                                }
                            }
                            if (!isAiVerified) return null;
                            return (
                                <Badge
                                    label="AI Verified"
                                    colors={{
                                        bg: "rgba(16, 185, 129, 0.1)",
                                        text: "#10b981",
                                        border: "rgba(16, 185, 129, 0.3)",
                                    }}
                                />
                            );
                        })()}
                        {/* QC workflow status pill — colour-coded, sits leftmost */}
                        <QuestionStatusPill status={question.status} short />
                        <Badge label={question.subject} colors={subjectColor} />
                        <Badge
                            label={getQuestionTypeLabel(question.question_type)}
                            colors={typeColor}
                        />
                        {question.difficutly_level && (
                            <Badge label={question.difficutly_level} colors={diffColor} />
                        )}
                        {question.source && (
                            <Badge
                                label={question.source}
                                colors={{
                                    bg: "rgba(100, 100, 140, 0.1)",
                                    text: "var(--text-tertiary)",
                                    border: "var(--border-primary)",
                                }}
                            />
                        )}
                        {/* Exam badges */}
                        {!hideExamBadges &&
                            question.exam &&
                            question.exam.length > 0 &&
                            question.exam.map((ex) => (
                                <Badge
                                    key={ex}
                                    label={ex}
                                    colors={{
                                        bg: "rgba(168, 85, 247, 0.1)",
                                        text: "#c084fc",
                                        border: "rgba(168, 85, 247, 0.2)",
                                    }}
                                />
                            ))}
                        {/* Class level badge */}
                        {question.class_level && (
                            <Badge
                                label={`Class ${question.class_level}`}
                                colors={{
                                    bg: "rgba(14, 165, 233, 0.1)",
                                    text: "#38bdf8",
                                    border: "rgba(14, 165, 233, 0.2)",
                                }}
                            />
                        )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        <span
                            style={{
                                fontSize: "0.68rem",
                                color: "var(--text-secondary)",
                                fontFamily: "'JetBrains Mono', monospace",
                                maxWidth: "200px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                textAlign: "right",
                            }}
                        >
                            {question.chapter}
                        </span>
                        {trailingControl && (
                            <span
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                {trailingControl}
                            </span>
                        )}
                        {expanded ? (
                            <ChevronUp size={16} color="var(--text-tertiary)" />
                        ) : (
                            <ChevronDown size={16} color="var(--text-tertiary)" />
                        )}
                    </div>
                </div>

                {/* Question preview */}
                <div
                    style={{
                        fontSize: showFullQuestion ? "0.95rem" : "0.88rem",
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                        overflow: "hidden",
                    }}
                >
                    {!showFullQuestion && previewText && (
                        <span>
                            {previewText}
                            {(plainText?.length || 0) > 180 && (
                                <span style={{ color: "var(--text-muted)" }}>...</span>
                            )}
                        </span>
                    )}
                    {showFullQuestion && (
                        <MathContent
                            html={question.question_text}
                            className="question-html"
                        />
                    )}
                </div>
            </div>

            {/* Expanded content */}
            {expanded && (
                <div
                    style={{
                        padding: "0 16px 16px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "12px",
                        borderTop: "1px solid var(--border-secondary)",
                        paddingTop: "12px",
                    }}
                    className="animate-fade-in"
                >
                    {/* Options */}
                    {!isNumericalType &&
                        question.options &&
                        question.options.some((opt) => opt.text !== null) && (
                            <div>
                                <div
                                    style={{
                                        fontSize: "0.75rem",
                                        fontWeight: 600,
                                        color: "var(--text-tertiary)",
                                        marginBottom: "8px",
                                        textTransform: "uppercase",
                                        letterSpacing: "0.06em",
                                    }}
                                >
                                    Options
                                </div>
                                <div
                                    style={{
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
                                                    alignItems: "center",
                                                    gap: "10px",
                                                    padding: "10px 14px",
                                                    borderRadius: "8px",
                                                    background: isCorrect
                                                        ? "rgba(var(--accent-success-rgb), 0.08)"
                                                        : "var(--bg-tertiary)",
                                                    border: `1px solid ${isCorrect
                                                        ? "rgba(var(--accent-success-rgb), 0.2)"
                                                        : "var(--border-secondary)"
                                                        }`,
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        width: "22px",
                                                        height: "22px",
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
                                                    style={{ fontSize: "0.85rem", flex: 1 }}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                    {/* Answer (for Integer/Numerical) */}
                    {isNumericalType && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    padding: "7px 10px",
                                    borderRadius: "7px",
                                    background: "rgba(var(--accent-success-rgb), 0.08)",
                                    border: "1px solid rgba(var(--accent-success-rgb), 0.2)",
                                    width: "fit-content",
                                }}
                            >
                                <Hash size={13} color="var(--accent-success)" />
                                <span
                                    style={{
                                        fontSize: "0.76rem",
                                        fontWeight: 600,
                                        color: "var(--accent-success)",
                                    }}
                                >
                                    Answer: {answerKey.join(", ") || "-"}
                                </span>
                            </div>
                        )}

                    {/* Solution */}
                    {question.solution_text && (
                        <details>
                            <summary
                                style={{
                                    fontSize: "0.75rem",
                                    fontWeight: 600,
                                    color: "var(--accent-primary)",
                                    cursor: "pointer",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                    padding: "6px 0",
                                    userSelect: "none",
                                    listStyle: "none",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                }}
                            >
                                <Eye size={14} />
                                View Solution
                            </summary>
                            <MathContent
                                html={question.solution_text}
                                className="question-html"
                                style={{
                                    marginTop: "8px",
                                    padding: "14px",
                                    borderRadius: "8px",
                                    background: "var(--bg-tertiary)",
                                    border: "1px solid var(--border-secondary)",
                                }}
                            />
                        </details>
                    )}

                    {/* Metadata footer */}
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "16px",
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            paddingTop: "8px",
                            borderTop: "1px solid var(--border-secondary)",
                            flexWrap: "wrap",
                        }}
                    >
                        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            <BookOpen size={12} />
                            {question.chapter}
                        </span>
                        {question.topic && (
                            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <Award size={12} />
                                {question.topic}
                            </span>
                        )}
                        {question.subtopic && (
                            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <GraduationCap size={12} />
                                {question.subtopic}
                            </span>
                        )}
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto" }}>
                            <span
                                style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontSize: "0.65rem",
                                    color: "var(--text-muted)",
                                }}
                            >
                                {question.question_id.slice(0, 8)}
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
