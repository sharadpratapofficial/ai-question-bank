import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createServerSupabaseClient } from "@/lib/supabase/server";
import { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase/env";

const TABLE = "ai_reports";
const MAX_REPORTS = 100;
const VALID_REPORT_TYPES = new Set(["qc", "solution", "modification", "repeat_check", "extraction", "translate", "video", "qbg_modification", "qbg_ingestion", "qbg_tagging"]);

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
        return { db, user: null, error: error?.message || "Sign in to save and view AI report history." };
    }

    const bearerDb = createBearerSupabaseClient(accessToken);
    const {
        data: { user: bearerUser },
        error: bearerError,
    } = await bearerDb.auth.getUser(accessToken);

    if (bearerError || !bearerUser) {
        return { db: bearerDb, user: null, error: bearerError?.message || "Sign in to save and view AI report history." };
    }

    return { db: bearerDb, user: bearerUser, error: null };
}

// GET /api/ai-tools/reports?type=qc  (optional filter)
export async function GET(request: NextRequest) {
    try {
        const { db, user, error: authError } = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json(
                { success: false, error: authError, reports: [] },
                { status: 401 }
            );
        }

        const reportType = request.nextUrl.searchParams.get("type");

        let query = db
            .from(TABLE)
            .select("id, report_type, file_name, provider, model_id, created_at, report_data")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(MAX_REPORTS);

        if (reportType && VALID_REPORT_TYPES.has(reportType)) {
            query = query.eq("report_type", reportType);
        }

        const { data, error } = await query;

        if (error) {
            console.error("Error fetching AI reports:", error);
            return NextResponse.json(
                { success: false, error: error.message, reports: [] },
                { status: 500 }
            );
        }

        return NextResponse.json({ success: true, reports: data || [] });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: String(err), reports: [] },
            { status: 500 }
        );
    }
}

// POST /api/ai-tools/reports
// Body: { report_type, file_name, provider, model_id, report_data }
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { report_type, file_name, provider, model_id, report_data } = body;

        if (!report_type || !report_data) {
            return NextResponse.json(
                { success: false, error: "report_type and report_data are required." },
                { status: 400 }
            );
        }
        if (!VALID_REPORT_TYPES.has(String(report_type))) {
            return NextResponse.json(
                { success: false, error: "Invalid report_type." },
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .insert({
                user_id: user.id,
                report_type: String(report_type),
                file_name: String(file_name || ""),
                provider: String(provider || ""),
                model_id: String(model_id || ""),
                report_data,
            } as any)
            .select("id, report_type, file_name, provider, model_id, created_at")
            .single();

        if (error) {
            console.error("Error saving AI report:", error);
            return NextResponse.json(
                { success: false, error: error.message },
                { status: 500 }
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

// DELETE /api/ai-tools/reports?id=<uuid>
export async function DELETE(request: NextRequest) {
    try {
        const id = request.nextUrl.searchParams.get("id");

        if (!id) {
            return NextResponse.json(
                { success: false, error: "id query parameter is required." },
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

        const { error } = await db.from(TABLE).delete().eq("id", id).eq("user_id", user.id);

        if (error) {
            console.error("Error deleting AI report:", error);
            return NextResponse.json(
                { success: false, error: error.message },
                { status: 500 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
