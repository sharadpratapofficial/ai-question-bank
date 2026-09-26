// Database constants for QBG View
// Updated from actual Supabase data exploration (2026-02-15)

/** Actual table name in Supabase */
export const TABLE_NAME = "qbg_questions";

/** Page size for paginated queries */
export const DEFAULT_PAGE_SIZE = 20;

/** Max rows Supabase returns per query without range() */
export const SUPABASE_MAX_ROWS = 1000;

/** Known subjects in the database */
export const KNOWN_SUBJECTS = ["Chemistry", "Maths", "Physics"] as const;

/** Known question types (discovered from data) */
export const KNOWN_QUESTION_TYPES = [
    "Single_Choice(SCQ)",
    "Multi_Choice(MCQ)",
    "Integer",
    "Numerical",
    "Single_Digit_Integer",
    "Assertion_Reason(AR)",
    "Matching_List(ML)",
    "Composite",
    "Passage_Numerical",
    "passage_numerical",
    "Unknown",
] as const;

/** Known difficulty levels */
export const KNOWN_DIFFICULTIES = ["Easy", "Medium", "Hard"] as const;

/** Known sources */
export const KNOWN_SOURCES = ["AIR", "3QuestionBank", "Milestone", "Prayas_Advance_New"] as const;

/** Display-friendly labels for question types */
export const QUESTION_TYPE_LABELS: Record<string, string> = {
    "Single_Choice(SCQ)": "SCQ",
    "Multi_Choice(MCQ)": "MCQ",
    Integer: "Integer",
    Numerical: "Numerical",
    Single_Digit_Integer: "Single Digit Integer",
    "Assertion_Reason(AR)": "Assertion & Reason",
    "Matching_List(ML)": "Matrix Match",
    Composite: "Composite",
    Passage_Numerical: "Passage Numerical",
    passage_numerical: "Passage Numerical",
    Unknown: "Unknown",
};

/** Color styles for subjects (inline style-safe) */
export const SUBJECT_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    Physics: { bg: "rgba(59, 130, 246, 0.12)", text: "#60a5fa", border: "rgba(59, 130, 246, 0.25)" },
    Chemistry: { bg: "rgba(var(--accent-success-rgb), 0.12)", text: "var(--accent-success)", border: "rgba(var(--accent-success-rgb), 0.25)" },
    Maths: { bg: "rgba(var(--accent-warning-rgb), 0.12)", text: "var(--accent-warning)", border: "rgba(var(--accent-warning-rgb), 0.25)" },
};

/** Color styles for difficulty */
export const DIFFICULTY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    Easy: { bg: "rgba(var(--accent-success-rgb), 0.12)", text: "var(--accent-success)", border: "rgba(var(--accent-success-rgb), 0.25)" },
    Medium: { bg: "rgba(var(--accent-warning-rgb), 0.12)", text: "var(--accent-warning)", border: "rgba(var(--accent-warning-rgb), 0.25)" },
    Hard: { bg: "rgba(var(--accent-danger-rgb), 0.12)", text: "var(--accent-danger)", border: "rgba(var(--accent-danger-rgb), 0.25)" },
};

/** Color styles for question types */
export const QUESTION_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    "Single_Choice(SCQ)": { bg: "rgba(99, 102, 241, 0.12)", text: "#818cf8", border: "rgba(99, 102, 241, 0.25)" },
    "Multi_Choice(MCQ)": { bg: "rgba(168, 85, 247, 0.12)", text: "#c084fc", border: "rgba(168, 85, 247, 0.25)" },
    Integer: { bg: "rgba(6, 182, 212, 0.12)", text: "#22d3ee", border: "rgba(6, 182, 212, 0.25)" },
    Numerical: { bg: "rgba(20, 184, 166, 0.12)", text: "#2dd4bf", border: "rgba(20, 184, 166, 0.25)" },
    Single_Digit_Integer: { bg: "rgba(14, 165, 233, 0.12)", text: "#38bdf8", border: "rgba(14, 165, 233, 0.25)" },
    "Assertion_Reason(AR)": { bg: "rgba(249, 115, 22, 0.12)", text: "#fb923c", border: "rgba(249, 115, 22, 0.25)" },
    "Matching_List(ML)": { bg: "rgba(236, 72, 153, 0.12)", text: "#f472b6", border: "rgba(236, 72, 153, 0.25)" },
    Composite: { bg: "rgba(244, 63, 94, 0.12)", text: "#fb7185", border: "rgba(244, 63, 94, 0.25)" },
    Passage_Numerical: { bg: "rgba(244, 63, 94, 0.12)", text: "#fb7185", border: "rgba(244, 63, 94, 0.25)" },
    passage_numerical: { bg: "rgba(244, 63, 94, 0.12)", text: "#fb7185", border: "rgba(244, 63, 94, 0.25)" },
    Unknown: { bg: "rgba(107, 114, 128, 0.12)", text: "#9ca3af", border: "rgba(107, 114, 128, 0.25)" },
};

/** Default color fallback */
export const DEFAULT_BADGE_COLOR = { bg: "rgba(107, 114, 128, 0.12)", text: "#9ca3af", border: "rgba(107, 114, 128, 0.25)" };
