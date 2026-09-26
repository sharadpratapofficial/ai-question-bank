"""
video_builder
=============

Build per-question MP4 solution videos from:

  * the question image (cropped earlier by `pdf_to_pptx`)
  * a structured solution: a list of "steps" — each step is a short
    narratable chunk of text/math that we reveal on screen and speak
    via Edge TTS.

Each video is 1280x720 @ 30 fps, H.264 + AAC, matching the original AITS
sample videos in style:

  +-----------------------------------------+
  |  [question image]   |  step 1 ...      |
  |                     |  step 2 ...      |
  |                     |  step 3 ...      |
  |       (PW watermark behind)             |
  +-----------------------------------------+

For each step we render the right-hand panel showing all steps revealed
*so far*, generate TTS narration, and produce a still-image segment whose
duration equals the narration audio. Segments are concatenated into the
final MP4 with ffmpeg.

Public API
----------
    build_video(question_image, steps, out_path, *, voice="en-IN-PrabhatNeural")
    build_videos_for_quiz(questions_dir, solutions, out_dir, *, name_prefix)
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import edge_tts
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFilter, ImageFont


# ---------------------------------------------------------------------------
# Visual constants
# ---------------------------------------------------------------------------
VIDEO_W = 1280
VIDEO_H = 720
FPS = 30

LEFT_PANE_W = 640          # question image lives here
RIGHT_PANE_W = VIDEO_W - LEFT_PANE_W
PANE_PAD = 24

# Top-align the question (and start the solution at the same height) instead of
# vertically centring the question. The base slide has a lot of empty space up
# top; pinning both columns near the top reclaims it and keeps the first line of
# the solution level with the top of the question, like a real worked page.
CONTENT_TOP = PANE_PAD

# Adaptive solution placement. The question sits in the LEFT half. If the
# question is short enough to leave room beneath it, the solution STARTS in the
# space below the question (left half) and only overflows into the right half —
# using the page the way a person would. If the question is tall (little/no room
# below), the solution starts top-right, level with the top of the question.
BELOW_GAP = 18                 # px between the question's bottom and the solution
MIN_BELOW_LINES = 3            # need room for at least this many lines to start below

# Sized to roughly match the question text on the left at default render DPI.
# Kalam runs a touch taller/slantier than the old Patrick Hand, so 24 keeps
# line density similar.
HANDWRITING_SIZE = 24      # used by the token renderer
LINE_GAP = 8               # vertical pixels between successive committed lines

WATERMARK_FILL = (235, 235, 235)
WATERMARK_RADIUS = 220

# Bundled handwritten font (downloaded into ./assets/). Kalam is a natural,
# non-connecting handwriting face (SIL OFL) — it reads like real ballpoint
# handwriting while keeping equations legible because glyphs don't join.
# Patrick Hand is kept as a secondary fallback if Kalam is ever missing.
_HANDWRITTEN_TTF = Path(__file__).with_name("assets") / "Kalam-Regular.ttf"
_HANDWRITTEN_TTF_FALLBACK = Path(__file__).with_name("assets") / "PatrickHand-Regular.ttf"

# Bundled "Full HD Video Solution Base Slide" background — a branded white
# slide with a faint centred PW watermark and a PW logo badge in the corner.
# Every frame is composed on top of this base (question on the left, the
# handwritten solution on the right). Pre-rendered from the source PDF to a
# PNG so the render path only needs PIL — no PDF library at render time.
_BASE_SLIDE_PNG = Path(__file__).with_name("assets") / "base_slide.png"

# Built-in Unicode fallback paths in preference order. Used both as the
# "no handwriting" fallback and for per-glyph fallback when the handwriting
# font lacks a particular codepoint (Δ, π, ², ³, ·, ∫ etc.).
_FALLBACK_FONTS = [
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _handwriting_ttf_path() -> str | None:
    """Absolute path to the bundled handwriting TTF (Kalam, then Patrick Hand
    as a fallback). Returns None if neither is present."""
    for p in (_HANDWRITTEN_TTF, _HANDWRITTEN_TTF_FALLBACK):
        if p.exists():
            return str(p)
    return None


def _find_font(size: int, *, handwritten: bool = True) -> ImageFont.ImageFont:
    """Resolve a PIL ImageFont. Default uses the bundled handwriting TTF."""
    if handwritten:
        hw = _handwriting_ttf_path()
        if hw:
            try:
                return ImageFont.truetype(hw, size)
            except Exception:
                pass
    for path in _FALLBACK_FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _find_fallback_font(size: int) -> ImageFont.ImageFont | None:
    for path in _FALLBACK_FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


# Lazy: parse each font's cmap once via fontTools so we can answer
# "does this font have a glyph for this codepoint?" without touching disk.
from functools import lru_cache


@lru_cache(maxsize=8)
def _font_cmap(path: str) -> frozenset[int]:
    try:
        from fontTools.ttLib import TTFont
        return frozenset(TTFont(path).getBestCmap().keys())
    except Exception:
        return frozenset()


# ---------------------------------------------------------------------------
# Solution data model
# ---------------------------------------------------------------------------
@dataclass
class Step:
    """Used by the legacy/demo path: a single text+math step rendered
    procedurally on the right-hand panel."""
    text: str
    math: str | None = None


@dataclass
class Solution:
    """Legacy demo input. Real videos now go through `build_video_from_images`."""
    qnum: int
    steps: list[Step] = field(default_factory=list)
    final_answer: str | None = None


# ---------------------------------------------------------------------------
# Frame rendering
# ---------------------------------------------------------------------------
@lru_cache(maxsize=4)
def _load_base_slide(size: tuple[int, int]) -> Image.Image | None:
    """Load the bundled "Full HD Video Solution Base Slide" and scale it to
    `size`. Returns None if the asset is missing/unreadable so the caller can
    fall back to the procedural watermark. Cached per size."""
    if not _BASE_SLIDE_PNG.exists():
        return None
    try:
        base = Image.open(_BASE_SLIDE_PNG).convert("RGB")
    except Exception:
        return None
    if base.size != size:
        base = base.resize(size, Image.LANCZOS)
    return base


def _make_procedural_watermark(size: tuple[int, int]) -> Image.Image:
    """Faint centred 'PW' circle — fallback used only when the base slide
    asset is unavailable."""
    w, h = size
    img = Image.new("RGB", size, (255, 255, 255))
    draw = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    r = WATERMARK_RADIUS
    draw.ellipse((cx - r, cy - r, cx + r, cy + r),
                 outline=WATERMARK_FILL, width=8)
    font = _find_font(int(r * 1.1))
    text = "PW"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw // 2 - bbox[0], cy - th // 2 - bbox[1]),
              text, fill=WATERMARK_FILL, font=font)
    return img.filter(ImageFilter.GaussianBlur(radius=1.5))


def _make_watermark(size: tuple[int, int]) -> Image.Image:
    """Base frame every video is composed on top of.

    Uses the bundled branded base slide ("Full HD Video Solution Base Slide
    Format") when present; otherwise falls back to the procedural PW circle.
    Returns a fresh copy each call so callers can paste onto it freely.
    """
    base = _load_base_slide(size)
    if base is not None:
        return base.copy()
    return _make_procedural_watermark(size)


def _fit_image(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Resize keeping aspect ratio so it fits inside (box_w, box_h)."""
    scale = min(box_w / img.width, box_h / img.height, 1.0)
    return img.resize(
        (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
        Image.LANCZOS,
    )


# Pixels at or above this luminance (near-pure-white) in the question crop are
# treated as background and made transparent, so the base slide's PW watermark
# shows through behind the question. Kept high (250) so anti-aliased text edges
# and any light-grey diagram shading stay opaque — only true white is dropped.
_QUESTION_WHITE_THRESHOLD = 250


def _make_question_transparent(img: Image.Image) -> Image.Image:
    """Return an RGBA copy of the question crop with its white background made
    transparent. Black text and diagrams stay fully opaque; only near-white
    pixels become see-through so the branded base slide shows behind them."""
    rgba = img.convert("RGBA")
    # Build an alpha mask from luminance: white→0 (transparent), ink→255.
    gray = img.convert("L")
    alpha = gray.point(
        lambda v: 0 if v >= _QUESTION_WHITE_THRESHOLD else 255, mode="L"
    )
    rgba.putalpha(alpha)
    return rgba


def _load_question_transparent(path: str | Path) -> Image.Image:
    """Load a question image and drop its white background (see
    `_make_question_transparent`). Returns an RGBA image."""
    return _make_question_transparent(Image.open(path).convert("RGB"))


def _render_math_to_image(latex: str, fontsize: int = 18,
                          dpi: int = 150) -> Image.Image:
    """Render a single line of LaTeX-like math (mathtext) to a PNG."""
    fig = plt.figure(figsize=(0.01, 0.01))
    text = fig.text(0, 0, f"${latex}$", fontsize=fontsize)
    fig.canvas.draw()
    bbox = text.get_window_extent(renderer=fig.canvas.get_renderer())
    fig.set_size_inches(bbox.width / dpi + 0.05, bbox.height / dpi + 0.05)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, transparent=False,
                bbox_inches="tight", pad_inches=0.05,
                facecolor="white")
    plt.close(fig)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def _compose_frame_with_solution(question_img: Image.Image,
                                 watermark: Image.Image,
                                 solution_img: Image.Image,
                                 reveal_fraction: float) -> Image.Image:
    """Compose a 1280x720 frame: question on left, top `reveal_fraction` of
    the solution image on the right. `reveal_fraction` in (0, 1] — values
    less than 1 crop the bottom of the solution to simulate progressive
    reveal as narration proceeds."""
    frame = watermark.copy()

    # Left pane: question image, top-aligned. Paste with its own alpha so the
    # transparent (white) background lets the base slide show through.
    q = _fit_image(question_img, LEFT_PANE_W - 2 * PANE_PAD,
                   VIDEO_H - 2 * PANE_PAD)
    qx = (LEFT_PANE_W - q.width) // 2
    qy = CONTENT_TOP
    frame.paste(q, (qx, qy), q if q.mode == "RGBA" else None)

    # Right pane: solution image, fitted to the pane, top-aligned.
    box_w = RIGHT_PANE_W - 2 * PANE_PAD
    box_h = VIDEO_H - 2 * PANE_PAD
    s = _fit_image(solution_img, box_w, box_h)
    visible_h = max(1, int(s.height * max(0.0, min(1.0, reveal_fraction))))
    if visible_h < s.height:
        s = s.crop((0, 0, s.width, visible_h))
    sx = LEFT_PANE_W + PANE_PAD + (box_w - s.width) // 2
    sy = PANE_PAD
    frame.paste(s, (sx, sy))

    return frame


def _compose_frame(question_img: Image.Image,
                   watermark: Image.Image,
                   revealed_steps: Sequence[Step]) -> Image.Image:
    """Build a single 1280x720 frame: question on left, revealed steps right."""
    frame = watermark.copy()

    # --- Left pane: question image, top-aligned, transparent background ---
    q = _fit_image(question_img, LEFT_PANE_W - 2 * PANE_PAD,
                   VIDEO_H - 2 * PANE_PAD)
    x = (LEFT_PANE_W - q.width) // 2
    y = CONTENT_TOP
    frame.paste(q, (x, y), q if q.mode == "RGBA" else None)

    # --- Right pane: revealed solution steps ---
    if revealed_steps:
        draw = ImageDraw.Draw(frame)
        font = _find_font(FONT_SIZE)
        x0 = LEFT_PANE_W + PANE_PAD
        max_text_w = RIGHT_PANE_W - 2 * PANE_PAD
        y_cursor = PANE_PAD

        for step in revealed_steps:
            # Word-wrap the text body.
            for line in _wrap_text(step.text, font, max_text_w):
                if y_cursor + FONT_SIZE > VIDEO_H - PANE_PAD:
                    break
                draw.text((x0, y_cursor), line, fill=(20, 20, 20), font=font)
                y_cursor += FONT_SIZE + LINE_GAP

            if step.math:
                try:
                    math_img = _render_math_to_image(step.math,
                                                     fontsize=FONT_SIZE + 4)
                    math_img = _fit_image(math_img, max_text_w,
                                          VIDEO_H - y_cursor - PANE_PAD)
                    if y_cursor + math_img.height < VIDEO_H - PANE_PAD:
                        frame.paste(math_img, (x0, y_cursor))
                        y_cursor += math_img.height + LINE_GAP
                except Exception:
                    # If mathtext can't parse it, drop the math silently.
                    pass

            y_cursor += LINE_GAP // 2  # extra breathing room between steps

    return frame


def _wrap_text(text: str, font: ImageFont.ImageFont, max_w: int) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    cur: list[str] = []
    for word in words:
        trial = " ".join(cur + [word])
        bbox = font.getbbox(trial)
        if bbox[2] - bbox[0] <= max_w or not cur:
            cur.append(word)
        else:
            lines.append(" ".join(cur))
            cur = [word]
    if cur:
        lines.append(" ".join(cur))
    return lines


# ---------------------------------------------------------------------------
# TTS — Edge-TTS (free) and ElevenLabs (premium, multilingual incl. Hindi)
# ---------------------------------------------------------------------------
EDGE_DEFAULT_VOICE = "hi-IN-SwaraNeural"
ELEVEN_DEFAULT_MODEL = "eleven_multilingual_v2"

# Microsoft removed several Hindi voices from the public edge-tts endpoint
# (they show up in their voice docs but the API returns no audio). When the
# user picks one of these we silently fall back to a working same-gender
# voice so the render doesn't crash mid-job.
EDGE_VOICE_FALLBACKS: dict[str, str] = {
    "hi-IN-AaravNeural":  "hi-IN-MadhurNeural",  # male
    "hi-IN-KunalNeural":  "hi-IN-MadhurNeural",  # male
    "hi-IN-RehaanNeural": "hi-IN-MadhurNeural",  # male
    "hi-IN-AnanyaNeural": "hi-IN-SwaraNeural",   # female
    "hi-IN-KavyaNeural":  "hi-IN-SwaraNeural",   # female
}


def _resolve_edge_voice(voice: str) -> str:
    """Map deprecated edge-tts voices to a working same-gender substitute."""
    return EDGE_VOICE_FALLBACKS.get(voice, voice)


@dataclass(frozen=True)
class TTSConfig:
    """How to render a narration text → MP3 file.

    `engine`   — "edge" (free, MS Edge TTS), "elevenlabs" (premium),
                 "chatterbox" (external HTTP server, OpenAI-compatible API).
    `voice`    — voice name for edge (e.g. "hi-IN-SwaraNeural"),
                 voice id for elevenlabs (e.g. "TX3LPaxmHKxFdv7VOQHJ"),
                 voice name for chatterbox (from server's /v1/voices).
    `model`    — model id for elevenlabs *or* chatterbox.
    `api_key`  — ElevenLabs API key, ignored for all other engines.
    `base_url` — Base URL of an external TTS server (Chatterbox).
                 e.g. "http://localhost:8004". Ignored for other engines.
    `language` — ISO-639 language code (e.g. "en", "hi"). Currently only used
                 by Chatterbox-multilingual to pick the right phonemizer.
                 Ignored for other engines (edge/elevenlabs encode language
                 in the voice id itself).
    """
    engine: str = "edge"
    voice: str = EDGE_DEFAULT_VOICE
    model: str = ELEVEN_DEFAULT_MODEL
    api_key: str = ""
    base_url: str = ""
    language: str = ""


def _synth_tts_edge(text: str, out_path: Path, voice: str) -> None:
    """Block until edge-tts has written an MP3 narrating `text`.

    edge-tts occasionally returns NoAudioReceived on transient Microsoft
    service hiccups (the auth blob expires, a region is overloaded, etc.).
    Retry up to 3 times with exponential backoff (1s, 2s, 4s) before giving
    up. Empty text is replaced with a single space so edge-tts always has
    something to render.
    """
    import time
    safe_text = (text or "").strip() or " "
    # Some voices listed in Microsoft's docs are not served by the public
    # endpoint — fall back to a working same-gender voice automatically.
    actual_voice = _resolve_edge_voice(voice)
    if actual_voice != voice:
        print(
            f"[tts] voice {voice!r} unavailable from public edge-tts endpoint; "
            f"using {actual_voice!r} instead.",
            file=sys.stderr, flush=True,
        )
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            async def _run() -> None:
                comm = edge_tts.Communicate(safe_text, voice=actual_voice)
                await comm.save(str(out_path))
            asyncio.run(_run())
            return
        except Exception as exc:  # noqa: BLE001 — covers NoAudioReceived etc.
            last_exc = exc
            if attempt < 2:
                wait = 1.0 * (2 ** attempt)
                print(
                    f"[tts] edge-tts attempt {attempt + 1}/3 failed "
                    f"({type(exc).__name__}: {exc!s:.120}); retrying in {wait:.1f}s.",
                    file=sys.stderr, flush=True,
                )
                time.sleep(wait)
    raise RuntimeError(f"edge-tts failed after 3 attempts: {last_exc}") from last_exc


def _synth_tts_elevenlabs(text: str, out_path: Path, voice_id: str,
                          model_id: str, api_key: str) -> None:
    """Synthesize `text` to MP3 via ElevenLabs HTTP API.

    Uses urllib (no extra runtime dependency). Raises RuntimeError on any
    non-2xx response; the caller is expected to catch and fall back to edge.
    """
    if not api_key:
        raise RuntimeError(
            "ElevenLabs API key is empty. Save one in Manage API Keys → ElevenLabs (TTS)."
        )
    if not voice_id:
        raise RuntimeError("ElevenLabs voice_id is empty.")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    body = json.dumps({
        "text": text,
        "model_id": model_id or ELEVEN_DEFAULT_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(
            f"ElevenLabs TTS HTTP {e.code}: {detail}"
        ) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"ElevenLabs TTS network error: {e.reason}") from None
    out_path.write_bytes(audio)


# ---------------------------------------------------------------------------
# Local TTS — Chatterbox runs as a *separate* OpenAI-compatible HTTP server
# the user starts themselves, e.g. http://localhost:8004
# ---------------------------------------------------------------------------

CHATTERBOX_DEFAULT_URL = "http://localhost:8004"
CHATTERBOX_DEFAULT_MODEL = "tts-1"


def _synth_tts_chatterbox(text: str, out_path: Path,
                           base_url: str, voice: str, model: str,
                           language: str = "") -> None:
    """Synthesize `text` → MP3 via the Chatterbox TTS Server (OpenAI-compatible).

    Targets the Chatterbox-TTS-Server FastAPI service the user runs locally
    (e.g. http://localhost:8004 — open /docs to inspect the contract). POSTs
    to ``{base_url}/v1/audio/speech`` with body::

        {"model": <model>, "input": <text>, "voice": <voice>,
         "response_format": "mp3",
         "language": <iso-639>}   # only when language is non-empty

    The `language` field is honoured by ChatterboxMultilingualTTS to switch
    the phonemizer — without it a Hindi prompt is read with English phonemes
    and sounds wrong. We omit it entirely for English-only servers so they
    don't 400 on an unknown field.

    Returns: writes the audio bytes (server returns audio/mpeg when
    response_format="mp3") straight to `out_path` — no ffmpeg re-encode.
    """
    if not base_url:
        raise RuntimeError(
            "Chatterbox base URL is empty. Set it in the Video Solution panel "
            "(e.g. http://localhost:8004)."
        )
    url = base_url.rstrip("/") + "/v1/audio/speech"
    payload: dict[str, object] = {
        "model": model or CHATTERBOX_DEFAULT_MODEL,
        "input": text or " ",
        "voice": voice or "alloy",
        "response_format": "mp3",
    }
    if language:
        payload["language"] = language
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    print(
        f"[tts-chatterbox] POST {url} model={payload['model']!r} "
        f"voice={voice!r} lang={language or '-'} chars={len(text)} …",
        file=sys.stderr, flush=True,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(
            f"Chatterbox HTTP {e.code} at {url}: {detail}"
        ) from None
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Chatterbox network error at {url}: {e.reason}. "
            "Is your Chatterbox server running on that URL?"
        ) from None
    if not audio:
        raise RuntimeError(
            f"Chatterbox returned an empty response from {url}."
        )
    out_path.write_bytes(audio)


def _synth_tts(text: str, out_path: Path, tts: TTSConfig | str) -> None:
    """Dispatch to the configured TTS engine.

    Accepts either a TTSConfig or a bare voice name (legacy edge-only path).
    On ElevenLabs failure, falls back to edge with the default voice and
    prints a one-line warning to stderr so the user can see it in the log.
    """
    cfg = tts if isinstance(tts, TTSConfig) else TTSConfig(engine="edge", voice=str(tts))
    if cfg.engine == "elevenlabs":
        # Retry transient failures (429 rate-limit, 5xx, network blips) on the
        # SAME ElevenLabs voice before giving up. Equation-heavy sections emit
        # many rapid short tokens that are especially prone to 429s, so we are
        # generous here and rate-limit-aware. The whole point is that the
        # narration voice must NEVER audibly switch partway through the video.
        last_exc: Exception | None = None
        max_attempts = 6
        for attempt in range(max_attempts):
            try:
                _synth_tts_elevenlabs(text, out_path, cfg.voice, cfg.model, cfg.api_key)
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt < max_attempts - 1:
                    msg = str(exc).lower()
                    rate_limited = "429" in msg or "rate limit" in msg or "too many" in msg
                    base = 5.0 if rate_limited else 2.0
                    wait = min(base * (2 ** attempt), 30.0)
                    print(
                        f"[tts] ElevenLabs attempt {attempt + 1}/{max_attempts} failed "
                        f"({'rate-limited' if rate_limited else type(exc).__name__}: {exc!s:.100}); "
                        f"retrying in {wait:.0f}s to keep the voice consistent…",
                        file=sys.stderr, flush=True,
                    )
                    time.sleep(wait)
        # Exhausted all attempts. STRICT voice mode (default, opt out with
        # QBG_TTS_STRICT_VOICE=0): never switch to a different voice. Emit a
        # short silent segment instead so the video stays single-voice. Only
        # when strict mode is disabled do we fall through to edge-tts (which
        # WILL sound different).
        strict = os.environ.get("QBG_TTS_STRICT_VOICE", "1").strip() != "0"
        if strict:
            print(
                f"[tts] ElevenLabs still failing after {max_attempts} attempts "
                f"({last_exc}); STRICT voice mode on → rendering this segment as "
                f"silence rather than switching voice. Set QBG_TTS_STRICT_VOICE=0 "
                f"to allow an edge-tts fallback instead.",
                file=sys.stderr, flush=True,
            )
            _write_silence_mp3(out_path, _estimate_speech_seconds(text))
            return
        print(
            f"[tts] ElevenLabs still failing after {max_attempts} attempts "
            f"({last_exc}); QBG_TTS_STRICT_VOICE=0 → falling back to edge-tts for "
            f"THIS segment only — its voice will differ from the rest of the video.",
            file=sys.stderr, flush=True,
        )
    elif cfg.engine == "chatterbox":
        _synth_tts_chatterbox(
            text, out_path, cfg.base_url, cfg.voice, cfg.model, cfg.language,
        )
        return
    _synth_tts_edge(text, out_path, cfg.voice if cfg.engine == "edge" else EDGE_DEFAULT_VOICE)


def _audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _estimate_speech_seconds(text: str) -> float:
    """Rough spoken duration for a phrase, used only when we must emit a
    silent placeholder segment (strict-voice last resort). ~0.38s/word with
    sane clamps so timing/visuals stay reasonable."""
    words = len((text or "").split())
    return max(0.8, min(8.0, words * 0.38))


def _write_silence_mp3(out_path: Path, seconds: float) -> None:
    """Write `seconds` of silence as an MP3. Used as a strict-voice last
    resort: if a premium engine can't render a segment we'd rather drop in a
    brief silent gap than switch to a different-sounding voice mid-video."""
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", f"{max(0.4, seconds):.3f}",
        "-q:a", "9", "-acodec", "libmp3lame",
        str(out_path),
    ], check=True)


# ---------------------------------------------------------------------------
# Video assembly
# ---------------------------------------------------------------------------
def build_video(question_img_path: str | Path,
                solution: Solution,
                out_path: str | Path,
                *,
                voice: str = EDGE_DEFAULT_VOICE,
                tts: TTSConfig | None = None) -> Path:
    """Render one MP4 for one question. Returns the output path."""
    tts_cfg = tts or TTSConfig(engine="edge", voice=voice)
    question_img = _load_question_transparent(question_img_path)
    watermark = _make_watermark((VIDEO_W, VIDEO_H))

    steps = list(solution.steps)
    if solution.final_answer:
        steps.append(Step(text=f"The correct answer is {solution.final_answer}."))

    if not steps:
        steps = [Step(text="Solution not available for this question.")]

    with tempfile.TemporaryDirectory(prefix="vidbuild_") as td_str:
        td = Path(td_str)
        segment_list = td / "segments.txt"
        seg_paths: list[Path] = []

        for i, _ in enumerate(steps, 1):
            revealed = steps[:i]
            frame = _compose_frame(question_img, watermark, revealed)
            frame_path = td / f"frame_{i:03d}.png"
            frame.save(frame_path)

            audio_path = td / f"audio_{i:03d}.mp3"
            _synth_tts(steps[i - 1].text, audio_path, tts_cfg)
            duration = max(_audio_duration(audio_path), 0.5)

            seg_path = td / f"seg_{i:03d}.mp4"
            # Build a still-video segment with the audio muxed in.
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-loop", "1", "-i", str(frame_path),
                "-i", str(audio_path),
                "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                "-r", str(FPS), "-t", f"{duration:.3f}",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-shortest", "-movflags", "+faststart",
                str(seg_path),
            ], check=True)
            seg_paths.append(seg_path)

        segment_list.write_text(
            "\n".join(f"file '{p.as_posix()}'" for p in seg_paths),
            encoding="utf-8",
        )
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(segment_list),
            "-c", "copy", "-movflags", "+faststart",
            str(out_path),
        ], check=True)
    return out_path


# ---------------------------------------------------------------------------
# Token-level reveal: incrementally write each symbol as its TTS plays
# ---------------------------------------------------------------------------
# Blue ball-point pen ink for the handwritten solution on the right panel.
INK = (24, 62, 190)


def _measure_line_height(font: ImageFont.ImageFont) -> int:
    """Pixel line height for a font (ascent + descent + small gap)."""
    a, d = font.getmetrics()
    return a + d + 4


def _split_runs(text: str, primary_path: str,
                fallback_path: str | None) -> list[tuple[str, str]]:
    """Split `text` into (run_text, font_path) pairs, picking the fallback
    font for any character whose codepoint isn't in the primary font's cmap.
    Adjacent characters using the same font are merged into one run."""
    if not text:
        return []
    primary_cmap = _font_cmap(primary_path)
    fallback_cmap = _font_cmap(fallback_path) if fallback_path else frozenset()
    runs: list[tuple[str, str]] = []
    cur_text: list[str] = []
    cur_path = primary_path
    for ch in text:
        cp = ord(ch)
        if cp in primary_cmap or ch in " \t":
            chosen = primary_path
        elif fallback_path and cp in fallback_cmap:
            chosen = fallback_path
        else:
            chosen = primary_path  # let .notdef show — better than nothing
        if chosen != cur_path and cur_text:
            runs.append(("".join(cur_text), cur_path))
            cur_text = []
        cur_path = chosen
        cur_text.append(ch)
    if cur_text:
        runs.append(("".join(cur_text), cur_path))
    return runs


@lru_cache(maxsize=64)
def _font_at(path: str, size: int) -> ImageFont.ImageFont:
    return ImageFont.truetype(path, size)


def _draw_text_with_fallback(draw: ImageDraw.ImageDraw,
                             xy: tuple[int, int],
                             text: str,
                             primary: ImageFont.ImageFont,
                             primary_path: str,
                             fallback_path: str | None,
                             fill: tuple[int, int, int]) -> int:
    """Draw `text` starting at `xy` switching fonts per-glyph. Returns
    advance width in pixels."""
    x, y = xy
    size = primary.size
    advance = 0
    for run_text, run_path in _split_runs(text, primary_path, fallback_path):
        font = _font_at(run_path, size) if run_path != primary_path else primary
        # Use the same baseline as primary so the line looks even when we mix.
        draw.text((x + advance, y), run_text, fill=fill, font=font)
        bbox = font.getbbox(run_text)
        advance += bbox[2] - bbox[0]
    return advance


def _measure_text_width(text: str,
                        primary: ImageFont.ImageFont,
                        primary_path: str,
                        fallback_path: str | None) -> int:
    """Pixel width of `text` if rendered with the fallback-aware drawer."""
    size = primary.size
    w = 0
    for run_text, run_path in _split_runs(text, primary_path, fallback_path):
        font = _font_at(run_path, size) if run_path != primary_path else primary
        bbox = font.getbbox(run_text)
        w += bbox[2] - bbox[0]
    return w


# ---------------------------------------------------------------------------
# Math sub/superscript rendering
# ---------------------------------------------------------------------------

def _parse_math_runs(text: str) -> list[tuple[str, str]]:
    """Split ``text`` into (chunk, kind) pairs for subscript/superscript rendering.

    kind is one of 'normal', 'sub', or 'sup'.

    Recognised syntax (same as LaTeX inline math):
      _x       or  _{xyz}   → subscript
      ^x       or  ^{xyz}   → superscript

    Examples:
      "p_m"        → [("p","normal"), ("m","sub")]
      "K_{cat}"    → [("K","normal"), ("cat","sub")]
      "x^2"        → [("x","normal"), ("2","sup")]
      "v_0^2"      → [("v","normal"), ("0","sub"), ("2","sup")]
    """
    runs: list[tuple[str, str]] = []
    buf: list[str] = []
    i, n = 0, len(text)

    while i < n:
        ch = text[i]
        if ch in ('_', '^') and i + 1 < n:
            if buf:
                runs.append((''.join(buf), 'normal'))
                buf = []
            kind = 'sub' if ch == '_' else 'sup'
            i += 1
            if i < n and text[i] == '{':
                j = text.find('}', i + 1)
                if j == -1:
                    # No closing brace — consume everything as the run.
                    runs.append((text[i + 1:], kind))
                    i = n
                else:
                    runs.append((text[i + 1:j], kind))
                    i = j + 1
            else:
                # Un-braced sub/sup: consume the maximal run of alphanumerics so
                # multi-character labels like "_total" / "_max" / "_net" subscript
                # FULLY. (Previously only the single next char became the sub/sup,
                # so "W_total" rendered as W, tiny "t", then "otal" inline.)
                # Stops at the first non-alphanumeric (space, operator, ^, _, etc.),
                # so "v_0^2" still splits into sub "0" and sup "2".
                j = i
                while j < n and text[j].isalnum():
                    j += 1
                if j == i:        # next char isn't alphanumeric — take just one
                    j = i + 1
                runs.append((text[i:j], kind))
                i = j
        else:
            buf.append(ch)
            i += 1

    if buf:
        runs.append((''.join(buf), 'normal'))
    return runs


def _has_math_markup(text: str) -> bool:
    """Quick check: does the text contain _x or ^x markers?"""
    return '_' in text or '^' in text


# Visual constants for sub/superscript — adjust if tuning is needed.
_SS_SCALE = 0.65   # sub/sup font size as a fraction of normal font size
_SUB_DOWN = 0.40   # fraction of font size to shift subscript *down*
_SUP_UP   = 0.30   # fraction of font size to shift superscript *up*


def _ss_font(primary_path: str, size: int) -> ImageFont.ImageFont:
    """Return a smaller font for subscript/superscript (same TTF, 65% size)."""
    sub_size = max(8, int(size * _SS_SCALE))
    if primary_path and os.path.exists(primary_path):
        try:
            return _font_at(primary_path, sub_size)
        except Exception:
            pass
    return _find_font(sub_size, handwritten=True)


def _measure_math_text_width(text: str,
                              primary: ImageFont.ImageFont,
                              primary_path: str,
                              fallback_path: str | None) -> int:
    """Pixel width of ``text``, accounting for smaller sub/sup glyph sizes."""
    if not _has_math_markup(text):
        return _measure_text_width(text, primary, primary_path, fallback_path)
    size = primary.size
    w = 0
    for chunk, kind in _parse_math_runs(text):
        if kind == 'normal':
            w += _measure_text_width(chunk, primary, primary_path, fallback_path)
        else:
            sf = _ss_font(primary_path, size)
            w += _measure_text_width(chunk, sf, primary_path, fallback_path)
    return w


def _draw_math_text(draw: ImageDraw.ImageDraw,
                    xy: tuple[int, int],
                    text: str,
                    primary: ImageFont.ImageFont,
                    primary_path: str,
                    fallback_path: str | None,
                    fill: tuple[int, int, int]) -> int:
    """Draw ``text`` with sub/superscript support. Returns advance width (px).

    For each subscript/superscript run the glyph is rendered at ``_SS_SCALE``
    of the normal font size with a vertical shift (_SUB_DOWN downward for sub,
    _SUP_UP upward for sup, both expressed as fractions of the normal font size).

    Per-glyph font-fallback (for Δ, π, Unicode Devanagari, …) is preserved by
    delegating each run to ``_draw_text_with_fallback``.
    """
    if not _has_math_markup(text):
        return _draw_text_with_fallback(
            draw, xy, text, primary, primary_path, fallback_path, fill
        )

    x, y = xy
    size = primary.size
    advance = 0

    for chunk, kind in _parse_math_runs(text):
        if kind == 'normal':
            adv = _draw_text_with_fallback(
                draw, (x + advance, y), chunk,
                primary, primary_path, fallback_path, fill,
            )
            advance += adv
        else:
            sf = _ss_font(primary_path, size)
            y_off = int(size * _SUB_DOWN) if kind == 'sub' else -int(size * _SUP_UP)
            adv = _draw_text_with_fallback(
                draw, (x + advance, y + y_off), chunk,
                sf, primary_path, fallback_path, fill,
            )
            advance += adv

    return advance


def _wrap_text_aware(text: str, primary: ImageFont.ImageFont,
                     primary_path: str, fallback_path: str | None,
                     max_w: int) -> list[str]:
    """Word-wrap, measuring widths with the math-and-fallback-aware metric."""
    words = text.split(" ")
    if not words:
        return [""]
    lines: list[str] = []
    cur: list[str] = []
    for word in words:
        trial = (" ".join(cur + [word])) if cur else word
        if _measure_math_text_width(trial, primary, primary_path, fallback_path) <= max_w or not cur:
            cur.append(word)
        else:
            lines.append(" ".join(cur))
            cur = [word]
    if cur:
        lines.append(" ".join(cur))
    return lines


def _compose_token_frame(question_img: Image.Image,
                         watermark: Image.Image,
                         lines: list[str],
                         font: ImageFont.ImageFont,
                         primary_path: str,
                         fallback_path: str | None) -> Image.Image:
    """Left pane: question. Right pane: each logical line rendered with the
    handwritten font, with per-glyph fallback for any chars the handwriting
    font is missing (Δ, ², π, …)."""
    frame, _cursor = _compose_token_frame_with_cursor(
        question_img, watermark, lines, font, primary_path, fallback_path,
    )
    return frame


# A writing zone is (x0, width, top, bottom) in frame pixels.
def _solution_zones(q_bottom: int, line_h: int) -> list[tuple[int, int, int, int]]:
    """Ordered list of zones the solution is written into.

    The right half (level with the top of the question) is always available.
    When the question is short enough to leave >= MIN_BELOW_LINES of room beneath
    it, that space (left half, below the question) is used FIRST and the right
    half becomes the overflow zone — so a short question's solution begins right
    under it instead of leaving that area blank.
    """
    right = (
        LEFT_PANE_W + PANE_PAD,           # x0
        RIGHT_PANE_W - 2 * PANE_PAD,      # width
        CONTENT_TOP,                      # top
        VIDEO_H - PANE_PAD,               # bottom
    )
    below_top = q_bottom + BELOW_GAP
    below_bottom = VIDEO_H - PANE_PAD
    if below_bottom - below_top >= MIN_BELOW_LINES * line_h:
        below = (PANE_PAD, LEFT_PANE_W - 2 * PANE_PAD, below_top, below_bottom)
        return [below, right]
    return [right]


def _compose_token_frame_with_cursor(
        question_img: Image.Image,
        watermark: Image.Image,
        lines: list[str],
        font: ImageFont.ImageFont,
        primary_path: str,
        fallback_path: str | None,
) -> tuple[Image.Image, tuple[int, int] | None]:
    """Compose a frame and also report the (x, y) position where the next
    character would be written — used to anchor the pen-tip cursor during
    the handwriting animation.

    Returns:
        (frame, cursor) where cursor is (x, y_top_of_line) at the end of the
        last drawn line, or None if no text was drawn.
    """
    frame = watermark.copy()

    q = _fit_image(question_img, LEFT_PANE_W - 2 * PANE_PAD,
                   VIDEO_H - 2 * PANE_PAD)
    qx = (LEFT_PANE_W - q.width) // 2
    qy = CONTENT_TOP
    frame.paste(q, (qx, qy), q if q.mode == "RGBA" else None)

    line_h = _measure_line_height(font)
    draw = ImageDraw.Draw(frame)

    # Both halves are the same width, so the wrap width is identical whether we
    # write below the question (left half) or on the right half.
    box_w = LEFT_PANE_W - 2 * PANE_PAD
    q_bottom = qy + q.height

    zones = _solution_zones(q_bottom, line_h)

    # Flatten the logical lines into display sub-lines (wrapped to the column
    # width). The pen writes these in order, filling each zone top-to-bottom
    # before moving to the next zone.
    display: list[str] = []
    for raw_line in lines:
        display.extend(
            _wrap_text_aware(raw_line, font, primary_path, fallback_path, box_w)
            or [""]
        )

    caps = [max(0, int((z[3] - z[2]) // line_h)) for z in zones]
    total_cap = sum(caps) or 1

    # Decide which display lines land in which zone. The FINAL zone scrolls when
    # content overflows (newest lines stay visible); earlier zones stay frozen
    # so text already written below the question doesn't jump around.
    if len(display) <= total_cap:
        assigned = display
    else:
        # Freeze all but the last zone; let the last zone show the newest lines.
        head_cap = sum(caps[:-1])
        head = display[:head_cap]
        tail = display[head_cap:][-caps[-1]:] if caps[-1] else []
        assigned = head + tail

    cursor: tuple[int, int] | None = None
    idx = 0
    for (zx, _zw, ztop, zbot), cap in zip(zones, caps):
        y = ztop
        drawn = 0
        while drawn < cap and idx < len(assigned):
            text = assigned[idx]
            idx += 1
            drawn += 1
            if text:
                _draw_math_text(
                    draw, (zx, y), text, font, primary_path, fallback_path, INK,
                )
                w = _measure_math_text_width(text, font, primary_path, fallback_path)
                cursor = (zx + w, y)
            else:
                cursor = (zx, y)
            y += line_h
        if idx >= len(assigned):
            break

    return frame, cursor


# ---------------------------------------------------------------------------
# Handwriting animation — per-character reveal with a pen-tip cursor
# ---------------------------------------------------------------------------

# Lower the per-segment render rate to keep total time reasonable. The output
# video still runs at FPS (30); ffmpeg duplicates frames as needed. 12 fps for
# the writing animation is more than enough for a hand-drawn feel.
ANIM_FPS = 12

# Natural handwriting speed cap. If `total_chars / audio_duration` exceeds
# this, the segment falls back to instant-appearance — animated writing at
# faster rates than this looks unnaturally sped-up.
NATURAL_WRITE_CPS = 6.0


def _draw_pen_tip(draw: ImageDraw.ImageDraw,
                   cursor: tuple[int, int],
                   line_h: int) -> None:
    """Draw a small red dot at the current writing position.

    Simpler than the previous pen-shape — just a filled red disc roughly at
    the baseline of the current line, indicating where the next character
    will appear.
    """
    x, y_top = cursor
    # Place the dot near where a pen tip would be touching paper — slightly
    # above the bottom of the line (around baseline).
    cy = y_top + int(line_h * 0.62)
    r = 6
    draw.ellipse(
        [(x - r, cy - r), (x + r, cy + r)],
        fill=(220, 30, 30),
    )


def _render_animated_segment(question_img: Image.Image,
                              watermark: Image.Image,
                              prior_lines: list[str],
                              write_text: str,
                              audio_path: Path,
                              seg_path: Path,
                              work_dir: Path,
                              font: ImageFont.ImageFont,
                              primary_path: str,
                              fallback_path: str | None) -> None:
    """Render a video segment where `write_text` is revealed character by
    character at a natural handwriting rate, with a red-dot cursor at the
    writing position, then muxed with `audio_path`.

    Pacing strategy:
      • Compute the natural write duration: total_chars / NATURAL_WRITE_CPS
      • If that exceeds the audio duration (i.e. we'd have to type FASTER
        than a person reasonably writes to fit it all in), don't animate —
        the text appears instantly via the still-frame path. Animating at
        super-human speeds looks robotic.
      • Otherwise, animate for write_duration, then keep the static final
        frame for the rest of the audio. Pen-tip dot is hidden after the
        last char is drawn (the "pen lifts off the page" effect).

    Optimisation: only render a new frame when the visible char count
    changes; otherwise hardlink/copy the previous frame. Cuts PIL render
    cost down to ~total_chars unique renders per segment.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    duration = max(_audio_duration(audio_path), 0.4)
    total_chars = len(write_text)
    line_h = _measure_line_height(font)

    # If there's nothing to write, just play audio over a static frame.
    if total_chars == 0:
        lines_for_frame = list(prior_lines) if prior_lines else [""]
        _render_static_segment(
            question_img, watermark, lines_for_frame,
            audio_path, seg_path, work_dir,
            font, primary_path, fallback_path,
        )
        return

    # Natural-rate write duration (in seconds). If it doesn't fit in the
    # audio with some margin, fall back to instant-show.
    natural_write_duration = total_chars / NATURAL_WRITE_CPS
    if natural_write_duration > duration * 0.95:
        # Too much text to write naturally during this segment's audio —
        # show the full text instantly via the static path. Saves render
        # time AND avoids the unnatural "rapid typing" look.
        full_lines = list(prior_lines) if prior_lines else [""]
        full_lines[-1] = full_lines[-1] + write_text
        _render_static_segment(
            question_img, watermark, full_lines,
            audio_path, seg_path, work_dir,
            font, primary_path, fallback_path,
        )
        return

    # We have time to write naturally. Use min(natural, 95% of audio) so the
    # final char appears slightly before the audio ends (gives the viewer a
    # moment to look at the finished line as the narration concludes).
    write_duration = min(natural_write_duration, duration * 0.95)
    write_duration = max(write_duration, 0.3)

    n_frames = max(int(duration * ANIM_FPS), 1)
    write_frames = max(1, int(write_duration * ANIM_FPS))

    last_count = -1
    last_path: Path | None = None

    for f in range(n_frames):
        if f < write_frames:
            # Linear reveal during the writing phase.
            t = (f + 1) / write_frames
            chars_visible = min(total_chars, int(round(t * total_chars)))
        else:
            # Audio still playing after writing is done — hold the final frame.
            chars_visible = total_chars

        frame_path = work_dir / f"f_{f:05d}.png"

        if chars_visible == last_count and last_path is not None:
            # No change → reuse previous frame (cheap hardlink/copy).
            try:
                os.link(last_path, frame_path)
            except OSError:
                shutil.copyfile(last_path, frame_path)
            continue

        partial = write_text[:chars_visible]
        lines_for_frame = list(prior_lines) if prior_lines else [""]
        lines_for_frame[-1] = lines_for_frame[-1] + partial

        frame, cursor = _compose_token_frame_with_cursor(
            question_img, watermark, lines_for_frame,
            font, primary_path, fallback_path,
        )
        # Only show the red dot while there are still chars left to write.
        if cursor is not None and chars_visible < total_chars:
            draw = ImageDraw.Draw(frame)
            _draw_pen_tip(draw, cursor, line_h)

        frame.save(frame_path)
        last_count = chars_visible
        last_path = frame_path

    # Mux the PNG sequence into a video segment with the audio track.
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(ANIM_FPS),
        "-i", str(work_dir / "f_%05d.png"),
        "-i", str(audio_path),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-r", str(FPS),
        "-t", f"{duration:.3f}",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-shortest", "-movflags", "+faststart",
        str(seg_path),
    ], check=True)


def _render_static_segment(question_img: Image.Image,
                            watermark: Image.Image,
                            lines: list[str],
                            audio_path: Path,
                            seg_path: Path,
                            work_dir: Path,
                            font: ImageFont.ImageFont,
                            primary_path: str,
                            fallback_path: str | None) -> None:
    """Render a still-image segment with the given audio. Used for tokens
    whose `write` is empty (pure narration — question reading, concept setup,
    transitions)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    duration = max(_audio_duration(audio_path), 0.4)
    frame = _compose_token_frame(
        question_img, watermark, lines, font, primary_path, fallback_path,
    )
    frame_path = work_dir / "still.png"
    frame.save(frame_path)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-i", str(frame_path),
        "-i", str(audio_path),
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-r", str(FPS), "-t", f"{duration:.3f}",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-shortest", "-movflags", "+faststart",
        str(seg_path),
    ], check=True)


# ---------------------------------------------------------------------------
# Answer tick — a hand-drawn check over the correct option (objective Qs)
# ---------------------------------------------------------------------------

# A teacher's green correcting pen — clearly "correct" yet natural-looking.
TICK_COLOR = (22, 150, 60)

# Tick geometry, expressed relative to the option-marker box it marks (the
# "(A)" / "(1)" span). The check is drawn directly OVER that marker, the way a
# teacher strikes the correct option on a paper — not politely beside it — and
# is deliberately larger than the marker so the long upstroke reads as a
# confident tick from across the room.
TICK_HEIGHT_SCALE = 1.7    # tick height  ÷ marker height
TICK_WIDTH_SCALE = 1.5     # tick width   ÷ marker width
TICK_MIN_ASPECT = 1.15     # floor on width ÷ height, so it always looks "long"
TICK_STROKE_SCALE = 0.18   # pen thickness ÷ marker height


def _question_fit_layout(question_img: Image.Image) -> tuple[float, int, int]:
    """Return (scale, qx, qy) describing how the question image is placed in the
    left pane — MUST match `_compose_token_frame_with_cursor` so a tick lands on
    the right spot."""
    q = _fit_image(question_img, LEFT_PANE_W - 2 * PANE_PAD, VIDEO_H - 2 * PANE_PAD)
    scale = (q.width / question_img.width) if question_img.width else 1.0
    qx = (LEFT_PANE_W - q.width) // 2
    qy = CONTENT_TOP
    return scale, qx, qy


def _checkmark_points(box: tuple[int, int, int, int]) -> list[tuple[float, float]]:
    """Three points of a check drawn directly OVER `box` (the option marker
    "(A)"/"(1)", in frame px), centred on it and sized well beyond it — the way
    a teacher strikes the correct option rather than annotating beside it.

    The stroke runs left tip -> bottom vertex -> long upstroke to the top
    right, with the vertex kept left of centre so the tail is the long part."""
    bx0, by0, bx1, by1 = box
    h = max(10.0, float(by1 - by0))
    w = max(10.0, float(bx1 - bx0))

    height = h * TICK_HEIGHT_SCALE
    # Never let a narrow marker (e.g. "(1)") produce a stubby check.
    width = max(w * TICK_WIDTH_SCALE, height * TICK_MIN_ASPECT)

    cx = (bx0 + bx1) / 2.0
    cy = (by0 + by1) / 2.0
    # Sit slightly left/high of dead-centre so the long upstroke sweeps up and
    # past the marker's right edge, which is what makes it read as a tick.
    left = cx - width * 0.45
    top = cy - height * 0.58

    # Keep the stroke on-frame and out of the solution pane, clamping against
    # the real edges rather than the content padding — a correcting pen may sit
    # in the margin, and padding-based clamping would gratuitously slide the
    # tick off the very marker it is meant to cover.
    edge = 2.0
    left = max(edge, min(left, LEFT_PANE_W - width - edge))
    top = max(edge, min(top, VIDEO_H - height - edge))

    p0 = (left,                    top + 0.55 * height)
    p1 = (left + 0.32 * width,     top + height)
    p2 = (left + width,            top)
    return [p0, p1, p2]


def _draw_partial_polyline(draw: ImageDraw.ImageDraw, pts, frac: float,
                           fill: tuple[int, int, int], width: int) -> None:
    """Draw the `pts` polyline up to cumulative-length fraction `frac` (0..1),
    with rounded joints so the check looks pen-drawn."""
    import math
    segs = list(zip(pts[:-1], pts[1:]))
    total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs) or 1.0
    target = max(0.0, min(1.0, frac)) * total
    acc = 0.0
    r = width / 2.0
    for a, b in segs:
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        if acc + d <= target:
            draw.line([a, b], fill=fill, width=width)
            draw.ellipse([b[0] - r, b[1] - r, b[0] + r, b[1] + r], fill=fill)
            acc += d
        else:
            t = (target - acc) / d if d > 0 else 0.0
            mx = a[0] + (b[0] - a[0]) * t
            my = a[1] + (b[1] - a[1]) * t
            draw.line([a, (mx, my)], fill=fill, width=width)
            return


def _render_answer_tick_segment(question_img: Image.Image,
                                watermark: Image.Image,
                                final_lines: list[str],
                                answer_tick: dict,
                                seg_path: Path,
                                work_dir: Path,
                                font: ImageFont.ImageFont,
                                primary_path: str,
                                fallback_path: str | None) -> None:
    """Short closing segment: over the final solution frame, draw a check on the
    correct option in the question (left pane), animated left-to-right, then
    hold. Silent — the narration already announced the answer."""
    work_dir.mkdir(parents=True, exist_ok=True)

    scale, qx, qy = _question_fit_layout(question_img)
    bx0, by0, bx1, by1 = answer_tick["box"]
    fbox = (int(qx + bx0 * scale), int(qy + by0 * scale),
            int(qx + bx1 * scale), int(qy + by1 * scale))
    if fbox[2] <= fbox[0] or fbox[3] <= fbox[1] or fbox[0] > LEFT_PANE_W:
        raise ValueError(f"option box out of bounds: {fbox}")

    pts = _checkmark_points(fbox)
    stroke = max(3, int((fbox[3] - fbox[1]) * TICK_STROKE_SCALE))

    base = _compose_token_frame(question_img, watermark, final_lines,
                                font, primary_path, fallback_path)

    # A bit longer than the old short tick so the extended upstroke doesn't
    # feel rushed, while still leaving time to hold on the finished check.
    duration = 1.9
    n_frames = max(int(duration * ANIM_FPS), 1)
    draw_frames = max(1, int(n_frames * 0.62))   # spend ~60% drawing, then hold

    for f in range(n_frames):
        frac = min(1.0, (f + 1) / draw_frames)
        frame = base.copy()
        _draw_partial_polyline(ImageDraw.Draw(frame), pts, frac, TICK_COLOR, stroke)
        frame.save(work_dir / f"t_{f:05d}.png")

    audio_path = work_dir / "silence.mp3"
    _write_silence_mp3(audio_path, duration)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(ANIM_FPS),
        "-i", str(work_dir / "t_%05d.png"),
        "-i", str(audio_path),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-t", f"{duration:.3f}",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-shortest", "-movflags", "+faststart",
        str(seg_path),
    ], check=True)


def build_video_from_tokens(question_img_path: str | Path,
                            tokens: list[dict],
                            out_path: str | Path,
                            *,
                            voice: str = EDGE_DEFAULT_VOICE,
                            tts: TTSConfig | None = None,
                            font_size: int = HANDWRITING_SIZE,
                            animate: bool | None = None,
                            answer_tick: dict | None = None,
                            closing_say: str | None = None) -> Path:
    """Render an MP4 by walking the token stream.

    For each token (newline, say, write):
      * If newline is True, start a fresh empty line.
      * Append `write` to the current line (the new chars are what the viewer
        sees appear during this segment's narration).
      * Synthesize the `say` text to MP3 via the configured TTS engine.
      * Render a segment whose duration equals the audio length:
          - If `write` is non-empty and animation is enabled, the new chars
            are revealed letter-by-letter with a pen-tip cursor (looks like
            a teacher writing on a board).
          - If `write` is empty (pure narration — question reading, concept
            intro, transitions), the segment is a still frame.

    Segments are concatenated with ffmpeg into one MP4.

    `animate` defaults to True; set False (or env QBG_VIDEO_ANIMATE=0) to
    use still frames everywhere (faster render, no handwriting effect).
    """
    if animate is None:
        animate = os.environ.get("QBG_VIDEO_ANIMATE", "1").strip() != "0"

    if not tokens:
        tokens = [{"newline": True, "say": "No solution available.", "write": ""}]

    # Force the very first token to start a new line.
    tokens = list(tokens)
    tokens[0] = {**tokens[0], "newline": True}

    question_img = _load_question_transparent(question_img_path)
    watermark = _make_watermark((VIDEO_W, VIDEO_H))
    font = _find_font(font_size, handwritten=True)
    primary_path = _handwriting_ttf_path() or ""
    fb = _find_fallback_font(font_size)
    fallback_path = (fb.path if hasattr(fb, "path") else None) if fb else None
    # PIL ImageFont stores the source path in `.path` in modern versions.
    if fallback_path is None and fb is not None:
        # Older PIL — figure it out from getname()
        for p in _FALLBACK_FONTS:
            if os.path.exists(p):
                fallback_path = p
                break

    lines: list[str] = []

    with tempfile.TemporaryDirectory(prefix="vidbuild_") as td_str:
        td = Path(td_str)
        seg_paths: list[Path] = []

        for i, tok in enumerate(tokens, 1):
            say = (tok.get("say") or "").strip()
            write = tok.get("write") or ""
            newline = bool(tok.get("newline"))

            if newline or not lines:
                lines.append("")

            # Capture line state BEFORE the new write — animation needs it
            # so the pre-existing text stays static while just the new chars
            # are revealed letter-by-letter.
            prior_lines = list(lines)
            # And the post-write state (what the segment ends on):
            lines[-1] = lines[-1] + write

            # Synthesize narration first — we need its duration before rendering.
            audio_path = td / f"audio_{i:03d}.mp3"
            _synth_tts(say or "...", audio_path,
                       tts or TTSConfig(engine="edge", voice=voice))

            seg_path = td / f"seg_{i:03d}.mp4"
            seg_workdir = td / f"work_{i:03d}"

            if animate and write:
                # Handwriting animation — pen tip reveals chars over the
                # length of the say audio.
                _render_animated_segment(
                    question_img, watermark,
                    prior_lines=prior_lines,
                    write_text=write,
                    audio_path=audio_path,
                    seg_path=seg_path,
                    work_dir=seg_workdir,
                    font=font, primary_path=primary_path,
                    fallback_path=fallback_path,
                )
            else:
                # Empty-write token (pure narration like the question read or
                # a concept setup), or animation disabled. Static frame.
                _render_static_segment(
                    question_img, watermark,
                    lines=lines,
                    audio_path=audio_path,
                    seg_path=seg_path,
                    work_dir=seg_workdir,
                    font=font, primary_path=primary_path,
                    fallback_path=fallback_path,
                )
            seg_paths.append(seg_path)

        # Closing flourish: for objective questions, tick the correct option on
        # the question (left pane) with a hand-drawn check, drawn left-to-right.
        if answer_tick and animate:
            tick_seg = td / "seg_tick.mp4"
            tick_work = td / "work_tick"
            try:
                _render_answer_tick_segment(
                    question_img, watermark,
                    final_lines=lines,
                    answer_tick=answer_tick,
                    seg_path=tick_seg,
                    work_dir=tick_work,
                    font=font, primary_path=primary_path,
                    fallback_path=fallback_path,
                )
                seg_paths.append(tick_seg)
            except Exception as exc:  # noqa: BLE001 — never fail a video over the tick
                print(f"[tick] skipped answer tick: {exc}", file=sys.stderr, flush=True)

        # Closing: a spoken "thank you" over the final solution frame — the very
        # last thing the viewer hears, after the answer is announced/ticked.
        if closing_say:
            close_seg = td / "seg_closing.mp4"
            close_work = td / "work_closing"
            try:
                close_audio = td / "audio_closing.mp3"
                _synth_tts(closing_say, close_audio,
                           tts or TTSConfig(engine="edge", voice=voice))
                _render_static_segment(
                    question_img, watermark,
                    lines=(lines if lines else [""]),
                    audio_path=close_audio,
                    seg_path=close_seg,
                    work_dir=close_work,
                    font=font, primary_path=primary_path,
                    fallback_path=fallback_path,
                )
                seg_paths.append(close_seg)
            except Exception as exc:  # noqa: BLE001 — never fail a video over the closing
                print(f"[closing] skipped: {exc}", file=sys.stderr, flush=True)

        segment_list = td / "segments.txt"
        segment_list.write_text(
            "\n".join(f"file '{p.as_posix()}'" for p in seg_paths),
            encoding="utf-8",
        )
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Re-encode on concat — segments come from two different ffmpeg paths
        # (animated PNG-sequence vs still-image loop) so their codec params
        # don't always match perfectly for `-c copy`. Re-encoding is the safe
        # default; output is still fast since all segments are already h264.
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(segment_list),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart",
            str(out_path),
        ], check=True)

    return out_path


# Backwards-compat alias for the driver — the API name is unchanged.
build_video_from_steps = build_video_from_tokens


# ---------------------------------------------------------------------------
# Legacy image-reveal path (kept as a fallback when only an image is available)
# ---------------------------------------------------------------------------
def build_video_from_images(question_img_path: str | Path,
                            solution_img_path: str | Path,
                            narration_chunks: list[str],
                            out_path: str | Path,
                            *,
                            voice: str = EDGE_DEFAULT_VOICE,
                            tts: TTSConfig | None = None) -> Path:
    """Render one solution MP4. The right-hand solution image reveals top
    to bottom in N steps (one per narration chunk); each step's still
    duration equals its narration audio's duration."""
    if not narration_chunks:
        narration_chunks = ["Please refer to the worked solution shown on screen."]

    question_img = _load_question_transparent(question_img_path)
    solution_img = Image.open(solution_img_path).convert("RGB")
    watermark = _make_watermark((VIDEO_W, VIDEO_H))
    n = len(narration_chunks)

    with tempfile.TemporaryDirectory(prefix="vidbuild_") as td_str:
        td = Path(td_str)
        segment_list = td / "segments.txt"
        seg_paths: list[Path] = []

        for i, chunk_text in enumerate(narration_chunks, 1):
            reveal_frac = i / n
            frame = _compose_frame_with_solution(
                question_img, watermark, solution_img, reveal_frac
            )
            frame_path = td / f"frame_{i:03d}.png"
            frame.save(frame_path)

            audio_path = td / f"audio_{i:03d}.mp3"
            _synth_tts(chunk_text, audio_path,
                       tts or TTSConfig(engine="edge", voice=voice))
            duration = max(_audio_duration(audio_path), 0.5)

            seg_path = td / f"seg_{i:03d}.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-loop", "1", "-i", str(frame_path),
                "-i", str(audio_path),
                "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                "-r", str(FPS), "-t", f"{duration:.3f}",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-shortest", "-movflags", "+faststart",
                str(seg_path),
            ], check=True)
            seg_paths.append(seg_path)

        segment_list.write_text(
            "\n".join(f"file '{p.as_posix()}'" for p in seg_paths),
            encoding="utf-8",
        )
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(segment_list),
            "-c", "copy", "-movflags", "+faststart",
            str(out_path),
        ], check=True)

    return out_path


# ---------------------------------------------------------------------------
# Demo / CLI — used while no parser is wired in yet
# ---------------------------------------------------------------------------
def _demo():
    """Quick smoke test: build a single-video deck against the sample Q1."""
    import pdf_to_pptx as p2p
    import fitz

    pdf = Path(__file__).with_name(
        "AITS_Test-06_Class-11th_JEE_Mains_23-02-2025_Question.pdf"
    )
    doc = fitz.open(pdf)
    marks = p2p._find_question_marks(doc)
    m = marks[0]   # Q1
    segments = p2p._question_segments(m, marks, 0, doc)
    q_img = p2p._render_question(m, segments, doc, dpi=180)
    q_img_path = Path(__file__).with_name("_demo_q1.png")
    q_img.save(q_img_path)

    solution = Solution(
        qnum=1,
        steps=[
            Step(text="Let the initial separation between the bodies be d.",
                 math="F = G m^2 / d^2"),
            Step(text="After mass delta-m is transferred, one body has mass "
                      "m plus delta-m and the other m minus delta-m, and the "
                      "new distance is two-thirds of d."),
            Step(text="The new gravitational force becomes:",
                 math=r"F' = G (m+\Delta m)(m-\Delta m) / (2d/3)^2"),
            Step(text="We are told F-prime equals eight-ninths of F.",
                 math=r"\frac{9 (m^2-\Delta m^2)}{4} = \frac{8 m^2}{9} \cdot \frac{1}{1}"),
            Step(text="Solving gives the ratio delta-m over m equals one third.",
                 math=r"\Delta m / m = 1/3"),
        ],
        final_answer="(1)",
    )

    out = Path(__file__).with_name("_demo_q1.mp4")
    build_video(q_img_path, solution, out)
    print(f"Wrote {out} ({out.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    _demo()
