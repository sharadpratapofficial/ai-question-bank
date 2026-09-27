import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createServerSupabaseClient } from "@/lib/supabase/server";
import { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase/env";

const TABLE = "ai_reports";

function getBearerToken(request: NextRequest): string | null {
    const authHeader = request.headers.get("authorization") || "";
    const [scheme, token] = authHeader.split(" ");
    return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function createBearerSupabaseClient(accessToken: string) {
    return createSupabaseClient(
        getSupabaseUrl(),
        getSupabasePublishableKey(),
        {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${accessToken}` } },
        }
    );
}

async function getAuthenticatedUser(request: NextRequest) {
    const db = await createServerSupabaseClient();
    const {
        data: { user },
        error,
    } = await db.auth.getUser();

    if (user) return { db, user, error: null };

    const accessToken = getBearerToken(request);
    if (!accessToken) {
        return { db, user: null, error: error?.message || "Sign in to view AI report history." };
    }

    const bearerDb = createBearerSupabaseClient(accessToken);
    const {
        data: { user: bearerUser },
        error: bearerError,
    } = await bearerDb.auth.getUser(accessToken);

    if (bearerError || !bearerUser) {
        return { db: bearerDb, user: null, error: bearerError?.message || "Sign in to view AI report history." };
    }

    return { db: bearerDb, user: bearerUser, error: null };
}

// GET /api/ai-tools/reports/[id]  — fetch full report data by ID
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        if (!id) {
            return NextResponse.json(
                { success: false, error: "Report ID is required." },
                { status: 400 }
            );
        }

        const { db, user, error: authError } = await getAuthenticatedUser(request);

        if (!user) {
            return NextResponse.json(
                { success: false, error: authError },
                { status: 401 }
            );
        }

        const { data, error } = await db
            .from(TABLE)
            .select("*")
            .eq("id", id)
            .eq("user_id", user.id)
            .single();

        if (error) {
            console.error("Error fetching AI report:", error);
            return NextResponse.json(
                { success: false, error: error.message },
                { status: 500 }
            );
        }

        if (!data) {
            return NextResponse.json(
                { success: false, error: "Report not found." },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true, report: data });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
