/**
 * Dev-auth bypass (`qbg_dev_auth=1` cookie) — local development only.
 *
 * The sign-in page only offers the dev login when NODE_ENV !== "production",
 * but the cookie itself is trivially forgeable from any browser. Every server
 * check must therefore go through this helper so a production build never
 * treats the cookie as authentication, whoever set it.
 */

export const DEV_AUTH_COOKIE = "qbg_dev_auth";

export const DEV_AUTH_ENABLED = process.env.NODE_ENV !== "production";

interface CookieReader {
    get(name: string): { value: string } | undefined;
}

/** True only outside production AND when the dev-auth cookie is set. */
export function hasDevAuthCookie(cookies: CookieReader): boolean {
    return DEV_AUTH_ENABLED && cookies.get(DEV_AUTH_COOKIE)?.value === "1";
}
