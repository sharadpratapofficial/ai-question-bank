"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ShieldCheck, RefreshCw, AlertCircle, CheckCircle2, UserPlus, X, Loader2, SlidersHorizontal, Layers } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import {
    ALL_ROLES,
    FEATURE_CATALOGUE,
    FEATURE_GROUPS,
    ROLE_DESCRIPTIONS,
    ROLE_LABELS,
    ROLE_PERMISSIONS,
    type Permission,
    type UserRole,
} from "@/lib/auth/permissions";
import { useCurrentUser } from "@/context/UserProfileContext";

interface UserRow {
    user_id: string;
    email: string | null;
    role: UserRole;
    /** Features granted on top of the role. */
    extra_permissions: Permission[] | null;
    display_name: string | null;
    created_at: string;
    updated_at: string;
}

/** Everything a user can do: what the role gives, plus the individual grants. */
function effectiveFor(u: UserRow): Permission[] {
    const base = ROLE_PERMISSIONS[u.role] ?? [];
    const extra = u.extra_permissions ?? [];
    return [...base, ...extra.filter((p) => !base.includes(p))];
}

export default function AdminUsersPage() {
    return (
        <RequirePermission permission="manage_users">
            <AdminUsersInner />
        </RequirePermission>
    );
}

function AdminUsersInner() {
    const router = useRouter();
    const { email: currentEmail, role: currentRole, refresh } = useCurrentUser();

    const [users, setUsers] = useState<UserRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [savingId, setSavingId] = useState<string | null>(null);
    /** The user whose feature checkboxes are open, and the pending tick state. */
    const [accessFor, setAccessFor] = useState<UserRow | null>(null);
    const [draftPerms, setDraftPerms] = useState<Permission[]>([]);
    const [savingAccess, setSavingAccess] = useState(false);
    const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    // "Create user" modal state
    const [showCreate, setShowCreate] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newEmail, setNewEmail] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newDisplayName, setNewDisplayName] = useState("");
    const [newRole, setNewRole] = useState<UserRole>("viewer");
    const [createError, setCreateError] = useState<string | null>(null);

    const loadUsers = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/admin/users", { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `status ${res.status}`);
            }
            setUsers(data.users as UserRow[]);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadUsers();
    }, [loadUsers]);

    const openAccess = useCallback((u: UserRow) => {
        setAccessFor(u);
        setDraftPerms(effectiveFor(u));
    }, []);

    const toggleDraft = useCallback((permission: Permission, on: boolean) => {
        setDraftPerms((prev) =>
            on ? (prev.includes(permission) ? prev : [...prev, permission]) : prev.filter((p) => p !== permission)
        );
    }, []);

    const saveAccess = useCallback(async () => {
        if (!accessFor) return;
        setSavingAccess(true);
        setFlash(null);
        try {
            const res = await fetch(`/api/admin/users/${accessFor.user_id}/permissions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permissions: draftPerms }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `status ${res.status}`);
            }
            const updated = data.user as UserRow;
            setUsers((prev) => prev.map((u) => (u.user_id === updated.user_id ? { ...u, ...updated } : u)));
            setFlash({
                kind: "ok",
                text: `Access updated for ${updated.email || "user"}.`,
            });
            setAccessFor(null);
            await refresh();
        } catch (err) {
            setFlash({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setSavingAccess(false);
        }
    }, [accessFor, draftPerms, refresh]);

    const changeRole = useCallback(
        async (userId: string, newRole: UserRole) => {
            setSavingId(userId);
            setFlash(null);
            try {
                const res = await fetch(`/api/admin/users/${userId}/role`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ role: newRole }),
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || `status ${res.status}`);
                }
                setUsers((prev) =>
                    prev.map((u) =>
                        u.user_id === userId
                            ? { ...u, role: newRole, updated_at: new Date().toISOString() }
                            : u
                    )
                );
                setFlash({ kind: "ok", text: "Role updated." });
                // If the admin changed their own role, the sidebar role label
                // would be stale — refresh the profile context.
                await refresh();
            } catch (err) {
                setFlash({
                    kind: "err",
                    text: err instanceof Error ? err.message : String(err),
                });
            } finally {
                setSavingId(null);
            }
        },
        [refresh]
    );

    const resetCreateForm = useCallback(() => {
        setNewEmail("");
        setNewPassword("");
        setNewDisplayName("");
        setNewRole("viewer");
        setCreateError(null);
    }, []);

    const createUser = useCallback(async () => {
        setCreateError(null);
        const email = newEmail.trim();
        const password = newPassword;
        const display = newDisplayName.trim();

        if (!email) return setCreateError("Email is required.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return setCreateError("Enter a valid email address.");
        if (password.length < 8)
            return setCreateError("Password must be at least 8 characters.");

        setCreating(true);
        try {
            const res = await fetch("/api/admin/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    password,
                    role: newRole,
                    display_name: display || undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `status ${res.status}`);
            }

            // Optimistically prepend the new profile, then refresh to make sure.
            if (data.user) {
                setUsers((prev) => [data.user as UserRow, ...prev]);
            }
            setFlash({ kind: "ok", text: `Created ${email} as ${ROLE_LABELS[newRole]}.` });
            resetCreateForm();
            setShowCreate(false);
            // Re-load in the background so server is the source of truth.
            void loadUsers();
        } catch (err) {
            setCreateError(err instanceof Error ? err.message : String(err));
        } finally {
            setCreating(false);
        }
    }, [newEmail, newPassword, newDisplayName, newRole, loadUsers, resetCreateForm]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return users;
        return users.filter(
            (u) =>
                (u.email || "").toLowerCase().includes(q) ||
                (u.display_name || "").toLowerCase().includes(q) ||
                u.role.includes(q)
        );
    }, [users, search]);

    return (
        <>
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar
                activeTab="admin"
                onTabChange={(tab) => {
                    if (tab === "questions") router.push("/questions");
                    else if (tab === "tests") router.push("/tests");
                    else if (tab === "analytics") router.push("/analytics");
                    else if (tab === "upload") router.push("/upload");
                    else if (tab === "ai") router.push("/ai-tools");
                    else if (tab === "agentic-qc") router.push("/agentic-qc");
                    else if (tab === "qbg") router.push("/qbg");
                    else if (tab === "video-solution") router.push("/video-solution");
                    else if (tab === "question-wise-videos") router.push("/question-wise-videos");
                    else if (tab === "circuit-designer") router.push("/circuit-designer");
                }}
            />

            <main style={{ flex: 1, overflowY: "auto", background: "var(--bg-primary)" }}>
                <div style={{ maxWidth: "1080px", margin: "0 auto", padding: "28px 28px 64px" }}>
                    <header
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "12px",
                            marginBottom: "20px",
                        }}
                    >
                        <ShieldCheck size={22} color="var(--accent-primary, #818cf8)" />
                        <div>
                            <h1
                                style={{
                                    fontSize: "1.4rem",
                                    fontWeight: 700,
                                    color: "var(--text-primary)",
                                    margin: 0,
                                }}
                            >
                                User access control
                            </h1>
                            <p
                                style={{
                                    fontSize: "0.82rem",
                                    color: "var(--text-secondary)",
                                    margin: "4px 0 0",
                                }}
                            >
                                Assign roles to control what each user can do in the app.
                                You are signed in as{" "}
                                <strong style={{ color: "var(--accent-primary, #818cf8)" }}>
                                    {currentEmail || "an admin"}
                                </strong>{" "}
                                ({ROLE_LABELS[currentRole]}).
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => router.push("/admin/chapters")}
                            style={{
                                marginLeft: "auto",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-primary)",
                                borderRadius: 9,
                                padding: "8px 13px",
                                fontSize: "0.82rem",
                                fontWeight: 600,
                                cursor: "pointer",
                            }}
                            title="Find and merge chapters that are the same thing spelled differently"
                        >
                            <Layers size={14} /> Chapters
                        </button>
                    </header>

                    <section
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "12px",
                            background: "var(--bg-secondary)",
                            padding: "16px",
                            marginBottom: "20px",
                        }}
                    >
                        <h2
                            style={{
                                fontSize: "0.84rem",
                                fontWeight: 700,
                                color: "var(--text-primary)",
                                margin: "0 0 10px",
                            }}
                        >
                            Available roles
                        </h2>
                        <div
                            style={{
                                display: "grid",
                                gap: "8px",
                                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            }}
                        >
                            {ALL_ROLES.map((r) => (
                                <div
                                    key={r}
                                    style={{
                                        padding: "10px 12px",
                                        borderRadius: "8px",
                                        background: "var(--bg-tertiary)",
                                        border: "1px solid var(--border-primary)",
                                    }}
                                >
                                    <div
                                        style={{
                                            fontWeight: 700,
                                            color: "var(--text-primary)",
                                            fontSize: "0.84rem",
                                        }}
                                    >
                                        {ROLE_LABELS[r]}
                                    </div>
                                    <div
                                        style={{
                                            color: "var(--text-secondary)",
                                            fontSize: "0.72rem",
                                            marginTop: "4px",
                                            lineHeight: 1.4,
                                        }}
                                    >
                                        {ROLE_DESCRIPTIONS[r]}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "12px",
                            marginBottom: "12px",
                        }}
                    >
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "9px",
                                background: "var(--bg-secondary)",
                                padding: "8px 12px",
                            }}
                        >
                            <Search size={14} color="var(--text-muted)" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by email, name, or role"
                                style={{
                                    flex: 1,
                                    background: "transparent",
                                    border: "none",
                                    outline: "none",
                                    color: "var(--text-primary)",
                                    fontSize: "0.84rem",
                                }}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={loadUsers}
                            disabled={loading}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "9px",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                padding: "8px 12px",
                                fontSize: "0.78rem",
                                fontWeight: 600,
                                cursor: loading ? "default" : "pointer",
                                opacity: loading ? 0.6 : 1,
                            }}
                        >
                            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
                            Refresh
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                resetCreateForm();
                                setShowCreate(true);
                            }}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                border: "1px solid var(--accent-primary, #818cf8)",
                                borderRadius: "9px",
                                background: "var(--accent-primary, #818cf8)",
                                color: "#fff",
                                padding: "8px 12px",
                                fontSize: "0.78rem",
                                fontWeight: 700,
                                cursor: "pointer",
                            }}
                        >
                            <UserPlus size={14} />
                            New User
                        </button>
                    </div>

                    {flash && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "10px 12px",
                                borderRadius: "9px",
                                border: `1px solid ${flash.kind === "ok" ? "#22c55e55" : "#ef444455"}`,
                                background:
                                    flash.kind === "ok" ? "#22c55e10" : "#ef444410",
                                color: flash.kind === "ok" ? "#22c55e" : "#ef4444",
                                fontSize: "0.8rem",
                                marginBottom: "12px",
                            }}
                        >
                            {flash.kind === "ok" ? (
                                <CheckCircle2 size={14} />
                            ) : (
                                <AlertCircle size={14} />
                            )}
                            <span>{flash.text}</span>
                        </div>
                    )}

                    {error && (
                        <div
                            style={{
                                padding: "12px",
                                borderRadius: "9px",
                                border: "1px solid #ef444455",
                                background: "#ef444410",
                                color: "#ef4444",
                                fontSize: "0.8rem",
                                marginBottom: "12px",
                            }}
                        >
                            {error}
                        </div>
                    )}

                    <div
                        style={{
                            border: "1px solid var(--border-primary)",
                            borderRadius: "12px",
                            overflow: "hidden",
                            background: "var(--bg-secondary)",
                        }}
                    >
                        <table
                            style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: "0.82rem",
                            }}
                        >
                            <thead
                                style={{
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-secondary)",
                                }}
                            >
                                <tr>
                                    <th style={th()}>Email</th>
                                    <th style={th()}>Role</th>
                                    <th style={th()}>Feature access</th>
                                    <th style={th()}>Joined</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading && (
                                    <tr>
                                        <td colSpan={4} style={td({ textAlign: "center", color: "var(--text-muted)" })}>
                                            Loading…
                                        </td>
                                    </tr>
                                )}
                                {!loading && filtered.length === 0 && (
                                    <tr>
                                        <td colSpan={4} style={td({ textAlign: "center", color: "var(--text-muted)" })}>
                                            No users match this search.
                                        </td>
                                    </tr>
                                )}
                                {!loading &&
                                    filtered.map((u) => (
                                        <tr key={u.user_id} style={{ borderTop: "1px solid var(--border-primary)" }}>
                                            <td style={td()}>
                                                <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                                                    {u.email || "(no email)"}
                                                </div>
                                                {u.display_name && (
                                                    <div
                                                        style={{
                                                            color: "var(--text-muted)",
                                                            fontSize: "0.72rem",
                                                            marginTop: "2px",
                                                        }}
                                                    >
                                                        {u.display_name}
                                                    </div>
                                                )}
                                            </td>
                                            <td style={td()}>
                                                <select
                                                    value={u.role}
                                                    disabled={savingId === u.user_id}
                                                    onChange={(e) =>
                                                        changeRole(u.user_id, e.target.value as UserRole)
                                                    }
                                                    style={{
                                                        background: "var(--bg-tertiary)",
                                                        color: "var(--text-primary)",
                                                        border: "1px solid var(--border-primary)",
                                                        borderRadius: "8px",
                                                        padding: "6px 10px",
                                                        fontSize: "0.8rem",
                                                        cursor:
                                                            savingId === u.user_id ? "default" : "pointer",
                                                    }}
                                                >
                                                    {ALL_ROLES.map((r) => (
                                                        <option key={r} value={r}>
                                                            {ROLE_LABELS[r]}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td style={td()}>
                                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => openAccess(u)}
                                                        style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: 6,
                                                            background: "var(--bg-tertiary)",
                                                            color: "var(--text-primary)",
                                                            border: "1px solid var(--border-primary)",
                                                            borderRadius: 8,
                                                            padding: "6px 10px",
                                                            fontSize: "0.76rem",
                                                            fontWeight: 600,
                                                            cursor: "pointer",
                                                        }}
                                                    >
                                                        <SlidersHorizontal size={13} />
                                                        Choose features
                                                    </button>
                                                    <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>
                                                        {(() => {
                                                            const eff = effectiveFor(u);
                                                            const names = FEATURE_CATALOGUE.filter(
                                                                (f) => f.group === "Tools" && eff.includes(f.permission)
                                                            ).map((f) => f.label);
                                                            if (!names.length) return "no tools";
                                                            if (names.length <= 2) return names.join(", ");
                                                            return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
                                                        })()}
                                                        {(u.extra_permissions?.length ?? 0) > 0
                                                            ? ` · ${u.extra_permissions!.length} extra`
                                                            : ""}
                                                    </span>
                                                </div>
                                            </td>
                                            <td style={td({ color: "var(--text-muted)", fontSize: "0.74rem" })}>
                                                {new Date(u.created_at).toLocaleDateString()}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </div>

        {accessFor && (
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.55)",
                    zIndex: 170,
                    display: "grid",
                    placeItems: "center",
                    padding: "16px",
                }}
                onClick={() => !savingAccess && setAccessFor(null)}
            >
                <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        width: "100%",
                        maxWidth: 780,
                        maxHeight: "88vh",
                        overflowY: "auto",
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: 14,
                        padding: 20,
                    }}
                >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                        <div>
                            <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 800, color: "var(--text-primary)" }}>
                                Feature access
                            </h2>
                            <p style={{ margin: "4px 0 0", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                                {accessFor.email || "(no email)"} — role{" "}
                                <strong style={{ color: "var(--text-primary)" }}>{ROLE_LABELS[accessFor.role]}</strong>
                            </p>
                        </div>
                        <div style={{ flex: 1 }} />
                        <button
                            type="button"
                            onClick={() => !savingAccess && setAccessFor(null)}
                            style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                padding: 4,
                            }}
                            aria-label="Close"
                        >
                            <X size={18} />
                        </button>
                    </div>

                    <div
                        style={{
                            fontSize: "0.78rem",
                            color: "var(--text-muted)",
                            background: "var(--bg-tertiary)",
                            border: "1px solid var(--border-primary)",
                            borderRadius: 10,
                            padding: "10px 12px",
                            marginBottom: 14,
                            lineHeight: 1.5,
                        }}
                    >
                        Tick every feature this person should have. Items marked{" "}
                        <strong style={{ color: "var(--text-primary)" }}>from role</strong> already come with{" "}
                        {ROLE_LABELS[accessFor.role]} and stay on — to take those away, change the role (the{" "}
                        <strong style={{ color: "var(--text-primary)" }}>{ROLE_LABELS.custom}</strong> role starts from
                        nothing).
                    </div>

                    {FEATURE_GROUPS.map((group) => {
                        const items = FEATURE_CATALOGUE.filter((f) => f.group === group);
                        if (!items.length) return null;
                        return (
                            <div key={group} style={{ marginBottom: 16 }}>
                                <div
                                    style={{
                                        fontSize: "0.7rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.04em",
                                        color: "var(--text-muted)",
                                        marginBottom: 8,
                                    }}
                                >
                                    {group}
                                </div>
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
                                        gap: 8,
                                    }}
                                >
                                    {items.map((f) => {
                                        const fromRole = (ROLE_PERMISSIONS[accessFor.role] ?? []).includes(f.permission);
                                        const checked = draftPerms.includes(f.permission);
                                        return (
                                            <label
                                                key={f.permission}
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: "18px 1fr",
                                                    gap: 9,
                                                    alignItems: "start",
                                                    padding: "9px 11px",
                                                    borderRadius: 10,
                                                    border: `1px solid ${checked ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    background: checked ? "var(--accent-primary-soft, rgba(99,102,241,0.08))" : "var(--bg-tertiary)",
                                                    cursor: fromRole ? "not-allowed" : "pointer",
                                                    opacity: fromRole ? 0.75 : 1,
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    disabled={fromRole || savingAccess}
                                                    onChange={(e) => toggleDraft(f.permission, e.target.checked)}
                                                    style={{ marginTop: 2 }}
                                                />
                                                <div>
                                                    <div
                                                        style={{
                                                            fontSize: "0.83rem",
                                                            fontWeight: 600,
                                                            color: "var(--text-primary)",
                                                            display: "flex",
                                                            gap: 7,
                                                            alignItems: "center",
                                                            flexWrap: "wrap",
                                                        }}
                                                    >
                                                        {f.label}
                                                        {fromRole && (
                                                            <span
                                                                style={{
                                                                    fontSize: "0.64rem",
                                                                    fontWeight: 700,
                                                                    textTransform: "uppercase",
                                                                    letterSpacing: "0.04em",
                                                                    color: "var(--text-muted)",
                                                                    border: "1px solid var(--border-primary)",
                                                                    borderRadius: 5,
                                                                    padding: "1px 5px",
                                                                }}
                                                            >
                                                                from role
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div style={{ fontSize: "0.73rem", color: "var(--text-muted)", marginTop: 2 }}>
                                                        {f.description}
                                                    </div>
                                                </div>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 6 }}>
                        <button
                            type="button"
                            onClick={() => setAccessFor(null)}
                            disabled={savingAccess}
                            style={{
                                background: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-primary)",
                                borderRadius: 9,
                                padding: "9px 15px",
                                fontSize: "0.83rem",
                                fontWeight: 600,
                                cursor: savingAccess ? "default" : "pointer",
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={saveAccess}
                            disabled={savingAccess}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 7,
                                background: "var(--accent-primary)",
                                color: "#fff",
                                border: "none",
                                borderRadius: 9,
                                padding: "9px 17px",
                                fontSize: "0.83rem",
                                fontWeight: 700,
                                cursor: savingAccess ? "default" : "pointer",
                            }}
                        >
                            {savingAccess && <Loader2 size={14} className="spin" />}
                            {savingAccess ? "Saving…" : "Save access"}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {showCreate && (
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.55)",
                    zIndex: 160,
                    display: "grid",
                    placeItems: "center",
                    padding: "16px",
                }}
                onClick={() => !creating && setShowCreate(false)}
            >
                <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        width: "min(460px, 96vw)",
                        borderRadius: "12px",
                        border: "1px solid var(--border-accent)",
                        background: "var(--bg-elevated)",
                        boxShadow: "var(--shadow-md)",
                        padding: "18px",
                        display: "grid",
                        gap: "12px",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                        <div style={{ display: "grid", gap: "2px" }}>
                            <div style={{ fontSize: "0.98rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                Create new user
                            </div>
                            <div style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                Adds the user to Supabase auth and sets their role.
                            </div>
                        </div>
                        <button
                            type="button"
                            disabled={creating}
                            onClick={() => setShowCreate(false)}
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "8px",
                                background: "var(--bg-secondary)",
                                color: "var(--text-secondary)",
                                padding: "6px",
                                cursor: creating ? "default" : "pointer",
                                opacity: creating ? 0.5 : 1,
                            }}
                        >
                            <X size={14} />
                        </button>
                    </div>

                    <label style={{ display: "grid", gap: "5px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            Email
                        </span>
                        <input
                            type="email"
                            value={newEmail}
                            onChange={(e) => setNewEmail(e.target.value)}
                            placeholder="user@example.com"
                            disabled={creating}
                            autoFocus
                            style={inputStyle()}
                        />
                    </label>

                    <label style={{ display: "grid", gap: "5px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            Password (min 8 chars)
                        </span>
                        <input
                            type="text"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="Set initial password"
                            disabled={creating}
                            style={inputStyle()}
                        />
                    </label>

                    <label style={{ display: "grid", gap: "5px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            Display name <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
                        </span>
                        <input
                            type="text"
                            value={newDisplayName}
                            onChange={(e) => setNewDisplayName(e.target.value)}
                            placeholder="Full name"
                            disabled={creating}
                            style={inputStyle()}
                        />
                    </label>

                    <label style={{ display: "grid", gap: "5px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            Role
                        </span>
                        <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value as UserRole)}
                            disabled={creating}
                            style={{ ...inputStyle(), cursor: creating ? "default" : "pointer" }}
                        >
                            {ALL_ROLES.map((r) => (
                                <option key={r} value={r}>
                                    {ROLE_LABELS[r]} — {ROLE_DESCRIPTIONS[r]}
                                </option>
                            ))}
                        </select>
                    </label>

                    {createError && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "9px 12px",
                                borderRadius: "9px",
                                border: "1px solid #ef444455",
                                background: "#ef444410",
                                color: "#ef4444",
                                fontSize: "0.78rem",
                            }}
                        >
                            <AlertCircle size={14} />
                            <span>{createError}</span>
                        </div>
                    )}

                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
                        <button
                            type="button"
                            onClick={() => setShowCreate(false)}
                            disabled={creating}
                            style={{
                                border: "1px solid var(--border-primary)",
                                borderRadius: "8px",
                                background: "var(--bg-secondary)",
                                color: "var(--text-secondary)",
                                padding: "8px 14px",
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                cursor: creating ? "default" : "pointer",
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void createUser()}
                            disabled={creating}
                            style={{
                                border: "1px solid var(--accent-primary, #818cf8)",
                                borderRadius: "8px",
                                background: "var(--accent-primary, #818cf8)",
                                color: "#fff",
                                padding: "8px 14px",
                                fontSize: "0.8rem",
                                fontWeight: 700,
                                cursor: creating ? "default" : "pointer",
                                opacity: creating ? 0.75 : 1,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                            }}
                        >
                            {creating && <Loader2 size={14} className="animate-spin" />}
                            {creating ? "Creating..." : "Create user"}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}

function inputStyle(): React.CSSProperties {
    return {
        width: "100%",
        borderRadius: "8px",
        border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        color: "var(--text-primary)",
        fontSize: "0.84rem",
        padding: "9px 11px",
        outline: "none",
    };
}

function th(extra: React.CSSProperties = {}): React.CSSProperties {
    return {
        textAlign: "left",
        padding: "10px 14px",
        fontWeight: 600,
        fontSize: "0.74rem",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        ...extra,
    };
}

function td(extra: React.CSSProperties = {}): React.CSSProperties {
    return {
        padding: "12px 14px",
        verticalAlign: "top",
        ...extra,
    };
}
