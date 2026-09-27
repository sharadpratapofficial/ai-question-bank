import { createClient as createBrowserSessionClient } from "@/lib/supabase/client";
import type { QuestionTranslation } from "@/types";

const TABLE = "question_translations";

/**
 * This module runs in two places:
 *   - the browser (QuestionEditModal, tests page): uses the signed-in user's
 *     cookie session, so Row Level Security applies to that user;
 *   - the server (test generation / history): uses the client registered via
 *     registerServerTranslationsClient() by those server modules (the
 *     server-only admin client). It is injected rather than imported so this
 *     browser-reachable module never references the secret-key module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverClientFactory: (() => any) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browserClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerServerTranslationsClient(factory: () => any): void {
    serverClientFactory = factory;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSupabase(): any {
    if (typeof window !== "undefined") {
        if (!browserClient) browserClient = createBrowserSessionClient();
        return browserClient;
    }
    if (!serverClientFactory) {
        throw new Error("translations: no server client registered (call registerServerTranslationsClient from a server module).");
    }
    return serverClientFactory();
}

function normaliseLanguage(value: string): string {
    return value.trim().toLowerCase();
}

/** All translations (every version) for a single question, ordered newest first. */
export async function fetchTranslationsForQuestion(
    questionId: string
): Promise<QuestionTranslation[]> {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("question_id", questionId)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("fetchTranslationsForQuestion failed:", error);
        return [];
    }
    return (data as QuestionTranslation[]) ?? [];
}

/** Default translations only, for a set of question_ids in a target language. */
export async function fetchDefaultTranslations(
    questionIds: string[],
    language: string
): Promise<Map<string, QuestionTranslation>> {
    const map = new Map<string, QuestionTranslation>();
    if (questionIds.length === 0) return map;
    const lang = normaliseLanguage(language);
    if (!lang || lang === "english") return map;

    const supabase = getSupabase();
    // Supabase has a ~1000-element cap on .in() — chunk for safety.
    const CHUNK = 500;
    for (let i = 0; i < questionIds.length; i += CHUNK) {
        const slice = questionIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
            .from(TABLE)
            .select("*")
            .eq("language", lang)
            .eq("is_default", true)
            .in("question_id", slice);
        if (error) {
            console.error("fetchDefaultTranslations failed:", error);
            continue;
        }
        (data as QuestionTranslation[]).forEach((row) => {
            map.set(row.question_id, row);
        });
    }
    return map;
}

/**
 * Return question_ids that have a default translation in the given language.
 * Used to restrict the candidate pool when generating a test in a language.
 */
export async function fetchQuestionIdsWithDefaultTranslation(
    language: string
): Promise<Set<string>> {
    const set = new Set<string>();
    const lang = normaliseLanguage(language);
    if (!lang || lang === "english") return set;

    const supabase = getSupabase();
    // Paginate to bypass the 1000-row default limit.
    const PAGE = 1000;
    let from = 0;
    while (true) {
        const to = from + PAGE - 1;
        const { data, error } = await supabase
            .from(TABLE)
            .select("question_id")
            .eq("language", lang)
            .eq("is_default", true)
            .range(from, to);
        if (error) {
            console.error("fetchQuestionIdsWithDefaultTranslation failed:", error);
            break;
        }
        const rows = (data as { question_id: string }[]) ?? [];
        rows.forEach((r) => set.add(r.question_id));
        if (rows.length < PAGE) break;
        from += PAGE;
    }
    return set;
}

/** Distinct languages that have at least one default translation in the system. */
export async function fetchAvailableLanguages(): Promise<string[]> {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(TABLE)
        .select("language")
        .eq("is_default", true);
    if (error) {
        console.error("fetchAvailableLanguages failed:", error);
        return [];
    }
    const langs = new Set<string>();
    (data as { language: string }[]).forEach((r) => {
        if (r.language) langs.add(normaliseLanguage(r.language));
    });
    return [...langs].sort();
}

/**
 * Mark a translation as the default version for its (question, language).
 * The DB trigger handles flipping the previous default to false.
 */
export async function setTranslationAsDefault(translationId: string): Promise<void> {
    const supabase = getSupabase();
    const { error } = await supabase
        .from(TABLE)
        .update({ is_default: true })
        .eq("id", translationId);
    if (error) {
        throw new Error(`Failed to set default translation: ${error.message}`);
    }
}

/** Delete a translation row. RLS only allows the original translator to delete. */
export async function deleteTranslation(translationId: string): Promise<void> {
    const supabase = getSupabase();
    const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq("id", translationId);
    if (error) {
        throw new Error(`Failed to delete translation: ${error.message}`);
    }
}
