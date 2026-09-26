/**
 * Answer-key shift detection.
 *
 * When a key block is transcribed one position out of step, every question in it
 * looks independently wrong: Q5's key holds Q4's answer, Q6's holds Q5's, and so
 * on. QC then reports N separate "wrong key" defects and the reviewer re-solves N
 * questions, when the real defect is ONE clerical slip with a one-line fix.
 *
 * This is deliberately deterministic rather than another instruction to the model.
 * A shift is an arithmetic property of the key sequence — comparing each verified
 * answer against the key at offset ±1, ±2 — and asking an LLM to notice it across
 * a paper it sees one question at a time cannot work reliably.
 *
 * Reported as a single CRITICAL assembly defect with the exact realignment, in the
 * spirit of the reference QC engines' key-shift rule.
 */

export interface KeyShiftInput {
    questionNumber: number;
    /** The key printed on the paper. */
    providedKey: string | null;
    /** What QC independently derived. */
    verifiedAnswer: string | null;
}

export interface KeyShiftFinding {
    /** How far the key block is out of step; +1 means key[n] holds question n-1's answer. */
    offset: number;
    /** Question numbers covered by the run. */
    questionNumbers: number[];
    /** How many of them line up under the shift. */
    matched: number;
    /** How many were flagged as wrong before the shift was considered. */
    mismatched: number;
    message: string;
}

function norm(v: string | null | undefined): string {
    return String(v ?? "").trim().toLowerCase();
}

/** Minimum consecutive wrong keys before a shift is even worth testing. */
const MIN_RUN = 3;
/** How much of the run must line up under the offset to call it a shift. */
const MIN_MATCH_RATIO = 0.8;

/**
 * Find runs of consecutive questions whose keys are wrong, and report those that
 * are explained by a uniform offset rather than by N independent errors.
 *
 * Only offsets of ±1 and ±2 are tested: a larger displacement is a different kind
 * of assembly failure (a missing or duplicated block), which this must not
 * mislabel as a simple shift.
 */
export function detectKeyShifts(rows: KeyShiftInput[]): KeyShiftFinding[] {
    const usable = rows.filter((r) => norm(r.providedKey) !== "" && norm(r.verifiedAnswer) !== "");
    if (usable.length < MIN_RUN) return [];

    const wrong = usable.map((r) => norm(r.providedKey) !== norm(r.verifiedAnswer));

    const findings: KeyShiftFinding[] = [];
    let i = 0;
    while (i < usable.length) {
        if (!wrong[i]) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < usable.length && wrong[j + 1]) j++;
        const runLen = j - i + 1;

        if (runLen >= MIN_RUN) {
            for (const offset of [1, -1, 2, -2]) {
                let matched = 0;
                let testable = 0;
                for (let k = i; k <= j; k++) {
                    const src = k + offset;
                    if (src < 0 || src >= usable.length) continue;
                    testable++;
                    // Does this question's PRINTED key equal a NEIGHBOUR's verified
                    // answer? That is the signature of a displaced block.
                    if (norm(usable[k].providedKey) === norm(usable[src].verifiedAnswer)) matched++;
                }
                if (testable >= MIN_RUN && matched / testable >= MIN_MATCH_RATIO) {
                    const nums = usable.slice(i, j + 1).map((r) => r.questionNumber);
                    const dir = offset > 0 ? "later" : "earlier";
                    findings.push({
                        offset,
                        questionNumbers: nums,
                        matched,
                        mismatched: runLen,
                        message:
                            `CRITICAL: answer key appears shifted by ${Math.abs(offset)} position(s) ` +
                            `across Q${nums[0]}–Q${nums[nums.length - 1]} — each printed key matches the ` +
                            `verified answer of a question ${Math.abs(offset)} place(s) ${dir}. ` +
                            `Treat this as ONE key-transcription defect, not ${runLen} wrong answers: ` +
                            `realign the key block by ${offset > 0 ? "-" : "+"}${Math.abs(offset)} and re-check.`,
                    });
                    break; // one explanation per run is enough
                }
            }
        }
        i = j + 1;
    }
    return findings;
}
