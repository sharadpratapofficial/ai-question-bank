import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function isProtectedPath(pathname: string): boolean {
    return (
        pathname.startsWith("/questions") ||
        pathname.startsWith("/browse") ||
        pathname.startsWith("/test") ||
        pathname.startsWith("/ai-tools") ||
        pathname.startsWith("/upload") ||
        pathname.startsWith("/question") ||
        pathname.startsWith("/admin")
    );
}

function isAdminPath(pathname: string): boolean {
    return pathname.startsWith("/admin");
}

export async function proxy(request: NextRequest) {
    let response = NextResponse.next({
        request: {
            headers: request.headers,
        },
    });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        request.cookies.set(name, value);
                        response.cookies.set(name, value, options);
                    });
                },
            },
        }
    );

    let user = null;
    try {
        const {
            data: { user: authUser },
        } = await supabase.auth.getUser();
        user = authUser;
    } catch {
        user = null;
    }

    const hasDevAuthCookie = request.cookies.get("qbg_dev_auth")?.value === "1";
    const isAuthenticated = Boolean(user) || hasDevAuthCookie;

    const { pathname } = request.nextUrl;

    if (!isAuthenticated && isProtectedPath(pathname)) {
        const redirectUrl = request.nextUrl.clone();
        redirectUrl.pathname = "/";
        redirectUrl.searchParams.set("next", pathname);
        return NextResponse.redirect(redirectUrl);
    }

    if (isAuthenticated && pathname === "/") {
        const redirectUrl = request.nextUrl.clone();
        redirectUrl.pathname = "/questions";
        return NextResponse.redirect(redirectUrl);
    }

    // /admin/* is admin-only. Dev-auth users are treated as admin in serverAuth,
    // but in middleware we don't have role info — defer enforcement to the page
    // and API routes (which check role server-side via requirePermission).
    // We still ensure these paths require *some* form of authentication above.
    if (isAdminPath(pathname) && !isAuthenticated) {
        const redirectUrl = request.nextUrl.clone();
        redirectUrl.pathname = "/";
        return NextResponse.redirect(redirectUrl);
    }

    return response;
}

export const middleware = proxy;

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    ],
};
