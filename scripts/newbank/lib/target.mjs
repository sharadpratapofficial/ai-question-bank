/**
 * Database access for the NEW question-bank importer. Only these five calls touch
 * Supabase. supabase-js is loaded lazily so an offline dry run never imports it.
 */
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
    };
}
