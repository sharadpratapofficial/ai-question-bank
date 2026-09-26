# -*- coding: utf-8 -*-
"""
Does the reframed solution actually solve the reframed question?

The reported failure: "question data is different while the solution is doing
calculations with different data". The cause is visible in the prompt — the model
is asked to rewrite a question AND write a fresh solution in one pass, and when it
changes the stem's numbers it sometimes carries the ORIGINAL question's numbers
into the working, because those are the numbers it was just reading.

That leaves a signature this module detects deterministically, with no model call:

    a value that appears in the ORIGINAL stem,
    is absent from the REFRAMED stem,
    but still appears in the REFRAMED solution.

That is not a judgement call — a number the new question never states has no
business in its solution, and it is almost always the value the model failed to
update. Values that merely LOOK stale (2, 10, g = 9.8) are excluded by the
"absent from the new stem" test plus a small ignore list of constants.

Detection is cheap and runs always; repair (build_repair_prompt) costs one model
call and only for the questions that failed.
"""
import re

from logsetup import get_logger

log = get_logger("consistency")

_NUM = re.compile(r"-?\d+(?:\.\d+)?")

# Values too common to mean anything: small integers turn up as exponents, indices,
# option counts and coefficients in any solution, and the standard constants appear
# whether or not the stem mentions them.
_IGNORE = {"0", "1", "2", "3", "4", "5", "10", "100", "1000",
           "9.8", "9.81", "10.0", "180", "360", "273", "6.02", "3.14", "22"}


def _values(text):
    return _NUM.findall(text or "")


def stale_values(orig_stem, new_stem, new_solution):
    """Values the solution kept from the ORIGINAL question after the stem moved on.

    Returns a list of the offending values, worst first (most occurrences in the
    solution). Empty when the solution is consistent with its own question.
    """
    orig = set(_values(orig_stem)) - _IGNORE
    if not orig:
        return []
    new = set(_values(new_stem))
    sol = _values(new_solution)
    if not sol:
        return []
    sol_counts = {}
    for v in sol:
        sol_counts[v] = sol_counts.get(v, 0) + 1

    stale = [v for v in orig if v not in new and v in sol_counts]
    stale.sort(key=lambda v: -sol_counts[v])
    return stale


def check_questions(questions, originals, stem_text_of, solution_text_of):
    """Run the check across a reframed batch.

    `stem_text_of` / `solution_text_of` turn one question's parts into plain text
    (cli.py owns those helpers). Returns [{num, stale, stem, solution}] for the
    questions that need repair.
    """
    by_num = {q.get("num"): q for q in (originals or [])}
    flagged = []
    for i, q in enumerate(questions, 1):
        num = q.get("num", i)
        orig = by_num.get(num) or {}
        stem = stem_text_of(q)
        sol = solution_text_of(q)
        bad = stale_values(orig.get("q_text", ""), stem, sol)
        if bad:
            flagged.append({"num": num, "stale": bad, "stem": stem, "solution": sol})
            log.info("Q%s: solution still uses the original's value(s) %s", num, bad)
    return flagged


_REPAIR_SYSTEM = (
    "You are a meticulous physics problem setter fixing your own work. You output ONLY a "
    "single valid JSON object matching the schema you are given — no markdown, no commentary."
)

_REPAIR_SCHEMA = '''{
  "questions": [
    { "num": 7,
      "solution": [ {"t":"short label:"}, {"m":"equation"} ],
      "answer": "B | [\\"A\\",\\"C\\"] | 42" }
  ]
}'''


def build_repair_prompt(flagged, type_of):
    """Ask for a corrected solution (and answer) for each inconsistent question.

    The QUESTION is deliberately not up for revision: it has already been checked
    against the syllabus, may already have a redrawn diagram, and its options are
    what the student sees. The solution is what is wrong, so the solution is what
    gets rewritten — around the data the question actually states.
    """
    L = [
        "Each question below was written by you, but its SOLUTION uses values that the "
        "question itself does not state — they are left over from an earlier version of the "
        "question. Rewrite the SOLUTION so it solves the question exactly as written.",
        "",
        "Rules:",
        "- Do NOT change the question, its options, or its numbers. Only the solution.",
        "- Use ONLY the data the question states. The listed leftover values must not appear.",
        "- Re-derive the result from those values and give the answer that actually follows. "
        "If the correct option changes, say so in \"answer\" — do not force the old one.",
        "- Same solution style as before: alternate a short 2-6 word label with its equation, "
        "as a list of parts ({\"t\":prose} / {\"m\":latex}).",
        "- For a NUMERICAL question \"answer\" must be a whole number 0-99 as a string; for SCQ a "
        "single letter; for MCQ a JSON array of letters.",
        "",
        "Return ONLY this JSON:",
        _REPAIR_SCHEMA,
        "",
        "=== QUESTIONS TO FIX ===",
    ]
    for f in flagged:
        L.append("")
        L.append("Q%s [type: %s]" % (f["num"], type_of(f["num"])))
        L.append("  QUESTION (authoritative — do not change): " + (f["stem"] or "")[:1500])
        L.append("  ITS CURRENT SOLUTION (wrong): " + (f["solution"] or "")[:2000])
        L.append("  LEFTOVER VALUES THAT MUST NOT APPEAR: " + ", ".join(f["stale"][:10]))
    return "\n".join(L)
