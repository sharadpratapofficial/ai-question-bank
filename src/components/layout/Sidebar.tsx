"use client";

import { useEffect, useMemo, useState } from "react";
import {
    Search,
    FileText,
    BarChart3,
    GraduationCap,
    Sparkles,
    Database,
    Layers,
    Bot,
    Wand2,
    Video,
    CircuitBoard,
    Clapperboard,
    Moon,
    Sun,
    ShieldCheck,
    LogOut,
    UserCircle2,
    KeyRound,
    LockKeyhole,
    Loader2,
} from "lucide-react";
import { useTheme } from "@/lib/theme";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { useCurrentUser } from "@/context/UserProfileContext";
import type { Permission } from "@/lib/auth/permissions";
import {
    API_KEY_PROVIDER_LABELS,
    EMPTY_USER_API_KEYS,
    SUPPORTED_API_PROVIDERS,
    providerNeedsApiKey,
    parseCustomOpenAIProviderConfig,
    parseGoogleDriveProviderConfig,
    parseQbgProviderConfig,
    readDevApiKeysFromStorage,
    sanitizeUserApiKeys,
    stringifyCustomOpenAIProviderConfig,
    stringifyGoogleDriveProviderConfig,
    stringifyQbgProviderConfig,
    writeDevApiKeysToStorage,
    type UserApiKeys,
} from "@/lib/userApiKeys";

interface NavItem {
    id: string;
    label: string;
    icon?: React.ReactNode;
    badge?: string;
    disabled?: boolean;
    /** If set, item only shown when user has this permission. */
    requires?: Permission;
}

const allNavItems: NavItem[] = [
    { id: "questions", label: "Questions", icon: <Search size={18} />, requires: "view_questions" },
    { id: "tests", label: "Tests", icon: <FileText size={18} />, requires: "generate_tests" },
    { id: "analytics", label: "Analytics", icon: <BarChart3 size={18} />, requires: "view_analytics" },
    { id: "ai", label: "AI Tools", icon: <Sparkles size={18} />, requires: "use_ai_tools" },
    // Agentic QC runs 1-3 parallel QC agents on a paper, then an aggregator
    // reconciles their answers. Lives at /agentic-qc.
    { id: "agentic-qc", label: "Agentic QC", icon: <Bot size={18} />, requires: "use_agentic_qc" },
    // QBG hub: AI tools built around the QBG (PenPencil) question bank — QBG
    // Modifier (reframe a Word test's MCQs into QBG-format questions), plus
    // QBG Ingestion / QBG Tagging (coming soon) as tabs. Lives at /qbg.
    { id: "qbg", label: "QBG", icon: <Wand2 size={18} />, requires: "use_qbg" },
    // Video Solution: its own page (independent of the rest of AI Tools) so a
    // user can be granted just this one feature. Lives at /video-solution.
    { id: "video-solution", label: "Video Solution", icon: <Video size={18} />, requires: "use_video_solution" },
    // Question Wise Videos: detects per-question timestamp boundaries in a
    // recorded lecture (classical CV, no AI model) and optionally crops one
    // clip per question. Lives at /question-wise-videos.
    {
        id: "question-wise-videos",
        label: "Question Wise Videos",
        icon: <Clapperboard size={18} />,
        requires: "use_question_wise_videos",
    },
    // Circuit Designer: draw/edit circuit diagrams with live CircuiTikZ code
    // both ways, and export PNG. Lives at /circuit-designer.
    {
        id: "circuit-designer",
        label: "Circuit Designer",
        icon: <CircuitBoard size={18} />,
        requires: "use_circuit_designer",
    },
];

const allBottomNavItems: NavItem[] = [
    { id: "admin", label: "Admin", icon: <ShieldCheck size={18} />, requires: "manage_users" },
];

interface SidebarProps {
    activeTab: string;
    onTabChange: (tab: string) => void;
}

export default function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const supabase = useMemo(() => createClient(), []);
    const [hovered, setHovered] = useState<string | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [hasDevAuth, setHasDevAuth] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [showApiKeysModal, setShowApiKeysModal] = useState(false);
    const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
    const [signingOut, setSigningOut] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [loadingApiKeys, setLoadingApiKeys] = useState(false);
    const [savingApiKeys, setSavingApiKeys] = useState(false);
    const [apiKeys, setApiKeys] = useState<UserApiKeys>({ ...EMPTY_USER_API_KEYS });
    const [apiKeysError, setApiKeysError] = useState<string | null>(null);
    const [apiKeysMessage, setApiKeysMessage] = useState<string | null>(null);
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changePasswordError, setChangePasswordError] = useState<string | null>(null);
    const [changePasswordMessage, setChangePasswordMessage] = useState<string | null>(null);
    const { theme, toggleTheme } = useTheme();
    const { can, roleLabel, loading: permLoading } = useCurrentUser();
    const navItems = useMemo(
        () =>
            // While permissions are loading show all items optimistically — each page
            // has its own RequirePermission guard that handles unauthorised access.
            permLoading
                ? allNavItems
                : allNavItems.filter((item) => !item.requires || can(item.requires)),
        [can, permLoading]
    );
    const bottomNavItems = useMemo(
        () =>
            permLoading
                ? allBottomNavItems
                : allBottomNavItems.filter((item) => !item.requires || can(item.requires)),
        [can, permLoading]
    );

    useEffect(() => {
        let mounted = true;

        async function loadUser() {
            const devAuth = document.cookie.includes("qbg_dev_auth=1");
            if (mounted) setHasDevAuth(devAuth);

            const {
                data: { user: authUser },
            } = await supabase.auth.getUser();
            if (mounted) setUser(authUser);
        }

        loadUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setUser(session?.user ?? null);
            setHasDevAuth(document.cookie.includes("qbg_dev_auth=1"));
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, [supabase]);

    async function loadApiKeys() {
        setLoadingApiKeys(true);
        setApiKeysError(null);
        setApiKeysMessage(null);

        try {
            if (user) {
                const response = await fetch("/api/user/api-keys", {
                    method: "GET",
                    cache: "no-store",
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    apiKeys?: unknown;
                    error?: string;
                };

                if (!response.ok || !payload.success) {
                    throw new Error(payload.error || "Could not load API keys.");
                }

                setApiKeys(sanitizeUserApiKeys(payload.apiKeys));
                return;
            }

            if (hasDevAuth) {
                setApiKeys(readDevApiKeysFromStorage());
                return;
            }

            setApiKeys({ ...EMPTY_USER_API_KEYS });
        } catch (err) {
            setApiKeysError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingApiKeys(false);
        }
    }

    async function handleOpenApiKeys() {
        setShowApiKeysModal(true);
        await loadApiKeys();
    }

    function handleOpenChangePassword() {
        setChangePasswordError(null);
        setChangePasswordMessage(null);
        setNewPassword("");
        setConfirmPassword("");
        setShowChangePasswordModal(true);
    }

    async function handleChangePassword() {
        setChangePasswordError(null);
        setChangePasswordMessage(null);

        if (!user) {
            setChangePasswordError("Password changes are available only for signed-in user accounts.");
            return;
        }

        const trimmedPassword = newPassword.trim();
        if (trimmedPassword.length < 8) {
            setChangePasswordError("New password must be at least 8 characters.");
            return;
        }

        if (trimmedPassword !== confirmPassword.trim()) {
            setChangePasswordError("New password and confirm password do not match.");
            return;
        }

        setChangingPassword(true);
        try {
            const { error } = await supabase.auth.updateUser({ password: trimmedPassword });
            if (error) throw error;

            setChangePasswordMessage("Password updated successfully.");
            setNewPassword("");
            setConfirmPassword("");
        } catch (err) {
            setChangePasswordError(err instanceof Error ? err.message : String(err));
        } finally {
            setChangingPassword(false);
        }
    }

    async function handleSaveApiKeys() {
        setSavingApiKeys(true);
        setApiKeysError(null);
        setApiKeysMessage(null);

        try {
            const sanitized = sanitizeUserApiKeys(apiKeys);
            setApiKeys(sanitized);

            if (user) {
                const response = await fetch("/api/user/api-keys", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiKeys: sanitized }),
                });
                const payload = (await response.json()) as {
                    success?: boolean;
                    apiKeys?: unknown;
                    error?: string;
                };

                if (!response.ok || !payload.success) {
                    throw new Error(payload.error || "Could not save API keys.");
                }

                setApiKeys(sanitizeUserApiKeys(payload.apiKeys));
                setApiKeysMessage("API keys saved successfully.");
                return;
            }

            if (hasDevAuth) {
                writeDevApiKeysToStorage(sanitized);
                setApiKeysMessage("API keys saved for this dev login.");
                return;
            }

            throw new Error("Please login to save API keys.");
        } catch (err) {
            setApiKeysError(err instanceof Error ? err.message : String(err));
        } finally {
            setSavingApiKeys(false);
        }
    }

    async function handleLogout() {
        setSigningOut(true);
        try {
            await supabase.auth.signOut();
            document.cookie = "qbg_dev_auth=; Path=/; Max-Age=0; SameSite=Lax";
            setHasDevAuth(false);
            window.location.href = "/";
        } finally {
            setSigningOut(false);
            setShowUserMenu(false);
            setShowApiKeysModal(false);
            setShowChangePasswordModal(false);
        }
    }

    const isAuthenticated = Boolean(user) || hasDevAuth;
    const userName = user
        ? typeof user.user_metadata?.full_name === "string" &&
          user.user_metadata.full_name.trim().length > 0
            ? user.user_metadata.full_name.trim()
            : user.email ?? "User"
        : hasDevAuth
            ? "Test Admin"
            : "User";
    const userEmail = user?.email ?? (hasDevAuth ? "test@admin.com" : "");

    return (
        <>
            <aside
            className="no-print"
            style={{
                width: "56px",
                minWidth: "56px",
                height: "100vh",
                position: "sticky",
                top: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--bg-secondary)",
                borderRight: "1px solid var(--border-primary)",
                zIndex: 50,
                overflow: "visible",
            }}
        >
            {/* Logo */}
            <div
                style={{
                    padding: "14px 0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderBottom: "1px solid var(--border-secondary)",
                    minHeight: "56px",
                }}
            >
                <div
                    style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "9px",
                        background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 0 16px rgba(99, 102, 241, 0.3)",
                    }}
                >
                    <Layers size={17} color="white" />
                </div>
            </div>

            {/* Main nav */}
            <nav
                style={{
                    flex: 1,
                    padding: "8px 0",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "2px",
                }}
            >
                {navItems.map((item) => (
                    <div
                        key={item.id}
                        style={{ position: "relative" }}
                        onMouseEnter={() => setHovered(item.id)}
                        onMouseLeave={() => setHovered(null)}
                    >
                        <button
                            onClick={() => !item.disabled && onTabChange(item.id)}
                            disabled={item.disabled}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "40px",
                                height: "40px",
                                borderRadius: "10px",
                                border: "none",
                                background:
                                    activeTab === item.id
                                        ? "var(--accent-glow)"
                                        : hovered === item.id && !item.disabled
                                            ? "var(--bg-hover)"
                                            : "transparent",
                                color:
                                    item.disabled
                                        ? "var(--text-muted)"
                                        : activeTab === item.id
                                            ? "var(--accent-primary-hover)"
                                            : hovered === item.id
                                                ? "var(--text-primary)"
                                                : "var(--text-tertiary)",
                                cursor: item.disabled ? "default" : "pointer",
                                transition: "all 0.15s ease",
                                position: "relative",
                                opacity: item.disabled ? 0.4 : 1,
                            }}
                        >
                            {item.icon}
                            {/* Active indicator */}
                            {activeTab === item.id && (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: "-8px",
                                        top: "50%",
                                        transform: "translateY(-50%)",
                                        width: "3px",
                                        height: "18px",
                                        borderRadius: "0 3px 3px 0",
                                        background: "var(--accent-primary)",
                                    }}
                                />
                            )}
                            {/* Badge dot */}
                            {item.badge && (
                                <div
                                    style={{
                                        position: "absolute",
                                        top: "4px",
                                        right: "4px",
                                        width: "6px",
                                        height: "6px",
                                        borderRadius: "50%",
                                        background: "var(--accent-secondary)",
                                    }}
                                />
                            )}
                        </button>

                        {/* Tooltip */}
                        {hovered === item.id && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: "52px",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    padding: "5px 10px",
                                    borderRadius: "6px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-accent)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.75rem",
                                    fontWeight: 500,
                                    whiteSpace: "nowrap",
                                    boxShadow: "var(--shadow-md)",
                                    zIndex: 100,
                                    pointerEvents: "none",
                                }}
                            >
                                {item.label}
                                {item.badge && (
                                    <span
                                        style={{
                                            marginLeft: "6px",
                                            fontSize: "0.6rem",
                                            padding: "1px 5px",
                                            borderRadius: "3px",
                                            background: "var(--accent-secondary)",
                                            color: "white",
                                            fontWeight: 600,
                                        }}
                                    >
                                        {item.badge}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </nav>

            {/* Bottom nav */}
            <div
                style={{
                    padding: "8px 0",
                    borderTop: "1px solid var(--border-secondary)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "2px",
                }}
            >
                {/* Permission-gated bottom nav items (e.g. Admin) — rendered above the
                    theme toggle so admin actions sit just above utility buttons. */}
                {bottomNavItems.map((item) => (
                    <div
                        key={item.id}
                        style={{ position: "relative" }}
                        onMouseEnter={() => setHovered(item.id)}
                        onMouseLeave={() => setHovered(null)}
                    >
                        <button
                            onClick={() => !item.disabled && onTabChange(item.id)}
                            disabled={item.disabled}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "40px",
                                height: "40px",
                                borderRadius: "10px",
                                border: "none",
                                background:
                                    activeTab === item.id
                                        ? "var(--accent-glow)"
                                        : hovered === item.id && !item.disabled
                                            ? "var(--bg-hover)"
                                            : "transparent",
                                color:
                                    item.disabled
                                        ? "var(--text-muted)"
                                        : activeTab === item.id
                                            ? "var(--accent-primary-hover)"
                                            : hovered === item.id
                                                ? "var(--text-primary)"
                                                : "var(--text-tertiary)",
                                cursor: item.disabled ? "default" : "pointer",
                                opacity: item.disabled ? 0.4 : 1,
                                transition: "all 0.15s ease",
                                position: "relative",
                            }}
                        >
                            {item.icon}
                            {activeTab === item.id && (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: "-8px",
                                        top: "50%",
                                        transform: "translateY(-50%)",
                                        width: "3px",
                                        height: "18px",
                                        borderRadius: "0 3px 3px 0",
                                        background: "var(--accent-primary)",
                                    }}
                                />
                            )}
                        </button>

                        {/* Tooltip */}
                        {hovered === item.id && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: "52px",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    padding: "5px 10px",
                                    borderRadius: "6px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-accent)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.75rem",
                                    fontWeight: 500,
                                    whiteSpace: "nowrap",
                                    boxShadow: "var(--shadow-md)",
                                    zIndex: 100,
                                    pointerEvents: "none",
                                }}
                            >
                                {item.label}
                            </div>
                        )}
                    </div>
                ))}

                {/* Theme toggle */}
                <div
                    style={{ position: "relative" }}
                    onMouseEnter={() => setHovered("theme")}
                    onMouseLeave={() => setHovered(null)}
                >
                    <button
                        onClick={toggleTheme}
                        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "40px",
                            height: "40px",
                            borderRadius: "10px",
                            border: "none",
                            background: hovered === "theme" ? "var(--bg-hover)" : "transparent",
                            color: hovered === "theme" ? "var(--text-primary)" : "var(--text-tertiary)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                        }}
                    >
                        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                    </button>
                    {hovered === "theme" && (
                        <div
                            style={{
                                position: "absolute",
                                left: "52px",
                                top: "50%",
                                transform: "translateY(-50%)",
                                padding: "5px 10px",
                                borderRadius: "6px",
                                background: "var(--bg-elevated)",
                                border: "1px solid var(--border-accent)",
                                color: "var(--text-primary)",
                                fontSize: "0.75rem",
                                fontWeight: 500,
                                whiteSpace: "nowrap",
                                boxShadow: "var(--shadow-md)",
                                zIndex: 100,
                                pointerEvents: "none",
                            }}
                        >
                            {theme === "dark" ? "Light mode" : "Dark mode"}
                        </div>
                    )}
                </div>

                {isAuthenticated && (
                    <div
                        style={{ position: "relative" }}
                        onMouseEnter={() => setHovered("account")}
                        onMouseLeave={() => setHovered(null)}
                    >
                        <button
                            type="button"
                            onClick={() => setShowUserMenu((prev) => !prev)}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "40px",
                                height: "40px",
                                borderRadius: "10px",
                                border: "none",
                                background:
                                    showUserMenu || hovered === "account"
                                        ? "var(--bg-hover)"
                                        : "transparent",
                                color: showUserMenu
                                    ? "var(--accent-primary-hover)"
                                    : "var(--text-tertiary)",
                                cursor: "pointer",
                                transition: "all 0.15s ease",
                            }}
                        >
                            <UserCircle2 size={18} />
                        </button>

                        {hovered === "account" && !showUserMenu && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: "52px",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    padding: "5px 10px",
                                    borderRadius: "6px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-accent)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.75rem",
                                    fontWeight: 500,
                                    whiteSpace: "nowrap",
                                    boxShadow: "var(--shadow-md)",
                                    zIndex: 100,
                                    pointerEvents: "none",
                                }}
                            >
                                Account
                            </div>
                        )}

                        {showUserMenu && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: "52px",
                                    bottom: "0",
                                    minWidth: "230px",
                                    borderRadius: "10px",
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-accent)",
                                    boxShadow: "var(--shadow-md)",
                                    zIndex: 120,
                                    padding: "10px",
                                    display: "grid",
                                    gap: "10px",
                                }}
                            >
                                <div
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        padding: "8px",
                                        background: "var(--bg-secondary)",
                                        display: "grid",
                                        gap: "3px",
                                    }}
                                >
                                    <div
                                        style={{
                                            fontSize: "0.78rem",
                                            fontWeight: 700,
                                            color: "var(--text-primary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {userName}
                                    </div>
                                    <div
                                        style={{
                                            fontSize: "0.72rem",
                                            color: "var(--text-tertiary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {userEmail}
                                    </div>
                                    <div
                                        style={{
                                            fontSize: "0.68rem",
                                            color: "var(--accent-primary, #818cf8)",
                                            marginTop: "2px",
                                            fontWeight: 600,
                                        }}
                                    >
                                        {roleLabel}
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowUserMenu(false);
                                        void handleOpenApiKeys();
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        padding: "8px 10px",
                                        fontSize: "0.78rem",
                                        fontWeight: 650,
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px",
                                    }}
                                >
                                    <KeyRound size={14} />
                                    Manage API Keys
                                </button>

                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowUserMenu(false);
                                        handleOpenChangePassword();
                                    }}
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "8px",
                                        background: "var(--bg-secondary)",
                                        color: "var(--text-secondary)",
                                        padding: "8px 10px",
                                        fontSize: "0.78rem",
                                        fontWeight: 650,
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px",
                                    }}
                                >
                                    <LockKeyhole size={14} />
                                    Change Password
                                </button>

                                <button
                                    type="button"
                                    onClick={handleLogout}
                                    disabled={signingOut}
                                    style={{
                                        border: "1px solid rgba(var(--accent-danger-rgb), 0.4)",
                                        borderRadius: "8px",
                                        background: "rgba(var(--accent-danger-rgb), 0.08)",
                                        color: "var(--accent-danger)",
                                        padding: "8px 10px",
                                        fontSize: "0.78rem",
                                        fontWeight: 650,
                                        cursor: signingOut ? "default" : "pointer",
                                        opacity: signingOut ? 0.7 : 1,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px",
                                    }}
                                >
                                    <LogOut size={14} />
                                    {signingOut ? "Logging out..." : "Logout"}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
            </aside>

            {showApiKeysModal && (
                <div
                    className="no-print"
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0, 0, 0, 0.52)",
                        zIndex: 160,
                        display: "grid",
                        placeItems: "center",
                        padding: "16px",
                    }}
                    onClick={() => setShowApiKeysModal(false)}
                >
                    <div
                        style={{
                            width: "min(620px, 96vw)",
                            borderRadius: "12px",
                            border: "1px solid var(--border-accent)",
                            background: "var(--bg-elevated)",
                            boxShadow: "var(--shadow-md)",
                            padding: "16px",
                            display: "grid",
                            gap: "12px",
                            maxHeight: "88vh",
                            overflowY: "auto",
                        }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                            }}
                        >
                            <div style={{ display: "grid", gap: "2px" }}>
                                <div
                                    style={{
                                        fontSize: "0.95rem",
                                        fontWeight: 700,
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    API Keys
                                </div>
                                <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                    Save provider keys for this user profile.
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => setShowApiKeysModal(false)}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    fontSize: "0.75rem",
                                    fontWeight: 650,
                                    padding: "6px 10px",
                                    cursor: "pointer",
                                }}
                            >
                                Close
                            </button>
                        </div>

                        {loadingApiKeys ? (
                            <div
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "10px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    padding: "12px",
                                    fontSize: "0.82rem",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "8px",
                                }}
                            >
                                <Loader2 size={14} className="animate-spin" />
                                Loading saved API keys...
                            </div>
                        ) : (
                            <>
                                <div
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "10px",
                                        background: "var(--bg-secondary)",
                                        padding: "12px",
                                        display: "grid",
                                        gap: "10px",
                                    }}
                                >
                                    {SUPPORTED_API_PROVIDERS.map((provider) => {
                                        const customConfig = provider === "custom_openai"
                                            ? parseCustomOpenAIProviderConfig(apiKeys.custom_openai)
                                            : null;
                                        const qbgConfig = provider === "qbg"
                                            ? parseQbgProviderConfig(apiKeys.qbg)
                                            : null;
                                        const driveConfig = provider === "google_drive"
                                            ? parseGoogleDriveProviderConfig(apiKeys.google_drive)
                                            : null;
                                        return (
                                            <label key={provider} style={{ display: "grid", gap: "5px" }}>
                                                <span
                                                    style={{
                                                        fontSize: "0.76rem",
                                                        fontWeight: 600,
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    {API_KEY_PROVIDER_LABELS[provider]}
                                                </span>
                                                {provider === "qbg" && qbgConfig ? (
                                                    <div style={{ display: "grid", gap: "6px" }}>
                                                        <input
                                                            type="password"
                                                            value={qbgConfig.token}
                                                            onChange={(event) => {
                                                                const token = event.target.value;
                                                                setApiKeys((prev) => ({
                                                                    ...prev,
                                                                    qbg: stringifyQbgProviderConfig({
                                                                        ...parseQbgProviderConfig(prev.qbg),
                                                                        token,
                                                                    }),
                                                                }));
                                                            }}
                                                            placeholder="Authorization token (Bearer …)"
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.8rem",
                                                                padding: "8px 10px",
                                                                outline: "none",
                                                            }}
                                                        />
                                                        <input
                                                            type="text"
                                                            value={qbgConfig.user}
                                                            onChange={(event) => {
                                                                const user = event.target.value;
                                                                setApiKeys((prev) => ({
                                                                    ...prev,
                                                                    qbg: stringifyQbgProviderConfig({
                                                                        ...parseQbgProviderConfig(prev.qbg),
                                                                        user,
                                                                    }),
                                                                }));
                                                            }}
                                                            placeholder="user (header) — e.g. Qbg sub admin"
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.8rem",
                                                                padding: "8px 10px",
                                                                outline: "none",
                                                            }}
                                                        />
                                                        <input
                                                            type="text"
                                                            value={qbgConfig.userId}
                                                            onChange={(event) => {
                                                                const userId = event.target.value;
                                                                setApiKeys((prev) => ({
                                                                    ...prev,
                                                                    qbg: stringifyQbgProviderConfig({
                                                                        ...parseQbgProviderConfig(prev.qbg),
                                                                        userId,
                                                                    }),
                                                                }));
                                                            }}
                                                            placeholder="user-id (header)"
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.8rem",
                                                                padding: "8px 10px",
                                                                outline: "none",
                                                            }}
                                                        />
                                                    </div>
                                                ) : provider === "google_drive" && driveConfig ? (
                                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                        {driveConfig.refreshToken ? (
                                                            <>
                                                                <span
                                                                    style={{
                                                                        fontSize: "0.78rem",
                                                                        color: "#22c55e",
                                                                        flex: 1,
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                        whiteSpace: "nowrap",
                                                                    }}
                                                                >
                                                                    Connected{driveConfig.email ? ` as ${driveConfig.email}` : ""}
                                                                </span>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setApiKeys((prev) => ({
                                                                            ...prev,
                                                                            google_drive: stringifyGoogleDriveProviderConfig({
                                                                                refreshToken: "",
                                                                                email: "",
                                                                                folderId: "",
                                                                            }),
                                                                        }));
                                                                    }}
                                                                    style={{
                                                                        border: "1px solid var(--border-primary)",
                                                                        borderRadius: "8px",
                                                                        background: "var(--bg-tertiary)",
                                                                        color: "var(--text-secondary)",
                                                                        fontSize: "0.74rem",
                                                                        fontWeight: 600,
                                                                        padding: "6px 10px",
                                                                        cursor: "pointer",
                                                                        flexShrink: 0,
                                                                    }}
                                                                >
                                                                    Disconnect
                                                                </button>
                                                            </>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    window.location.href = "/api/integrations/google-drive/connect";
                                                                }}
                                                                style={{
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: "8px",
                                                                    background: "var(--bg-tertiary)",
                                                                    color: "var(--text-primary)",
                                                                    fontSize: "0.78rem",
                                                                    fontWeight: 600,
                                                                    padding: "8px 12px",
                                                                    cursor: "pointer",
                                                                }}
                                                            >
                                                                Connect Google Drive
                                                            </button>
                                                        )}
                                                    </div>
                                                ) : provider === "custom_openai" && customConfig ? (
                                                    <div style={{ display: "grid", gap: "6px" }}>
                                                        <input
                                                            type="url"
                                                            value={customConfig.baseUrl}
                                                            onChange={(event) => {
                                                                const baseUrl = event.target.value;
                                                                setApiKeys((prev) => ({
                                                                    ...prev,
                                                                    custom_openai: stringifyCustomOpenAIProviderConfig({
                                                                        ...parseCustomOpenAIProviderConfig(prev.custom_openai),
                                                                        baseUrl,
                                                                    }),
                                                                }));
                                                            }}
                                                            placeholder="https://your-provider.example.com/v1"
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.8rem",
                                                                padding: "8px 10px",
                                                                outline: "none",
                                                            }}
                                                        />
                                                        <input
                                                            type="password"
                                                            value={customConfig.apiKey}
                                                            onChange={(event) => {
                                                                const apiKey = event.target.value;
                                                                setApiKeys((prev) => ({
                                                                    ...prev,
                                                                    custom_openai: stringifyCustomOpenAIProviderConfig({
                                                                        ...parseCustomOpenAIProviderConfig(prev.custom_openai),
                                                                        apiKey,
                                                                    }),
                                                                }));
                                                            }}
                                                            placeholder="Enter OpenAI-compatible API key"
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                border: "1px solid var(--border-primary)",
                                                                background: "var(--bg-tertiary)",
                                                                color: "var(--text-primary)",
                                                                fontSize: "0.8rem",
                                                                padding: "8px 10px",
                                                                outline: "none",
                                                            }}
                                                        />
                                                    </div>
                                                ) : (
                                                    <input
                                                        // local / g4f store an endpoint, not a secret: masking a
                                                        // URL only makes it impossible to check for a typo.
                                                        type={providerNeedsApiKey(provider) ? "password" : "text"}
                                                        value={apiKeys[provider]}
                                                        onChange={(event) => {
                                                            const nextValue = event.target.value;
                                                            setApiKeys((prev) => ({ ...prev, [provider]: nextValue }));
                                                        }}
                                                        placeholder={
                                                            providerNeedsApiKey(provider)
                                                                ? `Enter ${API_KEY_PROVIDER_LABELS[provider]} API key`
                                                                : provider === "g4f"
                                                                    ? "http://localhost:1337/v1  (leave blank for this default)"
                                                                    : "http://localhost:11434/v1"
                                                        }
                                                        style={{
                                                            width: "100%",
                                                            borderRadius: "8px",
                                                            border: "1px solid var(--border-primary)",
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            fontSize: "0.8rem",
                                                            padding: "8px 10px",
                                                            outline: "none",
                                                        }}
                                                    />
                                                )}
                                            </label>
                                        );
                                    })}
                                </div>

                                {apiKeysError && (
                                    <div
                                        style={{
                                            border: "1px solid rgba(var(--accent-danger-rgb), 0.35)",
                                            borderRadius: "10px",
                                            background: "rgba(var(--accent-danger-rgb), 0.1)",
                                            color: "var(--accent-danger)",
                                            fontSize: "0.78rem",
                                            padding: "10px 12px",
                                        }}
                                    >
                                        {apiKeysError}
                                    </div>
                                )}

                                {apiKeysMessage && (
                                    <div
                                        style={{
                                            border: "1px solid rgba(var(--accent-success-rgb), 0.35)",
                                            borderRadius: "10px",
                                            background: "rgba(var(--accent-success-rgb), 0.1)",
                                            color: "var(--accent-success)",
                                            fontSize: "0.78rem",
                                            padding: "10px 12px",
                                        }}
                                    >
                                        {apiKeysMessage}
                                    </div>
                                )}

                                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                                    <button
                                        type="button"
                                        onClick={() => setShowApiKeysModal(false)}
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-secondary)",
                                            color: "var(--text-secondary)",
                                            padding: "8px 12px",
                                            fontSize: "0.8rem",
                                            fontWeight: 600,
                                            cursor: "pointer",
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleSaveApiKeys()}
                                        disabled={savingApiKeys}
                                        style={{
                                            border: "1px solid var(--accent-primary)",
                                            borderRadius: "8px",
                                            background: "var(--accent-primary)",
                                            color: "#fff",
                                            padding: "8px 12px",
                                            fontSize: "0.8rem",
                                            fontWeight: 700,
                                            cursor: savingApiKeys ? "default" : "pointer",
                                            opacity: savingApiKeys ? 0.7 : 1,
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "6px",
                                        }}
                                    >
                                        {savingApiKeys && <Loader2 size={14} className="animate-spin" />}
                                        {savingApiKeys ? "Saving..." : "Save Keys"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {showChangePasswordModal && (
                <div
                    className="no-print"
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0, 0, 0, 0.52)",
                        zIndex: 160,
                        display: "grid",
                        placeItems: "center",
                        padding: "16px",
                    }}
                    onClick={() => setShowChangePasswordModal(false)}
                >
                    <div
                        style={{
                            width: "min(460px, 96vw)",
                            borderRadius: "12px",
                            border: "1px solid var(--border-accent)",
                            background: "var(--bg-elevated)",
                            boxShadow: "var(--shadow-md)",
                            padding: "16px",
                            display: "grid",
                            gap: "12px",
                        }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                            }}
                        >
                            <div style={{ display: "grid", gap: "2px" }}>
                                <div
                                    style={{
                                        fontSize: "0.95rem",
                                        fontWeight: 700,
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    Change Password
                                </div>
                                <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                    Update the password for your signed-in account.
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => setShowChangePasswordModal(false)}
                                style={{
                                    border: "1px solid var(--border-primary)",
                                    borderRadius: "8px",
                                    background: "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                    fontSize: "0.75rem",
                                    fontWeight: 650,
                                    padding: "6px 10px",
                                    cursor: "pointer",
                                }}
                            >
                                Close
                            </button>
                        </div>

                        {user ? (
                            <>
                                <div
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: "10px",
                                        background: "var(--bg-secondary)",
                                        padding: "12px",
                                        display: "grid",
                                        gap: "10px",
                                    }}
                                >
                                    <label style={{ display: "grid", gap: "5px" }}>
                                        <span
                                            style={{
                                                fontSize: "0.76rem",
                                                fontWeight: 600,
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            New Password
                                        </span>
                                        <input
                                            type="password"
                                            value={newPassword}
                                            onChange={(event) => setNewPassword(event.target.value)}
                                            placeholder="Enter a new password"
                                            style={{
                                                width: "100%",
                                                borderRadius: "8px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.8rem",
                                                padding: "8px 10px",
                                                outline: "none",
                                            }}
                                        />
                                    </label>

                                    <label style={{ display: "grid", gap: "5px" }}>
                                        <span
                                            style={{
                                                fontSize: "0.76rem",
                                                fontWeight: 600,
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            Confirm Password
                                        </span>
                                        <input
                                            type="password"
                                            value={confirmPassword}
                                            onChange={(event) => setConfirmPassword(event.target.value)}
                                            placeholder="Re-enter the new password"
                                            style={{
                                                width: "100%",
                                                borderRadius: "8px",
                                                border: "1px solid var(--border-primary)",
                                                background: "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                fontSize: "0.8rem",
                                                padding: "8px 10px",
                                                outline: "none",
                                            }}
                                        />
                                    </label>
                                </div>

                                {changePasswordError && (
                                    <div
                                        style={{
                                            border: "1px solid rgba(var(--accent-danger-rgb), 0.35)",
                                            borderRadius: "10px",
                                            background: "rgba(var(--accent-danger-rgb), 0.1)",
                                            color: "var(--accent-danger)",
                                            fontSize: "0.78rem",
                                            padding: "10px 12px",
                                        }}
                                    >
                                        {changePasswordError}
                                    </div>
                                )}

                                {changePasswordMessage && (
                                    <div
                                        style={{
                                            border: "1px solid rgba(var(--accent-success-rgb), 0.35)",
                                            borderRadius: "10px",
                                            background: "rgba(var(--accent-success-rgb), 0.1)",
                                            color: "var(--accent-success)",
                                            fontSize: "0.78rem",
                                            padding: "10px 12px",
                                        }}
                                    >
                                        {changePasswordMessage}
                                    </div>
                                )}

                                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                                    <button
                                        type="button"
                                        onClick={() => setShowChangePasswordModal(false)}
                                        style={{
                                            border: "1px solid var(--border-primary)",
                                            borderRadius: "8px",
                                            background: "var(--bg-secondary)",
                                            color: "var(--text-secondary)",
                                            padding: "8px 12px",
                                            fontSize: "0.8rem",
                                            fontWeight: 600,
                                            cursor: "pointer",
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleChangePassword()}
                                        disabled={changingPassword}
                                        style={{
                                            border: "1px solid var(--accent-primary)",
                                            borderRadius: "8px",
                                            background: "var(--accent-primary)",
                                            color: "#fff",
                                            padding: "8px 12px",
                                            fontSize: "0.8rem",
                                            fontWeight: 700,
                                            cursor: changingPassword ? "default" : "pointer",
                                            opacity: changingPassword ? 0.7 : 1,
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "6px",
                                        }}
                                    >
                                        {changingPassword && <Loader2 size={14} className="animate-spin" />}
                                        {changingPassword ? "Updating..." : "Update Password"}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div
                                style={{
                                    border: "1px solid rgba(var(--accent-warning-rgb), 0.35)",
                                    borderRadius: "10px",
                                    background: "rgba(var(--accent-warning-rgb), 0.1)",
                                    color: "var(--text-secondary)",
                                    fontSize: "0.78rem",
                                    padding: "12px",
                                    lineHeight: 1.6,
                                }}
                            >
                                Password changes are not available for the temporary dev login. Sign in with a real user account to manage your password here.
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
