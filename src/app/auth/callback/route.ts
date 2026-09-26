import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    defaultLandingPathFor,
    effectivePermissions,
    isValidRole,
    pathRequiresPermission,
} from "@/lib/auth/permissions";

function getAllowedGoogleEmails(): Set<string> {
    return new Set(
        (process.env.QBG_ALLOWED_GOOGLE_EMAILS || "")
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
    );
}

// Behind the Cloudflare tunnel, `request.url`'s own origin resolves to the
// Next.js server's local bind address (e.g. 0.0.0.0:5001), not the public
// domain the browser is actually on — trust the standard reverse-proxy
// forwarded headers first, since the tunnel sets them on every request.
function resolveOrigin(request: Request, requestUrl: URL): string {
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (!forwardedHost) return requestUrl.origin;
    const forwardedProto = request.headers.get("x-forwarded-proto") || requestUrl.protocol.replace(":", "");
    return `${forwardedProto}://${forwardedHost}`;
}

function redirectWithAuthError(origin: string, next: string, message: string) {
    const url = new URL("/", origin);
    url.searchParams.set("next", next);
    url.searchParams.set("authError", message);
    const response = NextResponse.redirect(url);
    response.cookies.set("qbg_dev_auth", "", {
        path: "/",
        maxAge: 0,
        sameSite: "lax",
    });
    return response;
}

export async function GET(request: Request) {
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const provider = requestUrl.searchParams.get("provider");
    const origin = resolveOrigin(request, requestUrl);

    let next = requestUrl.searchParams.get("next") ?? "/questions";
    if (!next.startsWith("/")) {
        next = "/questions";
    }

    if (!code) {
        return redirectWithAuthError(origin, next, "Sign in failed. Please try again.");
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        return redirectWithAuthError(origin, next, "Google sign in failed. Please try again.");
    }

    if (provider === "google") {
        const allowedEmails = getAllowedGoogleEmails();
        const signedInEmail = data.user?.email?.trim().toLowerCase() || "";

        if (!allowedEmails.size || !signedInEmail || !allowedEmails.has(signedInEmail)) {
            await supabase.auth.signOut();
            return redirectWithAuthError(
                origin,
                next,
                "This Google email is not registered for access."
            );
        }
    }

    // Steer away from a page the user's role can't see — e.g. the app's
    // hardcoded post-login default "/questions", which a QBG/Video-only role
    // lacks view_questions for — instead of landing them on a dead page.
    const requiredPermission = pathRequiresPermission(next);
    if (requiredPermission && data.user?.id) {
        const { data: profile } = await supabase
            .from("user_profiles")
            .select("role, extra_permissions")
            .eq("user_id", data.user.id)
            .maybeSingle();
        const role = isValidRole(profile?.role) ? profile.role : undefined;
        const perms = effectivePermissions(role, profile?.extra_permissions);
        if (!perms.includes(requiredPermission)) {
            next = defaultLandingPathFor(perms);
        }
    }

    const response = NextResponse.redirect(`${origin}${next}`);
    response.cookies.set("qbg_dev_auth", "1", {
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        httpOnly: false,
    });
    return response;
}
