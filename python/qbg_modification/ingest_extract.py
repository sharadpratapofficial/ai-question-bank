# -*- coding: utf-8 -*-
"""AI-based extraction for QBG Ingestion.

Unlike ai_extract.py (which feeds the *reframer* and only needs the question +
its figure), ingestion must produce a complete, push-ready question: correct
answer, question TYPE (SCQ / MCQ / Numerical), and a worked solution — reading
them out of the Word file(s) faithfully, and having the AI fill any gap:

  * answer not stated anywhere        -> AI solves the question
  * no worked solution present        -> AI authors a fresh step solution
  * a diagram is described but missing -> AI generates the figure (imagegen)

Input can be ONE file (questions + answer key + solutions together, in any
order — e.g. all questions then all solutions at the end) or TWO files (one of
questions, one of solutions). Solutions are matched to questions by number as a
hint, but the AI reconciles by content so a mismatched/renumbered solution still
lands on the right question.

Output shape is the same reframed-JSON list csvbuild.modified_records /
htmlbuild.build_html already consume — plus per-question `type` and provenance
flags (answer_source / solution_source / diagram_generated) for the review UI.
"""
import os
import re
import json
import shutil
import subprocess

import pypandoc

import llm as _llm
import imagegen as _imagegen
import progress as _progress
import mtef as _mtef
import patterns as _patterns
from ai_extract import _media_path, _save_png
import html_ingest as _html_ingest
from logsetup import get_logger

log = get_logger("ingest_extract")

# A paper may offer five options (QBG accepts them; see csvbuild.MAX_OPTIONS).
_LET = "ABCDEF"
INGEST_CHUNK_SIZE = 6

IMG_PROVIDER_MAP = {
    "gemini": "Google Gemini (nano banana)",
    "openai": "OpenAI (gpt-image-1)",
}


# --------------------------------------------------------------------------- #
#  small helpers
# --------------------------------------------------------------------------- #
def _chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _gen_retry(provider, api_key, model, prompt, base_url, max_tokens, system, what, attempts=3):
    """LLM call with retries. Large structured extractions occasionally come back as
    invalid JSON (an unescaped quote/backslash in a big LaTeX blob); a fresh attempt
    almost always parses. Raises the last error if every attempt fails."""
    last = None
    for a in range(attempts):
        try:
            return _llm.generate(provider, api_key, model, prompt, system=system,
                                 base_url=base_url, max_tokens=max_tokens)
        except Exception as e:
            last = e
            log.warning("%s attempt %d/%d failed: %s", what, a + 1, attempts, str(e)[:200])
            if a + 1 < attempts:
                _progress.emit("retry", "%s came back malformed — retrying (%d/%d)…"
                               % (what, a + 2, attempts))
    raise last


def _norm_type(t):
    s = (t or "").strip().upper().replace(" ", "").replace("_", "")
    if "MCQ" in s or "MULTI" in s:
        return "MCQ"
    if "NUM" in s or "INT" in s:
        return "Numerical"
    return "SCQ"


def _norm_answer(ans, qtype):
    """SCQ -> single letter 'A'..'D'; MCQ -> sorted list of letters; Numerical ->
    the numeric string as given. Accepts letters or 1..4 option numbers."""
    def to_letter(x):
        s = str(x).strip().strip("()").strip().upper()
        if not s:
            return ""
        if s[0] in _LET:
            return s[0]
        if s[0].isdigit():
            n = int(re.match(r"\d+", s).group())
            return _LET[n - 1] if 1 <= n <= len(_LET) else ""
        return ""

    if qtype == "Numerical":
        if ans is None:
            return ""
        return str(ans).strip().strip("()").strip()
    if isinstance(ans, (list, tuple, set)):
        letters = sorted({to_letter(a) for a in ans if to_letter(a)})
        return letters
    # A multi-correct key is often written as one string — "(A), (B) and (C)",
    # "A, C", "ACD". Reading only the first character turned every one of those
    # into a single-correct question (2026-09-08 report), so pull out every
    # letter and hand back a list when there is more than one.
    text = str(ans or "")
    many = re.findall(r"\(?\s*([A-Fa-f])\s*\)?(?=\s*(?:[,;/&]|and\b|\)|$))", text)
    distinct = sorted({m.upper() for m in many})
    if len(distinct) > 1:
        return distinct
    # A bare run of option letters, as answer keys are often printed: "ACD".
    bare = text.strip().upper()
    if re.fullmatch(r"[A-F]{2,5}", bare) and len(set(bare)) == len(bare):
        return sorted(set(bare))
    letter = to_letter(ans)
    return letter  # SCQ (or MCQ that came back as one letter)


def _has_answer(ans):
    return bool(ans) if not isinstance(ans, list) else len(ans) > 0


def _soffice():
    """Locate the LibreOffice CLI (used to convert legacy .doc -> .docx, which pandoc
    can't read). Honours QBG_SOFFICE, else the standard Windows install path, else PATH."""
    cand = os.environ.get("QBG_SOFFICE", "").strip()
    if cand and os.path.exists(cand):
        return cand
    win = r"C:\Program Files\LibreOffice\program\soffice.exe"
    if os.path.exists(win):
        return win
    return shutil.which("soffice") or shutil.which("soffice.exe")


def _ensure_docx(path, workdir, tag):
    """pandoc can read .docx but not legacy binary .doc. If given a .doc, convert it to
    .docx with LibreOffice headless first. Returns a path pandoc can read."""
    if not path.lower().endswith(".doc"):
        return path
    soffice = _soffice()
    if not soffice:
        raise RuntimeError("this is a legacy .doc file and LibreOffice (soffice) was not found "
                           "to convert it — install LibreOffice or upload a .docx")
    outdir = os.path.join(workdir, "conv_" + tag)
    os.makedirs(outdir, exist_ok=True)
    # The explicit export-filter name is required — a bare "--convert-to docx" fails with
    # "no export filter" on some LibreOffice builds.
    subprocess.run([soffice, "--headless", "--convert-to", "docx:MS Word 2007 XML",
                    "--outdir", outdir, path],
                   check=True, capture_output=True, timeout=180)
    conv = os.path.join(outdir, os.path.splitext(os.path.basename(path))[0] + ".docx")
    if not os.path.exists(conv):
        raise RuntimeError("LibreOffice did not produce a .docx for " + os.path.basename(path))
    return conv


def _docx_to_markdown(path, workdir, tag):
    """pandoc -> markdown (LaTeX math) + extracted images into workdir/media_<tag>.
    Returns (markdown, media_dir). Legacy .doc is converted to .docx first.

    Also reads HTML, which pandoc handles natively (MathML becomes LaTeX, and
    data: URI images are extracted like any other media). That is what lets an
    HTML paper of ANY layout go through the same AI extractor as a Word file —
    see the html_direct note in ingest_extract().

    MathType equations (OLE objects — pandoc only sees their WMF preview image) are
    converted DETERMINISTICALLY to LaTeX via the MathType SDK when MathType is
    installed, and the corresponding image references are replaced with $math$."""
    is_html = _html_ingest.looks_like_html(path)
    if not is_html:
        path = _ensure_docx(path, workdir, tag)
    media = os.path.join(workdir, "media_" + tag)
    os.makedirs(media, exist_ok=True)
    md = pypandoc.convert_file(path, "markdown", format="html" if is_html else "docx",
                               extra_args=["--extract-media=" + media, "--wrap=none"])
    if is_html:
        return md, media
    try:
        math_map, n_failed = _mtef.docx_math_map(path)
        if math_map:
            md, n_swapped = _mtef.replace_wmf_math(md, math_map)
            _progress.emit("convert", "Converted %d MathType equation(s) to real math%s"
                           % (n_swapped, (" (%d failed)" % n_failed) if n_failed else ""))
            log.info("mathtype: %d equations swapped into markdown (%s)", n_swapped, tag)
    except Exception:
        log.exception("mathtype conversion failed — proceeding with images")
    return md, media


# --------------------------------------------------------------------------- #
#  prompts
# --------------------------------------------------------------------------- #
_SYS_EXTRACT = ("You are a meticulous exam-paper TRANSCRIBER. Your job is to copy what the "
                "document says into JSON — never to improve, complete, summarise or add to it. "
                "If the document does not say something, it does not appear in your output. "
                "You output ONLY a single valid JSON "
                "object matching the schema in the user's message — no markdown, no commentary. "
                "The JSON MUST be strictly valid: escape every backslash as \\\\ (so LaTeX like "
                "\\\\frac, \\\\sqrt, \\\\sin is written with a doubled backslash), escape every "
                "double-quote inside a string as \\\", and never put a raw newline inside a string "
                "value. Double-check the JSON parses before returning it.")
_SYS_SOLVE = ("You are an expert JEE/NEET problem solver and author. You output ONLY a single "
              "valid JSON object matching the schema — no markdown, no commentary.")

_Q_SCHEMA = '''{
  "questions": [
    {
      "num": 51,
      "type": "SCQ | MCQ | Numerical",
      "chapter": "short chapter name (best guess)",
      "stem": [ {"t":"plain prose"}, {"m":"latex"}, {"t":"more prose"} ],
      "fig": "image3.png OR null",
      "diagram_desc": "null, OR a description if the paper mentions/needs a diagram that is NOT present as an image file",
      "options": [ [ {"t":".."} ], [ {"m":".."} ], [ {"t":".."} ], [ {"t":".."} ] ],
      "answer": "A | [\\"A\\",\\"C\\"] | 18 | null  (ONLY if the answer is explicitly stated in THIS document)",
      "solution": [ {"t":".."}, {"m":".."} ]  // ONLY if a worked solution is present in THIS document, else null
    }
  ]
}'''


# Ingestion is a TRANSCRIPTION job, and a model asked to "extract a solution"
# will otherwise tidy it: it completes patterns (adding "(A): Verified correct."
# to a Wrong Answer Analysis that only discussed the wrong options), rewrites a
# line more clearly, or merges two into one. Every one of those is a change to a
# question a teacher already approved (2026-09-08 report), so the prohibition is
# stated as its own block rather than left implicit.
_VERBATIM_RULES = [
    "",
    "TRANSCRIBE, DO NOT AUTHOR — this is the most important rule here:",
    "- Copy the document's wording EXACTLY. Same sentences, same order, same numbers, "
    "same labels. Do not reword, tighten, expand, translate or 'improve' anything.",
    "- NEVER add a line, bullet, section or entry that is not in the document. If a "
    "Wrong Answer Analysis discusses only options (B) and (D), output only (B) and (D) "
    "— do NOT complete the set with entries for (A) and (C).",
    "- Never merge two lines into one, split one into two, or reorder them.",
    "- Never summarise. A long solution is transcribed in full, however long it is.",
    "- Do not add a heading, label or piece of commentary the document does not have.",
    "- The ONLY thing you may change is form: an equation moves into an {\"m\"} part and "
    "loses its $ delimiters; the words themselves stay as they were.",
    "- If part of the document is unreadable, leave that part out rather than guessing "
    "what it said.",
]


def _build_question_prompt(markdown, image_names, expected_hint=None):
    L = []
    L.append("Below is an exam paper (or the question part of one) converted to Markdown. "
             "Equations are LaTeX between $...$; diagrams appear as image references like "
             "![](media/image3.png). Extract EVERY question EXACTLY as written — transcribe "
             "faithfully, do NOT reword or rephrase the question itself.")
    L.append("")
    L.append("Return ONLY valid JSON (no markdown fences) shaped exactly like this:")
    L.append(_Q_SCHEMA)
    L.append("")
    L.append("RULES:")
    L.append("- Keep the ORIGINAL question number in \"num\".")
    L.append("- Classify \"type\": SCQ = 4 options, exactly one correct. MCQ = the wording asks "
             "for one-or-more / 'select all that apply' / 'which of the following are correct'. "
             "Numerical = no options and the answer is a number (integer/decimal), or the paper "
             "labels it Integer/Numerical. If it has 4 options and intent is unclear, use SCQ.")
    L.append("- 'stem'/each option/'solution' is a LIST of parts; each part is {\"t\":prose} OR {\"m\":latex}. "
             "Put ONLY real equations in {\"m\":...} as plain LaTeX (no $ delimiters). Keep needed spaces inside the {\"t\":...} parts.")
    L.append("- The document you are reading is MARKDOWN, so it uses $…$ for equations and **…** for bold. "
             "Move every equation into its own {\"m\":...} part WITHOUT the $ signs. KEEP the **…** around a "
             "label such as **Recognition Cue:** or **Option (B):** exactly as written — those bold markers are "
             "rendered, and they are what puts each labelled line on a line of its own.")
    L.append("- For SCQ/MCQ give the options the question ACTUALLY has, in order — usually 4, but "
             "keep all 5 when the paper prints 5 (do not drop one to make it fit, and do not "
             "invent a fifth). For Numerical give an empty options list [].")
    L.append("- \"fig\": the EXACT image filename (basename, e.g. \"image3.png\") if the question has a real diagram image; otherwise null.")
    L.extend(_VERBATIM_RULES)
    L.append("- \"diagram_desc\": if the paper DESCRIBES or asks to create a diagram but no image file is present "
             "(e.g. a line like 'Note to create diagram: ...'), put that full description here and set \"fig\": null. Otherwise null.")
    L.append("- \"answer\": ONLY if an answer key gives it right next to the question. SCQ -> a single letter "
             "\"A\"-\"D\". MCQ -> a list like [\"A\",\"C\"]. Numerical -> the number. If not obviously stated here, set "
             "null — do NOT guess, and do NOT hunt through solutions in this step.")
    L.append("- \"solution\": ALWAYS set null in this step. Worked solutions are extracted separately — do not "
             "transcribe or author them here (this keeps your output small so no question is lost).")
    if expected_hint:
        L.append("- This document appears to contain questions numbered %s. Return one object per question you find." % expected_hint)
    if image_names:
        L.append("")
        L.append("Image files present in this document: " + ", ".join(sorted(image_names)))
    L.append("")
    L.append("=== DOCUMENT (Markdown) ===")
    L.append(markdown)
    return "\n".join(L)


_S_SCHEMA = '''{
  "solutions": [
    { "num": 51, "answer": "A | [\\"A\\",\\"C\\"] | 18 | null", "solution": [ {"t":".."}, {"m":".."} ] , "fig": "imageX.png OR null" }
  ]
}'''


# --- RankUp rich solutions (TEMPORARY, 2026-09-05) -------------------------
# The RankUp Test Series solution documents carry more than the worked solution:
# an "Effective Approach" preamble, then "Detailed Solution", then "Physical and
# Consistency Checks" and "Wrong Answer Analysis". Ordinary ingestion keeps only
# the worked solution, which is the right default for every other paper — so
# this is a flag, not a behaviour change, and the whole block can be deleted
# when that series is done.
_RICH_SECTIONS = [
    ("Effective Approach",
     "its Recognition Cue / Micro Concept / Macro Linkage / Fast Route lines, each kept as its own labelled line"),
    ("Detailed Solution", "the full worked derivation"),
    ("Physical and Consistency Checks", "every check listed, one per line"),
    ("Wrong Answer Analysis",
     "every option discussed, with its Mistake Tag, exactly as written"),
]


def _rich_rules(verb):
    """Prompt rules for the rich-solution sections. `verb` is 'Keep' (extraction)
    or 'Write' (AI authoring)."""
    L = []
    L.append("")
    L.append("SOLUTION SECTIONS (IMPORTANT — this document uses the RankUp format):")
    L.append("- The solution is NOT only the worked derivation. %s ALL of these sections, "
             "in this order, as ONE \"solution\" list:" % verb)
    for name, detail in _RICH_SECTIONS:
        L.append("    * \"%s\" — %s" % (name, detail))
    L.append("- Start each section with its heading as its own prose part, e.g. "
             "{\"t\":\"Effective Approach\"}, then the section's content as further parts.")
    L.append("- Keep sub-labels (\"Recognition Cue:\", \"Micro Concept:\", \"Mistake Tag:\", "
             "option letters like \"(A):\") verbatim at the start of their line.")
    L.append("- Do NOT summarise, shorten, merge or reorder these sections, and do not drop one "
             "because it looks like commentary rather than working.")
    L.append("- A section that is genuinely absent from the source is simply omitted — never invented.")
    L.append("- Inside a section, transcribe only the lines that are there. A Wrong Answer Analysis "
             "that covers three options has three entries in your output, not four — do NOT add "
             "\"(A): Verified correct.\" or any other line the document does not contain.")
    return L


def _build_solution_prompt(markdown, image_names, rich=False):
    L = []
    L.append("Below is a solutions document (may start with an ANSWER KEY, then worked "
             "solutions) converted to Markdown. Extract the ANSWER and the worked SOLUTION for "
             "each question number. Combine the answer key and the per-question hints/solutions.")
    L.append("")
    L.append("Return ONLY valid JSON (no markdown fences) shaped exactly like this:")
    L.append(_S_SCHEMA)
    L.append("")
    L.append("RULES:")
    L.append("- \"num\" = the question number this answer/solution belongs to.")
    L.append("- \"answer\": a single letter \"A\"-\"D\" for single-correct; a list like [\"A\",\"C\"] for multi-correct; "
             "the number for numerical/integer answers. Use the answer key if present. null only if truly absent.")
    L.append("- A key that names SEVERAL options — \"(A), (B) and (C)\", \"A, C\", \"ACD\" — is a MULTI-CORRECT "
             "question: return EVERY letter as a list ([\"A\",\"B\",\"C\"]), never just the first one. Getting this "
             "wrong files the question in QBG as single-correct with only one option ticked.")
    L.append("- \"solution\": the worked solution as a LIST of parts ({\"t\":prose}/{\"m\":latex}); null if there is no worked solution for that number.")
    L.append("- \"fig\": a solution diagram image filename if one is present for that solution, else null.")
    L.append("- Ignore 'Video Solution' / QR-code placeholders — they are not solutions.")
    L.extend(_VERBATIM_RULES)
    if rich:
        L.extend(_rich_rules("Keep"))
    if image_names:
        L.append("")
        L.append("Image files present in this document: " + ", ".join(sorted(image_names)))
    L.append("")
    L.append("=== SOLUTIONS DOCUMENT (Markdown) ===")
    L.append(markdown)
    return "\n".join(L)


_SOLVE_SCHEMA = '''{
  "results": [
    { "num": 51, "answer": "A | [\\"A\\",\\"C\\"] | 18", "solution": [ {"t":"short label:"}, {"m":"equation"}, {"t":"next label:"}, {"m":"equation"} ] }
  ]
}'''


def _build_solve_prompt(questions, rich=False):
    L = []
    L.append("You are given exam questions that are MISSING their correct answer and/or a worked "
             "solution. For EACH, work it out yourself: determine the correct answer and write a "
             "concise, correct step-by-step solution. Re-derive and re-check every number — "
             "accuracy is non-negotiable.")
    L.append("")
    L.append("Return ONLY valid JSON (no markdown fences) shaped exactly like this:")
    L.append(_SOLVE_SCHEMA)
    L.append("")
    L.append("RULES:")
    L.append("- \"answer\": SCQ -> one letter \"A\"-\"D\" (the correct option). MCQ -> list of correct letters. "
             "Numerical -> the number. Match the question's type.")
    L.append("- \"solution\": a LIST of parts ({\"t\":prose}/{\"m\":latex}), STEP style and terse — a short label "
             "then its equation. Put only real equations in {\"m\":...} as plain LaTeX.")
    L.append("- Verify the answer by re-doing the computation before choosing.")
    if rich:
        L.extend(_rich_rules("Write"))
    L.append("")
    L.append("=== QUESTIONS TO SOLVE ===")
    for q in questions:
        L.append("")
        L.append("Q%s [type=%s]: %s" % (q["num"], q["type"], _parts_text(q.get("stem"))))
        opts = q.get("options") or []
        for idx, o in enumerate(opts[: len(_LET)]):
            L.append("   (%s) %s" % (_LET[idx], _parts_text(o)))
    return "\n".join(L)


def _parts_text(parts):
    buf = []
    for p in parts or []:
        if isinstance(p, dict):
            buf.append(str(p.get("t") if "t" in p else p.get("m", "")))
    return re.sub(r"\s+", " ", "".join(buf)).strip()


# --------------------------------------------------------------------------- #
#  figure mapping / generation
# --------------------------------------------------------------------------- #
def _place_fig(fig_ref, media_dirs, figdir, num):
    """Copy a referenced docx image into figdir as qN_figure.png. Returns the new
    name or None."""
    if not fig_ref:
        return None
    for md in media_dirs:
        mp = _media_path(md, fig_ref)
        if mp:
            nm = "q%s_figure.png" % num
            if _save_png(mp, os.path.join(figdir, nm)):
                return nm
    return None


def _generate_fig(desc, figdir, num, img_provider, img_key, img_model):
    """Draw a fresh diagram from a text description via imagegen. Returns name or None."""
    prov = IMG_PROVIDER_MAP.get(img_provider or "")
    if not (prov and img_key and desc):
        return None
    try:
        data = _imagegen.generate_image(prov, img_key, img_model, desc)
        nm = "q%s_figure.png" % num
        with open(os.path.join(figdir, nm), "wb") as f:
            f.write(data)
        return nm
    except Exception as e:
        log.exception("diagram generation failed for Q%s", num)
        return ("ERR:" + str(e)[:200])


# --------------------------------------------------------------------------- #
#  main
# --------------------------------------------------------------------------- #
def _fill_gaps(questions, warnings, provider, api_key, model, base_url,
               solve_missing, author_missing, rich_solution):
    """AI-solve the answers and AI-author the solutions that the source didn't
    carry. Shared by the .docx path and the HTML one — an HTML paper missing a
    stated answer deserves the same treatment, and only those questions cost a
    model call."""
    need = [q for q in questions
            if (solve_missing and not _has_answer(q["answer"]))
            or (author_missing and not q["solution"])]
    if need:
        solved = {}
        batches = list(_chunked(need, INGEST_CHUNK_SIZE))
        _progress.emit("solve", "AI solving/authoring %d question(s) with no answer or solution…" % len(need),
                       done=0, total=len(batches))
        for bi, chunk in enumerate(batches, 1):
            _progress.emit("solve", "Solving/authoring batch %d/%d…" % (bi, len(batches)),
                           done=bi, total=len(batches))
            try:
                sp = _build_solve_prompt(chunk, rich=rich_solution)
                r = _llm.generate(provider, api_key, model, sp, system=_SYS_SOLVE,
                                  base_url=base_url, max_tokens=24000 if rich_solution else 8000)
                for item in (r.get("results") if isinstance(r, dict) else r) or []:
                    if item.get("num") is not None:
                        solved[str(item["num"])] = item
            except Exception as e:
                warnings.append("AI solve/author failed for a batch: %s" % str(e)[:200])
        for q in questions:
            hit = solved.get(str(q["num"]))
            if not hit:
                continue
            if not _has_answer(q["answer"]) and hit.get("answer") is not None:
                q["answer"] = _norm_answer(hit.get("answer"), q["type"])
                if _has_answer(q["answer"]):
                    q["answer_source"] = "ai-solved"
            if not q["solution"] and hit.get("solution"):
                q["solution"] = hit.get("solution")
                q["solution_source"] = "ai-authored"

    for q in questions:
        if not _has_answer(q["answer"]):
            warnings.append("Q%s: no answer could be determined" % q["num"])
        if not q["solution"]:
            q["solution"] = []  # keep shape valid for downstream builders


def ingest_extract(question_docx, solution_docx, workdir, provider, api_key, model,
                   base_url=None, img_provider=None, img_key=None, img_model=None,
                   solve_missing=True, author_missing=True, gen_diagrams=True,
                   use_patterns=True, rich_solution=False, html_direct=True):
    """Returns {source_name, questions:[reframed-shape + type + flags], figdir, warnings,
    pattern_used, pattern_learned}."""
    warnings = []
    figdir = os.path.join(workdir, "figures")
    os.makedirs(figdir, exist_ok=True)
    source_name = os.path.splitext(os.path.basename(question_docx))[0]

    # ---- HTML, read directly ----
    # Tried FIRST, because it is the only path that cannot change the text: it
    # copies the document. A model asked to extract a solution will tidy it —
    # completing a Wrong Answer Analysis with entries the teacher never wrote,
    # rewording a line — and the question was already approved as it stands
    # (2026-09-08 report). So: read it structurally, and fall back to the AI only
    # when the layout genuinely does not match (these papers' layouts do move
    # between batches, which is why the fallback exists at all).
    if html_direct and _html_ingest.looks_like_html(question_docx):
        _progress.emit("convert", "Reading the HTML paper directly (no AI)…")
        parsed = None
        try:
            parsed = _html_ingest.parse_html_paper(question_docx, figdir,
                                                   rich_solution=rich_solution)
        except Exception as e:
            log.exception("direct HTML read failed — falling back to the AI extractor")
            warnings.append("reading the HTML directly failed (%s) — used the AI extractor "
                            "instead." % str(e)[:160])
        shortfall = None
        if parsed is None:
            shortfall = "no 'Question <n>' headings were found"
        else:
            qs = parsed["questions"]
            answered = sum(1 for q in qs if _has_answer(q.get("answer")))
            # A structure-guided read that finds questions but almost no answers has
            # matched the headings and missed the rest of the layout; that is worse
            # than not matching at all, because it looks like success.
            if qs and answered * 2 < len(qs):
                shortfall = ("only %d of %d questions had an answer, so the layout does not "
                             "match the template" % (answered, len(qs)))
        if shortfall:
            warnings.append("the HTML could not be read directly (%s) — used the AI extractor "
                            "instead." % shortfall)
            parsed = None
        if parsed is not None:
            questions = parsed["questions"]
            warnings.extend(parsed["warnings"])
            if solution_docx:
                warnings.append("the separate solutions file was ignored: an HTML paper is read "
                                "whole, solutions included.")
            _progress.emit("extract_q", "Read %d question(s) straight from the HTML" % len(questions),
                           done=len(questions), total=len(questions))
            # Only questions the file left unanswered cost a model call.
            _fill_gaps(questions, warnings, provider, api_key, model, base_url,
                       solve_missing, author_missing, rich_solution)
            log.info("ingest_extract(html) ok: source=%s questions=%d figures=%d",
                     source_name, len(questions), sum(1 for q in questions if q["fig"]))
            return {"source_name": source_name, "questions": questions, "figdir": figdir,
                    "warnings": warnings, "pattern_used": "html (parsed directly)",
                    "pattern_learned": None}

    _progress.emit("convert", "Reading the uploaded document(s)…")
    q_md, q_media = _docx_to_markdown(question_docx, workdir, "q")
    media_dirs = [q_media]
    q_images = {f for _r, _d, fs in os.walk(q_media) for f in fs}

    # solutions live either in a separate file, or in the same (single) file
    if solution_docx:
        s_md, s_media = _docx_to_markdown(solution_docx, workdir, "s")
        media_dirs.append(s_media)
        s_images = {f for _r, _d, fs in os.walk(s_media) for f in fs}
    else:
        s_md, s_images = q_md, q_images  # single file: solutions are in the same doc

    # ---- 0) learned-format fast path: if a previously learned pattern parses this
    #         file cleanly, skip the AI extraction entirely (0 model cost). ----
    pattern_used = None
    raw_qs = []
    sol_by_num = {}
    # A learned spec was taught by an ordinary run, so it slices out the worked
    # solution alone — exactly what rich mode is asking us not to do. Rich runs
    # therefore always go to the model (and never teach a spec, below).
    if use_patterns and not rich_solution:
        try:
            hit = _patterns.apply_saved(q_md, s_md)
        except Exception:
            log.exception("pattern apply failed — falling back to AI")
            hit = None
        if hit:
            raw_qs = hit["questions"]
            sol_by_num = hit["solutions"]
            pattern_used = hit["spec_id"]
            _progress.emit("pattern", "Matched learned format '%s' — extracted %d question(s) "
                           "without the AI model" % (pattern_used, len(raw_qs)),
                           done=len(raw_qs), total=len(raw_qs))

    if not raw_qs:
        # ---- 1) extract questions with the AI model ----
        _progress.emit("extract_q", "Extracting questions with AI (large papers take a few minutes)…")
        q_prompt = _build_question_prompt(q_md, q_images)
        payload = _gen_retry(provider, api_key, model, q_prompt, base_url, 16000, _SYS_EXTRACT,
                             "Question extraction")
        raw_qs = (payload.get("questions") if isinstance(payload, dict) else payload) or []
        if not raw_qs:
            raise ValueError("the AI extractor found no questions in the uploaded file")
        _progress.emit("extract_q", "Found %d question(s)" % len(raw_qs), done=len(raw_qs), total=len(raw_qs))

        # ---- 2) extract solutions/answers from the solution source ----
        _progress.emit("extract_s", "Extracting the answer key & worked solutions…")
        try:
            s_prompt = _build_solution_prompt(s_md, s_images, rich=rich_solution)
            # Four sections per question instead of one: the same paper needs a far
            # bigger answer budget, and running out mid-JSON costs the whole call.
            s_budget = 32000 if rich_solution else 16000
            s_payload = _gen_retry(provider, api_key, model, s_prompt, base_url, s_budget, _SYS_EXTRACT,
                                   "Solution extraction")
            for s in (s_payload.get("solutions") if isinstance(s_payload, dict) else s_payload) or []:
                n = s.get("num")
                if n is not None:
                    sol_by_num[str(n)] = s
        except Exception as e:
            warnings.append("solution extraction failed: %s" % str(e)[:200])
        _progress.emit("extract_s", "Matched %d answer/solution block(s)" % len(sol_by_num))

    # ---- 3) assemble, matching solutions by number ----
    def _type_from_answer(qtype, answer):
        """A key naming more than one option IS a multi-correct question.

        The extractor classifies the type from the question's wording, which does
        not always announce itself ("Which of the following statements is(are)
        correct?"), so a paper whose key says "(A), (B) and (C)" was being pushed
        to QBG as single-correct — type 1 instead of 2 — with only the first
        option marked (2026-09-08 report). The answer key is the harder evidence,
        so it wins.
        """
        if qtype == "Numerical":
            return qtype
        if isinstance(answer, (list, tuple)) and len(answer) > 1:
            return "MCQ"
        return qtype

    questions = []
    for raw in raw_qs:
        num = raw.get("num")
        qtype = _norm_type(raw.get("type"))
        stem = raw.get("stem") or []
        opts = raw.get("options") or []
        if qtype == "Numerical":
            opts = []
        answer = _norm_answer(raw.get("answer"), qtype)
        solution = raw.get("solution")
        answer_source = "stated" if _has_answer(answer) else None
        solution_source = "stated" if solution else None

        matched = sol_by_num.get(str(num))
        if matched:
            if not _has_answer(answer) and matched.get("answer") is not None:
                answer = _norm_answer(matched.get("answer"), qtype)
                if _has_answer(answer):
                    answer_source = "answer-key"
            if not solution and matched.get("solution"):
                solution = matched.get("solution")
                solution_source = "matched"
        qtype = _type_from_answer(qtype, answer)

        # figure: real image, else generate from description
        fig = _place_fig(raw.get("fig"), media_dirs, figdir, num)
        diagram_generated = False
        if not fig and raw.get("diagram_desc") and gen_diagrams:
            _progress.emit("diagram", "Drawing a diagram for Q%s…" % num)
            gen = _generate_fig(raw["diagram_desc"], figdir, num, img_provider, img_key, img_model)
            if gen and not gen.startswith("ERR:"):
                fig = gen
                diagram_generated = True
            elif gen:
                warnings.append("Q%s diagram generation failed: %s" % (num, gen[4:]))

        # image OPTIONS (graphs/diagrams as the choices — pattern path): copy each
        # referenced media image into figdir as qN_optL.png so the review pack + QBG
        # push can carry it. A missing file degrades to a placeholder text option.
        placed_opts = []
        for oi, opt in enumerate(opts[: len(_LET)]):
            if isinstance(opt, dict) and opt.get("img"):
                nm = "q%s_opt%s.png" % (num, _LET[oi])
                placed = None
                for md_dir in media_dirs:
                    mp = _media_path(md_dir, opt["img"])
                    if mp and _save_png(mp, os.path.join(figdir, nm)):
                        placed = nm
                        break
                placed_opts.append({"img": placed} if placed else [{"t": "(image option missing)"}])
                if not placed:
                    warnings.append("Q%s option %s image %s could not be read" % (num, _LET[oi], opt["img"]))
            else:
                placed_opts.append(opt)
        opts = placed_opts

        # SOLUTION images (diagrams inside the worked solution — pattern path): the
        # parts carry {"img": basename} INLINE at the diagram's original position;
        # copy each into figdir and rewrite to the placed name. Unplaceable ones are
        # dropped (with a warning) rather than left dangling.
        if solution:
            placed_sol = []
            k = 0
            for p in solution:
                if isinstance(p, dict) and p.get("img") and "t" not in p and "m" not in p:
                    k += 1
                    nm = "q%s_sol%d.png" % (num, k)
                    placed = False
                    for md_dir in media_dirs:
                        mp = _media_path(md_dir, p["img"])
                        if mp and _save_png(mp, os.path.join(figdir, nm)):
                            placed = True
                            break
                    if placed:
                        placed_sol.append({"img": nm})
                    else:
                        warnings.append("Q%s solution image %s could not be read" % (num, p["img"]))
                else:
                    placed_sol.append(p)
            solution = placed_sol

        questions.append({
            "num": num, "type": qtype, "chapter": raw.get("chapter") or "",
            "stem": stem, "options": opts, "fig": fig,
            "answer": answer, "solution": solution,
            "answer_source": answer_source, "solution_source": solution_source,
            "diagram_generated": diagram_generated,
            "diagram_desc": raw.get("diagram_desc") or None,
        })

    # ---- 4) fill gaps: AI solves answer / authors solution ----
    _fill_gaps(questions, warnings, provider, api_key, model, base_url,
               solve_missing, author_missing, rich_solution)

    # ---- 5) pattern learning: when this file needed the AI, check whether a
    #         deterministic spec reproduces the AI's extraction — if so, save it and
    #         the NEXT upload in this format skips the AI entirely. ----
    pattern_learned = None
    if use_patterns and not rich_solution and pattern_used is None:
        try:
            pattern_learned = _patterns.learn(q_md, s_md, questions, source_name)
            if pattern_learned:
                _progress.emit("pattern", "Learned this file's format ('%s') — future uploads "
                               "in this format won't need the AI model" % pattern_learned)
        except Exception:
            log.exception("pattern learning failed (non-fatal)")

    nfig = sum(1 for q in questions if q["fig"])
    ngen = sum(1 for q in questions if q["diagram_generated"])
    log.info("ingest_extract ok: source=%s questions=%d figures=%d generated=%d pattern=%s",
             source_name, len(questions), nfig, ngen, pattern_used or "-")
    return {"source_name": source_name, "questions": questions, "figdir": figdir,
            "warnings": warnings, "pattern_used": pattern_used,
            "pattern_learned": pattern_learned}
