import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "@/lib/auth/serverAuth";
import { isValidRole, type UserRole } from "@/lib/auth/permissions";

const TABLE = "user_profiles";

function getSupabase() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

/**
 * Change a single user's role. Admin-only. Refuses to demote the last admin
 * so an admin lockout is impossible.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    const { id } = await params;
    if (!id) {
        return NextResponse.json(
            { success: false, error: "User id is required." },
            { status: 400 }
        );
    }

    let body: { role?: string };
    try {
        body = (await req.json()) as { role?: string };
    } catch {
        return NextResponse.json(
            { success: false, error: "Invalid JSON payload." },
            { status: 400 }
        );
    }

    const role = body?.role;
    if (!isValidRole(role)) {
        return NextResponse.json(
            { success: false, error: "Invalid role." },
            { status: 400 }
        );
    }

    const supabase = getSupabase();

    // Load the current row so we can detect last-admin demotion.
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
        return NextResponse.json(
            { success: false, error: "User profile not found." },
            { status: 404 }
        );
    }

    if (current.role === "admin" && role !== "admin") {
        const { count, error: countError } = await supabase
            .from(TABLE)
            .select("user_id", { count: "exact", head: true })
            .eq("role", "admin");
        if (countError) {
            return NextResponse.json(
                { success: false, error: `Admin count check failed: ${countError.message}` },
                { status: 500 }
            );
        }
        if ((count ?? 0) <= 1) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Cannot demote the last remaining admin.",
                },
                { status: 400 }
            );
        }
    }

    const { error: updateError, data: updated } = await supabase
        .from(TABLE)
        .update({ role: role as UserRole })
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
