import { NextRequest, NextResponse } from "next/server";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { isValidRole } from "@/lib/auth/permissions";

const TABLE = "user_profiles";

function getSupabase() {
    return createAnonClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

/**
 * Admin-only: list every user profile so an admin can promote/demote.
 */
export async function GET() {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    const supabase = getSupabase();
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
 * Delegates to the SECURITY DEFINER Postgres function admin_create_user_with_role,
 * which writes into auth.users / auth.identities and re-checks the admin role
 * server-side. We must call it through the *user-session* client (not the bare
 * anon client) so auth.uid() inside the function returns the calling admin's id.
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

    // Must use the cookie-aware client so auth.uid() is set inside the RPC.
    const supabase = await createServerClient();
    const { data: newUserId, error } = await supabase.rpc(
        "admin_create_user_with_role",
        {
            p_email: email,
            p_password: password,
            p_role: role,
            p_display_name: displayName,
        }
    );

    if (error) {
        // 23505 = duplicate email, 42501 = permission, 22023 = bad input
        const status =
            error.code === "23505" ? 409 :
            error.code === "42501" ? 403 :
            error.code === "22023" ? 400 :
            500;
        return NextResponse.json(
            { success: false, error: error.message || "Failed to create user." },
            { status }
        );
    }

    // Fetch the new profile row to return to the client.
    const { data: profile } = await getSupabase()
        .from(TABLE)
        .select("user_id, email, role, extra_permissions, display_name, created_at, updated_at")
        .eq("user_id", newUserId as string)
        .maybeSingle();

    return NextResponse.json({ success: true, user: profile, user_id: newUserId });
}
