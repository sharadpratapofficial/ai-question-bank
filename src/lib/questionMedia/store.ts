/**
 * SERVER-ONLY Supabase implementation of the question-media MediaStore.
 *
 * A caller with a real session goes through their own cookie client, so the
 * storage policies from 003 (read / insert, no update / delete) apply on top of
 * the route's permission check. Only the dev-auth bypass (never honoured in a
 * production build) has no session; like the rest of the app it then uses the
 * server-only secret-key client after the route's permission check. An
 * unauthenticated caller never gets a client at all.
 */
import { NextResponse } from "next/server";
import type { CurrentUserContext } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { QUESTION_MEDIA_BUCKET, type MediaResult, type MediaStore } from "./core";

interface StorageErrorLike {
    message?: string;
    status?: number;
    statusCode?: string | number;
}

const statusOf = (e: StorageErrorLike) => String(e?.statusCode ?? e?.status ?? "");
const isNotFound = (e: StorageErrorLike) => statusOf(e) === "404" || /not.?found|does not exist/i.test(e?.message ?? "");
const isAlreadyExists = (e: StorageErrorLike) => statusOf(e) === "409" || /already exists|duplicate/i.test(e?.message ?? "");

export function questionMediaStore(ctx: CurrentUserContext): MediaStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any = null;
    const db = async () => {
        if (client) return client;
        if (ctx.userId) client = await createClient();
        else if (ctx.isDevAuth) client = getSupabaseAdmin();
        else throw new Error("question-media: no authenticated caller");
        return client;
    };
    const bucket = async () => (await db()).storage.from(QUESTION_MEDIA_BUCKET);

    return {
        async signedUrl(path, ttlSeconds) {
            const { data, error } = await (await bucket()).createSignedUrl(path, ttlSeconds);
            if (error) return isNotFound(error) ? { notFound: true as const } : { error: String(error.message ?? error) };
            return data?.signedUrl ? { url: data.signedUrl as string } : { notFound: true as const };
        },
        async upload(path, bytes, mime) {
            const { error } = await (await bucket()).upload(path, bytes, { contentType: mime, upsert: false, cacheControl: "31536000" });
            if (!error) return "uploaded";
            if (isAlreadyExists(error)) return "exists";
            throw new Error(`question-media upload failed: ${error.message ?? error}`);
        },
        async download(path) {
            const { data, error } = await (await bucket()).download(path);
            if (error) {
                if (isNotFound(error)) return null;
                throw new Error(`question-media download failed: ${error.message ?? error}`);
            }
            return new Uint8Array(await data.arrayBuffer());
        },
        async questionExists(questionId) {
            const { data, error } = await (await db()).from("qbg_questions").select("question_id").eq("question_id", questionId).maybeSingle();
            if (error) throw new Error(`question lookup failed: ${error.message}`);
            return Boolean(data);
        },
    };
}

export function toNextResponse(r: MediaResult): NextResponse {
    if (r.status >= 300 && r.status < 400) return new NextResponse(null, { status: r.status, headers: r.headers });
    return NextResponse.json(r.body ?? {}, { status: r.status, headers: r.headers });
}
