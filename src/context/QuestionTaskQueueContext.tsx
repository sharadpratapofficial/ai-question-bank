"use client";

/**
 * In-memory queue for per-question AI tasks (translate / verify) that should
 * run in the background. The user can fire a task, close the edit modal, do
 * other work, and a floating notifier reports completion.
 *
 * Unlike AIJobQueueContext (which is tied to the persistent ai_reports table),
 * this queue is ephemeral. Translate jobs land in public.question_translations
 * automatically (via the translate API). Verify jobs round-trip the result
 * through onComplete so the caller can persist to qbg_questions.raw_data.
 */

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";

export type QuestionTaskKind = "translate" | "verify" | "test_verify" | "test_translate";
export type QuestionTaskStatus = "running" | "done" | "error";

export interface QuestionTask {
    id: string;
    kind: QuestionTaskKind;
    questionId: string;
    /** Short human-readable subject for the notifier (e.g. question_id or qbg_id) */
    label: string;
    /** Additional context shown under the label (e.g. "Hindi", "Claude 4") */
    detail: string;
    status: QuestionTaskStatus;
    error?: string;
    /** Result returned by the API call when status === "done" */
    result?: unknown;
    createdAt: number;
    finishedAt?: number;
}

interface EnqueueArgs {
    kind: QuestionTaskKind;
    questionId: string;
    label: string;
    detail: string;
    /** Async work that yields the result. Errors surface as task.error. */
    run: () => Promise<unknown>;
    /** Optional callback fired after a successful run (e.g. to refresh state). */
    onComplete?: (result: unknown) => void | Promise<void>;
}

interface ContextValue {
    tasks: QuestionTask[];
    runningCount: number;
    enqueue: (args: EnqueueArgs) => string;
    dismiss: (id: string) => void;
    clearDone: () => void;
}

const QuestionTaskQueueContext = createContext<ContextValue | null>(null);

export function useQuestionTaskQueue(): ContextValue {
    const ctx = useContext(QuestionTaskQueueContext);
    if (!ctx) {
        throw new Error(
            "useQuestionTaskQueue must be used inside <QuestionTaskQueueProvider>"
        );
    }
    return ctx;
}

const DONE_AUTO_DISMISS_MS = 15_000;

export function QuestionTaskQueueProvider({ children }: { children: React.ReactNode }) {
    const [tasks, setTasks] = useState<QuestionTask[]>([]);
    // Hold the onComplete callbacks outside React state so they can be invoked
    // without serialisation concerns.
    const callbacksRef = useRef<Map<string, EnqueueArgs["onComplete"]>>(new Map());

    const updateTask = useCallback((id: string, patch: Partial<QuestionTask>) => {
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    }, []);

    const enqueue = useCallback(
        ({ kind, questionId, label, detail, run, onComplete }: EnqueueArgs): string => {
            const id =
                typeof crypto !== "undefined" && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const newTask: QuestionTask = {
                id,
                kind,
                questionId,
                label,
                detail,
                status: "running",
                createdAt: Date.now(),
            };
            setTasks((prev) => [newTask, ...prev]);
            if (onComplete) callbacksRef.current.set(id, onComplete);

            // Fire the actual work outside the state update.
            (async () => {
                try {
                    const result = await run();
                    updateTask(id, {
                        status: "done",
                        result,
                        finishedAt: Date.now(),
                    });
                    const cb = callbacksRef.current.get(id);
                    if (cb) {
                        try {
                            await cb(result);
                        } catch (cbErr) {
                            console.warn("QuestionTask onComplete threw:", cbErr);
                        }
                    }
                } catch (err) {
                    updateTask(id, {
                        status: "error",
                        error: err instanceof Error ? err.message : String(err),
                        finishedAt: Date.now(),
                    });
                } finally {
                    callbacksRef.current.delete(id);
                }
            })();

            return id;
        },
        [updateTask]
    );

    const dismiss = useCallback((id: string) => {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        callbacksRef.current.delete(id);
    }, []);

    const clearDone = useCallback(() => {
        setTasks((prev) => prev.filter((t) => t.status === "running"));
    }, []);

    // Auto-dismiss completed tasks after a while so the notifier doesn't grow forever.
    useEffect(() => {
        const doneOrErrored = tasks.filter(
            (t) => (t.status === "done" || t.status === "error") && t.finishedAt
        );
        if (doneOrErrored.length === 0) return;
        const timers = doneOrErrored.map((t) => {
            const elapsed = Date.now() - (t.finishedAt || Date.now());
            const wait = Math.max(2_000, DONE_AUTO_DISMISS_MS - elapsed);
            return setTimeout(() => dismiss(t.id), wait);
        });
        return () => timers.forEach((tm) => clearTimeout(tm));
    }, [tasks, dismiss]);

    const runningCount = tasks.filter((t) => t.status === "running").length;

    const value: ContextValue = {
        tasks,
        runningCount,
        enqueue,
        dismiss,
        clearDone,
    };

    return (
        <QuestionTaskQueueContext.Provider value={value}>
            {children}
        </QuestionTaskQueueContext.Provider>
    );
}
