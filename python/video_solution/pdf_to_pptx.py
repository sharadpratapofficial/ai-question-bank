"""
pdf_to_pptx
===========

Convert a question-paper PDF (2-column, numbered "N." questions) into a
widescreen PowerPoint deck — one slide per question, each slide showing a
cropped, whitespace-trimmed image of the question — matching the visual
style of the AITS sample deck shipped with this project.

Public API
----------
    convert(pdf_path, pptx_path, *, dpi=200, image_left_in=0.33,
            image_top_in=0.40) -> dict

Returns a small report dict (question count, list of questions, etc.) that
the web app can show to the user.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List

import fitz  # PyMuPDF
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Emu, Inches


# ---------------------------------------------------------------------------
# Tunables — match the AITS sample deck (16:9, image anchored top-left).
# ---------------------------------------------------------------------------
SLIDE_WIDTH_IN = 13.333
SLIDE_HEIGHT_IN = 7.5

# Column geometry on a 595x842 A4 page (the sample PDF). The detector
# auto-classifies each question into left/right column by x coordinate,
# then crops up to the column edges. Values are PDF points.
COL_LEFT = (28.0, 295.0)   # right edge stops short of the center divider line
COL_RIGHT = (300.0, 568.0) # left edge clears the divider; right edge clears the page border
COL_TOP_PAD = 1.0           # points above the question label baseline (kept tight so
                            # the section header underline above Q1 doesn't bleed in)
COL_GAP_PAD = 4.0           # points above the *next* question's baseline

# Vertical content band on every page (PDF points). Above CONTENT_TOP sits the
# header (date / "JEE_DPP" / the "JEE" badge at y≈31–43). Below CONTENT_BOTTOM
# sits the "Master NCERT with PW Books APP" banner + book logo (y≈770–800) and
# the page-URL footer. These bound continuation slices so cross-column /
# cross-page question tails don't drag in page furniture.
CONTENT_TOP = 46.0
CONTENT_BOTTOM = 768.0

# White gap inserted between stacked segments of a multi-slice question (pixels).
SEGMENT_GAP_PX = 14

# Minimum height (PDF points) for a computed segment to be kept — below this
# it can't hold a real line of text, so it's noise (e.g. from a loosened
# content_top landing just above a tight next-question gap) rather than
# genuine continuation content.
MIN_SEGMENT_HEIGHT = 6.0

# Anything darker than this gray level counts as "ink" when computing the
# whitespace-trim bbox. Kept BELOW the faint "PW" page watermark (which renders
# at gray ≈242) so the watermark — which spans the middle of every column — does
# not expand the trim bbox and leave a tall blank band between stacked slices.
# Real text and figure strokes are far darker (≈0), so this still captures them.
# The watermark itself stays visible on the slide via _WHITE_THRESHOLD (250),
# which governs transparency separately.
INK_THRESHOLD = 230

# Maximum displayed dimensions on the slide (inches). Images are scaled
# down proportionally if they exceed either bound.
MAX_IMG_WIDTH_IN = 7.6
MAX_IMG_HEIGHT_IN = 6.6


# ---------------------------------------------------------------------------
# Question detection
# ---------------------------------------------------------------------------

QNUM_RE = re.compile(r"^(?:\d+\.|Q\d+)$")


@dataclass
class QuestionMark:
    qnum: int
    page: int       # 0-indexed
    column: str     # "L" or "R"
    x0: float
    y0: float

    def col_x_bounds(self) -> tuple[float, float]:
        return COL_LEFT if self.column == "L" else COL_RIGHT

    @property
    def slot(self) -> int:
        """Reading-order index of this question's column box across the whole
        document. The layout is column-major (left column top→bottom, then
        right column, then next page), so slots run:
        p0-L=0, p0-R=1, p1-L=2, p1-R=3, ... = page*2 + (0 if L else 1)."""
        return self.page * 2 + (0 if self.column == "L" else 1)


def _find_question_marks(doc: fitz.Document) -> List[QuestionMark]:
    """Locate every bold "N." span in the document and return them sorted
    by question number. Filters out unrelated numeric tokens (page numbers,
    options like "1." in the body) by requiring (a) bold font and (b) span
    text being *exactly* "N." with N in 1..999."""
    marks: list[QuestionMark] = []
    for pno, page in enumerate(doc):
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    text = (span["text"] or "").strip()
                    if not QNUM_RE.match(text):
                        continue
                    if "Bold" not in (span.get("font") or ""):
                        continue
                    n = int(text.lstrip("Q").rstrip("."))
                    if not 1 <= n <= 999:
                        continue
                    x0, y0, _x1, _y1 = span["bbox"]
                    column = "L" if x0 < (COL_LEFT[1] + COL_RIGHT[0]) / 2 else "R"
                    marks.append(QuestionMark(n, pno, column, x0, y0))
    # Dedupe by question number, keeping the FIRST occurrence in document
    # reading order. Question papers repeat the numbering in an answer-key /
    # solutions section on later pages; the real question always comes first,
    # so keeping the earliest slot drops the answer-key duplicates.
    marks.sort(key=lambda m: (m.slot, m.y0))
    seen: set[int] = set()
    out: list[QuestionMark] = []
    for m in marks:
        if m.qnum in seen:
            continue
        seen.add(m.qnum)
        out.append(m)
    # `out` is already in reading order (sorted by slot then y above).
    return out


@dataclass
class Segment:
    """One column-box slice of a question, in a single page's coordinate space."""
    page_index: int
    rect: fitz.Rect


def _slot_geometry(slot: int) -> tuple[int, str, float, float]:
    """Decompose a reading-order slot into (page_index, column, x0, x1)."""
    page_index = slot // 2
    column = "L" if slot % 2 == 0 else "R"
    x0, x1 = COL_LEFT if column == "L" else COL_RIGHT
    return page_index, column, x0, x1


# Text fragments that appear in the branded footer banner some PW-generated
# question PDFs ship ("Master NCERT with PW Books APP" + a book-icon image).
# Used as a fallback content-bottom clamp when the divider-line heuristic
# below doesn't find it (e.g. the footer sits close enough to CONTENT_BOTTOM
# that only a couple of points separate them on some page templates).
_FOOTER_TEXT_MARKERS = ("PW Books", "Master NCERT")

_content_band_cache: dict[tuple[int, int], tuple[float, float]] = {}


_INK_MARGIN = 6.0


def _detect_content_band(doc: fitz.Document, page_index: int) -> tuple[float, float]:
    """Per-page (top, bottom) content bounds, in PDF points.

    CONTENT_TOP/CONTENT_BOTTOM are tuned for PW/QBG-generated question papers
    (the AITS sample deck this pipeline shipped with, and QBG's own PDF
    export) — both carry a header divider, a footer banner ("PW Books"/
    "Master NCERT" + book logo), and a faint diagonal "PW" watermark at known
    heights, at/beyond which real content never runs.

    Manually-assembled decks (typed in Word, exported to PDF) usually carry
    NONE of that furniture, and their content can legitimately run closer to
    the true page edges than the hardcoded constants assume — e.g. a
    question's last option wrapping to a line that ends at y≈785 on a page
    whose default CONTENT_BOTTOM is 768, silently clipping that option's text
    (2026-07-18 bug: options were cut off or entirely missing on a footerless
    deck).

    So this function first checks for PW/QBG furniture (a header/footer
    divider bar, or the known footer banner text) using the ORIGINAL,
    unmodified detection+tightening logic. If ANY furniture is found on this
    page, that's a strong signal it's a PW/QBG-generated page — the band is
    resolved from furniture alone, exactly as before this fix, and the ink
    scan below is skipped entirely. This matters because a QBG page's own
    "PW" watermark is real PDF text (and/or an embedded image spanning much
    of the page) — scanning it as "ink" would loosen the band right back
    open despite genuine furniture being present, silently reintroducing the
    watermark/header/footer into crops on exactly the decks this band exists
    to protect.

    Only when NO furniture is found at all (the footerless/headerless,
    manually-assembled case) does it loosen the band out to the page's own
    real ink extent (text + images, plus a small margin), which is what
    actually fixed the 2026-07-18 clipping bug. A deck that matches the
    original AITS-sample assumptions renders byte-for-byte identically to
    before that fix; a QBG-generated deck (which always has this furniture)
    is unaffected by the ink-scan step altogether."""
    key = (id(doc), page_index)
    cached = _content_band_cache.get(key)
    if cached is not None:
        return cached

    page = doc[page_index]
    top = CONTENT_TOP
    bottom = CONTENT_BOTTOM
    page_h = page.rect.height
    page_w = page.rect.width
    found_furniture = False

    for d in page.get_drawings():
        r = d.get("rect")
        if r is None:
            continue
        if r.width < page_w * 0.6 or r.height >= 5:
            continue  # not a wide, thin divider bar
        mid_y = (r.y0 + r.y1) / 2
        if mid_y < page_h / 2:
            top = max(top, r.y1 + 2.0)
        else:
            bottom = min(bottom, r.y0 - 2.0)
        found_furniture = True

    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span.get("text") or ""
                if any(marker in text for marker in _FOOTER_TEXT_MARKERS):
                    bottom = min(bottom, span["bbox"][1] - 2.0)
                    found_furniture = True

    if not found_furniture:
        ink_top: float | None = None
        ink_bottom: float | None = None
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    if not (span.get("text") or "").strip():
                        continue
                    y0, y1 = span["bbox"][1], span["bbox"][3]
                    ink_top = y0 if ink_top is None else min(ink_top, y0)
                    ink_bottom = y1 if ink_bottom is None else max(ink_bottom, y1)
        for ib in page.get_image_info():
            bbox = ib.get("bbox")
            if not bbox:
                continue
            y0, y1 = bbox[1], bbox[3]
            ink_top = y0 if ink_top is None else min(ink_top, y0)
            ink_bottom = y1 if ink_bottom is None else max(ink_bottom, y1)

        if ink_top is not None:
            top = min(top, max(0.0, ink_top - _INK_MARGIN))
        if ink_bottom is not None:
            bottom = max(bottom, min(page_h, ink_bottom + _INK_MARGIN))

    result = (top, bottom)
    _content_band_cache[key] = result
    return result


def _question_segments(mark: QuestionMark,
                       ordered: List[QuestionMark],
                       idx: int,
                       doc: fitz.Document) -> List[Segment]:
    """Column-box slices that make up one question, in reading order.

    The layout is column-major, so a question's content flows from its label
    through consecutive column boxes (left→right within a page, then onto the
    next page) until the next question begins. We therefore crop:

      * the START slot from the label down to the bottom of the content band;
      * any INTERMEDIATE slots in full (content band top→bottom);
      * the END slot from the content-band top down to the next question's label.

    For same-slot consecutive questions this collapses to the historical single
    tight crop. The last question (no successor) is bounded to the remaining
    column boxes *on its own page* so it can't bleed into a following
    answer-key / solutions section."""
    start_slot = mark.slot
    nxt = ordered[idx + 1] if idx + 1 < len(ordered) else None
    end_slot = nxt.slot if nxt is not None else mark.page * 2 + 1
    # Last question (no successor): stay on its own page, spanning to the
    # right column if the question started on the left. Never cross into a
    # later page. end_y is only meaningful when nxt is not None (used below).
    end_y = nxt.y0 if nxt is not None else None

    segments: List[Segment] = []
    for slot in range(start_slot, end_slot + 1):
        page_index, _column, x0, x1 = _slot_geometry(slot)
        if page_index >= len(doc):
            break
        content_top, content_bottom = _detect_content_band(doc, page_index)
        top = (mark.y0 - COL_TOP_PAD) if slot == start_slot else content_top
        if slot == end_slot and nxt is not None:
            bottom = end_y - COL_GAP_PAD
        else:
            bottom = content_bottom
        if bottom - top < MIN_SEGMENT_HEIGHT:
            continue  # empty tail slice (e.g. next question sits at the very top) —
            # threshold is well under one real text line so genuine short
            # continuations still render, but a near-zero sliver (e.g. content_top
            # loosened by _detect_content_band's ink-margin landing just a couple
            # points above a tight next-question gap) doesn't add a stray blank
            # segment to the stack.
        page = doc[page_index]
        rect = fitz.Rect(x0, top, x1, bottom) & page.rect
        if rect.is_empty:
            continue
        segments.append(Segment(page_index, rect))
    return segments


# ---------------------------------------------------------------------------
# Rendering + whitespace trim
# ---------------------------------------------------------------------------

def _ink_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    """Bounding box of pixels darker than INK_THRESHOLD (the content), or None
    if the image is blank."""
    gray = img.convert("L")
    mask = gray.point(lambda v: 255 if v < INK_THRESHOLD else 0, mode="L")
    return mask.getbbox()


def _render_segment(page: fitz.Page, rect: fitz.Rect, dpi: int):
    """Render one column-box slice to a full-width PIL image (no cropping) and
    return it with a transform mapping PDF points → pixels in that image."""
    pix = page.get_pixmap(dpi=dpi, clip=rect, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    transform = {
        "rect_x0": rect.x0, "rect_y0": rect.y0,
        "scale": dpi / 72.0,
        "crop_x0": 0, "crop_y0": 0,
        "img_w": img.width, "img_h": img.height,
    }
    return img, transform


def _trim(img: Image.Image, dpi: int) -> tuple[Image.Image, int, int]:
    """Trim whitespace on all sides of the (possibly stacked) image. Returns the
    cropped image plus the (x, y) pixel offset that was removed from the top-left
    (so callers can re-base coordinates into the cropped image)."""
    bbox = _ink_bbox(img)
    if not bbox:
        return img, 0, 0
    pad = max(2, dpi // 40)
    x0 = max(0, bbox[0] - pad)
    y0 = max(0, bbox[1] - pad)
    x1 = min(img.width, bbox[2] + pad)
    y1 = min(img.height, bbox[3] + pad)
    return img.crop((x0, y0, x1, y1)), x0, y0


def _render_question_located(mark: QuestionMark, segments: List[Segment],
                             doc: fitz.Document, dpi: int):
    """Render every column-box slice of a question, erase the leading
    question-number on the first slice, vertically stack them with a small gap,
    and return ``(image, locator)``.

    ``locator`` is a dict carrying enough per-slice geometry for
    :func:`map_pdf_box` to translate any PDF-space box (on any slice's page)
    into pixel coordinates within the final stacked + trimmed image — used to
    place answer ticks on option markers."""
    slice_imgs: List[Image.Image] = []
    slices: list[dict] = []
    pad = max(2, dpi // 40)
    for i, seg in enumerate(segments):
        page = doc[seg.page_index]
        img, transform = _render_segment(page, seg.rect, dpi)
        if i == 0:
            # The "Qn"/"n." label only appears on the first slice.
            _erase_question_number(page, mark, img, transform)
        # Vertical-only trim, preserving full width for a consistent left margin.
        bbox = _ink_bbox(img)
        if bbox:
            vtop = max(0, bbox[1] - pad)
            vbot = min(img.height, bbox[3] + pad)
        else:
            vtop, vbot = 0, img.height
        slice_imgs.append(img.crop((0, vtop, img.width, vbot)))
        slices.append({"rect": seg.rect, "page_index": seg.page_index,
                       "transform": transform, "vtrim_top": vtop, "paste_y": 0})

    # Stack vertically, recording each slice's paste offset.
    if len(slice_imgs) == 1:
        stacked = slice_imgs[0]
    else:
        width = max(im.width for im in slice_imgs)
        height = (sum(im.height for im in slice_imgs)
                  + SEGMENT_GAP_PX * (len(slice_imgs) - 1))
        stacked = Image.new("RGB", (width, height), (255, 255, 255))
        y = 0
        for im, meta in zip(slice_imgs, slices):
            stacked.paste(im, (0, y))
            meta["paste_y"] = y
            y += im.height + SEGMENT_GAP_PX

    final, trim_x0, trim_y0 = _trim(stacked, dpi)
    locator = {"slices": slices, "trim_x0": trim_x0, "trim_y0": trim_y0}
    return final, locator


def _render_question(mark: QuestionMark, segments: List[Segment],
                     doc: fitz.Document, dpi: int) -> Image.Image:
    """Convenience wrapper returning just the rendered question image."""
    img, _locator = _render_question_located(mark, segments, doc, dpi)
    return img


def map_pdf_box_to_png(box: tuple[float, float, float, float],
                       transform: dict) -> tuple[int, int, int, int]:
    """Map a PDF-space box (x0, y0, x1, y1) in page points to pixel coords in a
    single rendered slice (before stacking/trimming), per its `transform`."""
    s = transform["scale"]
    rx0, ry0 = transform["rect_x0"], transform["rect_y0"]
    cx0, cy0 = transform["crop_x0"], transform["crop_y0"]
    x0 = (box[0] - rx0) * s - cx0
    y0 = (box[1] - ry0) * s - cy0
    x1 = (box[2] - rx0) * s - cx0
    y1 = (box[3] - ry0) * s - cy0
    return (int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1)))


def map_pdf_box(locator: dict, page_index: int,
                box: tuple[float, float, float, float]
                ) -> tuple[int, int, int, int] | None:
    """Translate a PDF-space box on `page_index` into pixel coordinates in the
    final stacked + trimmed question image described by `locator` (from
    :func:`_render_question_located`). Returns None if the box's centre doesn't
    fall inside any rendered slice."""
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    for sl in locator["slices"]:
        if sl["page_index"] != page_index:
            continue
        r = sl["rect"]
        if not (r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1):
            continue
        px0, py0, px1, py1 = map_pdf_box_to_png(box, sl["transform"])
        dx = -locator["trim_x0"]
        dy = sl["paste_y"] - sl["vtrim_top"] - locator["trim_y0"]
        return (px0 + dx, py0 + dy, px1 + dx, py1 + dy)
    return None


# ---------------------------------------------------------------------------
# PPTX assembly
# ---------------------------------------------------------------------------

# Branded "Full HD Video Solution Base Slide" background — same asset the video
# renderer composes on. Bundled PNG (pre-rendered from the source PDF).
_BASE_SLIDE_PNG = Path(__file__).with_name("assets") / "base_slide.png"

# Pixels at/above this luminance in the question crop are treated as background
# and made transparent so the base slide's PW watermark shows through behind it.
#
# Source question PDFs frequently carry their OWN faint centered "PW" logo
# watermark baked into the page background (gray ~242-243 — same band
# INK_THRESHOLD below is tuned to sit under). At the old threshold of 250
# those watermark pixels were NOT near-white enough to be made transparent,
# so they stayed opaque and were visible, duplicated, in the cropped question
# image — on top of the base slide's own single intentional watermark.
# Lowering this to sit just above INK_THRESHOLD sweeps the source watermark
# (and true whitespace) into "background", leaving only real ink opaque.
_WHITE_THRESHOLD = 235


def _white_to_transparent(img: Image.Image) -> Image.Image:
    """RGBA copy of `img` with near-white background made transparent (ink stays
    opaque), so it composites cleanly over the branded base slide."""
    rgba = img.convert("RGBA")
    alpha = img.convert("L").point(
        lambda v: 0 if v >= _WHITE_THRESHOLD else 255, mode="L"
    )
    rgba.putalpha(alpha)
    return rgba


def _add_base_background(slide, prs: Presentation) -> None:
    """Place the branded base slide as a full-bleed background on `slide`."""
    if not _BASE_SLIDE_PNG.exists():
        return
    slide.shapes.add_picture(
        str(_BASE_SLIDE_PNG),
        left=0, top=0,
        width=prs.slide_width, height=prs.slide_height,
    )


def _add_question_slide(prs: Presentation, image: Image.Image,
                        left_in: float, top_in: float,
                        max_width_in: float = MAX_IMG_WIDTH_IN,
                        max_height_in: float = MAX_IMG_HEIGHT_IN) -> None:
    blank_layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[-1]
    slide = prs.slides.add_slide(blank_layout)

    # Branded base slide first, so it sits behind the question.
    _add_base_background(slide, prs)

    # Display the image at native 96 DPI sizing (matches the sample deck's
    # scale), capped at max_width_in / max_height_in so very tall questions
    # still fit a 16:9 slide. Callers other than the default PDF pipeline
    # (e.g. docx_to_pptx, whose full-page-width crops need a bigger cap to
    # read at a comparable size) may override the caps.
    px_w, px_h = image.size
    native_w_in = px_w / 96.0
    native_h_in = px_h / 96.0
    scale = min(1.0, max_width_in / native_w_in, max_height_in / native_h_in)
    display_w_in = native_w_in * scale
    display_h_in = native_h_in * scale

    # Drop the white background so the base watermark shows through behind it.
    buf = io.BytesIO()
    _white_to_transparent(image).save(buf, format="PNG", optimize=True)
    buf.seek(0)

    slide.shapes.add_picture(
        buf,
        left=Inches(left_in),
        top=Inches(top_in),
        width=Inches(display_w_in),
        height=Inches(display_h_in),
    )


def _erase_question_number(page: fitz.Page, mark: QuestionMark,
                           img: Image.Image, transform: dict) -> None:
    """Paint over the bold 'N.' question-number marker in the rendered question
    image so slides show only the question (no number at the top-left)."""
    target = None
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                t = (span.get("text") or "").strip()
                if not QNUM_RE.match(t) or "Bold" not in (span.get("font") or ""):
                    continue
                bx0, by0, bx1, by1 = span["bbox"]
                if abs(bx0 - mark.x0) < 2 and abs(by0 - mark.y0) < 2:
                    target = (bx0, by0, bx1, by1)
                    break
            if target:
                break
        if target:
            break
    if not target:
        return
    x0, y0, x1, y1 = map_pdf_box_to_png(target, transform)
    pad = 3
    ImageDraw.Draw(img).rectangle(
        [max(0, x0 - pad), max(0, y0 - pad),
         min(img.width, x1 + pad), min(img.height, y1 + pad)],
        fill=(255, 255, 255),
    )


def convert(pdf_path: str | Path,
            pptx_path: str | Path,
            *,
            dpi: int = 200,
            image_left_in: float = 0.33,
            image_top_in: float = 0.40) -> dict:
    pdf_path = Path(pdf_path)
    pptx_path = Path(pptx_path)

    doc = fitz.open(pdf_path)
    # Per-page content-band cache is keyed by id(doc); CPython can reuse a
    # freed object's id, so start each conversion with a clean cache rather
    # than risk a stale entry from an earlier, already-closed document.
    _content_band_cache.clear()
    marks = _find_question_marks(doc)
    if not marks:
        raise ValueError(
            "No questions detected in the PDF. The detector looks for bold "
            "question labels like '1.' or 'Q1'. Check the PDF layout."
        )

    prs = Presentation()
    prs.slide_width = Inches(SLIDE_WIDTH_IN)
    prs.slide_height = Inches(SLIDE_HEIGHT_IN)

    for idx, mark in enumerate(marks):
        # A question may span several column boxes (left→right, across pages);
        # render each slice, stack them, and place the combined image.
        segments = _question_segments(mark, marks, idx, doc)
        if not segments:
            continue
        img = _render_question(mark, segments, doc, dpi=dpi)
        _add_question_slide(prs, img, image_left_in, image_top_in)

    prs.save(pptx_path)
    doc.close()

    return {
        "pdf": str(pdf_path),
        "pptx": str(pptx_path),
        "question_count": len(marks),
        "questions": [m.qnum for m in marks],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, json, sys

    ap = argparse.ArgumentParser(description="Convert a question PDF to a slide deck.")
    ap.add_argument("pdf", help="Source PDF path")
    ap.add_argument("pptx", help="Destination PPTX path")
    ap.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    args = ap.parse_args()

    report = convert(args.pdf, args.pptx, dpi=args.dpi)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
