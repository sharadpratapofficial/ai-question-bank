import { NextRequest, NextResponse } from "next/server";
import type { GeneratedTest } from "@/types";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const TESTS_TABLE = "qbg_generated_tests";

interface SavePayload {
    testIds: string[];
    language: string;
    translatedTest: GeneratedTest;
    notes?: string;
}

function getSupabase() {
    return getSupabaseAdmin();
}

/**
 * Persists a fully-translated test JSON onto qbg_generated_tests.output_config.aiTestTranslations[language]
 * so the user can come back and re-download a previously translated test.
 */
export async function POST(req: NextRequest) {
    const forbid = await checkPermission("generate_tests");
    if (forbid) return forbid;
    try {
        const body = (await req.json()) as Partial<SavePayload>;
        const testIds = Array.isArray(body.testIds) ? body.testIds.filter(Boolean) : [];
        const language = (body.language || "").trim().toLowerCase();
        if (testIds.length === 0) {
            return NextResponse.json({ success: false, error: "testIds is required." }, { status: 400 });
        }
        if (!language) {
            return NextResponse.json({ success: false, error: "language is required." }, { status: 400 });
        }
        if (!body.translatedTest) {
            return NextResponse.json({ success: false, error: "translatedTest is required." }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: rows, error: readError } = await supabase
            .from(TESTS_TABLE)
            .select("id, output_config")
            .in("id", testIds);

        if (readError) {
            return NextResponse.json(
                { success: false, error: `Failed to load tests: ${readError.message}` },
                { status: 500 }
            );
        }

        for (const row of (rows as Array<{ id: string; output_config?: unknown }>) || []) {
            const current = (row.output_config && typeof row.output_config === "object"
                ? (row.output_config as Record<string, unknown>)
                : {}) as Record<string, unknown>;
            const previous =
                (current.aiTestTranslations && typeof current.aiTestTranslations === "object"
                    ? (current.aiTestTranslations as Record<string, unknown>)
                    : {}) as Record<string, unknown>;
            const next = {
                ...current,
                aiTestTranslations: {
                    ...previous,
                    [language]: {
                        language,
                        notes: body.notes || "",
                        translatedTest: body.translatedTest,
                        savedAt: new Date().toISOString(),
                    },
                },
            };
            const { error: updateError } = await supabase
                .from(TESTS_TABLE)
                .update({ output_config: next })
                .eq("id", row.id);
            if (updateError) {
                return NextResponse.json(
                    { success: false, error: `Failed to update test ${row.id}: ${updateError.message}` },
                    { status: 500 }
                );
            }
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
