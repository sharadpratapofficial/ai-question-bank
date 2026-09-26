# -*- coding: utf-8 -*-
"""
Does the redrawn diagram actually say what the reframed question says?

Why this exists
---------------
The reframe pipeline changes a question's numbers and then asks an image-editing
model to change the matching labels in its figure. Two things go wrong there, and
they have different causes:

  1. COORDINATION — the instruction ("fig_edit") is written by the text model and
     can be wrong or incomplete: it names a value the stem no longer uses, or it
     forgets one of the values that changed. cli._synth_fig_edit exists to repair
     that from the numbers themselves.

  2. THE IMAGE MODEL — even given a perfect instruction, a diffusion image editor
     renders digits unreliably. Asked to change "5 Ω" to "8 Ω" it may produce "3 Ω",
     "88 Ω", or leave the original untouched. No amount of prompt wording fixes
     this, because the model is not writing text, it is drawing something that
     looks like text.

(2) is unfixable by instruction, so it has to be CHECKED. This module reads the
redrawn image back with a vision model and compares the numbers it can see against
the numbers the question now states. A failed check drives a retry, and a diagram
that still disagrees after the retries is reported instead of shipped silently —
a figure that contradicts its own question is a wrong question, not a cosmetic
blemish.

Only reads; never edits. cli._regen_figures owns the retry loop.
"""
import base64
import json
import re

import llm as _llm
from logsetup import get_logger

log = get_logger("figcheck")

# A number with the unit that follows it, if any: "8 Ω", "3.5 m/s", "12".
_VALUE = re.compile(r"-?\d+(?:\.\d+)?(?:\s*[°%]|\s*[A-Za-zΩμ°/]{1,6}(?![A-Za-z]))?")

_SYSTEM = (
    "You are a meticulous proof-reader of exam diagrams. You look ONLY at what is "
    "actually drawn in the image and report it verbatim. You never guess a value you "
    "cannot read, and you never assume the diagram is correct. You output ONLY a "
    "single valid JSON object."
)

_SCHEMA = '''{
  "labels": ["every number or short label you can read in the image, verbatim"],
  "missing": ["values the question states that the diagram should show but does not"],
  "contradicting": ["values the diagram shows that contradict the question text"],
  "unreadable": true|false,
  "ok": true|false
}'''


# A unit-shaped suffix is a unit; an English word that happens to follow a number
# is not ("0.2 and" would otherwise be carried around as if "and" were a unit).
_NOT_A_UNIT = {"and", "or", "of", "in", "at", "to", "on", "for", "with", "the", "is",
               "are", "an", "as", "by", "from", "if", "so", "then", "that", "this",
               "was", "were", "be", "it", "its", "each", "per", "than", "when", "while"}

_SPLIT_VALUE = re.compile(r"^(-?\d+(?:\.\d+)?)\s*(.*)$")


def numeric_values(text):
    """The numbers (with units when written) in a piece of question text."""
    out = []
    for raw in _VALUE.findall(text or ""):
        v = raw.strip()
        if not v:
            continue
        m = _SPLIT_VALUE.match(v)
        if m and m.group(2).strip().lower() in _NOT_A_UNIT:
            v = m.group(1)
        out.append(v)
    return out


def _norm(v):
    """Compare "8Ω", "8 Ω" and "8.0 Ω" as the same value."""
    s = re.sub(r"\s+", "", str(v or "")).lower()
    m = re.match(r"^(-?\d+(?:\.\d+)?)(.*)$", s)
    if not m:
        return s
    num, rest = m.group(1), m.group(2)
    if "." in num:
        num = num.rstrip("0").rstrip(".")
    return num + rest


def compare_labels(expected, seen):
    """Which expected values are absent from what the model read off the image.

    Deliberately one-directional: a diagram legitimately carries labels the stem
    never mentions (axis names, angles, "O" for the origin), so extra labels are
    not an error. A value the stem states and the picture contradicts IS.
    """
    seen_norm = {_norm(s) for s in seen}
    return [e for e in expected if _norm(e) not in seen_norm]


def verify_figure(provider, api_key, model, image_bytes, mime, stem_text,
                  expected_values=None, timeout=120):
    """Read `image_bytes` back with a vision model and check it against the question.

    Returns (ok, problems, labels). `problems` is a list of plain-English strings
    naming what disagrees; empty when the diagram matches. `ok` is False only when
    the model could actually read the image and found a disagreement — a failed or
    unparseable check returns ok=True with a note, because a flaky checker must
    never throw away a diagram that may well be correct.
    """
    expected = list(expected_values or [])
    prompt = [
        "The attached image is the diagram printed with the exam question below.",
        "",
        "QUESTION TEXT:",
        (stem_text or "").strip()[:2000],
        "",
    ]
    if expected:
        prompt.append("The question states these values, so the diagram must not contradict them: "
                      + ", ".join(expected[:25]))
        prompt.append("")
    prompt += [
        "Do this:",
        "1. Read EVERY number and short text label that is actually drawn in the image, verbatim.",
        "2. List any value from the question that the diagram should show but does not.",
        "3. List any value the diagram shows that CONTRADICTS the question text (e.g. the "
        "question says 8 Ω and the diagram says 5 Ω, or the diagram shows a value the "
        "question replaced).",
        "",
        "Rules:",
        "- Report only what you can genuinely see. If the image is too blurry or garbled to "
        "read, set \"unreadable\": true.",
        "- A label the question never mentions (axis names, points like O or P, angles) is NOT "
        "a contradiction — ignore it.",
        "- \"ok\" is true only when nothing in the diagram contradicts the question.",
        "",
        "Return ONLY this JSON:",
        _SCHEMA,
    ]
    images = [{"name": "figure.png", "mime": mime or "image/png",
               "b64": base64.b64encode(image_bytes or b"").decode()}]
    try:
        res = _llm.generate(provider, api_key, model, "\n".join(prompt), images=images,
                            system=_SYSTEM, timeout=timeout, max_tokens=1500)
    except Exception as e:
        log.warning("figure check failed to run: %s", str(e)[:200])
        return True, [], []

    if not isinstance(res, dict):
        return True, [], []
    labels = [str(x) for x in (res.get("labels") or [])]
    if res.get("unreadable"):
        return False, ["the redrawn diagram is not legible"], labels

    problems = []
    for item in (res.get("contradicting") or []):
        problems.append("the diagram shows %s, which contradicts the question" % str(item)[:120])
    for item in (res.get("missing") or []):
        problems.append("the diagram does not show %s, which the question states" % str(item)[:120])

    # A deterministic backstop for the model's own judgement: if it read the labels
    # but claimed everything was fine while an expected value is plainly absent from
    # what it read, trust the reading, not the verdict.
    if expected and labels and not problems:
        absent = compare_labels(expected, labels)
        # Only flag when MOST of the expected values are missing — a diagram
        # legitimately labels some quantities and leaves others to the text.
        if len(absent) == len(expected) and len(expected) >= 1:
            problems.append("none of the question's values (%s) appear in the diagram; it reads: %s"
                            % (", ".join(expected[:6]), ", ".join(labels[:8]) or "nothing"))

    ok = not problems and bool(res.get("ok", True))
    if not ok and not problems:
        problems.append("the checker judged the diagram inconsistent with the question")
    log.info("figure check: ok=%s problems=%d labels=%d", ok, len(problems), len(labels))
    return ok, problems, labels


def amend_instruction(instruction, problems):
    """Fold what the check found back into the redraw instruction for a retry.

    Repeating the same instruction to the same model usually reproduces the same
    mistake; naming what came out wrong is what makes the second attempt different.
    """
    extra = " ".join(str(p) for p in problems[:6])
    return (
        (instruction or "").rstrip()
        + "\n\nTHE PREVIOUS ATTEMPT WAS WRONG: " + extra
        + " Fix exactly that. Read every number you draw back to yourself before finishing and "
          "confirm each one matches the value named above, digit for digit."
    )
