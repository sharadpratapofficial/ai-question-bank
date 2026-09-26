/**
 * Is the saved QBG token still good — checked BEFORE a run, not discovered after.
 *
 * Ingestion, Modification and the Pipeline all spend AI tokens first and touch
 * QBG last. An expired QBG token used to surface only at the push, after the
 * whole paper had been extracted / reframed / QC'd — every AI call paid for and
 * nothing ingested (2026-09-22 report). So each of those runs now asks
 * /api/qbg/token-status first and stops, or asks, before any AI call is made.
 *
 * Isomorphic: the route uses the JWT decoding, the panels use the pre-run check.
 */
import { readDevApiKeysFromStorage } from "@/lib/userApiKeys";

export type QbgTokenStatus =
    /** Present, not expired, and QBG accepted it just now. */
    | "valid"
    /** Valid now, but expires soon enough that a long run could outlast it. */
    | "expiring"
    /** The token's own `exp` has passed. */
    | "expired"
    /** Not expired by its clock, but QBG answered 401/403 — revoked or superseded. */
    | "rejected"
    /** No token / user / user-id saved. */
    | "missing"
    /** Not expired by its clock, but QBG could not be reached to confirm it. */
    | "unverified";

export interface QbgTokenCheck {
    status: QbgTokenStatus;
    message: string;
    /** ISO time the token expires, when the token says. */
    expiresAt?: string;
    minutesLeft?: number;
}

/** A run shorter than this is not at risk; a long reframe with QC can take most of it. */
export const QBG_TOKEN_EXPIRING_MINUTES = 60;

const WHERE_TO_UPDATE = "Update it under the user icon → Manage API Keys → QBG (PenPencil) API, then run again.";

/** The `exp` claim of a JWT, or null when the token is not a JWT or carries none. */
export function qbgTokenExpiry(token: string): Date | null {
    try {
        let tok = (token || "").trim();
        if (tok.toLowerCase().startsWith("bearer ")) tok = tok.slice(7).trim();
        const part = tok.split(".")[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
        const payload = JSON.parse(atob(b64)) as { exp?: unknown };
        const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
        return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
    } catch {
        return null;
    }
}

function formatWhen(d: Date): string {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The verdict from the token alone — no network. `null` means "not decided yet, ask QBG". */
export function qbgTokenLocalVerdict(creds: { token: string; user: string; userId: string }, now = new Date()): QbgTokenCheck | null {
    if (!creds.token.trim() || !creds.user.trim() || !creds.userId.trim()) {
        const missing = [
            !creds.token.trim() && "token",
            !creds.user.trim() && "user",
            !creds.userId.trim() && "user-id",
        ].filter(Boolean).join(", ");
        return { status: "missing", message: `No QBG ${missing} is saved. ${WHERE_TO_UPDATE}` };
    }
    const exp = qbgTokenExpiry(creds.token);
    if (exp && exp.getTime() <= now.getTime()) {
        return {
            status: "expired",
            expiresAt: exp.toISOString(),
            minutesLeft: 0,
            message: `Your QBG token expired on ${formatWhen(exp)}. ${WHERE_TO_UPDATE}`,
        };
    }
    return null;
}

/** Final verdict once QBG has answered (or failed to). */
export function qbgTokenVerdict(
    creds: { token: string },
    probe: { httpStatus?: number; networkError?: string },
    now = new Date()
): QbgTokenCheck {
    const exp = qbgTokenExpiry(creds.token);
    const expiresAt = exp?.toISOString();
    const minutesLeft = exp ? Math.max(0, Math.floor((exp.getTime() - now.getTime()) / 60000)) : undefined;

    if (probe.httpStatus === 401 || probe.httpStatus === 403) {
        return {
            status: "rejected",
            expiresAt,
            minutesLeft,
            message:
                `QBG rejected your saved token (HTTP ${probe.httpStatus}) — it has been revoked or replaced ` +
                `by a newer login, even though it has not reached its expiry time. ${WHERE_TO_UPDATE}`,
        };
    }
    if (probe.httpStatus === undefined) {
        return {
            status: "unverified",
            expiresAt,
            minutesLeft,
            message:
                `Could not reach QBG to confirm your token (${probe.networkError || "no response"}). ` +
                `If it has expired, the AI work will run and the push at the end will fail.`,
        };
    }
    if (minutesLeft !== undefined && minutesLeft < QBG_TOKEN_EXPIRING_MINUTES) {
        return {
            status: "expiring",
            expiresAt,
            minutesLeft,
            message:
                `Your QBG token expires in ${minutesLeft} minute(s), at ${formatWhen(exp!)}. ` +
                `A long run can outlast it, and the push at the end would then fail after the AI work is paid for.`,
        };
    }
    return {
        status: "valid",
        expiresAt,
        minutesLeft,
        message: exp ? `QBG token is valid until ${formatWhen(exp)}.` : "QBG token accepted.",
    };
}

/**
 * Run from a panel right before a run that will touch QBG. Returns whether to
 * go ahead; when not, `error` is what to show the user.
 *
 * Blocks outright on a missing / expired / rejected token. For one that is about
 * to expire, or that QBG could not confirm, the user decides — those can still
 * succeed. A failure of this check itself (our own route down) never blocks: the
 * run would then fail or succeed exactly as it did before this check existed.
 */
export async function checkQbgTokenBeforeRun(): Promise<{ proceed: boolean; error?: string }> {
    // A dev-auth session keeps its QBG creds in the browser, not on the server,
    // so they travel with the request exactly as they do for the run itself.
    const headers: Record<string, string> = {};
    if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
        headers["x-dev-qbg"] = readDevApiKeysFromStorage().qbg || "";
    }
    let check: QbgTokenCheck;
    try {
        const res = await fetch("/api/qbg/token-status", { headers, cache: "no-store" });
        const data = (await res.json()) as { success?: boolean; check?: QbgTokenCheck };
        if (!data?.check) return { proceed: true };
        check = data.check;
    } catch {
        return { proceed: true };
    }

    if (check.status === "valid") return { proceed: true };
    if (check.status === "expiring" || check.status === "unverified") {
        const ok = typeof window !== "undefined" &&
            window.confirm(`${check.message}\n\nStart the run anyway?`);
        return ok
            ? { proceed: true }
            : { proceed: false, error: `${check.message} ${WHERE_TO_UPDATE} Nothing was sent to the AI.` };
    }
    return { proceed: false, error: `${check.message} Nothing was sent to the AI.` };
}
