import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isValidRole } from "@/lib/auth/permissions";

const TABLE = "user_profiles";

// user_profiles RLS only lets an admin read or update other users' rows, so
// these queries must run as the caller (cookie session), not as a
// session-less anon client that RLS sees as nobody.
function getSupabase() {
    return createServerClient();
}

/**
 * Admin-only: list every user profile so an admin can promote/demote.
 */
export async function GET() {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    const supabase = await getSupabase();
    const { data, error } = await supabase
        .from(TABLE)
        .select("user_id, email, role, extra_permissions, display_name, created_at, updated_at")
        .order("created_at", { ascending: false });

    if (error) {
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        );
    }
    return NextResponse.json({ success: true, users: data ?? [] });
}

/**
 * Admin-only: create a new auth user + assign role.
 * Uses Supabase Auth's supported admin API (auth.admin.createUser) through the
 * server-only secret-key client, instead of writing auth.users / auth.identities
 * directly from SQL (the former admin_create_user_with_role function), which
 * breaks when Supabase changes its auth schema. checkPermission("manage_users")
 * above is the authorization; the auth.users trigger then creates the profile,
 * whose role is set here.
 */
export async function POST(req: NextRequest) {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    let body: { email?: string; password?: string; role?: string; display_name?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { success: false, error: "Invalid JSON payload." },
            { status: 400 }
        );
    }

    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    const role = body.role;
    const displayName = body.display_name?.trim() || null;

    if (!email) {
        return NextResponse.json(
            { success: false, error: "Email is required." },
            { status: 400 }
        );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json(
            { success: false, error: "Invalid email address." },
            { status: 400 }
        );
    }
    if (!password || password.length < 8) {
        return NextResponse.json(
            { success: false, error: "Password must be at least 8 characters." },
            { status: 400 }
        );
    }
    if (!isValidRole(role)) {
        return NextResponse.json(
            { success: false, error: "Invalid role." },
            { status: 400 }
        );
    }

    const admin = getSupabaseAdmin();
    const { data: created, error } = await admin.auth.admin.createUser({
        email: email.toLowerCase(),
        password,
        email_confirm: true,
        user_metadata: displayName ? { full_name: displayName } : {},
    });

    if (error || !created?.user) {
        const msg = error?.message || "Failed to create user.";
        const status = /already|registered|exists/i.test(msg) ? 409 : error?.status && error.status < 500 ? 400 : 500;
        return NextResponse.json({ success: false, error: msg }, { status });
    }
    const newUserId = created.user.id;

    // The auth.users trigger created the profile with the default role; apply the requested one.
    const { data: profile, error: profileError } = await admin
        .from(TABLE)
        .update({ role, display_name: displayName })
        .eq("user_id", newUserId)
        .select("user_id, email, role, extra_permissions, display_name, created_at, updated_at")
        .maybeSingle();

    if (profileError || !profile) {
        return NextResponse.json(
            { success: false, error: `User created, but assigning the role failed: ${profileError?.message ?? "profile row not found"}. Set it from the user list.`, user_id: newUserId },
            { status: 500 }
        );
    }

    return NextResponse.json({ success: true, user: profile, user_id: newUserId });
}
