/**
 * GET  /api/admin/chapters  — every chapter with its question counts, plus the
 *      duplicate groups detected by spelling-insensitive matching.
 * POST /api/admin/chapters  — merge one or more chapter spellings into a chosen
 *      canonical name across both question tables.
 *
 * This exists because the same chapter kept arriving under several spellings
 * ("Work, Energy and Power" vs "Work Energy and Power", "&" vs "and", p-Block vs
 * P-Block), which splits a chapter's questions in every picker and every
 * distribution. Rather than fixing those by hand in SQL each time, an admin can
 * resolve them here, and every merge is written to chapter_merge_log.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission, getCurrentUserWithRole } from "@/lib/auth/serverAuth";
import { chapterKey } from "@/lib/chapterOrder";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const TABLES = ["qbg_question_pool", "qbg_questions"] as const;

function db() {
    return getSupabaseAdmin();
}

export interface ChapterRow {
    subject: string | null;
    chapter: string;
    classLevels: string[];
    pool: number;
    questions: number;
    total: number;
}

export interface DuplicateGroup {
    key: string;
    subject: string | null;
    /** Highest-count spelling first — the suggested canonical name. */
    variants: ChapterRow[];
    total: number;
}

/** Page through a table collecting chapter/subject/class counts. */
async function collect(table: string): Promise<Map<string, ChapterRow>> {
    const out = new Map<string, ChapterRow>();
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await db()
            .from(table)
            .select("subject, chapter, class_level")
            .not("chapter", "is", null)
            .order("chapter", { ascending: true })
            .range(offset, offset + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data as { subject: string | null; chapter: string | null; class_level: string | null }[]) {
            const chapter = (r.chapter || "").trim();
            if (!chapter) continue;
            const id = `${r.subject || ""}||${chapter}`;
            const row = out.get(id) || {
                subject: r.subject,
                chapter,
                classLevels: [],
                pool: 0,
                questions: 0,
                total: 0,
            };
            if (table === "qbg_question_pool") row.pool += 1;
            else row.questions += 1;
            row.total += 1;
            if (r.class_level && !row.classLevels.includes(r.class_level)) row.classLevels.push(r.class_level);
            out.set(id, row);
        }
        if (data.length < PAGE) break;
    }
    return out;
}

export async function GET() {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    try {
        const merged = new Map<string, ChapterRow>();
        for (const t of TABLES) {
            const part = await collect(t);
            for (const [id, row] of part) {
                const existing = merged.get(id);
                if (!existing) {
                    merged.set(id, row);
                    continue;
                }
                existing.pool += row.pool;
                existing.questions += row.questions;
                existing.total += row.total;
                for (const c of row.classLevels) {
                    if (!existing.classLevels.includes(c)) existing.classLevels.push(c);
                }
            }
        }

        const chapters = [...merged.values()].sort((a, b) => b.total - a.total);

        // Group by spelling-insensitive key, within a subject.
        const groups = new Map<string, ChapterRow[]>();
        for (const c of chapters) {
            const k = `${c.subject || ""}||${chapterKey(c.chapter)}`;
            groups.set(k, [...(groups.get(k) || []), c]);
        }
        const duplicates: DuplicateGroup[] = [...groups.entries()]
            .filter(([, v]) => v.length > 1)
            .map(([k, v]) => ({
                key: k,
                subject: v[0].subject,
                variants: [...v].sort((a, b) => b.total - a.total),
                total: v.reduce((s, x) => s + x.total, 0),
            }))
            .sort((a, b) => b.total - a.total);

        return NextResponse.json({ success: true, chapters, duplicates });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}

interface MergeBody {
    /** Spellings to rename away. */
    from?: string[];
    /** The spelling to keep. */
    to?: string;
    /** Restrict to one subject; omit to merge across every subject. */
    subject?: string | null;
}

export async function POST(req: NextRequest) {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;

    let body: MergeBody;
    try {
        body = (await req.json()) as MergeBody;
    } catch {
        return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
    }

    const to = (body.to || "").trim();
    const from = (body.from || []).map((f) => (f || "").trim()).filter((f) => f && f !== to);
    if (!to || from.length === 0) {
        return NextResponse.json(
            { success: false, error: "Provide `to` (the spelling to keep) and at least one different `from`." },
            { status: 400 }
        );
    }

    const { email } = await getCurrentUserWithRole();
    const changed: { table: string; from: string; rows: number }[] = [];

    try {
        for (const table of TABLES) {
            for (const f of from) {
                let q = db().from(table).update({ chapter: to }).eq("chapter", f);
                if (body.subject) q = q.eq("subject", body.subject);
                // Each table's own primary key — qbg_questions has no unique_id.
                const { data, error } = await q.select(
                    table === "qbg_question_pool" ? "unique_id" : "question_id"
                );
                if (error) {
                    return NextResponse.json(
                        { success: false, error: `Merge failed on ${table}: ${error.message}` },
                        { status: 500 }
                    );
                }
                const rows = (data || []).length;
                if (rows > 0) {
                    changed.push({ table, from: f, rows });
                    await db().from("chapter_merge_log").insert({
                        table_name: table,
                        subject: body.subject ?? null,
                        from_chapter: f,
                        to_chapter: to,
                        rows_changed: rows,
                        merged_by: email || "admin",
                    });
                }
            }
        }
        const total = changed.reduce((s, c) => s + c.rows, 0);
        return NextResponse.json({ success: true, to, changed, totalRows: total });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
