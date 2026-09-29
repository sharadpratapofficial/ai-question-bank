/**
 * Server-side identity + role resolution.
 *
 * Combines two paths the app supports:
 *   1) Real Supabase session (cookie-based)
 *   2) Dev-auth bypass (qbg_dev_auth=1 cookie) — synthesised as an admin so
 *      local development continues to work end-to-end. Never honoured in a
 *      production build (see src/lib/auth/devAuth.ts).
 *
 * Used by API routes and middleware to decide whether a request is allowed.
 */

import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import {
    effectivePermissions,
    type Permission,
    type UserRole,
    isValidRole,
} from "@/lib/auth/permissions";

export interface CurrentUserContext {
    userId: string | null;
    email: string | null;
    role: UserRole;
    /**
     * What this user can actually do: the role's permissions plus any features
     * an admin granted them individually (user_profiles.extra_permissions).
     * Always check against this, not against the role alone.
     */
    permissions: Permission[];
    isDevAuth: boolean;
    isAuthenticated: boolean;
}

/**
 * Resolve the current user's role for an incoming server request.
 * - Real session → reads public.user_profiles for the role
 * - Dev-auth cookie only → returns synthesised admin (no DB lookup)
 * - Neither → returns viewer + isAuthenticated=false
 */
export async function getCurrentUserWithRole(): Promise<CurrentUserContext> {
    const cookieStore = await cookies();
    const hasDevAuth = hasDevAuthCookie(cookieStore);

    let supabaseUser: { id: string; email?: string | null } | null = null;
    try {
        const supabase = await createClient();
        const { data } = await supabase.auth.getUser();
        supabaseUser = data?.user ?? null;
    } catch {
        supabaseUser = null;
    }

    if (supabaseUser) {
        try {
            const supabase = await createClient();
            const { data: profile } = await supabase
                .from("user_profiles")
                .select("role, email, extra_permissions")
                .eq("user_id", supabaseUser.id)
                .maybeSingle();

            const role: UserRole = isValidRole(profile?.role)
                ? (profile!.role as UserRole)
                : "viewer";

            return {
                userId: supabaseUser.id,
                email: profile?.email ?? supabaseUser.email ?? null,
                role,
                permissions: effectivePermissions(role, profile?.extra_permissions),
                isDevAuth: false,
                isAuthenticated: true,
            };
        } catch {
            // Fall through to viewer if the profile lookup fails.
            return {
                userId: supabaseUser.id,
                email: supabaseUser.email ?? null,
                role: "viewer",
                permissions: effectivePermissions("viewer"),
                isDevAuth: false,
                isAuthenticated: true,
            };
        }
    }

    if (hasDevAuth) {
        return {
            userId: null,
            email: null,
            role: "admin",
            permissions: effectivePermissions("admin"),
            isDevAuth: true,
            isAuthenticated: true,
        };
    }

    return {
        userId: null,
        email: null,
        role: "viewer",
        permissions: effectivePermissions("viewer"),
        isDevAuth: false,
        isAuthenticated: false,
    };
}

export class ForbiddenError extends Error {
    permission: Permission;
    constructor(permission: Permission) {
        super(`Missing permission: ${permission}`);
        this.permission = permission;
    }
}

/**
 * Throws ForbiddenError if the current user lacks the permission.
 * Wrap the throw in `forbiddenResponse(err)` from your route to return JSON 403.
 */
export async function requirePermission(
    permission: Permission
): Promise<CurrentUserContext> {
    const ctx = await getCurrentUserWithRole();
    if (!ctx.isAuthenticated) {
        throw new ForbiddenError(permission);
    }
    if (!ctx.permissions.includes(permission)) {
        throw new ForbiddenError(permission);
    }
    return ctx;
}

/**
 * Throws ForbiddenError unless the user has at least one of the given permissions.
 * Useful for routes that can be reached from two different UI contexts (e.g.
 * /api/ai-tools/translate accepts use_ai_tools OR use_per_question_ai).
 */
export async function requireAnyPermission(
    permissions: Permission[]
): Promise<CurrentUserContext> {
    const ctx = await getCurrentUserWithRole();
    if (!ctx.isAuthenticated || !permissions.some((p) => ctx.permissions.includes(p))) {
        throw new ForbiddenError(permissions[0]);
    }
    return ctx;
}

/**
 * One-line helper for route handlers:
 *
 *     const forbid = await checkPermission("create_batch");
 *     if (forbid) return forbid;
 *
 * Returns a 403 NextResponse if denied, null if allowed.
 */
export async function checkPermission(
    permission: Permission
): Promise<NextResponse | null> {
    try {
        await requirePermission(permission);
        return null;
    } catch (err) {
        return forbiddenResponse(err);
    }
}

export async function checkAnyPermission(
    permissions: Permission[]
): Promise<NextResponse | null> {
    try {
        await requireAnyPermission(permissions);
        return null;
    } catch (err) {
        return forbiddenResponse(err);
    }
}

/**
 * Returns a NextResponse 403 (or 401 if not authenticated at all) for the given
 * caught error. Returns null if the error is not a ForbiddenError, so callers
 * can rethrow.
 */
export function forbiddenResponse(err: unknown): NextResponse | null {
    if (err instanceof ForbiddenError) {
        return NextResponse.json(
            {
                success: false,
                error: `Forbidden: missing permission "${err.permission}".`,
                code: "FORBIDDEN",
                permission: err.permission,
            },
            { status: 403 }
        );
    }
    return null;
}
