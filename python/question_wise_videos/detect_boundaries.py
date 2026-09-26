# -*- coding: utf-8 -*-
"""
detect_boundaries
==================

Detects "the question changed" boundaries in a lecture-style recording,
using two classical (no LLM/vision-model) techniques, tried in order:

  PRIMARY — on-screen question-number OCR. Many lecture templates (this
  module was validated against real PW "paper discussion" recordings) print
  a fixed "N." label in the same on-screen corner for every question. OCR'ing
  that one small region once a second and tracking where the recognized
  number increases is both simpler and dramatically more reliable than
  inferring boundaries from overall visual similarity — see
  `_detect_questions_by_number()`'s docstring for the full story, including
  why a naive implementation isn't enough (occlusion, single-glyph OCR
  blind spots, misreads that must not desync the whole rest of the video).

  FALLBACK — visual-diff clustering, used when OCR finds no numbered slides
  at all (a different template, or tesseract isn't installed). Validated
  against a real 98-minute NEET paper-discussion recording (43 questions,
  presenter walking + pink-pen annotation + occasional flips to a blank
  scratch page mid-question):
    1. Extract frames at a low fps (default 1/s), downscaled, via ffmpeg.
    2. Estimate a "presenter/annotation-free" background at every sampled
       second using a rolling temporal MEDIAN over a short window — a person
       standing in one spot for a moment, or a pen stroke, doesn't survive a
       median over several nearby seconds, but a genuine slide swap does.
    3. Diff consecutive background estimates; timestamps with an unusually
       large jump are candidate boundaries, found via a robust-outlier
       threshold from the score distribution itself, not a fixed magic
       number.
    4. Build the resulting (typically over-split) segments and fingerprint
       each with the median frame over its OWN full range.
    5. Cluster segments — even NON-adjacent ones — whose fingerprints
       closely match into one question, absorbing blank-page detours and
       occlusion-caused over-splits.

Public API
----------
    detect_questions(video_path, out_dir, *, fps=1.0, width=320,
                      progress=lambda *_a: None) -> dict
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

_FFMPEG = "ffmpeg"

# Fraction-of-frame box (left, top, right, bottom) where the "N." question
# label sits, calibrated against a real 1280x720 PW recording (pixel box
# (30,128,200,188)) with extra margin on all sides for other resolutions/
# fonts and to comfortably fit 2-3 digit question numbers.
_OCR_CROP_BOX_FRAC = (0.015, 0.15, 0.20, 0.30)
_OCR_NUM_RE = re.compile(r"(\d{1,3})")

# --- Audio-silence end refinement ----------------------------------------
# A question's clip should end when the teacher stops discussing it, NOT when
# the next question's slide appears (the OCR boundary) — between the two is a
# silent gap (pause / slide switch / presenter out of frame) that shouldn't be
# in the clip. We find that gap with ffmpeg's silencedetect and end the
# question at the START of the trailing silence before the next question.
# Validated against a hand-labelled 45-question video: ~40/45 ends land within
# 5s of ground truth (median 1.6s). When the teacher talks continuously into
# the next slide (no detectable pause), the last silence is implausibly far
# back, so we clamp the end to `next_start - _SILENCE_END_GAP` instead.
_SILENCE_NOISE_DB = -30
_SILENCE_MIN_DUR = 1.0
_SILENCE_CLAMP_MAX = 25.0   # if the trailing silence is >this before the next question, ignore it
_SILENCE_END_GAP = 3.0      # fallback gap when no plausible trailing silence exists
_SILENCE_START_RE = re.compile(r"silence_start:\s*([\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([\d.]+)")


@dataclass
class Segment:
    start: float
    end: float


def _video_duration_sec(video_path: str | Path) -> float:
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    return float(frame_count / fps) if fps else 0.0


def _video_dimensions(video_path: str | Path) -> tuple[int, int]:
    cap = cv2.VideoCapture(str(video_path))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return w, h


def _resolve_tesseract() -> bool:
    """Points pytesseract at a real tesseract binary if one can be found.
    Returns False (caller falls back to visual-diff detection) if pytesseract
    isn't installed or no tesseract binary is found — this whole detection
    path is optional, never a hard requirement."""
    try:
        import pytesseract
    except ImportError:
        return False
    cmd = os.environ.get("TESSERACT_CMD")
    if not cmd:
        default_win = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
        if os.name == "nt" and os.path.exists(default_win):
            cmd = default_win
        elif shutil.which("tesseract"):
            cmd = "tesseract"
    if not cmd:
        return False
    pytesseract.pytesseract.tesseract_cmd = cmd
    return True


def _extract_corner_crops(video_path: Path, out_dir: Path, *, width: int, height: int,
                          box_frac: tuple[float, float, float, float]) -> list[Path]:
    """One tiny JPG per second of just the question-number corner (not the
    full frame) — cheap enough (~1 min for a 100-min video) to always try
    before committing to the full visual-diff pipeline."""
    x1 = int(width * box_frac[0])
    y1 = int(height * box_frac[1])
    crop_w = max(1, int(width * box_frac[2]) - x1)
    crop_h = max(1, int(height * box_frac[3]) - y1)
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "n_%06d.jpg")
    cmd = [
        _FFMPEG, "-y", "-i", str(video_path),
        "-vf", f"fps=1,crop={crop_w}:{crop_h}:{x1}:{y1}",
        pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg corner-crop extraction failed: {proc.stderr[-2000:]}")
    return sorted(out_dir.glob("n_*.jpg"))


def _ocr_number_readings(crop_files: list[Path], *,
                         upscale: int = 3, gap: int = 6,
                         max_composite_height: int = 16000) -> dict[int, int]:
    """Returns {second_index: recognized_leading_integer}.

    Spawning Tesseract once per frame is the actual bottleneck (~0.18s/call
    of fixed process-startup overhead — ~19 minutes for a 100-minute video
    at 1fps) — not OCR itself. Instead, many crops are tiled into one tall
    composite image per Tesseract call (far fewer subprocess spawns), and
    `image_to_data`'s per-word bounding boxes are used to map each detection
    back to its source cell by vertical position — NOT by output line index,
    since Tesseract silently drops blank lines (a page with no visible
    number), which would desync a line-count-based mapping.

    Tesseract also rejects an image taller than ~32K px outright ("Image too
    large"), so the number of crops per composite (`chunk_size`) is derived
    from `max_composite_height` rather than fixed — the corner-crop's own
    height (which scales with the source video's resolution) determines how
    many cells fit per batch."""
    import pytesseract
    from pytesseract import Output
    from PIL import Image, ImageOps

    if not crop_files:
        return {}
    first = Image.open(crop_files[0])
    cell_w, cell_h = first.width * upscale, first.height * upscale
    stride = cell_h + gap
    chunk_size = max(1, max_composite_height // stride)

    raw: dict[int, list[str]] = {}
    for start in range(0, len(crop_files), chunk_size):
        batch = crop_files[start:start + chunk_size]
        composite = Image.new("L", (cell_w, stride * len(batch)), color=0)
        for i, f in enumerate(batch):
            im = ImageOps.grayscale(Image.open(f)).resize((cell_w, cell_h))
            composite.paste(im, (0, i * stride))
        data = pytesseract.image_to_data(
            composite, config="--psm 6 -c tessedit_char_whitelist=0123456789.",
            output_type=Output.DICT,
        )
        for txt, top, height in zip(data["text"], data["top"], data["height"]):
            txt = txt.strip()
            if not txt:
                continue
            cell_idx = int((top + height / 2) // stride)
            if 0 <= cell_idx < len(batch):
                raw.setdefault(start + cell_idx, []).append(txt)

    parsed: dict[int, int] = {}
    for idx, parts in raw.items():
        m = _OCR_NUM_RE.search("".join(parts))
        if m:
            parsed[idx] = int(m.group(1))
    return parsed


# --- High-accuracy path: OCR each crop on its own -------------------------
# The batched/tiled reader above is fast (~100x fewer Tesseract spawns) but
# loses per-row accuracy when a crop contains extra text besides the number
# (e.g. "50. A 92% w/w"): stacked with its neighbours under psm 6, Tesseract
# sometimes reads the embedded "92" or drops the row entirely. OCR'ing one
# crop at a time with psm 7 (single line) reads those correctly — validated
# where the batched path lost questions 49-56 of a 42-question video. The
# cost is one subprocess per crop (~0.15s), so the individual scan samples
# at a `stride` (capped to ~a few thousand OCR calls total) and then refines
# only the detected boundaries down to 1-second precision.

_OCR_MAX_INDIVIDUAL_CALLS = 3500


def _ocr_single_number(crop_file: Path, *, upscale: int = 3) -> int | None:
    import pytesseract
    from PIL import Image, ImageOps

    im = ImageOps.grayscale(Image.open(crop_file))
    im = im.resize((im.width * upscale, im.height * upscale))
    # psm 6 ("uniform block"), NOT psm 7 ("single line") — the corner crop can
    # wrap onto a second line, and psm 7 reads almost nothing there (measured
    # 8% vs 99% coverage on a real 3-hour video). The leading "N." is still
    # the first digit group, so _OCR_NUM_RE picks it out.
    txt = pytesseract.image_to_string(
        im, config="--psm 6 -c tessedit_char_whitelist=0123456789."
    )
    m = _OCR_NUM_RE.search(txt)
    return int(m.group(1)) if m else None


def _ocr_number_readings_individual(crop_files: list[Path], stride: int, *,
                                    progress) -> dict[int, int]:
    """Scan crops at `stride`, OCR'ing each one on its own. Returns
    {second_index: number} for the scanned indices only (boundaries are
    refined to 1s afterwards by _refine_boundary)."""
    readings: dict[int, int] = {}
    scanned = 0
    for idx in range(0, len(crop_files), stride):
        num = _ocr_single_number(crop_files[idx])
        if num is not None:
            readings[idx] = num
        scanned += 1
        if scanned % 500 == 0:
            progress(f"  scanned {scanned} frame(s)...")
    return readings


def _refine_boundary(crop_files: list[Path], approx_idx: int, num: int, stride: int) -> int:
    """`approx_idx` is the first STRIDED sample that read `num`; the real
    first appearance is somewhere in the `stride` seconds before it. OCR
    those individual crops and return the earliest that reads `num`."""
    lo = max(0, approx_idx - stride + 1)
    for j in range(lo, approx_idx + 1):
        if _ocr_single_number(crop_files[j]) == num:
            return j
    return approx_idx


def _debounce_sequential(readings: dict[int, int], *, min_confirms: int = 3) -> list[tuple[float, int]]:
    """`readings` is {second_index: recognized_number}. Returns the real
    question sequence as [(start_second, number), ...] with monotonically
    increasing start times.

    Question numbers only ever go UP over a paper discussion and each is on
    screen for many contiguous seconds, so the real sequence is the longest
    run of DISTINCT values whose value increases in lock-step with time.
    We therefore:
      1. keep only values read at least `min_confirms` times (kills one-off
         misreads),
      2. order the kept values by their MEDIAN read time (robust to a few
         scattered misreads of the same value), and
      3. take the longest strictly-increasing-value subsequence of that
         time-ordered list.

    This is what makes the detector robust to OCR dropping a digit off a
    2-digit number: e.g. "47"/"57" occasionally misread as "7" produces a
    spurious value 7 with real support, scattered across the video. The
    OLDER "smallest value > current with support" rule would lock onto that
    7 (it's smaller than the real 50s on screen at the time) and its late
    timestamps would then exclude the genuine 46-56 readings — collapsing a
    whole run of questions. Measured on a real 45-question (numbers 46-90)
    3-hour recording: the old rule returned 37 with a 7->57 jump that
    swallowed nine questions; this LIS rule returns a clean 46-90. Because
    the longest increasing subsequence of a clean, gap-free video IS just
    that video's full sequence, this never does worse than the old rule on
    videos that already worked; it only rejects out-of-order noise.

    A number the OCR never reads >= min_confirms times is simply absent from
    the run (one merged boundary, fixable with one click in the review UI) —
    never a desync of everything after it."""
    from collections import defaultdict

    times_by_value: dict[int, list[int]] = defaultdict(list)
    for t, v in readings.items():
        times_by_value[v].append(t)

    # (median_time, value, earliest_time) for every well-supported value.
    candidates: list[tuple[int, int, int]] = []
    for v, ts in times_by_value.items():
        if len(ts) >= min_confirms:
            ts_sorted = sorted(ts)
            candidates.append((ts_sorted[len(ts_sorted) // 2], v, ts_sorted[0]))
    candidates.sort()  # by median time
    n = len(candidates)
    if n == 0:
        return []

    values = [c[1] for c in candidates]
    length = [1] * n
    prev = [-1] * n
    for i in range(n):
        for j in range(i):
            if values[j] < values[i] and length[j] + 1 > length[i]:
                length[i] = length[j] + 1
                prev[i] = j
    end = max(range(n), key=lambda i: length[i])

    chain: list[tuple[int, int, int]] = []
    while end != -1:
        chain.append(candidates[end])
        end = prev[end]
    chain.reverse()

    confirmed: list[tuple[float, int]] = []
    last_t = -1
    for median_t, value, _earliest_t in chain:
        # Boundary = the EARLIEST read of this value that comes after the
        # previous boundary. Using the earliest read overall would misplace a
        # value that has a stray early misread far before its real on-screen
        # block (observed: it packs a whole run of questions 1 second apart);
        # constraining to reads after the previous boundary skips that stray
        # and lands on the value's real first appearance.
        later = [t for t in times_by_value[value] if t > last_t]
        start = min(later) if later else max(int(median_t), last_t + 1)
        confirmed.append((float(start), value))
        last_t = int(start)
    return confirmed


_OCR_MIN_COVERAGE = 0.25


def _detect_questions_by_number(video_path: Path, out_dir: Path, duration: float, *,
                                progress, accuracy: str = "fast") -> list[Segment] | None:
    """Primary detection path. Returns None (caller falls back to the
    visual-diff method) if tesseract isn't available, the corner region
    isn't a real numbered-slide label, or no numbers were ever confirmed.

    `accuracy`:
      "fast" — one tiled Tesseract call per ~a hundred crops (default).
      "high" — one Tesseract call per crop (strided + refined). Much slower,
               but reads dense 2-digit numbers the batched path can miss."""
    if not _resolve_tesseract():
        progress("Tesseract OCR not found — skipping numbered-slide detection.")
        return None
    width, height = _video_dimensions(video_path)
    if not width or not height:
        return None
    progress("Extracting question-number corner crops...")
    crop_files = _extract_corner_crops(
        video_path, out_dir / "number_crops", width=width, height=height, box_frac=_OCR_CROP_BOX_FRAC
    )
    if not crop_files:
        return None

    stride = 1
    if accuracy == "high":
        stride = max(1, math.ceil(len(crop_files) / _OCR_MAX_INDIVIDUAL_CALLS))
        progress(
            f"Reading question numbers (high accuracy) from {len(crop_files)} sampled "
            f"second(s), every {stride}s..."
        )
        readings = _ocr_number_readings_individual(crop_files, stride, progress=progress)
    else:
        progress(f"Reading question numbers from {len(crop_files)} sampled second(s)...")
        readings = _ocr_number_readings(crop_files)

    # A genuine numbered-slide template's label is visible most of the time
    # (minus brief occlusion) — validated at 87.8% coverage on a real PW
    # recording. A template with NO number in that corner still produces
    # occasional digit-shaped false reads from unrelated on-screen text
    # (branding, equations) over a long video, but only sparsely — 7.9%
    # coverage on a real 98-minute video with no corner label, incidentally
    # producing enough repeats of small numbers (a monotonic "1,2,4,7" by
    # coincidence) to slip past `_debounce_sequential`'s occurrence-count
    # check alone. This coverage gate — checked BEFORE even attempting
    # confirmation — is what actually separates the two cases; requiring
    # more occurrences per number would not, since the noise case's most
    # frequent misread ("1") alone occurred 240 times over the video.
    sampled_count = len(range(0, len(crop_files), stride))
    coverage = len(readings) / max(1, sampled_count)
    if coverage < _OCR_MIN_COVERAGE:
        progress(
            f"Corner region rarely shows a number ({coverage:.0%} of sampled seconds) — "
            "not a numbered-slide template. Falling back to visual-diff detection."
        )
        return None

    confirmed = _debounce_sequential(readings)
    if not confirmed:
        progress("No numbered slides detected — falling back to visual-diff detection.")
        return None

    # In high-accuracy mode the confirmed times land on STRIDED samples; pull
    # each boundary back to the exact second the new number first appears.
    if accuracy == "high" and stride > 1:
        progress("Refining boundary timestamps...")
        refined: list[tuple[float, int]] = []
        for t, num in confirmed:
            refined.append((float(_refine_boundary(crop_files, int(t), num, stride)), num))
        confirmed = refined

    progress(f"Found {len(confirmed)} numbered question(s) via on-screen label OCR.")
    segments: list[Segment] = []
    for i, (t, _num) in enumerate(confirmed):
        end = confirmed[i + 1][0] if i + 1 < len(confirmed) else duration
        segments.append(Segment(start=t, end=end))
    return segments


def _extract_frames(video_path: Path, out_dir: Path, *, fps: float, width: int) -> list[Path]:
    """One color JPG per sampled second via ffmpeg's fps filter (frame i,
    1-indexed in the filename, corresponds to timestamp (i-1)/fps — ffmpeg
    samples uniformly starting at t=0). Much faster and more reliable across
    codecs than seeking frame-by-frame with OpenCV."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "f_%06d.jpg")
    cmd = [
        _FFMPEG, "-y", "-i", str(video_path),
        "-vf", f"fps={fps},scale={width}:-2",
        "-q:v", "4",
        pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed: {proc.stderr[-2000:]}")
    return sorted(out_dir.glob("f_*.jpg"))


def _mad_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a.astype(np.int16) - b.astype(np.int16))))


def _rolling_background(frames: np.ndarray, window: int) -> np.ndarray:
    """frames: (N,H,W) uint8. Returns (N,H,W) uint8 — the median over a
    window of `window` frames centered at each index (truncated at the
    video's edges)."""
    n = frames.shape[0]
    half = window // 2
    out = np.empty_like(frames)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out[i] = np.median(frames[lo:hi], axis=0).astype(np.uint8)
    return out


def _find_candidates(timestamps: list[float], bg: np.ndarray, *,
                     min_gap_sec: float = 2.0) -> list[float]:
    """Robust-outlier boundary detection: a candidate is a timestamp whose
    background-estimate diff from the previous one sits well above the
    "noise floor" formed by ordinary presenter motion — found from the
    score distribution's own median + a multiple of its median absolute
    deviation, not a fixed threshold."""
    scores = np.array([_mad_diff(bg[i], bg[i + 1]) for i in range(len(bg) - 1)])
    if len(scores) == 0:
        return [0.0]
    median = float(np.median(scores))
    mad = float(np.median(np.abs(scores - median))) + 1e-6
    threshold = median + 6 * mad

    candidates = [0.0]
    last = 0.0
    for i, s in enumerate(scores):
        t = timestamps[i + 1]
        if s > threshold and (t - last) >= min_gap_sec:
            candidates.append(t)
            last = t
    return candidates


def _build_segments(candidates: list[float], duration: float) -> list[Segment]:
    bounds = candidates + [duration]
    return [Segment(start=bounds[i], end=bounds[i + 1]) for i in range(len(bounds) - 1)
            if bounds[i + 1] > bounds[i]]


def _segment_frame_indices(timestamps: list[float], seg: Segment) -> list[int]:
    idx = [i for i, t in enumerate(timestamps) if seg.start <= t < seg.end]
    if idx:
        return idx
    # Degenerate (very short) segment — fall back to the single nearest frame.
    nearest = min(range(len(timestamps)), key=lambda i: abs(timestamps[i] - seg.start))
    return [nearest]


def _fingerprint(frames: np.ndarray, idx: list[int]) -> np.ndarray:
    """Median frame over a segment's own full range — the whole point of
    computing this per-segment (not per-window) is that once a segment
    spans many seconds, a presenter who's rarely in the same place twice
    gets fully median'd away, revealing the true static slide even under
    minutes of occlusion."""
    return np.median(frames[idx], axis=0).astype(np.uint8)


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    """Normalized cross-correlation (Pearson correlation of the flattened
    pixel arrays) — the same metric used to validate merges by hand on the
    reference video, where genuine duplicates scored 0.86-0.98 and every
    other pair scored <= 0.53: a wide, reliable gap despite every slide
    sharing an identical header/option-layout template, because the actual
    question text dominates the correlation once computed over the whole
    frame."""
    fa = a.astype(np.float64).ravel()
    fb = b.astype(np.float64).ravel()
    fa = fa - fa.mean()
    fb = fb - fb.mean()
    denom = np.sqrt((fa ** 2).sum() * (fb ** 2).sum())
    if denom < 1e-9:
        return 1.0
    return float((fa * fb).sum() / denom)


def _cluster_segments(segments: list[Segment], fingerprints: list[np.ndarray], *,
                      sim_threshold: float = 0.8, lookahead_sec: float = 240.0) -> list[Segment]:
    """Union-find over "segment i and a LATER segment j look the same" pairs
    (not just adjacent ones): when two non-adjacent segments match, every
    segment between them — including a blank scratch page whose own
    fingerprint matches neither — is unioned into the same group, since it
    must belong to the same question.

    `lookahead_sec` bounds how far apart (in time, not index count) two
    segments may be and still bridge-merge — deliberately tight (4 minutes,
    matching the longest occlusion the technique has actually been
    validated against) rather than generous, because the "union everything
    between i and j" rule means a single false-positive match at long range
    doesn't just misjoin two segments, it silently swallows every real
    question boundary in between. A borderline coincidental match between
    two genuinely different questions ~9.5 minutes apart (score 0.808, just
    over threshold) did exactly this during validation before the bound was
    tightened from an initial 600s. Legitimate same-question matches (an
    occlusion-fragmented question, or a brief blank-page detour) still
    connect transitively through a chain of short hops even when no single
    pair spans the full range — only a long, ungrounded single jump is
    rejected."""
    n = len(segments)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    for i in range(n):
        for j in range(i + 1, n):
            gap = segments[j].start - segments[i].end
            if gap > lookahead_sec:
                break
            if _ncc(fingerprints[i], fingerprints[j]) >= sim_threshold:
                for k in range(i, j):
                    union(k, k + 1)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    merged: list[Segment] = []
    for root in sorted(groups):
        member_idx = groups[root]
        merged.append(Segment(start=segments[member_idx[0]].start, end=segments[member_idx[-1]].end))
    return merged


def _detect_silences(video_path: Path) -> list[tuple[float, float]]:
    """Returns [(silence_start, silence_end), ...] over the whole audio via
    ffmpeg's silencedetect. A missing trailing end (silence runs to EOF) is
    returned as (start, inf)."""
    cmd = [
        _FFMPEG, "-nostats", "-i", str(video_path),
        "-af", f"silencedetect=noise={_SILENCE_NOISE_DB}dB:d={_SILENCE_MIN_DUR}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = proc.stderr or ""
    starts = [float(x) for x in _SILENCE_START_RE.findall(out)]
    ends = [float(x) for x in _SILENCE_END_RE.findall(out)]
    silences: list[tuple[float, float]] = []
    for i, s in enumerate(starts):
        silences.append((s, ends[i] if i < len(ends) else float("inf")))
    return silences


def _refine_ends_by_silence(segments: list[Segment], silences: list[tuple[float, float]],
                            duration: float) -> list[Segment]:
    """End each question at the START of the trailing silence before the next
    question begins (so the silent gap isn't in the clip). If the nearest such
    silence is implausibly far back (> _SILENCE_CLAMP_MAX — the teacher talked
    continuously into the next slide), the real gap is short, so end at
    next_start - _SILENCE_END_GAP instead."""
    refined: list[Segment] = []
    for i, seg in enumerate(segments):
        next_start = segments[i + 1].start if i + 1 < len(segments) else duration
        # the latest silence that begins after this question's start and before
        # the next question begins — i.e. the trailing transition gap.
        best: float | None = None
        for s, _e in silences:
            if seg.start < s < next_start and (best is None or s > best):
                best = s
        if best is None or (next_start - best) > _SILENCE_CLAMP_MAX:
            end = next_start - _SILENCE_END_GAP
        else:
            end = best
        end = max(seg.start + 1.0, min(end, next_start))
        refined.append(Segment(start=seg.start, end=end))
    return refined


def detect_questions(video_path: str | Path, out_dir: str | Path, *,
                     fps: float = 1.0, width: int = 320, accuracy: str = "fast",
                     refine_ends: bool = True,
                     progress=lambda *_a: None) -> dict:
    """Returns {videoDurationSec, questions: [{index,startSec,endSec,thumb}],
    thumbDir}. `thumb` is an absolute path to a representative (presenter-
    removed) JPG for that question, written under `out_dir/thumbs/`.

    `accuracy`: "fast" (default, batched OCR) or "high" (per-crop OCR — much
    slower but reads dense 2-digit question numbers the batched path can
    miss). Only affects the numbered-slide path; the visual-diff fallback is
    unchanged.

    `refine_ends`: when True (default), each question's `endSec` is pulled
    back to the end of the teacher's speech (the trailing silence before the
    next question) so the silent gap between questions isn't included. When
    False, `endSec` is the next question's start (contiguous)."""
    video_path = Path(video_path)
    out_dir = Path(out_dir)
    frames_dir = out_dir / "frames"
    thumb_dir = out_dir / "thumbs"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    duration = _video_duration_sec(video_path)
    progress(f"Video duration: {duration:.0f}s")
    if duration <= 0:
        raise ValueError("Could not read video duration — is this a valid video file?")

    merged = _detect_questions_by_number(video_path, out_dir, duration, progress=progress, accuracy=accuracy)

    progress("Extracting frames...")
    frame_files = _extract_frames(video_path, frames_dir, fps=fps, width=width)
    if not frame_files:
        raise ValueError("ffmpeg produced no frames — is this a valid video file?")
    timestamps = [i / fps for i in range(len(frame_files))]

    progress(f"Loading {len(frame_files)} sampled frame(s)...")
    frames = np.stack([cv2.imread(str(f), cv2.IMREAD_GRAYSCALE) for f in frame_files])

    if merged is None:
        progress("Estimating presenter/annotation-free background...")
        bg = _rolling_background(frames, window=5)

        progress("Finding candidate boundaries...")
        candidates = _find_candidates(timestamps, bg)
        progress(f"{len(candidates)} candidate segment(s) before clustering")

        segments = _build_segments(candidates, duration)
        fingerprints = [_fingerprint(frames, _segment_frame_indices(timestamps, seg)) for seg in segments]

        progress("Clustering near-duplicate segments (blank pages / occlusion splits)...")
        merged = _cluster_segments(segments, fingerprints)
        progress(f"{len(merged)} question(s) after clustering")

    if refine_ends and merged:
        progress("Refining end times (trimming the silent gap before each next question)...")
        try:
            silences = _detect_silences(video_path)
            merged = _refine_ends_by_silence(merged, silences, duration)
        except Exception as _e:
            progress(f"(End refinement skipped: {_e})")

    progress("Writing thumbnails...")
    questions = []
    for i, seg in enumerate(merged, 1):
        idx = _segment_frame_indices(timestamps, seg)
        color_imgs = [cv2.imread(str(frame_files[j])) for j in idx]
        color_imgs = [im for im in color_imgs if im is not None]
        if color_imgs:
            thumb = np.median(np.stack(color_imgs), axis=0).astype(np.uint8)
        else:
            thumb = cv2.imread(str(frame_files[idx[0]]))
        thumb_path = thumb_dir / f"q{i:03d}.jpg"
        cv2.imwrite(str(thumb_path), thumb)
        questions.append({
            "index": i,
            "startSec": round(seg.start, 2),
            "endSec": round(seg.end, 2),
            "thumb": str(thumb_path),
        })

    return {
        "videoDurationSec": round(duration, 2),
        "questions": questions,
        "thumbDir": str(thumb_dir),
    }


if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(description="Detect per-question boundaries in a lecture video.")
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--width", type=int, default=320)
    ap.add_argument("--accuracy", choices=["fast", "high"], default="fast")
    args = ap.parse_args()

    def _progress(msg: str) -> None:
        print(msg, file=sys.stderr)

    result = detect_questions(
        args.video, args.out_dir, fps=args.fps, width=args.width, accuracy=args.accuracy, progress=_progress
    )
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
