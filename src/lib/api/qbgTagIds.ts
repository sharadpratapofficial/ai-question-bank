/**
 * AI-tag a set of QBG ids from the browser.
 *
 * Ingestion and the post-hoc push both end with "here are the new QBG ids", and
 * both want the same next step the QBG Pipeline already chains after Modify:
 * hand those ids to the tagging job. Wrapped here so the two callers can't drift
 * from each other (or from the pipeline) in how they start and poll that job.
 *
 * Tagging runs on the server's single-slot queue, so several of these wait their
 * turn rather than hammering QBG.
 */
import { pollQbgJob } from "@/lib/api/qbgJobPoll";
import type { ProgressEvent } from "@/components/qbg/QbgProgressLog";

export interface TagIdsResult {
    mode?: "ai" | "csv";
    count?: number;
    tagged?: number;
    results?: {
        qbg_id: string | null;
        ok: boolean;
        error?: string;
        meta?: {
            subject_name?: string;
            chapter_name?: string;
            topic_name?: string;
            subtopic_name?: string;
            class_name?: string;
            difficulty_name?: string;
            category?: string;
            taxonomy_category?: string | null;
            /** Other chapters the question relies on — read by the syllabus audit. */
            chapters_used?: string[];
        };
    }[];
    [k: string]: unknown;
}

export interface TagIdsArgs {
    ids: string[];
    provider: string;
    modelId: string;
    /** Match against this taxonomy instead of each question's own category.
     *  Blank/undefined = Auto, which is right whenever the category's tree has
     *  been crawled into the bundled tagging table. */
    taxonomyCategory?: string;
    /**
     * Restrict the tag shortlist to these subjects (empty/undefined = all).
     *
     * Chapter names repeat across subjects — "Mathematical Tools and Vectors"
     * exists under Physics AND Maths — so a Physics question can be filed under
     * Maths unless the subject is decided before the model sees the list.
     */
    subjects?: string[];
    /** Extra headers for dev-auth sessions (x-dev-api-key / x-dev-qbg / …). */
    headers?: Record<string, string>;
    label?: string;
    onProgress?: (events: ProgressEvent[]) => void;
}

/** Start a tagging job for `ids` and resolve with its result. Throws on failure. */
export async function tagQbgIds(args: TagIdsArgs): Promise<TagIdsResult> {
    const ids = args.ids.filter(Boolean);
    if (ids.length === 0) throw new Error("No QBG ids to tag.");
    if (!args.modelId.trim()) throw new Error("A model is required to tag.");

    return pollQbgJob<TagIdsResult>({
        startUrl: "/api/ai-tools/qbg-tagging",
        startBody: {
            mode: "ai",
            qbgIds: ids.join("\n"),
            provider: args.provider,
            modelId: args.modelId.trim(),
            taxonomyCategory: args.taxonomyCategory || undefined,
            subjects: args.subjects?.length ? args.subjects : undefined,
        },
        startHeaders: args.headers || {},
        buildPollUrl: (jobId) => `/api/ai-tools/qbg-tagging?jobId=${encodeURIComponent(jobId)}`,
        kind: "qbg_ingestion_tag",
        label: args.label || `Tag · ${ids.length} ID(s)`,
        onProgress: args.onProgress,
    });
}
