/**
 * GET /api/qbg/token-status — is the saved QBG token usable right now?
 *
 * Called by Ingestion, Modification and the Pipeline before a run starts, so an
 * expired token is caught before any AI tokens are spent rather than at the push
 * at the very end (see src/lib/qbgToken.ts).
 *
 * Two checks, cheapest first:
 *   1. the JWT's own `exp` claim — free, no network, and definitive when passed;
 *   2. one tiny authenticated GET against QBG — the only way to catch a token that
 *      has not reached its expiry but was revoked or superseded by a newer login.
 *
 * Credentials are resolved exactly as the run routes resolve them (the signed-in
 * user's saved "qbg" key, or the x-dev-qbg header for a dev-auth session), so the
 * verdict is about the token the run would actually use.
 */
import { hasDevAuthCookie } from "@/lib/auth/devAuth";
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { parseQbgProviderConfig, sanitizeUserApiKeys, type QbgProviderConfig } from "@/lib/userApiKeys";
import { qbgTokenLocalVerdict, qbgTokenVerdict } from "@/lib/qbgToken";

// Same constants python/qbg_modification/qbg.py sends with every request.
const QBG_ORG_ID = "5eb393ee95fab7468a79d189";
// A single row of the smallest taxonomy list: authenticated, read-only, tiny.
// Any status other than 401/403 means QBG accepted the token — a 400 for a
// missing filter would still have been answered by an authenticated handler.
const PROBE_URL = "https://api.penpencil.co/qbg/classes?page=1&limit=1&status=visible";
const PROBE_TIMEOUT_MS = 8000;

async function resolveCreds(req: NextRequest): Promise<QbgProviderConfig> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        return parseQbgProviderConfig(sanitizeUserApiKeys(user.user_metadata?.api_keys).qbg);
    }
    if (hasDevAuthCookie(req.cookies)) {
        return parseQbgProviderConfig(req.headers.get("x-dev-qbg")?.trim() || "");
    }
    return parseQbgProviderConfig("");
}

export async function GET(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    const creds = await resolveCreds(req);
    const local = qbgTokenLocalVerdict(creds);
    if (local) return NextResponse.json({ success: true, check: local });

    const token = creds.token.trim();
    const probe: { httpStatus?: number; networkError?: string } = {};
    try {
        const res = await fetch(PROBE_URL, {
            headers: {
                "client-type": "QBG",
                "organization-id": QBG_ORG_ID,
                authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
                user: creds.user,
                "user-id": creds.userId,
            },
            cache: "no-store",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        probe.httpStatus = res.status;
    } catch (err) {
        probe.networkError = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({ success: true, check: qbgTokenVerdict(creds, probe) });
}
