"""
docx_to_pptx
============

Convert a question-paper Word document (.docx, or legacy .doc) into the same
widescreen PPTX slide deck produced by ``pdf_to_pptx.convert()`` — one slide
per question, cropped + whitespace-trimmed, on the branded base slide.

Unlike a PDF (already a fixed grid of pixels we can crop directly), a .docx
has no fixed page geometry, and content like OMML equations, embedded
diagrams and super/subscripts can't be reconstructed faithfully with text
boxes alone. So instead of re-implementing Word layout, this module:

  1. Opens the docx with python-docx and finds question boundaries from the
     leading "N." marker at the start of a paragraph (regex), stopping at
     the first numbering regression — question papers commonly repeat "1.,
     2., ..." in an answer-key / solutions section afterwards, which we do
     not want on the slides.
  2. Strips that leading "N." marker text and forces each question's first
     paragraph onto a new page (``paragraph_format.page_break_before``), so
     LibreOffice is guaranteed to start rendering each question at the top
     of a fresh PDF page — one question can never share a page-start with
     another.
  3. Shells out to LibreOffice (``soffice --headless --convert-to pdf``) to
     render the modified docx. Word-compatible layout engine does the
     actual typesetting, so equations/images/formatting come out exactly as
     they would printed from Word — no re-implementation needed.
  4. Locates each question's start page by searching the rendered PDF's
     text layer for a fingerprint of the question's own paragraph text (the
     forced page break guarantees a 1:1 first-match).
  5. Reuses pdf_to_pptx's whitespace-trim + branded-slide helpers to build
     an identical-style deck to the PDF path.

Public API
----------
    convert(docx_path, pptx_path, *, dpi=200, image_left_in=0.33,
            image_top_in=0.40) -> dict
    render_question_images(docx_path, *, dpi=200, workdir=None)
        -> (dict[int, Path], dict) — steps 1-4 above, stopping short of
        pptx assembly. `convert()` is a thin wrapper around this, and
        qbg_source.py (synthetic QBG-sourced docs) uses it directly to get
        raw per-question images for video narration.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Tuple

import docx
import fitz  # PyMuPDF
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt
from PIL import Image

from pdf_to_pptx import (
    Presentation,
    Inches,
    SLIDE_WIDTH_IN,
    SLIDE_HEIGHT_IN,
    SEGMENT_GAP_PX,
    _add_question_slide,
    _trim,
)

# Same question-number marker convention as pdf_to_pptx.QNUM_RE, but matched
# against the START of a paragraph's plain text rather than a whole bold span
# (a .docx numbered question is ordinary body text, not necessarily bold).
NUM_RE = re.compile(r"^\s*(\d{1,3})\.(?!\d)")

# docx source content is a full page wide (unlike the PDF pipeline's narrow
# column crop), so it needs a bigger on-slide display cap to read at a
# comparable size — the shared MAX_IMG_WIDTH_IN/HEIGHT_IN in pdf_to_pptx.py
# are tuned for that narrow column and are left untouched for the PDF path.
DOCX_IMG_LEFT_IN = 0.35
DOCX_IMG_TOP_IN = 0.35
DOCX_MAX_IMG_WIDTH_IN = 10.2
DOCX_MAX_IMG_HEIGHT_IN = 6.8

Boundary = Tuple[int, int, int]  # (start_paragraph_idx, end_paragraph_idx, qnum)


# ---------------------------------------------------------------------------
# Question detection (docx paragraphs)
# ---------------------------------------------------------------------------

def _split_questions(document: "docx.document.Document") -> List[Boundary]:
    """Locate question boundaries from paragraphs whose text starts with
    "N." (N = 1..999). Collection stops at the first regression (the next
    marker's number is <= the last one collected) — question papers commonly
    follow the question list with an answer key / solutions section that
    restarts numbering at 1, which must not become extra "questions"."""
    paragraphs = document.paragraphs
    marks: list[tuple[int, int]] = []
    for i, p in enumerate(paragraphs):
        m = NUM_RE.match(p.text)
        if m:
            marks.append((i, int(m.group(1))))

    kept: list[tuple[int, int]] = []
    # Index where regression happened (start of the excluded answer-key /
    # solutions tail) — bounds the LAST kept question's content. Defaults to
    # the end of the document when no regression is ever found.
    tail_start = len(paragraphs)
    last = 0
    for idx, n in marks:
        if kept and n <= last:
            tail_start = idx
            break
        kept.append((idx, n))
        last = n

    if not kept:
        raise ValueError(
            "No questions detected in the Word document. The detector looks "
            "for paragraphs starting with '1.', '2.', etc. Check the "
            "document's numbering."
        )

    boundaries: list[Boundary] = []
    for i, (idx, n) in enumerate(kept):
        end = kept[i + 1][0] if i + 1 < len(kept) else tail_start
        boundaries.append((idx, end, n))
    return boundaries


def _strip_leading_marker(paragraph) -> None:
    """Remove the leading 'N.' (+ one following tab/space) from a question's
    first paragraph so the rendered slide shows only the question — matching
    the PDF pipeline, which erases the same marker from the cropped image."""
    text = paragraph.text
    m = NUM_RE.match(text)
    if not m:
        return
    strip_len = m.end()
    if strip_len < len(text) and text[strip_len] in ("\t", " "):
        strip_len += 1

    remaining = strip_len
    for run in paragraph.runs:
        if remaining <= 0:
            break
        run_text = run.text
        if not run_text:
            continue
        # Never touch a run that carries a drawing/image — clearing .text on
        # python-docx's Run wipes all non-text child content, so if a run
        # somehow mixes a leading number with an inline picture, leave the
        # rest of the marker in place rather than risk losing the image.
        if "w:drawing" in run._r.xml:
            break
        if len(run_text) <= remaining:
            remaining -= len(run_text)
            run.text = ""
        else:
            run.text = run_text[remaining:]
            remaining = 0


def _normalize_formatting(document: "docx.document.Document", boundaries: List[Boundary],
                          *, align: int = WD_ALIGN_PARAGRAPH.LEFT) -> None:
    """Question papers exported from Word are frequently inconsistent in ways
    that don't matter on a printed page but read as broken on a slide:

      * Justified paragraphs stretch word spacing unevenly on short wrapped
        lines (very visible once a paragraph is cropped to slide width) —
        this is why the default here is LEFT, not JUSTIFY. Callers whose
        source docx already wraps at its own final display width (so there
        are no short/uneven wrapped lines to stretch) can opt into
        JUSTIFY explicitly — see qbg_source.py, which narrows its synthetic
        page to the same width the content will actually be shown at.
      * Numbered-list paragraphs use a hanging indent (first line flush
        left where the "N." used to sit, continuation lines indented to
        align with the text after it) — after _strip_leading_marker removes
        the "N.", the first line no longer has anything occupying that
        space, so it now looks raggedly mis-aligned against the wrapped
        lines below it.
      * Option paragraphs ((A)/(B)/(C)/(D)) aren't always styled
        consistently — one option pasted from elsewhere can end up with a
        different (or no) indent than its siblings.

    This normalizes every paragraph up to the excluded answer-key tail:
    align per `align` (default LEFT), remove the hanging first-line
    offset (kills the ragged-first-line effect), zero out indentation for
    ordinary stem paragraphs, and force every option-styled paragraph to
    share one consistent indent (taken from the first one encountered)."""
    tail_start = boundaries[-1][1]
    option_indent = None
    for i in range(tail_start):
        para = document.paragraphs[i]
        para.alignment = align
        pf = para.paragraph_format
        pf.first_line_indent = Pt(0)
        is_option = "option" in (para.style.name or "").lower()
        if is_option:
            if option_indent is None and pf.left_indent is not None:
                option_indent = pf.left_indent
            if option_indent is not None:
                pf.left_indent = option_indent
        else:
            pf.left_indent = Pt(0)


# ---------------------------------------------------------------------------
# LibreOffice conversion
# ---------------------------------------------------------------------------

def _find_soffice() -> str:
    env = os.environ.get("QBG_SOFFICE")
    if env and Path(env).exists():
        return env
    candidates = [
        "soffice",
        "soffice.exe",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/opt/libreoffice/program/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for c in candidates:
        found = shutil.which(c)
        if found:
            return found
        if Path(c).exists():
            return c
    raise RuntimeError(
        "LibreOffice (soffice) was not found. Install LibreOffice, or set "
        "QBG_SOFFICE to the full path of the soffice binary."
    )


def _soffice_convert(src: Path, outdir: Path, soffice_bin: str, target: str) -> Path:
    """Run one `soffice --convert-to <target>` and return the produced file
    path. Uses an isolated user profile per job so concurrent conversions
    (different Node requests running at once) never collide on LibreOffice's
    default profile lock.

    A brand-new, never-used UserInstallation profile directory can crash
    LibreOffice on its very first launch (it does first-run setup — filter
    and font registration — under `--headless`, and that setup step is
    known to segfault on some installs); a second launch into the SAME
    now-partially-initialized directory succeeds immediately. Retry once
    into the same profile dir before giving up, rather than surfacing that
    one-time crash as a hard failure."""
    profile_dir = outdir / "lo_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        soffice_bin,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
        "--convert-to",
        target,
        "--outdir",
        str(outdir),
        str(src),
    ]
    out_path = outdir / (src.stem + f".{target}")
    last_proc = None
    for _attempt in range(2):
        last_proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if last_proc.returncode == 0 and out_path.exists():
            return out_path
    raise RuntimeError(
        f"LibreOffice conversion to .{target} failed (exit {last_proc.returncode}) "
        f"after retry. stdout: {last_proc.stdout.strip()[:2000]} "
        f"stderr: {last_proc.stderr.strip()[:2000]}"
    )


def _ensure_docx(path: Path, workdir: Path, soffice_bin: str) -> Path:
    """Legacy .doc files aren't a zip/OOXML package python-docx can open —
    convert them to .docx with LibreOffice first."""
    if path.suffix.lower() == ".docx":
        return path
    return _soffice_convert(path, workdir, soffice_bin, "docx")


# ---------------------------------------------------------------------------
# Mapping questions -> rendered PDF pages
# ---------------------------------------------------------------------------

def _fingerprint(document: "docx.document.Document", start: int, end: int,
                 min_len: int = 8, max_len: int = 50) -> str:
    """A short, whitespace-normalised text snippet unique enough to locate
    this question's start page in the rendered PDF's text layer. Some
    questions carry no text on their first paragraph (just the "N." marker,
    with the real stem in the next paragraph, or entirely an image) — walk
    forward through the question's own paragraphs until there's enough text,
    or give up (empty string) if the question is pure image/equation."""
    parts: list[str] = []
    total = 0
    for i in range(start, end):
        t = document.paragraphs[i].text.strip()
        if not t:
            continue
        parts.append(t)
        total += len(t)
        if total >= max_len:
            break
    combined = re.sub(r"\s+", " ", " ".join(parts)).strip()
    if len(combined) < min_len:
        return ""
    return combined[:max_len]


def _locate_start_pages(document: "docx.document.Document", pdf: "fitz.Document",
                        boundaries: List[Boundary]) -> List[int]:
    page_texts = [re.sub(r"\s+", " ", page.get_text()) for page in pdf]
    starts: list[int] = []
    search_from = 0
    for start_idx, end_idx, _qnum in boundaries:
        fp = _fingerprint(document, start_idx, end_idx)
        found = None
        if fp:
            for p in range(search_from, len(page_texts)):
                if fp in page_texts[p]:
                    found = p
                    break
        if found is None:
            # Fingerprint-less (pure image/equation) question, or a page
            # miss — best-effort: assume it starts right after the previous
            # question, never before it.
            found = search_from
        starts.append(found)
        search_from = found + 1
    return starts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def render_question_images(docx_path: str | Path,
                           *,
                           dpi: int = 200,
                           workdir: Path | None = None,
                           align: int = WD_ALIGN_PARAGRAPH.LEFT) -> tuple[dict[int, Path], dict]:
    """Render each question detected in `docx_path` to a whitespace-trimmed
    PNG (steps 1-4 in the module docstring). Returns ({qnum: png_path}, meta)
    where meta = {"question_count": int, "questions": [qnum, ...]}.

    `workdir`: when None, a fresh temp dir is created to hold the rendered
    PNGs. On SUCCESS that directory is left in place (the returned paths
    live inside it) — the caller owns cleaning it up once it's done reading
    the images. On failure it's removed here. Pass an existing dir to render
    into a workdir you already control (e.g. to keep two calls' outputs
    alongside each other without collision — qbg_source.py renders a
    "questions" doc and a "solutions" doc into separate subdirectories).

    `align`: paragraph alignment applied by _normalize_formatting — see its
    docstring for why LEFT is the safe default.
    """
    docx_path = Path(docx_path)
    own_workdir = workdir is None
    workdir = Path(tempfile.mkdtemp(prefix="docx2pptx_")) if own_workdir else Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        soffice_bin = _find_soffice()
        source_docx = _ensure_docx(docx_path, workdir, soffice_bin)

        document = docx.Document(source_docx)
        boundaries = _split_questions(document)

        # Drop everything after the last real question (answer-key /
        # solutions sections, which is exactly what made _split_questions
        # stop collecting). Without this, the last question's slide would
        # have no forced page break to bound it against that trailing
        # content, and it would render glued onto the same "last question"
        # slide as a giant extra stack of pages.
        tail_start = boundaries[-1][1]
        trailing_paragraphs = document.paragraphs[tail_start:]
        for p in trailing_paragraphs:
            p._p.getparent().remove(p._p)

        for start_idx, _end_idx, _qnum in boundaries:
            para = document.paragraphs[start_idx]
            _strip_leading_marker(para)
            para.paragraph_format.page_break_before = True

        _normalize_formatting(document, boundaries, align=align)

        prepared_path = workdir / "prepared.docx"
        document.save(prepared_path)

        pdf_path = _soffice_convert(prepared_path, workdir, soffice_bin, "pdf")

        images: dict[int, Path] = {}
        pdf = fitz.open(pdf_path)
        try:
            starts = _locate_start_pages(document, pdf, boundaries)
            n_pages = pdf.page_count

            for i, (start_page, (_s, _e, qnum)) in enumerate(zip(starts, boundaries)):
                end_page = starts[i + 1] - 1 if i + 1 < len(starts) else n_pages - 1
                end_page = max(start_page, min(end_page, n_pages - 1))

                page_imgs: list[Image.Image] = []
                for p in range(start_page, end_page + 1):
                    pix = pdf[p].get_pixmap(dpi=dpi, alpha=False)
                    page_imgs.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))

                if len(page_imgs) == 1:
                    stacked = page_imgs[0]
                else:
                    width = max(im.width for im in page_imgs)
                    height = (sum(im.height for im in page_imgs)
                              + SEGMENT_GAP_PX * (len(page_imgs) - 1))
                    stacked = Image.new("RGB", (width, height), (255, 255, 255))
                    y = 0
                    for im in page_imgs:
                        stacked.paste(im, (0, y))
                        y += im.height + SEGMENT_GAP_PX

                final, _x0, _y0 = _trim(stacked, dpi)
                img_path = workdir / f"q{qnum:03d}.png"
                final.save(img_path)
                images[qnum] = img_path
        finally:
            pdf.close()
    except Exception:
        if own_workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        raise

    meta = {"question_count": len(boundaries), "questions": [qnum for _, _, qnum in boundaries]}
    return images, meta


def convert(docx_path: str | Path,
            pptx_path: str | Path,
            *,
            dpi: int = 200,
            image_left_in: float = DOCX_IMG_LEFT_IN,
            image_top_in: float = DOCX_IMG_TOP_IN) -> dict:
    docx_path = Path(docx_path)
    pptx_path = Path(pptx_path)

    workdir = Path(tempfile.mkdtemp(prefix="docx2pptx_"))
    try:
        images, meta = render_question_images(docx_path, dpi=dpi, workdir=workdir)

        prs = Presentation()
        prs.slide_width = Inches(SLIDE_WIDTH_IN)
        prs.slide_height = Inches(SLIDE_HEIGHT_IN)

        for qnum in meta["questions"]:
            img = Image.open(images[qnum])
            _add_question_slide(
                prs, img, image_left_in, image_top_in,
                max_width_in=DOCX_MAX_IMG_WIDTH_IN,
                max_height_in=DOCX_MAX_IMG_HEIGHT_IN,
            )

        prs.save(pptx_path)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return {
        "docx": str(docx_path),
        "pptx": str(pptx_path),
        "question_count": meta["question_count"],
        "questions": meta["questions"],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(description="Convert a question Word doc to a slide deck.")
    ap.add_argument("docx", help="Source .docx/.doc path")
    ap.add_argument("pptx", help="Destination PPTX path")
    ap.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    args = ap.parse_args()

    report = convert(args.docx, args.pptx, dpi=args.dpi)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
