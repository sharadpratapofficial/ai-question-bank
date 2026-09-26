/**
 * GET /api/integrations/google-drive/callback
 *
 * Exchanges Google's authorization code for a refresh token, stores it in
 * the caller's vault (src/lib/userApiKeys.ts's "google_drive" provider —
 * same storage location/pattern as every other saved credential in this
 * app), and redirects back to the Question Wise Videos page.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens } from "@/lib/googleDrive";
import {
    sanitizeUserApiKeys,
    parseGoogleDriveProviderConfig,
    stringifyGoogleDriveProviderConfig,
} from "@/lib/userApiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See connect/route.ts's getOrigin() for why this isn't request.nextUrl.origin. */
function getOrigin(request: NextRequest): string {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
    const proto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "");
    return `${proto}://${host}`;
}

export async function GET(request: NextRequest) {
    const origin = getOrigin(request);
    const returnTo = `${origin}/question-wise-videos`;

    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) {
        return NextResponse.redirect(
            `${returnTo}?driveError=${encodeURIComponent("Missing permission to connect Google Drive.")}`
        );
    }

    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const errorParam = request.nextUrl.searchParams.get("error");
    const expectedState = request.cookies.get("gdrive_oauth_state")?.value;

    if (errorParam) {
        return NextResponse.redirect(`${returnTo}?driveError=${encodeURIComponent(errorParam)}`);
    }
    if (!code || !state || !expectedState || state !== expectedState) {
        return NextResponse.redirect(
            `${returnTo}?driveError=${encodeURIComponent("Invalid or expired connect request. Please try again.")}`
        );
    }

    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.redirect(
            `${returnTo}?driveError=${encodeURIComponent("You must be signed in to connect Google Drive.")}`
        );
    }

    try {
        const redirectUri = `${origin}/api/integrations/google-drive/callback`;
        const { refreshToken, email } = await exchangeCodeForTokens(code, redirectUri);

        const userMetadata =
            user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
        const currentApiKeys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
        const existingFolderId = parseGoogleDriveProviderConfig(currentApiKeys.google_drive).folderId;
        const nextApiKeys = {
            ...currentApiKeys,
            google_drive: stringifyGoogleDriveProviderConfig({ refreshToken, email, folderId: existingFolderId }),
        };

        const { error } = await supabase.auth.updateUser({
            data: { ...userMetadata, api_keys: nextApiKeys },
        });
        if (error) throw error;

        const response = NextResponse.redirect(`${returnTo}?driveConnected=1`);
        response.cookies.delete("gdrive_oauth_state");
        return response;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.redirect(`${returnTo}?driveError=${encodeURIComponent(message)}`);
    }
}
