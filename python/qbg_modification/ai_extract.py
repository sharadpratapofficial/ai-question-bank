# -*- coding: utf-8 -*-
"""AI-based extraction of the ORIGINAL questions from a .docx, robust to any layout.

The regex extractor in extract.py assumes one fixed format (questions "1."..,
an answer key like "1. (B)", then "Text Solution:" blocks). Real papers vary
wildly — different numbering, "(1)-(4)" options, no answer key, no solutions,
equations as images/MathML. So here we:

  1. use pandoc ONLY to (a) render equations as LaTeX and (b) pull diagram images
     to local files (via --extract-media), and
  2. hand the resulting markdown to the SAME LLM used for reframing, which
     structures it into questions/options/answer/solution + figure references.

The result is assembled into the exact `data` dict shape extract.extract()
returns, so build_prompt / reframe / htmlbuild / csvbuild / qbg all work unchanged.
"""
import os
import re
import json
import shutil

import pypandoc

import llm as _llm
from mathconv import field_html
from logsetup import get_logger

log = get_logger("ai_extract")

_LET = "ABCD"


def _to_tuples(parts):
    """[{'t':..}|{'m':..}] -> [('t',..),('m',..)] for mathconv.field_html."""
    out = []
    for p in parts or []:
        if not isinstance(p, dict):
            continue
        if "t" in p:
            out.append(("t", p["t"]))
        elif "m" in p:
            out.append(("m", p["m"]))
    return out


def _plain(parts):
    """Readable plain text of a parts list (prose verbatim, equations as their LaTeX)."""
    buf = []
    for kind, val in _to_tuples(parts):
        buf.append(str(val))
    return re.sub(r"\s+", " ", "".join(buf)).strip()


def _norm_answer(ans):
    """Normalise an answer to a letter A-D (accepts 'A'..'D', '1'..'4', '(2)', etc.)."""
    if ans is None:
        return ""
    s = str(ans).strip().strip("()").strip()
    if not s:
        return ""
    if s[:1].upper() in _LET:
        return s[:1].upper()
    if s[:1].isdigit():
        n = int(re.match(r"\d+", s).group())
        return _LET[n - 1] if 1 <= n <= 4 else ""
    return ""


def _media_path(media_dir, name):
    """Find a media file by basename anywhere under media_dir."""
    base = os.path.basename(name or "")
    if not base:
        return None
    for root, _dirs, files in os.walk(media_dir):
        if base in files:
            return os.path.join(root, base)
    return None


def _soffice_bin():
    """LibreOffice CLI, if installed (used to rasterise EMF/WMF vector images)."""
    cand = os.environ.get("QBG_SOFFICE", "").strip()
    if cand and os.path.exists(cand):
        return cand
    win = r"C:\Program Files\LibreOffice\program\soffice.exe"
    if os.path.exists(win):
        return win
    return shutil.which("soffice") or shutil.which("soffice.exe")


def _emf_to_png(src_path, dst_path):
    """Rasterise an EMF/WMF vector image to PNG via LibreOffice headless — PIL can't
    read those formats, and browsers can't display them, so without this the figures
    from Word files (drawn objects / CorelDraw exports) arrive broken."""
    soffice = _soffice_bin()
    if not soffice:
        return False
    import subprocess, tempfile
    outdir = tempfile.mkdtemp(prefix="emf2png_")
    try:
        subprocess.run([soffice, "--headless", "--convert-to", "png", "--outdir", outdir, src_path],
                       check=True, capture_output=True, timeout=90)
        base = os.path.splitext(os.path.basename(src_path))[0] + ".png"
        produced = os.path.join(outdir, base)
        if not os.path.exists(produced):
            return False
        shutil.copy(produced, dst_path)
        return True
    except Exception:
        log.exception("ai_extract: EMF/WMF -> PNG failed for %s", src_path)
        return False
    finally:
        shutil.rmtree(outdir, ignore_errors=True)


def _save_png(src_path, dst_path):
    """Copy/convert an extracted media image into figdir as PNG."""
    try:
        from PIL import Image
        Image.open(src_path).convert("RGB").save(dst_path, "PNG")
        return True
    except Exception:
        if os.path.splitext(src_path)[1].lower() in (".emf", ".wmf"):
            if _emf_to_png(src_path, dst_path):
                return True
        try:
            shutil.copy(src_path, dst_path)
            return True
        except Exception:
            log.exception("ai_extract: could not save figure %s", dst_path)
            return False


EXTRACT_SYSTEM = (
    "You are a meticulous exam-paper parser. You output ONLY a single valid JSON object "
    "matching the schema in the user's message — no markdown, no commentary."
)

_SCHEMA = '''{
  "source_name": "<short test name>",
  "questions": [
    {
      "num": 51,
      "stem": [ {"t":"plain prose"}, {"m":"latex equation"}, {"t":"more prose"} ],
      "fig": "image1.png OR null",
      "options": [
        [ {"t":"..."}, {"m":"..."} ],
        [ {"m":"..."} ],
        [ {"t":"..."} ],
        [ {"t":"..."} ]
      ],
      "answer": "A OR 1 OR null",
      "solution": [ {"t":"..."}, {"m":"..."} ]  // or null if the paper has no solution
    }
  ]
}'''


def build_extract_prompt(source_name, markdown, image_names):
    lines = []
    lines.append(
        "Below is a test paper converted to Markdown. Equations are LaTeX between $...$; "
        "diagrams appear as image references like ![](media/image1.png). Extract EVERY "
        "question EXACTLY as written — do NOT reword, solve, or add anything. This is a "
        "faithful transcription step, not authoring."
    )
    lines.append("")
    lines.append("OUTPUT FORMAT — return ONLY valid JSON (no markdown fences), shaped exactly like this:")
    lines.append(_SCHEMA)
    lines.append("")
    lines.append("RULES:")
    lines.append("- Keep the ORIGINAL question numbers in \"num\" (they may not start at 1).")
    lines.append("- 'stem'/each option/'solution' is a LIST of parts; each part is {\"t\":prose} OR {\"m\":latex}.")
    lines.append("- Put ONLY real equations in {\"m\":...} as plain LaTeX (no $ delimiters, no markup). Ordinary words stay in {\"t\":...}.")
    lines.append("- Preserve every option. Most questions have 4 options; if a question is numeric with no options, use an empty options list [].")
    lines.append("- If an option is itself an image, output it as {\"img\":\"image7.png\"} using the EXACT image filename shown in the markdown.")
    lines.append("- If a question has a diagram, set \"fig\" to the EXACT image filename (basename, e.g. \"image1.png\"); otherwise \"fig\": null.")
    lines.append("- If the paper gives no answer key, set \"answer\": null. If it gives no worked solution, set \"solution\": null. NEVER invent answers or solutions.")
    lines.append("- Spacing: parts are concatenated directly, so include needed spaces inside the {\"t\":...} parts around equations.")
    if image_names:
        lines.append("")
        lines.append("Image files present in the document: " + ", ".join(sorted(image_names)))
    lines.append("")
    lines.append("=== PAPER (Markdown) ===")
    lines.append(markdown)
    return "\n".join(lines)


def ai_extract(docx_path, workdir, provider, api_key, model, base_url=None):
    """AI-structured extraction. Returns the same dict shape as extract.extract():
    {source_name, questions[list], originals{N:(html,ans,sol)}, figdir, prompt}."""
    from extract import build_prompt  # local import avoids an import cycle

    log.info("ai_extract start: %s", docx_path)
    source_name = os.path.splitext(os.path.basename(docx_path))[0]
    media = os.path.join(workdir, "media"); os.makedirs(media, exist_ok=True)
    figdir = os.path.join(workdir, "figures"); os.makedirs(figdir, exist_ok=True)

    # 1) pandoc -> markdown (LaTeX math) + extracted images.
    markdown = pypandoc.convert_file(
        docx_path, "markdown", format="docx",
        extra_args=["--extract-media=" + media, "--wrap=none"],
    )
    # MathType OLE equations arrive as WMF image refs (pandoc can't read OLE); when
    # MathType is installed, convert them deterministically to LaTeX via its SDK.
    try:
        import mtef as _mtef
        math_map, _nf = _mtef.docx_math_map(docx_path)
        if math_map:
            markdown, n_swapped = _mtef.replace_wmf_math(markdown, math_map)
            log.info("ai_extract: %d MathType equation(s) converted to LaTeX", n_swapped)
    except Exception:
        log.exception("ai_extract: mathtype conversion failed — proceeding with images")
    image_names = set()
    for root, _dirs, files in os.walk(media):
        for f in files:
            image_names.add(f)

    # 2) LLM structures the markdown into questions.
    prompt = build_extract_prompt(source_name, markdown, image_names)
    payload = _llm.generate(provider, api_key, model, prompt, system=EXTRACT_SYSTEM, base_url=base_url)
    ex_questions = (payload.get("questions") if isinstance(payload, dict) else payload) or []
    if not ex_questions:
        raise ValueError("the AI extractor returned no questions from this document")
    src = (payload.get("source_name") if isinstance(payload, dict) else None) or source_name

    # 3) Assemble the `data` dict shape the rest of the pipeline expects.
    questions = []
    originals = {}
    for i, q in enumerate(ex_questions, 1):
        N = i  # renumber 1..n so figure filenames + originals map cleanly
        stem_parts = q.get("stem") or []
        opts = q.get("options") or []
        answer = _norm_answer(q.get("answer"))
        sol_parts = q.get("solution")

        # figure
        fig_name = None
        if q.get("fig"):
            mp = _media_path(media, q["fig"])
            if mp:
                fig_name = "q%d_figure.png" % N
                if not _save_png(mp, os.path.join(figdir, fig_name)):
                    fig_name = None

        # options -> html + text; detect image options
        opt_html = []
        opt_texts = []
        opt_img_names = None
        img_opts = [o for o in opts if isinstance(o, dict) and "img" in o]
        if opts and len(img_opts) == len(opts):  # every option is an image
            opt_img_names = []
            for idx, o in enumerate(opts[:4]):
                nm = "q%d_opt%s.png" % (N, _LET[idx])
                mp = _media_path(media, o.get("img"))
                if mp and _save_png(mp, os.path.join(figdir, nm)):
                    opt_img_names.append(nm)
                    opt_html.append('<p><img title="%s" src="" /></p>' % nm)
                else:
                    opt_html.append("<p></p>")
        else:
            for o in opts[:4]:
                if isinstance(o, dict) and "img" in o:
                    opt_html.append('<p><em>(image option)</em></p>')
                    opt_texts.append("(image)")
                else:
                    opt_html.append(field_html(_to_tuples(o)))
                    opt_texts.append(_plain(o))

        stem_html = field_html(_to_tuples(stem_parts))
        if fig_name:
            stem_html += '\n<p><img title="%s" src="" /></p>' % fig_name
        sol_html = field_html(_to_tuples(sol_parts)) if sol_parts else ""

        # originals compare-panel html = stem + options + answer
        oseg = [stem_html]
        for idx, oh in enumerate(opt_html):
            oseg.append('<p><b>(%s)</b> %s</p>' % (_LET[idx], oh))
        originals[N] = ("".join(oseg), answer, sol_html)

        # No options at all (and no image options) -> a Numerical/integer-answer
        # question in the source paper. Mirrors extract.py's extract() — see
        # build_prompt's type_rule, which reads this to stop the AI fabricating
        # multiple-choice options for a question that never had any.
        q_type = "NUMERICAL" if not (opt_texts or opt_img_names) else "SCQ"

        questions.append({
            "num": N,
            "q_text": _plain(stem_parts),
            "options_text": opt_texts,
            "options_html": opt_html,
            "stem_html": stem_html,
            "answer": answer,
            "sol_text": _plain(sol_parts) if sol_parts else "",
            "fig_name": fig_name,
            "opt_img_names": opt_img_names,
            "sol_img_names": [],
            "type": q_type,
        })

    prompt_out = build_prompt(src, questions)
    nfig = sum(1 for q in questions if q["fig_name"])
    log.info("ai_extract ok: source=%s questions=%d figures=%d", src, len(questions), nfig)
    return {"source_name": src, "questions": questions, "originals": originals,
            "figdir": figdir, "prompt": prompt_out}
