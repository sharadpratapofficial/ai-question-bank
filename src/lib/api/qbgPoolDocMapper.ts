/**
 * Maps the QBG Pipeline's final working set (ParsedQuestion[] from
 * qbgPoolAdapter.ts, paired with each question's original pool row for the
 * fields ParsedQuestion doesn't carry — source/subtopic/class_level) into one
 * `GeneratedTest`, so the existing, already-decoupled
 * `downloadTestAsDocx`/`downloadTestAsPDF` (src/lib/downloadTest.ts) can
 * render it directly. This feature selects one pool per run, not N papers, so
 * unlike the Tests feature's `numberOfTests` loop, this always builds exactly
 * one `GeneratedTest`.
 *
 * Kept HTML-preserving (uses questionHtml/solutionHtml, not the plain-text
 * fields QC uses) since a rendered test document needs the original
 * formatting/MathML, not a QC-agent-friendly plain-text summary.
 */
import type { ExamPreset, GeneratedTest, GeneratedTestSection, Question, QuestionOption } from "@/types";
import { DIFFICULTY_MAP, getQuestionTypeLabel } from "@/types";
import type { ParsedQuestion } from "@/lib/agenticQC/parseStructured";
import type { PoolQuestion } from "@/lib/api/qbgPoolSelection";

const QUESTION_TYPE_MAP: Record<string, string> = {
    SCQ: "Single_Choice(SCQ)",
    MCQ: "Multi_Choice(MCQ)",
    Numerical: "Numerical",
    Integer: "Integer",
    Unknown: "Unknown",
};

function bucketDifficulty(diff: number | null | undefined): "Easy" | "Medium" | "Hard" {
    if (diff === 1) return "Easy";
    if (diff === 3) return "Hard";
    return "Medium"; // 2, 0, null, undefined
}

export interface PoolDocItem {
    question: ParsedQuestion;
    originalRow?: PoolQuestion;
}

function toQuestion(item: PoolDocItem): Question {
    const { question: q, originalRow } = item;
    const options: QuestionOption[] = q.options.map((o) => ({ text: o.html || o.text, isCorrect: o.isCorrect }));
    const hasOptions = options.length > 0;

    let answer_key: number | number[];
    if (hasOptions) {
        answer_key = options
            .map((o, i) => (o.isCorrect ? i + 1 : null))
            .filter((v): v is number => v !== null);
    } else {
        const n = Number(q.correctAnswer);
        answer_key = Number.isFinite(n) ? n : 0;
    }

    return {
        question_id: q.sourceId || `pipeline-${q.questionNumber}`,
        qbg_id: q.sourceId || "",
        question_text: q.questionHtml || q.questionText,
        options,
        answer_key,
        solution_text: q.solutionHtml || q.solutionText,
        question_type: QUESTION_TYPE_MAP[q.questionType] || q.questionType,
        subject: q.subject || originalRow?.subject || "",
        chapter: q.chapter || originalRow?.chapter || "",
        topic: q.topic || originalRow?.topic || "",
        source: originalRow?.source || "",
        difficutly_level: DIFFICULTY_MAP[q.difficulty || 0] || bucketDifficulty(q.difficulty),
        parent_question_id: null,
        raw_data: null,
        exam: null,
        class_level: q.klass || originalRow?.class_level || null,
        subtopic: originalRow?.subtopic || null,
    };
}

/** Build the one `GeneratedTest` this feature's final working set produces. */
export function mapPoolItemsToGeneratedTest(
    items: PoolDocItem[],
    opts: { batchName: string; examPreset: ExamPreset; testDate?: string }
): GeneratedTest {
    const questions = items.map(toQuestion);

    // Group by subject -> question_type, preserving first-seen order.
    const bySubject = new Map<string, Map<string, Question[]>>();
    for (const q of questions) {
        const subject = q.subject || "Unspecified";
        if (!bySubject.has(subject)) bySubject.set(subject, new Map());
        const byType = bySubject.get(subject)!;
        if (!byType.has(q.question_type)) byType.set(q.question_type, []);
        byType.get(q.question_type)!.push(q);
    }

    const sections: GeneratedTestSection[] = Array.from(bySubject.entries()).map(([subject, byType]) => {
        const questionTypes = Array.from(byType.entries()).map(([type, qs]) => ({
            type,
            typeLabel: getQuestionTypeLabel(type),
            questions: qs,
        }));
        return {
            subject,
            questionTypes,
            totalQuestions: questionTypes.reduce((sum, qt) => sum + qt.questions.length, 0),
        };
    });

    const byDifficulty: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byChapter: Record<string, number> = {};
    for (const q of questions) {
        byDifficulty[q.difficutly_level] = (byDifficulty[q.difficutly_level] || 0) + 1;
        bySource[q.source || "Unknown"] = (bySource[q.source || "Unknown"] || 0) + 1;
        byChapter[q.chapter || "Unspecified"] = (byChapter[q.chapter || "Unspecified"] || 0) + 1;
    }

    return {
        testNumber: 1,
        batchName: opts.batchName,
        testDate: opts.testDate,
        examPreset: opts.examPreset,
        sections,
        totalQuestions: questions.length,
        stats: { byDifficulty, bySource, byChapter },
    };
}
