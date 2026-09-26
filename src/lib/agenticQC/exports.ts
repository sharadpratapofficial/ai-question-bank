/**
 * Client-side exporters for Agentic QC reports — Excel (.xlsx) and PDF.
 *
 * PDF design goals (per user feedback):
 *   - Top summary table: Q# · Has Diagram · Provided Answer · per-Agent Answer
 *     · Final Answer, with each cell colour-coded:
 *       GREEN  — agent / final matches the source-of-truth
 *       RED    — answer key mismatch OR question marked unsolvable
 *       YELLOW — minor issue only (spelling, grammar, suggestion, solution
 *                feedback, needs-review without a hard error)
 *   - Per-question detail blocks below the table render:
 *       - The full question text + options (correct option highlighted green)
 *       - Any embedded diagram URLs are fetched and inlined as images
 *       - Errors classified into "Critical" (red) vs "Minor" (yellow)
 *   - All timestamps in IST (UTC+5:30) — `Asia/Kolkata` via Intl.
 *
 * Filenames include the source paper's name so multiple downloads stay
 * distinguishable in a Downloads folder.
 */
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";
import type { JobRecord } from "./jobStore";
import { buildCostSummary, computeTokenCost } from "./pricing";

/**
 * ASCII-only number formatters for the PDF. jsPDF's built-in WinAnsi font
 * cannot render the ₹ glyph (U+20B9) and, worse, mis-measures any string that
 * contains it — which spaces the digits out ("1 3 . 5 2"). So in the PDF we
 * omit the ₹ symbol (the column header already says "(INR)") and use the en-US
 * locale, whose grouping/decimal separators are plain ASCII comma + period.
 */
function pdfMoney(n: number): string {
    return (Math.round(n * 100) / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
function pdfInt(n: number): string {
    return Math.round(n).toLocaleString("en-US");
}

// ─── Shared helpers ─────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as Indian Standard Time (UTC+5:30, "Asia/Kolkata").
 * Used everywhere a date is shown in a downloaded report so the user always
 * sees their local time, never the server's UTC.
 */
export function formatIST(iso: string | null | undefined, opts?: { withTimezoneSuffix?: boolean }): string {
    if (!iso) return "";
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const parts = new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(d);
        // en-IN formats as "DD-MMM-YYYY, HH:MM:SS" — convert to nicer form.
        const cleaned = parts.replace(",", "");
        return opts?.withTimezoneSuffix === false ? cleaned : `${cleaned} IST`;
    } catch {
        return iso;
    }
}

/**
 * Sanitize a name to be safe across all OSes (Windows/macOS/Linux). Keeps
 * alnum + dash + underscore, replaces everything else with `_`, collapses
 * runs, trims to a reasonable length, and removes any trailing dots/spaces
 * which Windows refuses.
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/\.[^.]+$/, "") // drop the original extension if any
        .replace(/[^a-zA-Z0-9_\-.]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[_.]+|[_.]+$/g, "")
        .slice(0, 80);
}

/**
 * Build a download filename that includes the source paper's name so the
 * user can tell two reports apart in their downloads folder.
 *
 * Example:
 *   buildFilename(job, "xlsx") → "MHT_CET_Test_1_Physics_agentic-qc.xlsx"
 */
export function buildFilename(job: JobRecord, ext: string): string {
    const rawBase =
        job.sourceFileName?.trim() ||
        job.label?.trim() ||
        `agentic-qc-${job.id.slice(0, 8)}`;
    const base = sanitizeFilename(rawBase);
    return `${base || "agentic-qc"}_agentic-qc.${ext}`;
}

/**
 * Classify each error string into "critical" or "minor".
 *
 * CRITICAL — strong signals the question is broken / wrong:
 *   - "missing data", "data needed", "incomplete", "cannot be solved"
 *   - "contradiction", "ambiguous", "wrong answer", "incorrect answer"
 *   - "wrong final answer", "data mismatch", "no correct option"
 *
 * MINOR — everything else, typically:
 *   - spelling / grammar / typo / language
 *   - suggestion / improvement / clarification
 *   - "solution too short", "solution too verbose"
 *   - figure-referenced-but-not-rendered (visual only)
 */
export function classifyErrors(errors: string[]): {
    critical: string[];
    minor: string[];
} {
    const critical: string[] = [];
    const minor: string[] = [];
    const criticalSignals = [
        "missing data",
        "data needed",
        "data missing",
        "incomplete",
        "cannot be solved",
        "cannot determine",
        "not solvable",
        "unsolvable",
        "contradict",
        "ambiguous",
        "wrong answer",
        "incorrect answer",
        "wrong final answer",
        "answer key mismatch",
        "key mismatch",
        "no correct option",
        "data mismatch",
        "repeated option",
        "duplicate option",
    ];
    for (const raw of errors) {
        const lower = raw.toLowerCase();
        if (criticalSignals.some((sig) => lower.includes(sig))) {
            critical.push(raw);
        } else {
            minor.push(raw);
        }
    }
    return { critical, minor };
}

/** True if the question has a hard error (mismatch or unsolvable). */
function questionHasCriticalError(q: JobRecord["questions"][number]): boolean {
    if (q.aggregator.agreementWithProvidedKey === false) return true;
    if (q.aggregator.status === "skipped") return true;
    const { critical } = classifyErrors(q.aggregator.consolidatedErrors);
    return critical.length > 0;
}

/** True if the question has a minor issue worth highlighting yellow. */
function questionHasMinorIssue(q: JobRecord["questions"][number]): boolean {
    if (questionHasCriticalError(q)) return false; // critical wins
    if (q.aggregator.consolidatedErrors.length > 0) return true;
    if (q.aggregator.needsManualReview) return true;
    if (q.aggregator.consolidatedSolutionFeedback?.trim()) return true;
    return false;
}

const normAns = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * Confidence score (0-100%) for a question, derived from how strongly the QC
 * agents and the aggregator agree, plus whether any errors were found.
 *
 * Reaches 100% when EVERY QC agent produced an answer, all of those answers
 * match the aggregator's final answer, the aggregator agrees with the provided
 * key (or there's no key to disagree with), and no errors were flagged. Each
 * weakness — a missing agent answer, a disagreeing agent, a key mismatch, or
 * an error — pulls the score down proportionally.
 */
export function computeConfidencePercent(q: JobRecord["questions"][number]): number {
    const agents = q.agentResults;
    const total = agents.length;
    const agg = q.aggregator;
    let score = 100;

    // 1. QC agents that actually produced a usable answer.
    const answered = agents.filter(
        (a) =>
            a.status === "done" &&
            a.answer !== null &&
            a.answer !== undefined &&
            String(a.answer).trim() !== ""
    );
    if (total > 0) {
        const missingFrac = (total - answered.length) / total;
        score -= missingFrac * 35;
    }

    // 2. How many answering agents agree with the aggregator's final answer.
    const final = agg.finalAnswer;
    if (final !== null && final !== undefined && answered.length > 0) {
        const agree = answered.filter((a) => normAns(a.answer) === normAns(final)).length;
        const disagreeFrac = (answered.length - agree) / answered.length;
        score -= disagreeFrac * 30;
    }

    // 3. Aggregator vs the provided answer key.
    if (agg.agreementWithProvidedKey === false) score -= 30;

    // 4. Errors flagged.
    const { critical, minor } = classifyErrors(agg.consolidatedErrors);
    if (critical.length > 0) score -= 25;
    else if (minor.length > 0) score -= 10;

    // 5. Aggregator never reached a real verdict (all agents failed / fell back
    //    to a majority vote).
    if (agg.status === "skipped" || agg.status === "failed") score -= 25;

    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Normalise a question for duplicate detection — lowercase, strip HTML-ish
 * punctuation and collapse whitespace, then cap the length. Exact-match on this
 * key catches verbatim / near-verbatim repeats within the same paper.
 */
function dupKey(text: string): string {
    return String(text || "")
        .toLowerCase()
        .replace(/<[^>]+>/g, " ")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
}

/** Groups of question numbers whose (normalised) text repeats within the paper. */
export function findRepeatedQuestions(
    job: JobRecord
): { questionNumbers: number[]; preview: string }[] {
    const map = new Map<string, { nums: number[]; preview: string }>();
    for (const q of job.questions) {
        const key = dupKey(q.questionText || q.questionSummary || "");
        if (key.length < 25) continue; // too short to compare reliably
        const entry = map.get(key);
        if (entry) entry.nums.push(q.questionNumber);
        else
            map.set(key, {
                nums: [q.questionNumber],
                preview: (q.questionText || q.questionSummary || "").replace(/\s+/g, " ").trim().slice(0, 70),
            });
    }
    return Array.from(map.values())
        .filter((e) => e.nums.length > 1)
        .map((e) => ({ questionNumbers: e.nums, preview: e.preview }));
}

/**
 * Per-subject → per-chapter question counts plus syllabus-aware flagging.
 *
 * For each subject the analysis produces:
 *   - chapters: sorted by count desc
 *   - notInSyllabus: chapters that have questions but aren't in the syllabus
 *   - missingFromPaper: chapters listed in the syllabus but 0 questions present
 *   - heavy: chapters whose count is ≥2× the per-subject average (imbalance)
 *
 * When no syllabus is supplied, notInSyllabus and missingFromPaper are empty.
 */
export function chapterDistribution(
    job: JobRecord
): {
    subject: string;
    total: number;
    chapters: { chapter: string; count: number }[];
    notInSyllabus: string[];
    missingFromPaper: string[];
    heavy: string[];
}[] {
    const syllabus: Record<string, string[]> = job.syllabus || {};

    // Normalize a chapter name for comparison: lowercase, strip spaces/punctuation.
    const norm = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

    const bySubject = new Map<string, Map<string, number>>();
    for (const q of job.questions) {
        const subject = (q.subject || "(unspecified)").trim() || "(unspecified)";
        const chapter = (q.chapter || "(unspecified)").trim() || "(unspecified)";
        if (!bySubject.has(subject)) bySubject.set(subject, new Map());
        const chMap = bySubject.get(subject)!;
        chMap.set(chapter, (chMap.get(chapter) || 0) + 1);
    }

    return Array.from(bySubject.entries()).map(([subject, chMap]) => {
        const chapters = Array.from(chMap.entries())
            .map(([chapter, count]) => ({ chapter, count }))
            .sort((a, b) => b.count - a.count);
        const total = chapters.reduce((s, c) => s + c.count, 0);
        const avg = total / Math.max(1, chapters.length);

        // Chapters where count ≥ 2× average (only flag when avg > 1 to avoid
        // noise on small papers).
        const heavy = avg > 1
            ? chapters.filter((c) => c.count >= avg * 2).map((c) => c.chapter)
            : [];

        // Syllabus matching — look up by subject name (case-insensitive).
        const syllabusEntry =
            Object.entries(syllabus).find(([k]) => norm(k) === norm(subject))?.[1] ?? null;

        let notInSyllabus: string[] = [];
        let missingFromPaper: string[] = [];

        if (syllabusEntry && syllabusEntry.length > 0) {
            const syllabusNorms = syllabusEntry.map(norm);
            // Chapter in paper but not listed in syllabus.
            notInSyllabus = chapters
                .filter(
                    (c) =>
                        c.chapter !== "(unspecified)" &&
                        !syllabusNorms.includes(norm(c.chapter))
                )
                .map((c) => c.chapter);
            // Chapter in syllabus but no question from it.
            const paperNorms = new Set(chapters.map((c) => norm(c.chapter)));
            missingFromPaper = syllabusEntry.filter(
                (ch) => !paperNorms.has(norm(ch))
            );
        }

        return { subject, total, chapters, notInSyllabus, missingFromPaper, heavy };
    });
}

/**
 * The syllabus to show in a report, restricted to the subjects the user
 * actually selected for this paper. If only "Physics" was selected, only the
 * Physics syllabus is returned — so the report mirrors the paper's scope. When
 * the job carries no subject selection, the full syllabus is returned as-is.
 */
export function selectedSyllabusEntries(job: JobRecord): [string, string[]][] {
    const syllabus = job.syllabus || {};
    const entries = Object.entries(syllabus);
    const subjects = job.subjects || [];
    if (subjects.length === 0) return entries;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
    const selected = new Set(subjects.map(norm));
    const filtered = entries.filter(([subj]) => selected.has(norm(subj)));
    // If the filter removes everything (e.g. subject names don't line up with
    // the syllabus keys), fall back to showing the full syllabus rather than
    // a blank section.
    return filtered.length > 0 ? filtered : entries;
}

/** Human-readable difficulty label. PW uses a 1-4 index; show the word + index. */
export function difficultyLabel(d: number | null | undefined): string {
    if (d === null || d === undefined) return "";
    const map: Record<number, string> = { 1: "Easy", 2: "Medium", 3: "Hard", 4: "Very Hard" };
    return map[d] ? `${map[d]} (${d})` : String(d);
}

// ─── EXCEL ──────────────────────────────────────────────────────────────

export function downloadJobAsExcel(job: JobRecord): void {
    const wb = XLSX.utils.book_new();
    const agentLabels = job.qcAgents.map((a) => a.label);
    const header = [
        "Q#",
        "QBG ID",
        "Subject",
        "Chapter",
        "Topic",
        "Difficulty",
        "Provided Answer Key",
        "Has Diagram",
        "Video Solution",
        "Text Solution Present",
        "Question Type",
        ...agentLabels.flatMap((l) => [`${l} Answer`, `${l} Errors`]),
        "Final Answer",
        "Confidence %",
        "Confidence",
        "Needs Manual Review",
        "Manual Review Reason",
        "Consolidated Errors",
        "Solution Feedback",
        "Aggregator Rationale",
        "Question Summary",
    ];
    const rows = job.questions.map((q) => {
        const agentCells = agentLabels.flatMap((label) => {
            const r = q.agentResults.find((x) => x.label === label);
            if (!r) return ["", ""];
            if (r.status === "failed") {
                return [`ERROR: ${r.error || "agent failed"}`, ""];
            }
            return [
                r.answer === null ? "" : String(r.answer),
                r.errorsFound.join(" | "),
            ];
        });
        return [
            q.questionNumber,
            q.qbgId || "",
            q.subject || "",
            q.chapter || "",
            q.topic || "",
            difficultyLabel(q.difficulty),
            q.providedAnswerKey === null ? "" : String(q.providedAnswerKey),
            q.hasFigure ? "YES" : "NO",
            q.hasVideoSolution ? "YES" : "NO",
            q.solutionText && q.solutionText.trim() ? "YES" : "NO",
            q.questionType || "",
            ...agentCells,
            q.aggregator.finalAnswer === null ? "" : String(q.aggregator.finalAnswer),
            `${computeConfidencePercent(q)}%`,
            q.aggregator.confidence,
            q.aggregator.needsManualReview ? "YES" : "NO",
            q.aggregator.manualReviewReason || "",
            q.aggregator.consolidatedErrors.join(" | "),
            q.aggregator.consolidatedSolutionFeedback,
            q.aggregator.rationale,
            q.questionSummary,
        ];
    });
    const ws1 = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws1["!cols"] = header.map((_, ci) => {
        const widths = rows.map((r) => String(r[ci] ?? "").length);
        const max = Math.max(header[ci].length, ...widths, 8);
        return { wch: Math.min(60, max + 2) };
    });
    XLSX.utils.book_append_sheet(wb, ws1, "Per-Question Report");

    // Summary sheet with IST timestamps.
    const total = job.questions.length;
    const flagged = job.questions.filter((q) => q.aggregator.needsManualReview).length;
    const mismatch = job.questions.filter(
        (q) => q.aggregator.agreementWithProvidedKey === false
    ).length;
    const figures = job.questions.filter((q) => q.hasFigure).length;
    const withErrors = job.questions.filter(
        (q) => q.aggregator.consolidatedErrors.length > 0
    ).length;

    const meta: (string | number)[][] = [
        ["Agentic AI QC Report"],
        ...(job.testName?.trim() ? [["Test name", job.testName.trim()]] : []),
        ["Job ID", job.id],
        ["Created (IST)", formatIST(job.createdAt)],
        ["Finished (IST)", job.finishedAt ? formatIST(job.finishedAt) : "(in progress)"],
        ["Status", job.status],
        ["Input mode", job.inputMode],
        ["Source", job.sourceFileName || ""],
        ["Exam type", job.examType || ""],
        ["Subjects", (job.subjects || []).join(", ")],
        ...(selectedSyllabusEntries(job).length > 0
            ? [
                  ["Selected syllabus"],
                  ...selectedSyllabusEntries(job).map(([subj, chs]) => [
                      subj,
                      chs.length > 0 ? chs.join(", ") : "(all chapters)",
                  ]),
              ]
            : []),
        [""],
        ["Agents"],
        ["Label", "Provider", "Model"],
        ...job.qcAgents.map((a) => [a.label, a.provider, a.modelId]),
        ["Aggregator", job.aggregator.provider, job.aggregator.modelId],
        [""],
        ["Totals"],
        ["Total questions", total],
        ["Flagged for review", flagged],
        ["Answer-key mismatches", mismatch],
        ["Questions with figures", figures],
        ["Questions with errors", withErrors],
        [""],
        ["Paper analysis"],
        ["Pattern", job.paperAnalysis.patternAnalysis || ""],
        ["Syllabus", job.paperAnalysis.syllabusAnalysis || ""],
        ["Overall suggestions", job.paperAnalysis.overallSuggestions.join(" | ")],
    ];

    // Question repetition check.
    const repeats = findRepeatedQuestions(job);
    meta.push([""], ["Question repetition"]);
    if (repeats.length === 0) {
        meta.push(["Repeated questions", "None detected"]);
    } else {
        for (const r of repeats) {
            meta.push([
                `Repeated ${r.questionNumbers.length}x`,
                `Q${r.questionNumbers.join(", Q")} — ${r.preview}...`,
            ]);
        }
    }

    // Syllabus balance — questions per chapter + smart flags.
    const dist = chapterDistribution(job);
    meta.push([""], ["Syllabus balance (questions per chapter)"]);
    for (const s of dist) {
        meta.push([
            `${s.subject} (${s.total})`,
            s.chapters.map((c) => `${c.chapter}: ${c.count}`).join(" | "),
        ]);
        if (s.notInSyllabus.length > 0)
            meta.push(["  UNEXPECTED chapters", s.notInSyllabus.join(" | ")]);
        if (s.missingFromPaper.length > 0)
            meta.push(["  MISSING from paper", s.missingFromPaper.join(" | ")]);
        if (s.heavy.length > 0)
            meta.push(["  HEAVY (>2x avg)", s.heavy.join(" | ")]);
    }

    if (job.partial) meta.push([""], ["Partial report"], ["Reason", job.partialReason || ""]);
    const ws2 = XLSX.utils.aoa_to_sheet(meta);
    ws2["!cols"] = [{ wch: 28 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Summary");

    // Token usage & cost sheet.
    const cost = buildCostSummary(job.tokenUsage);
    if (cost.rows.length > 0) {
        const costAoa: (string | number)[][] = [
            ["Token Usage & Cost"],
            [`Prices as of ${cost.pricedAsOf}`, `$1 = INR ${cost.usdToInr}`],
            [""],
            [
                "Model",
                "Used by",
                "Input tokens",
                "Output tokens",
                "Total tokens",
                "Rate $/1M in",
                "Rate $/1M out",
                "Cost USD",
                "Cost INR",
            ],
            ...cost.rows.map((r) => [
                `${r.provider}/${r.modelId}`,
                r.labels.join(" | "),
                r.inputTokens,
                r.outputTokens,
                r.totalTokens,
                r.priced ? r.price!.input : "",
                r.priced ? r.price!.output : "",
                r.priced ? Number(r.costUsd.toFixed(4)) : "price n/a",
                r.priced ? Number(r.costInr.toFixed(2)) : "price n/a",
            ]),
            [
                "TOTAL",
                "",
                cost.totalInputTokens,
                cost.totalOutputTokens,
                cost.totalTokens,
                "",
                "",
                Number(cost.totalCostUsd.toFixed(4)),
                Number(cost.totalCostInr.toFixed(2)),
            ],
        ];
        const ws3 = XLSX.utils.aoa_to_sheet(costAoa);
        ws3["!cols"] = [
            { wch: 34 },
            { wch: 18 },
            { wch: 14 },
            { wch: 14 },
            { wch: 14 },
            { wch: 13 },
            { wch: 13 },
            { wch: 12 },
            { wch: 12 },
        ];
        XLSX.utils.book_append_sheet(wb, ws3, "Token Cost");
    }

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    saveAs(blob, buildFilename(job, "xlsx"));
}

// ─── HTML report ────────────────────────────────────────────────────────
//
// The PDF carries QBG ids as plain PDF /URI link annotations, and the format
// has no "open in a new tab" flag for those (that flag exists only for /Launch
// and /GoToR actions), so Chrome navigates the tab showing the report. This
// HTML report is the same content as a web page, where every QBG id is an
// ordinary <a target="_blank"> and opens in a new tab as expected.

const QBG_QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question=";

function esc(v: unknown): string {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Greek letters, resolved before cleanLatex strips the backslash. The PDF path
 * deliberately leaves these as words ("Omega") because jsPDF's WinAnsi fonts
 * cannot draw them; HTML has no such limit, so the report reads properly.
 */
const HTML_GREEK: Record<string, string> = {
    Omega: "Ω", omega: "ω", alpha: "α", beta: "β", gamma: "γ",
    Gamma: "Γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ", kappa: "κ",
    lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν", xi: "ξ",
    pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ",
    tau: "τ", phi: "φ", varphi: "φ", Phi: "Φ", chi: "χ",
    psi: "ψ", Psi: "Ψ", times: "×", cdot: "·", pm: "±",
    infty: "∞", approx: "≈", neq: "≠", leq: "≤", geq: "≥",
};

/** Readable question/solution text: LaTeX simplified, then HTML-escaped. */
function htmlText(v: unknown): string {
    const raw = String(v ?? "");
    if (!raw) return "";
    const greeked = raw.replace(/\\([A-Za-z]+)/g, (m, name: string) => HTML_GREEK[name] ?? m);
    return esc(cleanLatex(greeked));
}

function qbgLink(qbgId: string): string {
    return (
        `<a class="qbg" href="${esc(QBG_QUESTION_URL + encodeURIComponent(qbgId))}" ` +
        `target="_blank" rel="noopener noreferrer" title="Open in QBG (new tab)">` +
        `${esc(qbgId)} <span class="ext">&#8599;</span></a>`
    );
}

const HTML_STYLES = `
:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;
--blue:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#d97706;--violet:#7c3aed;}
*{box-sizing:border-box}
body{margin:0;padding:28px 22px 60px;background:var(--bg);color:var(--ink);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.sub{color:var(--muted);font-size:.85rem;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:.83rem;background:var(--card);
border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f1f5f9;font-weight:700;font-size:.75rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
tr:last-child td{border-bottom:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
.stat .n{font-size:1.5rem;font-weight:800;line-height:1.1}
.stat .l{font-size:.73rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.q{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:10px;
padding:13px 15px;margin-bottom:11px}
.q.crit{border-left-color:var(--red)}
.q.minor{border-left-color:var(--amber)}
.q.ok{border-left-color:var(--green)}
.qhead{display:flex;flex-wrap:wrap;gap:9px;align-items:baseline;margin-bottom:6px}
.qnum{font-weight:800;font-size:1rem}
.meta{color:var(--muted);font-size:.78rem}
.tag{display:inline-block;font-size:.68rem;font-weight:700;padding:1px 7px;border-radius:999px;
border:1px solid currentColor}
.tag.red{color:var(--red);background:#fef2f2}
.tag.amber{color:var(--amber);background:#fffbeb}
.tag.violet{color:var(--violet);background:#f5f3ff}
.tag.green{color:var(--green);background:#f0fdf4}
.qtext{font-size:.85rem;margin:7px 0;white-space:pre-wrap}
ul{margin:5px 0 5px 18px;padding:0}
li{margin:2px 0;font-size:.82rem}
a.qbg{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.76rem;font-weight:600;
color:var(--blue);text-decoration:none;border-bottom:1px dotted currentColor}
a.qbg:hover{background:#eff6ff}
.ext{font-size:.7em}
.note{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:9px;
padding:9px 12px;font-size:.8rem;margin-bottom:16px}
.err{color:var(--red)}.warn{color:var(--amber)}.good{color:var(--green)}
@media print{body{background:#fff;padding:0}.note{display:none}.q,.card,table{break-inside:avoid}}
`;

/**
 * Download the job as a standalone HTML report. Same data as the PDF, but the
 * QBG ids are real links that open in a new tab.
 */
export function downloadJobAsHTML(job: JobRecord): void {
    const agentLabels = job.qcAgents.map((a) => a.label);
    const total = job.questions.length;
    const flagged = job.questions.filter((q) => q.aggregator.needsManualReview).length;
    const mismatch = job.questions.filter((q) => q.aggregator.agreementWithProvidedKey === false).length;
    const withErrors = job.questions.filter((q) => q.aggregator.consolidatedErrors.length > 0).length;
    const figures = job.questions.filter((q) => q.hasFigure).length;
    const hasQbgIds = job.questions.some((q) => q.qbgId);

    const parts: string[] = [];

    parts.push(`<h1>Agentic AI QC Report</h1>`);
    parts.push(
        `<p class="sub">${esc(job.testName?.trim() || job.sourceFileName || job.label || "Untitled")}` +
            ` &middot; job ${esc(job.id.slice(0, 8))}` +
            ` &middot; ${esc(formatIST(job.createdAt))}` +
            (job.finishedAt ? ` &rarr; ${esc(formatIST(job.finishedAt))}` : " (in progress)") +
            `</p>`
    );

    if (hasQbgIds) {
        parts.push(
            `<div class="note">Every QBG ID below opens in a new tab, so this report stays where it is. ` +
                `The PDF version can't do that &mdash; PDF links have no "new tab" flag, so Chrome opens them ` +
                `in the same tab.</div>`
        );
    }

    if (job.partial) {
        parts.push(
            `<div class="card"><strong class="warn">Partial report.</strong> ${esc(job.partialReason || "")}</div>`
        );
    }

    // ── Totals ──
    parts.push(`<h2>Totals</h2><div class="grid">`);
    const stats: [string, number | string, string][] = [
        ["Questions", total, ""],
        ["Flagged for review", flagged, flagged ? "warn" : "good"],
        ["Answer-key mismatches", mismatch, mismatch ? "err" : "good"],
        ["With errors", withErrors, withErrors ? "warn" : "good"],
        ["With figures", figures, ""],
    ];
    for (const [label, value, cls] of stats) {
        parts.push(`<div class="stat"><div class="n ${cls}">${esc(value)}</div><div class="l">${esc(label)}</div></div>`);
    }
    parts.push(`</div>`);

    // ── Run setup ──
    parts.push(`<h2>Run</h2><table><tr><th>Role</th><th>Provider</th><th>Model</th></tr>`);
    for (const a of job.qcAgents) {
        parts.push(`<tr><td>${esc(a.label)}</td><td>${esc(a.provider)}</td><td>${esc(a.modelId)}</td></tr>`);
    }
    parts.push(
        `<tr><td>Aggregator</td><td>${esc(job.aggregator.provider)}</td><td>${esc(job.aggregator.modelId)}</td></tr></table>`
    );
    parts.push(
        `<div class="card meta">Status ${esc(job.status)} &middot; input ${esc(job.inputMode)}` +
            (job.sourceFileName ? ` &middot; source ${esc(job.sourceFileName)}` : "") +
            (job.examType ? ` &middot; exam ${esc(job.examType)}` : "") +
            ((job.subjects || []).length ? ` &middot; subjects ${esc((job.subjects || []).join(", "))}` : "") +
            `</div>`
    );

    // ── Token cost ──
    const cost = buildCostSummary(job.tokenUsage);
    if (cost.rows.length > 0) {
        parts.push(
            `<h2>Token usage &amp; cost</h2>` +
                `<p class="sub">Prices as of ${esc(cost.pricedAsOf)} &middot; $1 = INR ${esc(cost.usdToInr)}</p>` +
                `<table><tr><th>Model</th><th>Input</th><th>Output</th><th>Total</th><th>Cost (INR)</th></tr>`
        );
        for (const r of cost.rows) {
            parts.push(
                `<tr><td>${esc(r.modelId)}</td><td>${esc(pdfInt(r.inputTokens))}</td>` +
                    `<td>${esc(pdfInt(r.outputTokens))}</td><td>${esc(pdfInt(r.totalTokens))}</td>` +
                    `<td>${esc(pdfMoney(r.costInr))}</td></tr>`
            );
        }
        parts.push(
            `<tr><td><strong>Total</strong></td><td colspan="3"></td>` +
                `<td><strong>${esc(pdfMoney(cost.totalCostInr))}</strong></td></tr></table>`
        );
    }

    // ── Paper analysis ──
    const pa = job.paperAnalysis;
    if (pa && (pa.patternAnalysis || pa.syllabusAnalysis || pa.overallSuggestions.length)) {
        parts.push(`<h2>Paper analysis</h2><div class="card">`);
        if (pa.patternAnalysis) parts.push(`<p><strong>Pattern.</strong> ${htmlText(pa.patternAnalysis)}</p>`);
        if (pa.syllabusAnalysis) parts.push(`<p><strong>Syllabus.</strong> ${htmlText(pa.syllabusAnalysis)}</p>`);
        if (pa.overallSuggestions.length) {
            parts.push(`<p><strong>Suggestions</strong></p><ul>`);
            for (const sug of pa.overallSuggestions) parts.push(`<li>${htmlText(sug)}</li>`);
            parts.push(`</ul>`);
        }
        parts.push(`</div>`);
    }

    // ── Repetition ──
    const repeats = findRepeatedQuestions(job);
    parts.push(`<h2>Question repetition</h2><div class="card">`);
    if (repeats.length === 0) {
        parts.push(`<span class="good">No repeated questions detected.</span>`);
    } else {
        parts.push(`<ul>`);
        for (const r of repeats) {
            parts.push(
                `<li class="warn">Q${esc(r.questionNumbers.join(", Q"))} &mdash; ${htmlText(r.preview)}&hellip;</li>`
            );
        }
        parts.push(`</ul>`);
    }
    parts.push(`</div>`);

    // ── Syllabus balance ──
    const dist = chapterDistribution(job);
    if (dist.length) {
        parts.push(`<h2>Syllabus balance</h2>`);
        for (const sdist of dist) {
            parts.push(
                `<div class="card"><strong>${esc(sdist.subject)}</strong> <span class="meta">(${esc(sdist.total)} questions)</span><ul>`
            );
            for (const c of sdist.chapters) {
                parts.push(`<li>${esc(c.chapter)}: ${esc(c.count)}</li>`);
            }
            parts.push(`</ul>`);
            if (sdist.notInSyllabus.length)
                parts.push(`<div class="err">Unexpected chapters: ${esc(sdist.notInSyllabus.join(", "))}</div>`);
            if (sdist.missingFromPaper.length)
                parts.push(`<div class="warn">Missing from paper: ${esc(sdist.missingFromPaper.join(", "))}</div>`);
            if (sdist.heavy.length)
                parts.push(`<div class="warn">Heavy (&gt;2&times; average): ${esc(sdist.heavy.join(", "))}</div>`);
            parts.push(`</div>`);
        }
    }

    // ── Per-question ──
    parts.push(`<h2>Questions</h2>`);
    for (const q of job.questions) {
        const cls = questionHasCriticalError(q) ? "crit" : questionHasMinorIssue(q) ? "minor" : "ok";
        parts.push(`<div class="q ${cls}"><div class="qhead">`);
        parts.push(`<span class="qnum">Q${esc(q.questionNumber)}</span>`);
        if (q.qbgId) parts.push(qbgLink(q.qbgId));
        const tags: string[] = [];
        if (q.hasFigure) tags.push(`<span class="tag violet">DIAGRAM</span>`);
        if (q.aggregator.agreementWithProvidedKey === false) tags.push(`<span class="tag red">KEY MISMATCH</span>`);
        if (q.aggregator.needsManualReview) tags.push(`<span class="tag amber">REVIEW</span>`);
        if (q.aggregator.consolidatedErrors.length)
            tags.push(`<span class="tag red">${esc(q.aggregator.consolidatedErrors.length)} ERR</span>`);
        if (!tags.length) tags.push(`<span class="tag green">CLEAN</span>`);
        parts.push(tags.join(" "));
        parts.push(`</div>`);

        const bits = [q.subject, q.chapter, q.topic, difficultyLabel(q.difficulty), q.questionType].filter(Boolean);
        if (bits.length) parts.push(`<div class="meta">${esc(bits.join(" &middot; ").replace(/&amp;middot;/g, "·"))}</div>`);

        const text = q.questionText || q.questionSummary;
        if (text) parts.push(`<div class="qtext">${htmlText(text)}</div>`);

        parts.push(`<table><tr><th>Source</th><th>Answer</th><th>Issues raised</th></tr>`);
        parts.push(
            `<tr><td>Provided key</td><td><strong>${esc(q.providedAnswerKey ?? "—")}</strong></td><td></td></tr>`
        );
        for (const label of agentLabels) {
            const r = q.agentResults.find((x) => x.label === label);
            if (!r) {
                parts.push(`<tr><td>${esc(label)}</td><td class="meta">—</td><td></td></tr>`);
                continue;
            }
            if (r.status === "failed") {
                parts.push(
                    `<tr><td>${esc(label)}</td><td class="err">failed</td><td class="err">${htmlText(r.error || "agent failed")}</td></tr>`
                );
                continue;
            }
            const issues = r.errorsFound.length
                ? `<ul>${r.errorsFound.map((e) => `<li>${htmlText(e)}</li>`).join("")}</ul>`
                : `<span class="meta">none</span>`;
            parts.push(`<tr><td>${esc(label)}</td><td><strong>${esc(r.answer ?? "—")}</strong></td><td>${issues}</td></tr>`);
        }
        const conf = computeConfidencePercent(q);
        parts.push(
            `<tr><td><strong>Final</strong></td>` +
                `<td><strong>${esc(q.aggregator.finalAnswer ?? "—")}</strong> ` +
                `<span class="meta">${esc(conf)}% ${esc(q.aggregator.confidence)}</span></td>` +
                `<td>${
                    q.aggregator.consolidatedErrors.length
                        ? `<ul>${q.aggregator.consolidatedErrors.map((e) => `<li>${htmlText(e)}</li>`).join("")}</ul>`
                        : `<span class="meta">none</span>`
                }</td></tr></table>`
        );

        if (q.aggregator.needsManualReview && q.aggregator.manualReviewReason)
            parts.push(`<p class="warn"><strong>Review:</strong> ${htmlText(q.aggregator.manualReviewReason)}</p>`);
        if (q.aggregator.consolidatedSolutionFeedback?.trim())
            parts.push(`<p class="meta"><strong>Solution feedback:</strong> ${htmlText(q.aggregator.consolidatedSolutionFeedback)}</p>`);
        if (q.aggregator.rationale?.trim())
            parts.push(`<p class="meta"><strong>Rationale:</strong> ${htmlText(q.aggregator.rationale)}</p>`);

        parts.push(`</div>`);
    }

    const html =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Agentic QC — ${esc(job.testName?.trim() || job.sourceFileName || job.id.slice(0, 8))}</title>` +
        `<style>${HTML_STYLES}</style></head><body><div class="wrap">${parts.join("\n")}</div></body></html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildFilename(job, "html");
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─── PDF — beautified ───────────────────────────────────────────────────

/**
 * jsPDF's built-in fonts only support WinAnsi (Latin-1). Any character above
 * U+00FF (arrows, ✓/✗, bullets, Greek like θ, subscripts ₀, smart quotes,
 * em-dashes, math symbols, etc.) renders as garbage AND — worse — is
 * mis-measured by getTextWidth, which makes inline coloured segments (e.g. the
 * agent answer) overlap the text after them. We map the common offenders to
 * ASCII and strip anything else outside Latin-1, then normalise odd whitespace.
 * Apply this to EVERY string before pdf.text / splitTextToSize / getTextWidth.
 */
const PDF_CHAR_MAP: Record<string, string> = {
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=",
    "✓": "ok", "✔": "ok", "✗": "x", "✘": "x", "✕": "x", "×": "x", "✦": "*",
    "•": "-", "◦": "-", "▪": "-", "‣": "-", "·": "-",
    "—": "-", "–": "-", "―": "-",
    "“": '"', "”": '"', "„": '"', "‟": '"', "‘": "'", "’": "'", "‚": "'",
    "…": "...", "≤": "<=", "≥": ">=", "≈": "~", "≠": "!=", "±": "+/-",
    "°": " deg", "√": "sqrt", "∞": "inf", "∝": " prop ", "∆": "delta", "Δ": "delta",
    "θ": "theta", "π": "pi", "µ": "u", "μ": "u", "α": "alpha", "β": "beta",
    "γ": "gamma", "λ": "lambda", "Ω": "ohm", "Σ": "sum",
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "⟶": "->", "⟵": "<-",
};
// Unicode whitespace variants (thin/hair/no-break/zero-width spaces, etc.) that
// collapse to a plain space - a common cause of "s p a c e d  o u t" text.
const PDF_SPACE_CODEPOINTS = new Set([
    0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0x200b, 0x200c, 0x200d, 0xfeff,
]);

/**
 * jsPDF can't typeset LaTeX, so question text full of `\( ... \)`, `\mathrm{}`,
 * `^{2}`, `\sin`, `\circ` etc. would otherwise dump raw markup into the report.
 * This converts the common LaTeX the QC content uses into plain readable text
 * (e.g. `\( 2 \mathrm{~m}/\mathrm{s}^{2} \)` -> `2 m/s^2`,
 *  `\sin 37^\circ=3/5` -> `sin 37 deg=3/5`). Best-effort, not a TeX engine.
 */
function cleanLatex(s: string): string {
    if (!/[\\${}^_]/.test(s)) return s; // fast path: no math markup
    return s
        .replace(/\\[()[\]]/g, " ") // \( \) \[ \]
        .replace(/\$\$?/g, " ") // $ and $$
        .replace(
            /\\(?:mathrm|mathbf|mathit|mathsf|text|operatorname|boldsymbol|mathbb|mathcal|rm|bf)\s*\{([^{}]*)\}/g,
            "$1"
        )
        .replace(/\\(?:frac|dfrac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)")
        .replace(/\^\s*\{?\s*\\circ\s*\}?/g, "°") // ^\circ -> degree
        .replace(/\\(?:circ|degree)/g, "°")
        .replace(/\^\{([^{}]*)\}/g, "^$1") // ^{2} -> ^2
        .replace(/_\{([^{}]*)\}/g, "_$1") // _{1} -> _1
        .replace(/\\times/g, "x")
        .replace(/\\cdot/g, ".")
        .replace(/\\div/g, "/")
        .replace(/\\pm/g, "+/-")
        .replace(/\\leq/g, "<=")
        .replace(/\\geq/g, ">=")
        .replace(/\\neq/g, "!=")
        .replace(/\\approx/g, "~")
        .replace(/\\propto/g, " prop ")
        .replace(/\\infty/g, "inf")
        .replace(/\\(?:left|right|displaystyle|quad|qquad|,|;|:|!)/g, " ")
        .replace(/~/g, " ") // LaTeX non-breaking space
        .replace(/\\\\/g, " ") // line break
        .replace(/\\([a-zA-Z]+)/g, "$1") // strip remaining \commands, keep the name
        .replace(/[{}]/g, "") // leftover braces
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function pdfSafe(input: unknown): string {
    const s = cleanLatex(String(input ?? ""));
    let out = "";
    for (const ch of s) {
        const mapped = PDF_CHAR_MAP[ch];
        if (mapped !== undefined) {
            out += mapped;
            continue;
        }
        const cp = ch.codePointAt(0)!;
        if (PDF_SPACE_CODEPOINTS.has(cp)) {
            out += " ";
        } else if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xff)) {
            out += ch; // printable Latin-1 / tab / newline
        }
        // else: drop characters jsPDF WinAnsi font cannot render.
    }
    return out.replace(/ {2,}/g, " ");
}

/** Tailwind-ish palette tuned for printable contrast. */
const COLORS = {
    // Softened from pure/near-black to save printer ink while keeping contrast.
    text: [51, 65, 85] as [number, number, number], // slate-700 (was slate-800)
    textMuted: [100, 116, 139] as [number, number, number], // slate-500
    border: [203, 213, 225] as [number, number, number], // slate-300
    headerBg: [51, 65, 85] as [number, number, number], // slate-700 (was slate-900 — big dark band, lighter = less ink)
    headerText: [241, 245, 249] as [number, number, number], // slate-100
    green: [22, 163, 74] as [number, number, number], // green-600
    greenBg: [220, 252, 231] as [number, number, number], // green-100
    red: [220, 38, 38] as [number, number, number], // red-600
    redBg: [254, 226, 226] as [number, number, number], // red-100
    yellow: [202, 138, 4] as [number, number, number], // yellow-600
    yellowBg: [254, 249, 195] as [number, number, number], // yellow-100
    blue: [37, 99, 235] as [number, number, number], // blue-600
    blueBg: [219, 234, 254] as [number, number, number], // blue-100
    cardBg: [248, 250, 252] as [number, number, number], // slate-50
    purple: [126, 34, 206] as [number, number, number], // purple-700
};

/**
 * Draw a small check mark (✓) as vector strokes — jsPDF's WinAnsi fonts can't
 * render the Unicode glyph, so we draw it. `(x, y)` is the top-left of a ~7pt
 * box; `color` sets the stroke (green for "yes").
 */
function drawTick(
    pdf: jsPDF,
    x: number,
    y: number,
    color: [number, number, number]
): void {
    pdf.setDrawColor(...color);
    pdf.setLineWidth(1.1);
    // Start low-left, down to the vertex, then up to the long arm.
    pdf.lines([[2.2, 2.8], [4.6, -6.2]], x, y + 3.4, [1, 1], "S", false);
}

/**
 * Draw a small cross (✗) as two diagonal strokes — used for "no" in red.
 * `(x, y)` is the top-left of a ~6pt box.
 */
function drawCross(
    pdf: jsPDF,
    x: number,
    y: number,
    color: [number, number, number]
): void {
    pdf.setDrawColor(...color);
    pdf.setLineWidth(1.1);
    pdf.line(x, y, x + 6, y + 6);
    pdf.line(x + 6, y, x, y + 6);
}

/**
 * Main PDF entry point. Async to keep the call signature stable for callers
 * (the per-question renderer is async).
 */
export async function downloadJobAsPDF(job: JobRecord): Promise<void> {
    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 32;
    const usableWidth = pageWidth - margin * 2;
    let y = margin;

    const ensureRoom = (needed: number) => {
        if (y + needed > pageHeight - margin) {
            pdf.addPage();
            y = margin;
        }
    };

    const setFill = (rgb: [number, number, number]) => pdf.setFillColor(...rgb);
    const setText = (rgb: [number, number, number]) => pdf.setTextColor(...rgb);
    const setStroke = (rgb: [number, number, number]) => pdf.setDrawColor(...rgb);

    const writeText = (
        text: string,
        opts: {
            size?: number;
            bold?: boolean;
            color?: [number, number, number];
            gap?: number;
            x?: number;
            maxWidth?: number;
        } = {}
    ) => {
        const size = opts.size ?? 10;
        pdf.setFont("helvetica", opts.bold ? "bold" : "normal");
        pdf.setFontSize(size);
        setText(opts.color || COLORS.text);
        const x = opts.x ?? margin;
        const w = opts.maxWidth ?? pageWidth - x - margin;
        const lines = pdf.splitTextToSize(pdfSafe(text), w);
        const lineHeight = size * 1.3;
        for (const line of lines) {
            ensureRoom(lineHeight);
            pdf.text(line, x, y + size * 0.9);
            y += lineHeight;
        }
        if (opts.gap) y += opts.gap;
    };

    // ─── COVER / HEADER ────────────────────────────────────────────────
    // Dark band with centred title (+ optional test name heading below it).
    const testName = job.testName?.trim();
    const bandH = testName ? 100 : 80;
    const cx = pageWidth / 2;
    setFill(COLORS.headerBg);
    pdf.rect(0, 0, pageWidth, bandH, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(22);
    setText(COLORS.headerText);
    pdf.text("Agentic AI QC Report", cx, 36, { align: "center" });
    if (testName) {
        // User-provided test name as a heading just below the main title.
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(12);
        setText([203, 213, 225]); // slate-300
        const tnLines = pdf.splitTextToSize(pdfSafe(testName), usableWidth);
        pdf.text(tnLines[0], cx, 56, { align: "center" });
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    setText([180, 200, 220]);
    const infoY = testName ? 80 : 58;
    pdf.text(
        pdfSafe(job.sourceFileName ? `Source: ${job.sourceFileName}` : `Job: ${job.id.slice(0, 8)}`),
        margin,
        infoY
    );
    pdf.text(
        `Generated: ${formatIST(new Date().toISOString())}`,
        pageWidth - margin,
        infoY,
        { align: "right" }
    );
    y = bandH + 20;

    // Metadata two-column.
    const metaLeft: [string, string][] = [
        ["Job ID", job.id],
        ["Status", job.status.toUpperCase()],
        ["Created", formatIST(job.createdAt)],
        ["Finished", job.finishedAt ? formatIST(job.finishedAt) : "(in progress)"],
    ];
    const metaRight: [string, string][] = [
        ["Input mode", job.inputMode],
        ["Exam type", job.examType || "—"],
        ["Subjects", (job.subjects || []).join(", ") || "—"],
        [
            "Agents",
            `${job.qcAgents.length} QC + 1 aggregator (${job.aggregator.modelId})`,
        ],
    ];
    const colWidth = usableWidth / 2;
    const startY = y;
    for (const [k, v] of metaLeft) {
        writeText(`${k}:`, { x: margin, maxWidth: colWidth - 10, bold: true, size: 9 });
        y -= 12;
        writeText(v, {
            x: margin + 70,
            maxWidth: colWidth - 80,
            size: 9,
            color: COLORS.textMuted,
        });
    }
    const leftEnd = y;
    y = startY;
    for (const [k, v] of metaRight) {
        writeText(`${k}:`, {
            x: margin + colWidth,
            maxWidth: colWidth - 10,
            bold: true,
            size: 9,
        });
        y -= 12;
        writeText(v, {
            x: margin + colWidth + 70,
            maxWidth: colWidth - 80,
            size: 9,
            color: COLORS.textMuted,
        });
    }
    y = Math.max(leftEnd, y) + 6;

    // ─── TOTALS BANNER ─────────────────────────────────────────────────
    const total = job.questions.length;
    const flagged = job.questions.filter((q) => q.aggregator.needsManualReview).length;
    const mismatch = job.questions.filter(
        (q) => q.aggregator.agreementWithProvidedKey === false
    ).length;
    const figures = job.questions.filter((q) => q.hasFigure).length;
    const criticalErrCount = job.questions.filter(questionHasCriticalError).length;
    const minorIssueCount = job.questions.filter(questionHasMinorIssue).length;

    const tiles: { label: string; value: string; color: [number, number, number]; bg: [number, number, number] }[] = [
        { label: "TOTAL", value: String(total), color: COLORS.text, bg: COLORS.cardBg },
        { label: "OK", value: String(total - criticalErrCount - minorIssueCount), color: COLORS.green, bg: COLORS.greenBg },
        { label: "CRITICAL", value: String(criticalErrCount), color: COLORS.red, bg: COLORS.redBg },
        { label: "MINOR", value: String(minorIssueCount), color: COLORS.yellow, bg: COLORS.yellowBg },
        { label: "KEY MISMATCH", value: String(mismatch), color: COLORS.red, bg: COLORS.redBg },
        { label: "DIAGRAMS", value: String(figures), color: COLORS.purple, bg: COLORS.cardBg },
        { label: "FLAGGED", value: String(flagged), color: COLORS.yellow, bg: COLORS.yellowBg },
    ];
    const tileW = (usableWidth - (tiles.length - 1) * 6) / tiles.length;
    const tileH = 44;
    ensureRoom(tileH + 6);
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const x = margin + i * (tileW + 6);
        setFill(t.bg);
        pdf.roundedRect(x, y, tileW, tileH, 4, 4, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        setText(t.color);
        pdf.text(t.value, x + tileW / 2, y + 22, { align: "center" });
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        setText(COLORS.textMuted);
        pdf.text(t.label, x + tileW / 2, y + 36, { align: "center" });
    }
    y += tileH + 14;

    if (job.partial) {
        setFill(COLORS.yellowBg);
        ensureRoom(28);
        pdf.roundedRect(margin, y, usableWidth, 22, 3, 3, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        setText(COLORS.yellow);
        pdf.text(pdfSafe(`PARTIAL REPORT  -  ${job.partialReason || ""}`), margin + 8, y + 14);
        y += 28;
    }

    // ─── MODELS USED — per-agent table with tokens + ₹ cost ────────────
    // Shows which model powered each QC agent and the aggregator, and the
    // tokens consumed + ₹ cost for EACH agent individually (right-aligned),
    // laid out as a compact table.
    {
        writeText("Models used", { size: 12, bold: true, gap: 4, color: COLORS.text });

        const byLabel = job.tokenUsageByLabel || {};
        // One row per agent in configured order, then the aggregator.
        const agentList = [
            ...job.qcAgents.map((a) => ({ label: a.label, provider: a.provider, modelId: a.modelId })),
            { label: "Aggregator", provider: job.aggregator.provider, modelId: job.aggregator.modelId },
        ];

        // Column geometry: Agent | Model | Tokens (right) | Cost ₹ (right).
        const cAgentW = 70;
        const cTokW = 78;
        const cCostW = 78;
        const cModelW = usableWidth - cAgentW - cTokW - cCostW;
        const colX = {
            agent: margin,
            model: margin + cAgentW,
            tokEnd: margin + cAgentW + cModelW + cTokW, // right edge for tokens
            costEnd: margin + usableWidth, // right edge for cost
        };

        const headH = 15;
        ensureRoom(headH);
        // Header strip.
        setFill(COLORS.headerBg);
        pdf.rect(margin, y, usableWidth, headH, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        setText(COLORS.headerText);
        pdf.text("Agent", colX.agent + 4, y + 10);
        pdf.text("Model", colX.model + 2, y + 10);
        pdf.text("Tokens", colX.tokEnd - 2, y + 10, { align: "right" });
        pdf.text("Cost (INR)", colX.costEnd - 2, y + 10, { align: "right" });
        y += headH;

        let totalTokens = 0;
        let totalInr = 0;
        let anyPriced = false;
        const rowH = 14;
        for (const a of agentList) {
            ensureRoom(rowH);
            const rowY = y;
            const usage = byLabel[a.label];
            const inTok = usage?.inputTokens || 0;
            const outTok = usage?.outputTokens || 0;
            const tok = inTok + outTok;
            const cost = computeTokenCost(a.provider, a.modelId, inTok, outTok);
            totalTokens += tok;
            if (cost.priced) {
                totalInr += cost.costInr;
                anyPriced = true;
            }

            // Agent label (bold).
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(8);
            setText(COLORS.text);
            pdf.text(pdfSafe(a.label), colX.agent + 4, rowY + 9.5);
            // Model id (muted, truncated to fit its column).
            pdf.setFont("helvetica", "normal");
            setText(COLORS.textMuted);
            let model = pdfSafe(`${a.provider}/${a.modelId}`);
            while (model.length > 1 && pdf.getTextWidth(model) > cModelW - 6) {
                model = model.slice(0, -1);
            }
            pdf.text(model, colX.model + 2, rowY + 9.5);
            // Tokens (right-aligned).
            setText(COLORS.text);
            pdf.text(tok > 0 ? pdfInt(tok) : "-", colX.tokEnd - 2, rowY + 9.5, { align: "right" });
            // Cost in INR (right-aligned) — no ₹ glyph (header says INR).
            pdf.text(
                tok === 0 ? "-" : cost.priced ? pdfMoney(cost.costInr) : "n/a",
                colX.costEnd - 2,
                rowY + 9.5,
                { align: "right" }
            );
            // Bottom divider.
            setStroke(COLORS.border);
            pdf.setLineWidth(0.3);
            pdf.line(margin, rowY + rowH, margin + usableWidth, rowY + rowH);
            y = rowY + rowH;
        }

        // Total row.
        ensureRoom(rowH);
        const totY = y;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        setText(COLORS.text);
        pdf.text("TOTAL", colX.agent + 4, totY + 9.5);
        pdf.text(totalTokens > 0 ? pdfInt(totalTokens) : "-", colX.tokEnd - 2, totY + 9.5, { align: "right" });
        pdf.text(anyPriced ? pdfMoney(totalInr) : "-", colX.costEnd - 2, totY + 9.5, { align: "right" });
        y = totY + rowH + 2;

        // Pricing footnote.
        const cost = buildCostSummary(job.tokenUsage);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        setText(COLORS.textMuted);
        ensureRoom(10);
        pdf.text(
            pdfSafe(`Prices as of ${cost.pricedAsOf} · $1 = INR ${cost.usdToInr}. Costs are estimates (unlisted models use a per-provider average); tokens are provider-reported.`),
            margin,
            y + 6
        );
        y += 14;
    }

    // ─── TOP SUMMARY TABLE ─────────────────────────────────────────────
    writeText("At-a-glance answer summary", {
        size: 13,
        bold: true,
        gap: 4,
        color: COLORS.text,
    });

    // Column setup: Q# | Diagram | Text Sol | Video Sol | Provided | each agent
    // | Final | Conf. The three flag columns render a green tick / red cross.
    const agentLabels = job.qcAgents.map((a) => a.label);
    const tableCols = [
        { key: "qnum", title: "Q#", width: 24 },
        { key: "diag", title: "Diag", width: 30 },
        { key: "textsol", title: "Txt Sol", width: 38 },
        { key: "videosol", title: "Vid Sol", width: 38 },
        { key: "provided", title: "Provided", width: 50 },
        ...agentLabels.map((l) => ({ key: `agent:${l}`, title: l, width: 0 })), // width assigned below
        { key: "final", title: "Final", width: 46 },
        { key: "conf", title: "Conf", width: 38 },
    ];
    // Distribute remaining width to agent columns.
    const fixedWidth =
        tableCols.filter((c) => c.width > 0).reduce((s, c) => s + c.width, 0);
    const agentColWidth = Math.max(
        40,
        (usableWidth - fixedWidth) / agentLabels.length
    );
    for (const c of tableCols) if (c.width === 0) c.width = agentColWidth;

    const headerH = 22;
    const rowH = 22;

    const drawTableHeader = () => {
        ensureRoom(headerH);
        setFill(COLORS.headerBg);
        pdf.rect(margin, y, usableWidth, headerH, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        setText(COLORS.headerText);
        let cx = margin;
        for (const c of tableCols) {
            pdf.text(pdfSafe(c.title), cx + c.width / 2, y + headerH / 2 + 3, { align: "center" });
            cx += c.width;
        }
        y += headerH;
    };

    drawTableHeader();

    // Per-row drawing. Each agent cell + final cell is colour-coded:
    //   GREEN  → matches the "source of truth" for that column
    //   RED    → mismatch / failed / hard error
    //   YELLOW → minor issue only
    for (const q of job.questions) {
        ensureRoom(rowH + 2);
        // Row background — subtle stripe.
        if (q.questionNumber % 2 === 0) {
            setFill(COLORS.cardBg);
            pdf.rect(margin, y, usableWidth, rowH, "F");
        }
        // Border line at bottom.
        setStroke(COLORS.border);
        pdf.setLineWidth(0.4);
        pdf.line(margin, y + rowH, margin + usableWidth, y + rowH);

        let cx = margin;
        const finalAns = q.aggregator.finalAnswer;
        const provided = q.providedAnswerKey;

        for (const c of tableCols) {
            const cellW = c.width;
            // Colour fill for answer columns.
            let cellBg: [number, number, number] | null = null;
            let cellFg: [number, number, number] = COLORS.text;
            let value = "";
            // Boolean flag columns render a tick/cross glyph instead of text.
            let boolYes: boolean | null = null;
            if (c.key === "qnum") {
                value = `Q${q.questionNumber}`;
                pdf.setFont("helvetica", "bold");
            } else if (c.key === "diag") {
                boolYes = !!q.hasFigure;
            } else if (c.key === "textsol") {
                boolYes = !!(q.solutionText && q.solutionText.trim());
            } else if (c.key === "videosol") {
                boolYes = !!q.hasVideoSolution;
            } else if (c.key === "provided") {
                value = provided === null ? "—" : String(provided);
                pdf.setFont("helvetica", "normal");
            } else if (c.key === "final") {
                value = finalAns === null ? "—" : String(finalAns);
                pdf.setFont("helvetica", "bold");
                // Final cell colour:
                //   GREEN if it matches provided key
                //   RED if it differs
                //   YELLOW if no provided key or needs review only
                if (provided !== null && finalAns !== null) {
                    const match =
                        String(finalAns).trim().toLowerCase() ===
                        String(provided).trim().toLowerCase();
                    if (match) {
                        cellBg = COLORS.greenBg;
                        cellFg = COLORS.green;
                    } else {
                        cellBg = COLORS.redBg;
                        cellFg = COLORS.red;
                    }
                } else if (q.aggregator.needsManualReview) {
                    cellBg = COLORS.yellowBg;
                    cellFg = COLORS.yellow;
                }
            } else if (c.key === "conf") {
                const pct = computeConfidencePercent(q);
                value = `${pct}%`;
                pdf.setFont("helvetica", "bold");
                // Colour by band: green ≥80, yellow ≥50, red below.
                if (pct >= 80) {
                    cellBg = COLORS.greenBg;
                    cellFg = COLORS.green;
                } else if (pct >= 50) {
                    cellBg = COLORS.yellowBg;
                    cellFg = COLORS.yellow;
                } else {
                    cellBg = COLORS.redBg;
                    cellFg = COLORS.red;
                }
            } else if (c.key.startsWith("agent:")) {
                const label = c.key.slice("agent:".length);
                const r = q.agentResults.find((x) => x.label === label);
                pdf.setFont("helvetica", "bold");
                if (!r || r.status === "pending") {
                    value = "—";
                    cellFg = COLORS.textMuted;
                } else if (r.status === "running") {
                    value = "…";
                    cellFg = COLORS.blue;
                } else if (r.status === "failed") {
                    value = "ERR";
                    cellBg = COLORS.redBg;
                    cellFg = COLORS.red;
                } else {
                    value = r.answer === null ? "—" : String(r.answer);
                    // Colour: GREEN if matches final, RED if mismatch / hard
                    // error, YELLOW if it matches but has minor issues.
                    const matchesFinal =
                        finalAns !== null &&
                        r.answer !== null &&
                        String(r.answer).trim().toLowerCase() ===
                            String(finalAns).trim().toLowerCase();
                    const { critical, minor } = classifyErrors(r.errorsFound);
                    if (!matchesFinal || critical.length > 0) {
                        cellBg = COLORS.redBg;
                        cellFg = COLORS.red;
                    } else if (minor.length > 0) {
                        cellBg = COLORS.yellowBg;
                        cellFg = COLORS.yellow;
                    } else {
                        cellBg = COLORS.greenBg;
                        cellFg = COLORS.green;
                    }
                }
            }

            if (cellBg) {
                setFill(cellBg);
                pdf.rect(cx + 1, y + 2, cellW - 2, rowH - 4, "F");
            }
            if (boolYes !== null) {
                // Centre a green tick (yes) / red cross (no) in the cell.
                const gx = cx + cellW / 2 - 3.5;
                const gy = y + rowH / 2 - 3;
                if (boolYes) drawTick(pdf, gx, gy, COLORS.green);
                else drawCross(pdf, gx, gy, COLORS.red);
                cx += cellW;
                continue;
            }
            pdf.setFontSize(9);
            setText(cellFg);
            // Truncate to fit
            const maxChars = Math.max(4, Math.floor(cellW / 5));
            const display =
                value.length > maxChars ? value.slice(0, maxChars - 1) + "..." : value;
            pdf.text(pdfSafe(display), cx + cellW / 2, y + rowH / 2 + 3, { align: "center" });
            cx += cellW;
        }
        y += rowH;
    }
    y += 12;

    // Legend.
    ensureRoom(28);
    writeText("Legend:", { size: 9, bold: true, gap: 2 });
    const legendItems: { color: [number, number, number]; bg: [number, number, number]; text: string }[] = [
        { color: COLORS.green, bg: COLORS.greenBg, text: "OK — agent matches final / key" },
        {
            color: COLORS.red,
            bg: COLORS.redBg,
            text: "Critical — key mismatch or unsolvable",
        },
        {
            color: COLORS.yellow,
            bg: COLORS.yellowBg,
            text: "Minor — spelling / suggestion / minor issue",
        },
    ];
    let lx = margin;
    pdf.setFontSize(8);
    for (const it of legendItems) {
        const safeText = pdfSafe(it.text);
        const w = pdf.getTextWidth(safeText) + 24;
        ensureRoom(16);
        setFill(it.bg);
        // Colour swatch (the rounded rect itself is the legend marker).
        pdf.roundedRect(lx, y - 4, 14, 12, 2, 2, "F");
        setText(COLORS.text);
        pdf.setFont("helvetica", "normal");
        pdf.text(safeText, lx + 18, y + 4);
        lx += w;
    }
    y += 16;
    // Tick/cross legend for the Diag / Txt Sol / Vid Sol flag columns.
    {
        ensureRoom(14);
        let fx = margin;
        drawTick(pdf, fx, y - 3, COLORS.green);
        fx += 12;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        setText(COLORS.text);
        pdf.text("present", fx, y + 4);
        fx += pdf.getTextWidth("present") + 16;
        drawCross(pdf, fx, y - 3, COLORS.red);
        fx += 12;
        pdf.text("absent", fx, y + 4);
        fx += pdf.getTextWidth("absent") + 16;
        setText(COLORS.textMuted);
        pdf.text("(Diag = diagram, Txt Sol = text solution, Vid Sol = video solution)", fx, y + 4);
    }
    y += 16;

    // QBG deep-links are plain PDF /URI annotations, and the PDF format has no
    // "open in a new tab" flag for them (that flag exists only for /Launch and
    // /GoToR actions). Chrome's viewer therefore navigates the tab showing the
    // report. Ctrl/Cmd- or middle-click is the only way to keep the report open,
    // so say so rather than letting people lose their place.
    if (job.inputMode === "structured" && job.questions.some((q) => q.qbgId)) {
        ensureRoom(14);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        setText(COLORS.textMuted);
        pdf.text(
            "Tip: Ctrl+click (Cmd+click on Mac) or middle-click a QBG ID to open it in a new tab and keep this report open.",
            margin,
            y + 4
        );
        y += 16;
    }

    // ─── PAPER INSIGHTS: question repetition + syllabus balance ────────
    {
        // Repeated questions.
        const repeats = findRepeatedQuestions(job);
        writeText("Question repetition check", { size: 12, bold: true, gap: 2, color: COLORS.text });
        if (repeats.length === 0) {
            writeText("No repeated questions detected in this paper.", {
                size: 8.5,
                color: COLORS.green,
                gap: 6,
            });
        } else {
            const repeatedCount = repeats.reduce((n, r) => n + r.questionNumbers.length, 0);
            writeText(
                `${repeats.length} repeated question${repeats.length > 1 ? "s" : ""} found (${repeatedCount} affected).`,
                { size: 8.5, bold: true, color: COLORS.red, gap: 2 }
            );
            for (const r of repeats) {
                writeText(
                    `Repeated ${r.questionNumbers.length}x  -  Q${r.questionNumbers.join(", Q")}  -  "${r.preview}..."`,
                    { size: 8.5, color: COLORS.red, gap: 1 }
                );
            }
            y += 4;
        }

        // Selected syllabus — what the user asked the paper to cover, limited
        // to the subjects actually selected for this paper.
        const syllabusEntries = selectedSyllabusEntries(job);
        const hasSyllabus = syllabusEntries.length > 0;
        if (hasSyllabus) {
            writeText("Selected syllabus", { size: 12, bold: true, gap: 2, color: COLORS.text });
            for (const [subj, chs] of syllabusEntries) {
                const head = pdfSafe(`${subj}: `);
                pdf.setFont("helvetica", "bold");
                pdf.setFontSize(8.5);
                const headW = pdf.getTextWidth(head);
                pdf.setFont("helvetica", "normal");
                const body = chs.length > 0 ? chs.join(", ") : "(all chapters)";
                const lines = pdf.splitTextToSize(pdfSafe(body), usableWidth - headW);
                const lineH = 12;
                for (let i = 0; i < lines.length; i++) {
                    ensureRoom(lineH);
                    const yy = y;
                    if (i === 0) {
                        pdf.setFont("helvetica", "bold");
                        pdf.setFontSize(8.5);
                        setText(COLORS.text);
                        pdf.text(head, margin, yy + 8);
                    }
                    pdf.setFont("helvetica", "normal");
                    pdf.setFontSize(8.5);
                    setText(COLORS.textMuted);
                    pdf.text(lines[i], margin + headW, yy + 8);
                    y = yy + lineH;
                }
            }
            y += 4;
        }

        // Syllabus balance — per subject, per chapter counts with smart flags.
        const dist = chapterDistribution(job);
        writeText("Syllabus balance (questions per chapter)", {
            size: 12,
            bold: true,
            gap: 2,
            color: COLORS.text,
        });
        if (!hasSyllabus) {
            writeText("No syllabus provided — showing counts only. Provide a syllabus when starting QC for gap/imbalance analysis.", {
                size: 7.5,
                color: COLORS.textMuted,
                gap: 3,
            });
        }

        // Class 11 vs Class 12 split (parsed from the source CSV class field).
        const classCounts = (() => {
            let c11 = 0, c12 = 0, other = 0;
            for (const q of job.questions) {
                const k = (q.klass || "").toString();
                if (/\b11\b|\bxi\b/i.test(k)) c11++;
                else if (/\b12\b|\bxii\b/i.test(k)) c12++;
                else other++;
            }
            return { c11, c12, other };
        })();
        if (classCounts.c11 + classCounts.c12 > 0) {
            const parts = [`Class 11: ${classCounts.c11}`, `Class 12: ${classCounts.c12}`];
            if (classCounts.other > 0) parts.push(`Other/unspecified: ${classCounts.other}`);
            writeText(parts.join("       "), { size: 9.5, bold: true, gap: 4, color: COLORS.text });
        }

        // Two-column chapter list per subject (saves vertical space on paper).
        const halfW = usableWidth / 2;
        const renderChapterCell = (
            c: { chapter: string; count: number },
            xBase: number
        ) => {
            const yy = y;
            const countStr = String(c.count);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(8.5);
            const countW = pdf.getTextWidth(countStr);
            // Chapter name, truncated to leave room for the right-aligned count.
            pdf.setFont("helvetica", "normal");
            const maxNameW = halfW - 18 - countW;
            let name = pdfSafe(c.chapter);
            while (name.length > 1 && pdf.getTextWidth(name) > maxNameW) name = name.slice(0, -1);
            setText(COLORS.textMuted);
            pdf.text(name, xBase, yy + 8);
            pdf.setFont("helvetica", "bold");
            setText(COLORS.text);
            pdf.text(countStr, xBase + halfW - 14, yy + 8, { align: "right" });
        };

        for (const s of dist) {
            writeText(`${s.subject} (${s.total} questions)`, {
                size: 9,
                bold: true,
                gap: 1,
                color: COLORS.text,
            });
            const chRowH = 12;
            for (let i = 0; i < s.chapters.length; i += 2) {
                ensureRoom(chRowH);
                const yy = y;
                renderChapterCell(s.chapters[i], margin);
                if (s.chapters[i + 1]) renderChapterCell(s.chapters[i + 1], margin + halfW);
                y = yy + chRowH;
            }

            // Flags — only when a syllabus was provided or anomalies detected.
            if (s.notInSyllabus.length > 0) {
                writeText(
                    `  UNEXPECTED: "${s.notInSyllabus.join('", "')}" not in syllabus — verify intentional.`,
                    { size: 8, color: COLORS.red, gap: 1 }
                );
            }
            if (s.missingFromPaper.length > 0) {
                writeText(
                    `  MISSING: no questions from "${s.missingFromPaper.join('", "')}" — listed in syllabus.`,
                    { size: 8, color: COLORS.yellow, gap: 1 }
                );
            }
            if (s.heavy.length > 0) {
                writeText(
                    `  HEAVY: "${s.heavy.join('", "')}" has >2x average questions — consider rebalancing.`,
                    { size: 8, color: COLORS.yellow, gap: 1 }
                );
            }
            y += 3; // small gap between subjects
        }
        y += 4;
    }

    // ─── PER-QUESTION DETAIL ───────────────────────────────────────────
    pdf.addPage();
    y = margin;
    writeText("Per-question detail", { size: 14, bold: true, gap: 6, color: COLORS.text });

    for (const q of job.questions) {
        await renderQuestionDetail(pdf, q, {
            agentLabels,
            ensureRoom,
            getY: () => y,
            setY: (v) => {
                y = v;
            },
            writeText,
            pageWidth,
            margin,
            usableWidth,
            structured: job.inputMode === "structured",
        });
    }

    pdf.save(buildFilename(job, "pdf"));
}

/**
 * Render one question's detail block. To keep the report short & compact
 * (per requirement) the question text, options, and diagram images are all
 * omitted — the block focuses on the QC verdict: a Provided-key vs
 * Aggregator-final answer panel, a clean per-agent answer table, and the
 * classified issues / solution feedback.
 */
async function renderQuestionDetail(
    pdf: jsPDF,
    q: JobRecord["questions"][number],
    ctx: {
        agentLabels: string[];
        ensureRoom: (n: number) => void;
        getY: () => number;
        setY: (v: number) => void;
        writeText: (text: string, opts?: Record<string, unknown>) => void;
        pageWidth: number;
        margin: number;
        usableWidth: number;
        /** True for structured (CSV/Excel) uploads — enables the QBG-id deep
         *  link and the tick/cross rendering of the yes/no fields. */
        structured: boolean;
    }
): Promise<void> {
    const { ensureRoom, writeText, pageWidth, margin, usableWidth, structured } = ctx;
    let y = ctx.getY();

    // ── Card top with question header strip ──
    ensureRoom(50);
    y = ctx.getY();
    const isCritical = questionHasCriticalError(q);
    const isMinor = questionHasMinorIssue(q);
    const headerColor: [number, number, number] = isCritical
        ? COLORS.red
        : isMinor
        ? COLORS.yellow
        : COLORS.green;
    const headerBg: [number, number, number] = isCritical
        ? COLORS.redBg
        : isMinor
        ? COLORS.yellowBg
        : COLORS.greenBg;

    pdf.setFillColor(...headerBg);
    pdf.rect(margin, y, usableWidth, 26, "F");
    pdf.setDrawColor(...headerColor);
    pdf.setLineWidth(2);
    pdf.line(margin, y, margin, y + 26); // left accent bar

    // Status chip on the right (measure first so the title can avoid it).
    const status = isCritical ? "CRITICAL" : isMinor ? "MINOR" : "OK";
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    const chipW = pdf.getTextWidth(status) + 14;

    // Header line: Q# followed by the first line of the question text, with a
    // trailing "..." to signal the question is truncated (just enough to match
    // the row to the source paper). Truncate to the space left of the chip.
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(...COLORS.text);
    const qLabel = `Q${q.questionNumber}  `;
    const qLabelW = pdf.getTextWidth(pdfSafe(qLabel));
    const titleMaxW = usableWidth - chipW - 16 - qLabelW - 8;
    const firstLine =
        (q.questionText || q.questionSummary || "")
            .split("\n")
            .map((s) => s.trim())
            .find(Boolean) || "";
    let snippet = pdfSafe(firstLine);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    // Trim the snippet until it (plus "...") fits the available width.
    while (snippet.length > 0 && pdf.getTextWidth(snippet + "...") > titleMaxW) {
        snippet = snippet.slice(0, -1);
    }
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.text(pdfSafe(qLabel), margin + 8, y + 17);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(...COLORS.textMuted);
    pdf.text(`${snippet}...`, margin + 8 + qLabelW, y + 17);

    // Status chip.
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...headerColor);
    pdf.setDrawColor(...headerColor);
    pdf.setLineWidth(0.5);
    pdf.roundedRect(margin + usableWidth - chipW - 6, y + 7, chipW, 12, 3, 3, "S");
    pdf.text(status, margin + usableWidth - chipW / 2 - 6, y + 15, { align: "center" });
    y += 30;
    ctx.setY(y);

    // ── QBG id deep-link ──
    // For structured (CSV) uploads that carried a unique_id, show the QBG id
    // right after the question number and before the chapter line, as a
    // clickable link into the QBG admin question-details page.
    if (structured && q.qbgId) {
        ensureRoom(12);
        const yy = ctx.getY();
        const label = "QBG ID: ";
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.setTextColor(...COLORS.text);
        pdf.text(label, margin, yy + 8);
        const labelW = pdf.getTextWidth(label);
        const idText = pdfSafe(q.qbgId);
        pdf.setFont("helvetica", "normal");
        pdf.setTextColor(...COLORS.blue);
        const url = `https://qbg-admin.penpencil.co/question-details?question=${q.qbgId}`;
        pdf.textWithLink(idText, margin + labelW, yy + 8, { url });
        // Underline so it reads as a link.
        const idW = pdf.getTextWidth(idText);
        pdf.setDrawColor(...COLORS.blue);
        pdf.setLineWidth(0.4);
        pdf.line(margin + labelW, yy + 9.4, margin + labelW + idW, yy + 9.4);
        ctx.setY(yy + 12);
    }

    // ── Compact metadata line: subject / chapter / topic / difficulty, then
    //    the yes/no fields (Diagram / Video solution / Text Solution). For
    //    structured uploads the yes/no fields render as a green tick / red
    //    cross instead of the word "Yes" / "No". Single muted line.
    {
        const textParts: string[] = [];
        if (q.subject) textParts.push(q.subject);
        if (q.chapter) textParts.push(q.chapter);
        if (q.topic) textParts.push(q.topic);
        const diff = difficultyLabel(q.difficulty);
        if (diff) textParts.push(`Difficulty: ${diff}`);

        const bools: { label: string; yes: boolean }[] = [
            { label: "Diagram", yes: q.hasFigure },
            { label: "Video solution", yes: !!q.hasVideoSolution },
            {
                label: "Text Solution",
                yes: !!(q.solutionText && q.solutionText.trim()),
            },
        ];

        if (structured) {
            // Render the text parts (if any) on their own muted line first.
            if (textParts.length > 0) {
                writeText(textParts.join("   ·   "), {
                    size: 8,
                    color: COLORS.textMuted,
                    gap: 2,
                });
            }
            // Then the yes/no fields with tick/cross glyphs on one line.
            ensureRoom(12);
            const yy = ctx.getY();
            let mx = margin;
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(8);
            for (const b of bools) {
                const lbl = `${b.label}: `;
                pdf.setTextColor(...COLORS.textMuted);
                pdf.text(lbl, mx, yy + 8);
                mx += pdf.getTextWidth(lbl) + 2;
                if (b.yes) drawTick(pdf, mx, yy + 2, COLORS.green);
                else drawCross(pdf, mx, yy + 2, COLORS.red);
                mx += 8 + 14; // glyph width + gap before the next field
            }
            ctx.setY(yy + 12);
        } else {
            // File-mode papers: keep plain text (no QBG id / CSV booleans).
            const metaParts = [
                ...textParts,
                `Diagram: ${q.hasFigure ? "Yes" : "No"}`,
                `Video solution: ${q.hasVideoSolution ? "Yes" : "No"}`,
                `Text Solution: ${q.solutionText && q.solutionText.trim() ? "provided" : "not provided"}`,
            ];
            writeText(metaParts.join("   ·   "), {
                size: 8,
                color: COLORS.textMuted,
                gap: 2,
            });
        }
    }

    // Full question text, options, and diagram images are intentionally omitted
    // to keep the report short & compact. The verdict panel + agent table below
    // carry everything needed to action a question.

    // ── Answer comparison table: Given key | QC1 | QC2 | QC3 | Aggregator |
    //    Confidence. Each cell colour-coded against the aggregator's final. ──
    const provided = q.providedAnswerKey;
    const finalAnsRaw = q.aggregator.finalAnswer;
    const finalAns = finalAnsRaw === null || finalAnsRaw === undefined ? "—" : String(finalAnsRaw);
    const agreement = q.aggregator.agreementWithProvidedKey;
    const matchFinal = (v: string | number | null | undefined): boolean =>
        finalAns !== "—" &&
        v !== null &&
        v !== undefined &&
        String(v).trim().toLowerCase() === finalAns.trim().toLowerCase();

    type AnsCell = {
        title: string;
        value: string;
        bg: [number, number, number] | null;
        fg: [number, number, number];
    };
    const ansCells: AnsCell[] = [];
    // Given key — neutral, but tinted by whether the final agreed with it.
    ansCells.push({
        title: "Given key",
        value: provided === null || provided === undefined ? "—" : String(provided),
        bg:
            agreement === true ? COLORS.greenBg : agreement === false ? COLORS.redBg : null,
        fg: agreement === true ? COLORS.green : agreement === false ? COLORS.red : COLORS.text,
    });
    // One column per QC agent (in the configured order).
    for (const label of ctx.agentLabels) {
        const ar = q.agentResults.find((x) => x.label === label);
        let value = "—";
        let bg: [number, number, number] | null = null;
        let fg: [number, number, number] = COLORS.textMuted;
        if (ar) {
            if (ar.status === "failed") {
                value = "FAIL";
                bg = COLORS.redBg;
                fg = COLORS.red;
            } else if (ar.status === "done") {
                value = ar.answer === null || ar.answer === undefined ? "—" : String(ar.answer);
                const { critical, minor } = classifyErrors(ar.errorsFound);
                if (!matchFinal(ar.answer) || critical.length > 0) {
                    bg = COLORS.redBg;
                    fg = COLORS.red;
                } else if (minor.length > 0) {
                    bg = COLORS.yellowBg;
                    fg = COLORS.yellow;
                } else {
                    bg = COLORS.greenBg;
                    fg = COLORS.green;
                }
            }
        }
        ansCells.push({ title: label, value, bg, fg });
    }
    // Aggregator final.
    ansCells.push({
        title: "Aggregator",
        value: finalAns,
        bg: agreement === false ? COLORS.redBg : agreement === true ? COLORS.greenBg : COLORS.yellowBg,
        fg: agreement === false ? COLORS.red : agreement === true ? COLORS.green : COLORS.yellow,
    });
    // Confidence %.
    const confPct = computeConfidencePercent(q);
    ansCells.push({
        title: "Confidence",
        value: `${confPct}%`,
        bg: confPct >= 80 ? COLORS.greenBg : confPct >= 50 ? COLORS.yellowBg : COLORS.redBg,
        fg: confPct >= 80 ? COLORS.green : confPct >= 50 ? COLORS.yellow : COLORS.red,
    });

    const atHeadH = 14;
    const atValH = 20;
    const atColW = usableWidth / ansCells.length;
    y = ctx.getY() + 4;
    ensureRoom(atHeadH + atValH + 4);
    y = ctx.getY();
    // Header strip.
    pdf.setFillColor(...COLORS.headerBg);
    pdf.rect(margin, y, usableWidth, atHeadH, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.setTextColor(...COLORS.headerText);
    ansCells.forEach((c, i) => {
        pdf.text(pdfSafe(c.title), margin + i * atColW + atColW / 2, y + 9.5, { align: "center" });
    });
    y += atHeadH;
    // Value row.
    ansCells.forEach((c, i) => {
        const cx = margin + i * atColW;
        if (c.bg) {
            pdf.setFillColor(...c.bg);
            pdf.rect(cx + 1, y + 1, atColW - 2, atValH - 2, "F");
        }
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
        pdf.setTextColor(...c.fg);
        const maxChars = Math.max(4, Math.floor(atColW / 6));
        const disp = c.value.length > maxChars ? c.value.slice(0, maxChars - 1) + "..." : c.value;
        pdf.text(pdfSafe(disp), cx + atColW / 2, y + 14, { align: "center" });
    });
    // Outer border + column dividers.
    pdf.setDrawColor(...COLORS.border);
    pdf.setLineWidth(0.5);
    pdf.rect(margin, y - atHeadH, usableWidth, atHeadH + atValH, "S");
    for (let i = 1; i < ansCells.length; i++) {
        pdf.line(margin + i * atColW, y - atHeadH, margin + i * atColW, y + atValH);
    }
    y += atValH + 8;
    ctx.setY(y);

    // ── Per-agent comments (detailed issue raised by each QC model). Shows the
    //    AGENT only (no model id), with its full correctness note + issues. ──
    writeText("Per-agent comments", { size: 8.5, bold: true, gap: 1, color: COLORS.text });
    for (const ar of q.agentResults) {
        const { critical, minor } = classifyErrors(ar.errorsFound);
        let comment: string;
        let commentColor: [number, number, number] = COLORS.textMuted;
        if (ar.status === "failed") {
            comment = `failed - ${ar.error || "no response"}`;
            commentColor = COLORS.red;
        } else if (ar.status !== "done") {
            comment = ar.status;
        } else {
            const parts: string[] = [];
            if (ar.correctness) parts.push(ar.correctness);
            if (ar.errorsFound.length > 0) parts.push(`Issues: ${ar.errorsFound.join("; ")}`);
            if (ar.solutionFeedback?.trim()) parts.push(`Solution: ${ar.solutionFeedback.trim()}`);
            comment = parts.length > 0 ? parts.join("  ·  ") : "No issues found.";
            commentColor =
                critical.length > 0 ? COLORS.red : minor.length > 0 ? COLORS.yellow : COLORS.green;
        }
        // Bold agent label, then the wrapped comment beside / under it.
        const labelText = pdfSafe(ar.label);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.5);
        const labW = pdf.getTextWidth(labelText) + 6;
        pdf.setFont("helvetica", "normal");
        const lines = pdf.splitTextToSize(pdfSafe(comment), usableWidth - labW);
        const lineH = 11;
        for (let i = 0; i < lines.length; i++) {
            ensureRoom(lineH);
            const yy = ctx.getY();
            if (i === 0) {
                pdf.setFont("helvetica", "bold");
                pdf.setFontSize(8.5);
                pdf.setTextColor(...COLORS.text);
                pdf.text(labelText, margin, yy + 8);
            }
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(8.5);
            pdf.setTextColor(...commentColor);
            pdf.text(lines[i], margin + labW, yy + 8);
            ctx.setY(yy + lineH);
        }
    }
    ctx.setY(ctx.getY() + 4);

    // ── Aggregator's final conclusion ──
    writeText("Aggregator conclusion", { size: 8.5, bold: true, gap: 1, color: COLORS.purple });

    // ── Errors (classified) ──
    const allErrs = q.aggregator.consolidatedErrors;
    if (allErrs.length > 0) {
        const { critical, minor } = classifyErrors(allErrs);
        if (critical.length > 0) {
            y = ctx.getY() + 4;
            ctx.setY(y);
            renderIssueBlock(pdf, ctx, "Critical issues", critical, COLORS.red, COLORS.redBg);
        }
        if (minor.length > 0) {
            renderIssueBlock(pdf, ctx, "Minor issues", minor, COLORS.yellow, COLORS.yellowBg);
        }
    }

    // ── Solution feedback (minor / yellow) ──
    if (q.aggregator.consolidatedSolutionFeedback?.trim()) {
        renderIssueBlock(
            pdf,
            ctx,
            "Solution feedback",
            [q.aggregator.consolidatedSolutionFeedback],
            COLORS.yellow,
            COLORS.yellowBg
        );
    }

    // ── Rationale ──
    if (q.aggregator.rationale) {
        y = ctx.getY() + 2;
        ctx.setY(y);
        writeText(q.aggregator.rationale, {
            size: 8,
            color: COLORS.textMuted,
        });
    }
    if (q.aggregator.manualReviewReason) {
        writeText(`Review reason: ${q.aggregator.manualReviewReason}`, {
            size: 8,
            color: COLORS.yellow,
            bold: true,
        });
    }

    // Separator between questions.
    y = ctx.getY() + 6;
    ctx.setY(y);
    pdf.setDrawColor(...COLORS.border);
    pdf.setLineWidth(0.4);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 10;
    ctx.setY(y);
}

function renderIssueBlock(
    pdf: jsPDF,
    ctx: {
        ensureRoom: (n: number) => void;
        getY: () => number;
        setY: (v: number) => void;
        writeText: (text: string, opts?: Record<string, unknown>) => void;
        usableWidth: number;
        margin: number;
    },
    title: string,
    items: string[],
    color: [number, number, number],
    bg: [number, number, number]
): void {
    const { margin, usableWidth, ensureRoom } = ctx;
    let y = ctx.getY();
    ensureRoom(20 + items.length * 14);
    y = ctx.getY();
    // Lable strip
    pdf.setFillColor(...bg);
    pdf.roundedRect(margin, y, usableWidth, 16, 2, 2, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...color);
    pdf.text(pdfSafe(title.toUpperCase()), margin + 6, y + 11);
    y += 20;
    ctx.setY(y);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(...COLORS.text);
    for (const it of items) {
        const lines = pdf.splitTextToSize(pdfSafe(`- ${it}`), usableWidth - 16);
        for (const line of lines) {
            ensureRoom(12);
            y = ctx.getY();
            pdf.text(line, margin + 8, y + 9);
            y += 12;
            ctx.setY(y);
        }
    }
    ctx.setY(ctx.getY() + 2);
}
