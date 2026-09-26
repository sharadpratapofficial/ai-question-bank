# -*- coding: utf-8 -*-
"""
qbg_source
==========

Fetch QBG questions by unique_id and assemble them into two synthetic Word
documents ("question paper" and "solutions key"), each question numbered
"N. " so it matches docx_to_pptx.py's plain-text question-boundary detector.
Reusing docx_to_pptx.render_question_images() on both docs turns them into
per-question PNGs — the same crop/trim/branded-slide pipeline the manual
docx-upload path already uses — so QBG-sourced questions come out in the
exact same visual format without a bespoke renderer.

The actual QBG fetch/download/type-classification is qbg_modification's
qbg.qbg_extract() (imported via an explicit sys.path insert — the two
python/ feature directories don't share an import path today), used as-is
rather than re-derived here: that logic has already had one real bug fixed
(Numerical questions mis-tagged as SCQ), so this module trusts it as the
single source of truth for "what type is this question" and only adds the
HTML-assembly + docx-conversion step on top.

Public API
----------
    build_from_qbg_ids(unique_ids, token, user, user_id, workdir, *, dpi=200)
        -> QbgSourceResult
"""
from __future__ import annotations

import html as _html
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "qbg_modification"),
)
import qbg as _qbg  # noqa: E402  (python/qbg_modification/qbg.py)
from mathconv import fix_mathml_in_html  # noqa: E402  (same MathType-compat fix qbg.py uses)

import docx  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Inches  # noqa: E402

from docx_to_pptx import render_question_images  # noqa: E402

try:
    import pypandoc
except ImportError:  # pragma: no cover - declared in requirements.txt
    pypandoc = None

_STUB_NO_SOLUTION = "<p><i>Solution not available.</i></p>"

_OPTION_TYPES = {"SCQ", "MCQ", "ASSERTION_REASON"}


@dataclass
class QbgSourceResult:
    q_imgs: dict            # {qnum: Path}
    sol_imgs: dict           # {qnum: Path}
    answers: dict             # {qnum: str | None}
    missing_ids: list
    skipped_unsupported: list
    question_doc_path: Path
    solutions_doc_path: Path
    qbg_id_by_num: dict       # {qnum: unique_id}


def _rewrite_first_image(html_str: str, local_name: str | None) -> str:
    """Point the FIRST <img src> at `local_name` (a filename already
    downloaded into figdir by qbg_extract). Any further images in the same
    field are left as remote URLs — qbg_extract only downloads a stem's
    first figure, and pandoc will fetch a remaining live URL itself."""
    if not local_name:
        return html_str
    urls = _qbg._img_srcs(html_str)
    if not urls:
        return html_str
    return html_str.replace(urls[0], local_name, 1)


def _rewrite_images_by_list(html_str: str, local_names: list) -> str:
    """Pair each <img src> (in document order) with the matching entry of
    `local_names` (same order qbg_extract downloaded them in)."""
    if not local_names:
        return html_str
    urls = _qbg._img_srcs(html_str)
    for url, local_name in zip(urls, local_names):
        html_str = html_str.replace(url, local_name, 1)
    return html_str


_LEADING_P_RE = re.compile(r"<p[^>]*>", re.I)


def _prepend_marker(html_str: str, marker: str) -> str:
    """Insert `marker` (e.g. "<b>1.</b> " or "(A) ") at the start of `html_str`'s
    own first paragraph, rather than wrapping the whole (already block-level)
    fragment in a NEW <p> tag. QBG's stored content/options are themselves
    "<p>...</p>" fragments; wrapping one of those in another <p> produces
    invalid nested-<p> HTML, which pandoc's HTML reader silently repairs by
    closing the outer <p> at the inner one — splitting the marker onto its
    own paragraph, disconnected from the text that follows it (e.g. an
    option letter like "(A)" landing alone on one line and its answer text
    on the next)."""
    stripped = html_str.lstrip()
    pad = html_str[: len(html_str) - len(stripped)]
    m = _LEADING_P_RE.match(stripped)
    if m:
        return pad + stripped[: m.end()] + marker + stripped[m.end():]
    return marker + html_str


_P_TAG_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.I | re.S)
_MATH_TAG_RE = re.compile(r"<math[^>]*>.*?</math>", re.I | re.S)
_ANY_TAG_RE = re.compile(r"<[^>]+>")


def _is_pure_math_paragraph(inner_html: str) -> bool:
    """True if `inner_html` (one paragraph's contents) is nothing but a
    <math> element — no other prose. Used to tell "this paragraph is really
    a continuation of the previous sentence" (merge it) apart from "this
    paragraph is a distinct list item / sentence that happens to contain a
    formula" (leave it alone — see _merge_paragraphs)."""
    without_math = _MATH_TAG_RE.sub("", inner_html)
    text = _html.unescape(_ANY_TAG_RE.sub("", without_math)).strip()
    return not text or text in {".", ":", ";", ","}


def _merge_paragraphs(html_str: str) -> str:
    """Join a paragraph into the PREVIOUS one only when it's pure equation
    with no other text — QBG's rich-text editor commonly puts a stem's
    trailing equation on its own paragraph — e.g. "<p>What is the
    equivalent mass of X in its decomposition reaction</p>
    <p><math>...</math></p>" — a within-sentence continuation, not a
    deliberate new line. Left as separate <p> tags, each renders as its own
    block/line, visually tearing the equation away from the sentence it
    belongs to.

    Deliberately conservative: a paragraph that mixes real prose with a
    formula — e.g. a numbered sub-item "(I) BaSO4(s) ⇌ Ba2+(aq) + ..." in a
    multi-part question — is NOT merged, since those are genuine distinct
    list items meant to stay on their own line (same as Assertion/Reason's
    two paragraphs, which also never qualify as "pure math" and so are
    naturally left alone without needing a special-case type check)."""
    parts = [p.strip() for p in _P_TAG_RE.findall(html_str) if p.strip()]
    if len(parts) <= 1:
        return html_str
    merged: list = [parts[0]]
    for p in parts[1:]:
        if _is_pure_math_paragraph(p):
            merged[-1] = merged[-1] + " " + p
        else:
            merged.append(p)
    return "\n".join("<p>%s</p>" % m for m in merged)


# Short-option 2x2 grid: when every option is a brief, image-free snippet
# (e.g. "30°", "45°", "60°", "90°"), stacking them one-per-line wastes most of
# the slide and reads worse than a compact A/B over C/D grid. Options longer
# than this (statements, formulae, Assertion/Reason clauses) or carrying an
# image stay one-per-row so they get the full column width.
_OPT_GRID_MAX_CHARS = 24
_LEAD_P_OPEN_RE = re.compile(r"^\s*<p[^>]*>", re.I)
_TRAIL_P_CLOSE_RE = re.compile(r"</p>\s*$", re.I)


def _plain_text(html_str: str) -> str:
    return _html.unescape(_ANY_TAG_RE.sub("", html_str or "")).strip()


def _inline_option(html_str: str) -> str:
    """Strip the option fragment's own outer <p>...</p> wrapper so its content
    can sit inside a table cell (a block <p> inside a <td> renders with extra
    vertical padding and can force the cell taller than its sibling)."""
    s = (html_str or "").strip()
    s = _LEAD_P_OPEN_RE.sub("", s, count=1)
    s = _TRAIL_P_CLOSE_RE.sub("", s, count=1)
    return s.strip()


def _options_grid_html(options_html: list) -> str | None:
    """Return a borderless 2-column HTML table (A/B, then C/D) when all
    options are short, image-free, plain text; otherwise None so the caller
    falls back to the stacked one-per-row layout. Borders are cleared later
    in _narrow_page (identified by the leading "(A)" cell), so this table
    renders as a clean side-by-side grid, not a bordered spreadsheet.

    <math> options are excluded outright, not just length-checked: stripping
    tags for the plain-text length check collapses a MathML fraction/vector
    down to a handful of characters even though the rendered equation is
    wide, so an equation option can pass the "short" check and still be far
    too wide for a half-width grid cell — it then overflows past the page
    margin and gets clipped when rendered (2026-07-24 bug report: options B/D
    cut off)."""
    opts = list(options_html[:4])
    if len(opts) < 2:
        return None
    for o in opts:
        if re.search(r"<img|<table|<math", o or "", re.I):
            return None
        if len(_plain_text(o)) > _OPT_GRID_MAX_CHARS:
            return None
    cells = ["(%s) %s" % ("ABCD"[i], _inline_option(o)) for i, o in enumerate(opts)]
    rows = []
    for r in range(0, len(cells), 2):
        pair = cells[r:r + 2]
        if len(pair) == 1:
            pair.append("")
        rows.append("<tr><td>%s</td><td>%s</td></tr>" % (pair[0], pair[1]))
    return "<table>%s</table>" % "".join(rows)


def _question_html(num: int, q: dict) -> str:
    # QBG's stored MathML carries a display="inline"/"block" attribute that
    # makes pandoc/LibreOffice typeset the equation as an off-baseline
    # "display" element instead of a proper inline one — the same alignment
    # bug qbg.py's original_qbg_records() already works around (2026-07-24
    # bug report: equations rendering lower than the surrounding text).
    stem = _rewrite_first_image(fix_mathml_in_html(q["stem_html"]), q.get("fig_name"))
    # Safe for every type except MATCHING_LIST: its stem_html contains a
    # <table>, and this regex-based merge doesn't know about table
    # boundaries — running it there would rip <p> tags out of table cells
    # and destroy the table. Every other type's stem is a flat paragraph
    # run, and the pure-math-only join rule already leaves deliberately
    # separate paragraphs (Assertion/Reason, numbered sub-items) untouched.
    if q.get("type") != "MATCHING_LIST":
        stem = _merge_paragraphs(stem)
    parts = [_prepend_marker(stem, "<b>%d.</b> " % num)]

    options_html = [fix_mathml_in_html(o) for o in (q.get("options_html") or [])]
    if q.get("type") in _OPTION_TYPES and options_html:
        opt_img_names = q.get("opt_img_names")
        has_opt_imgs = bool(opt_img_names and any(opt_img_names))
        # Short, image-free options -> compact 2x2 grid (A/B over C/D).
        grid = None if has_opt_imgs else _options_grid_html(options_html)
        if grid:
            parts.append(grid)
        else:
            for i, oh in enumerate(options_html[:4]):
                letter = "ABCD"[i]
                if opt_img_names and i < len(opt_img_names):
                    oh = _rewrite_first_image(oh, opt_img_names[i])
                parts.append(_prepend_marker(oh, "(%s) " % letter))
    # NUMERICAL has no options to render. MATCHING_LIST's List-I/List-II
    # content already lives inside stem_html (rendered as a table upstream).
    return "\n".join(parts)


def _solution_html(num: int, sol_html: str, sol_img_names: list) -> str:
    if not (sol_html or "").strip():
        return "<p><b>%d.</b></p>%s" % (num, _STUB_NO_SOLUTION)
    sol_html = fix_mathml_in_html(sol_html)
    sol_html = _rewrite_images_by_list(sol_html, sol_img_names or [])
    return _prepend_marker(sol_html, "<b>%d.</b> " % num)


def _convert_html_to_docx(html_str: str, figdir: Path, out_path: Path) -> None:
    if pypandoc is None:
        raise RuntimeError("pypandoc is not installed (pip install pypandoc_binary).")
    full = "<html><body>%s</body></html>" % html_str
    try:
        pypandoc.convert_text(
            full, "docx", format="html", outputfile=str(out_path),
            extra_args=["--resource-path=" + str(figdir)],
        )
    except Exception:
        # Defensive fallback: a malformed HTML fragment from one bad question
        # shouldn't be able to kill the whole batch's docx assembly — strip
        # tags to plain text and try again via the markdown reader.
        plain = re.sub(r"<[^>]+>", " ", full)
        plain = _html.unescape(plain)
        pypandoc.convert_text(plain, "docx", format="markdown", outputfile=str(out_path))


# Narrow the pandoc-generated page's content column to roughly half of a
# standard page's width, so text wraps at that final display width (short
# enough that JUSTIFY doesn't stretch word-spacing unevenly, per
# docx_to_pptx._normalize_formatting's own warning about that) and — since
# _add_question_slide scales the whitespace-trimmed crop to fit within a
# fixed box, height-constrained more often once the crop is narrower/taller
# — the rendered slide image ends up a "half page" column instead of
# stretching edge-to-edge, matching the rest of the app's real QBG exam-PDF
# look (pdf_to_pptx.py's own two-column crop is similarly narrow).
_PAGE_WIDTH_IN = 4.6
_PAGE_HEIGHT_IN = 20.0
_PAGE_MARGIN_IN = 0.4

# Cap embedded diagrams by height as well as width. Pandoc embeds each figure
# at its native pixel size, which for many QBG diagrams is tall enough to
# dominate the slide and shrink the question text once the whole crop is
# scaled to fit the slide box. Holding the figure to this height keeps the
# text visually larger relative to the diagram (what the user asked for:
# "text size can be increased and figure size reduced"). Width is still capped
# to the content column (below).
_IMG_MAX_HEIGHT_IN = 3.4
_IMG_MAX_WIDTH_FRAC = 0.95   # of the content column width


def _narrow_page(docx_path: Path) -> None:
    d = docx.Document(str(docx_path))
    for section in d.sections:
        section.page_width = Inches(_PAGE_WIDTH_IN)
        section.page_height = Inches(_PAGE_HEIGHT_IN)
        section.left_margin = Inches(_PAGE_MARGIN_IN)
        section.right_margin = Inches(_PAGE_MARGIN_IN)
        section.top_margin = Inches(_PAGE_MARGIN_IN)
        section.bottom_margin = Inches(_PAGE_MARGIN_IN)

    # pandoc sizes each embedded diagram at its native pixel size (96 DPI),
    # which is frequently wider (and/or taller) than this narrowed column.
    # Word/LibreOffice do NOT auto-shrink an inline image to fit — it just
    # overflows and gets clipped at the page edge when rendered to PDF. Cap
    # every image to the content width AND a max height, scaling uniformly by
    # the tighter of the two ratios so nothing distorts and big diagrams stop
    # crowding out the text.
    content_width = Inches(_PAGE_WIDTH_IN - 2 * _PAGE_MARGIN_IN)
    max_w = int(content_width * _IMG_MAX_WIDTH_FRAC)
    max_h = Inches(_IMG_MAX_HEIGHT_IN)
    for shape in d.inline_shapes:
        w, h = shape.width, shape.height
        if not (w and h):
            continue
        ratio = 1.0
        if w > max_w:
            ratio = min(ratio, max_w / w)
        if h > max_h:
            ratio = min(ratio, max_h / h)
        if ratio < 1.0:
            shape.width = int(w * ratio)
            shape.height = int(h * ratio)

    # Clear borders on the short-option grid tables (identified by their
    # leading "(A)" cell) so they render as a clean side-by-side layout rather
    # than a bordered spreadsheet. Matching-List tables (List-I / List-II) are
    # left with their borders intact.
    half_cell = Inches((_PAGE_WIDTH_IN - 2 * _PAGE_MARGIN_IN) / 2)
    for table in d.tables:
        if _is_option_grid_table(table):
            _clear_table_borders(table)
            table.autofit = False
            for row in table.rows:
                for cell in row.cells:
                    cell.width = half_cell

    d.save(str(docx_path))


def _is_option_grid_table(table) -> bool:
    try:
        first_cell = table.rows[0].cells[0].text.strip()
    except (IndexError, AttributeError):
        return False
    return bool(re.match(r"^\(A\)", first_cell))


def _clear_table_borders(table) -> None:
    tbl_pr = table._tbl.tblPr
    for existing in tbl_pr.findall(qn("w:tblBorders")):
        tbl_pr.remove(existing)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "nil")
        borders.append(el)
    tbl_pr.append(borders)


def build_from_qbg_ids(unique_ids: list, token: str, user: str, user_id: str,
                        workdir, *, dpi: int = 200) -> QbgSourceResult:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    fetch_dir = workdir / "fetch"
    fetch_dir.mkdir(exist_ok=True)

    data = _qbg.qbg_extract(unique_ids, token, user, user_id, str(fetch_dir))
    figdir = Path(data["figdir"])
    questions = data["questions"]
    originals = data["originals"]  # {orig_num: (content_html, answer, sol_html)}

    # Renumber densely 1..len(questions) so the two generated docs (and the
    # `answers` dict) line up 1:1 regardless of which ids were skipped or
    # missing. `q["num"]` is qbg_extract's own 1-based index into
    # `unique_ids` (enumerate(unique_ids, 1)) — used here only to recover the
    # original qbg_id and this question's (content_html, answer, sol_html).
    qbg_id_by_num: dict = {}
    answers: dict = {}
    q_parts: list = []
    s_parts: list = []
    for new_num, q in enumerate(questions, 1):
        orig_num = q["num"]
        _content_html, answer, sol_html = originals.get(orig_num, ("", None, ""))
        qbg_id_by_num[new_num] = unique_ids[orig_num - 1]
        answers[new_num] = answer or None
        q_parts.append(_question_html(new_num, q))
        s_parts.append(_solution_html(new_num, sol_html, q.get("sol_img_names")))

    if not q_parts:
        raise ValueError(
            "None of the given QBG ids produced a usable question "
            "(all missing and/or an unsupported type)."
        )

    question_doc_path = workdir / "question_paper.docx"
    solutions_doc_path = workdir / "solutions_key.docx"
    _convert_html_to_docx("\n".join(q_parts), figdir, question_doc_path)
    _convert_html_to_docx("\n".join(s_parts), figdir, solutions_doc_path)
    _narrow_page(question_doc_path)
    _narrow_page(solutions_doc_path)

    q_imgs, _q_meta = render_question_images(
        question_doc_path, dpi=dpi, workdir=workdir / "q_render", align=WD_ALIGN_PARAGRAPH.JUSTIFY
    )
    sol_imgs, _s_meta = render_question_images(
        solutions_doc_path, dpi=dpi, workdir=workdir / "s_render", align=WD_ALIGN_PARAGRAPH.JUSTIFY
    )

    return QbgSourceResult(
        q_imgs=q_imgs,
        sol_imgs=sol_imgs,
        answers=answers,
        missing_ids=data.get("missing_ids") or [],
        skipped_unsupported=data.get("skipped_unsupported") or [],
        question_doc_path=question_doc_path,
        solutions_doc_path=solutions_doc_path,
        qbg_id_by_num=qbg_id_by_num,
    )


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Fetch QBG questions and build question/solutions docs.")
    ap.add_argument("ids", help="Comma or newline separated QBG unique_ids")
    ap.add_argument("workdir")
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    token = os.environ.get("QBG_TOKEN", "").strip()
    user = os.environ.get("QBG_USER", "Qbg sub admin").strip()
    user_id = os.environ.get("QBG_USER_ID", "").strip()
    if not (token and user_id):
        print("Set QBG_TOKEN and QBG_USER_ID env vars first.", file=sys.stderr)
        sys.exit(2)

    ids = [i.strip() for i in re.split(r"[\s,]+", args.ids) if i.strip()]
    result = build_from_qbg_ids(ids, token, user, user_id, args.workdir, dpi=args.dpi)
    json.dump({
        "question_count": len(result.q_imgs),
        "missing_ids": result.missing_ids,
        "skipped_unsupported": result.skipped_unsupported,
        "question_doc": str(result.question_doc_path),
        "solutions_doc": str(result.solutions_doc_path),
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")
