/**
 * question-media: the rules for new-bank question images, in one place.
 *
 * Framework-free and import-free on purpose. It is used by
 *   - the API routes (src/app/api/question-media/**), through ./store.ts
 *   - the new-bank importer and its tests (scripts/newbank), which load this file
 *     directly with Node's TypeScript type stripping.
 * Keep it to erasable TypeScript (no enums, namespaces or parameter properties).
 *
 * Storage rules mirror scripts/sql/003_new_question_bank_support.sql:
 *   bucket  question-media (private), 10 MB, png/jpeg/gif/webp
 *   path    newbank/<question_id>/<file name>
 *   read    the qbg_questions SELECT permissions
 *   upload  manual_question_entry / upload_pdf / edit_metadata
 *   update / delete: nobody (objects are immutable)
 *
 * Question HTML stores only the storage path, behind the read route:
 *   <img src="/api/question-media/newbank/<question_id>/<file name>">
 * The route checks the caller and redirects to a short-lived signed URL, so no
 * public or signed URL is ever stored.
 */

export const QUESTION_MEDIA_BUCKET = "question-media";
export const QUESTION_MEDIA_PREFIX = "newbank";
export const QUESTION_MEDIA_ROUTE = "/api/question-media/";
export const QUESTION_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 300;

/** Same lists as the question_media_read / question_media_insert policies in 003. */
export const MEDIA_READ_PERMISSIONS = ["view_questions", "generate_tests", "manual_question_entry", "edit_metadata", "upload_pdf"] as const;
export const MEDIA_UPLOAD_PERMISSIONS = ["manual_question_entry", "upload_pdf", "edit_metadata"] as const;

export type MediaKind = "png" | "jpeg" | "gif" | "webp";
export const MEDIA_MIME: Record<MediaKind, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const CANONICAL_EXT: Record<MediaKind, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };
const EXT_KIND: Record<string, MediaKind> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" };
const MIME_KIND: Record<string, MediaKind> = { "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/pjpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The exact regex of the question_media_insert policy (003). A test keeps them identical. */
export const MEDIA_PATH_PATTERN = "^newbank/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const MEDIA_PATH_RE = new RegExp(MEDIA_PATH_PATTERN);

// ---------------------------------------------------------------- content ---

/** Identify an image by its magic bytes. SVG (text, can carry script) is never accepted. */
export function sniffImageKind(b: Uint8Array): MediaKind | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
    return null;
}

function baseName(name: string): string {
    return (name || "").split(/[\\/]/).pop() || "";
}

/** The kind a file name's extension claims, or null when it has no (known) extension. */
export function extensionKind(name: string): MediaKind | null {
    const m = baseName(name).match(/\.([A-Za-z0-9]+)$/);
    return m ? EXT_KIND[m[1].toLowerCase()] ?? null : null;
}

export type MediaCheck =
    | { ok: true; kind: MediaKind; mime: string }
    | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Validate an image by its bytes (not by what the uploader claims):
 * non-empty, at most 10 MB, a real PNG/JPEG/GIF/WebP, and consistent with the
 * file name's extension and the declared MIME type when those are given.
 */
export function validateMediaBytes(bytes: Uint8Array, originalName: string, declaredMime?: string | null): MediaCheck {
    if (!bytes || bytes.length === 0) return { ok: false, status: 400, error: "The file is empty." };
    if (bytes.length > QUESTION_MEDIA_MAX_BYTES) {
        return { ok: false, status: 413, error: `The file is ${bytes.length} bytes; the limit is ${QUESTION_MEDIA_MAX_BYTES} (10 MB).` };
    }
    const kind = sniffImageKind(bytes);
    if (!kind) return { ok: false, status: 415, error: "Not a PNG, JPEG, GIF or WebP image (SVG is not accepted)." };
    const byName = extensionKind(originalName);
    const ext = baseName(originalName).match(/\.([A-Za-z0-9]+)$/)?.[1];
    if (ext && !byName) return { ok: false, status: 415, error: `Unsupported file extension ".${ext}".` };
    if (byName && byName !== kind) return { ok: false, status: 415, error: `The file name says ${byName} but the content is ${kind}.` };
    const declared = (declaredMime || "").toLowerCase().split(";")[0].trim();
    if (declared && declared !== "application/octet-stream") {
        const byMime = MIME_KIND[declared];
        if (byMime !== kind) return { ok: false, status: 415, error: `Declared type ${declared} does not match the content (${kind}).` };
    }
    return { ok: true, kind, mime: MEDIA_MIME[kind] };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------- paths ---

/**
 * Deterministic object name: the source file's name (sanitised) + the first 12 hex
 * chars of the content's SHA-256 + the canonical extension, e.g. "fig 3.PNG" ->
 * "fig-3-1a2b3c4d5e6f.png". The same bytes always map to the same name (idempotent
 * retries), and different bytes get a different name, so nothing is overwritten.
 */
export function mediaFileName(originalName: string, sha256: string, kind: MediaKind): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 lower-case hex characters");
    const stem = baseName(originalName)
        .replace(/\.[^.]*$/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .replace(/[._-]+$/, "")
        .slice(0, 80) || "image";
    return `${stem}-${sha256.slice(0, 12)}.${CANONICAL_EXT[kind]}`;
}

export function mediaStoragePath(questionId: string, fileName: string): string {
    if (!UUID_RE.test(questionId)) throw new Error(`not a lower-case question uuid: ${questionId}`);
    const p = `${QUESTION_MEDIA_PREFIX}/${questionId}/${fileName}`;
    if (!parseMediaPath(p)) throw new Error(`invalid media path: ${p}`);
    return p;
}

/** Accepts exactly the paths the storage policy accepts (and a known image extension). */
export function parseMediaPath(p: string): { questionId: string; fileName: string } | null {
    if (typeof p !== "string" || !MEDIA_PATH_RE.test(p)) return null;
    const [, questionId, fileName] = p.split("/");
    if (!extensionKind(fileName)) return null;
    return { questionId, fileName };
}

export function mediaSrc(storagePath: string): string {
    return QUESTION_MEDIA_ROUTE + storagePath;
}

// ---------------------------------------------------------------- handlers ---

export interface MediaCaller {
    isAuthenticated: boolean;
    permissions: readonly string[];
}

/** Storage access used by the handlers; ./store.ts implements it with Supabase. */
export interface MediaStore {
    signedUrl(path: string, ttlSeconds: number): Promise<{ url: string } | { notFound: true } | { error: string }>;
    /** Never overwrites: resolves "exists" when an object is already at the path. */
    upload(path: string, bytes: Uint8Array, mime: string): Promise<"uploaded" | "exists">;
    download(path: string): Promise<Uint8Array | null>;
    questionExists(questionId: string): Promise<boolean>;
}

export interface MediaResult {
    status: number;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
}

const hasAny = (c: MediaCaller, perms: readonly string[]) => perms.some((p) => c.permissions.includes(p));
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): MediaResult => ({ status, body: { success: false, error, ...extra } });

function deny(caller: MediaCaller, perms: readonly string[]): MediaResult | null {
    if (!caller.isAuthenticated) return fail(401, "Sign in required.");
    if (!hasAny(caller, perms)) return fail(403, `Forbidden: needs one of ${perms.join(", ")}.`, { code: "FORBIDDEN" });
    return null;
}
export const denyMediaRead = (caller: MediaCaller) => deny(caller, MEDIA_READ_PERMISSIONS);
export const denyMediaUpload = (caller: MediaCaller) => deny(caller, MEDIA_UPLOAD_PERMISSIONS);

/** GET /api/question-media/<path>: permission check, then a redirect to a short-lived signed URL. */
export async function readQuestionMedia(caller: MediaCaller, path: string, store: MediaStore): Promise<MediaResult> {
    const denied = denyMediaRead(caller);
    if (denied) return denied;
    if (!parseMediaPath(path)) return fail(400, "Invalid media path.");
    const r = await store.signedUrl(path, SIGNED_URL_TTL_SECONDS);
    if ("notFound" in r) return fail(404, "Not found.");
    if ("error" in r) return fail(502, "Storage error.");
    return {
        status: 302,
        headers: {
            Location: r.url,
            // the signed URL expires; let the browser reuse the redirect only briefly, privately
            "Cache-Control": `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`,
            "Referrer-Policy": "no-referrer",
        },
    };
}

export interface MediaUploadInput {
    questionId: string;
    originalName: string;
    bytes: Uint8Array;
    declaredMime?: string | null;
}

/**
 * POST /api/question-media: store one image for an existing question.
 * Idempotent: re-uploading the same bytes returns the same path (200 already_exists).
 * Never overwrites: a different object at the same path is a 409.
 */
export async function uploadQuestionMedia(caller: MediaCaller, input: MediaUploadInput, store: MediaStore): Promise<MediaResult> {
    const denied = denyMediaUpload(caller);
    if (denied) return denied;
    if (!UUID_RE.test(input.questionId || "")) return fail(400, "question_id must be a lower-case question uuid.");
    const check = validateMediaBytes(input.bytes, input.originalName, input.declaredMime);
    if (!check.ok) return fail(check.status, check.error);
    if (!(await store.questionExists(input.questionId))) return fail(404, "Question not found.");

    const sha256 = await sha256Hex(input.bytes);
    const fileName = mediaFileName(input.originalName, sha256, check.kind);
    const path = mediaStoragePath(input.questionId, fileName);
    const meta = { path, src: mediaSrc(path), file_name: fileName, original_name: baseName(input.originalName), sha256, bytes: input.bytes.length, mime: check.mime };

    if ((await store.upload(path, input.bytes, check.mime)) === "uploaded") {
        return { status: 201, body: { success: true, status: "uploaded", ...meta } };
    }
    const existing = await store.download(path);
    if (existing && (await sha256Hex(existing)) === sha256) {
        return { status: 200, body: { success: true, status: "already_exists", ...meta } };
    }
    return fail(409, "A different file already exists at this path; it is never overwritten.", { path });
}
