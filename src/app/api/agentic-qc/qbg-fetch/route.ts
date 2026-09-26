/**
 * POST /api/agentic-qc/qbg-fetch
 *
 * Body: { qbgIds: string }  — comma / whitespace / newline separated QBG unique_ids.
 *
 * Resolves the caller's saved QBG credentials server-side, fetches each question
 * live from QBG's bulk endpoint, and adapts them into the SAME `ParsedQuestion[]`
 * shape a CSV / Excel upload produces (via the existing pool adapter). The client
 * then runs the identical structured-mode QC job with these questions — so QBG-ids
 * is just a new way to obtain the questions, riding all the existing QC rails.
 *
 * Returns: { success, questions: ParsedQuestion[], subjects: string[],
 *            missingIds: string[], warnings: string[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { sanitizeUserApiKeys, parseQbgProviderConfig } from "@/lib/userApiKeys";
import { fetchQbgPoolRowsByIds, type QbgCreds } from "@/lib/agenticQC/qbgLiveFetch";
import { adaptPoolRowsToParsedQuestions } from "@/lib/agenticQC/qbgPoolAdapter";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_agentic_qc");
    if (forbid) return forbid;

    let body: { qbgIds?: string };
    try {
        body = (await req.json()) as { qbgIds?: string };
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
    }

    const ids = (body.qbgIds || "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (ids.length === 0) {
        return NextResponse.json(
            { success: false, error: "Paste at least one QBG unique_id." },
            { status: 400 }
        );
    }

    // ─── Resolve QBG credentials (never trusted from the client body) ────────
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    const isDev = req.cookies.get("qbg_dev_auth")?.value === "1";

    let creds: QbgCreds | undefined;
    if (user) {
        const keys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
        creds = parseQbgProviderConfig(keys.qbg);
    } else if (isDev) {
        const rawQbg = req.headers.get("x-dev-qbg")?.trim();
        if (rawQbg) creds = parseQbgProviderConfig(rawQbg);
    } else {
        return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    }

    if (!creds || !creds.token || !creds.user || !creds.userId) {
        return NextResponse.json(
            {
                success: false,
                error:
                    "QBG token / user / user-id are required. Add them under the user icon → Manage API Keys → QBG (PenPencil) API.",
            },
            { status: 400 }
        );
    }

    // ─── Fetch live + adapt to ParsedQuestion[] ──────────────────────────────
    try {
        const { rows, missingIds } = await fetchQbgPoolRowsByIds(ids, creds);
        if (rows.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "None of the given QBG ids returned a usable question" +
                        (missingIds.length ? ` (${missingIds.length} not found).` : "."),
                    missingIds,
                },
                { status: 404 }
            );
        }

        const { questions, warnings } = adaptPoolRowsToParsedQuestions(rows);
        if (questions.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: "The fetched QBG questions couldn't be parsed for QC.",
                    missingIds,
                    warnings,
                },
                { status: 422 }
            );
        }

        // Distinct subjects detected across the parsed questions — pre-fills the
        // Subjects pills client-side, same as the CSV path does.
        const subjects = Array.from(
            new Set(questions.map((q) => q.subject).filter((s): s is string => Boolean(s)))
        );

        return NextResponse.json({
            success: true,
            questions,
            subjects,
            missingIds,
            warnings,
        });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 502 }
        );
    }
}
