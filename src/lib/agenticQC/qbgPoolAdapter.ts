/**
 * Agentic QC adapter for the QBG Pipeline feature. Turns the two shapes the
 * pipeline can hand QC — raw `qbg_question_pool` rows, or the in-memory
 * result of a QBG Modification job — into `ParsedQuestion[]`, reusing
 * `parseStructuredRecord()` (extracted from parseStructured.ts) rather than
 * re-deriving the SCQ-answer-from-isCorrect / question-type-inference logic.
 *
 * No "fetch full question by id from live QBG" round trip is needed anywhere:
 * unmodified content comes from the pool table's own JSONB (already fetched
 * by pool selection), modified content comes from the modification job's own
 * in-memory result (already fetched by that stage) — both are already in hand
 * by the time QC runs in the pipeline panel.
 */
import { parseStructuredRecord, pickEnglish, htmlToText, type ParsedQuestion } from "@/lib/agenticQC/parseStructured";
import type { PoolQuestion } from "@/lib/api/qbgPoolSelection";

export interface AdaptResult {
    questions: ParsedQuestion[];
    /** Parallel to `questions` (same index, same length) — the pool row each
     *  parsed question came from (unmodified path) or was taxonomy-copied from
     *  (post-Modify path). Lets a second consumer (e.g. the test-document
     *  mapper) recover fields ParsedQuestion doesn't carry — `source`,
     *  `subtopic`, `class_level` — without redoing the id-backmapping this
     *  module already does. */
    originalRows: (PoolQuestion | undefined)[];
    warnings: string[];
}

/** Unmodified pool rows -> ParsedQuestion[]. Pool JSONB columns already use
 *  the same shapes parseStructuredRecord expects (content.english,
 *  bilingual_options.english[], etc.) — this is a direct field-name
 *  passthrough, plus unwrapping `answer` (JSONB {english:"<p>3</p>"} in this
 *  table) into the plain string Numerical/Integer answer resolution expects. */
export function adaptPoolRowsToParsedQuestions(rows: PoolQuestion[]): AdaptResult {
    const questions: ParsedQuestion[] = [];
    const originalRows: (PoolQuestion | undefined)[] = [];
    const warnings: string[] = [];

    rows.forEach((row) => {
        const record: Record<string, unknown> = {
            content: row.content,
            bilingual_options: row.bilingual_options,
            solutions: row.solutions,
            bilingual_solutions: row.bilingual_solutions,
            answer: htmlToText(pickEnglish(row.answer)) || undefined,
            is_int_answer: row.is_int_answer,
            is_range_numerical: row.is_range_numerical,
            difficulty: row.difficulty,
            subject_direct: row.subject || "",
            chapter_direct: row.chapter || "",
            topic_direct: row.topic || "",
            class_direct: row.class_level || "",
            unique_id: row.unique_id,
            slug: row.slug,
        };
        const outcome = parseStructuredRecord(record, questions.length + 1);
        if (!outcome.question) {
            warnings.push(`${row.unique_id}: ${outcome.warning || "skipped"}`);
            return;
        }
        questions.push(outcome.question);
        originalRows.push(row);
    });

    return { questions, originalRows, warnings };
}

/**
 * Shape of one qbg-modification job's `records[]` entry, AS RECEIVED OVER THE
 * WIRE. NOT the same shape as the sidecar's own ReframedRecord (which has
 * options as [isCorrect, text] tuples) — the qbg-modification route remaps
 * that into {isCorrect, text} objects for its own preview UI before sending
 * the job result to the client (see src/app/api/ai-tools/qbg-modification/
 * route.ts's `previewRecords` mapping). Destructuring this as a tuple throws
 * "object is not iterable" at runtime — matched the wire shape here instead.
 */
export interface ModifiedRecord {
    content: string;
    options: { isCorrect: boolean | null; text: string | null }[];
    solution: string;
    /** Present only when `options` is empty (Numerical/no-option question) — the
     *  AI's plain numeric answer, e.g. "42". */
    answer?: string | null;
}
/** Shape of one qbg-modification job's `qbgResults[]` entry (QbgPushResult).
 *  `num` is each reframed question's own 1-indexed position in the original
 *  request's id list (set server-side from the question's own "num", not
 *  from array position — see python/qbg_modification/cli.py's
 *  `_maybe_qbg_push`, which assigns `num = q.get("num", i)`). */
export interface ModifyQbgPushResult {
    num: number;
    unique_id: string | null;
    ok: boolean;
    error?: string;
}

/**
 * Post-Modify records -> ParsedQuestion[]. `records` and `qbgResults` are
 * positionally aligned by array index (confirmed against
 * python/qbg_modification/cli.py's `_maybe_qbg_push`: it iterates
 * `zip(records, questions)` and appends to `results` in that same order) —
 * only successfully-pushed entries (`ok && unique_id`) become the new working
 * set, per the pipeline's confirmed design.
 *
 * Modify's own output doesn't carry meaningful taxonomy (buildRows() in the
 * qbg-modification route leaves subject/topic/class blank), so subject /
 * chapter / topic / class are copied from the ORIGINAL pool row instead —
 * Modify only rewrites question content, not tagging. The original row is
 * located via each reframed question's own 1-indexed `num` (from
 * `qbgResults[i].num`, its position in the original request's id list),
 * falling back to plain array position if `num` looks out of range.
 *
 * Note: the qbg-modification job's response has no top-level `questions`
 * field (only `records`/`qbgResults`/etc — see the route's `reportData`), so
 * there's no per-question "chapter" override available here; the pool row's
 * own difficulty/taxonomy is used throughout. A Numerical/Integer modified
 * question's answer DOES come through, though — via `records[i].answer`
 * (see csvbuild.py's modified_records(), only set when options is empty).
 */
export function adaptModifiedRecordsToParsedQuestions(args: {
    records: ModifiedRecord[];
    qbgResults: ModifyQbgPushResult[];
    /** The exact id list sent to qbg-modification, in request order. */
    originalIds: string[];
    /** Original pool rows keyed by unique_id, for taxonomy passthrough. */
    poolRowsById: Record<string, PoolQuestion>;
}): AdaptResult {
    const { records, qbgResults, originalIds, poolRowsById } = args;
    const questions: ParsedQuestion[] = [];
    const originalRows: (PoolQuestion | undefined)[] = [];
    const warnings: string[] = [];

    records.forEach((rec, i) => {
        const push = qbgResults[i];
        if (!push || !push.ok || !push.unique_id) {
            warnings.push(`Question ${i + 1}: not successfully pushed to QBG — excluded from QC.`);
            return;
        }

        const num = typeof push.num === "number" && push.num >= 1 && push.num <= originalIds.length ? push.num : i + 1;
        const originalId = originalIds[num - 1] ?? originalIds[i];
        const originalRow = originalId ? poolRowsById[originalId] : undefined;

        const hasOptions = Array.isArray(rec.options) && rec.options.length > 0;
        const record: Record<string, unknown> = {
            content: { english: rec.content || "" },
            bilingual_options: hasOptions
                ? { english: rec.options.map((o) => ({ isCorrect: o.isCorrect === true, text: o.text || "" })) }
                : undefined,
            solutions: [{ english: { text: rec.solution || "" } }],
            answer: !hasOptions ? rec.answer ?? undefined : undefined,
            is_int_answer: false,
            is_range_numerical: !hasOptions,
            difficulty: originalRow?.difficulty ?? null,
            subject_direct: originalRow?.subject || "",
            chapter_direct: originalRow?.chapter || "",
            topic_direct: originalRow?.topic || "",
            class_direct: originalRow?.class_level || "",
            unique_id: push.unique_id,
        };
        const outcome = parseStructuredRecord(record, questions.length + 1);
        if (!outcome.question) {
            warnings.push(`${push.unique_id}: ${outcome.warning || "skipped"}`);
            return;
        }
        questions.push(outcome.question);
        originalRows.push(originalRow);
    });

    return { questions, originalRows, warnings };
}
