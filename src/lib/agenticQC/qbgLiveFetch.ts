/**
 * Live QBG (PenPencil) question fetch for Agentic QC's "QBG IDs" input mode.
 *
 * The same live bulk endpoint qbg.py's `get_bulk_questions()` uses — POST a list
 * of `unique_id`s, get back each question in the exact content / bilingual_options
 * / solutions / answer JSON shape the `qbg_question_pool` table stores. That means
 * every returned question maps 1:1 onto `PoolQuestion`, so the existing
 * `adaptPoolRowsToParsedQuestions()` (used by the QBG Pipeline's QC stage) turns
 * them into the same `ParsedQuestion[]` a CSV/Excel upload produces — no new
 * parsing logic, just a different way to obtain the rows.
 *
 * Credentials (Bearer token + `user` / `user-id` headers) are the user's saved
 * QBG creds, resolved server-side by the caller (the qbg-fetch route) — never
 * from the browser.
 */
import type { PoolQuestion } from "@/lib/api/qbgPoolSelection";

/** QBG REST credentials — same shape as userApiKeys.QbgProviderConfig. */
export interface QbgCreds {
    token: string;
    user: string;
    userId: string;
}

// Same constants qbg.py sends (python/qbg_modification/qbg.py).
const BULK_URL = "https://api.penpencil.co/qbg/questions/get-bulk-questions";
const ORG_ID = "5eb393ee95fab7468a79d189";
// Send in comfortably-sized batches rather than one giant POST for a long id list.
const BULK_CHUNK = 100;

function headers(creds: QbgCreds): Record<string, string> {
    const tok = creds.token.trim();
    return {
        "Content-Type": "application/json",
        "client-type": "QBG",
        "organization-id": ORG_ID,
        authorization: tok && !/^bearer /i.test(tok) ? `Bearer ${tok}` : tok,
        user: creds.user,
        "user-id": creds.userId,
    };
}

/** One question dict as returned by QBG's bulk endpoint (only the fields the
 *  pool adapter reads are typed; the rest are ignored). */
interface QbgApiQuestion {
    unique_id?: string;
    content?: { english?: string } | null;
    bilingual_options?: { english?: { isCorrect: boolean | null; text: string | null }[] } | null;
    solutions?: { english?: { text?: string } }[] | null;
    bilingual_solutions?: unknown;
    answer?: { english?: string } | null;
    is_int_answer?: boolean | null;
    is_range_numerical?: boolean | null;
    difficulty?: number | null;
    subject?: string | null;
    chapter?: string | null;
    topic?: string | null;
    subtopic?: string | null;
    class_level?: string | null;
    slug?: string | null;
    [k: string]: unknown;
}

// Every PoolQuestion field defaults to null — the QBG bulk response only carries
// the content/answer/taxonomy subset the adapter actually reads, so the rest are
// filled in so the object still satisfies the PoolQuestion type.
const POOL_ROW_DEFAULTS: Omit<PoolQuestion, "unique_id"> = {
    qbg_id: null,
    question_type: null,
    difficulty_level: null,
    difficulty: null,
    source: null,
    subject: null,
    chapter: null,
    topic: null,
    subtopic: null,
    class_level: null,
    category_name: null,
    used_in_exam: null,
    has_video_solution: null,
    has_text_solution: null,
    verification_status: null,
    is_int_answer: null,
    is_range_numerical: null,
    exam_year: null,
    qc_status: null,
    content: null,
    bilingual_options: null,
    solutions: null,
    bilingual_solutions: null,
    answer: null,
    concept_tags: null,
    readiness_tags: null,
    x_category_tags: null,
    languages: null,
    exam_details: null,
    sources: null,
    child_questions: null,
    link: null,
    slug: null,
    parent_question_id: null,
    organization_id: null,
    category_configuration_id: null,
};

function toPoolRow(d: QbgApiQuestion): PoolQuestion {
    return {
        ...POOL_ROW_DEFAULTS,
        unique_id: String(d.unique_id || ""),
        content: d.content ?? null,
        bilingual_options: d.bilingual_options ?? null,
        solutions: d.solutions ?? null,
        bilingual_solutions: d.bilingual_solutions ?? null,
        answer: d.answer ?? null,
        is_int_answer: d.is_int_answer ?? null,
        is_range_numerical: d.is_range_numerical ?? null,
        difficulty: typeof d.difficulty === "number" ? d.difficulty : null,
        subject: d.subject ?? null,
        chapter: d.chapter ?? null,
        topic: d.topic ?? null,
        subtopic: d.subtopic ?? null,
        class_level: d.class_level ?? null,
        slug: d.slug ?? null,
    };
}

async function fetchChunk(ids: string[], creds: QbgCreds): Promise<QbgApiQuestion[]> {
    const res = await fetch(BULK_URL, {
        method: "POST",
        headers: headers(creds),
        body: JSON.stringify({ uniqueIds: ids }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`QBG bulk fetch HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const payload = await res.json();
    // Response is `[{ error, message, data: [...] }]` (or the same object un-wrapped).
    const block = Array.isArray(payload) ? payload[0] : payload;
    if (!block || typeof block !== "object") {
        throw new Error(`QBG bulk fetch: unexpected response shape.`);
    }
    if ((block as { error?: unknown }).error) {
        throw new Error(`QBG error: ${String((block as { message?: unknown }).message ?? "unknown")}`);
    }
    const data = (block as { data?: unknown }).data;
    return Array.isArray(data) ? (data as QbgApiQuestion[]) : [];
}

/**
 * Fetch QBG questions by unique_id from the live API, mapped to `PoolQuestion[]`
 * (feed straight into `adaptPoolRowsToParsedQuestions`). Returns the rows in the
 * SAME order the ids were given (missing ones omitted), plus the ids QBG didn't
 * return so the caller can surface them.
 */
export async function fetchQbgPoolRowsByIds(
    ids: string[],
    creds: QbgCreds
): Promise<{ rows: PoolQuestion[]; missingIds: string[] }> {
    const cleanIds = ids.map((s) => s.trim()).filter(Boolean);
    if (cleanIds.length === 0) return { rows: [], missingIds: [] };

    const byId = new Map<string, QbgApiQuestion>();
    for (let i = 0; i < cleanIds.length; i += BULK_CHUNK) {
        const chunk = cleanIds.slice(i, i + BULK_CHUNK);
        const fetched = await fetchChunk(chunk, creds);
        for (const d of fetched) {
            if (d.unique_id) byId.set(String(d.unique_id), d);
        }
    }

    const rows: PoolQuestion[] = [];
    const missingIds: string[] = [];
    for (const id of cleanIds) {
        const d = byId.get(id);
        if (d) rows.push(toPoolRow(d));
        else missingIds.push(id);
    }
    return { rows, missingIds };
}
