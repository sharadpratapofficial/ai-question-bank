"""
solutions_parser
================

Parse an AITS-style "Hints and Solution" PDF and produce, for each question:

  * the rendered solution image (the right-hand-side panel in the video)
  * the final answer (e.g. "(2)", "(360)") from the answer-key page
  * the raw text dump (used as additional grounding for the LLM narrator)

The first page is usually an "ANSWER KEY" — just numbered answers in 2 columns.
Subsequent pages are the detailed solutions, formatted exactly like the
question paper (bold "N." markers, 2 columns).

Public API
----------
    parse_solutions(pdf_path, out_dir, *, dpi=180) -> dict[int, ParsedSolution]
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import fitz

from pdf_to_pptx import (
    COL_LEFT, COL_RIGHT, QNUM_RE,
    QuestionMark, _question_segments, _render_question,
)


def _scan_question_marks(doc: fitz.Document,
                         skip_pages: set[int]) -> list[QuestionMark]:
    """Like pdf_to_pptx._find_question_marks but lets us exclude pages
    (e.g. the answer-key page) before deduping, so that a label in the
    answer key doesn't shadow the real solution's marker. Matches both
    "N." and "QN" labels (shared QNUM_RE) and returns marks in reading order."""
    marks: list[QuestionMark] = []
    for pno, page in enumerate(doc):
        if pno in skip_pages:
            continue
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
    # Dedupe by qnum, keeping the earliest in reading order. Leave the result in
    # reading order (slot, y) — the segment model bounds each question by the
    # next mark in reading order, not by question number.
    marks.sort(key=lambda m: (m.slot, m.y0))
    seen: set[int] = set()
    out: list[QuestionMark] = []
    for m in marks:
        if m.qnum in seen:
            continue
        seen.add(m.qnum)
        out.append(m)
    return out


ANSWER_RE = re.compile(r"^\(([^)]+)\)$")


@dataclass
class ParsedSolution:
    qnum: int
    answer: str | None
    image_path: Path
    raw_text: str  # PDF-extracted text from the solution region (may be noisy)


def _parse_answer_key(page: fitz.Page) -> dict[int, str]:
    """Scan a page that looks like an answer key — pairs of 'N.' and '(X)' —
    and return {qnum: answer_text}. Tolerant of missing pairs."""
    # Collect every short span: "N." or "(X)" with their positions.
    spans = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                t = (span["text"] or "").strip()
                if not t:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                spans.append((y0, x0, t))

    spans.sort()
    answers: dict[int, str] = {}
    # Pair up: a "N." followed (rightward, same line) by "(X)".
    i = 0
    while i < len(spans):
        y0, x0, t = spans[i]
        m = re.match(r"^(\d+)\.$", t)
        if not m:
            i += 1
            continue
        n = int(m.group(1))
        # Look ahead for the (...) on the same line.
        for j in range(i + 1, min(i + 6, len(spans))):
            yj, xj, tj = spans[j]
            if abs(yj - y0) > 4:
                break
            am = ANSWER_RE.match(tj)
            if am:
                answers[n] = am.group(1).strip()
                break
        i += 1
    return answers


def _extract_raw_text(doc: fitz.Document, segments) -> str:
    """Plain-text extraction across all of a solution's column-box slices. Math
    symbols may be lost (private PDF font glyphs), so this output is best used as
    *grounding hints* for the LLM, not as the narration itself."""
    cleaned: list[str] = []
    for seg in segments:
        text = doc[seg.page_index].get_text("text", clip=seg.rect)
        for line in text.splitlines():
            s = "".join(ch for ch in line if ch == "\n" or ch.isprintable())
            s = re.sub(r"\s+", " ", s).strip()
            if s:
                cleaned.append(s)
    return "\n".join(cleaned)


def parse_solutions(pdf_path: str | Path,
                    out_dir: str | Path,
                    *,
                    dpi: int = 180) -> dict[int, ParsedSolution]:
    """Render each question's solution panel to out_dir, return parsed data.

    Heuristics:
      * If the first page contains ~25 short "N. (X)" pairs and no real
        solution body, treat it as the answer key.
      * Question markers in remaining pages are detected using the same
        bold-"N." finder we use for the question PDF.
    """
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    if doc.page_count == 0:
        raise ValueError("Solutions PDF has no pages.")

    # --- Answer key (page 1 if it looks like one) ---
    answers: dict[int, str] = {}
    answer_page_idx = -1
    first_page_text = doc[0].get_text("text").upper()
    if "ANSWER KEY" in first_page_text or "ANSWER" in first_page_text[:300]:
        answers = _parse_answer_key(doc[0])
        answer_page_idx = 0

    # --- Detailed solutions on remaining pages ---
    skip = {answer_page_idx} if answer_page_idx >= 0 else set()
    detail_marks = _scan_question_marks(doc, skip_pages=skip)

    if not detail_marks:
        # Fall back: maybe the whole thing IS the answer key. Synthesize
        # empty solutions so the video pipeline still has *something*.
        result: dict[int, ParsedSolution] = {}
        for q, ans in answers.items():
            result[q] = ParsedSolution(
                qnum=q,
                answer=ans,
                image_path=Path(""),     # caller checks .exists()
                raw_text="",
            )
        return result

    result: dict[int, ParsedSolution] = {}
    for idx, mark in enumerate(detail_marks):
        # A solution may flow across columns / pages — render every slice.
        segments = _question_segments(mark, detail_marks, idx, doc)
        if not segments:
            continue
        img = _render_question(mark, segments, doc, dpi=dpi)
        img_path = out_dir / f"sol_q{mark.qnum:03d}.png"
        img.save(img_path)
        raw = _extract_raw_text(doc, segments)
        result[mark.qnum] = ParsedSolution(
            qnum=mark.qnum,
            answer=answers.get(mark.qnum),
            image_path=img_path,
            raw_text=raw,
        )

    # Make sure every key from the answer-key page is at least represented.
    for q, ans in answers.items():
        if q not in result:
            result[q] = ParsedSolution(
                qnum=q, answer=ans,
                image_path=Path(""), raw_text="",
            )

    doc.close()
    return result


if __name__ == "__main__":
    import argparse, json, sys
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out_dir")
    args = ap.parse_args()
    out = parse_solutions(args.pdf, args.out_dir)
    summary = {
        q: {
            "answer": s.answer,
            "image": str(s.image_path),
            "raw_len": len(s.raw_text),
        } for q, s in sorted(out.items())
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
