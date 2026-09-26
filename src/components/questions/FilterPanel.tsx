"use client";

import { useState, useEffect, useCallback } from "react";
import { Filter, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import type { FilterState, MetadataHierarchy } from "@/types";
import { EMPTY_FILTERS, ALL_QUESTION_STATUSES, QUESTION_STATUS_LABELS } from "@/types";

interface FilterPanelProps {
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    totalResults: number;
}

const EMPTY_METADATA: MetadataHierarchy = {
    subjects: [],
    chaptersBySubject: {},
    topicsByChapter: {},
    subtopicsByTopic: {},
    questionTypes: [],
    difficultyLevels: [],
    sources: [],
    exams: [],
    classLevels: [],
};

function normalizeMetadata(data: unknown): MetadataHierarchy {
    const obj = (data && typeof data === "object" ? data : {}) as Partial<MetadataHierarchy>;
    return {
        subjects: Array.isArray(obj.subjects) ? obj.subjects : [],
        chaptersBySubject:
            obj.chaptersBySubject && typeof obj.chaptersBySubject === "object"
                ? obj.chaptersBySubject
                : {},
        topicsByChapter:
            obj.topicsByChapter && typeof obj.topicsByChapter === "object"
                ? obj.topicsByChapter
                : {},
        subtopicsByTopic:
            obj.subtopicsByTopic && typeof obj.subtopicsByTopic === "object"
                ? obj.subtopicsByTopic
                : {},
        questionTypes: Array.isArray(obj.questionTypes) ? obj.questionTypes : [],
        difficultyLevels: Array.isArray(obj.difficultyLevels) ? obj.difficultyLevels : [],
        sources: Array.isArray(obj.sources) ? obj.sources : [],
        exams: Array.isArray(obj.exams) ? obj.exams : [],
        classLevels: Array.isArray(obj.classLevels) ? obj.classLevels : [],
    };
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values)];
}

// Collapsible section for filter groups
function FilterSection({
    title,
    children,
    count,
    defaultOpen = false,
}: {
    title: string;
    children: React.ReactNode;
    count?: number;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div style={{ borderBottom: "1px solid var(--border-secondary)" }}>
            <button
                onClick={() => setOpen(!open)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "11px 16px",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    transition: "background 0.1s ease",
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                }}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
                {count !== undefined && count > 0 && (
                    <span
                        style={{
                            fontSize: "0.6rem",
                            padding: "1px 5px",
                            borderRadius: "4px",
                            background: "var(--accent-primary)",
                            color: "white",
                            fontWeight: 700,
                            minWidth: "16px",
                            textAlign: "center",
                        }}
                    >
                        {count}
                    </span>
                )}
            </button>
            {open && (
                <div
                    style={{ padding: "0 16px 10px 16px" }}
                    className="animate-fade-in"
                >
                    {children}
                </div>
            )}
        </div>
    );
}

// Checkbox item
function CheckboxItem({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label
            style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "4px 8px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "0.8rem",
                color: checked ? "var(--text-primary)" : "var(--text-secondary)",
                transition: "all 0.1s ease",
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
            }}
        >
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                style={{
                    accentColor: "var(--accent-primary)",
                    width: "14px",
                    height: "14px",
                    cursor: "pointer",
                }}
            />
            <span style={{ flex: 1, lineHeight: 1.3 }}>{label}</span>
        </label>
    );
}

export default function FilterPanel({
    filters,
    onFiltersChange,
    totalResults,
}: FilterPanelProps) {
    const [metadata, setMetadata] = useState<MetadataHierarchy | null>(null);
    const [loading, setLoading] = useState(true);

    // Fetch metadata for filter options
    useEffect(() => {
        fetch("/api/metadata")
            .then(async (res) => {
                if (!res.ok) throw new Error(`Metadata API failed: HTTP ${res.status}`);
                return res.json();
            })
            .then((data) => {
                setMetadata(normalizeMetadata(data));
                setLoading(false);
            })
            .catch((err) => {
                console.error("Failed to load metadata:", err);
                setMetadata(EMPTY_METADATA);
                setLoading(false);
            });
    }, []);

    const toggleFilter = useCallback(
        (key: keyof FilterState, value: string) => {
            const current = filters[key] as string[];
            const updated = current.includes(value)
                ? current.filter((v) => v !== value)
                : [...current, value];
            onFiltersChange({ ...filters, [key]: updated });
        },
        [filters, onFiltersChange]
    );

    const resetFilters = useCallback(() => {
        onFiltersChange({ ...EMPTY_FILTERS });
    }, [onFiltersChange]);

    const activeFilterCount = Object.entries(filters).reduce((acc, [key, val]) => {
        if (key === "search") return acc + (val ? 1 : 0);
        return acc + (Array.isArray(val) ? val.length : 0);
    }, 0);

    // Get available chapters based on selected subjects
    const availableChapters: string[] = (() => {
        if (!metadata) return [];
        if (filters.subjects.length === 0) {
            return uniqueStrings(metadata.subjects.flatMap(
                (subject) => metadata.chaptersBySubject[subject] || []
            ));
        }
        return uniqueStrings(filters.subjects.flatMap(
            (subject) => metadata.chaptersBySubject[subject] || []
        ));
    })();

    // Get available topics based on selected chapters
    const availableTopics: string[] = (() => {
        if (!metadata) return [];
        if (filters.chapters.length === 0) {
            if (filters.subjects.length === 0) {
                return uniqueStrings(Object.values(metadata.topicsByChapter).flat()).sort();
            }
            return uniqueStrings(availableChapters
                .flatMap((c) => metadata.topicsByChapter[c] || [])
            ).sort();
        }
        return uniqueStrings(filters.chapters
            .flatMap((c) => metadata.topicsByChapter[c] || [])
        ).sort();
    })();

    // Get available subtopics based on selected topics
    const availableSubtopics: string[] = (() => {
        if (!metadata || !metadata.subtopicsByTopic) return [];
        if (filters.topics.length === 0) return [];
        return uniqueStrings(filters.topics
            .flatMap((t) => metadata.subtopicsByTopic[t] || [])
        ).sort();
    })();

    if (loading) {
        return (
            <div
                style={{
                    padding: "20px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                }}
            >
                {[...Array(5)].map((_, i) => (
                    <div key={i} className="skeleton" style={{ height: "30px" }} />
                ))}
            </div>
        );
    }

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
                overflow: "hidden",
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: "14px 16px",
                    borderBottom: "1px solid var(--border-primary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Filter size={15} color="var(--accent-primary)" />
                    <span
                        style={{
                            fontSize: "0.82rem",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                        }}
                    >
                        Filters
                    </span>
                    {activeFilterCount > 0 && (
                        <span
                            style={{
                                fontSize: "0.6rem",
                                padding: "1px 5px",
                                borderRadius: "4px",
                                background: "var(--accent-primary)",
                                color: "white",
                                fontWeight: 700,
                                minWidth: "16px",
                                textAlign: "center",
                            }}
                        >
                            {activeFilterCount}
                        </span>
                    )}
                </div>
                {activeFilterCount > 0 && (
                    <button
                        onClick={resetFilters}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "4px 8px",
                            border: "none",
                            borderRadius: "6px",
                            background: "rgba(var(--accent-danger-rgb), 0.1)",
                            color: "var(--accent-danger)",
                            cursor: "pointer",
                            fontSize: "0.7rem",
                            fontWeight: 500,
                        }}
                    >
                        <RotateCcw size={11} />
                        Reset
                    </button>
                )}
            </div>

            {/* Results count */}
            <div
                style={{
                    padding: "9px 16px",
                    borderBottom: "1px solid var(--border-secondary)",
                    fontSize: "0.76rem",
                    color: "var(--text-tertiary)",
                }}
            >
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                    {totalResults.toLocaleString()}
                </span>{" "}
                questions found
            </div>

            {/* Filter sections - ORDER: Subject, Question Type, Class, Chapter, Topic, Subtopic, then Difficulty, Source at bottom */}
            <div style={{ flex: 1, overflow: "auto" }}>
                {/* Subject */}
                <FilterSection
                    title="Subject"
                    count={filters.subjects.length}
                    defaultOpen={true}
                >
                    {metadata?.subjects.map((subject) => (
                        <CheckboxItem
                            key={subject}
                            label={subject}
                            checked={filters.subjects.includes(subject)}
                            onChange={() => toggleFilter("subjects", subject)}
                        />
                    ))}
                </FilterSection>

                {/* Question Type */}
                <FilterSection
                    title="Question Type"
                    count={filters.question_types.length}
                    defaultOpen={true}
                >
                    {metadata?.questionTypes.map((type) => (
                        <CheckboxItem
                            key={type}
                            label={type}
                            checked={filters.question_types.includes(type)}
                            onChange={() => toggleFilter("question_types", type)}
                        />
                    ))}
                </FilterSection>

                {/* Class Level (new) */}
                {metadata?.classLevels && metadata.classLevels.length > 0 && (
                    <FilterSection
                        title="Class"
                        count={filters.class_levels.length}
                    >
                        {metadata.classLevels.map((cls) => (
                            <CheckboxItem
                                key={cls}
                                label={`Class ${cls}`}
                                checked={filters.class_levels.includes(cls)}
                                onChange={() => toggleFilter("class_levels", cls)}
                            />
                        ))}
                    </FilterSection>
                )}

                {/* Chapter (cascading from subject) */}
                <FilterSection
                    title={`Chapter${filters.subjects.length > 0 ? ` · ${filters.subjects.join(", ")}` : ""}`}
                    count={filters.chapters.length}
                >
                    {availableChapters.length === 0 ? (
                        <div
                            style={{
                                fontSize: "0.76rem",
                                color: "var(--text-muted)",
                                padding: "6px 8px",
                                fontStyle: "italic",
                            }}
                        >
                            Select a subject first
                        </div>
                    ) : (
                        <div style={{ maxHeight: "220px", overflow: "auto" }}>
                            {availableChapters.map((chapter) => (
                                <CheckboxItem
                                    key={chapter}
                                    label={chapter}
                                    checked={filters.chapters.includes(chapter)}
                                    onChange={() => toggleFilter("chapters", chapter)}
                                />
                            ))}
                        </div>
                    )}
                </FilterSection>

                {/* Topic (cascading from chapter) */}
                <FilterSection
                    title="Topic"
                    count={filters.topics.length}
                >
                    {availableTopics.length === 0 ? (
                        <div
                            style={{
                                fontSize: "0.76rem",
                                color: "var(--text-muted)",
                                padding: "6px 8px",
                                fontStyle: "italic",
                            }}
                        >
                            Select a chapter first
                        </div>
                    ) : (
                        <div style={{ maxHeight: "220px", overflow: "auto" }}>
                            {availableTopics.map((topic) => (
                                <CheckboxItem
                                    key={topic}
                                    label={topic}
                                    checked={filters.topics.includes(topic)}
                                    onChange={() => toggleFilter("topics", topic)}
                                />
                            ))}
                        </div>
                    )}
                </FilterSection>

                {/* Subtopic (cascading from topic) - new */}
                {availableSubtopics.length > 0 && (
                    <FilterSection
                        title="Subtopic"
                        count={filters.subtopics?.length || 0}
                    >
                        <div style={{ maxHeight: "220px", overflow: "auto" }}>
                            {availableSubtopics.map((subtopic) => (
                                <CheckboxItem
                                    key={subtopic}
                                    label={subtopic}
                                    checked={filters.subtopics?.includes(subtopic) || false}
                                    onChange={() => toggleFilter("subtopics", subtopic)}
                                />
                            ))}
                        </div>
                    </FilterSection>
                )}

                {/* ---- MOVED TO BOTTOM ---- */}

                {/* Difficulty */}
                <FilterSection
                    title="Difficulty"
                    count={filters.difficulty_levels.length}
                >
                    {metadata?.difficultyLevels.map((diff) => (
                        <CheckboxItem
                            key={diff}
                            label={diff}
                            checked={filters.difficulty_levels.includes(diff)}
                            onChange={() => toggleFilter("difficulty_levels", diff)}
                        />
                    ))}
                </FilterSection>

                {/* Source */}
                <FilterSection
                    title="Source"
                    count={filters.sources.length}
                >
                    {metadata?.sources.map((source) => (
                        <CheckboxItem
                            key={source}
                            label={source}
                            checked={filters.sources.includes(source)}
                            onChange={() => toggleFilter("sources", source)}
                        />
                    ))}
                </FilterSection>

                {/* QC workflow status */}
                <FilterSection
                    title="QC Status"
                    count={filters.statuses.length}
                >
                    {ALL_QUESTION_STATUSES.map((s) => (
                        <CheckboxItem
                            key={s}
                            label={QUESTION_STATUS_LABELS[s]}
                            checked={filters.statuses.includes(s)}
                            onChange={() => toggleFilter("statuses", s)}
                        />
                    ))}
                </FilterSection>
            </div>
        </div>
    );
}
