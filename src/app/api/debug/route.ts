import { NextResponse } from "next/server";
import { sortChaptersForSubject } from "@/lib/chapterOrder";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkPermission } from "@/lib/auth/serverAuth";

const TABLE_NAME = "qbg_questions";

// Diagnostic dump of the question table. Uses the server-only client, so it is
// admin-only (it previously had no gate at all).
export async function GET() {
    const forbid = await checkPermission("manage_users");
    if (forbid) return forbid;
    const supabase = getSupabaseAdmin();
    try {
        // 1. Total count
        const { count, error: countError } = await supabase
            .from(TABLE_NAME)
            .select("*", { count: "exact", head: true });

        if (countError) {
            return NextResponse.json(
                { error: "Count failed", details: countError },
                { status: 500 }
            );
        }

        // 2. Get all metadata columns (paginated to get full picture)
        const allRows: { subject: string; chapter: string; topic: string; question_type: string; difficutly_level: string; source: string }[] = [];
        let page = 0;
        const pageSize = 1000;
        while (true) {
            const { data } = await supabase
                .from(TABLE_NAME)
                .select("subject, chapter, topic, question_type, difficutly_level, source")
                .range(page * pageSize, (page + 1) * pageSize - 1);
            if (!data || data.length === 0) break;
            allRows.push(...data);
            page++;
            if (data.length < pageSize) break;
        }

        // 3. Unique values
        const subjects = [...new Set(allRows.map((r) => r.subject))].filter(Boolean).sort();
        const questionTypes = [...new Set(allRows.map((r) => r.question_type))].filter(Boolean).sort();
        const difficultyLevels = [...new Set(allRows.map((r) => r.difficutly_level))].filter((v) => v && v.trim()).sort();
        const sources = [...new Set(allRows.map((r) => r.source))].filter(Boolean).sort();

        // 4. Chapters by subject
        const chaptersBySubject: Record<string, string[]> = {};
        allRows.forEach((r) => {
            if (!r.subject || !r.chapter) return;
            if (!chaptersBySubject[r.subject]) chaptersBySubject[r.subject] = [];
            if (!chaptersBySubject[r.subject].includes(r.chapter)) {
                chaptersBySubject[r.subject].push(r.chapter);
            }
        });
        Object.entries(chaptersBySubject).forEach(([subject, arr]) => {
            chaptersBySubject[subject] = sortChaptersForSubject(subject, arr);
        });

        // 5. Questions per subject
        const questionsPerSubject: Record<string, number> = {};
        subjects.forEach((s) => {
            questionsPerSubject[s] = allRows.filter((r) => r.subject === s).length;
        });

        // 6. Column names from a sample row
        const { data: sample } = await supabase.from(TABLE_NAME).select("*").limit(1);
        const columnNames = sample?.[0] ? Object.keys(sample[0]) : [];

        return NextResponse.json({
            success: true,
            tableName: TABLE_NAME,
            totalQuestions: count,
            subjects,
            questionsPerSubject,
            chaptersBySubject,
            totalChapters: Object.values(chaptersBySubject).flat().length,
            questionTypes,
            difficultyLevels,
            sources,
            columnNames,
        });
    } catch (err) {
        return NextResponse.json(
            { error: "Connection failed", details: String(err) },
            { status: 500 }
        );
    }
}
