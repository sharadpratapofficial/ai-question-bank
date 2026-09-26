"use client";

/**
 * Client-side identity + permissions for UI gating.
 *
 * Fetches /api/me on mount, exposes role + can(permission). UI components call
 * `useCurrentUser()` to hide buttons/nav the user shouldn't see. All real
 * enforcement still happens server-side; this is purely cosmetic.
 */

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { type Permission, type UserRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/client";

interface MeResponse {
    success: boolean;
    isAuthenticated: boolean;
    isDevAuth: boolean;
    userId: string | null;
    email: string | null;
    role: UserRole;
    roleLabel: string;
    permissions: Permission[];
}

interface ContextValue {
    loading: boolean;
    isAuthenticated: boolean;
    isDevAuth: boolean;
    userId: string | null;
    email: string | null;
    role: UserRole;
    roleLabel: string;
    permissions: Permission[];
    can: (permission: Permission) => boolean;
    refresh: () => Promise<void>;
}

const DEFAULT: ContextValue = {
    loading: true,
    isAuthenticated: false,
    isDevAuth: false,
    userId: null,
    email: null,
    role: "viewer",
    roleLabel: "Viewer",
    permissions: ["view_questions"],
    can: () => false,
    refresh: async () => {},
};

const UserProfileContext = createContext<ContextValue>(DEFAULT);

export function useCurrentUser(): ContextValue {
    return useContext(UserProfileContext);
}

export function UserProfileProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<Omit<ContextValue, "can" | "refresh">>({
        loading: true,
        isAuthenticated: false,
        isDevAuth: false,
        userId: null,
        email: null,
        role: "viewer",
        roleLabel: "Viewer",
        permissions: ["view_questions"],
    });

    const load = useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true }));
        try {
            const res = await fetch("/api/me", { cache: "no-store" });
            if (!res.ok) throw new Error(`/api/me returned status ${res.status}`);
            const data = (await res.json()) as MeResponse;
            setState({
                loading: false,
                isAuthenticated: data.isAuthenticated,
                isDevAuth: data.isDevAuth,
                userId: data.userId,
                email: data.email,
                role: data.role,
                roleLabel: data.roleLabel,
                permissions: data.permissions ?? [],
            });
        } catch (err) {
            // If the fetch fails, keep showing all nav items (loading stays false
            // so the sidebar falls back to the role we have, defaulting to viewer).
            // Log it so developers can spot it quickly.
            console.warn("[UserProfileContext] /api/me fetch failed:", err);
            setState((prev) => ({ ...prev, loading: false }));
        }
    }, []);

    // Initial fetch
    useEffect(() => {
        load();
    }, [load]);

    // Re-fetch role whenever Supabase auth state changes (login/logout/token refresh).
    // Without this, signing in on `/` and soft-navigating to `/questions` would keep
    // the stale pre-login state (role: viewer) because the layout/Provider stays mounted.
    const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
    useEffect(() => {
        if (!supabaseRef.current) {
            supabaseRef.current = createClient();
        }
        const supabase = supabaseRef.current;
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((event) => {
            // SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED — refetch in all cases.
            if (
                event === "SIGNED_IN" ||
                event === "SIGNED_OUT" ||
                event === "TOKEN_REFRESHED" ||
                event === "USER_UPDATED"
            ) {
                load();
            }
        });
        return () => {
            subscription.unsubscribe();
        };
    }, [load]);

    // Checked against the server's effective list (role + granted features),
    // not recomputed from the role — otherwise individually granted features
    // would be invisible to the UI.
    const can = useCallback(
        (permission: Permission) => state.permissions.includes(permission),
        [state.permissions]
    );

    const value = useMemo<ContextValue>(
        () => ({
            ...state,
            can,
            refresh: load,
        }),
        [state, can, load]
    );

    return (
        <UserProfileContext.Provider value={value}>
            {children}
        </UserProfileContext.Provider>
    );
}
