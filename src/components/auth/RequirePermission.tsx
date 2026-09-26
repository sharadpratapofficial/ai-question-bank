"use client";

/**
 * Client-side route guard. Redirects to a fallback (default /questions) when
 * the current user doesn't have the required permission. Used at the top of
 * a page component to fully block access in addition to the server-side gate.
 *
 * While the profile is loading (the very first time only) we show nothing
 * (avoids a flash of forbidden content). Once we've resolved a role at least
 * once, we DON'T re-show that loading gate on subsequent background
 * refetches — UserProfileContext flips `loading` back to true on every
 * Supabase auth event, including the token refresh GoTrue fires whenever the
 * tab/window regains focus (switching back from another desktop or another
 * browser tab). Gating on the raw `loading` flag meant every one of those
 * background refreshes fully unmounted every child of this guard — the
 * entire protected page and all its component state (form inputs, in-progress
 * runs, everything) — then remounted it a moment later, which is
 * indistinguishable from a real page reload even though no network
 * navigation ever happened. This was the actual cause of "the app reloads
 * when I switch tabs/desktops" (2026-07-22); `role` itself is preserved
 * across these background refreshes (UserProfileContext only clears
 * `loading`, never `role`), so there's nothing to actually wait for.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/context/UserProfileContext";
import { hasAnyPermission, type Permission } from "@/lib/auth/permissions";

interface Props {
    permission: Permission | Permission[];
    redirectTo?: string;
    children: React.ReactNode;
}

export default function RequirePermission({
    permission,
    redirectTo = "/questions",
    children,
}: Props) {
    const router = useRouter();
    const { loading, role } = useCurrentUser();
    const hasLoadedOnceRef = useRef(false);
    const showLoadingGate = loading && !hasLoadedOnceRef.current;

    const perms = Array.isArray(permission) ? permission : [permission];
    const allowed = hasAnyPermission(role, perms);

    useEffect(() => {
        if (!loading) hasLoadedOnceRef.current = true;
        if (!loading && !allowed) {
            router.replace(redirectTo);
        }
    }, [loading, allowed, redirectTo, router]);

    if (showLoadingGate) {
        return (
            <div
                style={{
                    minHeight: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-muted)",
                    fontSize: "0.85rem",
                }}
            >
                Loading...
            </div>
        );
    }

    if (!allowed) {
        return (
            <div
                style={{
                    minHeight: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-muted)",
                    fontSize: "0.9rem",
                }}
            >
                You do not have access to this page. Redirecting...
            </div>
        );
    }

    return <>{children}</>;
}
