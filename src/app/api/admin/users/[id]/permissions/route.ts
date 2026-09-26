import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "@/lib/auth/serverAuth";
import { ROLE_PERMISSIONS, isValidRole, sanitizePermissions } from "@/lib/auth/permissions";

const TABLE = "user_profiles";

function getSupabase() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

/**
 * Set the extra features granted to one user, on top of whatever their role
 * already allows. Admin-only.
 *
 * Extras are additive: they widen access and never remove what the role implies,
 * so this route can't lock anyone out of anything. Permissions the role already
 * grants are dropped from the stored list rather than duplicated — otherwise a
 * later role change would leave stale grants behind that nobody ticked.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id) {
        return NextResponse.json({ success: false, error: "User id is required." }, { status: 400 });
    }

    let body: { permissions?: unknown };
    try {
        body = (await req.json()) as { permissions?: unknown };
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON payload." }, { status: 400 });
    }

    if (!Array.isArray(body?.permissions)) {
        return NextResponse.json(
            { success: false, error: "`permissions` must be an array." },
            { status: 400 }
        );
    }

    const requested = sanitizePermissions(body.permissions);
    if (requested.length !== body.permissions.length) {
        return NextResponse.json(
            { success: false, error: "One or more permissions are not recognised." },
            { status: 400 }
        );
    }

    const supabase = getSupabase();

    const { data: current, error: readError } = await supabase
        .from(TABLE)
        .select("user_id, role")
        .eq("user_id", id)
        .maybeSingle();

    if (readError) {
        return NextResponse.json(
            { success: false, error: `Failed to load profile: ${readError.message}` },
            { status: 500 }
        );
    }
    if (!current) {
        return NextResponse.json({ success: false, error: "User profile not found." }, { status: 404 });
    }

    const roleGrants = isValidRole(current.role) ? ROLE_PERMISSIONS[current.role] ?? [] : [];
    const extras = requested.filter((p) => !roleGrants.includes(p));

    const { data: updated, error: updateError } = await supabase
        .from(TABLE)
        .update({ extra_permissions: extras })
        .eq("user_id", id)
        .select("user_id, email, role, extra_permissions, display_name, created_at, updated_at")
        .maybeSingle();

    if (updateError) {
        return NextResponse.json(
            { success: false, error: `Update failed: ${updateError.message}` },
            { status: 500 }
        );
    }

    return NextResponse.json({ success: true, user: updated });
}
