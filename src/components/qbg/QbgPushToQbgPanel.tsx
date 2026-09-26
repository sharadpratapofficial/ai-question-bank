"use client";

/**
 * Push questions to QBG AFTER the run that produced them.
 *
 * The "Push to QBG" tick is chosen before a run starts, so forgetting it used to
 * mean re-running the whole AI extraction just to get the questions into QBG.
 * This pushes work that already exists, in two modes:
 *
 *   mode="records" — the questions the finished run is showing on screen. Their
 *                    diagrams travel as inlined base64 and are uploaded to QBG.
 *   mode="csv"     — a QBG CSV downloaded earlier (this run's or an older one).
 *                    The "QBG CSV" / "Modified CSV" downloads keep their diagrams
 *                    inline; an "Original CSV" has them stripped, and the push
 *                    reports how many images were missing rather than hiding it.
 */

import { useCallback, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Loader2, Tags, Upload } from "lucide-react";
import { pollQbgJob } from "@/lib/api/qbgJobPoll";
import QbgProgressLog, { type ProgressEvent } from "@/components/qbg/QbgProgressLog";
import { QBG_CATEGORIES } from "@/lib/qbgCategories";
import { tagQbgIds, type TagIdsResult } from "@/lib/api/qbgTagIds";
import { checkQbgTokenBeforeRun } from "@/lib/qbgToken";

const QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

export interface PushRecord {
    content: string;
    options: { isCorrect: boolean | null; text: string | null }[];
    solution: string;
    answer?: string | null;
}
export interface PushMeta {
    num?: number | null;
    type?: string | null;
    answer?: string | string[] | null;
}

interface PushResult {
    count?: number;
    pushed?: number;
    qbgResults?: { num: number; unique_id: string | null; ok: boolean; error?: string }[];
    blankImages?: number;
    warnings?: string[];
    [k: string]: unknown;
}

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 14,
};
const select: React.CSSProperties = {
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.85rem",
    padding: "8px 10px",
    outline: "none",
};

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
    } catch {
        return false;
    }
}

export default function QbgPushToQbgPanel({
    mode,
    records,
    meta,
    label,
    devHeaders,
    title,
    hint,
    tagProvider,
    tagModelId,
    tagDevHeaders,
}: {
    mode: "records" | "csv";
    records?: PushRecord[];
    meta?: PushMeta[];
    /** Task label, so the push is traceable to the run it came from. */
    label?: string;
    /** Dev-auth headers (x-dev-qbg) when the app runs without a session. */
    devHeaders?: () => Record<string, string>;
    title?: string;
    hint?: string;
    /** Supply both to offer "then AI-tag the pushed questions". Omitted = no
     *  tagging option (there is no model to tag with). */
    tagProvider?: string;
    tagModelId?: string;
    /** Dev-auth headers for tagging — needs the MODEL key as well as QBG creds. */
    tagDevHeaders?: () => Record<string, string>;
}) {
    const canTag = Boolean(tagProvider && tagModelId?.trim());
    const [categoryName, setCategoryName] = useState("JEE");
    const [csvType, setCsvType] = useState<"SCQ" | "MCQ" | "Numerical">("SCQ");
    const [csvName, setCsvName] = useState<string | null>(null);
    const [csvText, setCsvText] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<ProgressEvent[]>([]);
    const [result, setResult] = useState<PushResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const [tagAfter, setTagAfter] = useState(false);
    const [tagging, setTagging] = useState(false);
    const [tagResult, setTagResult] = useState<TagIdsResult | null>(null);
    const [tagError, setTagError] = useState<string | null>(null);

    const count = mode === "records" ? records?.length ?? 0 : 0;

    const onPickCsv = useCallback(async (file: File | null) => {
        setError(null);
        setResult(null);
        if (!file) {
            setCsvName(null);
            setCsvText("");
            return;
        }
        if (!/\.csv$/i.test(file.name)) {
            setError("Choose a .csv file — the QBG CSV a run produced.");
            return;
        }
        const text = await file.text();
        // Cheap shape check, so a wrong file fails here rather than mid-push.
        const head = text.slice(0, 400).toLowerCase();
        if (!head.includes("content") || !head.includes("bilingual_options")) {
            setError(
                "That doesn't look like a QBG CSV — it should start with the columns " +
                    "content, bilingual_options, solutions."
            );
            setCsvName(null);
            setCsvText("");
            return;
        }
        setCsvName(file.name);
        setCsvText(text);
    }, []);

    const run = useCallback(async () => {
        setError(null);
        setResult(null);
        setProgress([]);
        if (!QBG_CATEGORIES[categoryName]) {
            setError("Choose a QBG category to push to.");
            return;
        }
        if (mode === "records" && (!records || records.length === 0)) {
            setError("There are no questions to push.");
            return;
        }
        if (mode === "csv" && !csvText) {
            setError("Choose the QBG CSV to upload first.");
            return;
        }
        setBusy(true);
        try {
            // Same pre-flight as the runs that feed this panel: say "your token has
            // expired" up front instead of a column of per-question push failures.
            const gate = await checkQbgTokenBeforeRun();
            if (!gate.proceed) {
                setError(gate.error || "QBG token check failed.");
                return;
            }
            const data = await pollQbgJob<PushResult>({
                startUrl: "/api/ai-tools/qbg-push",
                startBody:
                    mode === "records"
                        ? {
                              records,
                              meta: meta || [],
                              category: QBG_CATEGORIES[categoryName],
                              label: label || `Push · ${records!.length} question(s)`,
                          }
                        : {
                              csv: csvText,
                              csvType,
                              category: QBG_CATEGORIES[categoryName],
                              label: `Push CSV · ${csvName}`,
                          },
                startHeaders: devHeaders?.() || {},
                buildPollUrl: (jobId) => `/api/ai-tools/qbg-push?jobId=${encodeURIComponent(jobId)}`,
                kind: "qbg_push",
                label: label || "QBG push",
                onProgress: setProgress,
            });
            setResult(data);

            // Tag what was just created. Kept separate from the push result: the
            // questions exist in QBG either way, so a tagging failure is reported
            // on its own line rather than failing the push.
            const newIds = (data.qbgResults || [])
                .filter((r) => r.ok && r.unique_id)
                .map((r) => r.unique_id as string);
            if (tagAfter && canTag && newIds.length > 0) {
                setTagging(true);
                setTagResult(null);
                setTagError(null);
                try {
                    setTagResult(
                        await tagQbgIds({
                            ids: newIds,
                            provider: tagProvider!,
                            modelId: tagModelId!,
                            headers: tagDevHeaders?.() || devHeaders?.() || {},
                            label: `Tag after push · ${newIds.length} ID(s)`,
                        })
                    );
                } catch (err) {
                    setTagError(err instanceof Error ? err.message : String(err));
                } finally {
                    setTagging(false);
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [canTag, categoryName, csvName, csvText, csvType, devHeaders, label, meta, mode,
        records, tagAfter, tagDevHeaders, tagModelId, tagProvider]);

    const okIds = (result?.qbgResults || []).filter((r) => r.ok && r.unique_id).map((r) => r.unique_id as string);

    return (
        <div style={{ ...card, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: "0.85rem", color: "var(--text-primary)" }}>
                <Upload size={15} color="var(--accent-primary)" />
                {title || (mode === "records" ? "Push these questions to QBG" : "Upload a QBG CSV into QBG")}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)" }}>
                {hint ||
                    (mode === "records"
                        ? `Sends the ${count} extracted question(s) above to QBG — no re-extraction, no model cost. Diagrams are uploaded with them.`
                        : "Pushes the rows of a QBG CSV produced by an earlier run. Diagrams travel with it when the CSV kept them inline.")}
            </div>

            {mode === "csv" && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => void onPickCsv(e.target.files?.[0] || null)}
                        style={{ display: "none" }}
                    />
                    <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        style={{ ...select, cursor: busy ? "default" : "pointer", fontWeight: 600 }}
                    >
                        {csvName ? `Selected: ${csvName}` : "Choose QBG CSV…"}
                    </button>
                    <label style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
                        Question type
                        <select
                            value={csvType}
                            onChange={(e) => setCsvType(e.target.value as "SCQ" | "MCQ" | "Numerical")}
                            style={select}
                            disabled={busy}
                        >
                            <option value="SCQ">SCQ (single correct)</option>
                            <option value="MCQ">MCQ (multi correct)</option>
                            <option value="Numerical">Numerical</option>
                        </select>
                    </label>
                </div>
            )}
            {mode === "csv" && (
                <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    A CSV has no type column, so every row is pushed as the type chosen here. Rows
                    with no options are pushed as Numerical regardless.
                </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
                    Category
                    <select
                        value={categoryName}
                        onChange={(e) => setCategoryName(e.target.value)}
                        style={select}
                        disabled={busy}
                    >
                        {Object.keys(QBG_CATEGORIES).map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                </label>
                {canTag && (
                    <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <input
                            type="checkbox"
                            checked={tagAfter}
                            onChange={(e) => setTagAfter(e.target.checked)}
                            disabled={busy}
                        />
                        <Tags size={14} color="var(--accent-primary)" />
                        Then AI-tag the pushed questions
                    </label>
                )}
                <button
                    type="button"
                    onClick={() => void run()}
                    disabled={busy || (mode === "csv" && !csvText) || (mode === "records" && count === 0)}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        border: "1px solid var(--accent-primary)",
                        borderRadius: 9,
                        background: "var(--accent-primary)",
                        color: "#fff",
                        fontSize: "0.82rem",
                        fontWeight: 700,
                        padding: "9px 15px",
                        cursor: busy ? "default" : "pointer",
                        opacity: busy || (mode === "csv" && !csvText) ? 0.6 : 1,
                    }}
                >
                    {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                    {busy ? "Pushing…" : mode === "records" ? `Push ${count} question(s)` : "Push CSV to QBG"}
                </button>
            </div>

            {busy && progress.length > 0 && <QbgProgressLog progress={progress} />}

            {error && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.8rem", color: "var(--accent-danger)" }}>
                    <AlertCircle size={14} /> {error}
                </div>
            )}

            {result && (
                <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                        <CheckCircle2 size={14} color="var(--accent-success)" />
                        Pushed {result.pushed ?? 0} of {result.count ?? 0} question(s) to {categoryName}.
                    </div>
                    {(result.warnings || []).map((w, i) => (
                        <div key={i} style={{ fontSize: "0.78rem", color: "var(--accent-warning)" }}>
                            {w}
                        </div>
                    ))}
                    {okIds.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                void copyText(okIds.join("\n")).then((ok) => {
                                    if (ok) {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    }
                                });
                            }}
                            style={{ ...select, cursor: "pointer", width: "fit-content", display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                            <Copy size={13} /> {copied ? "Copied!" : `Copy ${okIds.length} new QBG ID(s)`}
                        </button>
                    )}
                    <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                        {(result.qbgResults || []).map((r, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.76rem" }}>
                                {r.ok ? (
                                    <CheckCircle2 size={13} color="var(--accent-success)" />
                                ) : (
                                    <AlertCircle size={13} color="var(--accent-danger)" />
                                )}
                                <span style={{ color: "var(--text-tertiary)" }}>Q{r.num}</span>
                                {r.unique_id ? (
                                    <a
                                        href={QUESTION_URL + encodeURIComponent(r.unique_id)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ fontFamily: "ui-monospace, monospace", color: "var(--accent-primary)" }}
                                    >
                                        {r.unique_id}
                                    </a>
                                ) : (
                                    <span style={{ color: "var(--text-tertiary)" }}>(no id)</span>
                                )}
                                {!r.ok && r.error && <span style={{ color: "var(--accent-danger)" }}>{r.error}</span>}
                            </div>
                        ))}
                    </div>

                    {(tagging || tagResult || tagError) && (
                        <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                                {tagging ? <Loader2 size={14} className="spin" /> : <Tags size={14} color="var(--accent-primary)" />}
                                {tagging
                                    ? "Tagging the pushed questions…"
                                    : tagError
                                      ? "Tagging failed"
                                      : `Tagged ${tagResult?.tagged ?? 0} of ${tagResult?.count ?? 0} question(s)`}
                            </div>
                            {tagError && (
                                <div style={{ fontSize: "0.78rem", color: "var(--accent-danger)" }}>
                                    {tagError}
                                    <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>
                                        The questions are in QBG — only tagging failed. Retry from the QBG Tagging tab
                                        with the ids above.
                                    </div>
                                </div>
                            )}
                            {(tagResult?.results || []).map((r, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.75rem", flexWrap: "wrap" }}>
                                    {r.ok ? (
                                        <CheckCircle2 size={12} color="var(--accent-success)" />
                                    ) : (
                                        <AlertCircle size={12} color="var(--accent-danger)" />
                                    )}
                                    <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--text-tertiary)" }}>
                                        {r.qbg_id || "(no id)"}
                                    </span>
                                    {r.ok && r.meta && (
                                        <span style={{ color: "var(--text-tertiary)" }}>
                                            {[r.meta.subject_name, r.meta.chapter_name, r.meta.topic_name]
                                                .filter(Boolean)
                                                .join(" › ")}
                                        </span>
                                    )}
                                    {!r.ok && r.error && <span style={{ color: "var(--accent-danger)" }}>{r.error}</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
