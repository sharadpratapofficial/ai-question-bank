import { NextResponse } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { ROLE_LABELS } from "@/lib/auth/permissions";

/**
 * Returns the calling user's role + computed permission list.
 * UserProfileContext fetches this on mount so the UI can hide things the
 * user can't do. Permissions are also re-checked on every server action.
 */
export async function GET() {
    const ctx = await getCurrentUserWithRole();
    return NextResponse.json({
        success: true,
        isAuthenticated: ctx.isAuthenticated,
        isDevAuth: ctx.isDevAuth,
        userId: ctx.userId,
        email: ctx.email,
        role: ctx.role,
        roleLabel: ROLE_LABELS[ctx.role],
        // Role permissions plus any individually granted features.
        permissions: ctx.permissions,
    });
}
