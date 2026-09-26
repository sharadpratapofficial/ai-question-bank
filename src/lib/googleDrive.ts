/**
 * Google Drive OAuth (drive.file scope) + upload helpers.
 *
 * drive.file is narrow — it only ever touches files this app itself creates
 * (never the user's whole Drive), so it doesn't require Google's manual
 * security-assessment review, just a normal OAuth consent screen. Requires
 * a Google Cloud OAuth Client (GOOGLE_DRIVE_CLIENT_ID/_SECRET) the operator
 * sets up once in Google Cloud Console — see the Question Wise Videos plan
 * for the exact steps. Refresh tokens are stored per-user in the same
 * plaintext vault every other provider credential in this app already uses
 * (src/lib/userApiKeys.ts's "google_drive" provider) — not a new risk
 * posture, just following the existing convention.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function clientCreds(): { clientId: string; clientSecret: string } {
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || "";
    if (!clientId || !clientSecret) {
        throw new Error(
            "Google Drive isn't configured on this server (missing GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET)."
        );
    }
    return { clientId, clientSecret };
}

export function getAuthorizeUrl(redirectUri: string, state: string): string {
    const { clientId } = clientCreds();
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: `${DRIVE_SCOPE} openid email`,
        access_type: "offline",
        // Always show the consent screen so a repeat connect still returns a
        // refresh_token — Google omits it on a "silent" re-auth otherwise.
        prompt: "consent",
        state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function fetchAccountEmail(accessToken: string): Promise<string> {
    try {
        const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!res.ok) return "";
        const data = (await res.json()) as { email?: string };
        return data.email || "";
    } catch {
        return "";
    }
}

export async function exchangeCodeForTokens(
    code: string,
    redirectUri: string
): Promise<{ refreshToken: string; accessToken: string; email: string }> {
    const { clientId, clientSecret } = clientCreds();
    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
    };
    if (!res.ok || !data.access_token) {
        throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.statusText}`);
    }
    if (!data.refresh_token) {
        throw new Error(
            "Google did not return a refresh token. Try disconnecting (if already connected) and connecting again."
        );
    }
    const email = await fetchAccountEmail(data.access_token);
    return { refreshToken: data.refresh_token, accessToken: data.access_token, email };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
    const { clientId, clientSecret } = clientCreds();
    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
        }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
        throw new Error(
            `Google token refresh failed: ${data.error_description || data.error || res.statusText}. Try reconnecting Google Drive from Manage API Keys.`
        );
    }
    return data.access_token;
}

/** Finds a folder by name (optionally scoped to a parent), creating it if it
 *  doesn't exist. Used both for the shared "Question Wise Videos" folder and
 *  per-job subfolders inside it. */
export async function ensureFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
    const escapedName = name.replace(/'/g, "\\'");
    const parentClause = parentId ? ` and '${parentId}' in parents` : " and 'root' in parents";
    const q = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed=false${parentClause}`;
    const listUrl = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
    const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const listData = (await listRes.json()) as { files?: { id: string }[]; error?: { message?: string } };
    if (listRes.ok && listData.files && listData.files.length > 0) {
        return listData.files[0].id;
    }

    const createRes = await fetch(`${DRIVE_API_BASE}/files?fields=id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: parentId ? [parentId] : undefined,
        }),
    });
    const createData = (await createRes.json()) as { id?: string; error?: { message?: string } };
    if (!createRes.ok || !createData.id) {
        throw new Error(`Failed to create Drive folder "${name}": ${createData.error?.message || createRes.statusText}`);
    }
    return createData.id;
}

export interface UploadFileArgs {
    name: string;
    mimeType: string;
    bytes: Buffer;
    parentId: string;
}

export async function uploadFile(
    accessToken: string,
    args: UploadFileArgs
): Promise<{ id: string; webViewLink: string }> {
    const metadata = { name: args.name, parents: [args.parentId] };
    const boundary = `qwv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
    const mediaHeader = `--${boundary}\r\nContent-Type: ${args.mimeType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--`;
    const body = Buffer.concat([
        Buffer.from(metadataPart, "utf8"),
        Buffer.from(mediaHeader, "utf8"),
        args.bytes,
        Buffer.from(closing, "utf8"),
    ]);

    const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
    });
    const data = (await res.json()) as { id?: string; webViewLink?: string; error?: { message?: string } };
    if (!res.ok || !data.id) {
        throw new Error(`Drive upload failed for "${args.name}": ${data.error?.message || res.statusText}`);
    }
    return { id: data.id, webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}
