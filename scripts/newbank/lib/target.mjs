/**
 * Database + storage access for the NEW question-bank importer. Only these calls touch
 * Supabase. supabase-js is loaded lazily so an offline dry run never imports it.
 */
import { QUESTION_MEDIA_BUCKET } from "../../../src/lib/questionMedia/core.ts";

const SELECT_COLUMNS = "question_id,qbg_id,question_text,options,answer_key,solution_text,question_type,subject,chapter,topic,subtopic,source,difficutly_level,class_level,exam,parent_question_id,child_order,raw_data,status";
const CHUNK = 100;

export function projectRefFromUrl(url) {
    return (url || "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i)?.[1] ?? null;
}

export async function supabaseTarget({ url, key }) {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const byChunks = async (values, fn) => {
        const out = [];
        for (let i = 0; i < values.length; i += CHUNK) out.push(...(await fn(values.slice(i, i + CHUNK))));
        return out;
    };
    return {
        async fetchByIds(ids) {
            const rows = await byChunks([...new Set(ids)], async (c) => {
                const { data, error } = await db.from("qbg_questions").select(SELECT_COLUMNS).in("question_id", c);
                if (error) throw new Error(`read qbg_questions: ${error.message}`);
                return data;
            });
            return new Map(rows.map((r) => [r.question_id, r]));
        },
        async fetchByQbgIds(qbgIds) {
            return byChunks([...new Set(qbgIds)], async (c) => {
                const { data, error } = await db.from("qbg_questions").select("question_id,qbg_id").in("qbg_id", c);
                if (error) throw new Error(`read qbg_questions: ${error.message}`);
                return data;
            });
        },
        async userExists(userId) {
            const { data, error } = await db.from("user_profiles").select("user_id").eq("user_id", userId).maybeSingle();
            if (error) throw new Error(`read user_profiles: ${error.message}`);
            return !!data;
        },
        async insert(rows) {
            const { error } = await db.from("qbg_questions").insert(rows);
            if (error) throw new Error(error.message);
        },
        async update(questionId, patch) {
            const { error } = await db.from("qbg_questions").update(patch).eq("question_id", questionId);
            if (error) throw new Error(error.message);
        },
        /** Never overwrites (upsert: false). Resolves "uploaded" or "exists". */
        async uploadMedia(storagePath, bytes, mime) {
            const { error } = await db.storage.from(QUESTION_MEDIA_BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: false, cacheControl: "31536000" });
            if (!error) return "uploaded";
            if (isAlreadyExists(error)) return "exists";
            throw new Error(`upload ${storagePath}: ${error.message}`);
        },
        /** Buffer, or null when there is no object at the path. */
        async downloadMedia(storagePath) {
            const { data, error } = await db.storage.from(QUESTION_MEDIA_BUCKET).download(storagePath);
            if (error) {
                if (isNotFound(error)) return null;
                throw new Error(`download ${storagePath}: ${error.message}`);
            }
            return Buffer.from(await data.arrayBuffer());
        },
    };
}

const statusOf = (e) => String(e?.statusCode ?? e?.status ?? "");
const isNotFound = (e) => statusOf(e) === "404" || /not.?found|does not exist/i.test(e?.message ?? "");
const isAlreadyExists = (e) => statusOf(e) === "409" || /already exists|duplicate/i.test(e?.message ?? "");
