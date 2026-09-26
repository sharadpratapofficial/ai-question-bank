/**
 * Agentic QC executor — runs a job to completion in the background.
 *
 * Two execution paths:
 *
 *   1. Per-question (inputMode === "structured"):
 *      For each question, dispatch the enabled QC agents IN PARALLEL.
 *      As soon as all agents finish for a single question, run the
 *      aggregator on that question only — using just the question text
 *      + the agents' verdicts. Emit live `question_updated` events at
 *      each step so the UI can show the dashboard filling in.
 *
 *      Multiple questions are processed concurrently up to
 *      AGENT_QUESTION_CONCURRENCY (default 4). Higher = faster but more
 *      provider-side rate-limit risk.
 *
 *   2. Paper-level (inputMode === "combined" / "separate"):
 *      The legacy flow — each agent processes the whole paper in one LLM
 *      call, then the aggregator reconciles. Kept for PDF / Word input
 *      since we can't split those into per-question slices cheaply.
 *      Final results get unpacked into the per-question dashboard so
 *      the UI experience is the same.
 *
 * Both paths:
 *   - check the job's cancellation flag before each LLM call
 *   - keep going if SOME agents fail (partial reports)
 *   - persist state on every change so the user can navigate away and come
 *     back, or even reload the server, without losing progress
 */
import type { AIModelProvider } from "@/types/extraction";
import { detectKeyShifts } from "./keyShift";
import { detectDuplicates } from "./duplicates";
import {
    buildSyllabusPromptBlock,
    findSyllabusViolations,
    groupViolations,
    hasRestriction,
    type SyllabusScope,
} from "./syllabusCheck";
import { readTaxonomySummary } from "@/lib/api/qbgTaxonomy";
import {
    type JobQuestion,
    type PerAgentQuestionResult,
    type AggregatorQuestionResult,
    type AgentConfig,
    updateJob,
    getJob,
    emitEvent,
    isCancelled,
    getAbortSignal,
    clearAbortController,
    addTokenUsage,
    flushPersist,
} from "./jobStore";
import {
    callAI,
    parseJSONResponse,
    fetchImagesForPrompt,
    type FileInput,
    type ImageInput,
} from "./llm";

const AGENT_QUESTION_CONCURRENCY = Number(process.env.QBG_AGENTIC_QC_CONCURRENCY || "4");

// ─── Public entry point ────────────────────────────────────────────────

export interface ExecutorInput {
    userId: string;
    jobId: string;
    /** Maps provider → apiKey for this user. Looked up by the API route from
     *  user.user_metadata.api_keys before kicking off the executor. */
    apiKeys: Record<string, string>;
    /** Required for structured mode. */
    parsedQuestions?: PreparsedQuestion[];
    /** Required for paper-level mode. */
    files?: { questionFile: FileInput; answerKeyFile?: FileInput; solutionFile?: FileInput };
    inputMode: "combined" | "separate" | "structured";
    examType?: string;
    customQuestionTypeSequence?: string;
    subjects?: string[];
    syllabus?: Record<string, string[]>;
    /** Rendered syllabus/concept block for the per-question agent prompt. */
    syllabusBlock?: string;
    /** Structured scope for the deterministic post-run syllabus audit. */
    syllabusScope?: SyllabusScope;
    qcAgents: AgentConfig[];
    aggregator: AgentConfig;
}

/**
 * Parsed-question shape passed from the page (output of parseStructuredPaper).
 * Kept loose so we don't tightly couple the two modules.
 */
export interface PreparsedQuestion {
    questionNumber: number;
    /** PW QBG unique id (CSV `unique_id`) — carried through for the report. */
    sourceId?: string;
    questionText: string;
    questionHtml?: string;
    options: { label: string; text: string; isCorrect: boolean }[];
    correctAnswer: string;
    questionType: string;
    solutionText: string;
    solutionHtml?: string;
    subject: string;
    chapter: string;
    topic: string;
    /** Raw class / standard label (e.g. "Class 11") — structured input only. */
    klass?: string;
    /** Source difficulty index (0-3 typically) — optional, structured input only. */
    difficulty?: number | null;
    /** Whether the source row carried a video-solution URL. */
    hasVideoSolution?: boolean;
    imageUrls: string[];
}

/** Run the job to completion. Returns when the executor stops. */
export async function runJob(input: ExecutorInput): Promise<void> {
    const { userId, jobId } = input;
    try {
        await updateJob(userId, jobId, (j) => {
            j.status = "running";
        });
        await emitEvent(userId, jobId, {
            type: "started",
            qcAgents: input.qcAgents,
            aggregator: input.aggregator,
            inputMode: input.inputMode,
        });

        if (input.inputMode === "structured") {
            await runPerQuestion(input);
        } else {
            await runPaperLevel(input);
        }

        if (await isCancelled(userId, jobId)) {
            await updateJob(userId, jobId, (j) => {
                j.status = "cancelled";
                j.finishedAt = new Date().toISOString();
            });
            await emitEvent(userId, jobId, { type: "cancelled" });
            return;
        }

        await updateJob(userId, jobId, (j) => {
            j.status = "done";
            j.finishedAt = new Date().toISOString();
        });
        // Flush the terminal status to Supabase BEFORE telling the client the
        // run is complete. Otherwise the client's post-complete refetch (a
        // separate route instance with its own cache) can read a stale
        // "running" row and revert the dashboard, leaving the UI stuck.
        await flushPersist(jobId);
        await emitEvent(userId, jobId, { type: "complete" });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If the cancellation flag is set, treat any thrown error as a
        // cancel (AbortError tends to bubble up from inner fetches). This
        // keeps the dashboard from showing a confusing "fatal_error".
        if (await isCancelled(userId, jobId)) {
            await updateJob(userId, jobId, (j) => {
                j.status = "cancelled";
                j.finishedAt = new Date().toISOString();
            });
            await emitEvent(userId, jobId, { type: "cancelled" });
            return;
        }
        await updateJob(userId, jobId, (j) => {
            j.status = "failed";
            j.fatalError = msg;
            j.finishedAt = new Date().toISOString();
        });
        await emitEvent(userId, jobId, { type: "fatal_error", error: msg });
    } finally {
        // Make sure the terminal snapshot (done/failed/cancelled + final
        // per-question rows) is fully written to Supabase before we let the
        // task end — otherwise a client refetch could still read a mid-run
        // state from the coalescing queue's last in-flight write.
        await flushPersist(jobId);
        // Drop the per-job AbortController once the job has reached any
        // terminal state. New jobs get a fresh controller via getAbortSignal.
        clearAbortController(jobId);
    }
}

// ─── PER-QUESTION (structured) ──────────────────────────────────────────

async function runPerQuestion(input: ExecutorInput): Promise<void> {
    const { userId, jobId, parsedQuestions, qcAgents, aggregator, apiKeys } = input;
    if (!parsedQuestions || parsedQuestions.length === 0) {
        throw new Error("No parsed questions available for structured mode.");
    }

    // Resolve the syllabus ONCE for the whole run: the allowed chapters plus the
    // concepts inside each, so an agent can judge a question by what it tests
    // rather than by the label it carries. Best-effort — a taxonomy read failure
    // must not stop a QC run, it only costs the concept detail.
    const scope: SyllabusScope = { chaptersBySubject: input.syllabus || {} };
    if (hasRestriction(scope)) {
        try {
            const tax = await readTaxonomySummary();
            scope.topicsByChapter = tax.topicsByChapter;
        } catch {
            /* chapter names alone still give a usable, if coarser, check */
        }
        input.syllabusBlock = buildSyllabusPromptBlock(scope);
        input.syllabusScope = scope;
    }

    // Initialise per-question rows with `pending` placeholders.
    await updateJob(userId, jobId, (j) => {
        if (j.questions && j.questions.length > 0) {
            // Resuming an interrupted run (the previous serverless invocation
            // was frozen mid-flight). Reset any agent/aggregator left in
            // "running" — their in-flight fetches died with that invocation —
            // back to "pending" so they get retried. Keep all finished work.
            for (const row of j.questions) {
                for (const ar of row.agentResults) {
                    if (ar.status === "running") ar.status = "pending";
                }
                if (row.aggregator.status === "running") row.aggregator.status = "pending";
            }
            return;
        }
        j.questions = parsedQuestions.map<JobQuestion>((q) => ({
            questionNumber: q.questionNumber,
            qbgId: q.sourceId || undefined,
            questionSummary: q.questionText.slice(0, 120),
            questionText: q.questionText,
            providedAnswerKey: q.correctAnswer || null,
            questionType: q.questionType,
            hasFigure: q.imageUrls.length > 0,
            imageUrls: q.imageUrls,
            subject: q.subject || undefined,
            chapter: q.chapter || undefined,
            topic: q.topic || undefined,
            klass: q.klass || undefined,
            difficulty: q.difficulty ?? null,
            hasVideoSolution: q.hasVideoSolution ?? false,
            options: q.options.map((o) => ({
                label: o.label,
                text: o.text,
                isCorrect: o.isCorrect,
            })),
            solutionText: q.solutionText || "",
            agentResults: qcAgents.map<PerAgentQuestionResult>((a) => ({
                label: a.label,
                provider: a.provider,
                modelId: a.modelId,
                status: "pending",
                answer: null,
                correctness: "",
                errorsFound: [],
                solutionFeedback: "",
                hasFigure: q.imageUrls.length > 0,
                questionType: q.questionType,
            })),
            aggregator: {
                status: "pending",
                finalAnswer: null,
                confidence: "low",
                agreementWithProvidedKey: null,
                needsManualReview: false,
                manualReviewReason: null,
                consolidatedErrors: [],
                consolidatedSolutionFeedback: "",
                rationale: "",
            },
        }));
    });

    // Concurrency-limited dispatcher. On a resumed run, skip questions whose
    // aggregator already reached a terminal state (done / skipped / failed-with-
    // fallback) so reconnects continue instead of restarting from scratch.
    const finalised = new Set<number>();
    const snapshot = await getJob(userId, jobId);
    if (snapshot) {
        for (const row of snapshot.questions) {
            const s = row.aggregator.status;
            if (s === "done" || s === "skipped" || s === "failed") {
                finalised.add(row.questionNumber);
            }
        }
    }
    const queue = parsedQuestions.filter((q) => !finalised.has(q.questionNumber));
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.max(1, AGENT_QUESTION_CONCURRENCY); i++) {
        workers.push(
            (async () => {
                while (queue.length > 0) {
                    if (await isCancelled(userId, jobId)) return;
                    const q = queue.shift();
                    if (!q) return;
                    await processOneQuestion(input, q);
                }
            })()
        );
    }
    await Promise.all(workers);

    // Paper-level analysis derived from the per-question rolls. We could ALSO
    // ask one of the models to write a paragraph summary here, but that's an
    // extra LLM call; the per-question rationales already cover the needed
    // detail and the user explicitly asked for speed.
    await updateJob(userId, jobId, (j) => {
        const errCount = j.questions.filter((q) => q.aggregator.consolidatedErrors.length > 0).length;
        const figureCount = j.questions.filter((q) => q.hasFigure).length;
        const reviewCount = j.questions.filter((q) => q.aggregator.needsManualReview).length;
        j.paperAnalysis.patternAnalysis =
            `Paper has ${j.questions.length} question(s). ` +
            `${reviewCount} flagged for manual review, ${errCount} contain errors, ${figureCount} contain diagrams.`;
        j.paperAnalysis.syllabusAnalysis = "";

        // A displaced key block makes every question in it look independently
        // wrong. Detecting it here — across the finished paper — turns N
        // "wrong key" findings into one clerical fix. Deterministic on purpose:
        // an agent that sees one question at a time cannot spot a sequence shift.
        const shifts = detectKeyShifts(
            j.questions.map((q) => ({
                questionNumber: q.questionNumber,
                providedKey:
                    q.providedAnswerKey === null || q.providedAnswerKey === undefined
                        ? null
                        : String(q.providedAnswerKey),
                verifiedAnswer:
                    q.aggregator.finalAnswer === null || q.aggregator.finalAnswer === undefined
                        ? null
                        : String(q.aggregator.finalAnswer),
            }))
        );
        const suggestions = shifts.map((s) => s.message);

        // Syllabus: judged on what QC concluded the question tests, falling back
        // to its printed tag. Deterministic, so a violation cannot be argued away.
        if (input.syllabusScope) {
            // Consensus chapter: what the agents independently said the question
            // tests. Requires agreement from at least two agents (or the only one
            // that answered) — a single dissenting guess must not brand a question
            // out of syllabus.
            for (const q of j.questions) {
                const votes = new Map<string, number>();
                for (const a of q.agentResults) {
                    const c = (a.detectedChapter || "").trim();
                    if (c) votes.set(c, (votes.get(c) || 0) + 1);
                }
                let best: string | null = null;
                let bestN = 0;
                for (const [c, n] of votes) if (n > bestN) { best = c; bestN = n; }
                const answering = q.agentResults.filter((a) => a.status === "done").length;
                q.detectedChapter = best && (bestN >= 2 || answering <= 1) ? best : null;
            }

            const violations = findSyllabusViolations(
                input.syllabusScope,
                j.questions.map((q) => ({
                    questionNumber: q.questionNumber,
                    subject: q.subject,
                    taggedChapter: q.chapter,
                    detectedChapter: q.detectedChapter || undefined,
                }))
            );
            for (const g of groupViolations(violations)) {
                suggestions.push(
                    `MAJOR: "${g.chapter}"${g.subject ? ` (${g.subject})` : ""} is NOT in this ` +
                        `paper's syllabus — Q${g.questionNumbers.join(", Q")} test it. ` +
                        `Replace or remove them.`
                );
            }
            j.paperAnalysis.syllabusAnalysis = violations.length
                ? `${violations.length} question(s) fall outside the selected syllabus.`
                : "All questions are within the selected syllabus.";
        }

        // Repetition across the whole paper — exact twins, data-only reskins,
        // reworded twins, and same-concept repeats.
        for (const d of detectDuplicates(
            j.questions.map((q) => ({
                questionNumber: q.questionNumber,
                questionText: q.questionText || "",
                subject: q.subject,
                chapter: q.chapter,
                topic: q.topic,
            }))
        )) {
            suggestions.push(d.message);
        }

        j.paperAnalysis.overallSuggestions = suggestions;
    });
}

async function processOneQuestion(input: ExecutorInput, q: PreparsedQuestion): Promise<void> {
    const { userId, jobId, qcAgents, aggregator, apiKeys } = input;

    // Emit "question started" for the UI.
    await emitEvent(userId, jobId, { type: "question_started", questionNumber: q.questionNumber });

    // Download the question's diagram(s) once so every agent + the aggregator
    // can actually SEE the figure (vision input) instead of just being told a
    // URL exists. Fetched here, not per-agent, to avoid N redundant downloads.
    let questionImages: ImageInput[] = [];
    if (q.imageUrls.length > 0) {
        questionImages = await fetchImagesForPrompt(q.imageUrls, getAbortSignal(jobId));
    }

    // Run all enabled QC agents in parallel for this single question.
    const perAgent: PerAgentQuestionResult[] = await Promise.all(
        qcAgents.map(async (a) => {
            const t0 = Date.now();
            await markAgent(userId, jobId, q.questionNumber, a.label, (r) => {
                r.status = "running";
            });
            await emitEvent(userId, jobId, {
                type: "agent_started",
                questionNumber: q.questionNumber,
                label: a.label,
                provider: a.provider,
                modelId: a.modelId,
            });
            try {
                if (await isCancelled(userId, jobId)) throw new Error("Cancelled");
                const apiKey = apiKeys[a.provider];
                if (!apiKey)
                    throw new Error(`No saved API key for ${a.provider}.`);
                const prompt = buildPerQuestionAgentPrompt(q, {
                    examType: input.examType,
                    subjects: input.subjects,
                    customQuestionTypeSequence: input.customQuestionTypeSequence,
                    hasImages: questionImages.length > 0,
                    syllabusBlock: input.syllabusBlock,
                });
                const { text: raw, usage } = await callAI(
                    a.provider as AIModelProvider,
                    a.modelId,
                    apiKey,
                    prompt,
                    [],
                    getAbortSignal(jobId),
                    questionImages
                );
                await addTokenUsage(userId, jobId, {
                    provider: a.provider,
                    modelId: a.modelId,
                    label: a.label,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                });
                const parsed = parseJSONResponse(raw);
                const result = normalisePerQuestionAgent(parsed, q, a);
                result.elapsedMs = Date.now() - t0;
                await markAgent(userId, jobId, q.questionNumber, a.label, (r) => {
                    Object.assign(r, result);
                    r.status = "done";
                });
                await emitEvent(userId, jobId, {
                    type: "agent_completed",
                    questionNumber: q.questionNumber,
                    label: a.label,
                    answer: result.answer,
                    elapsedMs: result.elapsedMs,
                });
                return result;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // An AbortError means either the user hit Stop OR the per-call
                // timeout fired. Distinguish them: only the cancel flag means a
                // real user stop — otherwise it's a timeout, which must not be
                // mislabeled "Cancelled by user".
                const isAbort =
                    msg.toLowerCase().includes("abort") ||
                    msg.toLowerCase().includes("the operation was aborted") ||
                    msg.toLowerCase().includes("timeout");
                const finalMsg = isAbort
                    ? (await isCancelled(userId, jobId))
                        ? "Cancelled by user."
                        : "Timed out — model did not respond in time."
                    : msg;
                await markAgent(userId, jobId, q.questionNumber, a.label, (r) => {
                    r.status = "failed";
                    r.error = finalMsg;
                    r.elapsedMs = Date.now() - t0;
                });
                await emitEvent(userId, jobId, {
                    type: "agent_failed",
                    questionNumber: q.questionNumber,
                    label: a.label,
                    error: finalMsg,
                    elapsedMs: Date.now() - t0,
                });
                return placeholderAgentResult(a, q, "failed", finalMsg);
            }
        })
    );

    // Aggregator pass for this one question.
    if (await isCancelled(userId, jobId)) return;
    const successfulAgents = perAgent.filter((r) => r.status === "done");

    const tAgg = Date.now();
    if (successfulAgents.length === 0) {
        // Every agent failed — skip the aggregator, mark accordingly.
        await markAggregator(userId, jobId, q.questionNumber, (r) => {
            r.status = "skipped";
            r.rationale =
                "All QC agents failed for this question. Aggregator skipped — see per-agent errors.";
            r.needsManualReview = true;
            r.manualReviewReason = "All agents failed";
            r.elapsedMs = 0;
        });
        await emitEvent(userId, jobId, {
            type: "aggregator_skipped",
            questionNumber: q.questionNumber,
            reason: "all_agents_failed",
        });
        return;
    }

    await markAggregator(userId, jobId, q.questionNumber, (r) => {
        r.status = "running";
    });
    await emitEvent(userId, jobId, {
        type: "aggregator_started",
        questionNumber: q.questionNumber,
    });
    try {
        const apiKey = apiKeys[aggregator.provider];
        if (!apiKey) throw new Error(`No saved API key for ${aggregator.provider}.`);
        const prompt = buildPerQuestionAggregatorPrompt(q, successfulAgents, questionImages.length > 0);
        const { text: raw, usage } = await callAI(
            aggregator.provider as AIModelProvider,
            aggregator.modelId,
            apiKey,
            prompt,
            [],
            getAbortSignal(jobId),
            questionImages
        );
        await addTokenUsage(userId, jobId, {
            provider: aggregator.provider,
            modelId: aggregator.modelId,
            label: aggregator.label || "Aggregator",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
        });
        const parsed = parseJSONResponse(raw);
        const result = normalisePerQuestionAggregator(parsed, q, perAgent);
        result.elapsedMs = Date.now() - tAgg;
        await markAggregator(userId, jobId, q.questionNumber, (r) => {
            Object.assign(r, result);
            r.status = "done";
        });
        await emitEvent(userId, jobId, {
            type: "aggregator_completed",
            questionNumber: q.questionNumber,
            finalAnswer: result.finalAnswer,
            elapsedMs: result.elapsedMs,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fall back to a vote-based aggregate so the row isn't lost.
        const voted = voteAggregate(perAgent, q);
        voted.error = msg;
        voted.elapsedMs = Date.now() - tAgg;
        await markAggregator(userId, jobId, q.questionNumber, (r) => {
            Object.assign(r, voted);
            r.status = "failed"; // surfaces in UI as fallback path
        });
        await emitEvent(userId, jobId, {
            type: "aggregator_failed",
            questionNumber: q.questionNumber,
            error: msg,
            elapsedMs: voted.elapsedMs,
        });
    }

    await emitEvent(userId, jobId, { type: "question_done", questionNumber: q.questionNumber });
}

// ─── Helpers for per-question state mutations ──────────────────────────

async function markAgent(
    userId: string,
    jobId: string,
    qNum: number,
    label: string,
    mut: (r: PerAgentQuestionResult) => void
): Promise<void> {
    await updateJob(userId, jobId, (j) => {
        const q = j.questions.find((x) => x.questionNumber === qNum);
        if (!q) return;
        const r = q.agentResults.find((x) => x.label === label);
        if (r) mut(r);
    });
}

async function markAggregator(
    userId: string,
    jobId: string,
    qNum: number,
    mut: (r: AggregatorQuestionResult) => void
): Promise<void> {
    await updateJob(userId, jobId, (j) => {
        const q = j.questions.find((x) => x.questionNumber === qNum);
        if (q) mut(q.aggregator);
    });
}

function placeholderAgentResult(
    a: AgentConfig,
    q: PreparsedQuestion,
    status: PerAgentQuestionResult["status"],
    err?: string
): PerAgentQuestionResult {
    return {
        label: a.label,
        provider: a.provider,
        modelId: a.modelId,
        status,
        answer: null,
        correctness: "",
        errorsFound: [],
        solutionFeedback: "",
        hasFigure: q.imageUrls.length > 0,
        questionType: q.questionType,
        error: err,
    };
}

// ─── Per-question prompts ──────────────────────────────────────────────

function buildPerQuestionAgentPrompt(
    q: PreparsedQuestion,
    ctx: {
        examType?: string;
        subjects?: string[];
        customQuestionTypeSequence?: string;
        hasImages?: boolean;
        /** Rendered syllabus + concept inventory; "" when the run is unrestricted. */
        syllabusBlock?: string;
    }
): string {
    const syllabusBlock = ctx.syllabusBlock || "";
    const optionLines =
        q.options.length > 0
            ? "Options:\n" + q.options.map((o) => `  ${o.label}) ${o.text}`).join("\n")
            : "(no MCQ options — numerical / integer answer expected)";
    const figureLine = ctx.hasImages
        ? `\nNOTE: The diagram(s) for this question are ATTACHED as image(s). Read them carefully and use them in your solution. Set hasFigure=true.`
        : q.imageUrls.length > 0
        ? `\nNOTE: This question references diagram(s) at: ${q.imageUrls.join(", ")}, but the image(s) could not be loaded. Flag hasFigure=true and note if the diagram is essential to solve.`
        : "";

    return `You are one of several independent quality-control reviewers for a single competitive-exam question. Solve it yourself, then critique the provided answer key and solution.

EXAM CONTEXT: ${ctx.examType || "JEE/NEET"} ${ctx.subjects?.join(", ") || ""}
QUESTION (subject: ${q.subject || "?"} / chapter: ${q.chapter || "?"} / topic: ${q.topic || "?"}):
${q.questionText}
${figureLine}

${optionLines}

Provided answer key: ${q.correctAnswer || "(none)"}
Provided solution: ${q.solutionText || "(none)"}
${syllabusBlock ? `\n${syllabusBlock}\n` : ""}

## Your task
1. Solve the question yourself from first principles, BEFORE reading the key or
   solution as evidence. Never trust either by default.
2. SOLVE IT TWICE, by two genuinely different routes (e.g. standard derivation vs
   conservation law / symmetry / limiting case / direct substitution / dimensional
   reasoning). Only assert an answer when both routes agree. If they disagree and
   you cannot reconcile them, answer "Cannot Determine" and say why — a wrong
   confident answer is far worse here than an admitted one.
3. Run at least one sanity check before finalising: dimensional analysis, sign and
   direction, a limiting/extreme case, symmetry, or back-substitution.
4. Compare to the provided key. If NO key was provided, never claim a match or a
   mismatch — set answerMatch to null.
5. Detect every error, of every kind:
   - data: missing/contradictory values, units, conditions, figure not rendered
   - options: repeated or algebraically equivalent options, more than one correct
     in a single-correct question, no correct option, wrong/missing units,
     inconsistent precision
   - units and dimensions: flag a dimensional defect EVEN IF the final number
     happens to come out right
   - language: ambiguity, double negatives, spelling/grammar that changes meaning
6. Critique the provided solution (if present) line by line: wrong final answer,
   wrong physics/maths, arithmetic slips, a dropped sign or operator, a step that
   does not follow from the previous one, missing steps, or a value used mid-
   derivation that was never given. A correct FINAL answer does not excuse a
   defective intermediate line — report it anyway.

## Rules that change the verdict
- NO EARLY STOP: do not stop at the first error. Report every distinct error as
  its own item; never merge them into one vague phrase.
- Distinguish WHAT is wrong: wrong question / wrong option set / wrong key /
  wrong solution / correct answer via flawed reasoning / formatting-only defect /
  figure defect. Say which one it is.
- Prefix each error with its severity: "MAJOR:" (changes the answer, makes the
  question unsolvable/unfair, wrong key, no or multiple correct options),
  "MODERATE:" (confusing or invalid as printed, but the fix is obvious), or
  "MINOR:" (presentation only).
- If the question needs an assumption to be solvable, state the assumption rather
  than silently making it.

## Style — BE TERSE
- Each errorsFound item: a short phrase, max ~12 words. No full sentences, no preamble.
- correctness reasoning: max ~10 words.
- solutionFeedback: one short line (max ~15 words), or "" if the solution is fine.
- Report only real issues. Do NOT pad with generic advice.

## Output — single JSON object, no markdown, no preamble:
{
  "aiAnswer": <your answer — letter for MCQ, number/string for numerical>,
  "correctness": "<Correct | Incorrect | Partially Correct | Cannot Determine — followed by short reasoning>",
  "hasFigure": <true | false>,
  "questionType": "<SCQ | MCQ | Integer | Numerical | Assertion_Reason | Matching_List>",
  "answerMatch": <true | false | null>,
  "detectedChapter": "<the chapter this question ACTUALLY tests, your own judgement>",
  "outOfSyllabus": <true | false | null>,
  "errorsFound": ["<short error phrase>", ...],
  "solutionFeedback": "<one short line, or empty string>"
}`;
}

function buildPerQuestionAggregatorPrompt(
    q: PreparsedQuestion,
    agents: PerAgentQuestionResult[],
    hasImages = false
): string {
    const agentLines = agents
        .map(
            (a) =>
                `── ${a.label} (${a.provider}/${a.modelId}) ──\n` +
                JSON.stringify(
                    {
                        aiAnswer: a.answer,
                        correctness: a.correctness,
                        errorsFound: a.errorsFound,
                        solutionFeedback: a.solutionFeedback,
                    },
                    null,
                    2
                )
        )
        .join("\n\n");

    const figureLine = hasImages
        ? `\nNOTE: The diagram(s) for this question are ATTACHED as image(s) — use them in your re-derivation.`
        : q.imageUrls.length > 0
        ? `\nNOTE: This question references diagram(s) at: ${q.imageUrls.join(", ")} (image could not be loaded).`
        : "";

    return `You are the FINAL AGGREGATOR for a single question that ${agents.length} independent QC agent(s) have already reviewed. Re-derive the answer yourself, then reconcile with the agents.

QUESTION (subject: ${q.subject || "?"} / chapter: ${q.chapter || "?"}):
${q.questionText}
${figureLine}

${q.options.length > 0 ? "Options:\n" + q.options.map((o) => `  ${o.label}) ${o.text}`).join("\n") : ""}

Provided answer key: ${q.correctAnswer || "(none)"}

## Agent verdicts
${agentLines}

## Your task
1. Solve the question yourself — your finalAnswer must be your OWN independent derivation, not a vote.
2. Decide if the agents agree among themselves AND with the provided key.
3. Flag needsManualReview=true if ANY of: (a) agents disagree, (b) your answer differs from the provided key, (c) the question contains a figure AND any agent flagged an issue, (d) consolidatedErrors is non-empty.
4. Merge errorsFound / solutionFeedback from the agents (dedupe), preserving each
   item's MAJOR:/MODERATE:/MINOR: prefix. Never collapse several distinct defects
   into one vague line.

## finalAnswerConfidence — earn it, don't assume it
- "high"  ONLY if you derived the answer and it survived a second, different check,
           AND every agent that answered agrees with you.
- "medium" if it is settled but rests on a convention, an approximation, a rounding
           choice, or one agent dissenting.
- "low"    if the source is unclear or damaged, the question needs an unstated
           assumption, agents genuinely conflict, or a figure you cannot see is
           needed to decide.
Never report a low-confidence answer as if it were settled. If the question cannot
be decided at all, say so in manualReviewReason rather than picking an option.

## If no answer key was provided
Set agreementWithProvidedKey to null. Never claim a match or a mismatch against a
key that does not exist.

## Style — BE TERSE
- Each consolidatedErrors item: a short phrase, max ~12 words. Dedupe aggressively.
- consolidatedSolutionFeedback: one short line (max ~15 words), or "" if fine.
- manualReviewReason: one short phrase.
- aggregatorRationale: one short line, max ~20 words.

## Output — single JSON object, no markdown:
{
  "finalAnswer": <your re-derived answer>,
  "finalAnswerConfidence": "<high | medium | low>",
  "agreementWithProvidedKey": <true | false | null>,
  "needsManualReview": <true | false>,
  "manualReviewReason": "<short phrase, or empty string if needsManualReview=false>",
  "consolidatedErrors": ["<short error phrase>", ...],
  "consolidatedSolutionFeedback": "<one short line, or empty string>",
  "aggregatorRationale": "<one short line, max ~20 words>"
}`;
}

// ─── Per-question response normalisation ───────────────────────────────

function normalisePerQuestionAgent(
    raw: Record<string, unknown>,
    q: PreparsedQuestion,
    a: AgentConfig
): PerAgentQuestionResult {
    const errs = Array.isArray(raw.errorsFound) ? (raw.errorsFound as unknown[]).map(String) : [];
    const answer = (raw.aiAnswer ?? null) as string | number | null;
    return {
        label: a.label,
        provider: a.provider,
        modelId: a.modelId,
        status: "done",
        answer,
        correctness: String(raw.correctness || ""),
        errorsFound: errs,
        solutionFeedback: String(raw.solutionFeedback || ""),
        hasFigure: raw.hasFigure === true || q.imageUrls.length > 0,
        questionType: String(raw.questionType || q.questionType || ""),
        detectedChapter: raw.detectedChapter ? String(raw.detectedChapter) : null,
    };
}

function normalisePerQuestionAggregator(
    raw: Record<string, unknown>,
    q: PreparsedQuestion,
    perAgent: PerAgentQuestionResult[]
): AggregatorQuestionResult {
    const consolidatedErrors = Array.isArray(raw.consolidatedErrors)
        ? (raw.consolidatedErrors as unknown[]).map(String)
        : [];
    const finalAnswer = (raw.finalAnswer ?? null) as string | number | null;
    const providedKey = q.correctAnswer || null;
    let agreement: boolean | null = null;
    if (providedKey !== null && finalAnswer !== null) {
        agreement =
            String(finalAnswer).trim().toLowerCase() ===
            String(providedKey).trim().toLowerCase();
    }
    return {
        status: "done",
        finalAnswer,
        confidence:
            raw.finalAnswerConfidence === "high" || raw.finalAnswerConfidence === "low"
                ? (raw.finalAnswerConfidence as "high" | "low")
                : "medium",
        agreementWithProvidedKey:
            typeof raw.agreementWithProvidedKey === "boolean"
                ? (raw.agreementWithProvidedKey as boolean)
                : agreement,
        needsManualReview: raw.needsManualReview === true,
        manualReviewReason: raw.manualReviewReason ? String(raw.manualReviewReason) : null,
        consolidatedErrors,
        consolidatedSolutionFeedback: String(raw.consolidatedSolutionFeedback || ""),
        rationale: String(raw.aggregatorRationale || ""),
    };
}

/** Fallback aggregate when the aggregator LLM fails — majority vote. */
function voteAggregate(
    perAgent: PerAgentQuestionResult[],
    q: PreparsedQuestion
): AggregatorQuestionResult {
    const done = perAgent.filter((a) => a.status === "done");
    const counts = new Map<string, number>();
    for (const a of done) {
        if (a.answer === null) continue;
        const k = String(a.answer).trim();
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    let topAns: string | null = null;
    let topCount = 0;
    let tied = false;
    for (const [k, c] of counts) {
        if (c > topCount) {
            topCount = c;
            topAns = k;
            tied = false;
        } else if (c === topCount) {
            tied = true;
        }
    }
    if (tied) topAns = null;
    const providedKey = q.correctAnswer || null;
    let agreement: boolean | null = null;
    if (providedKey !== null && topAns !== null) {
        agreement =
            topAns.toLowerCase() === String(providedKey).trim().toLowerCase();
    }
    const allErrs = new Set<string>();
    for (const a of done) for (const e of a.errorsFound) allErrs.add(e);
    return {
        status: "failed",
        finalAnswer: topAns,
        confidence: tied ? "low" : topCount >= 2 ? "medium" : "low",
        agreementWithProvidedKey: agreement,
        needsManualReview: tied || agreement === false || q.imageUrls.length > 0 || allErrs.size > 0,
        manualReviewReason: tied
            ? "Agents disagreed; aggregator LLM also failed."
            : agreement === false
            ? "Vote disagrees with provided key (aggregator LLM failed)."
            : q.imageUrls.length > 0
            ? "Diagram present; aggregator LLM failed — verify visually."
            : "Aggregator LLM failed; result is a majority vote.",
        consolidatedErrors: Array.from(allErrs),
        consolidatedSolutionFeedback: done.map((a) => a.solutionFeedback).filter(Boolean).join(" | "),
        rationale: "(Aggregator LLM failed — majority vote across agents used as fallback.)",
    };
}

// ─── PAPER-LEVEL (combined / separate file mode) ───────────────────────

interface AgentRawReport {
    totalQuestions: number;
    overallSuggestions: string[];
    patternAnalysis: string;
    syllabusAnalysis: string;
    questions: AgentVerdictPerQuestion[];
}

interface AgentVerdictPerQuestion {
    questionNumber: number;
    questionSummary: string;
    hasFigure: boolean;
    questionType: string;
    aiAnswer: string | number | null;
    providedAnswer: string | number | null;
    answerMatch: boolean | null;
    correctness: string;
    errorsFound: string[];
    solutionFeedback: string;
}

async function runPaperLevel(input: ExecutorInput): Promise<void> {
    const { userId, jobId, files, qcAgents, aggregator, apiKeys } = input;
    if (!files?.questionFile)
        throw new Error("No question file provided for paper-level mode.");

    const agentFiles: FileInput[] = [files.questionFile];
    if (input.inputMode === "separate") {
        if (files.answerKeyFile) agentFiles.push(files.answerKeyFile);
        if (files.solutionFile) agentFiles.push(files.solutionFile);
    }

    // Each agent reads the whole paper.
    const agentResults = await Promise.allSettled(
        qcAgents.map(async (a) => {
            if (await isCancelled(userId, jobId)) throw new Error("Cancelled");
            await emitEvent(userId, jobId, {
                type: "agent_started",
                label: a.label,
                provider: a.provider,
                modelId: a.modelId,
            });
            const t0 = Date.now();
            try {
                const apiKey = apiKeys[a.provider];
                if (!apiKey) throw new Error(`No saved API key for ${a.provider}.`);
                const prompt = buildPaperLevelAgentPrompt(input);
                const { text: raw, usage } = await callAI(
                    a.provider as AIModelProvider,
                    a.modelId,
                    apiKey,
                    prompt,
                    agentFiles,
                    getAbortSignal(jobId)
                );
                await addTokenUsage(userId, jobId, {
                    provider: a.provider,
                    modelId: a.modelId,
                    label: a.label,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                });
                const parsed = parseJSONResponse(raw);
                const report = normalisePaperReport(parsed);
                await emitEvent(userId, jobId, {
                    type: "agent_completed",
                    label: a.label,
                    elapsedMs: Date.now() - t0,
                    totalQuestions: report.totalQuestions,
                });
                return { agent: a, report };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await emitEvent(userId, jobId, {
                    type: "agent_failed",
                    label: a.label,
                    error: msg,
                    elapsedMs: Date.now() - t0,
                });
                throw err;
            }
        })
    );

    const successful = agentResults
        .filter(
            (r): r is PromiseFulfilledResult<{ agent: AgentConfig; report: AgentRawReport }> =>
                r.status === "fulfilled"
        )
        .map((r) => r.value);

    if (successful.length === 0) {
        throw new Error("All QC agents failed in paper-level pass.");
    }

    // Build per-question rows from the union of question numbers seen.
    const qNums = new Set<number>();
    for (const s of successful) for (const q of s.report.questions) qNums.add(q.questionNumber);
    const sortedQNums = Array.from(qNums).sort((a, b) => a - b);

    await updateJob(userId, jobId, (j) => {
        j.questions = sortedQNums.map<JobQuestion>((qNum) => {
            const verdicts = successful
                .map(({ agent, report }) => {
                    const v = report.questions.find((qq) => qq.questionNumber === qNum);
                    if (!v) return null;
                    return { agent, v };
                })
                .filter((x): x is { agent: AgentConfig; v: AgentVerdictPerQuestion } => x !== null);
            const first = verdicts[0]?.v;
            return {
                questionNumber: qNum,
                questionSummary: first?.questionSummary || "",
                questionText: first?.questionSummary || "",
                providedAnswerKey: first?.providedAnswer ?? null,
                questionType: first?.questionType || "",
                hasFigure: verdicts.some((x) => x.v.hasFigure),
                imageUrls: [],
                agentResults: verdicts.map<PerAgentQuestionResult>(({ agent, v }) => ({
                    label: agent.label,
                    provider: agent.provider,
                    modelId: agent.modelId,
                    status: "done",
                    answer: v.aiAnswer,
                    correctness: v.correctness,
                    errorsFound: v.errorsFound,
                    solutionFeedback: v.solutionFeedback,
                    hasFigure: v.hasFigure,
                    questionType: v.questionType,
                })),
                aggregator: {
                    status: "pending",
                    finalAnswer: null,
                    confidence: "low",
                    agreementWithProvidedKey: null,
                    needsManualReview: false,
                    manualReviewReason: null,
                    consolidatedErrors: [],
                    consolidatedSolutionFeedback: "",
                    rationale: "",
                },
            };
        });
    });

    if (await isCancelled(userId, jobId)) return;

    // Aggregator over the whole paper.
    await emitEvent(userId, jobId, { type: "aggregator_started" });
    const tAgg = Date.now();
    try {
        const apiKey = apiKeys[aggregator.provider];
        if (!apiKey) throw new Error(`No saved API key for ${aggregator.provider}.`);
        const prompt = buildPaperLevelAggregatorPrompt(successful, input);
        const { text: raw, usage } = await callAI(
            aggregator.provider as AIModelProvider,
            aggregator.modelId,
            apiKey,
            prompt,
            agentFiles,
            getAbortSignal(jobId)
        );
        await addTokenUsage(userId, jobId, {
            provider: aggregator.provider,
            modelId: aggregator.modelId,
            label: aggregator.label || "Aggregator",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
        });
        const parsed = parseJSONResponse(raw);
        // Distribute the aggregator's per-question results into our rows.
        const aggQ = Array.isArray(parsed.questions) ? (parsed.questions as Record<string, unknown>[]) : [];
        await updateJob(userId, jobId, (j) => {
            for (const ag of aggQ) {
                const qNum = Number(ag.questionNumber) || 0;
                const row = j.questions.find((x) => x.questionNumber === qNum);
                if (!row) continue;
                const finalAnswer = (ag.finalAnswer ?? null) as string | number | null;
                row.aggregator = {
                    status: "done",
                    finalAnswer,
                    confidence:
                        ag.finalAnswerConfidence === "high" || ag.finalAnswerConfidence === "low"
                            ? (ag.finalAnswerConfidence as "high" | "low")
                            : "medium",
                    agreementWithProvidedKey:
                        ag.agreementWithProvidedKey === true
                            ? true
                            : ag.agreementWithProvidedKey === false
                            ? false
                            : null,
                    needsManualReview: ag.needsManualReview === true,
                    manualReviewReason: ag.manualReviewReason ? String(ag.manualReviewReason) : null,
                    consolidatedErrors: Array.isArray(ag.consolidatedErrors)
                        ? (ag.consolidatedErrors as unknown[]).map(String)
                        : [],
                    consolidatedSolutionFeedback: String(ag.consolidatedSolutionFeedback || ""),
                    rationale: String(ag.aggregatorRationale || ""),
                };
            }
            j.paperAnalysis.patternAnalysis = String(parsed.patternAnalysis || "");
            j.paperAnalysis.syllabusAnalysis = String(parsed.syllabusAnalysis || "");
            j.paperAnalysis.overallSuggestions = Array.isArray(parsed.overallSuggestions)
                ? (parsed.overallSuggestions as unknown[]).map(String)
                : [];
        });
        await emitEvent(userId, jobId, {
            type: "aggregator_completed",
            elapsedMs: Date.now() - tAgg,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fall back to per-question voting across the per-agent reports.
        await updateJob(userId, jobId, (j) => {
            j.partial = true;
            j.partialReason = `Aggregator failed: ${msg}`;
            for (const row of j.questions) {
                const counts = new Map<string, number>();
                for (const ar of row.agentResults) {
                    if (ar.status !== "done" || ar.answer === null) continue;
                    const k = String(ar.answer).trim();
                    if (!k) continue;
                    counts.set(k, (counts.get(k) || 0) + 1);
                }
                let top: string | null = null;
                let topC = 0;
                let tied = false;
                for (const [k, c] of counts) {
                    if (c > topC) {
                        topC = c;
                        top = k;
                        tied = false;
                    } else if (c === topC) tied = true;
                }
                if (tied) top = null;
                const providedKey = row.providedAnswerKey;
                let agreement: boolean | null = null;
                if (providedKey !== null && top !== null) {
                    agreement =
                        top.toLowerCase() === String(providedKey).trim().toLowerCase();
                }
                const allErrs = new Set<string>();
                for (const a of row.agentResults) for (const e of a.errorsFound) allErrs.add(e);
                row.aggregator = {
                    status: "failed",
                    finalAnswer: top,
                    confidence: tied ? "low" : topC >= 2 ? "medium" : "low",
                    agreementWithProvidedKey: agreement,
                    needsManualReview:
                        tied || agreement === false || row.hasFigure || allErrs.size > 0,
                    manualReviewReason:
                        "(Aggregator failed — answer derived by vote across QC agents.)",
                    consolidatedErrors: Array.from(allErrs),
                    consolidatedSolutionFeedback: row.agentResults
                        .map((a) => a.solutionFeedback)
                        .filter(Boolean)
                        .join(" | "),
                    rationale: "(Aggregator LLM failed; vote-based fallback used.)",
                };
            }
        });
        await emitEvent(userId, jobId, {
            type: "aggregator_failed",
            error: msg,
            elapsedMs: Date.now() - tAgg,
        });
    }
}

function buildPaperLevelAgentPrompt(input: ExecutorInput): string {
    return `You are an independent quality-control reviewer for a competitive-exam paper (JEE / NEET / similar). Read the attached file(s) carefully, then for EACH question (up to 60) return a verdict.

Return ONLY a single JSON object, no markdown, no preamble:

{
  "totalQuestions": <number>,
  "overallSuggestions": ["..."],
  "patternAnalysis": "...",
  "syllabusAnalysis": "...",
  "questions": [
    {
      "questionNumber": 1,
      "questionSummary": "<first 80-120 chars>",
      "hasFigure": <true|false>,
      "questionType": "<SCQ|MCQ|Integer|Numerical|Assertion_Reason|Matching_List>",
      "aiAnswer": <your answer>,
      "providedAnswer": <answer key from paper, or null>,
      "answerMatch": <true|false|null>,
      "correctness": "<Correct|Incorrect|Partially Correct|Cannot Determine — 1-line>",
      "errorsFound": ["..."],
      "solutionFeedback": "..."
    }
  ]
}

Exam context: ${input.examType || "JEE/NEET"}; subjects expected: ${input.subjects?.join(", ") || "any"}.
Be thorough — even minor spelling / grammar issues count as errorsFound.`;
}

function buildPaperLevelAggregatorPrompt(
    successful: { agent: AgentConfig; report: AgentRawReport }[],
    input: ExecutorInput
): string {
    const agentSummaries = successful
        .map(
            ({ agent, report }, idx) =>
                `── Agent ${idx + 1} (${agent.label}: ${agent.provider}/${agent.modelId}) ──\n` +
                JSON.stringify(report, null, 2)
        )
        .join("\n\n");
    return `You are the FINAL AGGREGATOR. ${successful.length} agent(s) reviewed the attached paper. Re-derive each answer independently, then reconcile.

Return ONLY a JSON object with shape:
{
  "patternAnalysis": "...",
  "syllabusAnalysis": "...",
  "overallSuggestions": ["..."],
  "questions": [
    {
      "questionNumber": 1,
      "finalAnswer": <your answer>,
      "finalAnswerConfidence": "<high|medium|low>",
      "agreementWithProvidedKey": <true|false|null>,
      "needsManualReview": <true|false>,
      "manualReviewReason": "<reason, or empty if false>",
      "consolidatedErrors": ["..."],
      "consolidatedSolutionFeedback": "...",
      "aggregatorRationale": "<one sentence>"
    }
  ]
}

## Agent reports
${agentSummaries}

Exam context: ${input.examType || "JEE/NEET"}; subjects: ${input.subjects?.join(", ") || "any"}.`;
}

function normalisePaperReport(raw: Record<string, unknown>): AgentRawReport {
    const questions = Array.isArray(raw.questions) ? (raw.questions as Record<string, unknown>[]) : [];
    return {
        totalQuestions: Number(raw.totalQuestions) || questions.length,
        overallSuggestions: Array.isArray(raw.overallSuggestions)
            ? (raw.overallSuggestions as unknown[]).map(String)
            : [],
        patternAnalysis: String(raw.patternAnalysis || ""),
        syllabusAnalysis: String(raw.syllabusAnalysis || ""),
        questions: questions.map((q) => ({
            questionNumber: Number(q.questionNumber) || 0,
            questionSummary: String(q.questionSummary || ""),
            hasFigure: q.hasFigure === true,
            questionType: String(q.questionType || ""),
            aiAnswer: (q.aiAnswer ?? null) as string | number | null,
            providedAnswer: (q.providedAnswer ?? null) as string | number | null,
            answerMatch:
                q.answerMatch === true ? true : q.answerMatch === false ? false : null,
            correctness: String(q.correctness || ""),
            errorsFound: Array.isArray(q.errorsFound) ? (q.errorsFound as unknown[]).map(String) : [],
            solutionFeedback: String(q.solutionFeedback || ""),
        })),
    };
}
