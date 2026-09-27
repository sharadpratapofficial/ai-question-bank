/**
 * Local image resolution for the NEW question-bank importer.
 *
 * Turns an <img src> in the input into a question-media object:
 *   media:<relative path>        a file under --media-dir
 *   data:image/...;base64,...    an inline image (converted unless --keep-inline-images)
 * Reads and validates the bytes LOCALLY only (type by magic bytes, size, extension);
 * never uploads. Upload happens in plan.mjs applyDecisions(), only with --apply.
 *
 * Naming, paths and validation come from the app's own rules
 * (src/lib/questionMedia/core.ts), loaded with Node's TypeScript type stripping.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateMediaBytes, mediaFileName, mediaStoragePath, mediaSrc } from "../../../src/lib/questionMedia/core.ts";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i;

/**
 * Returns resolve(src, { questionId, field, inlineIndex }) ->
 *   { kind: "none" }                               not an image reference this resolver handles
 *   { kind: "keep" }                               inline image kept as-is (--keep-inline-images)
 *   { kind: "media", src, record, upload }         rewritten src + provenance + upload job
 *   { kind: "error", error }
 */
export function createMediaResolver({ mediaDir = null, keepInline = false } = {}) {
    let root = null;
    if (mediaDir) {
        const abs = path.resolve(mediaDir);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`--media-dir ${mediaDir} is not a directory`);
        root = fs.realpathSync(abs);
    }
    const cache = new Map(); // real path -> Buffer

    function fromBytes(bytes, originalName, declaredMime, { questionId, field }, source) {
        const check = validateMediaBytes(bytes, originalName, declaredMime);
        if (!check.ok) return { kind: "error", error: `${field}: ${source}: ${check.error}` };
        const hash = sha256(bytes);
        const fileName = mediaFileName(originalName, hash, check.kind);
        const storagePath = mediaStoragePath(questionId, fileName);
        return {
            kind: "media",
            src: mediaSrc(storagePath),
            record: { field, source, original_name: path.basename(originalName), file_name: fileName, storage_path: storagePath, sha256: hash, bytes: bytes.length, mime: check.mime },
            upload: { storage_path: storagePath, sha256: hash, bytes: bytes.length, mime: check.mime, load: () => bytes },
        };
    }

    return function resolve(src, ctx) {
        if (/^media:/i.test(src)) {
            const rel = src.slice(6).trim().replace(/\\/g, "/");
            if (!root) return { kind: "error", error: `${ctx.field}: ${src} needs --media-dir=<folder containing the image files>` };
            if (!rel || rel.startsWith("/") || /^[a-z]:/i.test(rel) || rel.split("/").some((s) => s === ".." || s === "")) {
                return { kind: "error", error: `${ctx.field}: ${src}: must be a relative path inside --media-dir` };
            }
            const full = path.resolve(root, rel);
            let real;
            try { real = fs.realpathSync(full); } catch { return { kind: "error", error: `${ctx.field}: ${src}: file not found in --media-dir` }; }
            if (!real.startsWith(root + path.sep)) return { kind: "error", error: `${ctx.field}: ${src}: resolves outside --media-dir` };
            const st = fs.statSync(real);
            if (!st.isFile()) return { kind: "error", error: `${ctx.field}: ${src}: not a file` };
            let bytes = cache.get(real);
            if (!bytes) {
                // size check before reading the whole file
                if (st.size > 10 * 1024 * 1024) return { kind: "error", error: `${ctx.field}: ${src}: ${st.size} bytes exceeds the 10 MB limit` };
                bytes = fs.readFileSync(real);
                cache.set(real, bytes);
            }
            return fromBytes(bytes, rel, null, ctx, rel);
        }
        const m = src.match(DATA_URL_RE);
        if (m && /^image\//i.test(m[1])) {
            if (keepInline) return { kind: "keep" };
            const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
            const kindByMime = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" }[m[1].toLowerCase()];
            const name = `inline-${ctx.inlineIndex}${kindByMime ? "." + kindByMime : ""}`;
            return fromBytes(bytes, name, m[1], ctx, `inline data URL #${ctx.inlineIndex}`);
        }
        return { kind: "none" };
    };
}
