/**
 * GET /api/integrations/google-drive/connect
 *
 * Starts the "Connect Google Drive" OAuth flow (drive.file scope). Redirects
 * to Google's consent screen; the CSRF-guard `state` value is round-tripped
 * via a short-lived httpOnly cookie, verified in .../callback.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getAuthorizeUrl } from "@/lib/googleDrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** request.nextUrl.origin reflects the server's own bind address (e.g. the
 *  dev server's "next dev -H 0.0.0.0" → "0.0.0.0:5001"), not what the
 *  browser actually used to reach it — Google's redirect_uri must match a
 *  real, browser-reachable, pre-registered origin, so it's built from the
 *  Host header (what the browser sent) instead. */
function getOrigin(request: NextRequest): string {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
    const proto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "");
    return `${proto}://${host}`;
}

export async function GET(request: NextRequest) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const origin = getOrigin(request);
    const redirectUri = `${origin}/api/integrations/google-drive/callback`;
    const state = crypto.randomBytes(16).toString("hex");

    let authorizeUrl: string;
    try {
        authorizeUrl = getAuthorizeUrl(redirectUri, state);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.redirect(`${origin}/question-wise-videos?driveError=${encodeURIComponent(message)}`);
    }

    const response = NextResponse.redirect(authorizeUrl);
    response.cookies.set("gdrive_oauth_state", state, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        maxAge: 600,
        path: "/",
    });
    return response;
}
