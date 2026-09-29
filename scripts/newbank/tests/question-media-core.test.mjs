// Tests for the app's question-media rules and route handlers (src/lib/questionMedia/core.ts),
// with the app's real role -> permission map and an in-memory storage fake. Synthetic bytes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    sniffImageKind, validateMediaBytes, mediaFileName, mediaStoragePath, parseMediaPath, mediaSrc, sha256Hex,
    readQuestionMedia, uploadQuestionMedia, MEDIA_READ_PERMISSIONS, MEDIA_UPLOAD_PERMISSIONS, MEDIA_PATH_PATTERN,
    QUESTION_MEDIA_MAX_BYTES, SIGNED_URL_TTL_SECONDS,
} from "../../../src/lib/questionMedia/core.ts";
import { ROLE_PERMISSIONS } from "../../../src/lib/auth/permissions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_003 = fs.readFileSync(path.join(here, "..", "..", "sql", "003_new_question_bank_support.sql"), "utf8");

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF = Buffer.from("%PDF-1.7 synthetic");

const Q = "abcdef01-2345-4678-89ab-cdef01234567";
const as = (role) => ({ isAuthenticated: true, permissions: ROLE_PERMISSIONS[role] });
const ANON = { isAuthenticated: false, permissions: [] };

/** In-memory MediaStore: never overwrites, counts every call. */
class MemStore {
    constructor(questions = [Q]) { this.questions = new Set(questions); this.objects = new Map(); this.calls = { signedUrl: 0, upload: 0, download: 0, questionExists: 0 }; }
    async signedUrl(p, ttl) { this.calls.signedUrl++; return this.objects.has(p) ? { url: `https://example.test/sign/${p}?ttl=${ttl}&token=t` } : { notFound: true }; }
    async upload(p, bytes) { this.calls.upload++; if (this.objects.has(p)) return "exists"; this.objects.set(p, Buffer.from(bytes)); return "uploaded"; }
    async download(p) { this.calls.download++; return this.objects.get(p) ?? null; }
    async questionExists(id) { this.calls.questionExists++; return this.questions.has(id); }
}
const upload = (caller, store, bytes = PNG, name = "Fig 1.png", mime = "image/png", questionId = Q) =>
    uploadQuestionMedia(caller, { questionId, originalName: name, bytes: new Uint8Array(bytes), declaredMime: mime }, store);

// ------------------------------------------------------------- rules ---

test("permissions and path rule are identical to the 003 storage policies", () => {
    const arr = (policy) => SQL_003.match(new RegExp(`create policy ${policy}[\\s\\S]*?has_any_permission\\(array\\[([^\\]]*)\\]`))[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.deepEqual(arr("question_media_read"), [...MEDIA_READ_PERMISSIONS]);
    assert.deepEqual(arr("question_media_insert"), [...MEDIA_UPLOAD_PERMISSIONS]);
    assert.ok(SQL_003.includes(`name ~ '${MEDIA_PATH_PATTERN}'`), "path regex drift between core.ts and 003");
    assert.ok(SQL_003.includes("10485760") && QUESTION_MEDIA_MAX_BYTES === 10485760);
});

test("image type is decided by content; SVG, PDF and text are refused", () => {
    assert.equal(sniffImageKind(PNG), "png");
    assert.equal(sniffImageKind(JPEG), "jpeg");
    assert.equal(sniffImageKind(GIF), "gif");
    assert.equal(sniffImageKind(WEBP), "webp");
    for (const b of [SVG, PDF, Buffer.from("hello")]) assert.equal(sniffImageKind(b), null);
});

test("validateMediaBytes: empty, oversize, wrong type, extension or MIME mismatch", () => {
    assert.equal(validateMediaBytes(new Uint8Array(0), "a.png").status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(QUESTION_MEDIA_MAX_BYTES)]);
    assert.equal(validateMediaBytes(big, "a.png").status, 413);
    assert.equal(validateMediaBytes(SVG, "a.svg").status, 415);
    assert.equal(validateMediaBytes(PDF, "a.pdf").status, 415);
    assert.equal(validateMediaBytes(PNG, "a.jpg").status, 415, "extension says jpeg, content is png");
    assert.equal(validateMediaBytes(PNG, "a.bmp").status, 415, "unknown extension");
    assert.equal(validateMediaBytes(PNG, "a.png", "image/gif").status, 415, "declared MIME mismatch");
    const ok = validateMediaBytes(JPEG, "photo.JPEG", "image/jpeg");
    assert.deepEqual([ok.ok, ok.mime], [true, "image/jpeg"]);
    assert.equal(validateMediaBytes(PNG, "no-extension", "application/octet-stream").ok, true);
});

test("file names are deterministic, keep the source name, and change with the content", async () => {
    const h = await sha256Hex(PNG);
    const a = mediaFileName("figures\\Fig 3 (a).PNG", h, "png");
    assert.equal(a, `Fig-3-a-${h.slice(0, 12)}.png`);
    assert.equal(mediaFileName("figures\\Fig 3 (a).PNG", h, "png"), a, "same input, same name");
    assert.notEqual(mediaFileName("Fig 3 (a).PNG", await sha256Hex(JPEG), "jpeg"), a);
    assert.match(mediaFileName("../../evil name.png", h, "png"), /^evil-name-[0-9a-f]{12}\.png$/, "directories are dropped");
    assert.match(mediaFileName("../../ .hidden", h, "png"), /^image-[0-9a-f]{12}\.png$/, "a name with no stem falls back to 'image'");
    assert.match(mediaFileName("€€€.png", h, "png"), /^image-[0-9a-f]{12}\.png$/);
    assert.ok(mediaFileName("x".repeat(500) + ".png", h, "png").length <= 128);
});

test("storage paths: exactly newbank/<lower-case question uuid>/<safe name>.<image ext>", async () => {
    const name = mediaFileName("a.png", await sha256Hex(PNG), "png");
    const p = mediaStoragePath(Q, name);
    assert.equal(p, `newbank/${Q}/${name}`);
    assert.deepEqual(parseMediaPath(p), { questionId: Q, fileName: name });
    assert.equal(mediaSrc(p), `/api/question-media/${p}`);
    for (const bad of [`other/${Q}/a.png`, `newbank/${Q.toUpperCase()}/a.png`, `newbank/${Q}/../a.png`, `newbank/${Q}/sub/a.png`, `newbank/${Q}/.a.png`, `newbank/${Q}/a.svg`, `newbank/${Q}/a`, `newbank/not-a-uuid/a.png`, ""]) {
        assert.equal(parseMediaPath(bad), null, bad);
    }
    assert.throws(() => mediaStoragePath(Q.toUpperCase(), name));
});

// ---------------------------------------------------------- read route ---

test("read: allowed roles get a short-lived private redirect; nothing is signed for others", async () => {
    const store = new MemStore();
    const created = await upload(as("data_entry"), store);
    const p = created.body.path;
    for (const role of ["viewer", "qc_reviewer", "data_entry", "manager", "admin", "ai_user"]) {
        const r = await readQuestionMedia(as(role), p, store);
        assert.equal(r.status, 302, role);
        assert.match(r.headers.Location, /^https:\/\/example\.test\/sign\//);
        assert.equal(r.headers["Cache-Control"], `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
    }
    const before = store.calls.signedUrl;
    assert.equal((await readQuestionMedia(ANON, p, store)).status, 401);
    for (const role of ["qbg_user", "video_user", "qwv_user", "custom"]) assert.equal((await readQuestionMedia(as(role), p, store)).status, 403, role);
    assert.equal(store.calls.signedUrl, before, "no signed URL is created for a refused caller");
    assert.equal((await readQuestionMedia(as("viewer"), `newbank/${Q}/../../x.png`, store)).status, 400);
    assert.equal((await readQuestionMedia(as("viewer"), `newbank/${Q}/missing-000000000000.png`, store)).status, 404);
    const broken = Object.assign(new MemStore(), { signedUrl: async () => ({ error: "boom" }) });
    assert.equal((await readQuestionMedia(as("viewer"), p, broken)).status, 502);
});

// -------------------------------------------------------- upload route ---

test("upload: creators/editors may upload; everyone else is refused before storage is touched", async () => {
    for (const role of ["data_entry", "manager", "admin", "qc_reviewer"]) {
        const r = await upload(as(role), new MemStore());
        assert.equal(r.status, 201, role);
        assert.equal(r.body.status, "uploaded");
    }
    for (const [caller, code] of [[ANON, 401], [as("viewer"), 403], [as("ai_user"), 403], [as("qbg_user"), 403], [as("custom"), 403]]) {
        const store = new MemStore();
        assert.equal((await upload(caller, store)).status, code);
        assert.deepEqual(store.calls, { signedUrl: 0, upload: 0, download: 0, questionExists: 0 });
    }
});

test("upload: response carries a deterministic path, the src, and source metadata", async () => {
    const store = new MemStore();
    const r = await upload(as("data_entry"), store, PNG, "C:\\scans\\Fig 1.png");
    const h = await sha256Hex(PNG);
    assert.equal(r.body.path, `newbank/${Q}/Fig-1-${h.slice(0, 12)}.png`);
    assert.equal(r.body.src, `/api/question-media/${r.body.path}`);
    assert.equal(r.body.original_name, "Fig 1.png");
    assert.deepEqual([r.body.sha256, r.body.bytes, r.body.mime], [h, PNG.length, "image/png"]);
    assert.ok(!String(r.body.src).startsWith("http"), "no public or signed URL is returned for storage in HTML");
});

test("upload: retry is idempotent, different content gets a new path, nothing is ever overwritten", async () => {
    const store = new MemStore();
    const first = await upload(as("data_entry"), store);
    const retry = await upload(as("data_entry"), store);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "already_exists");
    assert.equal(retry.body.path, first.body.path);
    assert.equal(store.objects.size, 1);

    const other = await upload(as("data_entry"), store, JPEG, "Fig 1.jpg", "image/jpeg");
    assert.equal(other.status, 201);
    assert.notEqual(other.body.path, first.body.path);
    assert.equal(store.objects.size, 2);

    // a foreign object squatting on the exact path: 409, and it stays untouched
    const squat = new MemStore();
    const target = first.body.path;
    squat.objects.set(target, Buffer.from("not the same bytes"));
    const r = await upload(as("data_entry"), squat);
    assert.equal(r.status, 409);
    assert.equal(squat.objects.get(target).toString(), "not the same bytes");
});

test("upload: invalid type, size, question id and unknown question are refused without writing", async () => {
    const cases = [
        [SVG, "x.svg", "image/svg+xml", Q, 415],
        [PDF, "x.pdf", "application/pdf", Q, 415],
        [PNG, "x.jpg", "image/jpeg", Q, 415],
        [Buffer.concat([PNG, Buffer.alloc(QUESTION_MEDIA_MAX_BYTES)]), "big.png", "image/png", Q, 413],
        [Buffer.alloc(0), "empty.png", "image/png", Q, 400],
        [PNG, "x.png", "image/png", Q.toUpperCase(), 400],
        [PNG, "x.png", "image/png", "not-a-uuid", 400],
        [PNG, "x.png", "image/png", "99999999-9999-4999-8999-999999999999", 404],
    ];
    for (const [bytes, name, mime, qid, code] of cases) {
        const store = new MemStore();
        const r = await upload(as("data_entry"), store, bytes, name, mime, qid);
        assert.equal(r.status, code, `${name} ${qid}`);
        assert.equal(store.calls.upload, 0, `${name}: storage untouched`);
    }
});
