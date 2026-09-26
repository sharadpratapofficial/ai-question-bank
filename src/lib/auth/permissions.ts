/**
 * Role-based access control: single source of truth for what each role can do.
 *
 * Shared between server (middleware, API routes) and client (UI gates).
 * Keep this file framework-agnostic so it can be imported from anywhere.
 */

export type UserRole =
    | "admin"
    | "manager"
    | "qc_reviewer"
    | "data_entry"
    | "ai_user"
    | "qbg_user"
    | "video_user"
    | "qbg_video_user"
    | "qwv_user"
    | "custom"
    | "viewer";

export const ALL_ROLES: UserRole[] = [
    "admin",
    "manager",
    "qc_reviewer",
    "data_entry",
    "ai_user",
    "qbg_user",
    "video_user",
    "qbg_video_user",
    "qwv_user",
    "custom",
    "viewer",
];

export type Permission =
    | "manage_users"
    | "create_batch"
    | "edit_metadata"
    | "manual_question_entry"
    | "upload_pdf"
    | "generate_tests"
    | "use_ai_tools"
    | "use_agentic_qc"      // Agentic QC only
    | "use_per_question_ai"
    | "use_qbg"             // QBG hub only (Pipeline/Modifier/Ingestion/Tagging)
    | "use_video_solution"  // Video Solution tool only
    | "use_question_wise_videos" // Question Wise Videos tool only
    | "use_circuit_designer" // Circuit Designer (CircuiTikZ editor) only
    | "view_questions"
    | "view_analytics"
    // Question-status workflow:
    | "submit_for_verification"   // create new questions / resubmit after rejection
    | "verify_qc1"                // pending -> verified
    | "verify_qc2"                // verified -> double_verified
    | "verify_uat"                // double_verified -> uat_passed
    | "reject_question"           // any -> rejected
    | "restore_question_version"; // restore from history (admin-only)

export const ALL_PERMISSIONS: Permission[] = [
    "manage_users",
    "create_batch",
    "edit_metadata",
    "manual_question_entry",
    "upload_pdf",
    "use_circuit_designer",
    "generate_tests",
    "use_ai_tools",
    "use_agentic_qc",
    "use_per_question_ai",
    "use_qbg",
    "use_video_solution",
    "use_question_wise_videos",
    "view_questions",
    "view_analytics",
    "submit_for_verification",
    "verify_qc1",
    "verify_qc2",
    "verify_uat",
    "reject_question",
    "restore_question_version",
];

const MANAGER_PERMS: Permission[] = [
    "create_batch",
    "edit_metadata",
    "manual_question_entry",
    "upload_pdf",
    "generate_tests",
    "use_ai_tools",
    "use_agentic_qc",
    "use_per_question_ai",
    // Explicit, not implied by use_ai_tools — QBG and Video Solution moved to
    // their own permission strings so they can be granted independently
    // (see qbg_user/video_user below); managers keep the access they had
    // before that split.
    "use_qbg",
    "use_video_solution",
    "use_question_wise_videos",
    "use_circuit_designer",
    "view_questions",
    "view_analytics",
    "submit_for_verification",
];

const QC_REVIEWER_PERMS: Permission[] = [
    "view_questions",
    "edit_metadata",
    "verify_qc1",
    "verify_qc2",
    "verify_uat",
    "reject_question",
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
    admin: [...ALL_PERMISSIONS],
    manager: MANAGER_PERMS,
    qc_reviewer: QC_REVIEWER_PERMS,
    data_entry: [
        "manual_question_entry",
        "view_questions",
        "submit_for_verification",
    ],
    // Explicit, not implied by use_ai_tools — see MANAGER_PERMS comment above.
    ai_user: [
        "use_ai_tools",
        "use_agentic_qc",
        "use_per_question_ai",
        "use_qbg",
        "use_video_solution",
        "use_question_wise_videos",
        "use_circuit_designer",
        "view_questions",
    ],
    custom: [],
    qbg_user: ["use_qbg"],
    video_user: ["use_video_solution"],
    qbg_video_user: ["use_qbg", "use_video_solution"],
    qwv_user: ["use_question_wise_videos"],
    viewer: ["view_questions"],
};

export const ROLE_LABELS: Record<UserRole, string> = {
    admin: "Admin",
    manager: "Manager",
    qc_reviewer: "QC Reviewer",
    data_entry: "Data Entry",
    ai_user: "AI User",
    qbg_user: "QBG User",
    video_user: "Video Solution User",
    qbg_video_user: "QBG + Video User",
    qwv_user: "Question Wise Videos User",
    custom: "Custom (features only)",
    viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
    admin: "Full access including user management.",
    manager:
        "Create batches, tag metadata, manage questions, run AI tools, generate tests, upload.",
    qc_reviewer:
        "Reviews questions through the QC workflow (1st QC, 2nd QC, UAT) and can reject. Can edit metadata.",
    data_entry: "Only manually add and edit questions + solutions; submits for verification.",
    ai_user: "View questions and run AI tools.",
    qbg_user: "Only the QBG hub (Pipeline, Modifier, Ingestion, Tagging).",
    video_user: "Only the Video Solution tool.",
    qbg_video_user: "The QBG hub and the Video Solution tool — nothing else.",
    qwv_user: "Only the Question Wise Videos tool.",
    custom:
        "No access on its own — start from nothing and tick exactly the features this person should have.",
    viewer: "Read-only access.",
};

/**
 * The feature list an admin ticks per user. Groups mirror the sidebar so the
 * checkboxes read like the app rather than like the permission strings.
 */
export interface FeatureSpec {
    permission: Permission;
    label: string;
    description: string;
    group: "Tools" | "Question bank" | "QC workflow" | "Administration";
}

export const FEATURE_CATALOGUE: FeatureSpec[] = [
    { permission: "use_qbg", label: "QBG", description: "Pipeline, Modifier, Ingestion and Tagging.", group: "Tools" },
    { permission: "use_agentic_qc", label: "Agentic QC", description: "Run parallel QC agents over a paper.", group: "Tools" },
    { permission: "use_ai_tools", label: "AI Tools", description: "The AI Tools page.", group: "Tools" },
    { permission: "use_video_solution", label: "Video Solution", description: "Narrated solution videos and decks.", group: "Tools" },
    { permission: "use_question_wise_videos", label: "Question Wise Videos", description: "Per-question clips from a lecture recording.", group: "Tools" },
    { permission: "use_circuit_designer", label: "Circuit Designer", description: "Draw and edit circuit diagrams, export PNG.", group: "Tools" },
    { permission: "use_per_question_ai", label: "Per-question AI", description: "AI actions on a single question.", group: "Tools" },

    { permission: "view_questions", label: "View questions", description: "Browse and search the question bank.", group: "Question bank" },
    { permission: "manual_question_entry", label: "Add questions", description: "Enter and edit questions by hand.", group: "Question bank" },
    { permission: "edit_metadata", label: "Edit metadata", description: "Change tags, subject, chapter and topic.", group: "Question bank" },
    { permission: "create_batch", label: "Create batches", description: "Create question batches.", group: "Question bank" },
    { permission: "upload_pdf", label: "Upload", description: "Upload PDFs and Word papers.", group: "Question bank" },
    { permission: "generate_tests", label: "Tests", description: "Generate and manage tests.", group: "Question bank" },
    { permission: "view_analytics", label: "Analytics", description: "The analytics dashboard.", group: "Question bank" },

    { permission: "submit_for_verification", label: "Submit for verification", description: "Send questions into the QC workflow.", group: "QC workflow" },
    { permission: "verify_qc1", label: "1st QC", description: "Move pending questions to verified.", group: "QC workflow" },
    { permission: "verify_qc2", label: "2nd QC", description: "Move verified questions to double-verified.", group: "QC workflow" },
    { permission: "verify_uat", label: "UAT", description: "Move double-verified questions to UAT passed.", group: "QC workflow" },
    { permission: "reject_question", label: "Reject questions", description: "Reject a question at any stage.", group: "QC workflow" },

    { permission: "manage_users", label: "User management", description: "Create users and change access. Grant sparingly.", group: "Administration" },
    { permission: "restore_question_version", label: "Restore versions", description: "Roll a question back to an earlier version.", group: "Administration" },
];

export const FEATURE_GROUPS: FeatureSpec["group"][] = [
    "Tools",
    "Question bank",
    "QC workflow",
    "Administration",
];

export function isPermission(value: unknown): value is Permission {
    return typeof value === "string" && (ALL_PERMISSIONS as string[]).includes(value);
}

/** Keep only real permission strings, deduped — used when reading from the DB. */
export function sanitizePermissions(value: unknown): Permission[] {
    if (!Array.isArray(value)) return [];
    const out: Permission[] = [];
    for (const v of value) {
        if (isPermission(v) && !out.includes(v)) out.push(v);
    }
    return out;
}

/**
 * What a user can actually do: the role's own permissions plus any features an
 * admin granted individually. Extras are additive — they can only widen access,
 * never silently take away what the role already implies.
 */
export function effectivePermissions(
    role: UserRole | null | undefined,
    extra?: unknown
): Permission[] {
    const base = role ? ROLE_PERMISSIONS[role] ?? [] : [];
    const grants = sanitizePermissions(extra);
    const out = [...base];
    for (const g of grants) if (!out.includes(g)) out.push(g);
    return out;
}

export function hasPermission(
    role: UserRole | null | undefined,
    permission: Permission
): boolean {
    if (!role) return false;
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasAnyPermission(
    role: UserRole | null | undefined,
    permissions: Permission[]
): boolean {
    if (!role) return false;
    return permissions.some((p) => hasPermission(role, p));
}

export function permissionsForRole(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role] ?? [];
}

export function isValidRole(value: unknown): value is UserRole {
    return typeof value === "string" && ALL_ROLES.includes(value as UserRole);
}

/**
 * Top-level pages, ordered by priority, paired with the permission that
 * gates them (mirrors Sidebar.tsx's nav item list / each page's route
 * target). Used to steer a freshly-logged-in user away from a page their
 * role can't see — e.g. the app's hardcoded post-login default ("/questions")
 * — toward the first page they actually have access to, instead of a dead
 * page with nothing on it.
 */
export const NAV_LANDING_PATHS: { permission: Permission; path: string }[] = [
    { permission: "view_questions", path: "/questions" },
    { permission: "use_qbg", path: "/qbg" },
    { permission: "use_video_solution", path: "/video-solution" },
    { permission: "use_question_wise_videos", path: "/question-wise-videos" },
    { permission: "use_circuit_designer", path: "/circuit-designer" },
    { permission: "use_agentic_qc", path: "/agentic-qc" },
    { permission: "use_ai_tools", path: "/ai-tools" },
    { permission: "generate_tests", path: "/tests" },
    { permission: "view_analytics", path: "/analytics" },
    { permission: "manage_users", path: "/admin/users" },
];

/** First page in NAV_LANDING_PATHS this role has access to; "/questions" if none. */
export function defaultLandingPath(role: UserRole | null | undefined): string {
    return defaultLandingPathFor(effectivePermissions(role));
}

/** Same, but for an already-resolved permission list (role + granted features). */
export function defaultLandingPathFor(permissions: Permission[]): string {
    for (const { permission, path } of NAV_LANDING_PATHS) {
        if (permissions.includes(permission)) return path;
    }
    return "/questions";
}

/** The permission gating `path`, if it's one of NAV_LANDING_PATHS's pages; else null. */
export function pathRequiresPermission(path: string): Permission | null {
    const entry = NAV_LANDING_PATHS.find((e) => path === e.path || path.startsWith(e.path + "/"));
    return entry ? entry.permission : null;
}
