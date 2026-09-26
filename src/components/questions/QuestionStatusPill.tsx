"use client";

/**
 * Tiny coloured badge showing a question's QC workflow status.
 * Used in the questions list, the edit modal header, and the detail page.
 */
import React from "react";
import {
    QUESTION_STATUS_COLORS,
    QUESTION_STATUS_LABELS,
    QUESTION_STATUS_SHORT_LABELS,
    type QuestionStatus,
} from "@/types";

interface Props {
    status: QuestionStatus | null | undefined;
    /** Use the abbreviated label (for tight rows). Default: false (full label). */
    short?: boolean;
    style?: React.CSSProperties;
}

export default function QuestionStatusPill({ status, short = false, style }: Props) {
    const resolved: QuestionStatus = status ?? "verification_pending";
    const colors = QUESTION_STATUS_COLORS[resolved];
    const label = short
        ? QUESTION_STATUS_SHORT_LABELS[resolved]
        : QUESTION_STATUS_LABELS[resolved];

    return (
        <span
            title={QUESTION_STATUS_LABELS[resolved]}
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: colors.bg,
                color: colors.fg,
                border: `1px solid ${colors.fg}55`,
                fontSize: "0.7rem",
                fontWeight: 700,
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                letterSpacing: "0.01em",
                ...style,
            }}
        >
            <span
                style={{
                    display: "inline-block",
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: colors.fg,
                }}
            />
            {label}
        </span>
    );
}
