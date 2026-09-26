# -*- coding: utf-8 -*-
"""
QC-and-fix: audit each reframed question, then correct what is wrong — before it
is pushed to QBG.

Why a separate stage
-------------------
The reframe model writes the question, its options, its answer and its solution
in one pass, and then an image model redraws the figure from an instruction. Each
of those steps can be individually reasonable and still leave the finished
question wrong — most often because the DIAGRAM says something the text does not
(2026-09-08/09 reports). Nothing downstream re-reads the question as a whole, so
this stage does: one model, one question at a time, with the figure attached as
an image so the picture and the words are judged together.

It differs from the checks that already exist:

  * figcheck.py asks "does this redrawn figure match the stem's numbers?" — a
    narrow, mechanical comparison used to drive a redraw retry.
  * consistency.py catches one deterministic signature (the solution still using
    the ORIGINAL question's values).
  * this module re-solves the question, verifies the key, judges the options, the
    solution, the data and the figure together, and RETURNS CORRECTIONS.

Distilled from the user's "Unified Physics Question-Paper QC & Audit" prompt —
the parts that apply when the auditor is also allowed to repair: independent
re-solve before looking at the key, answer-format legality, option distinctness,
line-by-line solution verification, the figure protocol, data sufficiency, the
proof rule (evidence or no defect), the devil's-advocate rule (a defensible
convention is not a defect) and the no-over-flagging rule (cosmetics are not
defects). The audit-only machinery — paper-level balance, answer-key
distribution, duplicate clusters, timing — belongs to Agentic QC, which runs over
a whole paper; this runs per question, inside the push pipeline.

Nothing here is silent: every change is returned with the before and the after,
so a run can be inspected to see whether QC actually did anything.
"""
import base64
import copy
import json
import os

import llm as _llm
import progress as _progress
from logsetup import get_logger

log = get_logger("qcfix")

_LET = "ABCDEF"

# Fields QC is allowed to rewrite. Anything else it returns is ignored — a QC
# pass that could restructure a question would be a second author, not a checker.
_FIXABLE = ("stem", "options", "answer", "solution", "fig_edit")

_SYSTEM = (
    "You are a senior JEE/NEET physics examiner running quality control on a single "
    "exam question, and you are also the editor who repairs it. You solve the question "
    "yourself before looking at its printed answer. You report only defects you can "
    "prove from what is in front of you, and you change only what is actually wrong. "
    "You output ONLY one valid JSON object matching the schema you are given — no "
    "markdown, no commentary. Escape every backslash in LaTeX as \\\\."
)

_SCHEMA = '''{
  "verdict": "PASS | MINOR | MODERATE | MAJOR",
  "confidence": 0-100,
  "solved": {"answer": "the answer YOU derived", "working": "one or two lines of your own working"},
  "defects": [
    {"category": "KEY|OPT|SOL|FIG|DAT|PHY|PAT|LNG",
     "severity": "MINOR|MODERATE|MAJOR",
     "evidence": "the exact text, value or figure label that proves it",
     "fix": "what you changed, in one line"}
  ],
  "corrected": {
    "stem": null,
    "options": null,
    "answer": null,
    "solution": null,
    "fig_edit": null
  }
}'''


def _parts_text(parts):
    """Readable text for a parts list ({"t"}/{"m"}/{"h"}/{"img"})."""
    out = []
    for p in parts or []:
        if not isinstance(p, dict):
            continue
        if "t" in p:
            out.append(str(p["t"]))
        elif "m" in p:
            out.append("$" + str(p["m"]) + "$")
        elif "h" in p:
            out.append("[markup]")
        elif "img" in p:
            out.append("[image: %s]" % p["img"])
    return " ".join(out).strip()


def _answer_text(ans):
    if isinstance(ans, (list, tuple)):
        return ", ".join(str(a) for a in ans)
    return str(ans or "")


def _question_block(q):
    """The question as the auditor sees it."""
    L = ["QUESTION %s  [type: %s]" % (q.get("num"), q.get("type") or "SCQ"), ""]
    L.append("STEM: " + _parts_text(q.get("stem")))
    opts = q.get("options") or []
    if opts:
        L.append("")
        L.append("OPTIONS:")
        for i, o in enumerate(opts[: len(_LET)]):
            if isinstance(o, dict) and o.get("img"):
                L.append("  (%s) [image option: %s]" % (_LET[i], o["img"]))
            else:
                L.append("  (%s) %s" % (_LET[i], _parts_text(o)))
    L.append("")
    L.append("PRINTED ANSWER: " + (_answer_text(q.get("answer")) or "(none)"))
    L.append("")
    L.append("PRINTED SOLUTION: " + (_parts_text(q.get("solution")) or "(none)"))
    if q.get("fig"):
        L.append("")
        L.append("FIGURE: attached as an image. It is part of the question — read it.")
    return "\n".join(L)


def _rules(has_fig, numerical_range):
    L = [
        "",
        "HOW TO AUDIT — in this order:",
        "1. SOLVE IT YOURSELF FIRST, from the stem and the figure alone, before you read the "
        "printed answer or solution. Put your result in \"solved\".",
        "2. Compare your result with the printed answer. If they differ, find out which is "
        "wrong before deciding anything — re-check your own arithmetic first.",
        "3. Check the answer FORMAT: an SCQ must have exactly one correct option; an MCQ at "
        "least one and every option judged on its own; a Numerical answer must be "
        + numerical_range + ".",
        "4. Check the OPTIONS: all present, distinct after simplification and unit conversion, "
        "dimensionally consistent, and only one defensible reading of which is correct.",
        "5. Check the SOLUTION line by line: every step must follow from the previous one and "
        "use only data the stem states. A correct final answer does not excuse a wrong step, "
        "and a value that appears in the working but not in the question is a defect.",
        "6. Check DATA SUFFICIENCY: everything needed is given, nothing contradicts, the "
        "quantity asked for and its unit are unambiguous.",
    ]
    if has_fig:
        L += [
            "7. CHECK THE FIGURE — this is the most common failure, so do it carefully:",
            "   a. Read every number, label, arrow, direction and connection actually drawn in "
            "the attached image. Report what you see, not what you expect.",
            "   b. Compare each of those against the stem and against the solution. A value the "
            "figure shows that the question does not state (or states differently) is a MAJOR "
            "FIG defect — this is the single most common error in these papers.",
            "   c. Decide WHICH side is wrong and say so in the evidence. Normally the TEXT is "
            "authoritative and the picture must be redrawn to match it: put a precise redraw "
            "instruction in \"fig_edit\" naming the exact old label and the exact new one. Only "
            "change the text instead when the figure is clearly right and the text has a typo.",
            "   d. If the figure is illegible or missing something the question refers to, say "
            "so as a FIG defect and leave fig_edit null.",
        ]
    L += [
        "",
        "WHAT COUNTS AS A DEFECT:",
        "- PROOF RULE: every defect must quote the exact text, value or figure label that proves "
        "it, or show the calculation. Never report a defect you cannot point at.",
        "- DEVIL'S ADVOCATE: before you call something MAJOR, argue the other side — is it "
        "defensible under some accepted convention (g = 9.8 vs 10, magnitude vs signed value, "
        "rounding at a different step)? If it is defensible, it is not a defect.",
        "- NO OVER-FLAGGING: house style, spacing, a synonym, a differently formatted but "
        "unambiguous unit — none of these are defects. Do not report them and do not 'fix' them.",
        "- A question can be solvable and still defective; report the defect anyway.",
        "",
        "WHAT TO CHANGE:",
        "- Put a corrected value in \"corrected\" ONLY for the fields that are actually wrong. "
        "Leave every other field null. A question with no defects has verdict PASS, an empty "
        "defects list, and every corrected field null.",
        "- Do NOT rewrite a question you merely would have written differently. This is a "
        "repair, not a re-authoring: keep the scenario, the numbers and the difficulty unless "
        "one of them is the defect.",
        "- \"stem\", \"options\" and \"solution\" use the same part shape as the input: a list of "
        "{\"t\": prose} / {\"m\": latex} objects (options are a list of such lists). Keep the same "
        "number of options and their order.",
        "- \"answer\" is a single letter for SCQ, a list of letters for MCQ, a plain number for "
        "Numerical — matching whatever the corrected options say.",
        "- If you change the data in the stem, the solution and the answer MUST be updated to "
        "match, in the same response.",
        "",
        "Return ONLY this JSON:",
        _SCHEMA,
    ]
    return L


def _build_prompt(q, numerical_range):
    L = ["Audit and, where necessary, repair this exam question.", ""]
    L.append(_question_block(q))
    L.extend(_rules(bool(q.get("fig")), numerical_range))
    return "\n".join(L)


def _image_for(q, figdir):
    """The question's figure, as the payload llm.generate expects."""
    name = q.get("fig")
    if not name or not figdir:
        return []
    path = os.path.join(figdir, name)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "rb") as f:
            return [{"name": name, "mime": "image/png",
                     "b64": base64.b64encode(f.read()).decode()}]
    except OSError:
        log.warning("qc: could not read figure %s", path)
        return []


def _clean_parts(value):
    """Accept only a well-formed parts list; anything else is discarded."""
    if not isinstance(value, list) or not value:
        return None
    out = []
    for p in value:
        if isinstance(p, dict) and ("t" in p or "m" in p or "img" in p or "h" in p):
            out.append(p)
    return out or None


def _clean_options(value, original):
    """Corrected options must keep the original count and shape."""
    if not isinstance(value, list) or not value:
        return None
    if original and len(value) != len(original):
        log.info("qc: ignoring an options rewrite that changed the count (%d -> %d)",
                 len(original), len(value))
        return None
    out = []
    for o in value:
        if isinstance(o, dict) and "img" in o:
            out.append(o)
            continue
        parts = _clean_parts(o)
        if parts is None:
            return None
        out.append(parts)
    return out


def _diff_fields(before, after):
    """Which of the fixable fields actually changed."""
    changed = []
    for key in _FIXABLE:
        if key == "fig_edit":
            continue
        if json.dumps(before.get(key), sort_keys=True, ensure_ascii=False) != \
                json.dumps(after.get(key), sort_keys=True, ensure_ascii=False):
            changed.append(key)
    return changed


def qc_and_fix(questions, figdir, provider, api_key, model, base_url=None,
               numerical_range="a whole number from 0 to 99", timeout=180):
    """Audit every question, apply the corrections, and report what changed.

    Returns (questions, results). Each result carries the verdict, the defects,
    the fields changed, and the BEFORE/AFTER of each changed field — so a run can
    be checked for whether QC did anything at all.

    A question whose audit fails (bad JSON, model error) is left exactly as it
    was and reported with status "failed": QC must never be able to damage a
    question it could not read.
    """
    out = []
    results = []
    total = len(questions)
    for i, q in enumerate(questions, 1):
        q = dict(q)
        num = q.get("num", i)
        _progress.emit("qc", "QC checking Q%s (%d/%d)…" % (num, i, total), done=i, total=total)
        before = copy.deepcopy({k: q.get(k) for k in _FIXABLE})
        images = _image_for(q, figdir)
        try:
            res = _llm.generate(provider, api_key, model, _build_prompt(q, numerical_range),
                                images=images, system=_SYSTEM, base_url=base_url,
                                timeout=timeout, max_tokens=6000)
        except Exception as e:
            log.exception("qc failed for Q%s", num)
            results.append({"num": num, "status": "failed", "detail": str(e)[:300],
                            "saw_figure": bool(images)})
            out.append(q)
            continue

        if not isinstance(res, dict):
            results.append({"num": num, "status": "failed",
                            "detail": "the QC model did not return an object",
                            "saw_figure": bool(images)})
            out.append(q)
            continue

        corrected = res.get("corrected") or {}
        applied = {}
        if isinstance(corrected, dict):
            parts_fix = _clean_parts(corrected.get("stem"))
            if parts_fix:
                q["stem"] = parts_fix
                applied["stem"] = True
            opts_fix = _clean_options(corrected.get("options"), q.get("options"))
            if opts_fix:
                q["options"] = opts_fix
                applied["options"] = True
            sol_fix = _clean_parts(corrected.get("solution"))
            if sol_fix:
                q["solution"] = sol_fix
                applied["solution"] = True
            ans_fix = corrected.get("answer")
            if ans_fix not in (None, "", []):
                q["answer"] = ans_fix
                applied["answer"] = True
            fig_fix = corrected.get("fig_edit")
            if isinstance(fig_fix, str) and fig_fix.strip() and q.get("fig"):
                # Handed to the image editor by the caller, which redraws and
                # re-verifies exactly as the ordinary redraw does.
                q["fig_edit"] = fig_fix.strip()
                q["_qc_fig_edit"] = fig_fix.strip()
                applied["fig_edit"] = True

        changed = _diff_fields(before, {k: q.get(k) for k in _FIXABLE})
        if applied.get("fig_edit"):
            changed.append("figure")

        defects = [d for d in (res.get("defects") or []) if isinstance(d, dict)]
        entry = {
            "num": num,
            "status": "changed" if changed else "clean",
            "verdict": str(res.get("verdict") or ("MAJOR" if changed else "PASS"))[:20],
            "confidence": res.get("confidence"),
            "saw_figure": bool(images),
            "defects": [{
                "category": str(d.get("category") or "")[:12],
                "severity": str(d.get("severity") or "")[:12],
                "evidence": str(d.get("evidence") or "")[:600],
                "fix": str(d.get("fix") or "")[:400],
            } for d in defects[:12]],
            "changed_fields": changed,
        }
        if changed:
            # The before/after is the point of the report: it is how anyone can
            # tell whether the QC model actually did something.
            entry["before"] = {k: before.get(k) for k in changed if k in _FIXABLE}
            entry["after"] = {k: q.get(k) for k in changed if k in _FIXABLE}
            if applied.get("fig_edit"):
                entry["fig_edit"] = q.get("_qc_fig_edit")
        solved = res.get("solved")
        if isinstance(solved, dict):
            entry["solved"] = {"answer": str(solved.get("answer") or "")[:80],
                               "working": str(solved.get("working") or "")[:500]}
        results.append(entry)
        log.info("qc Q%s: verdict=%s defects=%d changed=%s",
                 num, entry["verdict"], len(defects), changed or "-")
        out.append(q)

    return out, results


def summarize(results):
    """One line for the run's warnings, and the counts the UI shows."""
    changed = [r for r in results if r.get("status") == "changed"]
    failed = [r for r in results if r.get("status") == "failed"]
    major = [r for r in results if str(r.get("verdict", "")).upper() == "MAJOR"]
    return {
        "checked": len(results),
        "changed": len(changed),
        "failed": len(failed),
        "major": len(major),
        "changed_nums": [r["num"] for r in changed],
        "with_figure": len([r for r in results if r.get("saw_figure")]),
    }
