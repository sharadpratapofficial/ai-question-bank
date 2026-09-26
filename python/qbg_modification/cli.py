"""
Headless CLI around the QBG-modification (MCQ reframer) pipeline, so the Next.js
API route can shell out to a single command instead of running Streamlit.

Subcommands
-----------
  reframe <input.docx> <out_dir> --provider P --model M [--no-images]
      Full pipeline: extract questions + diagrams from the .docx, reframe them
      with an AI model, and build the interactive HTML folder + CSV exports.
      The API key is read from env QBG_MOD_API_KEY (never passed on argv).

  build <reframed.json> <figdir> <out_dir> [--source-name NAME]
      Assisted mode: skip the AI call — take a reframed-questions JSON that was
      produced elsewhere and just build the HTML folder + modified CSV.

On success: exit 0, a JSON report is printed to stdout.
On rejected/invalid input: exit 3 with a message on stderr.
On unexpected error: exit 1 with a traceback on stderr.
Wrong usage: exit 2.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import tempfile
import traceback
from pathlib import Path

from PIL import Image

# On Windows, sys.stdout/stderr default to cp1252, which can't encode math /
# invisible unicode (e.g. U+2061 FUNCTION APPLICATION) that can appear in
# rendered questions. The Node caller reads stdout as UTF-8, so force UTF-8 here
# BEFORE any output, or json.dump(report, sys.stdout) crashes with a
# UnicodeEncodeError after the (successful) pipeline finishes.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

import extract as _extract
import ai_extract as _ai_extract
import ingest_extract as _ingest_extract
import figcheck as _figcheck
import consistency as _consistency
import qcfix as _qcfix
import answerkey as _answerkey
import tagmatch as _tagmatch
import llm as _llm
import qbg as _qbg
import imagegen as _imagegen
import progress as _progress
from htmlbuild import build_html, write_project
from csvbuild import build_csv, original_records, modified_records
from logsetup import get_logger

log = get_logger("cli")

# The sidecar accepts the app's provider ids directly (see llm.PROVIDERS).
PROVIDERS = _llm.PROVIDERS

# App-style image-model provider ids -> imagegen.py display names.
IMG_PROVIDER_MAP = {
    "gemini": "Google Gemini (nano banana)",
    "openai": "OpenAI (gpt-image-1)",
}

# Reframing all questions in a single giant LLM call is fragile for large papers:
# the response can be truncated by the provider's output-token limit, or the model
# can simply "give up" partway through a big batch and return far fewer questions
# than requested (e.g. 20 in -> 1 out). Splitting into small chunks keeps each call
# well inside any provider's output budget and means a bad chunk doesn't lose the
# rest of the paper.
REFRAME_CHUNK_SIZE = 5


def _match_figure_size(new_bytes: bytes, orig_path: str) -> bytes:
    """Scale an AI-redrawn figure DOWN to fit inside the ORIGINAL figure's pixel
    box (preserving aspect ratio) so it renders at the same on-screen size in QBG
    as the diagram it replaced. Image models emit a large canvas (gpt-image-1 is
    1024px+, Gemini similar), and the pushed <img> tag carries no width/height, so
    QBG shows the figure at its intrinsic pixel size — without this, a small source
    diagram comes back visibly much larger. Never enlarges (thumbnail only shrinks);
    returns the input bytes unchanged if the original size can't be read or the new
    image already fits."""
    try:
        with Image.open(orig_path) as om:
            ow, oh = om.size
        img = Image.open(io.BytesIO(new_bytes))
        if img.width <= ow and img.height <= oh:
            return new_bytes
        img = img.convert("RGB")
        img.thumbnail((ow, oh), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return new_bytes


_NUM_TOKEN = re.compile(r'-?\d+(?:\.\d+)?')


def _stem_plain(parts):
    """Plain text of a reframed question's stem parts."""
    out = []
    for p in parts or []:
        if isinstance(p, dict):
            out.append(str(p.get("t") if "t" in p else p.get("m", "")))
    return " ".join(out)


def _synth_fig_edit(orig_text, new_text):
    """Build a surgical redraw instruction from the numbers a reframe changed.

    Returns (instruction, pairs, reason). `instruction` is None when nothing can
    be said with confidence — either the numbers didn't change, or the two stems
    don't line up 1:1 so we can't tell which old value became which new one.

    This exists because a stale diagram is a WRONG question, not a cosmetic
    issue: the reframed stem says "3 m/s" while the untouched picture still says
    "4 m/s" (2026-08-30 bug report). The model is asked to fill "fig_edit" for
    exactly this, but it may return null, and then the mismatch used to ship
    silently."""
    a = _NUM_TOKEN.findall(orig_text or "")
    b = _NUM_TOKEN.findall(new_text or "")
    if not a:
        return None, [], "the original stem has no numbers to compare"
    if len(a) != len(b):
        return None, [], ("the stems have different numeric counts (%d vs %d), so old and new "
                          "values can't be matched up" % (len(a), len(b)))
    pairs = [(x, y) for x, y in zip(a, b) if x != y]
    if not pairs:
        return None, [], None          # nothing changed — the original figure is still correct
    instr = (
        "Update ONLY the numeric labels in this diagram: "
        + "; ".join("change the label '%s' to '%s'" % (x, y) for x, y in pairs)
        + ". Keep every other label, arrow, shape, position, size, font and style EXACTLY as "
          "in the original image — do not move, restyle or redraw anything else, and do not add "
          "or remove any element."
    )
    return instr, pairs, None


def _fill_missing_fig_edits(questions, originals):
    """For every reframed question that kept a figure but whose "fig_edit" the model
    left null, derive one from the numbers that actually changed. Returns
    (questions, warnings)."""
    by_num = {q.get("num"): q for q in (originals or [])}
    out, warnings = [], []
    for i, q in enumerate(questions, 1):
        q = dict(q)
        num = q.get("num", i)
        if q.get("fig") and not q.get("fig_edit"):
            orig = by_num.get(num) or {}
            instr, pairs, reason = _synth_fig_edit(orig.get("q_text", ""), _stem_plain(q.get("stem")))
            if instr:
                q["fig_edit"] = instr
                q["_fig_edit_synth"] = True
                log.info("Q%s: derived fig_edit from %d changed value(s): %s",
                         num, len(pairs), pairs)
            elif reason:
                warnings.append(
                    "Q%s: the diagram was left as-is and may still show the original "
                    "question's values — %s. Check it, or re-run with \"Redraw every "
                    "figure\"." % (num, reason))
        out.append(q)
    return out, warnings


def _stale_figure_warnings(questions, originals):
    """Diagram redraw is OFF: flag any question whose numbers changed but whose
    figure therefore still shows the original values."""
    by_num = {q.get("num"): q for q in (originals or [])}
    warnings = []
    for i, q in enumerate(questions, 1):
        num = q.get("num", i)
        if not q.get("fig"):
            continue
        orig = by_num.get(num) or {}
        a = _NUM_TOKEN.findall(orig.get("q_text", "") or "")
        b = _NUM_TOKEN.findall(_stem_plain(q.get("stem")))
        if a and len(a) == len(b) and any(x != y for x, y in zip(a, b)):
            warnings.append(
                "Q%s: the reframed values differ from the original but its diagram was not "
                "redrawn, so the picture still shows the original numbers. Enable \"Redraw "
                "figures\" to update it." % num)
    return warnings


# How many times a diagram is redrawn before we give up and report it. Two extra
# attempts is where the returns flat-lined in practice: a diffusion editor that has
# fumbled the same digits twice, having been told exactly what it got wrong, is not
# going to get it on the fifth try either.
_FIG_ATTEMPTS = 3


def _regen_figures(questions, figdir, provider, api_key, model,
                   check=None):
    """Redraw each reframed question's figure whose JSON set a non-null "fig_edit"
    (a described diagram change) via imagegen.edit_image. Returns
    (new_questions, results). Leaves 'fig' untouched on failure.

    Reports each result under the question's own original "num" (not its position
    in the list) — with chunked reframing a question can be dropped/reordered, so
    position no longer reliably identifies which original question this is.

    `check` (optional) is {"provider","api_key","model"} for a TEXT model that can
    see images. When given, every redraw is read back and compared against the
    question before it is accepted: an image editor renders digits unreliably, so
    "5 Ω" asked to become "8 Ω" can come back as "3 Ω" no matter how the
    instruction is worded (see figcheck.py). A diagram that fails the check is
    redrawn with the failure named, and one that still fails is reported rather
    than shipped as a question whose picture contradicts its own text."""
    out = []
    results = []
    for i, q in enumerate(questions, 1):
        q = dict(q)
        num = q.get("num", i)
        fig = q.get("fig")
        edit = q.get("fig_edit")
        if fig and edit:
            src_path = os.path.join(figdir, fig)
            if not os.path.exists(src_path):
                results.append({"num": num, "status": "failed",
                                "detail": "original figure %s not found" % fig})
            else:
                try:
                    with open(src_path, "rb") as f:
                        orig_bytes = f.read()
                    stem_text = _stem_plain(q.get("stem"))
                    expected = _figcheck.numeric_values(stem_text) if check else []
                    instruction = edit
                    new_bytes = None
                    problems = []
                    attempts = _FIG_ATTEMPTS if check else 1
                    for attempt in range(1, attempts + 1):
                        drawn = _imagegen.edit_image(provider, api_key, model, orig_bytes,
                                                     "image/png", instruction)
                        # Shrink the model's large canvas back to the original diagram's
                        # on-screen size so it doesn't render oversized in QBG.
                        drawn = _match_figure_size(drawn, src_path)
                        new_bytes = drawn
                        if not check:
                            problems = []
                            break
                        ok, problems, _labels = _figcheck.verify_figure(
                            check["provider"], check["api_key"], check["model"],
                            drawn, "image/png", stem_text, expected)
                        if ok:
                            break
                        log.info("Q%s: redraw attempt %d/%d rejected: %s",
                                 num, attempt, attempts, "; ".join(problems)[:300])
                        if attempt < attempts:
                            instruction = _figcheck.amend_instruction(edit, problems)
                    new_name = "q%s_figure_ai.png" % num
                    with open(os.path.join(figdir, new_name), "wb") as f:
                        f.write(new_bytes)
                    q["fig"] = new_name
                    if problems:
                        q["_fig_unverified"] = problems
                        results.append({"num": num, "status": "needs review",
                                        "detail": "%s — redrawn %d time(s), still: %s"
                                                  % (new_name, attempts, "; ".join(problems)[:300])})
                    else:
                        results.append({"num": num, "status": "regenerated", "detail": new_name})
                except Exception as e:
                    results.append({"num": num, "status": "failed", "detail": str(e)[:400]})
        out.append(q)
    return out, results


def _gen_solution_diagrams(questions, figdir, provider, api_key, model):
    """Draw a fresh diagram (via imagegen.generate_image, same call Ingestion uses for a
    missing stem figure — see ingest_extract._generate_fig) for each reframed question
    whose JSON set a non-null "sol_diagram_desc" (opt-in — see extract.py's
    gen_solution_diagrams prompt gating: only set for the rare solution that genuinely
    needs its own diagram). The image is spliced in as the FIRST part of that question's
    "solution" list ({"img": name}) — csvbuild.py/htmlbuild.py already render an inline
    solution image generically (used today by QBG Ingestion), so no downstream change is
    needed. Returns (new_questions, results); leaves 'solution' untouched on failure or
    when no description was requested."""
    out = []
    results = []
    for i, q in enumerate(questions, 1):
        q = dict(q)
        num = q.get("num", i)
        desc = q.pop("sol_diagram_desc", None)
        if desc:
            try:
                img_bytes = _imagegen.generate_image(provider, api_key, model, desc)
                img_name = "q%s_soldiag.png" % num
                with open(os.path.join(figdir, img_name), "wb") as f:
                    f.write(img_bytes)
                q["solution"] = [{"img": img_name}] + list(q.get("solution") or [])
                results.append({"num": num, "status": "generated", "detail": img_name})
            except Exception as e:
                results.append({"num": num, "status": "failed", "detail": str(e)[:400]})
        out.append(q)
    return out, results


def _gen_new_figures(questions, figdir, provider, api_key, model):
    """Draw a brand-new STEM diagram (via imagegen.generate_image) for each reframed question
    whose JSON set a non-null "new_fig_desc" — i.e. a question that had NO original figure
    and that the model judged would be genuinely clearer with one (opt-in; see extract.py's
    add_figures gating). The image is written into figdir and becomes that question's "fig", so
    csvbuild.py/htmlbuild.py render it exactly like an original diagram and no downstream change
    is needed. Returns (new_questions, results); leaves the question untouched on failure, and
    never overwrites a question that already has a figure (those go through _regen_figures)."""
    out = []
    results = []
    for i, q in enumerate(questions, 1):
        q = dict(q)
        num = q.get("num", i)
        desc = q.pop("new_fig_desc", None)
        if desc and not q.get("fig"):
            try:
                img_bytes = _imagegen.generate_image(provider, api_key, model, desc)
                img_name = "q%s_newfig.png" % num
                with open(os.path.join(figdir, img_name), "wb") as f:
                    f.write(img_bytes)
                q["fig"] = img_name
                results.append({"num": num, "status": "generated", "detail": img_name})
            except Exception as e:
                results.append({"num": num, "status": "failed", "detail": str(e)[:400]})
        out.append(q)
    return out, results


_REQUIRED_KEYS = ("stem", "options", "answer", "solution")


def _validate_questions(questions) -> list[str]:
    """Same shape checks the Streamlit app applied before building — used for the
    `build` subcommand (assisted mode), where there is no chunking to fall back on."""
    problems: list[str] = []
    for i, q in enumerate(questions, 1):
        for key in _REQUIRED_KEYS:
            if key not in q:
                problems.append(f"Q{i} missing '{key}'")
        if q.get("options") and len(q["options"]) != 4:
            problems.append(f"Q{i} has {len(q['options'])} options (expected 4)")
    return problems


def _normalize_mcq_letters(ans):
    """MCQ 'answer' should be a JSON array of letters (e.g. ["A","C"]) per build_prompt's
    type_rule, but tolerate a bare string too (e.g. "A" or "AC") — extract every A-D
    letter found, de-duplicated, order-preserving. Returns a list (possibly empty)."""
    if isinstance(ans, (list, tuple)):
        letters = [str(a).strip().upper() for a in ans if str(a).strip()]
    else:
        letters = re.findall(r'[A-D]', str(ans or "").upper())
    seen = []
    for l in letters:
        if l in ("A", "B", "C", "D") and l not in seen:
            seen.append(l)
    return seen


def _as_integer_answer(ans, lo=0, hi=99):
    """Normalise a Numerical answer to a whole number in [lo, hi], or None.

    JEE-Mains integer-type questions accept 0-99 only. "42" and "42.0" both
    normalise to "42"; a genuine decimal (37.714), a negative, or anything out
    of range returns None so the caller can drop the question."""
    s = str(ans or "").strip()
    if not s:
        return None
    try:
        value = float(s)
    except ValueError:
        return None
    if value != int(value):          # a real decimal, not 42.0
        return None
    value = int(value)
    if value < lo or value > hi:
        return None
    return str(value)


def _blank_option_indexes(options):
    """Indexes of options that would render as nothing at all.

    An option is either {"img": name} (a picture) or a parts list of
    {"t"/"m"} fragments. Anything with no image and no non-whitespace text is
    unanswerable on screen, so it must never reach QBG."""
    blank = []
    for i, opt in enumerate(options):
        if isinstance(opt, dict):
            if not str(opt.get("img") or "").strip():
                blank.append(i)
            continue
        if not isinstance(opt, (list, tuple)):
            blank.append(i)
            continue
        text = "".join(
            str(p.get("t", "") or "") + str(p.get("m", "") or "")
            for p in opt if isinstance(p, dict)
        )
        if not text.strip():
            blank.append(i)
    return blank


def _filter_valid_questions(chunk_qs, expected_nums, orig_type_by_num=None):
    """Drop any question missing a required field, with the wrong option count, or
    whose "num" doesn't match one of this chunk's original question numbers (so a
    hallucinated/missing num can never mis-pair a reframed question with the wrong
    original in the compare panel). Returns (valid, problem_messages).

    `orig_type_by_num`: {num: "SCQ"|"MCQ"|"NUMERICAL"|"MATCHING_LIST"|"ASSERTION_REASON"} — the ORIGINAL
    question's type (see extract.py/qbg.py). Enforced here as a safety net on top of
    the prompt-level instruction (build_prompt's type_rule): e.g. a Numerical original
    must come back with no options and a plain numeric answer, or it's dropped rather
    than silently letting a wrongly-typed (SCQ-shaped) question through. Each surviving
    question has its own "type" set to the ORIGINAL's type (not whatever — if anything —
    the AI put there), so downstream QBG push uses the correct type."""
    orig_type_by_num = orig_type_by_num or {}
    valid = []
    problems: list[str] = []
    seen_nums: set[int] = set()
    for q in chunk_qs:
        num = q.get("num")
        label = "Q%s" % (num if num is not None else "?")
        orig_type = orig_type_by_num.get(num, "SCQ")
        # Assertion_Reason is told NOT to include "options" at all (the 4 choices are
        # fixed and injected below, not written by the AI) — don't require that key
        # for this type, unlike every other type where an "options" key (even [], for
        # NUMERICAL) is always expected.
        required_keys = _REQUIRED_KEYS if orig_type != "ASSERTION_REASON" \
            else tuple(k for k in _REQUIRED_KEYS if k != "options")
        missing = [k for k in required_keys if k not in q]
        if missing:
            problems.append(f"{label} missing {', '.join(missing)} — dropped")
            continue
        if q.get("options") and len(q["options"]) != 4:
            problems.append(f"{label} has {len(q['options'])} options (expected 4) — dropped")
            continue
        # Count alone isn't enough: the model can return the right NUMBER of
        # options that are all empty. That happened on an image-option question
        # (four graphs) the model reworded — it couldn't supply new pictures, so
        # it emitted four blank options, which sailed through and were pushed to
        # QBG as "succeeded" with nothing to choose from (2026-08-17 bug report).
        blank = _blank_option_indexes(q.get("options") or [])
        if blank:
            problems.append(
                f"{label}: option(s) {', '.join('ABCD'[i] for i in blank if i < 4)} came back "
                f"empty (the AI produced no text and no image for them) — dropped rather than "
                f"pushing an unanswerable question")
            continue
        if not isinstance(num, int) or num not in expected_nums:
            problems.append(f"{label} has a missing/unexpected 'num' — dropped")
            continue
        if num in seen_nums:
            problems.append(f"{label} duplicate 'num' in this batch — dropped")
            continue
        opts = q.get("options") or []
        if orig_type == "NUMERICAL":
            if opts:
                problems.append(f"{label}: original is Numerical (no options) but the AI added "
                                 f"options — dropped")
                continue
            # JEE-Mains numerical questions take an INTEGER answer in 0-99. The
            # old check accepted any decimal, so a reframe whose answer worked
            # out to 12*pi was pushed as "37.7142857143" — unanswerable in that
            # format (2026-08-17 bug report). See extract.build_prompt, which
            # now tells the model to pick values that land on a clean integer.
            ans = str(q.get("answer") or "").strip()
            normalised = _as_integer_answer(ans)
            if normalised is None:
                problems.append(f"{label}: original is Numerical but the AI's answer "
                                 f"\"{ans}\" is not a whole number in 0-99 (JEE-Mains "
                                 f"integer format) — dropped")
                continue
            q = dict(q)
            q["answer"] = normalised
        elif orig_type == "MCQ":
            if not opts:
                problems.append(f"{label}: original is MCQ (has options) but the AI returned none — dropped")
                continue
            letters = _normalize_mcq_letters(q.get("answer"))
            if not letters:
                problems.append(f"{label}: original is MCQ but the AI's answer "
                                 f"\"{q.get('answer')}\" has no valid option letter — dropped")
                continue
            q = dict(q)
            q["answer"] = letters
        elif orig_type == "MATCHING_LIST":
            if not opts:
                problems.append(f"{label}: original is Matching_List but the AI returned no combination options — dropped")
                continue
            list1 = q.get("list1") or []
            list2 = q.get("list2") or []
            if not list1 or not list2:
                problems.append(f"{label}: original is Matching_List but the AI didn't return "
                                 f"list1/list2 — dropped")
                continue
            ans = str(q.get("answer") or "").strip().upper()
            if ans not in ("A", "B", "C", "D"):
                problems.append(f"{label}: original is Matching_List but the AI's answer "
                                 f"\"{q.get('answer')}\" is not a single option letter — dropped")
                continue
            q = dict(q)
            q["fig"] = None   # never carry the stale table image, regardless of what the AI set
        elif orig_type == "ASSERTION_REASON":
            assertion = q.get("assertion") or []
            reason = q.get("reason") or []
            if not assertion or not reason:
                problems.append(f"{label}: original is Assertion_Reason but the AI didn't return "
                                 f"assertion/reason — dropped")
                continue
            ans = str(q.get("answer") or "").strip().upper()
            if ans not in ("A", "B", "C", "D"):
                problems.append(f"{label}: original is Assertion_Reason but the AI's answer "
                                 f"\"{q.get('answer')}\" is not a single A/B/C/D letter — dropped")
                continue
            q = dict(q)
            # The 4 choices are fixed QBG-wide — use the real wording rather than
            # trusting the AI to reproduce it verbatim (it isn't asked to write them).
            q["options"] = [[{"t": opt}] for opt in _qbg.ASSERTION_REASON_OPTIONS]
        elif not opts:
            problems.append(f"{label}: original has options but the AI returned none — dropped")
            continue
        q = dict(q)
        q["type"] = orig_type
        seen_nums.add(num)
        valid.append(q)
    return valid, problems


def _chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


_REFRAME_TYPES = ("SCQ", "MCQ", "NUMERICAL", "MATCHING_LIST", "ASSERTION_REASON")


def _apply_target_types(questions, path):
    """Turn seed questions into the type the paper asked for.

    The pipeline picks a question of another type when the pool is short of the
    wanted one (qbgPoolSelection.ts) and passes {qbg_id: target_type}. Setting
    "type" here is the whole mechanism: the prompt tags the question with it (plus
    a CONVERT note naming the original type), _filter_valid_questions enforces the
    target's shape on the reply, and the push sends it to QBG as that type.

    Returns [{qbg_id, num, from, to}] for the report; [] when there is nothing to do.
    """
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as f:
            wanted = json.load(f) or {}
    except Exception as e:
        log.warning("could not read --target-types-json %s: %s", path, e)
        return []
    done = []
    for q in questions:
        target = str(wanted.get(q.get("qbg_id") or "", "")).upper()
        if target not in _REFRAME_TYPES:
            continue
        current = q.get("type") or "SCQ"
        if target == current:
            continue
        q["source_type"] = current
        q["type"] = target
        done.append({"qbg_id": q.get("qbg_id"), "num": q.get("num"), "from": current, "to": target})
    if done:
        log.info("type conversions: %s", ", ".join("Q%s %s->%s" % (d["num"], d["from"], d["to"]) for d in done))
    return done


def _load_syllabus(path):
    """Read the syllabus scope written by qbgModification.ts, or None."""
    if not path:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("could not read --syllabus-json %s: %s", path, e)
        return None
    return data if isinstance(data, list) and data else None


def _reframe_questions(all_questions, source_name, figdir, provider, api_key, model, base_url,
                       no_images, regen, fig_urls=None, mode="full_rewrite", gen_solution_diagrams=False,
                       difficulty="auto", force_redraw=False, add_figures=False, syllabus=None,
                       no_calculator=False, conceptual=False):
    """Reframe `all_questions` (extract.py-shaped dicts) in small batches
    (REFRAME_CHUNK_SIZE) rather than one giant call, so a large paper can't
    silently truncate or come back short. Returns (merged_questions, resolved_source_name,
    warnings) — merged_questions is sorted by 'num' and always fully well-formed
    (see _filter_valid_questions), so downstream building never KeyErrors."""
    merged: list[dict] = []
    warnings: list[str] = []
    resolved_src = source_name
    chunks = list(_chunked(all_questions, REFRAME_CHUNK_SIZE))
    for ci, chunk in enumerate(chunks, 1):
        _progress.emit("reframe", "Reframing batch %d/%d…" % (ci, len(chunks)), done=ci, total=len(chunks))
        expected_nums = {q["num"] for q in chunk}
        nums_label = ",".join(str(n) for n in sorted(expected_nums))
        prompt = _extract.build_prompt(source_name, chunk, fig_urls=fig_urls, allow_diagram_changes=regen, mode=mode,
                                       gen_solution_diagrams=gen_solution_diagrams, difficulty=difficulty,
                                       force_redraw=force_redraw, add_figures=add_figures,
                                       syllabus=syllabus, no_calculator=no_calculator,
                                       conceptual=conceptual)
        images = [] if (no_images and not regen) else _llm.collect_images(chunk, figdir)
        # Scale the output budget to the chunk size — generous but capped well under
        # providers' usual ceilings. Each reframed question is a "harder than the
        # original" question with a fully re-derived, step-by-step solution (see
        # build_prompt's rules) plus JSON-escaped LaTeX, which runs noticeably longer
        # than a plain reworded question — 1400/question routinely wasn't enough headroom
        # and was a repeat cause of "AI call failed — ...truncated/invalid JSON" chunk
        # failures (2026-07-19).
        max_tokens = min(14000, max(4000, 2200 * len(chunk)))
        try:
            payload = _llm.generate(provider, api_key, model, prompt, images=images,
                                    base_url=base_url, max_tokens=max_tokens)
        except Exception as e:
            # One retry with a bigger budget before giving up on the whole chunk —
            # generate() itself already retries internally on a *detected* truncation
            # (see llm.py), but this catches everything else too (e.g. malformed JSON
            # that isn't a token-limit issue), so a single bad response doesn't
            # permanently drop every question in the chunk.
            log.warning("chunk %d/%d (Q%s): first attempt failed (%s) — retrying once with a bigger budget",
                        ci, len(chunks), nums_label, str(e)[:200])
            try:
                payload = _llm.generate(provider, api_key, model, prompt, images=images,
                                        base_url=base_url, max_tokens=min(max_tokens * 2, 20000))
            except Exception as e2:
                warnings.append(f"chunk {ci}/{len(chunks)} (Q{nums_label}): AI call failed after retry — {str(e2)[:200]}")
                continue
        if isinstance(payload, dict) and payload.get("source_name"):
            resolved_src = payload["source_name"]
        chunk_qs = payload.get("questions") if isinstance(payload, dict) else payload
        if not chunk_qs:
            warnings.append(f"chunk {ci}/{len(chunks)} (Q{nums_label}): AI returned no questions")
            continue
        orig_type_by_num = {q["num"]: q.get("type", "SCQ") for q in chunk}
        valid, problems = _filter_valid_questions(chunk_qs, expected_nums, orig_type_by_num)
        if problems:
            warnings.append(f"chunk {ci}/{len(chunks)}: " + "; ".join(problems[:10]))

        # Safety net, not just a prompt request: if the original question had a
        # figure but the model dropped it (set "fig": null) despite being told not
        # to, restore the original figure rather than silently losing the diagram.
        # (Only relevant when NOT redrawing — if regen is on and the model wants a
        # genuinely different figure, "fig" pointing elsewhere is legitimate, but
        # dropping it to null is never legitimate.) EXCEPTION: never restore for a
        # Matching_List question — its "fig" is forced null in _filter_valid_questions
        # because the original image is a stale table, not a diagram worth keeping.
        orig_fig_by_num = {q["num"]: q.get("fig_name") for q in chunk}
        restored = []
        for q in valid:
            if q.get("type") == "MATCHING_LIST":
                continue
            orig_fig = orig_fig_by_num.get(q["num"])
            if orig_fig and not q.get("fig"):
                q["fig"] = orig_fig
                q["fig_edit"] = None
                restored.append(q["num"])
        if restored:
            warnings.append(
                f"chunk {ci}/{len(chunks)}: restored the original diagram for Q{sorted(restored)} "
                f"— the AI dropped it despite the original question having a figure")

        got_nums = {q["num"] for q in valid}
        missing = expected_nums - got_nums
        if missing:
            warnings.append(
                f"chunk {ci}/{len(chunks)}: no usable reframe for original Q{sorted(missing)} "
                f"(got {len(valid)} of {len(chunk)})")
        merged.extend(valid)
    merged.sort(key=lambda q: q["num"])
    return merged, resolved_src, warnings


def _write_artifacts(out_dir: Path, src: str, html: str, figdir: str,
                     questions, data_for_original=None) -> dict:
    """Build the HTML folder + zip and the CSV exports; return their paths and the
    per-question records used for DB injection."""
    folder, zip_path = write_project(str(out_dir), src, html, figdir)

    mod_recs = modified_records(questions, figdir)
    mod_csv = build_csv(mod_recs)
    mod_csv_path = out_dir / (src + "_modified.csv")
    mod_csv_path.write_text(mod_csv, encoding="utf-8")

    report = {
        "ok": True,
        "source_name": src,
        "question_count": len(questions),
        "folder": folder,
        "zip_path": zip_path,
        "html_path": os.path.join(folder, src + ".html"),
        "modified_csv_path": str(mod_csv_path),
        "figdir": figdir,
        "questions": questions,        # structured reframed JSON (chapter/answer/…)
        "modified_records": mod_recs,   # content / options / solution → DB injection
    }
    if data_for_original is not None:
        orig_csv = build_csv(original_records(data_for_original))
        orig_csv_path = out_dir / (src + "_original.csv")
        orig_csv_path.write_text(orig_csv, encoding="utf-8")
        report["original_csv_path"] = str(orig_csv_path)
        # Per-question originals (content HTML, answer letter, solution HTML) so the
        # UI can offer a "compare with original" expander next to each reframed one.
        # Keyed by each reframed question's own "num" (not array position) — chunked
        # reframing can drop/reorder questions, so position no longer reliably lines
        # up with the original's index.
        omap = data_for_original.get("originals") or {}
        report["originals"] = [
            {"content": omap.get(q.get("num"), ("", "", ""))[0],
             "answer": omap.get(q.get("num"), ("", "", ""))[1],
             "solution": omap.get(q.get("num"), ("", "", ""))[2]}
            for q in questions
        ]
    return report


def _ai_context(args):
    """Resolve (api_key, provider_id, base_url) from env + args, or raise ValueError.
    `local`/`g4f` need no key; custom_openai/local/g4f read the endpoint from
    QBG_MOD_BASE_URL, and g4f falls back to the address `g4f api` binds to."""
    provider = args.provider
    if provider not in PROVIDERS:
        raise ValueError(f"unsupported provider: {provider} (expected one of {', '.join(PROVIDERS)})")
    base_url = os.environ.get("QBG_MOD_BASE_URL", "").strip() or None
    api_key = os.environ.get("QBG_MOD_API_KEY", "").strip()
    if not api_key and provider not in ("local", "g4f"):
        raise ValueError("missing API key (set QBG_MOD_API_KEY)")
    if provider == "g4f" and not base_url:
        base_url = _llm.G4F_DEFAULT_BASE
    if provider in ("custom_openai", "local") and not base_url:
        raise ValueError(f"{provider} needs a base URL (set QBG_MOD_BASE_URL)")
    return api_key, provider, base_url


def _qbg_creds():
    return (os.environ.get("QBG_TOKEN", "").strip(),
            os.environ.get("QBG_USER", "").strip(),
            os.environ.get("QBG_USER_ID", "").strip())


def _maybe_qbg_push(report, figdir, records, questions, src, args, out_dir):
    """If --qbg-push was passed, upload each question's diagrams to QBG's S3 and
    POST it to the external QBG API. Adds report['qbg_results'] (+ results html).
    `records` and `questions` are the same length/order (records = modified_records
    of questions); results are reported under each question's own original "num"."""
    if not getattr(args, "qbg_push", False):
        return
    token, user, user_id = _qbg_creds()
    if not (token and user and user_id):
        report["qbg_error"] = "QBG push requested but token/user/user-id are missing"
        return
    category = getattr(args, "category", "") or ""
    if not category:
        report["qbg_error"] = "QBG push requested but no --category was given"
        return
    uploader = _qbg.qbg_uploader(token, user, user_id)
    cache = {}
    results = []
    resolved = []
    total = len(records)
    for i, (rec, q) in enumerate(zip(records, questions), 1):
        num = q.get("num", i)
        _progress.emit("qbg_push", "Pushing question %d/%d to QBG…" % (i, total), done=i, total=total)
        try:
            rec2 = _qbg.resolve_images(rec, figdir, uploader, cache)
            resolved.append(rec2)
            # "type" is the ORIGINAL question's type (Ingestion sets it from the source
            # file; the reframer sets it in _filter_valid_questions from the original
            # QBG/docx question, not from anything the AI writes) — for Numerical it's
            # pushed with no options and "answer" carries the plain numeric value.
            uid, _resp = _qbg.ingest(rec2, category, token, user, user_id,
                                     qtype=q.get("type", "SCQ"), answer=q.get("answer"))
            results.append({"num": num, "unique_id": uid, "ok": bool(uid)})
        except Exception as e:
            resolved.append(rec)
            results.append({"num": num, "unique_id": None, "ok": False, "error": str(e)[:300]})
    report["qbg_results"] = results
    try:
        results_html_path = Path(out_dir) / (src + "_qbg_results.html")
        results_html_path.write_text(_qbg.results_html(src, resolved, results, figdir), encoding="utf-8")
        report["qbg_results_html_path"] = str(results_html_path)
    except Exception:
        pass


def _sol_plain(parts):
    """Plain text of a reframed question's solution parts."""
    out = []
    for p in parts or []:
        if isinstance(p, dict):
            if "t" in p:
                out.append(str(p["t"]))
            elif "m" in p:
                out.append(str(p["m"]))
    return " ".join(out)


def _repair_inconsistent_solutions(questions, originals, provider, api_key, model, base_url):
    """Rewrite any solution that is still working with the ORIGINAL question's data.

    Detection is deterministic (consistency.stale_values) so it costs nothing and
    cannot hallucinate a problem; only the questions it flags are sent back to the
    model, one extra call for the batch. Returns (questions, warnings)."""
    flagged = _consistency.check_questions(questions, originals,
                                           lambda q: _stem_plain(q.get("stem")),
                                           lambda q: _sol_plain(q.get("solution")))
    if not flagged:
        return questions, []

    type_by_num = {q.get("num"): (q.get("type") or "SCQ") for q in questions}
    _progress.emit("repair", "Rewriting %d solution(s) that used the original question's data…"
                   % len(flagged), done=0, total=len(flagged))
    warnings = []
    fixed = {}
    try:
        prompt = _consistency.build_repair_prompt(
            flagged, lambda num: type_by_num.get(num, "SCQ"))
        res = _llm.generate(provider, api_key, model, prompt,
                            system=_consistency._REPAIR_SYSTEM, base_url=base_url,
                            max_tokens=8000)
        for item in ((res or {}).get("questions") or []):
            if item.get("num") is not None and item.get("solution"):
                fixed[str(item["num"])] = item
    except Exception as e:
        warnings.append("could not rewrite the inconsistent solution(s): %s" % str(e)[:200])

    out = []
    for q in questions:
        num = q.get("num")
        hit = fixed.get(str(num))
        entry = next((f for f in flagged if f["num"] == num), None)
        if hit:
            q = dict(q)
            q["solution"] = hit["solution"]
            if hit.get("answer"):
                q["answer"] = hit["answer"]
            # Only claim it is fixed if the leftover values are actually gone.
            still = _consistency.stale_values(
                next((o.get("q_text", "") for o in (originals or []) if o.get("num") == num), ""),
                _stem_plain(q.get("stem")), _sol_plain(q.get("solution")))
            if still:
                warnings.append(
                    "Q%s: the solution still uses %s, which the reframed question does not state — "
                    "check it before use." % (num, ", ".join(still[:5])))
            else:
                log.info("Q%s: solution rewritten to match the reframed question", num)
        elif entry:
            warnings.append(
                "Q%s: the solution calculates with %s, which the reframed question does not state "
                "(left over from the original) — check it before use."
                % (num, ", ".join(entry["stale"][:5])))
        out.append(q)
    return out, warnings


def _run_qc_stage(questions, data, args, provider, api_key, base_url,
                  img_provider, img_key, warnings):
    """Audit every reframed question with a (vision-capable) model and apply its
    corrections — the last gate before the questions are pushed to QBG.

    Runs AFTER the diagram stages on purpose: the figure QC judges has to be the
    one that will ship, and a diagram QC itself asks to change is redrawn here,
    through the same editor and the same verification the ordinary redraw uses.
    """
    qc_provider = getattr(args, "qc_provider", "") or provider
    qc_model = getattr(args, "qc_model", "") or args.model
    qc_subject = getattr(args, "subject", "") or "Physics"
    qc_key = os.environ.get("QBG_MOD_QC_API_KEY", "").strip() or (
        api_key if qc_provider == provider else "")
    qc_base = base_url if qc_provider == provider else None
    if not qc_key:
        warnings.append("QC was requested but no API key was available for %s — skipped."
                        % qc_provider)
        return questions, None, None

    _progress.emit("qc", "Quality-checking %d question(s) before the push…" % len(questions),
                   done=0, total=len(questions))
    questions, qc_results = _qcfix.qc_and_fix(
        questions, data["figdir"], qc_provider, qc_key, qc_model, base_url=qc_base,
        subject=qc_subject)

    # A figure QC asked to change is redrawn now, so the push carries the fixed
    # picture rather than a note about it.
    qc_fig_results = None
    redraw = [q for q in questions if q.get("_qc_fig_edit")]
    if redraw:
        if img_provider and img_key:
            _progress.emit("qc", "Redrawing %d diagram(s) QC asked to correct…" % len(redraw))
            fig_check = None if getattr(args, "no_fig_check", False) else {
                "provider": qc_provider, "api_key": qc_key, "model": qc_model}
            fixed, qc_fig_results = _regen_figures(
                redraw, data["figdir"], img_provider, img_key,
                getattr(args, "img_model", ""), check=fig_check)
            by_num = {q.get("num"): q for q in fixed}
            questions = [by_num.get(q.get("num"), q) for q in questions]
        else:
            warnings.append("QC asked for %d diagram correction(s) but no image model was "
                            "available to redraw them." % len(redraw))

    for q in questions:
        q.pop("_qc_fig_edit", None)

    summary = _qcfix.summarize(qc_results)
    if summary["changed"]:
        warnings.append("QC corrected %d of %d question(s): %s. The report shows what changed."
                        % (summary["changed"], summary["checked"],
                           ", ".join("Q%s" % n for n in summary["changed_nums"][:12])))
    if summary["failed"]:
        warnings.append("QC could not check %d question(s) — those were left exactly as they "
                        "were." % summary["failed"])
    return questions, qc_results, qc_fig_results


def _reframe_from_data(data, provider, api_key, base_url, args, out_dir):
    """Shared tail: reframe the extracted `data` with the LLM (in small batches —
    see _reframe_questions), build artifacts, and optionally regenerate diagrams +
    push to QBG. Returns the report dict, or None on a handled failure."""
    regen = getattr(args, "regen_diagrams", False)
    gen_sol_diag = getattr(args, "gen_solution_diagrams", False)
    add_figs = getattr(args, "add_figures", False)
    # "Redraw every figure" only means anything on top of the redraw option itself — without
    # --regen-diagrams there is no "fig_edit" in the schema at all, so nothing to force.
    force_redraw = bool(getattr(args, "redraw_all_figures", False)) and regen
    mode = getattr(args, "mode", None) or "full_rewrite"
    difficulty = getattr(args, "difficulty", None) or "auto"
    syllabus = _load_syllabus(getattr(args, "syllabus_json", "") or "")
    questions, src, warnings = _reframe_questions(
        data["questions"], data["source_name"], data["figdir"], provider, api_key, args.model,
        base_url, args.no_images, regen, fig_urls=data.get("fig_urls"), mode=mode,
        gen_solution_diagrams=gen_sol_diag, difficulty=difficulty, force_redraw=force_redraw,
        add_figures=add_figs, syllabus=syllabus,
        no_calculator=bool(getattr(args, "no_calculator", False)),
        conceptual=bool(getattr(args, "conceptual", False)))
    if not questions:
        detail = " — " + "; ".join(warnings) if warnings else ""
        print("the AI response contained no usable questions" + detail, file=sys.stderr)
        return None

    # A solution that quietly kept the ORIGINAL question's numbers is a wrong
    # question, and the model writes the stem and the solution in one pass, so this
    # has to be checked after the fact rather than asked for in the prompt.
    questions, repair_warnings = _repair_inconsistent_solutions(
        questions, data["questions"], provider, api_key, args.model, base_url)
    warnings.extend(repair_warnings)

    diagram_results = None
    sol_diagram_results = None
    new_figure_results = None
    if not regen:
        # No redraw was asked for, so any question whose numbers moved now carries a
        # figure showing the OLD ones. Say so rather than shipping it silently.
        warnings.extend(_stale_figure_warnings(questions, data["questions"]))
    if regen or gen_sol_diag or add_figs:
        img_provider = IMG_PROVIDER_MAP.get(getattr(args, "img_provider", "") or "")
        img_key = os.environ.get("QBG_MOD_IMG_API_KEY", "").strip()
        img_err = None
        if not img_provider:
            img_err = "unsupported image provider"
        elif not img_key:
            img_err = "no image-model API key"
        if regen:
            if img_err:
                diagram_results = [{"num": 0, "status": "failed", "detail": img_err}]
            else:
                # The model is told to fill "fig_edit" whenever it changes a value the
                # figure shows, but it does sometimes return null — leaving a diagram
                # that contradicts its own stem. Derive the edit from the numbers that
                # actually changed before redrawing, so the picture follows the text.
                questions, synth_warnings = _fill_missing_fig_edits(questions, data["questions"])
                warnings.extend(synth_warnings)
                # The reframe model doubles as the diagram's proof-reader: it can
                # see images, it already knows the question, and reading a figure
                # back is the only way to catch an image editor that drew the
                # wrong digits (see figcheck.py).
                # The reframe model doubles as the diagram's proof-reader: it can
                # see images, it already knows the question, and reading a figure
                # back is the only way to catch an image editor that drew the
                # wrong digits (see figcheck.py). Opt-out, because it costs a
                # vision call per figure.
                fig_check = None if getattr(args, "no_fig_check", False) else {
                    "provider": provider, "api_key": api_key, "model": args.model}
                questions, diagram_results = _regen_figures(
                    questions, data["figdir"], img_provider, img_key, getattr(args, "img_model", ""),
                    check=fig_check)
        if gen_sol_diag:
            if img_err:
                sol_diagram_results = [{"num": 0, "status": "failed", "detail": img_err}]
            else:
                questions, sol_diagram_results = _gen_solution_diagrams(
                    questions, data["figdir"], img_provider, img_key, getattr(args, "img_model", ""))
        if add_figs:
            if img_err:
                new_figure_results = [{"num": 0, "status": "failed", "detail": img_err}]
            else:
                questions, new_figure_results = _gen_new_figures(
                    questions, data["figdir"], img_provider, img_key, getattr(args, "img_model", ""))

    # ---- QC + fix: the last gate before anything reaches QBG ----
    qc_results = None
    qc_fig_results = None
    if getattr(args, "qc", False):
        img_provider_qc = IMG_PROVIDER_MAP.get(getattr(args, "img_provider", "") or "")
        img_key_qc = os.environ.get("QBG_MOD_IMG_API_KEY", "").strip()
        questions, qc_results, qc_fig_results = _run_qc_stage(
            questions, data, args, provider, api_key, base_url,
            img_provider_qc, img_key_qc, warnings)

    # ---- answer-key balance: the last thing before the artifacts are built ----
    # After QC, because QC can change which option is correct — balancing first
    # would be undone by the next stage. Only the ORDER of the options changes;
    # no question, option text or answer is rewritten.
    key_report = None
    if not getattr(args, "no_key_balance", False):
        questions, key_report = _answerkey.balance_answer_key(questions)
        line = _answerkey.summarize(key_report)
        if line:
            warnings.append(line)

    html = build_html(src, questions, data["originals"], data["figdir"])
    report = _write_artifacts(out_dir, src, html, data["figdir"], questions, data_for_original=data)
    report["requested_count"] = len(data["questions"])
    if key_report is not None:
        report["key_balance"] = key_report
    if qc_results is not None:
        report["qc_results"] = qc_results
        report["qc_summary"] = _qcfix.summarize(qc_results)
    if qc_fig_results:
        report["qc_diagram_results"] = qc_fig_results
    if diagram_results is not None:
        report["diagram_results"] = diagram_results
    if sol_diagram_results is not None:
        report["solution_diagram_results"] = sol_diagram_results
    if new_figure_results is not None:
        report["new_figure_results"] = new_figure_results
    if warnings:
        # Surface partial-batch issues (dropped/failed questions) instead of the
        # user silently getting fewer questions than expected with no explanation.
        report["warnings"] = warnings
    _maybe_qbg_push(report, data["figdir"], report["modified_records"], questions, src, args, out_dir)
    return report


def cmd_reframe(args) -> int:
    try:
        api_key, provider, base_url = _ai_context(args)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 3

    docx = Path(args.docx)
    if not docx.exists():
        print(f"input not found: {docx}", file=sys.stderr)
        return 2
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="qbgmod_"))

    try:
        if args.extract == "ai":
            # Format-agnostic: pandoc pulls equations/images, the LLM structures them.
            data = _ai_extract.ai_extract(str(docx), str(work), provider, api_key, args.model, base_url=base_url)
        else:
            data = _extract.extract(str(docx), str(work))
    except ValueError as e:
        # Expected "wrong format" / empty-extraction rejection.
        print(f"extract rejected the input: {e}", file=sys.stderr)
        return 3

    report = _reframe_from_data(data, provider, api_key, base_url, args, out_dir)
    if report is None:
        return 3
    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def cmd_qbg_reframe(args) -> int:
    """Input source = QBG unique_ids (fetched from the external QBG API), then reframe."""
    try:
        api_key, provider, base_url = _ai_context(args)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 3
    token, user, user_id = _qbg_creds()
    if not (token and user and user_id):
        print("missing QBG credentials (set QBG_TOKEN / QBG_USER / QBG_USER_ID)", file=sys.stderr)
        return 3
    ids = [x.strip() for x in re.split(r"[\s,]+", args.qbg_ids or "") if x.strip()]
    if not ids:
        print("no QBG unique_ids given (--qbg-ids)", file=sys.stderr)
        return 3
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="qbgmod_"))
    try:
        data = _qbg.qbg_extract(ids, token, user, user_id, str(work))
    except Exception as e:
        print(f"QBG fetch failed: {e}", file=sys.stderr)
        return 3
    if not data.get("questions"):
        print("QBG returned no questions for those unique_ids", file=sys.stderr)
        return 3
    converted = _apply_target_types(data["questions"], getattr(args, "target_types_json", "") or "")
    report = _reframe_from_data(data, provider, api_key, base_url, args, out_dir)
    if report is None:
        return 3
    if data.get("missing_ids"):
        report["missing_ids"] = data["missing_ids"]
    if data.get("skipped_unsupported"):
        report["skipped_unsupported"] = data["skipped_unsupported"]
    if converted:
        report["type_conversions"] = converted
    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def cmd_build(args) -> int:
    payload_path = Path(args.reframed_json)
    if not payload_path.exists():
        print(f"reframed JSON not found: {payload_path}", file=sys.stderr)
        return 2
    figdir = args.figdir
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"reframed JSON is not valid JSON: {e}", file=sys.stderr)
        return 3
    questions = payload.get("questions") if isinstance(payload, dict) else payload
    if not questions:
        print("no 'questions' array in the reframed JSON", file=sys.stderr)
        return 3
    problems = _validate_questions(questions)
    if problems:
        print("reframed JSON validation problems: " + "; ".join(problems[:20]), file=sys.stderr)
        return 3
    src = args.source_name or (payload.get("source_name") if isinstance(payload, dict) else None) or "reframed"
    # No `originals` available in assisted build → empty compare panels.
    html = build_html(src, questions, {}, figdir)
    report = _write_artifacts(out_dir, src, html, figdir, questions)
    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def cmd_ingest(args) -> int:
    """QBG Ingestion: read a question .docx/.doc (optionally a separate solutions file),
    have the AI extract each question + correct answer + type + worked solution (solving /
    authoring / drawing anything missing), build the review artifacts, and optionally push
    to QBG. Unlike the reframer there is no 'original' to compare against."""
    try:
        api_key, provider, base_url = _ai_context(args)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 3

    q_docx = Path(args.question_docx)
    if not q_docx.exists():
        print(f"question file not found: {q_docx}", file=sys.stderr)
        return 2
    s_docx = None
    if args.solution_docx:
        s_docx = Path(args.solution_docx)
        if not s_docx.exists():
            print(f"solution file not found: {s_docx}", file=sys.stderr)
            return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="qbging_"))

    img_provider = getattr(args, "img_provider", "") or None
    img_key = os.environ.get("QBG_MOD_IMG_API_KEY", "").strip() or None
    gen_diagrams = bool(getattr(args, "gen_diagrams", False) and img_provider and img_key)

    try:
        data = _ingest_extract.ingest_extract(
            str(q_docx), str(s_docx) if s_docx else None, str(work),
            provider, api_key, args.model, base_url=base_url,
            img_provider=img_provider, img_key=img_key, img_model=getattr(args, "img_model", ""),
            solve_missing=not args.no_solve, author_missing=not args.no_author,
            gen_diagrams=gen_diagrams, use_patterns=not getattr(args, "no_pattern", False),
            rich_solution=bool(getattr(args, "rich_solution", False)),
            html_direct=not bool(getattr(args, "html_ai", False)))
    except (ValueError, RuntimeError) as e:
        print(f"ingestion extract failed: {e}", file=sys.stderr)
        return 3

    questions = data["questions"]
    if not questions:
        print("no questions could be extracted from the uploaded file", file=sys.stderr)
        return 3
    src = data["source_name"]
    figdir = data["figdir"]

    # No 'originals' in ingestion -> empty compare panels (build_html handles {}).
    _progress.emit("build", "Building the review pack for %d question(s)…" % len(questions))
    html = build_html(src, questions, {}, figdir)
    report = _write_artifacts(out_dir, src, html, figdir, questions)
    report["requested_count"] = len(questions)
    # Per-question provenance for the review UI: where each answer/solution came from,
    # its QBG type, and whether the diagram was AI-generated.
    report["ingestion_meta"] = [
        {"num": q.get("num"), "type": q.get("type"),
         "answer": q.get("answer"),
         "answer_source": q.get("answer_source"),
         "solution_source": q.get("solution_source"),
         "diagram_generated": q.get("diagram_generated", False)}
        for q in questions
    ]
    if data.get("warnings"):
        report["warnings"] = data["warnings"]
    # Pattern-learning outcome: which learned format was used (AI skipped), or which
    # format was newly learned from this AI run.
    report["pattern_used"] = data.get("pattern_used")
    report["pattern_learned"] = data.get("pattern_learned")
    _maybe_qbg_push(report, figdir, report["modified_records"], questions, src, args, out_dir)

    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def _records_from_csv(path):
    """Read a QBG-format CSV (csvbuild.build_csv: content / bilingual_options /
    solutions, each cell a JSON string) back into push records.

    The MODIFIED csv keeps each diagram inline as a base64 data: URL, so a push
    from it carries the pictures (resolve_inline_images uploads them). The
    ORIGINAL-questions csv is built through csvbuild._empty_imgs and has every
    src blanked — the caller counts those as blank_images and warns, rather than
    silently creating questions with missing diagrams."""
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, row in enumerate(csv.DictReader(f), 1):
            def cell(name, default):
                raw = (row.get(name) or "").strip()
                if not raw:
                    return default
                try:
                    return json.loads(raw)
                except ValueError:
                    raise ValueError("row %d: column %r is not valid JSON" % (i, name))

            content = cell("content", {}).get("english") or ""
            opts_obj = cell("bilingual_options", {}).get("english") or []
            options = [(o.get("isCorrect"), o.get("text"))
                       for o in opts_obj if isinstance(o, dict)]
            # Four all-null option slots mean "no options" (Numerical).
            if options and all(c is None and t is None for c, t in options):
                options = []
            sols = cell("solutions", [])
            solution = ""
            if isinstance(sols, list) and sols:
                solution = ((sols[0] or {}).get("english") or {}).get("text") or ""
            out.append({"content": content, "options": options, "solution": solution})
    return out


def cmd_push(args) -> int:
    """Push already-built questions to QBG — no AI, no extraction.

    Feeds the same qbg.ingest() the ingestion/reframe runs use, from either:
      * --records-json : the records a finished job produced (diagrams inlined as
        base64 data: URLs, since the job's figdir is long gone), or
      * --csv          : a QBG-format CSV that was downloaded earlier.

    Exists because 'push to QBG' used to be decidable only BEFORE a run started:
    forgetting the tick meant re-running the whole AI extraction to get the
    questions into QBG."""
    token, user, user_id = _qbg_creds()
    if not (token and user and user_id):
        print("missing QBG credentials (set QBG_TOKEN / QBG_USER / QBG_USER_ID)", file=sys.stderr)
        return 3
    if not args.category:
        print("--category is required", file=sys.stderr)
        return 2

    # questions[] carries the per-question type/answer/num; records[] the HTML.
    questions = []
    if args.records_json:
        try:
            payload = json.loads(Path(args.records_json).read_text(encoding="utf-8"))
        except Exception as e:
            print("could not read --records-json: %s" % e, file=sys.stderr)
            return 2
        questions = payload.get("questions") or []
    elif args.csv:
        try:
            recs = _records_from_csv(args.csv)
        except (OSError, ValueError) as e:
            print("could not read --csv: %s" % e, file=sys.stderr)
            return 2
        # A CSV carries no type/answer columns; every row is pushed as the type the
        # caller chose (SCQ unless --csv-type says otherwise). The correct option
        # still comes from each row's own isCorrect flags.
        questions = [{"num": i, "type": args.csv_type,
                      "content": r["content"], "options": r["options"],
                      "solution": r["solution"]}
                     for i, r in enumerate(recs, 1)]
    else:
        print("one of --records-json / --csv is required", file=sys.stderr)
        return 2

    if not questions:
        print("nothing to push — the input contained no questions", file=sys.stderr)
        return 3

    uploader_bytes = _qbg.qbg_bytes_uploader(token, user, user_id)
    cache = {}
    results = []
    resolved = []
    blank_images = 0
    total = len(questions)
    for i, q in enumerate(questions, 1):
        num = q.get("num", i)
        rec = {"content": q.get("content") or "",
               "options": [tuple(o) if isinstance(o, (list, tuple)) else o
                           for o in (q.get("options") or [])],
               "solution": q.get("solution") or ""}
        _progress.emit("qbg_push", "Pushing question %d/%d to QBG…" % (i, total),
                       done=i, total=total)
        try:
            rec2 = _qbg.resolve_inline_images(rec, uploader_bytes, cache)
            blank_images += _qbg.count_blank_images(rec2)
            resolved.append(rec2)
            uid, _resp = _qbg.ingest(rec2, args.category, token, user, user_id,
                                     qtype=q.get("type", "SCQ"), answer=q.get("answer"))
            results.append({"num": num, "unique_id": uid, "ok": bool(uid)})
        except Exception as e:
            resolved.append(rec)
            results.append({"num": num, "unique_id": None, "ok": False, "error": str(e)[:300]})

    report = {"ok": True, "qbg_results": results, "count": total,
              "pushed": sum(1 for r in results if r["ok"]),
              "blank_images": blank_images}
    if blank_images:
        report["warnings"] = [
            "%d diagram(s) were pushed with no image — the file carried an <img> "
            "placeholder with no picture data. The 'Modified CSV' keeps its diagrams "
            "inline; an 'Original CSV' has them stripped, so push from the run itself "
            "or from the modified CSV to include them." % blank_images]
    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


DEFAULT_TAG_TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "tagging_data", "qbg_tagging_table.csv")


def _read_tag_csv(path):
    """Read a user-uploaded tagging CSV (sample format) into a list of row dicts."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def cmd_tag(args) -> int:
    """QBG Tagging. Two modes:
       * AI mode (--qbg-ids): fetch each question, AI-match nearest subject/chapter/topic/
         subtopic from the tagging table + difficulty, then PUT the tags to QBG.
       * CSV mode (--tag-csv): a ready tagging CSV (ids + difficulty already) -> PUT directly,
         no AI."""
    token, user, user_id = _qbg_creds()
    if not (token and user and user_id):
        print("missing QBG credentials (set QBG_TOKEN / QBG_USER / QBG_USER_ID)", file=sys.stderr)
        return 3

    results = []
    if args.tag_csv:
        # ---- CSV mode: direct PUT, no AI ----
        try:
            rows = _read_tag_csv(args.tag_csv)
        except Exception as e:
            print(f"could not read tag CSV: {e}", file=sys.stderr)
            return 3
        if not rows:
            print("tag CSV has no rows", file=sys.stderr)
            return 3
        for i, row in enumerate(rows, 1):
            _progress.emit("tag", "Writing tags %d/%d to QBG…" % (i, len(rows)), done=i, total=len(rows))
            qbg_id = (row.get("qbg_id") or "").strip()
            if not qbg_id:
                results.append({"qbg_id": None, "ok": False, "error": "row %d missing qbg_id" % i})
                continue
            tags = {
                "class_id": (row.get("class_id") or "").strip(),
                "subject_id": (row.get("subject_id") or "").strip(),
                "chapter_id": (row.get("chapter_id") or "").strip(),
                "topic_id": (row.get("topic_id") or "").strip(),
                "subtopic_id": (row.get("sub_topic_id") or "").strip(),
                "difficulty": (row.get("difficulty_level") or "2").strip() or "2",
            }
            missing = [k for k in ("class_id", "subject_id", "chapter_id") if not tags[k]]
            if missing:
                results.append({"qbg_id": qbg_id, "ok": False,
                                "error": "missing " + ", ".join(missing)})
                continue
            ok, detail = _qbg.tag_question(qbg_id, tags, token, user, user_id)
            results.append({"qbg_id": qbg_id, "ok": ok, "detail": detail, "tags": tags,
                            "meta": {"subject_name": row.get("subject_name", ""),
                                     "chapter_name": row.get("chapter_name", ""),
                                     "topic_name": row.get("topic_name", ""),
                                     "subtopic_name": row.get("sub_topic_name", ""),
                                     "class_name": row.get("class_name", ""),
                                     "difficulty_name": row.get("difficulty_name", "")}})
        mode = "csv"
    else:
        # ---- AI mode: match then PUT ----
        try:
            api_key, provider, base_url = _ai_context(args)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 3
        ids = [x.strip() for x in re.split(r"[\s,]+", args.qbg_ids or "") if x.strip()]
        if not ids:
            print("no QBG unique_ids given (--qbg-ids)", file=sys.stderr)
            return 3
        table_path = args.table or DEFAULT_TAG_TABLE
        if not os.path.exists(table_path):
            print(f"tagging table not found: {table_path}", file=sys.stderr)
            return 3
        try:
            table = _tagmatch.load_table(table_path)
        except Exception as e:
            print(f"could not load tagging table: {e}", file=sys.stderr)
            return 3
        # Empty = every subject (the default). Named subjects stop a question from
        # being filed under a subject that merely shares the chapter name.
        subject_filter = [x.strip() for x in (getattr(args, "subjects", "") or "").split(",")
                          if x.strip()]
        total = len(ids)
        for i, qbg_id in enumerate(ids, 1):
            _progress.emit("tag", "Tagging question %d/%d (%s)…" % (i, total, qbg_id), done=i, total=total)
            try:
                q = _qbg.get_question(qbg_id, token, user, user_id)
                tags, meta = _tagmatch.match_question(
                    q, table, provider, api_key, args.model, base_url,
                    taxonomy_category=getattr(args, "taxonomy_category", "") or None,
                    allowed_subjects=subject_filter)
                ok, detail = _qbg.tag_question(qbg_id, tags, token, user, user_id, question=q)
                results.append({"qbg_id": qbg_id, "ok": ok, "detail": detail,
                                "tags": tags, "meta": meta})
            except Exception as e:
                results.append({"qbg_id": qbg_id, "ok": False, "error": str(e)[:400]})
        mode = "ai"

    report = {"ok": True, "mode": mode, "count": len(results),
              "tagged": sum(1 for r in results if r.get("ok")), "results": results}
    json.dump(report, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="QBG modification (MCQ reframer) pipeline.")
    sub = ap.add_subparsers(dest="command", required=True)

    r = sub.add_parser("reframe", help="Extract a .docx, reframe with AI, build artifacts.")
    r.add_argument("docx", help="Source .docx test path")
    r.add_argument("out_dir", help="Directory for the HTML folder / zip / CSVs")
    r.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    r.add_argument("--model", required=True, help="Model id for the provider")
    r.add_argument("--no-images", action="store_true",
                   help="Do not send diagram images to the model (text-only prompt)")
    r.add_argument("--extract", choices=["ai", "regex"], default="ai",
                   help="How to read the .docx: 'ai' (LLM, layout-agnostic; default) "
                        "or 'regex' (legacy fixed-format parser)")
    r.add_argument("--qbg-push", action="store_true",
                   help="After building, POST each reframed question to the external QBG API "
                        "(needs QBG_TOKEN/QBG_USER/QBG_USER_ID env + --category)")
    r.add_argument("--category", default="", help="QBG category_configuration_id (with --qbg-push)")
    r.add_argument("--syllabus-json", default="",
                   help="JSON file: [{subject, chapters, permitted}] — keep every reframed question "
                        "inside this test's syllabus (chapters = what it must be about; permitted = "
                        "those plus earlier chapters it may lean on).")
    r.add_argument("--no-calculator", action="store_true",
                   help="Write every question so it can be solved by hand: clean numbers that "
                        "cancel, no calculator-grade arithmetic.")
    r.add_argument("--conceptual", action="store_true",
                   help="Make most questions conceptual: theory, or light arithmetic where the "
                        "hard part is recognising which concept applies.")
    r.add_argument("--regen-diagrams", action="store_true",
                   help="Let an image model redraw figures whose data the reframe changed")
    r.add_argument("--redraw-all-figures", action="store_true",
                   help="With --regen-diagrams: redraw EVERY figure so it matches the reframed "
                        "numbers, instead of only the ones the AI flagged as changed")
    r.add_argument("--no-key-balance", action="store_true",
                   help="Do NOT reorder options to spread the answer key. By default the "
                        "options of each question are permuted so one letter is not correct "
                        "far more often than the others, and never for two questions in a "
                        "row; option sets whose order carries meaning are left alone.")
    r.add_argument("--qc", action="store_true",
                   help="Quality-check every reframed question with an AI model "
                        "before pushing, and apply its corrections. Use a model that "
                        "can READ IMAGES — the figure is sent with the question, and "
                        "diagram-vs-text mismatches are the commonest defect.")
    r.add_argument("--qc-provider", default="",
                   help="Provider for the QC model (default: the reframe provider). "
                        "Its key comes from QBG_MOD_QC_API_KEY when it differs.")
    r.add_argument("--qc-model", default="",
                   help="Model id for the QC pass (default: the reframe model)")
    r.add_argument("--subject", default="",
                   help="Paper-level subject for --qc's persona/trap-sweep: 'Physics' "
                        "(default) or 'Chemistry'. A question dict carrying its own "
                        "'subject' field (from AI tagging) overrides this per question, "
                        "so a combined PCM paper is still audited correctly question by "
                        "question — set this as the paper's best single-value default.")
    r.add_argument("--no-fig-check", action="store_true",
                   help="With --regen-diagrams: do NOT read each redrawn figure back to check it "
                        "against the question. The check costs one vision call per redrawn figure "
                        "(plus a retry when it disagrees) and is what catches an image model that "
                        "drew the wrong digits — turn it off only to save tokens.")
    r.add_argument("--add-figures", action="store_true",
                   help="Let an image model draw a NEW diagram for a question that has none but "
                        "would be clearer with one (the AI decides per-question, see extract.py)")
    r.add_argument("--gen-solution-diagrams", action="store_true",
                   help="Let an image model draw a NEW diagram for a solution that genuinely needs "
                        "one (rare — the AI decides per-question, see extract.py)")
    r.add_argument("--img-provider", choices=sorted(IMG_PROVIDER_MAP), default="gemini",
                   help="Image model provider for diagram redraw (key from QBG_MOD_IMG_API_KEY)")
    r.add_argument("--img-model", default="", help="Image model id (blank = provider default)")
    r.add_argument("--mode", choices=list(_extract.MODES), default="full_rewrite",
                   help="How aggressively to rewrite: paraphrase (same numbers), vary_numbers "
                        "(new numbers, same physical quantity, same difficulty), or full_rewrite "
                        "(default — full freedom, slightly harder)")
    r.add_argument("--difficulty", choices=list(_extract.DIFFICULTY_LEVELS), default="auto",
                   help="Difficulty of the reframed questions, independent of --mode: auto (the "
                        "mode's own difficulty), harder, or much_harder (JEE-Advanced level)")
    r.set_defaults(func=cmd_reframe)

    q = sub.add_parser("qbg-reframe",
                       help="Fetch questions from the external QBG API by unique_id, reframe, build.")
    q.add_argument("out_dir", help="Directory for the HTML folder / zip / CSVs")
    q.add_argument("--qbg-ids", required=True, help="QBG unique_ids (comma/space/newline separated)")
    q.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    q.add_argument("--model", required=True, help="Model id for the provider")
    q.add_argument("--no-images", action="store_true",
                   help="Do not send diagram images to the model (text-only prompt)")
    q.add_argument("--qbg-push", action="store_true",
                   help="After building, POST each reframed question back to the external QBG API")
    q.add_argument("--category", default="", help="QBG category_configuration_id (with --qbg-push)")
    q.add_argument("--syllabus-json", default="",
                   help="JSON file: [{subject, chapters, permitted}] — keep every reframed question "
                        "inside this test's syllabus (chapters = what it must be about; permitted = "
                        "those plus earlier chapters it may lean on).")
    q.add_argument("--no-calculator", action="store_true",
                   help="Write every question so it can be solved by hand: clean numbers that "
                        "cancel, no calculator-grade arithmetic.")
    q.add_argument("--conceptual", action="store_true",
                   help="Make most questions conceptual: theory, or light arithmetic where the "
                        "hard part is recognising which concept applies.")
    q.add_argument("--target-types-json", default="",
                   help="JSON file {qbg_id: SCQ|MCQ|NUMERICAL|MATCHING_LIST|ASSERTION_REASON} — "
                        "rewrite those questions as that type (seeds picked to fill a type shortfall).")
    q.add_argument("--regen-diagrams", action="store_true",
                   help="Let an image model redraw figures whose data the reframe changed")
    q.add_argument("--redraw-all-figures", action="store_true",
                   help="With --regen-diagrams: redraw EVERY figure so it matches the reframed "
                        "numbers, instead of only the ones the AI flagged as changed")
    q.add_argument("--no-key-balance", action="store_true",
                   help="Do NOT reorder options to spread the answer key. By default the "
                        "options of each question are permuted so one letter is not correct "
                        "far more often than the others, and never for two questions in a "
                        "row; option sets whose order carries meaning are left alone.")
    q.add_argument("--qc", action="store_true",
                   help="Quality-check every reframed question with an AI model "
                        "before pushing, and apply its corrections. Use a model that "
                        "can READ IMAGES — the figure is sent with the question, and "
                        "diagram-vs-text mismatches are the commonest defect.")
    q.add_argument("--qc-provider", default="",
                   help="Provider for the QC model (default: the reframe provider). "
                        "Its key comes from QBG_MOD_QC_API_KEY when it differs.")
    q.add_argument("--qc-model", default="",
                   help="Model id for the QC pass (default: the reframe model)")
    q.add_argument("--subject", default="",
                   help="Paper-level subject for --qc's persona/trap-sweep: 'Physics' "
                        "(default) or 'Chemistry'. A question dict carrying its own "
                        "'subject' field (from AI tagging) overrides this per question.")
    q.add_argument("--no-fig-check", action="store_true",
                   help="With --regen-diagrams: do NOT read each redrawn figure back to check it "
                        "against the question. The check costs one vision call per redrawn figure "
                        "(plus a retry when it disagrees) and is what catches an image model that "
                        "drew the wrong digits — turn it off only to save tokens.")
    q.add_argument("--add-figures", action="store_true",
                   help="Let an image model draw a NEW diagram for a question that has none but "
                        "would be clearer with one (the AI decides per-question, see extract.py)")
    q.add_argument("--gen-solution-diagrams", action="store_true",
                   help="Let an image model draw a NEW diagram for a solution that genuinely needs "
                        "one (rare — the AI decides per-question, see extract.py)")
    q.add_argument("--img-provider", choices=sorted(IMG_PROVIDER_MAP), default="gemini",
                   help="Image model provider for diagram redraw (key from QBG_MOD_IMG_API_KEY)")
    q.add_argument("--img-model", default="", help="Image model id (blank = provider default)")
    q.add_argument("--mode", choices=list(_extract.MODES), default="full_rewrite",
                   help="How aggressively to rewrite: paraphrase (same numbers), vary_numbers "
                        "(new numbers, same physical quantity, same difficulty), or full_rewrite "
                        "(default — full freedom, slightly harder)")
    q.add_argument("--difficulty", choices=list(_extract.DIFFICULTY_LEVELS), default="auto",
                   help="Difficulty of the reframed questions, independent of --mode: auto (the "
                        "mode's own difficulty), harder, or much_harder (JEE-Advanced level)")
    q.set_defaults(func=cmd_qbg_reframe)

    ig = sub.add_parser("ingest",
                        help="Extract questions+answers+solutions from a Word file (AI), build, "
                             "optionally push to QBG.")
    ig.add_argument("question_docx",
                    help="Question .docx/.doc (may also contain the answer key + solutions), or a "
                         "structured .html paper, which is parsed directly with no AI model")
    ig.add_argument("out_dir", help="Directory for the HTML folder / zip / CSVs")
    ig.add_argument("--solution-docx", default=None,
                    help="Separate solutions .docx/.doc (omit if solutions are in the question file)")
    ig.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    ig.add_argument("--model", required=True, help="Model id for the provider")
    ig.add_argument("--no-pattern", action="store_true",
                    help="Do NOT use/learn deterministic format patterns (always use the AI)")
    ig.add_argument("--no-solve", action="store_true",
                    help="Do NOT let the AI solve questions whose answer is absent (leave blank)")
    ig.add_argument("--no-author", action="store_true",
                    help="Do NOT let the AI author a solution when none is present (leave blank)")
    ig.add_argument("--html-ai", action="store_true",
                    help="For an .html paper: go straight to the AI extractor. By default an HTML "
                         "paper is read structurally first — that path copies the document rather "
                         "than re-writing it — and falls back to the AI on its own when the "
                         "layout does not match.")
    ig.add_argument("--rich-solution", action="store_true",
                    help="TEMPORARY (RankUp Test Series): keep Effective Approach, Physical and "
                         "Consistency Checks and Wrong Answer Analysis in the solution alongside "
                         "the Detailed Solution, instead of the worked solution alone")
    ig.add_argument("--gen-diagrams", action="store_true",
                    help="Draw a figure with an image model when a question describes one but the "
                         "Word file has no image (key from QBG_MOD_IMG_API_KEY)")
    ig.add_argument("--img-provider", choices=sorted(IMG_PROVIDER_MAP), default="gemini",
                    help="Image model provider for diagram generation")
    ig.add_argument("--img-model", default="", help="Image model id (blank = provider default)")
    ig.add_argument("--qbg-push", action="store_true",
                    help="After building, POST each question to the external QBG API "
                         "(needs QBG_TOKEN/QBG_USER/QBG_USER_ID env + --category)")
    ig.add_argument("--category", default="", help="QBG category_configuration_id (with --qbg-push)")
    ig.set_defaults(func=cmd_ingest)

    ps = sub.add_parser("push",
                        help="Push already-built questions to QBG (no AI): from a finished "
                             "job's records JSON, or from a QBG-format CSV.")
    ps.add_argument("--records-json", default="",
                    help='JSON file: {"questions":[{num,type,answer,content,options,solution}]}')
    ps.add_argument("--csv", default="", help="A QBG-format CSV (content/bilingual_options/solutions)")
    ps.add_argument("--csv-type", default="SCQ", choices=["SCQ", "MCQ", "Numerical"],
                    help="Question type for every row of --csv (the CSV carries no type column)")
    ps.add_argument("--category", default="", required=True,
                    help="QBG category_configuration_id to push into")
    ps.set_defaults(func=cmd_push)

    tg = sub.add_parser("tag",
                        help="Tag QBG questions: AI-match nearest subject/chapter/topic/subtopic "
                             "+ difficulty (--qbg-ids), or PUT a ready tagging CSV (--tag-csv).")
    tg.add_argument("--qbg-ids", default="", help="QBG unique_ids to AI-tag (comma/space/newline separated)")
    tg.add_argument("--tag-csv", default="", help="A ready tagging CSV (sample format) to PUT directly, no AI")
    tg.add_argument("--provider", choices=sorted(PROVIDERS), help="AI provider (AI mode)")
    tg.add_argument("--model", default="", help="Model id (AI mode)")
    tg.add_argument("--table", default="", help="Tagging-table CSV path (AI mode; blank = bundled default)")
    tg.add_argument("--subjects", default="",
                    help="Comma-separated subject names the tagger may choose from (blank = all). "
                         "Stops e.g. a Physics vectors question being filed under Maths.")
    tg.add_argument("--taxonomy-category", default="",
                    help="Match against THIS category's slice of the tagging table instead of the "
                         "question's own category. For a QBG category the bundled table doesn't "
                         "cover yet (e.g. RankUp Test Series); subject/chapter/topic ids are "
                         "global, so the resulting tags are still valid.")
    tg.set_defaults(func=cmd_tag)

    b = sub.add_parser("build", help="Build artifacts from a pre-made reframed JSON (assisted).")
    b.add_argument("reframed_json", help="Path to reframed-questions JSON")
    b.add_argument("figdir", help="Directory holding the diagram PNGs")
    b.add_argument("out_dir", help="Directory for the HTML folder / zip / CSV")
    b.add_argument("--source-name", default=None)
    b.set_defaults(func=cmd_build)

    args = ap.parse_args()
    try:
        return args.func(args)
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
