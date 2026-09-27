/**
 * POST /api/qbg/pipeline/plan-availability
 *
 * How many pool questions exist for each slot of a manual paper plan.
 *
 * This is what makes the manual planner usable: a slot showing 0 can be fixed by
 * changing its topic, difficulty or source BEFORE the run, instead of the run
 * finishing short and explaining why in a warning. Batches the user is avoiding
 * are excluded here too, so the number shown is what is genuinely selectable.
 *
 * Body: { slots: [{subject, chapter, topic, difficulty, questionType, source}],
 *         classLevels?, categoryName?, avoidBatchNames?,
 *         hasVideoSolution?, hasTextSolution? }
 * Returns: { success, counts: number[] } — aligned with the input slots.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const POOL_TABLE = "qbg_question_pool";
/** The pool table's own spelling — NOT qbg_questions' `difficutly_level`. */
const COL_DIFFICULTY = "difficulty_level";

interface SlotQuery {
    subject?: string;
    chapter?: string;
    topic?: string | null;
    difficulty?: string | null;
    questionType?: string;
    source?: string | null;
}

interface Body {
    slots?: SlotQuery[];
    classLevels?: string[];
    categoryName?: string;
    avoidBatchNames?: string[];
    hasVideoSolution?: boolean;
    hasTextSolution?: boolean;
}

function db() {
    return getSupabaseAdmin();
}

/**
 * Difficulty as the SELECTOR buckets it, not as the column spells it.
 *
 * qbg_question_pool.difficulty_level holds Easy / Medium / Difficult / Hard /
 * Testing / "0" / NULL, and pickQuestionsFromPool folds everything that is not
 * Easy or Difficult/Hard into Medium — including the 14,863 NULL rows. Counting
 * only the literal "Medium" here would have told the user a slot had a third of
 * the candidates it really has.
 */
function applyDifficulty<T extends { eq: (c: string, v: unknown) => T; in: (c: string, v: unknown[]) => T; or: (f: string) => T }>(
    q: T,
    d: string | null | undefined
): T {
    const v = (d || "").trim();
    if (!v) return q;
    if (v === "Easy") return q.eq(COL_DIFFICULTY, "Easy");
    if (v === "Hard" || v === "Difficult") return q.in(COL_DIFFICULTY, ["Hard", "Difficult"]);
    return q.or(`${COL_DIFFICULTY}.is.null,${COL_DIFFICULTY}.not.in.(Easy,Difficult,Hard)`);
}

/** Question-type aliases, mirroring questionTypeAliases() in the selector. */
function typeAliases(t: string | null | undefined): string[] {
    const v = (t || "").trim();
    if (!v) return [];
    const normalized = v.toLowerCase();
    if (normalized === "integer") return ["Integer", "Numerical", "Single_Digit_Integer"];
    if (normalized === "single_digit_integer") return ["Single_Digit_Integer", "Numerical", "Integer"];
    return [v];
}

/**
 * Distinct slot signature — several slots usually share one combination, and one
 * COUNT query per distinct combination keeps a 75-question plan at a handful of
 * round trips instead of 75.
 */
function signature(s: SlotQuery, body: Body): string {
    return JSON.stringify([
        s.subject || "",
        s.chapter || "",
        s.topic || "",
        s.difficulty || "",
        s.questionType || "",
        s.source || "",
        body.classLevels || [],
        body.categoryName || "",
        body.hasVideoSolution || false,
        body.hasTextSolution || false,
    ]);
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("use_qbg");
    if (forbid) return forbid;

    try {
        const body = (await req.json()) as Body;
        const slots = Array.isArray(body.slots) ? body.slots : [];
        if (slots.length === 0) {
            return NextResponse.json({ success: true, counts: [] });
        }
        if (slots.length > 500) {
            return NextResponse.json(
                { success: false, error: "Too many slots in one request (max 500)." },
                { status: 400 }
            );
        }

        const avoid = (body.avoidBatchNames || []).filter(Boolean);
        const cache = new Map<string, number>();

        const counts: number[] = [];
        for (const slot of slots) {
            const key = signature(slot, body);
            const hit = cache.get(key);
            if (hit !== undefined) {
                counts.push(hit);
                continue;
            }

            // With an avoid-list we need the rows themselves (used_in_exam is an
            // array column that cannot be filtered server-side here); without one
            // a HEAD count is enough and far cheaper.
            let q = db()
                .from(POOL_TABLE)
                .select(avoid.length ? "unique_id, used_in_exam" : "unique_id", {
                    count: "exact",
                    head: !avoid.length,
                })
                .is("parent_question_id", null);

            if (slot.subject) q = q.eq("subject", slot.subject);
            if (slot.chapter) q = q.eq("chapter", slot.chapter);
            if (slot.topic) q = q.eq("topic", slot.topic);
            if (slot.source) q = q.eq("source", slot.source);
            q = applyDifficulty(q, slot.difficulty);
            const types = typeAliases(slot.questionType);
            if (types.length) q = q.in("question_type", types);
            if (body.classLevels?.length) q = q.in("class_level", body.classLevels);
            if (body.categoryName) q = q.eq("category_name", body.categoryName);
            if (body.hasVideoSolution) q = q.eq("has_video_solution", true);
            if (body.hasTextSolution) q = q.eq("has_text_solution", true);

            let value = 0;
            if (avoid.length) {
                // used_in_exam is an array column, so the avoid-list has to be
                // applied in JS. Capped: the number only has to be right enough to
                // tell "plenty" from "none".
                const { data, error } = await q.limit(2000);
                if (error) throw new Error(error.message);
                const rows =
                    (data as unknown as { unique_id: string; used_in_exam?: string[] }[]) || [];
                const avoidSet = new Set(avoid);
                value = rows.filter((r) => !(r.used_in_exam || []).some((b) => avoidSet.has(b))).length;
            } else {
                const { count, error } = await q;
                if (error) throw new Error(error.message);
                value = count ?? 0;
            }

            cache.set(key, value);
            counts.push(value);
        }

        return NextResponse.json({ success: true, counts });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
