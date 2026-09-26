"use client";

/**
 * Agentic QC — multi-agent quality-check for competitive-exam papers.
 *
 * UX flow:
 *   1. Pick an input mode: "all in one file" or "separate files".
 *   2. Upload the question paper (required) + answer key + solutions
 *      (both optional in separate mode; bundled in combined mode).
 *   3. Pick exam type (JEE Mains / NEET / JEE Advanced / Custom) and
 *      optionally provide a custom question-type sequence + syllabus.
 *   4. Configure 1-3 parallel QC agents (provider + model each) and 1
 *      aggregator agent (required).
 *   5. Submit → backend fires the QC agents in parallel, then the
 *      aggregator reconciles them into a final report.
 *   6. Final report shows per-question: each agent's answer, the
 *      provided answer key, the aggregator's independently re-derived
 *      final answer, figure flag, errors, solution feedback, and a
 *      manual-review flag with reason.
 *   7. Download the full report as JSON for archival.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    Bot,
    CheckCircle2,
    Download,
    FileSpreadsheet,
    FileText,
    Flag,
    Image as ImageIcon,
    Loader2,
    RefreshCw,
    Sparkles,
    Square,
    Trash2,
    XCircle,
    ExternalLink,
} from "lucide-react";
import type {
    JobRecord,
    JobQuestion,
    PerAgentQuestionResult,
} from "@/lib/agenticQC/jobStore";
import {
    downloadJobAsExcel,
    downloadJobAsHTML,
    downloadJobAsPDF,
    buildFilename,
    formatIST,
    computeConfidencePercent,
    difficultyLabel,
} from "@/lib/agenticQC/exports";
import { fullSyllabusFor, syllabusToText } from "@/lib/agenticQC/syllabus";
import { buildCostSummary, formatInr, formatTokens } from "@/lib/agenticQC/pricing";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";

/** QBG admin deep-link base — same URL the PDF report and the QBG panels use. */
const QBG_QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";
import { createClient } from "@/lib/supabase/client";
import {
    AI_PROVIDER_LABELS,
    AI_PROVIDER_MODELS,
    type AIModelProvider,
} from "@/types/extraction";
import { sanitizeUserApiKeys, readDevApiKeysFromStorage, providerNeedsApiKey, type UserApiKeys } from "@/lib/userApiKeys";
import {
    JEE_ADVANCED_PATTERN_MATRIX,
    type JeeAdvancedPaper,
} from "@/types";

// =============================================================================
//  TYPES (mirror the backend route)
// =============================================================================

/**
 * "NA" = No exam pattern. The agents just QC the questions as-is, with no
 * expected SCQ/Integer counts or per-section structure. This is the default
 * because most uploads don't follow a single canonical pattern.
 *
 * For JEE/NEET, a default per-subject distribution is applied (editable
 * by the user, just like the test-creation page).
 */
type ExamType = "NA" | "JEE_MAINS" | "NEET" | "JEE_ADVANCED" | "CUSTOM";

interface QTypeRow {
    type: string; // "Single_Choice(SCQ)" | "Multi_Choice(MCQ)" | "Integer" | "Numerical" | ...
    count: number;
    questionNumbers?: string; // optional human-readable range like "1-20"
}

interface ExamPatternConfig {
    examType: ExamType;
    /** For per-subject exams (JEE Mains / NEET / Custom). */
    perSubjectRows: Record<string, QTypeRow[]>;
    /** For JEE Advanced — picker for the year + selected papers + per-paper rows. */
    advYear?: string;
    advPapers?: JeeAdvancedPaper[];
    advRowsByPaper?: Record<JeeAdvancedPaper, QTypeRow[]>;
}

const QUESTION_TYPE_OPTIONS: { id: string; label: string }[] = [
    { id: "Single_Choice(SCQ)", label: "Single Choice (SCQ)" },
    { id: "Multi_Choice(MCQ)", label: "Multi Choice (MCQ)" },
    { id: "Integer", label: "Integer" },
    { id: "Numerical", label: "Numerical" },
    { id: "Single_Digit_Integer", label: "Single-Digit Integer" },
    { id: "Assertion_Reason", label: "Assertion-Reason" },
    { id: "Matching_List(ML)", label: "Matching List" },
    { id: "Passage_SCQ", label: "Passage SCQ" },
    { id: "Passage_Numerical", label: "Passage Numerical" },
];

interface AgentSlot {
    label: string; // "QC1" | "QC2" | "QC3"
    enabled: boolean;
    provider: AIModelProvider;
    modelId: string;
}

interface FileInput {
    fileBase64: string;
    fileName: string;
}

interface AgentVerdict {
    agentLabel: string;
    provider: string;
    modelId: string;
    answer: string | number | null;
    correctness: string;
    errorsFound: string[];
    solutionFeedback: string;
}

interface AggregatedQuestion {
    questionNumber: number;
    questionSummary: string;
    hasFigure: boolean;
    questionType: string;
    providedAnswerKey: string | number | null;
    agentAnswers: AgentVerdict[];
    finalAnswer: string | number | null;
    finalAnswerConfidence: "high" | "medium" | "low";
    agreementWithProvidedKey: boolean | null;
    needsManualReview: boolean;
    manualReviewReason: string | null;
    consolidatedErrors: string[];
    consolidatedSolutionFeedback: string;
    aggregatorRationale: string;
}

interface FinalReport {
    runId: string;
    createdAt: string;
    examType: ExamType;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    agents: { label: string; provider: string; modelId: string }[];
    aggregator: { label: string; provider: string; modelId: string };
    summary: {
        totalQuestions: number;
        flaggedForReview: number;
        answerKeyMismatches: number;
        questionsWithFigures: number;
        questionsWithErrors: number;
    };
    questions: AggregatedQuestion[];
    perAgentReports: {
        agent: { label: string; provider: string; modelId: string };
        report: unknown;
        error?: string;
    }[];
    aggregatorAnalysis: {
        patternAnalysis: string;
        syllabusAnalysis: string;
        overallSuggestions: string[];
    };
    /** Set when the aggregator failed but QC agents succeeded — the report
     *  was built by majority vote across agents rather than independent
     *  re-derivation. UI shows a warning banner in this case. */
    partial?: boolean;
    partialReason?: string;
}

// =============================================================================
//  CONSTANTS
// =============================================================================

const EXAM_TYPES: { id: ExamType; label: string; subjects: string[] }[] = [
    { id: "NA", label: "NA (no pattern check)", subjects: [] },
    { id: "JEE_MAINS", label: "JEE Mains", subjects: ["Physics", "Chemistry", "Mathematics"] },
    { id: "NEET", label: "NEET", subjects: ["Physics", "Chemistry", "Botany", "Zoology"] },
    { id: "JEE_ADVANCED", label: "JEE Advanced", subjects: ["Physics", "Chemistry", "Mathematics"] },
    { id: "CUSTOM", label: "Custom", subjects: [] },
];

/** Default JEE Mains per-subject rows. 20 SCQ + 5 Integer per subject. */
const DEFAULT_JEE_MAINS_ROWS: QTypeRow[] = [
    { type: "Single_Choice(SCQ)", count: 20, questionNumbers: "1-20" },
    { type: "Integer", count: 5, questionNumbers: "21-25" },
];

/** Default NEET per-subject rows. 45 SCQ. */
const DEFAULT_NEET_ROWS: QTypeRow[] = [
    { type: "Single_Choice(SCQ)", count: 45, questionNumbers: "1-45" },
];

function getDefaultRowsForExam(
    examType: ExamType,
    subjects: string[]
): Record<string, QTypeRow[]> {
    const out: Record<string, QTypeRow[]> = {};
    if (examType === "JEE_MAINS" || examType === "CUSTOM") {
        for (const s of subjects) out[s] = DEFAULT_JEE_MAINS_ROWS.map((r) => ({ ...r }));
    } else if (examType === "NEET") {
        for (const s of subjects) out[s] = DEFAULT_NEET_ROWS.map((r) => ({ ...r }));
    }
    return out;
}

/** JEE Advanced years available in the pattern matrix, newest first. */
const JEE_ADVANCED_YEARS = Object.keys(JEE_ADVANCED_PATTERN_MATRIX).sort(
    (a, b) => Number(b) - Number(a)
);
const JEE_ADVANCED_PAPERS: JeeAdvancedPaper[] = ["Paper 1", "Paper 2"];

function getAdvancedPatternRows(year: string, paper: JeeAdvancedPaper): QTypeRow[] {
    const rows = JEE_ADVANCED_PATTERN_MATRIX[year]?.[paper] || [];
    return rows.map((r) => ({
        type: r.type,
        count: r.count,
        questionNumbers: r.questionNumbers,
    }));
}

/**
 * Convert the editable pattern into the plain-text customQuestionTypeSequence
 * the executor passes to agents. Format:
 *   "Physics: 1-20 SCQ, 21-25 Integer; Chemistry: 1-20 SCQ, 21-25 Integer; ..."
 */
function patternToText(pattern: ExamPatternConfig): string {
    if (pattern.examType === "NA") return "";
    if (pattern.examType === "JEE_ADVANCED") {
        if (!pattern.advYear || !pattern.advPapers || !pattern.advRowsByPaper) return "";
        return pattern.advPapers
            .map((p) => {
                const rows = pattern.advRowsByPaper![p] || [];
                return `${p} (${pattern.advYear}): ` + rowsToText(rows);
            })
            .join("; ");
    }
    return Object.entries(pattern.perSubjectRows)
        .map(([subj, rows]) => `${subj}: ${rowsToText(rows)}`)
        .join("; ");
}

function rowsToText(rows: QTypeRow[]): string {
    return rows
        .map((r) =>
            r.questionNumbers ? `${r.questionNumbers} ${r.type}` : `${r.count} × ${r.type}`
        )
        .join(", ");
}

// All AI providers supported by the app's AI Tools — Agentic QC offers the
// same full list so any provider/model the user has a key for can run QC.
// (For PDF/Word uploads, prefer a vision-capable provider — gemini / openai /
// anthropic / openrouter / grok — since others may not read the file.)
const QC_CAPABLE_PROVIDERS: AIModelProvider[] = Object.keys(
    AI_PROVIDER_LABELS
) as AIModelProvider[];

// =============================================================================
//  HELPERS
// =============================================================================

function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.includes(",") ? result.split(",")[1] : result;
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function getModelOptionsFor(provider: AIModelProvider): { id: string; label: string }[] {
    return AI_PROVIDER_MODELS[provider] || [];
}

function defaultModelFor(provider: AIModelProvider): string {
    const opts = getModelOptionsFor(provider);
    return opts[0]?.id || "";
}

// =============================================================================
//  PATTERN EDITORS — inline editable question-type distribution
// =============================================================================

/**
 * Per-subject pattern editor for JEE Mains / NEET / Custom. One block per
 * subject, each with a small editable table of (type, count, optional Q#).
 *
 * The user can:
 *   - Change the count of an existing row
 *   - Change the question type via dropdown
 *   - Add / remove rows
 *
 * Matches the test-creation page's matrix in spirit but lighter-weight.
 */
function PatternEditorPerSubject({
    subjects,
    rows,
    onChange,
    examLabel,
}: {
    subjects: string[];
    rows: Record<string, QTypeRow[]>;
    onChange: (next: Record<string, QTypeRow[]>) => void;
    examLabel: string;
}) {
    const updateSubject = (subject: string, nextRows: QTypeRow[]) => {
        onChange({ ...rows, [subject]: nextRows });
    };
    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                <strong>{examLabel} expected pattern</strong> per subject — agents will check
                that each subject section matches these counts and flag mismatches.
            </div>
            {subjects.map((subj) => (
                <SubjectPatternBlock
                    key={subj}
                    subject={subj}
                    rows={rows[subj] || []}
                    onChange={(next) => updateSubject(subj, next)}
                />
            ))}
        </div>
    );
}

function SubjectPatternBlock({
    subject,
    rows,
    onChange,
}: {
    subject: string;
    rows: QTypeRow[];
    onChange: (next: QTypeRow[]) => void;
}) {
    const total = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    return (
        <div
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: 8,
                padding: "10px 12px",
                background: "var(--bg-tertiary)",
                display: "grid",
                gap: 6,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: "0.85rem" }}>{subject}</strong>
                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    {total} question{total === 1 ? "" : "s"}
                </span>
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={() =>
                        onChange([
                            ...rows,
                            { type: "Single_Choice(SCQ)", count: 5, questionNumbers: "" },
                        ])
                    }
                    style={{
                        background: "transparent",
                        border: "1px solid var(--border-primary)",
                        borderRadius: 6,
                        padding: "3px 8px",
                        fontSize: "0.72rem",
                        cursor: "pointer",
                        color: "var(--text-primary)",
                    }}
                >
                    + Row
                </button>
            </div>
            {rows.map((row, i) => (
                <div
                    key={i}
                    style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(180px, 2fr) 80px minmax(110px, 1fr) auto",
                        gap: 6,
                        alignItems: "center",
                    }}
                >
                    <select
                        value={row.type}
                        onChange={(e) => {
                            const next = [...rows];
                            next[i] = { ...next[i], type: e.target.value };
                            onChange(next);
                        }}
                        style={{ ...inputStyle(), padding: "5px 8px" }}
                    >
                        {QUESTION_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                    <input
                        type="number"
                        min={0}
                        value={row.count}
                        onChange={(e) => {
                            const next = [...rows];
                            next[i] = { ...next[i], count: Number(e.target.value) || 0 };
                            onChange(next);
                        }}
                        style={{ ...inputStyle(), padding: "5px 8px", textAlign: "center" }}
                    />
                    <input
                        type="text"
                        placeholder="Q# range (e.g. 1-20)"
                        value={row.questionNumbers || ""}
                        onChange={(e) => {
                            const next = [...rows];
                            next[i] = { ...next[i], questionNumbers: e.target.value };
                            onChange(next);
                        }}
                        style={{ ...inputStyle(), padding: "5px 8px" }}
                    />
                    <button
                        type="button"
                        onClick={() => onChange(rows.filter((_, j) => j !== i))}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-tertiary)",
                            cursor: "pointer",
                        }}
                        title="Remove row"
                    >
                        <Trash2 size={13} />
                    </button>
                </div>
            ))}
        </div>
    );
}

/**
 * JEE Advanced pattern editor — year picker, paper selector, and per-paper
 * row editor. The year drives default rows pulled from
 * JEE_ADVANCED_PATTERN_MATRIX; the user can then tweak counts.
 */
function PatternEditorJeeAdvanced({
    year,
    onYearChange,
    papers,
    onPapersChange,
    rowsByPaper,
    onRowsByPaperChange,
}: {
    year: string;
    onYearChange: (v: string) => void;
    papers: JeeAdvancedPaper[];
    onPapersChange: (next: JeeAdvancedPaper[]) => void;
    rowsByPaper: Record<JeeAdvancedPaper, QTypeRow[]>;
    onRowsByPaperChange: (next: Record<JeeAdvancedPaper, QTypeRow[]>) => void;
}) {
    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4 }}>
                    <Label>Pattern year</Label>
                    <select
                        value={year}
                        onChange={(e) => onYearChange(e.target.value)}
                        style={{ ...inputStyle(), padding: "5px 10px" }}
                    >
                        {JEE_ADVANCED_YEARS.map((y) => (
                            <option key={y} value={y}>
                                JEE Advanced {y}
                            </option>
                        ))}
                    </select>
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                    <Label>Papers in this upload</Label>
                    <div style={{ display: "flex", gap: 6 }}>
                        {JEE_ADVANCED_PAPERS.map((p) => {
                            const active = papers.includes(p);
                            return (
                                <button
                                    key={p}
                                    type="button"
                                    onClick={() =>
                                        onPapersChange(
                                            active
                                                ? papers.filter((x) => x !== p)
                                                : [...papers, p]
                                        )
                                    }
                                    style={pillStyle(active)}
                                >
                                    {p}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
            {papers.map((p) => (
                <SubjectPatternBlock
                    key={p}
                    subject={p}
                    rows={rowsByPaper[p] || []}
                    onChange={(next) => onRowsByPaperChange({ ...rowsByPaper, [p]: next })}
                />
            ))}
        </div>
    );
}

// =============================================================================
//  PAGE
// =============================================================================

export default function AgenticQCPage() {
    return (
        <RequirePermission permission="use_agentic_qc">
            <AgenticQCPageInner />
        </RequirePermission>
    );
}

function AgenticQCPageInner() {
    const router = useRouter();

    // Auth + saved keys
    const [userApiKeys, setUserApiKeys] = useState<UserApiKeys | null>(null);
    useEffect(() => {
        const supabase = createClient();
        void supabase.auth.getUser().then(({ data: { user } }) => {
            setUserApiKeys(sanitizeUserApiKeys(user?.user_metadata?.api_keys));
        });
    }, []);

    // Inputs
    const [inputMode, setInputMode] = useState<"combined" | "separate" | "structured" | "qbg">("structured");
    const [questionFile, setQuestionFile] = useState<File | null>(null);
    const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
    const [solutionFile, setSolutionFile] = useState<File | null>(null);
    // For structured (CSV/Excel) mode: the parsed result lives here. Parsing
    // happens client-side as soon as a file is dropped so we can show a preview.
    // The QBG-ids mode reuses this SAME state — it just obtains the parsed
    // questions from the live QBG API (via /api/agentic-qc/qbg-fetch) instead of
    // a CSV, then rides the identical structured-mode QC path.
    const [structuredFile, setStructuredFile] = useState<File | null>(null);
    const [structuredParse, setStructuredParse] = useState<{
        questions: import("@/lib/agenticQC/parseStructured").ParsedQuestion[];
        warnings: { rowIndex: number; message: string }[];
        subjects: string[];
        paperText: string;
    } | null>(null);
    const [structuredParseError, setStructuredParseError] = useState<string | null>(null);

    // QBG-ids mode: the pasted ids + live-fetch status.
    const [qbgIds, setQbgIds] = useState("");
    const [qbgFetching, setQbgFetching] = useState(false);
    const [qbgFetchError, setQbgFetchError] = useState<string | null>(null);
    const [qbgMissingIds, setQbgMissingIds] = useState<string[]>([]);

    // Exam config — defaults to "NA" so the agents just QC the questions
    // as-is, with no expected SCQ/Integer counts. The user can opt-in to a
    // specific exam pattern (JEE Mains / NEET / JEE Advanced) and edit the
    // per-subject question-type distribution inline.
    const [examType, setExamType] = useState<ExamType>("NA");
    const [testName, setTestName] = useState("");
    const [customQTypeSeq, setCustomQTypeSeq] = useState("");
    const [syllabusText, setSyllabusText] = useState("");
    // Default both class checkboxes to TRUE so a fresh user gets the full
    // Class 11 + 12 syllabus prefilled out of the box.
    const [fullSyllabusClass11, setFullSyllabusClass11] = useState(true);
    const [fullSyllabusClass12, setFullSyllabusClass12] = useState(true);

    // Editable per-subject question-type distribution (mirrors the test-creation
    // page's matrix). Hidden when examType === "NA". For JEE Advanced, we ALSO
    // track a year + selected papers picker that prefills from JEE_ADVANCED_PATTERN_MATRIX.
    const [perSubjectRows, setPerSubjectRows] = useState<Record<string, QTypeRow[]>>({});
    const [advYear, setAdvYear] = useState<string>(JEE_ADVANCED_YEARS[0] || "2025");
    const [advPapers, setAdvPapers] = useState<JeeAdvancedPaper[]>(["Paper 1", "Paper 2"]);
    const [advRowsByPaper, setAdvRowsByPaper] = useState<
        Record<JeeAdvancedPaper, QTypeRow[]>
    >({
        "Paper 1": getAdvancedPatternRows(JEE_ADVANCED_YEARS[0] || "2025", "Paper 1"),
        "Paper 2": getAdvancedPatternRows(JEE_ADVANCED_YEARS[0] || "2025", "Paper 2"),
    });
    // Subject selection — useful when the paper covers only one subject (e.g.
    // a Physics-only mock) or two (Physics + Chemistry combined). Defaults
    // adapt to the picked exam type but the user can override freely.
    const [subjects, setSubjects] = useState<string[]>(["Physics", "Chemistry", "Mathematics"]);

    // When the exam type changes, repopulate sensible default subjects.
    useEffect(() => {
        const defaultSubjects: Record<ExamType, string[]> = {
            NA: ["Physics", "Chemistry", "Mathematics"],
            JEE_MAINS: ["Physics", "Chemistry", "Mathematics"],
            JEE_ADVANCED: ["Physics", "Chemistry", "Mathematics"],
            NEET: ["Physics", "Chemistry", "Biology"],
            CUSTOM: ["Physics", "Chemistry", "Mathematics"],
        };
        setSubjects(defaultSubjects[examType]);
    }, [examType]);

    // Build the syllabus textarea from the canonical chapter lists, filtered to
    // ONLY the subjects selected for this paper. Re-runs when the class
    // checkboxes, exam type, or subject selection change — so picking just
    // "Physics" leaves only the Physics syllabus on screen (and in the report).
    useEffect(() => {
        const classes: Array<11 | 12> = [];
        if (fullSyllabusClass11) classes.push(11);
        if (fullSyllabusClass12) classes.push(12);
        if (classes.length === 0) return; // don't clobber user edits
        // "NA" maps to JEE Main (the closest superset) for syllabus purposes
        // since the chapter list itself is unaffected by the QC pattern.
        const family = examType === "NA" || examType === "CUSTOM" ? "JEE_MAINS" : examType;
        const bundle = fullSyllabusFor(family, classes);
        // Keep only the chapter lists for subjects the user actually selected.
        const filtered: Record<string, string[]> = {};
        for (const [subj, chs] of Object.entries(bundle)) {
            if (chs && chs.length > 0 && subjects.includes(subj)) filtered[subj] = chs;
        }
        setSyllabusText(syllabusToText(filtered));
    }, [fullSyllabusClass11, fullSyllabusClass12, examType, subjects]);

    // When exam type or subjects change, refresh the per-subject pattern rows
    // with the canonical defaults. Skips JEE Advanced (which has its own
    // year+paper picker) and NA (which doesn't use a pattern).
    useEffect(() => {
        if (examType === "NA" || examType === "JEE_ADVANCED") return;
        setPerSubjectRows(getDefaultRowsForExam(examType, subjects));
    }, [examType, subjects]);

    // When the JEE Advanced year changes, refresh per-paper rows.
    useEffect(() => {
        if (examType !== "JEE_ADVANCED") return;
        setAdvRowsByPaper({
            "Paper 1": getAdvancedPatternRows(advYear, "Paper 1"),
            "Paper 2": getAdvancedPatternRows(advYear, "Paper 2"),
        });
    }, [examType, advYear]);

    // Agent slots — QC1 required, QC2 + QC3 optional, all need provider + model.
    const [agents, setAgents] = useState<AgentSlot[]>([
        { label: "QC1", enabled: true, provider: "gemini", modelId: defaultModelFor("gemini") },
        { label: "QC2", enabled: false, provider: "openai", modelId: defaultModelFor("openai") },
        { label: "QC3", enabled: false, provider: "anthropic", modelId: defaultModelFor("anthropic") },
    ]);
    const [aggregator, setAggregator] = useState<AgentSlot>({
        label: "Aggregator",
        enabled: true,
        provider: "openai",
        modelId: defaultModelFor("openai"),
    });

    // Job state — replaces the old "report" + "running" model. The full
    // JobRecord is fetched from /api/agentic-qc/jobs/[id] on demand and kept
    // in sync via SSE so the per-question dashboard updates live.
    const [currentJobId, setCurrentJobId] = useState<string | null>(null);
    const [currentJob, setCurrentJob] = useState<JobRecord | null>(null);
    const [streamError, setStreamError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false); // POST in flight (pre-SSE)
    const [pastJobs, setPastJobs] = useState<
        Array<{
            id: string;
            label: string;
            status: string;
            createdAt: string;
            finishedAt?: string;
            totalQuestions: number;
            flaggedForReview: number;
            inputMode: string;
            partial?: boolean;
            fatalError?: string;
        }>
    >([]);
    const [pastJobsLoading, setPastJobsLoading] = useState(false);
    // Append-only log derived from incoming SSE events — kept short, sourced
    // from job.events on reconnect.
    const [logEntries, setLogEntries] = useState<
        {
            kind: "info" | "success" | "error" | "warning";
            message: string;
            timestamp: string;
            elapsedMs?: number;
        }[]
    >([]);

    // When `running` controls UI disable state, derive it from job status.
    const running =
        submitting ||
        (!!currentJob &&
            (currentJob.status === "queued" ||
                currentJob.status === "running" ||
                currentJob.status === "cancelling"));
    const error = streamError || currentJob?.fatalError || null;

    // ─── Past jobs list ─────────────────────────────────────────────────
    const refreshPastJobs = useCallback(async () => {
        setPastJobsLoading(true);
        try {
            const res = await fetch("/api/agentic-qc/jobs");
            const body = await res.json();
            if (body.success) setPastJobs(body.jobs || []);
        } catch {
            // silent — list is non-essential
        } finally {
            setPastJobsLoading(false);
        }
    }, []);
    useEffect(() => {
        void refreshPastJobs();
    }, [refreshPastJobs]);

    // ─── SSE subscription for the current job ───────────────────────────
    // Reconnects on job-id change AND on page mount (so leaving + returning
    // resumes the dashboard from where it was).
    const eventSourceRef = useRef<EventSource | null>(null);
    // Latches true once the job reaches a terminal state (done/failed/cancelled).
    // Used to ignore late/stale refetch responses that still say "running" —
    // without this guard, a slow in-flight GET issued just before completion can
    // resolve AFTER the terminal one and flip the UI back to "running" forever.
    const jobTerminalRef = useRef(false);
    useEffect(() => {
        if (!currentJobId) {
            setCurrentJob(null);
            return;
        }
        // Tear down any previous stream.
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        setStreamError(null);
        jobTerminalRef.current = false;

        const isTerminalStatus = (s: string | undefined) =>
            s === "done" || s === "failed" || s === "cancelled";

        const appendLog = (
            kind: "info" | "success" | "error" | "warning",
            message: string,
            elapsedMs?: number
        ) =>
            setLogEntries((prev) => {
                // Dedupe identical consecutive lines (SSE can replay events on
                // reconnect — the snapshot already includes them).
                const last = prev[prev.length - 1];
                if (
                    last &&
                    last.kind === kind &&
                    last.message === message &&
                    last.elapsedMs === elapsedMs
                ) {
                    return prev;
                }
                return [
                    ...prev,
                    {
                        kind,
                        message,
                        timestamp: new Date().toLocaleTimeString(),
                        elapsedMs,
                    },
                ];
            });

        const url = `/api/agentic-qc/jobs/${currentJobId}/stream`;
        const es = new EventSource(url);
        eventSourceRef.current = es;

        es.onmessage = (msg) => {
            let ev: Record<string, unknown>;
            try {
                ev = JSON.parse(msg.data);
            } catch {
                return;
            }
            const t = ev.type as string;
            if (t === "snapshot") {
                // Full job state on (re)connect.
                const job = ev.job as JobRecord;
                if (isTerminalStatus(job.status)) jobTerminalRef.current = true;
                setCurrentJob(job);
                // Reconnect succeeded — clear any "disconnected" banner. Also
                // clear it if the job already reached a terminal state so the
                // "reconnecting…" message doesn't linger after the job is done.
                setStreamError(null);
                if (isTerminalStatus(job.status)) void refreshPastJobs();
                return;
            }
            // For incremental events, refetch the job snapshot — keeps the
            // dashboard guaranteed-consistent with the disk state. This is one
            // extra request per event but the payload is small and the route
            // is in-process. (A future optimisation: apply event diffs in JS.)
            void fetch(`/api/agentic-qc/jobs/${currentJobId}`)
                .then((r) => r.json())
                .then((body) => {
                    if (!body?.job) return;
                    const fetched = body.job as JobRecord;
                    // Once the job is terminal, drop any stale read that still
                    // shows it running — it was issued before completion and
                    // would otherwise revert the UI to a never-ending "running".
                    if (jobTerminalRef.current && !isTerminalStatus(fetched.status)) {
                        return;
                    }
                    setCurrentJob(fetched);
                })
                .catch(() => {});

            // Friendly log lines — one per major event type.
            if (t === "started") {
                appendLog(
                    "info",
                    `Started — ${(ev.qcAgents as { label: string }[])?.length} agent(s), aggregator: ${(ev.aggregator as { modelId: string })?.modelId}`
                );
            } else if (t === "agent_started") {
                appendLog(
                    "info",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} → ${ev.label}`
                        : `→ ${ev.label} started`
                );
            } else if (t === "agent_completed") {
                appendLog(
                    "success",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} ✓ ${ev.label} → ${ev.answer ?? "(no answer)"}`
                        : `✓ ${ev.label} done`,
                    Number(ev.elapsedMs)
                );
            } else if (t === "agent_failed") {
                appendLog(
                    "error",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} ✗ ${ev.label} — ${ev.error}`
                        : `✗ ${ev.label} FAILED — ${ev.error}`,
                    Number(ev.elapsedMs)
                );
            } else if (t === "aggregator_started") {
                appendLog(
                    "info",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} → Aggregator`
                        : `→ Aggregator started`
                );
            } else if (t === "aggregator_completed") {
                appendLog(
                    "success",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} ✓ Final = ${ev.finalAnswer ?? "(none)"}`
                        : `✓ Aggregator done`,
                    Number(ev.elapsedMs)
                );
            } else if (t === "aggregator_failed") {
                appendLog(
                    "warning",
                    ev.questionNumber
                        ? `Q${ev.questionNumber} ⚠ Aggregator failed — vote fallback used`
                        : `⚠ Aggregator failed — vote fallback used`,
                    Number(ev.elapsedMs)
                );
            } else if (t === "aggregator_skipped") {
                appendLog(
                    "warning",
                    `Q${ev.questionNumber} skipped (all agents failed)`
                );
            } else if (t === "cancel_requested") {
                appendLog("warning", "Cancel requested — finishing in-flight calls…");
            } else if (t === "cancelled") {
                appendLog("warning", "Job cancelled.");
                jobTerminalRef.current = true;
                setStreamError(null);
                // Optimistically flip status so the UI leaves "running"
                // immediately, even before the refetch lands.
                setCurrentJob((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
                void refreshPastJobs();
            } else if (t === "complete") {
                appendLog("success", "✓ All questions processed.");
                setStreamError(null);
                // Latch terminal + optimistically mark done so the UI leaves
                // "running" the instant the event arrives — independent of the
                // refetch below, which can race / arrive out of order.
                jobTerminalRef.current = true;
                setCurrentJob((prev) => (prev ? { ...prev, status: "done" } : prev));
                // Delay the refetch slightly so flushPersist has time to write
                // the final question state to Supabase before we read it back —
                // otherwise the last question can still show "running".
                setTimeout(() => {
                    void fetch(`/api/agentic-qc/jobs/${currentJobId}`)
                        .then((r) => r.json())
                        .then((body) => {
                            if (!body?.job) return;
                            const fetched = body.job as JobRecord;
                            // The persisted snapshot may not have caught up to
                            // "done" yet (cross-instance Supabase write lag on
                            // Vercel). We KNOW the job completed — so take the
                            // fresh per-question data but never let a stale
                            // non-terminal status revert the UI to "running".
                            if (!isTerminalStatus(fetched.status)) {
                                setCurrentJob({ ...fetched, status: "done" });
                            } else {
                                setCurrentJob(fetched);
                            }
                        })
                        .catch(() => {});
                    void refreshPastJobs();
                }, 1500);
            } else if (t === "fatal_error") {
                appendLog("error", `Fatal: ${ev.error}`);
                setStreamError(String(ev.error));
                jobTerminalRef.current = true;
                setCurrentJob((prev) => (prev ? { ...prev, status: "failed" } : prev));
                void refreshPastJobs();
            } else if (t === "stream_end") {
                setStreamError(null);
                es.close();
                eventSourceRef.current = null;
            }
        };
        es.onerror = () => {
            // EventSource auto-reconnects; just surface the state.
            setStreamError("Live stream disconnected — reconnecting…");
        };

        return () => {
            es.close();
            eventSourceRef.current = null;
        };
    }, [currentJobId, refreshPastJobs]);

    // ─── Parse CSV / Excel as soon as the user picks a file ────────────
    useEffect(() => {
        if (inputMode !== "structured" || !structuredFile) {
            setStructuredParse(null);
            setStructuredParseError(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                setStructuredParseError(null);
                const buf = await structuredFile.arrayBuffer();
                const { parseStructuredPaper, buildSyntheticPaperText } = await import(
                    "@/lib/agenticQC/parseStructured"
                );
                const result = await parseStructuredPaper(buf, structuredFile.name);
                if (cancelled) return;
                if (result.questions.length === 0) {
                    setStructuredParseError(
                        result.warnings[0]?.message ||
                            "No questions could be parsed from this file. Check that the column names match (content / bilingual_options / solutions, or generic question / options / answer / solution)."
                    );
                    setStructuredParse(null);
                    return;
                }
                const paperText = buildSyntheticPaperText(result.questions);
                setStructuredParse({
                    questions: result.questions,
                    warnings: result.warnings,
                    subjects: result.subjects,
                    paperText,
                });
                // Auto-populate the subjects pills from what we detected.
                if (result.subjects.length > 0) {
                    setSubjects(result.subjects);
                }
            } catch (err) {
                if (cancelled) return;
                setStructuredParseError(
                    err instanceof Error ? err.message : String(err)
                );
                setStructuredParse(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [inputMode, structuredFile]);

    // Default the test name to the uploaded CSV/Excel file name (without its
    // extension) — only when the user hasn't already typed one, so manual edits
    // are never clobbered.
    useEffect(() => {
        if (inputMode !== "structured" || !structuredFile) return;
        const base = structuredFile.name.replace(/\.[^.]+$/, "").trim();
        if (base) setTestName((prev) => (prev.trim() ? prev : base));
    }, [inputMode, structuredFile]);

    // ─── QBG-ids: fetch live from QBG, adapt to the same parsed-question shape
    // the CSV path produces, then reuse the structured pipeline unchanged. ────
    const fetchQbgQuestions = useCallback(async () => {
        const ids = qbgIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) {
            setQbgFetchError("Paste at least one QBG unique_id.");
            return;
        }
        setQbgFetching(true);
        setQbgFetchError(null);
        setQbgMissingIds([]);
        try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            // Dev mode (no auth cookie): send the saved QBG creds so the route can
            // resolve them the same way the authenticated path does server-side.
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                headers["x-dev-qbg"] = readDevApiKeysFromStorage().qbg || "";
            }
            const res = await fetch("/api/agentic-qc/qbg-fetch", {
                method: "POST",
                headers,
                body: JSON.stringify({ qbgIds: qbgIds }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const questions = (data.questions || []) as import("@/lib/agenticQC/parseStructured").ParsedQuestion[];
            setStructuredParse({
                questions,
                warnings: (data.warnings || []).map((w: string, i: number) => ({ rowIndex: i, message: w })),
                subjects: data.subjects || [],
                paperText: "", // built server-side by the executor from parsedQuestions
            });
            setQbgMissingIds(data.missingIds || []);
            if (Array.isArray(data.subjects) && data.subjects.length > 0) {
                setSubjects(data.subjects);
            }
            if (!testName.trim()) {
                setTestName(`QBG · ${questions.length} question${questions.length === 1 ? "" : "s"}`);
            }
        } catch (err) {
            setStructuredParse(null);
            setQbgFetchError(err instanceof Error ? err.message : String(err));
        } finally {
            setQbgFetching(false);
        }
    }, [qbgIds, testName]);

    // Clear any previously-fetched result when the id list is edited, so a stale
    // fetch can't be submitted against a changed id list.
    useEffect(() => {
        if (inputMode !== "qbg") return;
        setStructuredParse(null);
        setQbgMissingIds([]);
        setQbgFetchError(null);
    }, [qbgIds, inputMode]);

    // ─── Validation ─────────────────────────────────────────────────────
    const validationError = useMemo((): string | null => {
        if (inputMode === "qbg") {
            if (qbgFetchError) return `Couldn't fetch QBG questions: ${qbgFetchError}`;
            if (!structuredParse || structuredParse.questions.length === 0) {
                return "Paste QBG ids and click “Fetch questions” first.";
            }
        } else if (inputMode === "structured") {
            if (!structuredFile) return "Upload a CSV or Excel file first.";
            if (structuredParseError) return `Couldn't parse file: ${structuredParseError}`;
            if (!structuredParse || structuredParse.questions.length === 0) {
                return "Parsing in progress — please wait a moment, or check that your file has a `content` / `question` column.";
            }
        } else {
            if (!questionFile) return "Upload a question paper first.";
            if (
                inputMode === "separate" &&
                !answerKeyFile &&
                !solutionFile
            ) {
                // Allowed — but warn at submit time, not block.
            }
        }
        const enabledAgents = agents.filter((a) => a.enabled);
        if (enabledAgents.length === 0) {
            return "Enable at least one QC agent (QC1 is required).";
        }
        for (const a of enabledAgents) {
            if (!a.modelId) return `Pick a model for ${a.label}.`;
            const key = userApiKeys?.[a.provider] || "";
            if (providerNeedsApiKey(a.provider) && !key) {
                return `Save an API key for ${AI_PROVIDER_LABELS[a.provider]} (used by ${a.label}) — open the user icon → Manage API Keys.`;
            }
        }
        if (!aggregator.modelId) return "Pick a model for the Aggregator.";
        const aggKey = userApiKeys?.[aggregator.provider] || "";
        if (providerNeedsApiKey(aggregator.provider) && !aggKey) {
            return `Save an API key for ${AI_PROVIDER_LABELS[aggregator.provider]} (used by Aggregator).`;
        }
        return null;
    }, [
        questionFile,
        agents,
        aggregator,
        userApiKeys,
        inputMode,
        answerKeyFile,
        solutionFile,
        structuredFile,
        structuredParse,
        structuredParseError,
        qbgFetchError,
    ]);

    const canRun = !running && !validationError;

    // ─── Submit ─────────────────────────────────────────────────────────
    // Kicks off a background job and switches the dashboard to live-stream
    // mode. The actual execution happens in the executor; this page only
    // observes via SSE.
    const handleRun = useCallback(async () => {
        // "qbg" rides the structured path — its questions were fetched live and
        // already sit in structuredParse, same as a CSV parse result.
        const isStructuredLike = inputMode === "structured" || inputMode === "qbg";
        if (isStructuredLike) {
            if (!structuredParse) return;
        } else {
            if (!questionFile) return;
        }
        setStreamError(null);
        setLogEntries([]);
        setCurrentJob(null);
        setSubmitting(true);
        try {
            const enabledAgents = agents.filter((a) => a.enabled);

            // Parse syllabus text into a structured object.
            const syllabus: Record<string, string[]> = {};
            if (syllabusText.trim()) {
                syllabusText.split(/[;\n]/).forEach((part) => {
                    const m = part.match(/^\s*([^:]+):\s*(.*)\s*$/);
                    if (!m) return;
                    const subj = m[1].trim();
                    const chapters = m[2].split(",").map((c) => c.trim()).filter(Boolean);
                    syllabus[subj] = chapters;
                });
            }

            const requestBody: Record<string, unknown> = {
                // The executor only knows combined / separate / structured — the
                // QBG-ids path is structured (its questions are already parsed).
                inputMode: inputMode === "qbg" ? "structured" : inputMode,
                qcAgents: enabledAgents.map((a) => ({
                    label: a.label,
                    provider: a.provider,
                    modelId: a.modelId,
                })),
                aggregator: {
                    label: aggregator.label,
                    provider: aggregator.provider,
                    modelId: aggregator.modelId,
                },
                // "NA" maps to undefined on the backend so the agent prompt
                // doesn't include any expected-pattern hint.
                examType: examType === "NA" ? undefined : examType,
                testName: testName.trim() || undefined,
                subjects: subjects.length > 0 ? subjects : undefined,
                // Build a single canonical sequence string for the executor.
                // - CUSTOM: free-form input from the textbox
                // - JEE Mains / NEET: per-subject rows (e.g. "Physics: 1-20 SCQ, 21-25 Integer; …")
                // - JEE Advanced: per-paper rows tied to the picked year
                customQuestionTypeSequence: (() => {
                    if (examType === "CUSTOM") return customQTypeSeq.trim() || undefined;
                    if (examType === "NA") return undefined;
                    const text = patternToText({
                        examType,
                        perSubjectRows,
                        advYear,
                        advPapers,
                        advRowsByPaper,
                    });
                    return text || undefined;
                })(),
                syllabus: Object.keys(syllabus).length > 0 ? syllabus : undefined,
            };

            if (isStructuredLike && structuredParse) {
                // Send the parsed per-question structure so the executor can do
                // per-question parallel dispatch.
                requestBody.parsedQuestions = structuredParse.questions;
                if (inputMode === "qbg") {
                    requestBody.sourceFileName = "QBG IDs";
                    requestBody.label = `QBG IDs · ${structuredParse.questions.length} Qs`;
                } else {
                    requestBody.sourceFileName = structuredFile?.name;
                    requestBody.label = `${structuredFile?.name || "Structured"} · ${structuredParse.questions.length} Qs`;
                }
            } else if (questionFile) {
                const [qBase64, akBase64, solBase64] = await Promise.all([
                    readFileAsBase64(questionFile),
                    answerKeyFile ? readFileAsBase64(answerKeyFile) : Promise.resolve(""),
                    solutionFile ? readFileAsBase64(solutionFile) : Promise.resolve(""),
                ]);
                requestBody.questionFile = {
                    fileBase64: qBase64,
                    fileName: questionFile.name,
                };
                if (inputMode === "separate") {
                    if (answerKeyFile && akBase64) {
                        requestBody.answerKeyFile = {
                            fileBase64: akBase64,
                            fileName: answerKeyFile.name,
                        };
                    }
                    if (solutionFile && solBase64) {
                        requestBody.solutionFile = {
                            fileBase64: solBase64,
                            fileName: solutionFile.name,
                        };
                    }
                }
                requestBody.label = questionFile.name;
            }

            const res = await fetch("/api/agentic-qc/jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            // Switch the dashboard to live-stream mode for the new job.
            setCurrentJobId(body.jobId);
            void refreshPastJobs();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStreamError(msg);
        } finally {
            setSubmitting(false);
        }
    }, [
        questionFile,
        answerKeyFile,
        solutionFile,
        structuredFile,
        structuredParse,
        inputMode,
        agents,
        aggregator,
        examType,
        testName,
        subjects,
        customQTypeSeq,
        syllabusText,
        perSubjectRows,
        advYear,
        advPapers,
        advRowsByPaper,
        refreshPastJobs,
    ]);

    // Stop the currently running job. Two-stage:
    //   1. POST /stop (graceful) — aborts in-flight LLM fetches via signal +
    //      flips status to "cancelling". Most jobs land in "cancelled" within
    //      a few seconds because every fetch is now sharing one abort signal
    //      plus a 4-min hard timeout.
    //   2. If after 8s the status is still not terminal, escalate to
    //      ?force=1 which slams the job state to "cancelled" regardless of
    //      whether the executor has confirmed.
    const handleStop = useCallback(async () => {
        if (!currentJobId) return;
        const jobId = currentJobId;
        setLogEntries((prev) => [
            ...prev,
            {
                kind: "warning",
                message: "Stop requested — aborting in-flight LLM calls…",
                timestamp: new Date().toLocaleTimeString(),
            },
        ]);
        try {
            const res = await fetch(`/api/agentic-qc/jobs/${jobId}/stop`, {
                method: "POST",
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
        } catch (err) {
            setLogEntries((prev) => [
                ...prev,
                {
                    kind: "error",
                    message: `Stop request failed: ${err instanceof Error ? err.message : String(err)}`,
                    timestamp: new Date().toLocaleTimeString(),
                },
            ]);
        }
        // After 8s, escalate if the server hasn't confirmed terminal state.
        setTimeout(async () => {
            try {
                const check = await fetch(`/api/agentic-qc/jobs/${jobId}`);
                const data = await check.json().catch(() => ({}));
                const status = data?.job?.status;
                if (status === "running" || status === "cancelling" || status === "queued") {
                    setLogEntries((prev) => [
                        ...prev,
                        {
                            kind: "warning",
                            message:
                                "Job still didn't stop after 8s — force-cancelling. The executor will keep unwinding in the background but the UI is now free.",
                            timestamp: new Date().toLocaleTimeString(),
                        },
                    ]);
                    await fetch(
                        `/api/agentic-qc/jobs/${jobId}/stop?force=1`,
                        { method: "POST" }
                    );
                    void refreshPastJobs();
                }
            } catch {
                // Best-effort. If we can't reach the server, the UI escape
                // hatch below ("Discard locally") lets the user move on.
            }
        }, 8000);
    }, [currentJobId, refreshPastJobs]);

    /**
     * Last-resort UI escape: clear the current job from the page without
     * touching the server. Used when the user just wants to move on and
     * doesn't care about server-side cleanup.
     */
    const handleDiscardLocal = useCallback(() => {
        if (!currentJobId) return;
        if (
            !confirm(
                "Stop showing this job and reset the page? The job may keep running on the server (use the 'Saved reports' panel to delete it if needed)."
            )
        )
            return;
        setCurrentJobId(null);
        setCurrentJob(null);
        setLogEntries([]);
    }, [currentJobId]);

    // Open a past job in the dashboard (read-only view of a completed run).
    const openPastJob = useCallback((jobId: string) => {
        setCurrentJobId(jobId);
        setLogEntries([]);
        setStreamError(null);
    }, []);

    // Delete a past job from the saved list.
    const handleDeleteJob = useCallback(
        async (jobId: string) => {
            if (!confirm("Delete this QC report permanently?")) return;
            await fetch(`/api/agentic-qc/jobs/${jobId}`, { method: "DELETE" });
            if (currentJobId === jobId) {
                setCurrentJobId(null);
                setCurrentJob(null);
            }
            void refreshPastJobs();
        },
        [currentJobId, refreshPastJobs]
    );

    const handleDownloadJSON = useCallback(() => {
        if (!currentJob) return;
        const blob = new Blob([JSON.stringify(currentJob, null, 2)], {
            type: "application/json",
        });
        triggerDownload(blob, buildFilename(currentJob, "json"));
    }, [currentJob]);

    /** CSV — one row per question. Same column order as before. */
    const handleDownloadCSV = useCallback(() => {
        if (!currentJob) return;
        const escape = (v: unknown): string => {
            if (v === null || v === undefined) return "";
            const s = String(v);
            if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };
        const agentLabels = ["QC1", "QC2", "QC3"] as const;
        const agentModels = new Map<string, string>();
        for (const a of currentJob.qcAgents) {
            agentModels.set(a.label, `${a.provider}/${a.modelId}`);
        }
        const headers = [
            "Q#",
            "QBG ID",
            "Subject",
            "Chapter",
            "Topic",
            "Difficulty",
            "Provided Answer Key",
            "Has Diagram",
            "Video Solution",
            "Text Solution Present",
            `QC1 Answer${agentModels.get("QC1") ? ` (${agentModels.get("QC1")})` : ""}`,
            `QC2 Answer${agentModels.get("QC2") ? ` (${agentModels.get("QC2")})` : ""}`,
            `QC3 Answer${agentModels.get("QC3") ? ` (${agentModels.get("QC3")})` : ""}`,
            `Final Answer (${currentJob.aggregator.provider}/${currentJob.aggregator.modelId})`,
            "Confidence %",
            "Confidence",
            "Needs Manual Review",
            "Manual Review Reason",
            "Errors",
            "Solution Feedback",
            "Aggregator Rationale",
            "Question Summary",
        ];
        const rows = currentJob.questions.map((q) => {
            const answerByLabel = new Map<string, string>();
            for (const ar of q.agentResults) {
                if (ar.status === "failed") {
                    answerByLabel.set(ar.label, `ERROR: ${ar.error || ""}`);
                } else {
                    answerByLabel.set(ar.label, ar.answer === null ? "" : String(ar.answer));
                }
            }
            return [
                q.questionNumber,
                q.qbgId ?? "",
                q.subject ?? "",
                q.chapter ?? "",
                q.topic ?? "",
                difficultyLabel(q.difficulty),
                q.providedAnswerKey ?? "",
                q.hasFigure ? "Yes" : "No",
                q.hasVideoSolution ? "Yes" : "No",
                q.solutionText && q.solutionText.trim() ? "Yes" : "No",
                ...agentLabels.map((lbl) => answerByLabel.get(lbl) ?? ""),
                q.aggregator.finalAnswer ?? "",
                `${computeConfidencePercent(q)}%`,
                q.aggregator.confidence,
                q.aggregator.needsManualReview ? "Yes" : "No",
                q.aggregator.manualReviewReason ?? "",
                q.aggregator.consolidatedErrors.join(" | "),
                q.aggregator.consolidatedSolutionFeedback,
                q.aggregator.rationale,
                q.questionSummary,
            ];
        });
        // Model legend at the top so each QC agent + the aggregator model is
        // clearly identified without the cost / token-usage block (omitted per
        // requirement).
        const modelLegend = [
            ...currentJob.qcAgents.map((a) => `${a.label}: ${a.provider}/${a.modelId}`),
            `Aggregator: ${currentJob.aggregator.provider}/${currentJob.aggregator.modelId}`,
        ].join("  |  ");
        const csv =
            `Models used,${escape(modelLegend)}` +
            "\n\n" +
            headers.map(escape).join(",") +
            "\n" +
            rows.map((r) => r.map(escape).join(",")).join("\n");

        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
        triggerDownload(blob, buildFilename(currentJob, "csv"));
    }, [currentJob]);

    const handleDownloadExcel = useCallback(() => {
        if (!currentJob) return;
        downloadJobAsExcel(currentJob);
    }, [currentJob]);

    /** The same report as a web page. Unlike the PDF, its QBG ids are ordinary
     *  links, so they open in a new tab instead of replacing the report. */
    const handleDownloadHTML = useCallback(() => {
        if (!currentJob) return;
        downloadJobAsHTML(currentJob);
    }, [currentJob]);

    /** PDF download is async — fetches diagram images and embeds them. Shows
     *  a brief "Generating PDF…" indicator via a transient state flag. */
    const [generatingPdf, setGeneratingPdf] = useState(false);
    const handleDownloadPDF = useCallback(async () => {
        if (!currentJob) return;
        setGeneratingPdf(true);
        try {
            await downloadJobAsPDF(currentJob);
        } finally {
            setGeneratingPdf(false);
        }
    }, [currentJob]);

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar
                activeTab="agentic-qc"
                onTabChange={(tab) => {
                    if (tab === "questions") router.push("/questions");
                    else if (tab === "tests") router.push("/tests");
                    else if (tab === "analytics") router.push("/analytics");
                    else if (tab === "upload") router.push("/upload");
                    else if (tab === "ai") router.push("/ai-tools");
                    else if (tab === "admin") router.push("/admin/users");
                    else if (tab === "qbg") router.push("/qbg");
                    else if (tab === "video-solution") router.push("/video-solution");
                    else if (tab === "question-wise-videos") router.push("/question-wise-videos");
                    else if (tab === "circuit-designer") router.push("/circuit-designer");
                }}
            />

            <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <header
                    style={{
                        padding: "16px 24px",
                        borderBottom: "1px solid var(--border-primary)",
                        background: "var(--bg-secondary)",
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                    }}
                >
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 10,
                            background: "var(--accent-glow)",
                            color: "var(--accent-primary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <Bot size={20} />
                    </div>
                    <div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>Agentic QC</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                            1–3 parallel AI reviewers + 1 aggregator that re-derives the final answer key.
                        </div>
                    </div>
                </header>

                <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 36px" }}>
                    <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gap: "16px" }}>
                        {/* ──── 1. Inputs ──── */}
                        <Section
                            title="1. Upload paper"
                            subtitle="PDF / Word with the questions, OR a structured CSV / Excel with one row per question."
                        >
                            <div style={{ display: "grid", gap: "10px" }}>
                                <ToggleGroup
                                    label="Input mode"
                                    value={inputMode}
                                    onChange={(v) =>
                                        setInputMode(v as "combined" | "separate" | "structured" | "qbg")
                                    }
                                    options={[
                                        { id: "structured", label: "Structured table (CSV / Excel — one row per question)" },
                                        { id: "qbg", label: "QBG IDs (fetch questions live from QBG)" },
                                        { id: "separate", label: "Separate files (question / answer key / solutions)" },
                                        { id: "combined", label: "Single file (everything inside one PDF/DOCX)" },
                                    ]}
                                />

                                {inputMode === "structured" ? (
                                    <StructuredUploader
                                        file={structuredFile}
                                        onChange={setStructuredFile}
                                        parse={structuredParse}
                                        error={structuredParseError}
                                    />
                                ) : inputMode === "qbg" ? (
                                    <QbgIdsInput
                                        ids={qbgIds}
                                        onChange={setQbgIds}
                                        onFetch={fetchQbgQuestions}
                                        fetching={qbgFetching}
                                        error={qbgFetchError}
                                        fetchedCount={structuredParse?.questions.length ?? 0}
                                        missingIds={qbgMissingIds}
                                    />
                                ) : (
                                    <>
                                        <FilePicker
                                            label={
                                                inputMode === "combined"
                                                    ? "Combined paper file"
                                                    : "Question paper"
                                            }
                                            required
                                            file={questionFile}
                                            onChange={setQuestionFile}
                                        />

                                        {inputMode === "separate" && (
                                            <>
                                                <FilePicker
                                                    label="Answer key (optional)"
                                                    hint="If skipped, agents still run QC but cannot cross-check against a provided key."
                                                    file={answerKeyFile}
                                                    onChange={setAnswerKeyFile}
                                                />
                                                <FilePicker
                                                    label="Solutions (optional)"
                                                    hint="Needed for solution-quality critique."
                                                    file={solutionFile}
                                                    onChange={setSolutionFile}
                                                />
                                            </>
                                        )}
                                    </>
                                )}
                            </div>
                        </Section>

                        {/* ──── 2. Exam config ──── */}
                        <Section
                            title="2. Exam config"
                            subtitle="Tells the agents what pattern / syllabus to evaluate against. All fields optional except exam type."
                        >
                            <div style={{ display: "grid", gap: "10px" }}>
                                <div style={{ display: "grid", gap: "4px" }}>
                                    <Label>Test name (optional)</Label>
                                    <input
                                        type="text"
                                        value={testName}
                                        onChange={(e) => setTestName(e.target.value)}
                                        placeholder="e.g. Vishwas Series — JEE/BITSAT Test 1 (Physics)"
                                        style={inputStyle()}
                                    />
                                </div>
                                <div style={{ display: "grid", gap: "4px" }}>
                                    <Label>Exam type</Label>
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                        {EXAM_TYPES.map((opt) => {
                                            const active = examType === opt.id;
                                            return (
                                                <button
                                                    key={opt.id}
                                                    type="button"
                                                    onClick={() => setExamType(opt.id)}
                                                    style={pillStyle(active)}
                                                >
                                                    {opt.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {examType === "CUSTOM" && (
                                    <div style={{ display: "grid", gap: "4px" }}>
                                        <Label>Question-type sequence (free-form)</Label>
                                        <input
                                            type="text"
                                            value={customQTypeSeq}
                                            onChange={(e) => setCustomQTypeSeq(e.target.value)}
                                            placeholder="e.g. 1-20: SCQ, 21-25: Integer, 26-30: MCQ"
                                            style={inputStyle()}
                                        />
                                    </div>
                                )}

                                {/* Per-subject question-type pattern editor — appears for
                                    JEE Mains / NEET / JEE Advanced. Mirrors the test-creation
                                    matrix so the user can adjust counts before kicking off QC.
                                    Hidden in "NA" mode and "Custom" mode (which uses a free-form
                                    string instead). */}
                                {(examType === "JEE_MAINS" || examType === "NEET") && (
                                    <PatternEditorPerSubject
                                        subjects={subjects}
                                        rows={perSubjectRows}
                                        onChange={setPerSubjectRows}
                                        examLabel={
                                            examType === "JEE_MAINS"
                                                ? "JEE Mains"
                                                : "NEET"
                                        }
                                    />
                                )}
                                {examType === "JEE_ADVANCED" && (
                                    <PatternEditorJeeAdvanced
                                        year={advYear}
                                        onYearChange={setAdvYear}
                                        papers={advPapers}
                                        onPapersChange={setAdvPapers}
                                        rowsByPaper={advRowsByPaper}
                                        onRowsByPaperChange={setAdvRowsByPaper}
                                    />
                                )}
                                {examType === "NA" && (
                                    <div
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            background: "var(--bg-tertiary)",
                                            borderRadius: 8,
                                            padding: "8px 12px",
                                            fontSize: "0.78rem",
                                            color: "var(--text-tertiary)",
                                        }}
                                    >
                                        <strong>NA mode:</strong> no expected pattern. Agents will
                                        QC each question on its own merits — answer correctness,
                                        errors, ambiguity, solution feedback — without checking
                                        SCQ/Integer counts. Pick a specific exam type to enable
                                        pattern verification.
                                    </div>
                                )}

                                {/* Subjects + syllabus combined into ONE section: the syllabus
                                    textarea below updates live to match the subjects and the
                                    Class 11/12 selection above it. Useful for single-subject
                                    papers (e.g. a Physics-only mock) or combined papers. */}
                                <div style={{ display: "grid", gap: "4px" }}>
                                    <Label>Subjects &amp; syllabus in this paper</Label>
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                        {[
                                            "Physics",
                                            "Chemistry",
                                            "Mathematics",
                                            "Biology",
                                            "Botany",
                                            "Zoology",
                                        ].map((subj) => {
                                            const active = subjects.includes(subj);
                                            return (
                                                <button
                                                    key={subj}
                                                    type="button"
                                                    onClick={() => {
                                                        setSubjects((prev) =>
                                                            active
                                                                ? prev.filter((s) => s !== subj)
                                                                : [...prev, subj]
                                                        );
                                                    }}
                                                    style={pillStyle(active)}
                                                >
                                                    {subj}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <span style={hintStyle}>
                                        Click to toggle the subjects present in your paper. The
                                        syllabus below updates automatically to show only the
                                        selected subjects for the chosen class(es).
                                    </span>
                                    <span
                                        style={{
                                            fontSize: "0.75rem",
                                            fontWeight: 600,
                                            color: "var(--text-secondary)",
                                            marginTop: 6,
                                        }}
                                    >
                                        Syllabus (auto-filled from selected subjects — editable)
                                    </span>
                                    {/* Quick-toggle full-syllabus presets. Maps to the canonical
                                        JEE Main / NEET / CBSE NCERT chapter list for the picked
                                        exam type and class. Either / both can be on; uncheck both
                                        to leave the textarea fully editable. */}
                                    <div
                                        style={{
                                            display: "flex",
                                            gap: 8,
                                            flexWrap: "wrap",
                                            marginBottom: 4,
                                        }}
                                    >
                                        {[
                                            { id: 11, label: "Full Syllabus Class 11", on: fullSyllabusClass11, toggle: () => setFullSyllabusClass11((v) => !v) },
                                            { id: 12, label: "Full Syllabus Class 12", on: fullSyllabusClass12, toggle: () => setFullSyllabusClass12((v) => !v) },
                                        ].map((opt) => (
                                            <label
                                                key={opt.id}
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: 6,
                                                    padding: "5px 10px",
                                                    borderRadius: 999,
                                                    border: `1px solid ${opt.on ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: opt.on ? "var(--accent-glow)" : "var(--bg-tertiary)",
                                                    color: opt.on ? "var(--accent-primary)" : "var(--text-primary)",
                                                    fontSize: "0.78rem",
                                                    cursor: "pointer",
                                                    userSelect: "none",
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={opt.on}
                                                    onChange={opt.toggle}
                                                    style={{ accentColor: "var(--accent-primary)" }}
                                                />
                                                {opt.label}
                                            </label>
                                        ))}
                                        {(fullSyllabusClass11 || fullSyllabusClass12) && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setFullSyllabusClass11(false);
                                                    setFullSyllabusClass12(false);
                                                    setSyllabusText("");
                                                }}
                                                style={{
                                                    background: "transparent",
                                                    border: "1px solid var(--border-primary)",
                                                    color: "var(--text-tertiary)",
                                                    borderRadius: 999,
                                                    padding: "5px 10px",
                                                    fontSize: "0.75rem",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Clear
                                            </button>
                                        )}
                                    </div>
                                    <textarea
                                        value={syllabusText}
                                        onChange={(e) => setSyllabusText(e.target.value)}
                                        placeholder={
                                            "Format: Subject: chapter1, chapter2; Subject: chapter1, chapter2\n" +
                                            "Example: Physics: Kinematics, Laws of Motion; Chemistry: Bonding"
                                        }
                                        rows={4}
                                        style={{ ...inputStyle(), resize: "vertical", fontFamily: "ui-monospace, monospace" }}
                                    />
                                    <span style={hintStyle}>
                                        Agents will check each question against the listed chapters and flag mismatches.
                                        Class 11/12 checkboxes fill in the canonical{" "}
                                        {examType === "NEET" ? "NEET" : "JEE Main / CBSE NCERT"} chapter list.
                                    </span>
                                </div>
                            </div>
                        </Section>

                        {/* ──── 3. Agents ──── */}
                        <Section
                            title="3. Configure parallel QC agents"
                            subtitle="QC1 is required. Enable QC2/QC3 to get 2- or 3-way cross-checks. Each runs in parallel."
                        >
                            <div style={{ display: "grid", gap: "10px" }}>
                                {agents.map((slot, idx) => (
                                    <AgentSlotRow
                                        key={slot.label}
                                        slot={slot}
                                        required={idx === 0}
                                        userApiKeys={userApiKeys}
                                        onChange={(next) =>
                                            setAgents((prev) => {
                                                const copy = [...prev];
                                                copy[idx] = next;
                                                return copy;
                                            })
                                        }
                                    />
                                ))}

                                <div
                                    style={{
                                        marginTop: "8px",
                                        padding: "12px 14px",
                                        borderRadius: "10px",
                                        border: "1px solid var(--accent-primary)",
                                        background: "var(--accent-glow)",
                                        display: "grid",
                                        gap: "8px",
                                    }}
                                >
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <Sparkles size={14} color="var(--accent-primary)" />
                                        <strong style={{ fontSize: "0.86rem", color: "var(--accent-primary)" }}>
                                            Aggregator (final decision)
                                        </strong>
                                    </div>
                                    <div style={hintStyle}>
                                        Reads the paper again + every QC agent's verdict, re-derives each answer
                                        independently, and produces the consolidated report. Flags any disagreement
                                        for manual review.
                                    </div>
                                    <AgentSlotRow
                                        slot={aggregator}
                                        required
                                        hideEnableToggle
                                        userApiKeys={userApiKeys}
                                        onChange={(next) => setAggregator(next)}
                                    />
                                </div>
                            </div>
                        </Section>

                        {/* ──── 4. Run + status ──── */}
                        {validationError && (
                            <NoticeBox kind="warn">
                                <AlertCircle size={14} /> {validationError}
                            </NoticeBox>
                        )}
                        {error && (
                            <NoticeBox kind="err">
                                <XCircle size={14} /> {error}
                            </NoticeBox>
                        )}

                        {/* Single morphing button:
                              - Idle / done → Bot icon + "Run Agentic QC"
                              - Running    → Stop icon + progress + click cancels
                              - Cancelling → click again = force-stop now
                            This avoids confusion from having Run + Stop side-by-side. */}
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
                            {currentJobId && currentJob && (currentJob.status === "running" || currentJob.status === "cancelling") && (
                                <button
                                    type="button"
                                    onClick={handleDiscardLocal}
                                    style={{
                                        background: "transparent",
                                        color: "var(--text-tertiary)",
                                        border: "1px dashed var(--border-primary)",
                                        borderRadius: 6,
                                        padding: "6px 12px",
                                        fontSize: "0.78rem",
                                        cursor: "pointer",
                                    }}
                                    title="Stop showing this job (server may keep running it in the background)."
                                >
                                    Discard locally
                                </button>
                            )}
                            {(() => {
                                const isCancelling = currentJob?.status === "cancelling";
                                const isRunning = running && !isCancelling;
                                const progressDone =
                                    currentJob?.questions.filter(
                                        (q) =>
                                            q.aggregator.status === "done" ||
                                            q.aggregator.status === "failed" ||
                                            q.aggregator.status === "skipped"
                                    ).length ?? 0;
                                const progressTotal = currentJob?.questions.length ?? 0;

                                let icon: React.ReactNode;
                                let label: string;
                                let onClick: () => void;
                                let disabled = false;
                                let style: React.CSSProperties = primaryButton(canRun);

                                if (isCancelling) {
                                    // Clicking again escalates to force-stop.
                                    icon = <Square size={14} fill="currentColor" />;
                                    label = "Cancelling… click to force-stop";
                                    onClick = async () => {
                                        if (!currentJobId) return;
                                        await fetch(
                                            `/api/agentic-qc/jobs/${currentJobId}/stop?force=1`,
                                            { method: "POST" }
                                        );
                                        void refreshPastJobs();
                                    };
                                    disabled = false;
                                    style = {
                                        ...primaryButton(true),
                                        background: "rgba(245, 158, 11, 0.15)",
                                        color: "#b45309",
                                        border: "1px solid #f59e0b",
                                    };
                                } else if (isRunning && currentJobId) {
                                    icon = <Square size={14} fill="currentColor" />;
                                    label = progressTotal
                                        ? `Stop  ·  ${progressDone}/${progressTotal} done`
                                        : "Stop";
                                    onClick = handleStop;
                                    style = {
                                        ...primaryButton(true),
                                        background: "rgba(239, 68, 68, 0.12)",
                                        color: "var(--accent-danger)",
                                        border: "1px solid var(--accent-danger)",
                                    };
                                } else {
                                    icon = <Bot size={14} />;
                                    label =
                                        currentJob &&
                                        (currentJob.status === "done" ||
                                            currentJob.status === "cancelled" ||
                                            currentJob.status === "failed")
                                            ? "Run another Agentic QC"
                                            : "Run Agentic QC";
                                    onClick = handleRun;
                                    disabled = !canRun;
                                }
                                return (
                                    <button
                                        type="button"
                                        onClick={onClick}
                                        disabled={disabled}
                                        style={style}
                                        title={
                                            isRunning
                                                ? "Stop the running job. In-flight LLM calls are aborted immediately."
                                                : isCancelling
                                                ? "Stopping… in-flight calls are being torn down."
                                                : "Run Agentic QC with the configured agents."
                                        }
                                    >
                                        {icon}
                                        {label}
                                    </button>
                                );
                            })()}
                        </div>

                        {/* Live per-question dashboard — updates as agents + aggregator
                            finish each question. Hidden until a job is selected. */}
                        {currentJob && (
                            <LiveDashboard
                                job={currentJob}
                                onDownloadCSV={handleDownloadCSV}
                                onDownloadExcel={handleDownloadExcel}
                                onDownloadPDF={handleDownloadPDF}
                                onDownloadHTML={handleDownloadHTML}
                                onDownloadJSON={handleDownloadJSON}
                                generatingPdf={generatingPdf}
                            />
                        )}

                        {/* Live event log — populated by SSE events. */}
                        {(running || logEntries.length > 0) && (
                            <LogPanel entries={logEntries} running={running} />
                        )}

                        {/* Past jobs — collapsible list of previous saved runs.
                            Click to reopen + re-download. */}
                        <PastJobsPanel
                            jobs={pastJobs}
                            loading={pastJobsLoading}
                            activeJobId={currentJobId}
                            onOpen={openPastJob}
                            onDelete={handleDeleteJob}
                            onRefresh={refreshPastJobs}
                        />
                    </div>
                </div>
            </main>
        </div>
    );
}

// =============================================================================
//  PRESENTATIONAL COMPONENTS
// =============================================================================

function Section({
    title,
    subtitle,
    children,
}: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
}) {
    return (
        <section
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: "12px",
                padding: "16px 18px",
                background: "var(--bg-secondary)",
                display: "grid",
                gap: "12px",
            }}
        >
            <div style={{ display: "grid", gap: "2px" }}>
                <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text-primary)" }}>{title}</div>
                {subtitle && (
                    <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>{subtitle}</div>
                )}
            </div>
            {children}
        </section>
    );
}

function Label({ children }: { children: React.ReactNode }) {
    return (
        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
            {children}
        </span>
    );
}

function FilePicker({
    label,
    required,
    hint,
    file,
    onChange,
}: {
    label: string;
    required?: boolean;
    hint?: string;
    file: File | null;
    onChange: (f: File | null) => void;
}) {
    return (
        <div style={{ display: "grid", gap: "4px" }}>
            <Label>
                {label}
                {required && <span style={{ color: "var(--accent-danger)", marginLeft: 4 }}>*</span>}
            </Label>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: "1px dashed var(--border-primary)",
                    background: "var(--bg-tertiary)",
                }}
            >
                <FileText size={14} color="var(--text-tertiary)" />
                <input
                    type="file"
                    accept=".pdf,.docx,.doc"
                    onChange={(e) => onChange(e.target.files?.[0] || null)}
                    style={{ flex: 1, fontSize: "0.8rem", color: "var(--text-primary)" }}
                />
                {file && (
                    <button
                        type="button"
                        onClick={() => onChange(null)}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-tertiary)",
                            cursor: "pointer",
                        }}
                        title="Remove file"
                    >
                        <Trash2 size={14} />
                    </button>
                )}
            </div>
            {hint && <span style={hintStyle}>{hint}</span>}
            {file && (
                <span style={{ ...hintStyle, color: "var(--accent-success, #22c55e)" }}>
                    ✓ {file.name} · {(file.size / 1024).toFixed(0)} KB
                </span>
            )}
        </div>
    );
}

/**
 * Specialised uploader for CSV / Excel structured papers. Shows a parse
 * preview (count, subjects detected, sample question, warnings) so the user
 * can confirm the extraction looks right before running QC.
 */
function StructuredUploader({
    file,
    onChange,
    parse,
    error,
}: {
    file: File | null;
    onChange: (f: File | null) => void;
    parse: {
        questions: import("@/lib/agenticQC/parseStructured").ParsedQuestion[];
        warnings: { rowIndex: number; message: string }[];
        subjects: string[];
        paperText: string;
    } | null;
    error: string | null;
}) {
    return (
        <div style={{ display: "grid", gap: "8px" }}>
            <Label>
                CSV / Excel file
                <span style={{ color: "var(--accent-danger)", marginLeft: 4 }}>*</span>
            </Label>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: "1px dashed var(--border-primary)",
                    background: "var(--bg-tertiary)",
                }}
            >
                <FileText size={14} color="var(--text-tertiary)" />
                <input
                    type="file"
                    accept=".csv,.tsv,.xlsx,.xls,.ods"
                    onChange={(e) => onChange(e.target.files?.[0] || null)}
                    style={{ flex: 1, fontSize: "0.8rem", color: "var(--text-primary)" }}
                />
                {file && (
                    <button
                        type="button"
                        onClick={() => onChange(null)}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-tertiary)",
                            cursor: "pointer",
                        }}
                        title="Remove file"
                    >
                        <Trash2 size={14} />
                    </button>
                )}
            </div>
            <span style={hintStyle}>
                Expected columns (PW QBG export):{" "}
                <code>content</code> · <code>bilingual_options</code> ·{" "}
                <code>solutions</code> · <code>answer</code> ·{" "}
                <code>examDetails</code>. Generic names also work:{" "}
                <code>question</code> / <code>options</code> / <code>solution</code> /{" "}
                <code>answer</code>. For SCQ the answer is taken from the option
                with <code>isCorrect: true</code>. Hindi / other-language fields
                are ignored — only English is sent to the agents. Diagram URLs
                inside the HTML are extracted and flagged for the agents.
            </span>

            {file && (
                <span
                    style={{
                        ...hintStyle,
                        color: error ? "var(--accent-danger)" : "var(--accent-success, #22c55e)",
                    }}
                >
                    {error ? "✗" : "✓"} {file.name} · {(file.size / 1024).toFixed(0)} KB
                </span>
            )}

            {error && (
                <div
                    style={{
                        border: "1px solid var(--accent-danger)",
                        background: "rgba(239, 68, 68, 0.08)",
                        color: "var(--accent-danger)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        fontSize: "0.78rem",
                    }}
                >
                    {error}
                </div>
            )}

            {parse && parse.questions.length > 0 && (
                <div
                    style={{
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-tertiary)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        display: "grid",
                        gap: "6px",
                        fontSize: "0.78rem",
                    }}
                >
                    <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
                        <span>
                            <strong>{parse.questions.length}</strong> questions parsed
                        </span>
                        <span>
                            <strong>
                                {
                                    parse.questions.filter((q) => q.imageUrls.length > 0)
                                        .length
                                }
                            </strong>{" "}
                            with diagram refs
                        </span>
                        <span>
                            <strong>
                                {parse.questions.filter((q) => q.questionType === "SCQ").length}
                            </strong>{" "}
                            SCQ ·{" "}
                            <strong>
                                {parse.questions.filter((q) => q.questionType === "MCQ").length}
                            </strong>{" "}
                            MCQ ·{" "}
                            <strong>
                                {
                                    parse.questions.filter(
                                        (q) =>
                                            q.questionType === "Numerical" ||
                                            q.questionType === "Integer"
                                    ).length
                                }
                            </strong>{" "}
                            numerical
                        </span>
                        {parse.subjects.length > 0 && (
                            <span>
                                Subjects: <strong>{parse.subjects.join(", ")}</strong>
                            </span>
                        )}
                    </div>

                    {/* Chapter distribution + class 11/12 split — compact two-column. */}
                    {(() => {
                        const chapterCounts = new Map<string, number>();
                        let class11 = 0;
                        let class12 = 0;
                        let classOther = 0;
                        for (const q of parse.questions) {
                            const ch = (q.chapter || "(unspecified)").trim() || "(unspecified)";
                            chapterCounts.set(ch, (chapterCounts.get(ch) || 0) + 1);
                            const k = (q.klass || "").toString();
                            if (/\b11\b|xi(?![a-z])/i.test(k)) class11++;
                            else if (/\b12\b|xii/i.test(k)) class12++;
                            else classOther++;
                        }
                        const chapters = Array.from(chapterCounts.entries()).sort(
                            (a, b) => b[1] - a[1]
                        );
                        const hasClassInfo = class11 + class12 > 0;
                        return (
                            <div style={{ display: "grid", gap: 6 }}>
                                {hasClassInfo && (
                                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                                        <span>
                                            Class 11: <strong>{class11}</strong>
                                        </span>
                                        <span>
                                            Class 12: <strong>{class12}</strong>
                                        </span>
                                        {classOther > 0 && (
                                            <span style={{ color: "var(--text-tertiary)" }}>
                                                Other / unspecified: <strong>{classOther}</strong>
                                            </span>
                                        )}
                                    </div>
                                )}
                                <div>
                                    <div
                                        style={{
                                            fontSize: "0.72rem",
                                            color: "var(--text-tertiary)",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Questions per chapter ({chapters.length} chapter
                                        {chapters.length === 1 ? "" : "s"})
                                    </div>
                                    <div
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns: "1fr 1fr",
                                            columnGap: 16,
                                            rowGap: 2,
                                        }}
                                    >
                                        {chapters.map(([ch, count]) => (
                                            <div
                                                key={ch}
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    gap: 8,
                                                    fontSize: "0.74rem",
                                                    borderBottom: "1px solid var(--border-primary)",
                                                    padding: "1px 0",
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                    title={ch}
                                                >
                                                    {ch}
                                                </span>
                                                <strong>{count}</strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {parse.warnings.length > 0 && (
                        <div style={{ color: "var(--accent-warning, #f59e0b)" }}>
                            ⚠ {parse.warnings.length} row(s) skipped:{" "}
                            {parse.warnings
                                .slice(0, 3)
                                .map((w) => `row ${w.rowIndex}`)
                                .join(", ")}
                            {parse.warnings.length > 3 ? ", …" : ""}
                        </div>
                    )}
                    <details style={{ marginTop: 4 }}>
                        <summary
                            style={{
                                cursor: "pointer",
                                color: "var(--text-tertiary)",
                                fontSize: "0.75rem",
                            }}
                        >
                            Preview first question
                        </summary>
                        <pre
                            style={{
                                marginTop: 6,
                                padding: 10,
                                background: "var(--bg-primary)",
                                borderRadius: 6,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: 220,
                                overflow: "auto",
                                fontSize: "0.72rem",
                                lineHeight: 1.45,
                            }}
                        >
                            {(() => {
                                const q = parse.questions[0];
                                const parts: string[] = [];
                                parts.push(`Q1. [${q.subject}${q.chapter ? " · " + q.chapter : ""}]`);
                                parts.push(q.questionText.slice(0, 400));
                                if (q.imageUrls.length > 0) {
                                    parts.push("\nDiagram refs:");
                                    for (const u of q.imageUrls.slice(0, 3)) parts.push("  • " + u);
                                }
                                if (q.options.length > 0) {
                                    parts.push("\nOptions:");
                                    for (const o of q.options) {
                                        parts.push(
                                            `  ${o.label}) ${o.text.slice(0, 120)}${o.isCorrect ? "  ← correct" : ""}`
                                        );
                                    }
                                }
                                parts.push(`\nType: ${q.questionType} · Answer key: ${q.correctAnswer || "(none)"}`);
                                if (q.solutionText) {
                                    parts.push("\nSolution: " + q.solutionText.slice(0, 200));
                                }
                                return parts.join("\n");
                            })()}
                        </pre>
                    </details>
                </div>
            )}
        </div>
    );
}

function QbgIdsInput({
    ids,
    onChange,
    onFetch,
    fetching,
    error,
    fetchedCount,
    missingIds,
}: {
    ids: string;
    onChange: (v: string) => void;
    onFetch: () => void;
    fetching: boolean;
    error: string | null;
    fetchedCount: number;
    missingIds: string[];
}) {
    const idCount = ids.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).length;
    return (
        <div style={{ display: "grid", gap: "8px" }}>
            <Label>
                QBG unique_ids
                <span style={{ color: "var(--accent-danger)", marginLeft: 4 }}>*</span>
            </Label>
            <textarea
                value={ids}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Paste QBG unique_ids — comma, space, or newline separated"
                rows={5}
                style={{ ...inputStyle(), fontFamily: "monospace", resize: "vertical", minHeight: 90 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <button
                    type="button"
                    onClick={onFetch}
                    disabled={fetching || idCount === 0}
                    style={{
                        ...pillStyle(true),
                        opacity: fetching || idCount === 0 ? 0.55 : 1,
                        cursor: fetching || idCount === 0 ? "default" : "pointer",
                    }}
                >
                    {fetching ? "Fetching…" : `Fetch questions${idCount ? ` (${idCount})` : ""}`}
                </button>
                {fetchedCount > 0 && !fetching && (
                    <span style={{ ...hintStyle, color: "var(--accent-success, #22c55e)" }}>
                        ✓ {fetchedCount} question{fetchedCount === 1 ? "" : "s"} fetched from QBG
                    </span>
                )}
            </div>
            <span style={hintStyle}>
                Questions are fetched live from QBG using your saved QBG credentials (user icon →
                Manage API Keys → QBG API). They&rsquo;re QC&rsquo;d exactly like a CSV upload — same
                agents, same report.
            </span>

            {error && (
                <div
                    style={{
                        border: "1px solid var(--accent-danger)",
                        background: "rgba(239, 68, 68, 0.08)",
                        color: "var(--accent-danger)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        fontSize: "0.78rem",
                    }}
                >
                    {error}
                </div>
            )}

            {missingIds.length > 0 && (
                <div
                    style={{
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-tertiary)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        fontSize: "0.75rem",
                        color: "var(--text-tertiary)",
                    }}
                >
                    {missingIds.length} id{missingIds.length === 1 ? "" : "s"} not found in QBG (skipped):{" "}
                    <code style={{ wordBreak: "break-all" }}>{missingIds.join(", ")}</code>
                </div>
            )}
        </div>
    );
}

function ToggleGroup<T extends string>({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: T;
    onChange: (v: T) => void;
    options: { id: T; label: string }[];
}) {
    return (
        <div style={{ display: "grid", gap: "4px" }}>
            <Label>{label}</Label>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {options.map((opt) => {
                    const active = value === opt.id;
                    return (
                        <button
                            key={opt.id}
                            type="button"
                            onClick={() => onChange(opt.id)}
                            style={pillStyle(active)}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AgentSlotRow({
    slot,
    required,
    hideEnableToggle,
    userApiKeys,
    onChange,
}: {
    slot: AgentSlot;
    required?: boolean;
    hideEnableToggle?: boolean;
    userApiKeys: UserApiKeys | null;
    onChange: (next: AgentSlot) => void;
}) {
    const models = getModelOptionsFor(slot.provider);
    const keyMissing =
        slot.enabled &&
        providerNeedsApiKey(slot.provider) &&
        !(userApiKeys?.[slot.provider]);

    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "minmax(110px,140px) 1fr 1fr",
                gap: "8px",
                alignItems: "center",
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid var(--border-primary)",
                background: slot.enabled ? "var(--bg-tertiary)" : "transparent",
                opacity: slot.enabled ? 1 : 0.6,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {!hideEnableToggle && !required && (
                    <input
                        type="checkbox"
                        checked={slot.enabled}
                        onChange={(e) => onChange({ ...slot, enabled: e.target.checked })}
                    />
                )}
                <strong style={{ fontSize: "0.84rem", color: "var(--text-primary)" }}>{slot.label}</strong>
                {required && (
                    <span
                        style={{
                            fontSize: "0.66rem",
                            color: "var(--accent-danger)",
                            fontWeight: 700,
                        }}
                    >
                        required
                    </span>
                )}
            </div>
            <select
                value={slot.provider}
                onChange={(e) => {
                    const next = e.target.value as AIModelProvider;
                    onChange({ ...slot, provider: next, modelId: defaultModelFor(next) });
                }}
                style={inputStyle()}
                disabled={!slot.enabled}
            >
                {QC_CAPABLE_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                        {AI_PROVIDER_LABELS[p]}
                    </option>
                ))}
            </select>
            <ModelPicker
                provider={slot.provider}
                modelId={slot.modelId}
                disabled={!slot.enabled}
                onChange={(modelId) => onChange({ ...slot, modelId })}
                options={models}
            />
            {keyMissing && (
                <div style={{ gridColumn: "1 / -1", fontSize: "0.72rem", color: "var(--accent-warning, #f59e0b)" }}>
                    ⚠ No saved API key for {AI_PROVIDER_LABELS[slot.provider]} — open the user icon → Manage API Keys.
                </div>
            )}
        </div>
    );
}

/**
 * Model picker with a "✎ Custom model ID..." fallback. Latest models often
 * arrive faster than we update the hardcoded list — this lets the user paste
 * any model name supported by their provider (especially relevant for
 * OpenRouter's huge catalog and OpenAI's frequent releases).
 */
const CUSTOM_MODEL_SENTINEL = "__custom__";

/**
 * Derive a grouping key for a model option so the dropdown can cluster models
 * from the same vendor together. OpenRouter ids are "<vendor>/<model>"
 * (e.g. "anthropic/claude-sonnet-4.5"); some lists carry "Vendor: Model"
 * labels instead. Falls back to a single "Models" group.
 */
function modelGroupOf(o: { id: string; label: string }): string {
    if (o.id.includes("/")) return o.id.split("/")[0];
    if (o.label.includes(":")) return o.label.split(":")[0].trim();
    return "Models";
}

/** A single clickable option row with hover highlight (inline styles can't :hover). */
function ModelOptionRow({
    label,
    title,
    active,
    onPick,
}: {
    label: string;
    title?: string;
    active: boolean;
    onPick: () => void;
}) {
    const [hover, setHover] = useState(false);
    return (
        <div
            onClick={onPick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title={title}
            style={{
                padding: "7px 12px",
                fontSize: "0.8rem",
                cursor: "pointer",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: active ? "var(--accent-primary)" : "var(--text-primary)",
                background: active
                    ? "var(--accent-glow)"
                    : hover
                    ? "var(--bg-tertiary)"
                    : "transparent",
            }}
        >
            {label}
        </div>
    );
}

/**
 * Searchable, provider-grouped model dropdown. Replaces a native <select>
 * (which can't filter a 170-model OpenRouter list). Type to filter by model
 * name OR provider (e.g. "d" surfaces DeepSeek); options are grouped under a
 * sticky vendor header. The "Custom model ID" choice is pinned at the top.
 */
function SearchableModelSelect({
    value,
    options,
    placeholder,
    disabled,
    onPick,
}: {
    /** Current modelId, or CUSTOM_MODEL_SENTINEL when in custom mode. */
    value: string;
    options: { id: string; label: string }[];
    placeholder?: string;
    disabled?: boolean;
    /** Called with a model id, or CUSTOM_MODEL_SENTINEL for the custom row. */
    onPick: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);

    const selectedLabel =
        value === CUSTOM_MODEL_SENTINEL
            ? "Custom model ID…"
            : options.find((o) => o.id === value)?.label || value || "";

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const byGroup = new Map<string, { id: string; label: string }[]>();
        for (const o of options) {
            if (q) {
                const g = modelGroupOf(o).toLowerCase();
                if (
                    !o.id.toLowerCase().includes(q) &&
                    !o.label.toLowerCase().includes(q) &&
                    !g.includes(q)
                ) {
                    continue;
                }
            }
            const g = modelGroupOf(o);
            const arr = byGroup.get(g) || [];
            arr.push(o);
            byGroup.set(g, arr);
        }
        return Array.from(byGroup.entries())
            .map(([group, items]) => ({
                group,
                items: items.sort((a, b) => a.label.localeCompare(b.label)),
            }))
            .sort((a, b) => a.group.localeCompare(b.group));
    }, [options, query]);

    const totalShown = groups.reduce((n, g) => n + g.items.length, 0);

    return (
        <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button
                type="button"
                disabled={disabled}
                onClick={() => {
                    if (disabled) return;
                    setQuery("");
                    setOpen((o) => !o);
                }}
                style={{
                    ...inputStyle(),
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "6px",
                    cursor: disabled ? "default" : "pointer",
                }}
            >
                <span
                    style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: selectedLabel ? "var(--text-primary)" : "var(--text-tertiary)",
                    }}
                >
                    {selectedLabel || placeholder || "— pick a model —"}
                </span>
                <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>▾</span>
            </button>
            {open && (
                <div
                    style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        right: 0,
                        zIndex: 50,
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "8px",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                        maxHeight: "320px",
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                    }}
                >
                    <div style={{ padding: "6px", borderBottom: "1px solid var(--border-primary)" }}>
                        <input
                            autoFocus
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={`Search ${options.length} models — name or provider…`}
                            style={{ ...inputStyle(), width: "100%" }}
                        />
                    </div>
                    <div style={{ overflowY: "auto" }}>
                        <ModelOptionRow
                            label="✎ Custom model ID…"
                            active={value === CUSTOM_MODEL_SENTINEL}
                            onPick={() => {
                                onPick(CUSTOM_MODEL_SENTINEL);
                                setOpen(false);
                            }}
                        />
                        {totalShown === 0 && (
                            <div
                                style={{
                                    padding: "10px 12px",
                                    fontSize: "0.78rem",
                                    color: "var(--text-tertiary)",
                                }}
                            >
                                No models match “{query}”.
                            </div>
                        )}
                        {groups.map((g) => (
                            <div key={g.group}>
                                <div
                                    style={{
                                        padding: "4px 10px",
                                        fontSize: "0.66rem",
                                        fontWeight: 700,
                                        letterSpacing: "0.04em",
                                        textTransform: "uppercase",
                                        color: "var(--text-tertiary)",
                                        background: "var(--bg-tertiary)",
                                        position: "sticky",
                                        top: 0,
                                    }}
                                >
                                    {g.group}
                                </div>
                                {g.items.map((o) => (
                                    <ModelOptionRow
                                        key={o.id}
                                        label={o.label}
                                        title={o.id}
                                        active={value === o.id}
                                        onPick={() => {
                                            onPick(o.id);
                                            setOpen(false);
                                        }}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ModelPicker({
    provider,
    modelId,
    options,
    disabled,
    onChange,
}: {
    provider: AIModelProvider;
    modelId: string;
    options: { id: string; label: string }[];
    disabled?: boolean;
    onChange: (modelId: string) => void;
}) {
    // Live-fetched models (per provider, cached in component state). When
    // populated, these REPLACE the curated `options` list.
    const [liveModels, setLiveModels] = useState<Record<string, { id: string; label: string }[]>>({});
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);

    // Use live models if we've fetched them for this provider, else fall back
    // to the curated list.
    const effectiveOptions = liveModels[provider] || options;

    // Auto-detect "custom" mode: if the current modelId isn't in the active
    // list, treat it as a custom one and show the text input.
    const isInList = effectiveOptions.some((o) => o.id === modelId);
    const startCustom = Boolean(modelId) && !isInList;
    const [usingCustom, setUsingCustom] = useState(startCustom);

    useEffect(() => {
        if (modelId && !isInList) setUsingCustom(true);
    }, [modelId, isInList]);

    // Clear any provider-specific error when the user switches providers.
    useEffect(() => {
        setRefreshError(null);
    }, [provider]);

    const handleRefresh = useCallback(async () => {
        setRefreshError(null);
        setRefreshing(true);
        try {
            const res = await fetch(
                `/api/agentic-qc/models?provider=${encodeURIComponent(provider)}`,
                { cache: "no-store" }
            );
            const body = (await res.json()) as {
                success?: boolean;
                models?: { id: string; label: string }[];
                error?: string;
            };
            if (!res.ok || !body.success) {
                throw new Error(body.error || `Status ${res.status}`);
            }
            const models = body.models || [];
            setLiveModels((prev) => ({ ...prev, [provider]: models }));
        } catch (err) {
            setRefreshError(err instanceof Error ? err.message : String(err));
        } finally {
            setRefreshing(false);
        }
    }, [provider]);

    return (
        <div style={{ display: "grid", gap: "4px" }}>
            <div style={{ display: "flex", gap: "4px" }}>
                <SearchableModelSelect
                    value={usingCustom ? CUSTOM_MODEL_SENTINEL : modelId}
                    options={effectiveOptions}
                    disabled={disabled}
                    onPick={(id) => {
                        if (id === CUSTOM_MODEL_SENTINEL) {
                            setUsingCustom(true);
                        } else {
                            setUsingCustom(false);
                            onChange(id);
                        }
                    }}
                />
                <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={disabled || refreshing}
                    title={
                        liveModels[provider]
                            ? `Live list (${liveModels[provider].length} models). Click to refetch.`
                            : `Fetch the live model list from ${provider}'s /v1/models endpoint.`
                    }
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "4px",
                        padding: "0 10px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-primary)",
                        background: liveModels[provider]
                            ? "var(--accent-glow)"
                            : "var(--bg-tertiary)",
                        color: liveModels[provider]
                            ? "var(--accent-primary)"
                            : "var(--text-secondary)",
                        cursor: disabled || refreshing ? "default" : "pointer",
                        fontSize: "0.74rem",
                        fontWeight: 600,
                    }}
                >
                    {refreshing ? (
                        <Loader2 size={12} className="animate-spin" />
                    ) : (
                        <RefreshCw size={12} />
                    )}
                    {liveModels[provider]
                        ? `Live (${liveModels[provider].length})`
                        : "Refresh"}
                </button>
            </div>
            {usingCustom && (
                <input
                    type="text"
                    value={modelId}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={
                        provider === "openrouter"
                            ? "e.g. anthropic/claude-sonnet-4.5, openai/gpt-5"
                            : provider === "openai"
                            ? "e.g. gpt-5.5, o4-mini, gpt-4o"
                            : provider === "anthropic"
                            ? "e.g. claude-sonnet-4-5-20250929"
                            : provider === "gemini"
                            ? "e.g. gemini-2.5-pro"
                            : "Paste exact model ID from provider's docs"
                    }
                    style={inputStyle()}
                    disabled={disabled}
                />
            )}
            {refreshError && (
                <span
                    style={{
                        fontSize: "0.7rem",
                        color: "var(--accent-warning, #f59e0b)",
                    }}
                >
                    Refresh failed: {refreshError}
                </span>
            )}
        </div>
    );
}

/**
 * Console-style log panel that streams the SSE events as they arrive. The
 * panel auto-scrolls to the latest entry so the user can keep an eye on
 * which agent finished, which question failed, etc., without manually
 * scrolling.
 */
function LogPanel({
    entries,
    running,
}: {
    entries: {
        kind: "info" | "success" | "error" | "warning";
        message: string;
        timestamp: string;
        elapsedMs?: number;
    }[];
    running: boolean;
}) {
    // Auto-scroll to bottom on new entries.
    const scrollRef = useMemo(() => ({ current: null as HTMLDivElement | null }), []);
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [entries, scrollRef]);

    const colorFor = (k: string): string => {
        if (k === "success") return "#22c55e";
        if (k === "error") return "#ef4444";
        if (k === "warning") return "#f59e0b";
        return "var(--text-secondary)";
    };

    return (
        <section
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: "12px",
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                display: "grid",
                gap: "8px",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {running ? (
                    <Loader2 size={14} className="animate-spin" color="var(--accent-primary)" />
                ) : (
                    <CheckCircle2 size={14} color="#22c55e" />
                )}
                <strong style={{ fontSize: "0.86rem" }}>
                    {running ? "Run in progress" : "Run log"}
                </strong>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                    {entries.length} event{entries.length === 1 ? "" : "s"}
                </span>
            </div>
            <div
                ref={(el) => {
                    scrollRef.current = el;
                }}
                style={{
                    maxHeight: 280,
                    overflowY: "auto",
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "8px",
                    padding: "8px 10px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: "0.74rem",
                    lineHeight: 1.55,
                }}
            >
                {entries.length === 0 ? (
                    <div style={{ color: "var(--text-tertiary)" }}>
                        Waiting for first event…
                    </div>
                ) : (
                    entries.map((e, i) => (
                        <div
                            key={i}
                            style={{
                                color: colorFor(e.kind),
                                display: "grid",
                                gridTemplateColumns: "70px 1fr auto",
                                gap: "8px",
                                padding: "1px 0",
                            }}
                        >
                            <span style={{ color: "var(--text-tertiary)" }}>{e.timestamp}</span>
                            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                {e.message}
                            </span>
                            <span style={{ color: "var(--text-tertiary)" }}>
                                {e.elapsedMs !== undefined && e.elapsedMs > 0
                                    ? `${(e.elapsedMs / 1000).toFixed(1)}s`
                                    : ""}
                            </span>
                        </div>
                    ))
                )}
            </div>
        </section>
    );
}

function NoticeBox({ kind, children }: { kind: "warn" | "err" | "ok"; children: React.ReactNode }) {
    const color =
        kind === "ok" ? "#22c55e" : kind === "warn" ? "#f59e0b" : "#ef4444";
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 12px",
                borderRadius: "9px",
                border: `1px solid ${color}55`,
                background: `${color}10`,
                color,
                fontSize: "0.78rem",
                whiteSpace: "pre-wrap",
            }}
        >
            {children}
        </div>
    );
}

// =============================================================================
//  LIVE DASHBOARD — per-question table that updates as the job runs
// =============================================================================

function statusColor(status: string): string {
    switch (status) {
        case "done":
            return "#22c55e";
        case "running":
            return "#3b82f6";
        case "failed":
            return "#ef4444";
        case "skipped":
            return "#94a3b8";
        case "cancelling":
        case "cancelled":
            return "#f59e0b";
        case "pending":
        default:
            return "#94a3b8";
    }
}

function StatusPill({ status }: { status: string }) {
    const color = statusColor(status);
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: "0.7rem",
                fontWeight: 600,
                background: `${color}22`,
                color,
                border: `1px solid ${color}66`,
                textTransform: "uppercase",
                letterSpacing: 0.3,
            }}
        >
            {status === "running" && <Loader2 size={9} className="animate-spin" />}
            {status}
        </span>
    );
}

/**
 * Token usage & cost breakdown for the run. Reads the job's per-model token
 * tallies (accumulated by the executor) and prices them from the maintained
 * table in lib/agenticQC/pricing.ts. Hidden until at least one model has
 * reported usage.
 */
function TokenCostPanel({ job }: { job: JobRecord }) {
    const summary = buildCostSummary(job.tokenUsage);
    if (summary.rows.length === 0) return null;

    return (
        <div
            style={{
                border: "1px solid var(--border-primary)",
                background: "var(--bg-tertiary)",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: "0.8rem",
                display: "grid",
                gap: 8,
            }}
        >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 600 }}>Token usage &amp; cost</div>
                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    prices as of {summary.pricedAsOf} · $1 = ₹{summary.usdToInr}
                </span>
            </div>

            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
                    <thead>
                        <tr>
                            <th style={tcTh}>Model</th>
                            <th style={tcTh}>Used by</th>
                            <th style={{ ...tcTh, textAlign: "right" }}>Input tok</th>
                            <th style={{ ...tcTh, textAlign: "right" }}>Output tok</th>
                            <th style={{ ...tcTh, textAlign: "right" }}>Rate $/1M (in/out)</th>
                            <th style={{ ...tcTh, textAlign: "right" }}>Cost ₹</th>
                        </tr>
                    </thead>
                    <tbody>
                        {summary.rows.map((row) => (
                            <tr key={`${row.provider}::${row.modelId}`}>
                                <td style={tcTd} title={`${row.provider}/${row.modelId}`}>
                                    <span style={{ color: "var(--text-tertiary)" }}>{row.provider}/</span>
                                    {row.modelId}
                                </td>
                                <td style={{ ...tcTd, color: "var(--text-tertiary)" }}>
                                    {row.labels.join(", ") || "—"}
                                </td>
                                <td style={{ ...tcTd, textAlign: "right" }}>{formatTokens(row.inputTokens)}</td>
                                <td style={{ ...tcTd, textAlign: "right" }}>{formatTokens(row.outputTokens)}</td>
                                <td style={{ ...tcTd, textAlign: "right" }}>
                                    {row.priced ? `${row.price!.input} / ${row.price!.output}` : "—"}
                                </td>
                                <td style={{ ...tcTd, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                    {row.priced ? formatInr(row.costInr) : "price n/a"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td style={{ ...tcTd, fontWeight: 700 }} colSpan={2}>
                                Total
                            </td>
                            <td style={{ ...tcTd, textAlign: "right", fontWeight: 700 }}>
                                {formatTokens(summary.totalInputTokens)}
                            </td>
                            <td style={{ ...tcTd, textAlign: "right", fontWeight: 700 }}>
                                {formatTokens(summary.totalOutputTokens)}
                            </td>
                            <td style={tcTd} />
                            <td style={{ ...tcTd, textAlign: "right", fontWeight: 700 }}>
                                {formatInr(summary.totalCostInr)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                Total ≈ {formatInr(summary.totalCostInr)} (${summary.totalCostUsd.toFixed(4)}) for{" "}
                {formatTokens(summary.totalTokens)} tokens.
                {summary.hasUnpriced &&
                    " Some models have no price in the table — their cost is excluded. Add them in lib/agenticQC/pricing.ts."}
            </div>
        </div>
    );
}

const tcTh: React.CSSProperties = {
    textAlign: "left",
    padding: "5px 8px",
    fontSize: "0.68rem",
    fontWeight: 700,
    color: "var(--text-tertiary)",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    borderBottom: "1px solid var(--border-primary)",
    whiteSpace: "nowrap",
};

const tcTd: React.CSSProperties = {
    padding: "5px 8px",
    borderBottom: "1px solid var(--border-primary)",
    verticalAlign: "top",
};

function LiveDashboard({
    job,
    onDownloadCSV,
    onDownloadExcel,
    onDownloadPDF,
    onDownloadHTML,
    onDownloadJSON,
    generatingPdf,
}: {
    job: JobRecord;
    onDownloadCSV: () => void;
    onDownloadExcel: () => void;
    onDownloadPDF: () => void;
    onDownloadHTML: () => void;
    generatingPdf?: boolean;
    onDownloadJSON: () => void;
}) {
    const total = job.questions.length;
    const aggDone = job.questions.filter(
        (q) =>
            q.aggregator.status === "done" ||
            q.aggregator.status === "failed" ||
            q.aggregator.status === "skipped"
    ).length;
    const progressPct = total === 0 ? 0 : Math.round((aggDone / total) * 100);
    const flagged = job.questions.filter((q) => q.aggregator.needsManualReview).length;
    const mismatched = job.questions.filter(
        (q) => q.aggregator.agreementWithProvidedKey === false
    ).length;
    const withErrors = job.questions.filter(
        (q) => q.aggregator.consolidatedErrors.length > 0
    ).length;
    const withFigures = job.questions.filter((q) => q.hasFigure).length;

    return (
        <section
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: 12,
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                display: "grid",
                gap: 12,
            }}
        >
            {/* ── Header row ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {job.status === "done" ? (
                    <CheckCircle2 size={18} color="#22c55e" />
                ) : job.status === "failed" || job.status === "cancelled" ? (
                    <AlertCircle size={18} color="#ef4444" />
                ) : (
                    <Loader2 size={18} className="animate-spin" color="#3b82f6" />
                )}
                <div style={{ fontSize: "1rem", fontWeight: 700 }}>
                    {job.label}{" "}
                    <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                        · {job.status}
                    </span>
                </div>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={onDownloadCSV} style={downloadBtn}>
                    <Download size={13} /> CSV
                </button>
                <button type="button" onClick={onDownloadExcel} style={downloadBtn}>
                    <FileSpreadsheet size={13} /> Excel
                </button>
                <button
                    type="button"
                    onClick={onDownloadPDF}
                    disabled={generatingPdf}
                    style={{
                        ...downloadBtn,
                        opacity: generatingPdf ? 0.6 : 1,
                        cursor: generatingPdf ? "wait" : "pointer",
                    }}
                    title="Color-coded PDF with embedded diagrams. Takes a moment to fetch images."
                >
                    {generatingPdf ? (
                        <Loader2 size={13} className="animate-spin" />
                    ) : (
                        <FileText size={13} />
                    )}
                    {generatingPdf ? "Generating…" : "PDF"}
                </button>
                <button
                    type="button"
                    onClick={onDownloadHTML}
                    style={downloadBtn}
                    title="Same report as a web page — QBG IDs open in a new tab (a PDF link can't)."
                >
                    <ExternalLink size={13} /> HTML
                </button>
                <button type="button" onClick={onDownloadJSON} style={downloadBtn}>
                    <Download size={13} /> JSON
                </button>
            </div>

            {/* ── Progress bar ── */}
            <div
                style={{
                    height: 8,
                    background: "var(--bg-tertiary)",
                    borderRadius: 999,
                    overflow: "hidden",
                }}
            >
                <div
                    style={{
                        width: `${progressPct}%`,
                        height: "100%",
                        background:
                            job.status === "failed"
                                ? "#ef4444"
                                : job.status === "cancelled"
                                ? "#f59e0b"
                                : "linear-gradient(90deg, #3b82f6, #22c55e)",
                        transition: "width 0.4s ease",
                    }}
                />
            </div>

            {/* ── Stat tiles ── */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                    gap: 8,
                }}
            >
                <StatTile label="Progress" value={`${aggDone} / ${total}`} accent="#3b82f6" />
                <StatTile label="Flagged" value={String(flagged)} accent="#f59e0b" />
                <StatTile label="Key mismatch" value={String(mismatched)} accent="#ef4444" />
                <StatTile label="With errors" value={String(withErrors)} accent="#ef4444" />
                <StatTile label="With diagrams" value={String(withFigures)} accent="#a855f7" />
            </div>

            {job.partial && (
                <div
                    style={{
                        border: "1px solid #f59e0b",
                        background: "rgba(245, 158, 11, 0.08)",
                        color: "#b45309",
                        borderRadius: 8,
                        padding: "8px 12px",
                        fontSize: "0.8rem",
                    }}
                >
                    <strong>Partial report.</strong> {job.partialReason || ""} Final answers were
                    derived by majority vote across the QC agents (not independent re-derivation).
                </div>
            )}

            {/* ── Per-question table ── */}
            {job.questions.length > 0 && (
                <div
                    style={{
                        border: "1px solid var(--border-primary)",
                        borderRadius: 8,
                        background: "var(--bg-tertiary)",
                        maxHeight: 520,
                        overflow: "auto",
                    }}
                >
                    <table
                        style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: "0.78rem",
                            color: "var(--text-primary)",
                        }}
                    >
                        <thead
                            style={{
                                position: "sticky",
                                top: 0,
                                background: "var(--bg-secondary)",
                                zIndex: 1,
                                boxShadow: "0 1px 0 var(--border-primary)",
                            }}
                        >
                            <tr>
                                <th style={th}>Q#</th>
                                <th style={th}>Provided</th>
                                {job.qcAgents.map((a) => (
                                    <th key={a.label} style={th} title={`${a.provider}/${a.modelId}`}>
                                        {a.label}
                                    </th>
                                ))}
                                <th style={th}>Final</th>
                                <th style={th}>Flags</th>
                                <th style={th}>Rationale</th>
                            </tr>
                        </thead>
                        <tbody>
                            {job.questions.map((q) => (
                                <QuestionRow key={q.questionNumber} q={q} agents={job.qcAgents} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ── Token usage & cost (live, accumulates as models respond) ── */}
            <TokenCostPanel job={job} />

            {/* ── Paper-level analysis (filled in at completion) ── */}
            {job.paperAnalysis.patternAnalysis && (
                <div
                    style={{
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-tertiary)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        fontSize: "0.82rem",
                        lineHeight: 1.55,
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Paper-level analysis</div>
                    <div>{job.paperAnalysis.patternAnalysis}</div>
                    {job.paperAnalysis.syllabusAnalysis && (
                        <div style={{ marginTop: 4 }}>{job.paperAnalysis.syllabusAnalysis}</div>
                    )}
                    {job.paperAnalysis.overallSuggestions.length > 0 && (
                        <ul style={{ margin: "6px 0 0 18px" }}>
                            {job.paperAnalysis.overallSuggestions.map((s, i) => (
                                <li key={i}>{s}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}

const th: React.CSSProperties = {
    textAlign: "left",
    padding: "8px 10px",
    fontSize: "0.7rem",
    fontWeight: 700,
    color: "var(--text-tertiary)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: "1px solid var(--border-primary)",
};

const td: React.CSSProperties = {
    padding: "8px 10px",
    verticalAlign: "top",
    borderBottom: "1px solid var(--border-primary)",
};

const downloadBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 10px",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-primary)",
    borderRadius: 6,
    fontSize: "0.78rem",
    cursor: "pointer",
};

function StatTile({ label, value, accent }: { label: string; value: string; accent: string }) {
    return (
        <div
            style={{
                background: "var(--bg-tertiary)",
                border: `1px solid ${accent}33`,
                borderRadius: 8,
                padding: "8px 10px",
            }}
        >
            <div style={{ fontSize: "0.65rem", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                {label}
            </div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color: accent }}>{value}</div>
        </div>
    );
}

function QuestionRow({
    q,
    agents,
}: {
    q: JobQuestion;
    agents: { label: string; provider: string; modelId: string }[];
}) {
    const flags: { label: string; color: string }[] = [];
    if (q.hasFigure) flags.push({ label: "DIAGRAM", color: "#a855f7" });
    if (q.aggregator.agreementWithProvidedKey === false)
        flags.push({ label: "KEY MISMATCH", color: "#ef4444" });
    if (q.aggregator.needsManualReview) flags.push({ label: "REVIEW", color: "#f59e0b" });
    if (q.aggregator.consolidatedErrors.length > 0)
        flags.push({ label: `${q.aggregator.consolidatedErrors.length} ERR`, color: "#ef4444" });

    const rowBg =
        q.aggregator.needsManualReview || q.aggregator.agreementWithProvidedKey === false
            ? "rgba(245, 158, 11, 0.05)"
            : undefined;

    return (
        <tr style={{ background: rowBg }}>
            <td style={{ ...td, fontWeight: 600 }}>
                Q{q.questionNumber}
                {q.subject && (
                    <div style={{ fontSize: "0.65rem", color: "var(--text-tertiary)" }}>
                        {q.subject}
                    </div>
                )}
                {q.qbgId && (
                    // The PDF report can only carry a plain PDF link, which Chrome
                    // opens in the same tab — so the in-app row is where a QBG id
                    // can actually open in a new tab without losing your place.
                    <a
                        href={`${QBG_QUESTION_URL}${encodeURIComponent(q.qbgId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${q.qbgId} in QBG (new tab)`}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 3,
                            marginTop: 3,
                            fontSize: "0.62rem",
                            fontWeight: 600,
                            fontFamily: "ui-monospace, Menlo, monospace",
                            color: "var(--accent-primary)",
                            textDecoration: "none",
                        }}
                    >
                        {q.qbgId.length > 12 ? `${q.qbgId.slice(0, 10)}…` : q.qbgId}
                        <ExternalLink size={9} />
                    </a>
                )}
            </td>
            <td style={td}>
                <span style={{ fontWeight: 600 }}>{q.providedAnswerKey ?? "—"}</span>
            </td>
            {agents.map((a) => {
                const result = q.agentResults.find((r) => r.label === a.label);
                return (
                    <td key={a.label} style={td}>
                        <AgentCell result={result} />
                    </td>
                );
            })}
            <td style={td}>
                <AggregatorCell q={q} />
            </td>
            <td style={td}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {flags.map((f) => (
                        <span
                            key={f.label}
                            style={{
                                fontSize: "0.65rem",
                                fontWeight: 700,
                                color: f.color,
                                background: `${f.color}1a`,
                                border: `1px solid ${f.color}55`,
                                padding: "1px 6px",
                                borderRadius: 999,
                                whiteSpace: "nowrap",
                            }}
                        >
                            {f.label}
                        </span>
                    ))}
                </div>
            </td>
            <td style={{ ...td, maxWidth: 280, color: "var(--text-secondary)", fontSize: "0.74rem" }}>
                {q.aggregator.rationale || (
                    <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>—</span>
                )}
            </td>
        </tr>
    );
}

function AgentCell({ result }: { result: PerAgentQuestionResult | undefined }) {
    if (!result) return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
    if (result.status === "pending")
        return <StatusPill status="pending" />;
    if (result.status === "running")
        return <StatusPill status="running" />;
    if (result.status === "failed")
        return (
            <span title={result.error || ""} style={{ color: "#ef4444", fontSize: "0.72rem" }}>
                ✗ failed
            </span>
        );
    return (
        <span title={result.correctness}>
            <span style={{ fontWeight: 700 }}>{result.answer ?? "—"}</span>
            {result.errorsFound.length > 0 && (
                <div style={{ color: "#ef4444", fontSize: "0.65rem", marginTop: 2 }}>
                    {result.errorsFound.length} issue(s)
                </div>
            )}
        </span>
    );
}

function AggregatorCell({ q }: { q: JobQuestion }) {
    if (q.aggregator.status === "pending") return <StatusPill status="pending" />;
    if (q.aggregator.status === "running") return <StatusPill status="running" />;
    if (q.aggregator.status === "skipped") return <StatusPill status="skipped" />;
    const answer = q.aggregator.finalAnswer ?? "—";
    const color =
        q.aggregator.status === "failed"
            ? "#f59e0b"
            : q.aggregator.agreementWithProvidedKey === false
            ? "#ef4444"
            : "#22c55e";
    return (
        <div>
            <div style={{ fontWeight: 700, color }}>{answer}</div>
            <div style={{ fontSize: "0.62rem", color: "var(--text-tertiary)" }}>
                {q.aggregator.confidence}
                {q.aggregator.status === "failed" ? "  · vote" : ""}
            </div>
        </div>
    );
}

// =============================================================================
//  PAST JOBS — list of saved runs, click to reopen + re-download
// =============================================================================

interface PastJobSummary {
    id: string;
    label: string;
    status: string;
    createdAt: string;
    finishedAt?: string;
    totalQuestions: number;
    flaggedForReview: number;
    inputMode: string;
    partial?: boolean;
    fatalError?: string;
}

function PastJobsPanel({
    jobs,
    loading,
    activeJobId,
    onOpen,
    onDelete,
    onRefresh,
}: {
    jobs: PastJobSummary[];
    loading: boolean;
    activeJobId: string | null;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
    onRefresh: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const recent = jobs.slice(0, 8);
    const hidden = jobs.length - recent.length;
    return (
        <section
            style={{
                border: "1px solid var(--border-primary)",
                borderRadius: 12,
                background: "var(--bg-secondary)",
                padding: "12px 14px",
                display: "grid",
                gap: 8,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "0.9rem",
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    {expanded ? "▼" : "▶"} Saved QC reports ({jobs.length})
                </button>
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    style={{
                        ...downloadBtn,
                        background: "transparent",
                    }}
                    title="Refresh list"
                >
                    <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
                </button>
            </div>
            {expanded && (
                <div style={{ display: "grid", gap: 6 }}>
                    {jobs.length === 0 && (
                        <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                            No saved reports yet. Run a QC and it&apos;ll show here — even after you
                            navigate away or start a new run.
                        </div>
                    )}
                    {recent.map((j) => (
                        <div
                            key={j.id}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "8px 10px",
                                borderRadius: 6,
                                background:
                                    activeJobId === j.id
                                        ? "var(--accent-glow)"
                                        : "var(--bg-tertiary)",
                                border:
                                    activeJobId === j.id
                                        ? "1px solid var(--accent-primary)"
                                        : "1px solid transparent",
                            }}
                        >
                            <StatusPill status={j.status} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontSize: "0.82rem",
                                        fontWeight: 600,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                    }}
                                    title={j.label}
                                >
                                    {j.label}
                                </div>
                                <div style={{ fontSize: "0.68rem", color: "var(--text-tertiary)" }}>
                                    {formatIST(j.createdAt)} ·{" "}
                                    {j.totalQuestions} Qs · {j.flaggedForReview} flagged
                                    {j.partial && " · partial"}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => onOpen(j.id)}
                                style={{ ...downloadBtn, padding: "4px 10px" }}
                            >
                                Open
                            </button>
                            <button
                                type="button"
                                onClick={() => onDelete(j.id)}
                                style={{
                                    ...downloadBtn,
                                    padding: "4px 8px",
                                    color: "var(--accent-danger)",
                                }}
                                title="Delete this report"
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                    ))}
                    {hidden > 0 && (
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                            … {hidden} more not shown.
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

// =============================================================================
//  REPORT VIEW (legacy)
// =============================================================================

function ReportView({
    report,
    onDownloadCSV,
    onDownloadJSON,
}: {
    report: FinalReport;
    onDownloadCSV: () => void;
    onDownloadJSON: () => void;
}) {
    return (
        <div style={{ display: "grid", gap: "14px", marginTop: "8px" }}>
            {/* Summary */}
            <section
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "12px",
                    padding: "16px 18px",
                    background: "var(--bg-secondary)",
                    display: "grid",
                    gap: "12px",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    {report.partial ? (
                        <AlertCircle size={18} color="#f59e0b" />
                    ) : (
                        <CheckCircle2 size={18} color="#22c55e" />
                    )}
                    <div style={{ fontSize: "1rem", fontWeight: 700 }}>
                        {report.partial ? "Partial QC report" : "QC report ready"}
                    </div>
                    <span style={{ flex: 1 }} />
                    <button
                        type="button"
                        onClick={onDownloadCSV}
                        style={primaryButton(true)}
                        title="Tabular CSV: Q#, provided key, diagram flag, each agent's answer, final answer, errors, …"
                    >
                        <Download size={14} />
                        Download CSV
                    </button>
                    <button
                        type="button"
                        onClick={onDownloadJSON}
                        style={{
                            ...primaryButton(true),
                            background: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            border: "1px solid var(--border-primary)",
                        }}
                        title="Full structured JSON with every detail (per-agent raw outputs, rationale, etc.)"
                    >
                        <Download size={14} />
                        JSON
                    </button>
                </div>
                {report.partial && (
                    <div
                        style={{
                            border: "1px solid #f59e0b",
                            background: "rgba(245, 158, 11, 0.08)",
                            color: "#b45309",
                            borderRadius: "8px",
                            padding: "10px 12px",
                            fontSize: "0.82rem",
                            lineHeight: 1.5,
                        }}
                    >
                        <strong>Aggregator step failed.</strong>{" "}
                        {report.partialReason || ""}
                        <br />
                        Final answers in this download were derived by{" "}
                        <strong>majority vote across the QC agents</strong>, not
                        by an independent re-derivation. Questions flagged for
                        manual review are usually those where agents disagreed,
                        only one agent reported, or a figure was present.
                    </div>
                )}
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: "10px",
                    }}
                >
                    <SummaryStat label="Questions" value={report.summary.totalQuestions} />
                    <SummaryStat
                        label="Flagged for review"
                        value={report.summary.flaggedForReview}
                        accent="#f59e0b"
                    />
                    <SummaryStat
                        label="Answer-key mismatches"
                        value={report.summary.answerKeyMismatches}
                        accent="#ef4444"
                    />
                    <SummaryStat
                        label="Has figure"
                        value={report.summary.questionsWithFigures}
                        accent="#8b5cf6"
                    />
                    <SummaryStat
                        label="Has errors"
                        value={report.summary.questionsWithErrors}
                        accent="#ef4444"
                    />
                </div>
                <div style={hintStyle}>
                    <strong>Models used:</strong>{" "}
                    {report.agents.map((a) => `${a.label}: ${a.modelId}`).join(" · ")} ·{" "}
                    Aggregator: {report.aggregator.modelId}
                </div>
                {report.aggregatorAnalysis.patternAnalysis && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <strong>Pattern analysis:</strong> {report.aggregatorAnalysis.patternAnalysis}
                    </div>
                )}
                {report.aggregatorAnalysis.syllabusAnalysis && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <strong>Syllabus analysis:</strong> {report.aggregatorAnalysis.syllabusAnalysis}
                    </div>
                )}
                {report.aggregatorAnalysis.overallSuggestions.length > 0 && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <strong>Overall suggestions:</strong>
                        <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                            {report.aggregatorAnalysis.overallSuggestions.map((s, i) => (
                                <li key={i}>{s}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>

            {/* Per-agent failures */}
            {report.perAgentReports.some((p) => p.error) && (
                <NoticeBox kind="warn">
                    <AlertCircle size={14} />
                    <div>
                        Some agents failed:{" "}
                        {report.perAgentReports
                            .filter((p) => p.error)
                            .map((p) => `${p.agent.label} (${p.agent.provider}): ${p.error}`)
                            .join("; ")}
                    </div>
                </NoticeBox>
            )}

            {/* Per-question details */}
            <Section title="Per-question detail" subtitle="Sorted by question number. Flagged questions are highlighted.">
                <div style={{ display: "grid", gap: "10px" }}>
                    {report.questions.map((q) => (
                        <QuestionCard key={q.questionNumber} q={q} />
                    ))}
                </div>
            </Section>
        </div>
    );
}

function SummaryStat({
    label,
    value,
    accent,
}: {
    label: string;
    value: number;
    accent?: string;
}) {
    return (
        <div
            style={{
                padding: "10px 12px",
                borderRadius: "10px",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-primary)",
            }}
        >
            <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>{label}</div>
            <div
                style={{
                    fontSize: "1.4rem",
                    fontWeight: 700,
                    color: accent || "var(--text-primary)",
                }}
            >
                {value}
            </div>
        </div>
    );
}

function QuestionCard({ q }: { q: AggregatedQuestion }) {
    const flagged = q.needsManualReview;
    const borderColor = flagged
        ? "#f59e0b"
        : q.agreementWithProvidedKey === false
        ? "#ef4444"
        : "var(--border-primary)";
    return (
        <div
            style={{
                border: `1px solid ${borderColor}`,
                borderRadius: "10px",
                padding: "12px 14px",
                background: flagged ? "#f59e0b10" : "var(--bg-tertiary)",
                display: "grid",
                gap: "8px",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.88rem" }}>Q{q.questionNumber}</strong>
                <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>{q.questionType}</span>
                {q.hasFigure && (
                    <span
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "0.7rem",
                            color: "#8b5cf6",
                            background: "#8b5cf615",
                            padding: "2px 8px",
                            borderRadius: 999,
                        }}
                        title="This question contains a figure/diagram — AI accuracy drops on visual questions."
                    >
                        <ImageIcon size={11} /> figure
                    </span>
                )}
                {flagged && (
                    <span
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "0.7rem",
                            fontWeight: 700,
                            color: "#f59e0b",
                            background: "#f59e0b20",
                            padding: "2px 8px",
                            borderRadius: 999,
                        }}
                    >
                        <Flag size={11} /> needs manual review
                    </span>
                )}
                {q.agreementWithProvidedKey === false && (
                    <span
                        style={{
                            fontSize: "0.7rem",
                            fontWeight: 700,
                            color: "#ef4444",
                            background: "#ef444420",
                            padding: "2px 8px",
                            borderRadius: 999,
                        }}
                    >
                        ✗ disagrees with key
                    </span>
                )}
                <span style={{ flex: 1 }} />
                <span
                    style={{
                        fontSize: "0.7rem",
                        color:
                            q.finalAnswerConfidence === "high"
                                ? "#22c55e"
                                : q.finalAnswerConfidence === "low"
                                ? "#ef4444"
                                : "var(--text-tertiary)",
                    }}
                >
                    confidence: {q.finalAnswerConfidence}
                </span>
            </div>
            {q.questionSummary && (
                <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    {q.questionSummary}
                </div>
            )}

            {/* Answers table */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(150px,1fr) repeat(auto-fit, minmax(120px,1fr))",
                    gap: "6px",
                    fontSize: "0.74rem",
                }}
            >
                <KV label="Provided key" value={String(q.providedAnswerKey ?? "—")} />
                {q.agentAnswers.map((aa) => (
                    <KV
                        key={aa.agentLabel}
                        label={`${aa.agentLabel} (${aa.modelId})`}
                        value={String(aa.answer ?? "—")}
                    />
                ))}
                <KV
                    label="Final answer"
                    value={String(q.finalAnswer ?? "—")}
                    bold
                    accent={flagged ? "#f59e0b" : "var(--accent-primary)"}
                />
            </div>

            {q.manualReviewReason && (
                <div style={{ fontSize: "0.74rem", color: "#b45309" }}>
                    <strong>Reason:</strong> {q.manualReviewReason}
                </div>
            )}
            {q.aggregatorRationale && (
                <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                    <strong>Aggregator rationale:</strong> {q.aggregatorRationale}
                </div>
            )}
            {q.consolidatedErrors.length > 0 && (
                <div style={{ fontSize: "0.74rem" }}>
                    <strong>Errors:</strong>
                    <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                        {q.consolidatedErrors.map((e, i) => (
                            <li key={i}>{e}</li>
                        ))}
                    </ul>
                </div>
            )}
            {q.consolidatedSolutionFeedback && (
                <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                    <strong>Solution feedback:</strong> {q.consolidatedSolutionFeedback}
                </div>
            )}
        </div>
    );
}

function KV({
    label,
    value,
    bold,
    accent,
}: {
    label: string;
    value: string;
    bold?: boolean;
    accent?: string;
}) {
    return (
        <div
            style={{
                padding: "6px 8px",
                borderRadius: 6,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-primary)",
            }}
        >
            <div style={{ fontSize: "0.66rem", color: "var(--text-tertiary)" }}>{label}</div>
            <div
                style={{
                    fontSize: "0.84rem",
                    fontWeight: bold ? 700 : 500,
                    color: accent || "var(--text-primary)",
                    wordBreak: "break-word",
                }}
            >
                {value}
            </div>
        </div>
    );
}

// =============================================================================
//  INLINE STYLE HELPERS
// =============================================================================

function inputStyle(): React.CSSProperties {
    return {
        width: "100%",
        padding: "7px 10px",
        borderRadius: "8px",
        border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        color: "var(--text-primary)",
        fontSize: "0.82rem",
        outline: "none",
    };
}

function primaryButton(enabled: boolean): React.CSSProperties {
    return {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "10px 16px",
        borderRadius: "10px",
        border: "1px solid var(--accent-primary, #818cf8)",
        background: enabled ? "var(--accent-primary, #818cf8)" : "var(--bg-tertiary)",
        color: enabled ? "#fff" : "var(--text-tertiary)",
        fontSize: "0.84rem",
        fontWeight: 700,
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.6,
    };
}

function pillStyle(active: boolean): React.CSSProperties {
    return {
        padding: "6px 12px",
        borderRadius: "999px",
        border: active ? "1px solid var(--accent-primary)" : "1px solid var(--border-primary)",
        background: active ? "var(--accent-glow)" : "transparent",
        color: active ? "var(--accent-primary)" : "var(--text-secondary)",
        fontSize: "0.78rem",
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
    };
}

const hintStyle: React.CSSProperties = {
    fontSize: "0.72rem",
    color: "var(--text-tertiary)",
};

