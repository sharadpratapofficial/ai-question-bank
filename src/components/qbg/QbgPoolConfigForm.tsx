"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { DIFFICULTY_COLORS } from "@/lib/constants";
import { compareChaptersBySubject } from "@/lib/chapterOrder";
import type { PoolFilterOptions, PoolSelectionConfig } from "@/lib/api/qbgPoolSelection";
import {
    buildPaperPlan,
    resolvePlanRequirements,
    type PlanDifficulty,
    type PlanSlot,
} from "@/lib/api/qbgPaperPlan";
import {
    JEE_ADVANCED_PATTERN_MATRIX,
    getQuestionTypeLabel,
    type DifficultyDistribution,
    type ExamPreset,
    type JeeAdvancedPaper,
    type SourcePreference,
} from "@/types";

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};
const sectionLabel: React.CSSProperties = { fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" };
const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.85rem",
    padding: "8px 10px",
    outline: "none",
};

function ChipButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                padding: "6px 12px",
                borderRadius: 9,
                border: active ? "1px solid rgba(var(--accent-success-rgb), 0.6)" : "1px solid var(--border-primary)",
                background: active
                    ? "linear-gradient(135deg, rgba(var(--accent-success-rgb), 0.18), rgba(var(--accent-success-rgb), 0.08))"
                    : "var(--bg-tertiary)",
                color: active ? "var(--accent-success)" : "var(--text-secondary)",
                fontSize: "0.8rem",
                fontWeight: 500,
                cursor: "pointer",
            }}
        >
            {children}
        </button>
    );
}

const DIST_GRID_COLS = "64px 170px 64px 26px";
const PLAN_GRID_COLS = "34px 84px 92px minmax(130px, 1.5fr) minmax(120px, 1.3fr) 92px 116px 46px";
const planCell: React.CSSProperties = {
    width: "100%",
    borderRadius: 6,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.72rem",
    padding: "3px 5px",
    outline: "none",
};

function QuestionDistributionTable({
    rows,
    questionTypes,
    onTypeChange,
    onCountChange,
    onAddRow,
    onRemoveRow,
}: {
    rows: { id: string; type: string; count: number; questionNumbers: string }[];
    questionTypes: string[];
    onTypeChange: (id: string, type: string) => void;
    onCountChange: (id: string, count: number) => void;
    onAddRow: () => void;
    onRemoveRow: (id: string) => void;
}) {
    return (
        <div style={{ display: "grid", gap: 6 }}>
            {rows.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: DIST_GRID_COLS, gap: 8, fontSize: "0.68rem", color: "var(--text-tertiary)", fontWeight: 700 }}>
                    <span>Question #s</span>
                    <span>Question Type</span>
                    <span>Count</span>
                    <span />
                </div>
            )}
            {rows.length === 0 && <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>No rows — add one below.</div>}
            {rows.map((row) => (
                <div key={row.id} style={{ display: "grid", gridTemplateColumns: DIST_GRID_COLS, gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{row.questionNumbers}</span>
                    <select value={row.type} onChange={(e) => onTypeChange(row.id, e.target.value)} style={{ ...input, padding: "6px 8px" }}>
                        {!questionTypes.includes(row.type) && <option value={row.type}>{getQuestionTypeLabel(row.type)}</option>}
                        {questionTypes.map((t) => (
                            <option key={t} value={t}>
                                {getQuestionTypeLabel(t)}
                            </option>
                        ))}
                    </select>
                    <input
                        type="number"
                        min={1}
                        value={row.count}
                        onChange={(e) => onCountChange(row.id, Number(e.target.value))}
                        style={{ ...input, padding: "6px 8px" }}
                    />
                    <button
                        type="button"
                        onClick={() => onRemoveRow(row.id)}
                        title="Remove row"
                        style={{ border: "none", background: "transparent", color: "var(--text-tertiary)", cursor: "pointer", display: "grid", placeItems: "center", padding: 0 }}
                    >
                        <X size={14} />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={onAddRow}
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    border: "1px solid var(--border-primary)",
                    borderRadius: 7,
                    background: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                    padding: "4px 10px",
                    cursor: "pointer",
                    width: "fit-content",
                }}
            >
                <Plus size={12} /> Add row
            </button>
        </div>
    );
}

const EXAM_PRESET_LABELS: Record<ExamPreset, string> = {
    NEET: "NEET",
    JEE_MAINS: "JEE Mains",
    JEE_ADVANCE: "JEE Advance",
};
const ADVANCE_YEARS = ["2025", "2024", "2023", "2022", "2021", "2020"];

interface QuestionDistributionRow {
    id: string;
    type: string;
    count: number;
}
const DEFAULT_JEE_MAINS_DISTRIBUTION = [
    { type: "Single_Choice(SCQ)", count: 20 },
    { type: "Integer", count: 5 },
];
const DEFAULT_NEET_DISTRIBUTION = [{ type: "Single_Choice(SCQ)", count: 45 }];

function makeRowId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function createDistributionRows(rows: { type: string; count: number }[]): QuestionDistributionRow[] {
    return rows
        .filter((r) => r.type && r.count > 0)
        .map((r) => ({ id: makeRowId(), type: r.type, count: Math.max(1, Math.floor(r.count)) }));
}
function normalizeDistributionRows(rows: QuestionDistributionRow[]): QuestionDistributionRow[] {
    return rows
        .filter((r) => r.type && r.count > 0)
        .map((r) => ({ ...r, count: Math.max(1, Math.floor(r.count)) }));
}
/** Mirrors testGeneration's rowsWithQuestionNumbers — a running-sum walk over
 *  the rows in array order, so the same "1-20"/"21-25" ranges show here that
 *  the Tests feature shows. */
function rowsWithQuestionNumbers(
    rows: QuestionDistributionRow[]
): { type: string; count: number; questionNumbers: string }[] {
    let start = 1;
    return normalizeDistributionRows(rows).map((row) => {
        const end = start + row.count - 1;
        const questionNumbers = `${start}-${end}`;
        start = end + 1;
        return { type: row.type, count: row.count, questionNumbers };
    });
}
/** For the editor UI — unlike rowsWithQuestionNumbers, keeps every row (even
 *  one mid-edit with a temporarily-empty count) and keeps `id`, so this stays
 *  index-safe against the raw rows array the onChange handlers mutate. */
function rowsForDisplay(rows: QuestionDistributionRow[]): (QuestionDistributionRow & { questionNumbers: string })[] {
    let start = 1;
    return rows.map((row) => {
        const count = Math.max(0, Math.floor(row.count || 0));
        const end = start + Math.max(count, 1) - 1;
        const questionNumbers = count > 0 ? `${start}-${end}` : "-";
        start = end + 1;
        return { ...row, questionNumbers };
    });
}
function getDefaultAdvanceDistributionRows(year: string, paper: JeeAdvancedPaper): QuestionDistributionRow[] {
    const yearRows = JEE_ADVANCED_PATTERN_MATRIX[year]?.[paper] || [];
    return createDistributionRows(yearRows.map((r) => ({ type: r.type, count: r.count })));
}
/** Mirrors testGeneration's buildEqualSourcePercentages — 10%-quantized equal
 *  split, remainder handed out one +10 chunk at a time in array order. */
function buildEqualSourcePercentages(sources: string[]): Record<string, number> {
    if (sources.length === 0) return {};
    const base = Math.floor(100 / sources.length / 10) * 10;
    let remainder = 100 - base * sources.length;
    const next: Record<string, number> = {};
    sources.forEach((source) => {
        const bonus = remainder > 0 ? 10 : 0;
        if (bonus > 0) remainder -= 10;
        next[source] = base + bonus;
    });
    return next;
}

interface FormState {
    examPreset: ExamPreset;
    jeeAdvancedYear: string;
    jeeAdvancedPapers: JeeAdvancedPaper[];
    selectedSubjects: string[];
    fullSyllabus: boolean;
    selectedChapters: Record<string, string[]>;
    /** subject -> chapter -> how many questions to take. Empty/all-zero = auto. */
    chapterCounts: Record<string, Record<string, number>>;
    selectedTopicsByChapter: Record<string, string[]>;
    selectedSubtopicsByTopic: Record<string, string[]>;
    /** Any-of match — empty means any class. */
    classLevels: string[];
    hasVideoSolution: boolean;
    hasTextSolution: boolean;
    sourcePreferences: SourcePreference[];
    difficultyDistribution: DifficultyDistribution;
    /** Selected batches — dual purpose: written to used_in_exam for every
     *  selected question AND used to exclude questions already tagged with
     *  any of these batches. */
    batches: string[];
    questionDistribution: QuestionDistributionRow[];
    questionDistributionByPaper: Partial<Record<JeeAdvancedPaper, QuestionDistributionRow[]>>;
    /** "auto" balances the paper while picking; "manual" follows `paperPlan`. */
    paperBalance: "auto" | "manual";
    /** The blueprint the user reviewed — one entry per question, in paper order. */
    paperPlan: PlanSlot[];
}

const DEFAULT_FORM: FormState = {
    examPreset: "JEE_MAINS",
    jeeAdvancedYear: "2025",
    jeeAdvancedPapers: ["Paper 1", "Paper 2"],
    selectedSubjects: ["Physics"],
    fullSyllabus: true,
    selectedChapters: {},
    chapterCounts: {},
    selectedTopicsByChapter: {},
    selectedSubtopicsByTopic: {},
    classLevels: ["11", "12"],
    hasVideoSolution: false,
    hasTextSolution: false,
    sourcePreferences: [],
    difficultyDistribution: { easyPercent: 30, hardPercent: 30 },
    batches: [],
    questionDistribution: createDistributionRows(DEFAULT_JEE_MAINS_DISTRIBUTION),
    questionDistributionByPaper: {
        "Paper 1": getDefaultAdvanceDistributionRows("2025", "Paper 1"),
        "Paper 2": getDefaultAdvanceDistributionRows("2025", "Paper 2"),
    },
    paperBalance: "auto",
    paperPlan: [],
};

export interface PoolConfigHandle {
    /** Builds the wire config, or returns validation errors instead. */
    buildConfig: () => { config: PoolSelectionConfig | null; errors: string[] };
}

function clamp(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function toggleArrayValue<T>(values: T[], value: T): T[] {
    return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

interface QbgPoolConfigFormProps {}

// Chrome/Safari can discard a backgrounded tab (switching desktops or even
// just switching Chrome tabs) and reload it from scratch when refocused,
// wiping all in-memory React state — this survives that by round-tripping
// the form through sessionStorage, so a forced reload restores exactly what
// was configured instead of resetting to DEFAULT_FORM (reported 2026-07-20).
const FORM_STORAGE_KEY = "qbg-pipeline-pool-config-form";

function loadPersistedForm(): FormState {
    if (typeof window === "undefined") return DEFAULT_FORM;
    try {
        const raw = window.sessionStorage.getItem(FORM_STORAGE_KEY);
        if (!raw) return DEFAULT_FORM;
        const parsed = JSON.parse(raw) as Partial<FormState>;
        // Shallow-merge over DEFAULT_FORM so a field added to FormState after
        // this was saved still gets a sane default instead of `undefined`.
        return { ...DEFAULT_FORM, ...parsed };
    } catch {
        return DEFAULT_FORM;
    }
}

const QbgPoolConfigForm = forwardRef<PoolConfigHandle, QbgPoolConfigFormProps>(function QbgPoolConfigForm(_props, ref) {
    const [form, setForm] = useState<FormState>(loadPersistedForm);
    const [filters, setFilters] = useState<PoolFilterOptions | null>(null);
    const [loadingFilters, setLoadingFilters] = useState(true);
    const [filtersError, setFiltersError] = useState<string | null>(null);

    useEffect(() => {
        try {
            window.sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
        } catch {
            /* sessionStorage unavailable (private mode / quota) — persistence is best-effort */
        }
    }, [form]);
    const [newBatch, setNewBatch] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingFilters(true);
            setFiltersError(null);
            try {
                const res = await fetch("/api/qbg/pipeline/filters", { cache: "no-store" });
                const data = (await res.json()) as { success?: boolean; error?: string } & Partial<PoolFilterOptions>;
                if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status}).`);
                if (!cancelled) {
                    setFilters({
                        subjects: data.subjects || [],
                        classLevels: data.classLevels || [],
                        categories: data.categories || [],
                        sources: data.sources || [],
                        questionTypes: data.questionTypes || [],
                        chaptersBySubject: data.chaptersBySubject || {},
                        chaptersBySubjectClass: data.chaptersBySubjectClass || {},
                        topicsByChapter: data.topicsByChapter || {},
                        subtopicsByTopic: data.subtopicsByTopic || {},
                        batchNames: data.batchNames || [],
                    });
                }
            } catch (err) {
                if (!cancelled) setFiltersError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setLoadingFilters(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const availableSubjects = filters?.subjects || [];

    // Reset the question-type distribution to the preset's default whenever
    // examPreset changes (NEET/JEE_MAINS only — JEE_ADVANCE uses the
    // per-paper effect below), mirroring testGeneration's page.tsx.
    useEffect(() => {
        setForm((prev) => {
            if (prev.examPreset === "JEE_MAINS") {
                return { ...prev, questionDistribution: createDistributionRows(DEFAULT_JEE_MAINS_DISTRIBUTION) };
            }
            if (prev.examPreset === "NEET") {
                return { ...prev, questionDistribution: createDistributionRows(DEFAULT_NEET_DISTRIBUTION) };
            }
            return prev;
        });
    }, [form.examPreset]);

    // Keep the per-paper distribution in sync with year/paper selection for
    // JEE_ADVANCE, diffing against current rows to avoid needless resets that
    // would wipe a user's manual edits on an unrelated re-render.
    useEffect(() => {
        if (form.examPreset !== "JEE_ADVANCE") return;
        setForm((prev) => {
            if (prev.examPreset !== "JEE_ADVANCE") return prev;
            const nextMap: Partial<Record<JeeAdvancedPaper, QuestionDistributionRow[]>> = { ...prev.questionDistributionByPaper };
            let changed = false;
            prev.jeeAdvancedPapers.forEach((paper) => {
                const defaults = getDefaultAdvanceDistributionRows(prev.jeeAdvancedYear, paper);
                const current = prev.questionDistributionByPaper[paper] || [];
                const same =
                    current.length === defaults.length &&
                    current.every((row, idx) => row.type === defaults[idx]?.type && row.count === defaults[idx]?.count);
                if (!same) {
                    nextMap[paper] = defaults;
                    changed = true;
                }
            });
            if (!changed) return prev;
            return { ...prev, questionDistributionByPaper: nextMap };
        });
    }, [form.examPreset, form.jeeAdvancedYear, form.jeeAdvancedPapers]);

    function updateDistributionCount(rowId: string, value: number, paper?: JeeAdvancedPaper) {
        const nextCount = Math.max(1, Math.floor(value || 1));
        setForm((prev) => {
            if (paper) {
                const rows = prev.questionDistributionByPaper[paper] || [];
                return {
                    ...prev,
                    questionDistributionByPaper: {
                        ...prev.questionDistributionByPaper,
                        [paper]: rows.map((r) => (r.id === rowId ? { ...r, count: nextCount } : r)),
                    },
                };
            }
            return {
                ...prev,
                questionDistribution: prev.questionDistribution.map((r) => (r.id === rowId ? { ...r, count: nextCount } : r)),
            };
        });
    }

    function updateDistributionType(rowId: string, newType: string, paper?: JeeAdvancedPaper) {
        setForm((prev) => {
            if (paper) {
                const rows = prev.questionDistributionByPaper[paper] || [];
                return {
                    ...prev,
                    questionDistributionByPaper: {
                        ...prev.questionDistributionByPaper,
                        [paper]: rows.map((r) => (r.id === rowId ? { ...r, type: newType } : r)),
                    },
                };
            }
            return {
                ...prev,
                questionDistribution: prev.questionDistribution.map((r) => (r.id === rowId ? { ...r, type: newType } : r)),
            };
        });
    }

    function addDistributionRow(paper?: JeeAdvancedPaper) {
        const defaultType = filters?.questionTypes[0] || "Single_Choice(SCQ)";
        const newRow: QuestionDistributionRow = { id: makeRowId(), type: defaultType, count: 1 };
        setForm((prev) => {
            if (paper) {
                const rows = prev.questionDistributionByPaper[paper] || [];
                return { ...prev, questionDistributionByPaper: { ...prev.questionDistributionByPaper, [paper]: [...rows, newRow] } };
            }
            return { ...prev, questionDistribution: [...prev.questionDistribution, newRow] };
        });
    }

    function removeDistributionRow(rowId: string, paper?: JeeAdvancedPaper) {
        setForm((prev) => {
            if (paper) {
                const rows = prev.questionDistributionByPaper[paper] || [];
                return { ...prev, questionDistributionByPaper: { ...prev.questionDistributionByPaper, [paper]: rows.filter((r) => r.id !== rowId) } };
            }
            return { ...prev, questionDistribution: prev.questionDistribution.filter((r) => r.id !== rowId) };
        });
    }

    /** Chapters for one subject, scoped to the union of `classLevels` when any
     *  are selected (empty = any class). */
    function chaptersForSubject(classLevels: string[], subject: string): string[] {
        // Both branches come back in textbook order (the API sorts them that way).
        // The class-filtered branch MERGES several class lists, so it has to re-sort
        // — and a plain .sort() here was silently undoing that ordering, putting
        // "Alternating Current" above "Mathematical Tools and Vectors" the moment a
        // class was picked (2026-09-03 bug report).
        if (!classLevels.length) return filters?.chaptersBySubject[subject] || [];
        const set = new Set<string>();
        for (const cls of classLevels) {
            for (const ch of filters?.chaptersBySubjectClass[cls]?.[subject] || []) set.add(ch);
        }
        return Array.from(set).sort((a, b) => compareChaptersBySubject(subject, a, b));
    }

    function toggleSubject(subject: string) {
        setForm((prev) => {
            const nextSubjects = toggleArrayValue(prev.selectedSubjects, subject);
            const nextSelectedChapters = Object.fromEntries(
                Object.entries(prev.selectedChapters).filter(([subj]) => nextSubjects.includes(subj))
            );
            return { ...prev, selectedSubjects: nextSubjects, selectedChapters: nextSelectedChapters };
        });
    }

    /** Toggling a class prunes any manually-selected chapters that don't
     *  belong to the new class set, so a stale chapter from a dropped class
     *  can't silently stay selected once it drops out of the picker. */
    function toggleClassLevel(cls: string) {
        setForm((prev) => {
            const nextClassLevels = toggleArrayValue(prev.classLevels, cls);
            const nextSelectedChapters: Record<string, string[]> = {};
            for (const [subject, chapters] of Object.entries(prev.selectedChapters)) {
                const allowed = new Set(chaptersForSubject(nextClassLevels, subject));
                const filtered = chapters.filter((c) => allowed.has(c));
                if (filtered.length) nextSelectedChapters[subject] = filtered;
            }
            return { ...prev, classLevels: nextClassLevels, selectedChapters: nextSelectedChapters };
        });
    }

    function clearClassLevels() {
        setForm((prev) => ({ ...prev, classLevels: [] }));
    }

    function toggleChapter(subject: string, chapter: string) {
        setForm((prev) => {
            const current = prev.selectedChapters[subject] || [];
            const isSelected = current.includes(chapter);
            const nextChapters = isSelected ? current.filter((c) => c !== chapter) : [...current, chapter];
            const nextTopics = { ...prev.selectedTopicsByChapter };
            if (isSelected) delete nextTopics[chapter];
            return {
                ...prev,
                selectedChapters: { ...prev.selectedChapters, [subject]: nextChapters },
                chapterCounts: {
                    ...prev.chapterCounts,
                    [subject]: Object.fromEntries(
                        Object.entries(prev.chapterCounts[subject] || {}).filter(([c]) =>
                            nextChapters.includes(c)
                        )
                    ),
                },
                selectedTopicsByChapter: nextTopics,
            };
        });
    }

    function toggleTopic(chapter: string, topic: string) {
        setForm((prev) => {
            const current = prev.selectedTopicsByChapter[chapter] || [];
            const next = current.includes(topic) ? current.filter((t) => t !== topic) : [...current, topic];
            return { ...prev, selectedTopicsByChapter: { ...prev.selectedTopicsByChapter, [chapter]: next } };
        });
    }

    function toggleSubtopic(topic: string, subtopic: string) {
        setForm((prev) => {
            const current = prev.selectedSubtopicsByTopic[topic] || [];
            const next = current.includes(subtopic) ? current.filter((s) => s !== subtopic) : [...current, subtopic];
            return { ...prev, selectedSubtopicsByTopic: { ...prev.selectedSubtopicsByTopic, [topic]: next } };
        });
    }

    function toggleSource(source: string) {
        setForm((prev) => {
            const exists = prev.sourcePreferences.some((p) => p.source === source);
            const nextSources = exists
                ? prev.sourcePreferences.map((p) => p.source).filter((s) => s !== source)
                : [...prev.sourcePreferences.map((p) => p.source), source];
            const percentages = buildEqualSourcePercentages(nextSources);
            return { ...prev, sourcePreferences: nextSources.map((s) => ({ source: s, percent: percentages[s] })) };
        });
    }

    function selectAllSources() {
        const nextSources = filters?.sources || [];
        const percentages = buildEqualSourcePercentages(nextSources);
        setForm((prev) => ({ ...prev, sourcePreferences: nextSources.map((s) => ({ source: s, percent: percentages[s] })) }));
    }

    function clearAllSources() {
        setForm((prev) => ({ ...prev, sourcePreferences: [] }));
    }

    function setSourcePercent(source: string, percent: number) {
        setForm((prev) => ({
            ...prev,
            sourcePreferences: prev.sourcePreferences.map((p) =>
                p.source === source ? { ...p, percent: clamp(percent, 0, 100) } : p
            ),
        }));
    }

    function updateDifficulty(easy: number, hard: number, changed: "easy" | "hard") {
        let nextEasy = clamp(easy, 0, 100);
        let nextHard = clamp(hard, 0, 100);
        if (changed === "easy") nextHard = Math.min(nextHard, 100 - nextEasy);
        else nextEasy = Math.min(nextEasy, 100 - nextHard);
        setForm((prev) => ({ ...prev, difficultyDistribution: { easyPercent: nextEasy, hardPercent: nextHard } }));
    }

    function addBatch() {
        const name = newBatch.trim();
        if (!name || form.batches.includes(name)) return;
        setForm((prev) => ({ ...prev, batches: [...prev.batches, name] }));
        setNewBatch("");
    }

    function toggleBatch(name: string) {
        setForm((prev) => ({ ...prev, batches: toggleArrayValue(prev.batches, name) }));
    }

    const sourcePercentTotal = useMemo(
        () => form.sourcePreferences.reduce((sum, p) => sum + (p.percent || 0), 0),
        [form.sourcePreferences]
    );

    // --- Manual paper plan ------------------------------------------------

    const [planEdited, setPlanEdited] = useState(false);
    const [planStale, setPlanStale] = useState(false);
    const [availabilityLoading, setAvailabilityLoading] = useState(false);
    const [availabilityError, setAvailabilityError] = useState<string | null>(null);

    /** Chapters the plan may draw on for one subject: the explicit selection
     *  when the syllabus is limited, otherwise everything the class offers. */
    function planChaptersForSubject(subject: string): string[] {
        const chosen = form.selectedChapters[subject] || [];
        if (!form.fullSyllabus && chosen.length > 0) {
            return [...chosen].sort((a, b) => compareChaptersBySubject(subject, a, b));
        }
        return chaptersForSubject(form.classLevels, subject);
    }

    function buildPlanFromForm(): PlanSlot[] {
        const requirements = resolvePlanRequirements({
            examPreset: form.examPreset,
            jeeAdvancedYear: form.examPreset === "JEE_ADVANCE" ? form.jeeAdvancedYear : undefined,
            jeeAdvancedPapers: form.examPreset === "JEE_ADVANCE" ? form.jeeAdvancedPapers : undefined,
            questionTypeDistribution:
                form.examPreset !== "JEE_ADVANCE" ? rowsWithQuestionNumbers(form.questionDistribution) : undefined,
            questionTypeDistributionByPaper:
                form.examPreset === "JEE_ADVANCE"
                    ? Object.fromEntries(
                          form.jeeAdvancedPapers.map((p) => [
                              p,
                              rowsWithQuestionNumbers(form.questionDistributionByPaper[p] || []),
                          ])
                      )
                    : undefined,
            selectedSubjects: form.selectedSubjects.length ? form.selectedSubjects : undefined,
        });
        const chaptersBySubject: Record<string, string[]> = {};
        for (const req of requirements) chaptersBySubject[req.subject] = planChaptersForSubject(req.subject);
        return buildPaperPlan({
            requirements: requirements.map((r) => ({
                subject: r.subject,
                paper: r.paper,
                questionTypes: r.questionTypes,
            })),
            chaptersBySubject,
            topicsByChapter: form.fullSyllabus ? {} : form.selectedTopicsByChapter,
            difficultyDistribution: form.difficultyDistribution,
            sourcePreferences: form.sourcePreferences,
            chapterCounts: form.fullSyllabus ? {} : form.chapterCounts,
        });
    }

    function regeneratePlan() {
        const slots = buildPlanFromForm();
        setPlanEdited(false);
        setPlanStale(false);
        setForm((prev) => ({ ...prev, paperPlan: slots }));
    }

    // Everything the blueprint is derived from. When one of these changes the
    // plan on screen no longer matches the settings, so it is rebuilt. Unless
    // the user has hand-edited it: then their edits are kept and the plan is
    // only flagged as out of date, for them to rebuild deliberately.
    const planSignature = useMemo(
        () =>
            JSON.stringify([
                form.examPreset,
                form.jeeAdvancedYear,
                form.jeeAdvancedPapers,
                form.selectedSubjects,
                form.fullSyllabus,
                form.selectedChapters,
                form.chapterCounts,
                form.selectedTopicsByChapter,
                form.classLevels,
                form.sourcePreferences,
                form.difficultyDistribution,
                form.questionDistribution.map((r) => [r.type, r.count]),
                form.questionDistributionByPaper,
            ]),
        [
            form.examPreset,
            form.jeeAdvancedYear,
            form.jeeAdvancedPapers,
            form.selectedSubjects,
            form.fullSyllabus,
            form.selectedChapters,
            form.chapterCounts,
            form.selectedTopicsByChapter,
            form.classLevels,
            form.sourcePreferences,
            form.difficultyDistribution,
            form.questionDistribution,
            form.questionDistributionByPaper,
        ]
    );
    const lastPlanSignature = useRef<string | null>(null);

    useEffect(() => {
        if (form.paperBalance !== "manual") return;
        if (lastPlanSignature.current === planSignature && form.paperPlan.length > 0) return;
        lastPlanSignature.current = planSignature;
        if (planEdited && form.paperPlan.length > 0) {
            setPlanStale(true);
            return;
        }
        regeneratePlan();
        // regeneratePlan reads the very form state this effect depends on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form.paperBalance, planSignature]);

    /** Availability for the current plan, refreshed as the plan is edited. */
    const planQuerySignature = JSON.stringify(
        form.paperPlan.map((sl) => [sl.subject, sl.chapter, sl.topic, sl.difficulty, sl.questionType, sl.source])
    );

    useEffect(() => {
        if (form.paperBalance !== "manual" || form.paperPlan.length === 0) return;
        const slots = form.paperPlan.map((sl) => ({
            subject: sl.subject,
            chapter: sl.chapter,
            topic: sl.topic,
            difficulty: sl.difficulty,
            questionType: sl.questionType,
            source: sl.source,
        }));
        const key = JSON.stringify(slots);
        let cancelled = false;
        // Debounced: one dropdown change re-renders every row, and a request per
        // change would hammer an endpoint that runs COUNT queries.
        const timer = window.setTimeout(async () => {
            setAvailabilityLoading(true);
            setAvailabilityError(null);
            try {
                const res = await fetch("/api/qbg/pipeline/plan-availability", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        slots,
                        classLevels: form.classLevels.length ? form.classLevels : undefined,
                        avoidBatchNames: form.batches.length ? form.batches : undefined,
                        hasVideoSolution: form.hasVideoSolution || undefined,
                        hasTextSolution: form.hasTextSolution || undefined,
                    }),
                });
                const data = (await res.json()) as { success?: boolean; error?: string; counts?: number[] };
                if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status}).`);
                if (cancelled) return;
                const counts = data.counts || [];
                setForm((prev) => {
                    // Apply only if the plan has not changed under the request.
                    const now = JSON.stringify(
                        prev.paperPlan.map((sl) => ({
                            subject: sl.subject,
                            chapter: sl.chapter,
                            topic: sl.topic,
                            difficulty: sl.difficulty,
                            questionType: sl.questionType,
                            source: sl.source,
                        }))
                    );
                    if (now !== key) return prev;
                    return {
                        ...prev,
                        paperPlan: prev.paperPlan.map((sl, i) => ({ ...sl, available: counts[i] ?? -1 })),
                    };
                });
            } catch (err) {
                if (!cancelled) setAvailabilityError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setAvailabilityLoading(false);
            }
        }, 450);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
        // `available` is written BY this effect, so depending on the whole plan
        // object would loop; planQuerySignature covers the fields it reads.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        form.paperBalance,
        planQuerySignature,
        form.classLevels,
        form.batches,
        form.hasVideoSolution,
        form.hasTextSolution,
    ]);

    function updateSlot(index: number, patch: Partial<PlanSlot>) {
        setPlanEdited(true);
        setForm((prev) => ({
            ...prev,
            paperPlan: prev.paperPlan.map((sl) => (sl.index === index ? { ...sl, ...patch, available: -1 } : sl)),
        }));
    }

    const planUnfillable = useMemo(
        () => form.paperPlan.filter((sl) => sl.available === 0).length,
        [form.paperPlan]
    );

    useImperativeHandle(ref, () => ({
        buildConfig: () => {
            const errors: string[] = [];
            if (form.examPreset === "JEE_ADVANCE" && form.jeeAdvancedPapers.length === 0) {
                errors.push("Select at least one JEE Advanced paper.");
            }
            if (form.paperBalance === "manual" && form.paperPlan.length === 0) {
                errors.push("Paper balancing is set to Manual but the plan is empty - build it, or switch back to Auto.");
            }
            if (errors.length) return { config: null, errors };

            const config: PoolSelectionConfig = {
                examPreset: form.examPreset,
                jeeAdvancedYear: form.examPreset === "JEE_ADVANCE" ? form.jeeAdvancedYear : undefined,
                jeeAdvancedPapers: form.examPreset === "JEE_ADVANCE" ? form.jeeAdvancedPapers : undefined,
                questionTypeDistribution:
                    form.examPreset !== "JEE_ADVANCE" ? rowsWithQuestionNumbers(form.questionDistribution) : undefined,
                questionTypeDistributionByPaper:
                    form.examPreset === "JEE_ADVANCE"
                        ? Object.fromEntries(
                              form.jeeAdvancedPapers.map((p) => [p, rowsWithQuestionNumbers(form.questionDistributionByPaper[p] || [])])
                          )
                        : undefined,
                batchNames: form.batches.length ? form.batches : undefined,
                avoidBatchNames: form.batches,
                classLevels: form.classLevels.length ? form.classLevels : undefined,
                hasVideoSolution: form.hasVideoSolution || undefined,
                hasTextSolution: form.hasTextSolution || undefined,
                fullSyllabus: form.fullSyllabus,
                selectedSubjects: form.selectedSubjects.length ? form.selectedSubjects : undefined,
                selectedChapters: form.fullSyllabus ? {} : form.selectedChapters,
            chapterCounts: form.fullSyllabus ? {} : form.chapterCounts,
                selectedTopicsByChapter: form.fullSyllabus ? {} : form.selectedTopicsByChapter,
                selectedSubtopicsByTopic: form.fullSyllabus ? {} : form.selectedSubtopicsByTopic,
                sourcePreferences: form.sourcePreferences,
                difficultyDistribution: form.difficultyDistribution,
                // Auto sends no plan at all, so selection keeps its weighted
                // balancing; Manual sends the reviewed blueprint and every
                // question is picked to fill one named slot.
                paperPlan: form.paperBalance === "manual" ? form.paperPlan : undefined,
            };
            return { config, errors: [] };
        },
    }));

    return (
        <div style={{ display: "grid", gap: 14 }}>
            {filtersError && (
                <div style={{ ...card, borderColor: "rgba(var(--accent-danger-rgb),0.35)", color: "var(--accent-danger)", fontSize: "0.82rem" }}>
                    Could not load filter options from the pool dataset: {filtersError}
                </div>
            )}
            {loadingFilters && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: "var(--text-tertiary)" }}>
                    <Loader2 size={14} className="animate-spin" /> Loading pool filter options…
                </div>
            )}

            {/* Exam preset */}
            <div style={card}>
                <div style={{ ...sectionLabel, marginBottom: 8 }}>Exam preset</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(Object.keys(EXAM_PRESET_LABELS) as ExamPreset[]).map((preset) => (
                        <ChipButton key={preset} active={form.examPreset === preset} onClick={() => setForm((prev) => ({ ...prev, examPreset: preset }))}>
                            {EXAM_PRESET_LABELS[preset]}
                        </ChipButton>
                    ))}
                </div>

                {form.examPreset === "JEE_ADVANCE" && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 14 }}>
                        <div style={{ display: "grid", gap: 6 }}>
                            <span style={sectionLabel}>Pattern year</span>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                {ADVANCE_YEARS.map((year) => (
                                    <ChipButton key={year} active={form.jeeAdvancedYear === year} onClick={() => setForm((prev) => ({ ...prev, jeeAdvancedYear: year }))}>
                                        {year}
                                    </ChipButton>
                                ))}
                            </div>
                        </div>
                        <div style={{ display: "grid", gap: 6 }}>
                            <span style={sectionLabel}>Paper</span>
                            <div style={{ display: "flex", gap: 6 }}>
                                {(["Paper 1", "Paper 2"] as JeeAdvancedPaper[]).map((paper) => (
                                    <ChipButton
                                        key={paper}
                                        active={form.jeeAdvancedPapers.includes(paper)}
                                        onClick={() => setForm((prev) => ({ ...prev, jeeAdvancedPapers: toggleArrayValue(prev.jeeAdvancedPapers, paper) }))}
                                    >
                                        {paper}
                                    </ChipButton>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Question distribution — editable per-type counts, same as the Tests feature */}
            <div style={card}>
                <div style={{ ...sectionLabel, marginBottom: 8 }}>Question distribution</div>
                {form.examPreset === "JEE_ADVANCE" ? (
                    <div
                        style={{
                            display: "grid",
                            gap: 12,
                            gridTemplateColumns: form.jeeAdvancedPapers.length > 1 ? "repeat(auto-fit, minmax(320px, 1fr))" : "1fr",
                        }}
                    >
                        {form.jeeAdvancedPapers.map((paper) => (
                            <div key={paper} style={{ border: "1px solid var(--border-secondary)", borderRadius: 10, padding: 10, background: "var(--bg-tertiary)", display: "grid", gap: 8 }}>
                                <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>{paper}</div>
                                <QuestionDistributionTable
                                    rows={rowsForDisplay(form.questionDistributionByPaper[paper] || [])}
                                    questionTypes={filters?.questionTypes || []}
                                    onTypeChange={(id, type) => updateDistributionType(id, type, paper)}
                                    onCountChange={(id, count) => updateDistributionCount(id, count, paper)}
                                    onAddRow={() => addDistributionRow(paper)}
                                    onRemoveRow={(id) => removeDistributionRow(id, paper)}
                                />
                            </div>
                        ))}
                    </div>
                ) : (
                    <QuestionDistributionTable
                        rows={rowsForDisplay(form.questionDistribution)}
                        questionTypes={filters?.questionTypes || []}
                        onTypeChange={(id, type) => updateDistributionType(id, type)}
                        onCountChange={(id, count) => updateDistributionCount(id, count)}
                        onAddRow={() => addDistributionRow()}
                        onRemoveRow={(id) => removeDistributionRow(id)}
                    />
                )}
            </div>

            {/* Syllabus: class -> subject -> chapter -> topic -> subtopic cascade */}
            <div style={card}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, alignItems: "end" }}>
                    <div style={{ display: "grid", gap: 6 }}>
                        <span style={sectionLabel}>Class (optional, any of)</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            <ChipButton active={form.classLevels.length === 0} onClick={clearClassLevels}>Any</ChipButton>
                            {(filters?.classLevels || []).map((cls) => (
                                <ChipButton key={cls} active={form.classLevels.includes(cls)} onClick={() => toggleClassLevel(cls)}>
                                    Class {cls}
                                </ChipButton>
                            ))}
                        </div>
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                        <span style={sectionLabel}>Subjects (blank = preset default)</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {availableSubjects.map((subject) => (
                                <ChipButton key={subject} active={form.selectedSubjects.includes(subject)} onClick={() => toggleSubject(subject)}>
                                    {subject}
                                </ChipButton>
                            ))}
                        </div>
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                        <span style={sectionLabel}>Full syllabus?</span>
                        <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)", width: "fit-content" }}>
                            <ChipButton active={form.fullSyllabus} onClick={() => setForm((prev) => ({ ...prev, fullSyllabus: true, selectedChapters: {}, selectedTopicsByChapter: {}, selectedSubtopicsByTopic: {} }))}>
                                Yes
                            </ChipButton>
                            <ChipButton active={!form.fullSyllabus} onClick={() => setForm((prev) => ({ ...prev, fullSyllabus: false }))}>
                                No
                            </ChipButton>
                        </div>
                    </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-secondary)" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            checked={form.hasVideoSolution}
                            onChange={(e) => setForm((prev) => ({ ...prev, hasVideoSolution: e.target.checked }))}
                        />
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Has English video solution</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            checked={form.hasTextSolution}
                            onChange={(e) => setForm((prev) => ({ ...prev, hasTextSolution: e.target.checked }))}
                        />
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Has English text solution</span>
                    </label>
                </div>

                {!form.fullSyllabus && (
                    <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                        {(form.selectedSubjects.length ? form.selectedSubjects : availableSubjects).map((subject) => {
                            const chapters = chaptersForSubject(form.classLevels, subject);
                            if (!chapters.length) return null;
                            const selectedForSubject = form.selectedChapters[subject] || [];
                            return (
                                <div key={subject} style={{ border: "1px solid var(--border-secondary)", borderRadius: 10, padding: 10, background: "var(--bg-tertiary)" }}>
                                    <div style={{ fontSize: "0.82rem", fontWeight: 700, marginBottom: 6 }}>{subject}</div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                        {chapters.map((chapter) => (
                                            <ChipButton key={chapter} active={selectedForSubject.includes(chapter)} onClick={() => toggleChapter(subject, chapter)}>
                                                {chapter}
                                            </ChipButton>
                                        ))}
                                    </div>

                                    {/* Per-chapter question counts. Blank everywhere = the
                                        automatic even spread (unchanged default); type a
                                        number and that chapter's count becomes exact. */}
                                    {selectedForSubject.length > 0 && (() => {
                                        const counts = form.chapterCounts[subject] || {};
                                        const total = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
                                        const manual = total > 0;
                                        return (
                                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border-secondary)" }}>
                                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                                                    <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                                        Questions per chapter
                                                    </span>
                                                    <span style={{ fontSize: "0.72rem", color: manual ? "var(--accent-primary)" : "var(--text-tertiary)" }}>
                                                        {manual
                                                            ? `manual — ${total} question(s) across ${Object.values(counts).filter((n) => Number(n) > 0).length} chapter(s)`
                                                            : "auto — spread evenly across the selected chapters"}
                                                    </span>
                                                    {manual && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setForm((prev) => ({
                                                                    ...prev,
                                                                    chapterCounts: { ...prev.chapterCounts, [subject]: {} },
                                                                }))
                                                            }
                                                            style={{
                                                                border: "1px solid var(--border-primary)",
                                                                borderRadius: 7,
                                                                background: "var(--bg-secondary)",
                                                                color: "var(--text-secondary)",
                                                                fontSize: "0.72rem",
                                                                padding: "3px 9px",
                                                                cursor: "pointer",
                                                            }}
                                                        >
                                                            Back to auto
                                                        </button>
                                                    )}
                                                </div>
                                                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                                    {selectedForSubject.map((chapter) => (
                                                        <label
                                                            key={chapter}
                                                            style={{
                                                                display: "inline-flex",
                                                                alignItems: "center",
                                                                gap: 6,
                                                                border: "1px solid var(--border-primary)",
                                                                borderRadius: 8,
                                                                padding: "4px 8px",
                                                                background: "var(--bg-secondary)",
                                                                fontSize: "0.74rem",
                                                                color: "var(--text-secondary)",
                                                            }}
                                                        >
                                                            <span style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                                {chapter}
                                                            </span>
                                                            <input
                                                                type="number"
                                                                min={0}
                                                                placeholder="auto"
                                                                value={counts[chapter] ?? ""}
                                                                onChange={(e) => {
                                                                    const raw = e.target.value;
                                                                    setForm((prev) => {
                                                                        const next = { ...(prev.chapterCounts[subject] || {}) };
                                                                        if (raw === "") delete next[chapter];
                                                                        else next[chapter] = Math.max(0, Math.floor(Number(raw) || 0));
                                                                        return {
                                                                            ...prev,
                                                                            chapterCounts: { ...prev.chapterCounts, [subject]: next },
                                                                        };
                                                                    });
                                                                }}
                                                                style={{
                                                                    width: 58,
                                                                    borderRadius: 6,
                                                                    border: "1px solid var(--border-primary)",
                                                                    background: "var(--bg-tertiary)",
                                                                    color: "var(--text-primary)",
                                                                    fontSize: "0.74rem",
                                                                    padding: "3px 6px",
                                                                    outline: "none",
                                                                }}
                                                            />
                                                        </label>
                                                    ))}
                                                </div>
                                                {manual && (
                                                    <div style={{ marginTop: 6, fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                                        Only these counts are used for {subject} — a chapter left blank or at 0
                                                        contributes nothing. If the total doesn&rsquo;t match the paper size, the run
                                                        warns you rather than silently rebalancing.
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })()}

                                    {selectedForSubject.map((chapter) => {
                                        const topics = filters?.topicsByChapter[chapter] || [];
                                        if (!topics.length) return null;
                                        const selectedTopics = form.selectedTopicsByChapter[chapter] || [];
                                        return (
                                            <div key={chapter} style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--border-secondary)" }}>
                                                <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)", marginBottom: 4 }}>{chapter} — topics (blank = all)</div>
                                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                                    {topics.map((topic) => (
                                                        <ChipButton key={topic} active={selectedTopics.includes(topic)} onClick={() => toggleTopic(chapter, topic)}>
                                                            {topic}
                                                        </ChipButton>
                                                    ))}
                                                </div>

                                                {selectedTopics.map((topic) => {
                                                    const subtopics = filters?.subtopicsByTopic[topic] || [];
                                                    if (!subtopics.length) return null;
                                                    const selectedSubtopics = form.selectedSubtopicsByTopic[topic] || [];
                                                    return (
                                                        <div key={topic} style={{ marginTop: 6, paddingLeft: 12, borderLeft: "2px solid var(--border-secondary)" }}>
                                                            <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", marginBottom: 4 }}>{topic} — subtopics (blank = all)</div>
                                                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                                                {subtopics.map((subtopic) => (
                                                                    <ChipButton key={subtopic} active={selectedSubtopics.includes(subtopic)} onClick={() => toggleSubtopic(topic, subtopic)}>
                                                                        {subtopic}
                                                                    </ChipButton>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Source preference */}
            <div style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={sectionLabel}>Source preference (optional)</span>
                    {form.sourcePreferences.length > 0 && (
                        <span style={{ fontSize: "0.72rem", color: sourcePercentTotal > 100 ? "var(--accent-danger)" : "var(--text-tertiary)" }}>
                            {sourcePercentTotal}% total
                        </span>
                    )}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        <button
                            type="button"
                            onClick={selectAllSources}
                            style={{ border: "1px solid var(--border-primary)", borderRadius: 7, background: "var(--bg-tertiary)", color: "var(--text-secondary)", fontSize: "0.72rem", fontWeight: 500, padding: "4px 10px", cursor: "pointer" }}
                        >
                            Select all
                        </button>
                        <button
                            type="button"
                            onClick={clearAllSources}
                            disabled={form.sourcePreferences.length === 0}
                            style={{ border: "1px solid var(--border-primary)", borderRadius: 7, background: "var(--bg-tertiary)", color: "var(--text-secondary)", fontSize: "0.72rem", fontWeight: 500, padding: "4px 10px", cursor: form.sourcePreferences.length === 0 ? "default" : "pointer", opacity: form.sourcePreferences.length === 0 ? 0.5 : 1 }}
                        >
                            Clear all
                        </button>
                    </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {(filters?.sources || []).map((source) => (
                        <ChipButton key={source} active={form.sourcePreferences.some((p) => p.source === source)} onClick={() => toggleSource(source)}>
                            {source}
                        </ChipButton>
                    ))}
                </div>
                {form.sourcePreferences.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, borderTop: "1px solid var(--border-secondary)", paddingTop: 10, marginTop: 10 }}>
                        {form.sourcePreferences.map((p) => (
                            <div key={p.source} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem" }}>
                                <span style={{ color: "var(--text-secondary)", flex: 1 }}>{p.source}</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={p.percent}
                                    onChange={(e) => setSourcePercent(p.source, Number(e.target.value))}
                                    style={{ ...input, width: 70, padding: "5px 8px" }}
                                />
                                <span style={{ color: "var(--text-tertiary)" }}>%</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Difficulty distribution */}
            <div style={card}>
                <div style={{ ...sectionLabel, marginBottom: 8 }}>Difficulty (%)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Easy.text }}>Easy</span>
                        <input
                            type="number"
                            min={0}
                            max={100 - form.difficultyDistribution.hardPercent}
                            value={form.difficultyDistribution.easyPercent}
                            onChange={(e) => updateDifficulty(Number(e.target.value), form.difficultyDistribution.hardPercent, "easy")}
                            style={{ ...input, width: 70, padding: "5px 8px" }}
                        />
                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>%</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Hard.text }}>Hard</span>
                        <input
                            type="number"
                            min={0}
                            max={100 - form.difficultyDistribution.easyPercent}
                            value={form.difficultyDistribution.hardPercent}
                            onChange={(e) => updateDifficulty(form.difficultyDistribution.easyPercent, Number(e.target.value), "hard")}
                            style={{ ...input, width: 70, padding: "5px 8px" }}
                        />
                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>%</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: DIFFICULTY_COLORS.Medium.text }}>Medium</span>
                        <input
                            readOnly
                            value={100 - form.difficultyDistribution.easyPercent - form.difficultyDistribution.hardPercent}
                            style={{ ...input, width: 70, padding: "5px 8px", color: "var(--text-tertiary)" }}
                        />
                        <span style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>%</span>
                    </div>
                </div>
            </div>

            {/* Batches — dual purpose: written to used_in_exam AND excludes
                questions already tagged with any selected batch */}
            <div style={card}>
                <div style={{ display: "grid", gap: 6 }}>
                    <span style={sectionLabel}>Avoid questions already used in (optional)</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {(filters?.batchNames || []).map((name) => (
                            <ChipButton key={name} active={form.batches.includes(name)} onClick={() => toggleBatch(name)}>
                                {name}
                            </ChipButton>
                        ))}
                        {form.batches
                            .filter((name) => !(filters?.batchNames || []).includes(name))
                            .map((name) => (
                                <ChipButton key={name} active onClick={() => toggleBatch(name)}>
                                    {name}
                                </ChipButton>
                            ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        <input
                            value={newBatch}
                            onChange={(e) => setNewBatch(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    addBatch();
                                }
                            }}
                            placeholder="Type a batch name not listed above"
                            style={{ ...input, flex: 1 }}
                        />
                        <button
                            type="button"
                            onClick={addBatch}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                border: "1px solid var(--border-primary)",
                                borderRadius: 8,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "0 12px",
                                fontSize: "0.8rem",
                                cursor: "pointer",
                            }}
                        >
                            <Plus size={14} /> Add
                        </button>
                    </div>
                    {form.batches.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                            {form.batches.map((name) => (
                                <span
                                    key={name}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                        fontSize: "0.7rem",
                                        padding: "3px 8px",
                                        borderRadius: 999,
                                        background: "rgba(var(--accent-danger-rgb),0.1)",
                                        color: "var(--accent-danger)",
                                    }}
                                >
                                    {name}
                                    <X size={11} style={{ cursor: "pointer" }} onClick={() => toggleBatch(name)} />
                                </span>
                            ))}
                        </div>
                    )}
                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        Optional. Questions already tagged with any selected batch are excluded from this run, and every
                        newly selected question has all selected batches written to its used_in_exam. Leave blank to run
                        the pipeline without touching used_in_exam at all.
                    </span>
                </div>
            </div>

            {/* Paper balancing - auto by default; manual shows the full blueprint */}
            <div style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={sectionLabel}>Paper balancing</span>
                    <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--bg-tertiary)" }}>
                        <ChipButton
                            active={form.paperBalance === "auto"}
                            onClick={() => setForm((prev) => ({ ...prev, paperBalance: "auto" }))}
                        >
                            Auto
                        </ChipButton>
                        <ChipButton
                            active={form.paperBalance === "manual"}
                            onClick={() => setForm((prev) => ({ ...prev, paperBalance: "manual" }))}
                        >
                            Manual
                        </ChipButton>
                    </div>
                    {form.paperBalance === "manual" && (
                        <>
                            <button
                                type="button"
                                onClick={regeneratePlan}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: 7,
                                    background: planStale ? "rgba(var(--accent-warning-rgb),0.16)" : "var(--bg-tertiary)",
                                    color: planStale ? "var(--accent-warning)" : "var(--text-secondary)",
                                    fontSize: "0.72rem",
                                    padding: "4px 10px",
                                    cursor: "pointer",
                                }}
                            >
                                {planStale ? "Settings changed - rebuild plan" : "Rebuild plan"}
                            </button>
                            {availabilityLoading && (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    <Loader2 size={12} className="animate-spin" /> counting candidates...
                                </span>
                            )}
                        </>
                    )}
                </div>

                {form.paperBalance === "auto" && (
                    <div style={{ marginTop: 8, fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                        Questions are balanced while they are picked - chapters spread evenly, difficulty and source
                        following the percentages above. Switch to Manual to see and edit the exact paper plan first.
                    </div>
                )}

                {form.paperBalance === "manual" && (
                    <div style={{ marginTop: 12 }}>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 8, fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                            <span>{form.paperPlan.length} question(s) planned</span>
                            {planUnfillable > 0 && (
                                <span style={{ color: "var(--accent-danger)", fontWeight: 600 }}>
                                    {planUnfillable} slot(s) have nothing in the database - change the topic, difficulty
                                    or source on those rows
                                </span>
                            )}
                            {availabilityError && (
                                <span style={{ color: "var(--accent-danger)" }}>Availability lookup failed: {availabilityError}</span>
                            )}
                        </div>

                        {form.paperPlan.length === 0 ? (
                            <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                                No plan yet - pick the subjects, chapters and question counts above, then press
                                &ldquo;Rebuild plan&rdquo;.
                            </div>
                        ) : (
                            <div style={{ maxHeight: 460, overflow: "auto", border: "1px solid var(--border-secondary)", borderRadius: 10 }}>
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: PLAN_GRID_COLS,
                                        gap: 6,
                                        padding: "8px 10px",
                                        position: "sticky",
                                        top: 0,
                                        background: "var(--bg-secondary)",
                                        borderBottom: "1px solid var(--border-secondary)",
                                        fontSize: "0.68rem",
                                        fontWeight: 700,
                                        color: "var(--text-tertiary)",
                                        zIndex: 1,
                                    }}
                                >
                                    <span>Q#</span>
                                    <span>Type</span>
                                    <span>Subject</span>
                                    <span>Chapter</span>
                                    <span>Topic</span>
                                    <span>Difficulty</span>
                                    <span>Source</span>
                                    <span title="Questions in the pool matching this exact row">In DB</span>
                                </div>
                                {form.paperPlan.map((slot) => {
                                    const chapterOptions = planChaptersForSubject(slot.subject);
                                    const topicOptions = filters?.topicsByChapter[slot.chapter] || [];
                                    const zero = slot.available === 0;
                                    return (
                                        <div
                                            key={`${slot.paper || ""}-${slot.index}`}
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: PLAN_GRID_COLS,
                                                gap: 6,
                                                alignItems: "center",
                                                padding: "5px 10px",
                                                borderBottom: "1px solid var(--border-secondary)",
                                                background: zero ? "rgba(var(--accent-danger-rgb),0.07)" : "transparent",
                                            }}
                                        >
                                            <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                                                {slot.index}
                                            </span>
                                            <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {getQuestionTypeLabel(slot.questionType)}
                                            </span>
                                            <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {slot.paper ? `${slot.subject} (${slot.paper})` : slot.subject}
                                            </span>
                                            <select
                                                value={slot.chapter}
                                                onChange={(e) => updateSlot(slot.index, { chapter: e.target.value, topic: null })}
                                                style={planCell}
                                            >
                                                {!chapterOptions.includes(slot.chapter) && (
                                                    <option value={slot.chapter}>{slot.chapter}</option>
                                                )}
                                                {chapterOptions.map((c) => (
                                                    <option key={c} value={c}>
                                                        {c}
                                                    </option>
                                                ))}
                                            </select>
                                            <select
                                                value={slot.topic || ""}
                                                onChange={(e) => updateSlot(slot.index, { topic: e.target.value || null })}
                                                style={planCell}
                                            >
                                                <option value="">Any topic</option>
                                                {!!slot.topic && !topicOptions.includes(slot.topic) && (
                                                    <option value={slot.topic}>{slot.topic}</option>
                                                )}
                                                {topicOptions.map((t) => (
                                                    <option key={t} value={t}>
                                                        {t}
                                                    </option>
                                                ))}
                                            </select>
                                            <select
                                                value={slot.difficulty}
                                                onChange={(e) => updateSlot(slot.index, { difficulty: e.target.value as PlanDifficulty })}
                                                style={planCell}
                                            >
                                                {(["Easy", "Medium", "Hard"] as PlanDifficulty[]).map((d) => (
                                                    <option key={d} value={d}>
                                                        {d}
                                                    </option>
                                                ))}
                                            </select>
                                            <select
                                                value={slot.source || ""}
                                                onChange={(e) => updateSlot(slot.index, { source: e.target.value || null })}
                                                style={planCell}
                                            >
                                                <option value="">Any source</option>
                                                {!!slot.source && !(filters?.sources || []).includes(slot.source) && (
                                                    <option value={slot.source}>{slot.source}</option>
                                                )}
                                                {(filters?.sources || []).map((src) => (
                                                    <option key={src} value={src}>
                                                        {src}
                                                    </option>
                                                ))}
                                            </select>
                                            <span
                                                style={{
                                                    fontSize: "0.74rem",
                                                    fontWeight: 700,
                                                    textAlign: "right",
                                                    color: zero
                                                        ? "var(--accent-danger)"
                                                        : slot.available < 0
                                                          ? "var(--text-tertiary)"
                                                          : "var(--text-secondary)",
                                                }}
                                            >
                                                {slot.available < 0 ? "-" : slot.available}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <div style={{ marginTop: 8, fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                            The paper opens on its hardest questions, no two neighbouring questions come from the same
                            chapter (and where a chapter has to repeat, the topic changes), and each question type is
                            split evenly across the selected chapters. &ldquo;In DB&rdquo; counts pool questions matching
                            that row after the class, batch and solution filters above; a row showing 0 will be filled by
                            relaxing its source, then topic, then difficulty - never its chapter.
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});

export default QbgPoolConfigForm;
