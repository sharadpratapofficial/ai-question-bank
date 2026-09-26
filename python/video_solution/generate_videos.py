"""
generate_videos
===============

End-to-end driver: given a question PDF and a solutions PDF, render one
MP4 per question, with filenames prefixed by the question-PDF's basename.

    py -3.13 generate_videos.py questions.pdf solutions.pdf out_dir

For each question:
  1. Crop the question region from the question PDF (`pdf_to_pptx`).
  2. Crop the solution region from the solutions PDF (`solutions_parser`).
  3. Ask Claude for narration chunks (`narrator`). Falls back to a
     generic 2-chunk script if ANTHROPIC_API_KEY is unset.
  4. Render the MP4 (`video_builder.build_video_from_images`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import fitz

import pdf_to_pptx as p2p
from solutions_parser import parse_solutions, ParsedSolution
from video_builder import (
    build_video_from_steps,
    TTSConfig,
    EDGE_DEFAULT_VOICE,
    ELEVEN_DEFAULT_MODEL,
)
from narrator import narrate, fallback_steps, NarratorConfig, MODEL as NARRATOR_DEFAULT_MODEL


# Sensible default model per provider when the caller doesn't supply one.
# These are the same defaults the rest of the app uses (see
# src/types/extraction.ts AI_PROVIDER_MODELS).
MODEL_DEFAULTS: dict[str, str] = {
    "anthropic": NARRATOR_DEFAULT_MODEL,
    "gemini": "gemini-2.0-flash",
    "openai": "gpt-4o",
    "groq": "llama-3.2-90b-vision-preview",
    "grok": "grok-2-vision-1212",
    "openrouter": "openai/gpt-4o",
    "nvidia": "meta/llama-3.2-90b-vision-instruct",
    "fireworks": "accounts/fireworks/models/llama-v3p2-90b-vision-instruct",
}


# Option markers in the question body: "(1)" "(2)" "(3)" "(4)" or "(A)".."(D)".
_OPTION_RE = re.compile(r"^\(\s*([1-4]|[A-Da-d])\s*\)")


def _find_option_boxes(locator: dict,
                       doc: "fitz.Document") -> dict[str, tuple[int, int, int, int]]:
    """Locate option markers across all of a question's rendered slices and
    return {LABEL: png_box}, where png_box is the marker's bbox in the final
    stacked + trimmed question image. LABEL is upper-cased ("1".."4"/"A".."D")."""
    found: dict[str, tuple[int, int, int, int]] = {}
    for page_index in dict.fromkeys(sl["page_index"] for sl in locator["slices"]):
        page = doc[page_index]
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    t = (span.get("text") or "").strip()
                    m = _OPTION_RE.match(t)
                    if not m:
                        continue
                    png_box = p2p.map_pdf_box(locator, page_index, span["bbox"])
                    if png_box is None:
                        continue  # marker isn't inside this question's slices
                    label = m.group(1).upper()
                    # Keep the FIRST occurrence of each label (the marker).
                    found.setdefault(label, png_box)
    return found


def _render_question_images(pdf_path: Path, out_dir: Path,
                            *, dpi: int = 180
                            ) -> tuple[dict[int, Path],
                                       dict[int, dict[str, tuple[int, int, int, int]]]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    marks = p2p._find_question_marks(doc)
    result: dict[int, Path] = {}
    options: dict[int, dict[str, tuple[int, int, int, int]]] = {}
    for idx, m in enumerate(marks):
        # A question may span several column boxes (left→right, across pages);
        # render every slice and stack them into one complete image.
        segments = p2p._question_segments(m, marks, idx, doc)
        if not segments:
            continue
        img, locator = p2p._render_question_located(m, segments, doc, dpi=dpi)
        path = out_dir / f"q{m.qnum:03d}.png"
        img.save(path)
        result[m.qnum] = path
        options[m.qnum] = _find_option_boxes(locator, doc)
    doc.close()
    return result, options


def _build_answer_tick(option_boxes: dict[str, tuple[int, int, int, int]],
                       answer: str | None) -> dict | None:
    """Return tick info {box, label} for the correct option, or None when the
    question isn't objective / the answer doesn't match a detected option.

    Requires >= 2 detected option markers (so a stray "(1)" in the body of a
    numeric-answer question doesn't get ticked)."""
    if not option_boxes or len(option_boxes) < 2 or not answer:
        return None
    label = answer.strip().upper()
    box = option_boxes.get(label)
    if box is None:
        return None
    return {"box": box, "label": label}


def _closing_say(language: str) -> str:
    """Spoken closing line for the end of every video — language aware."""
    code = (language or "en").lower()[:2]
    if code == "hi":
        return "Thank you बच्चों! Milte hain agle video mein."
    return "Thank you for watching. All the best!"


def _render_all(q_imgs: dict[int, Path],
                solutions: dict[int, "ParsedSolution"],
                out_dir: Path,
                *,
                name_prefix: str,
                tts_cfg: TTSConfig,
                narrator_cfg: NarratorConfig | None,
                language: str,
                max_questions: int | None,
                progress,
                q_options: dict[int, dict] | None = None) -> list[Path]:
    """Shared narrate+render loop behind both generate() (PDF source) and
    generate_from_qbg() (QBG-id source) — identical narration/TTS/video-build
    logic regardless of where the question/solution images came from.

    `q_options`: per-question detected option-marker boxes, used to draw the
    answer-tick overlay. Only available for the PDF-crop path (its column
    `locator` gives pixel boxes for "(A)"/"(B)"/... markers) — the QBG-id
    path passes None, so no tick overlay is drawn for those videos (the
    correct answer is still spoken correctly in narration)."""
    q_options = q_options or {}
    # We have "an API" if either a NarratorConfig with key was passed OR the
    # legacy ANTHROPIC_API_KEY env var is set.
    have_api = bool(
        (narrator_cfg and narrator_cfg.api_key)
        or (narrator_cfg and narrator_cfg.provider == "local")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    if not have_api:
        progress("No narrator API key configured — narration will fall back "
                 "to a generic script for each question.")

    qnums = sorted(q_imgs)
    if max_questions is not None and max_questions > 0 and len(qnums) > max_questions:
        progress(f"Limiting to first {max_questions} of {len(qnums)} questions.")
        qnums = qnums[:max_questions]

    written: list[Path] = []
    for qnum in qnums:
        sol = solutions.get(qnum)
        if not sol or not sol.image_path or not Path(sol.image_path).exists():
            progress(f"Q{qnum}: no solution found, skipping.")
            continue

        provider_label = (narrator_cfg.provider if narrator_cfg else "anthropic")
        progress(f"Q{qnum}: narrating (lang={language}, provider={provider_label})...")
        if have_api:
            try:
                steps = narrate(q_imgs[qnum], sol.image_path, qnum, sol.answer,
                                language=language, cfg=narrator_cfg,
                                tts_engine=tts_cfg.engine)
            except Exception as e:
                progress(f"Q{qnum}: narration failed ({type(e).__name__}: {e!s:.120}), "
                         "falling back to generic script.")
                steps = fallback_steps(qnum, sol.answer, language=language)
        else:
            steps = fallback_steps(qnum, sol.answer, language=language)

        answer_tick = _build_answer_tick(q_options.get(qnum, {}), sol.answer)
        out_path = out_dir / f"{name_prefix}_Q{qnum:02d}.mp4"
        progress(f"Q{qnum}: rendering video -> {out_path.name} "
                 f"(tts={tts_cfg.engine}, voice={tts_cfg.voice}"
                 f"{', tick option ' + answer_tick['label'] if answer_tick else ''})")
        build_video_from_steps(q_imgs[qnum], steps, out_path, tts=tts_cfg,
                               answer_tick=answer_tick,
                               closing_say=_closing_say(language))
        written.append(out_path)

    return written


def generate(question_pdf: Path, solution_pdf: Path,
             out_dir: Path,
             *,
             name_prefix: str | None = None,
             voice: str = EDGE_DEFAULT_VOICE,
             tts: TTSConfig | None = None,
             narrator_cfg: NarratorConfig | None = None,
             language: str = "en",
             max_questions: int | None = None,
             progress=lambda *_a, **_k: None) -> list[Path]:
    """Generate one MP4 per question.

    `max_questions`: if set to a positive int, only the first N questions
    (by qnum) are processed. Useful during testing to avoid spending API
    tokens / time on every question in the paper.

    `tts`: when set, overrides `voice` and selects the TTS engine
    (edge-tts default, ElevenLabs when a key is configured). The caller is
    responsible for reading the API key from env (ELEVEN_API_KEY).

    `narrator_cfg`: when None, narration falls back to Anthropic + env-var
    key (legacy behaviour). When set, the chosen provider/model/key is used
    for every per-question narration call.
    """
    tts_cfg = tts or TTSConfig(engine="edge", voice=voice)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "_work"
    work.mkdir(exist_ok=True)
    q_imgs_dir = work / "q_imgs"
    s_imgs_dir = work / "s_imgs"

    progress("Extracting question images...")
    q_imgs, q_options = _render_question_images(question_pdf, q_imgs_dir)
    progress("Extracting solutions...")
    solutions = parse_solutions(solution_pdf, s_imgs_dir)

    prefix = name_prefix or question_pdf.stem
    return _render_all(q_imgs, solutions, out_dir, name_prefix=prefix, tts_cfg=tts_cfg,
                       narrator_cfg=narrator_cfg, language=language,
                       max_questions=max_questions, progress=progress, q_options=q_options)


def generate_from_qbg(unique_ids: list[str],
                      out_dir: Path,
                      *,
                      qbg_creds: tuple[str, str, str],
                      name_prefix: str | None = None,
                      voice: str = EDGE_DEFAULT_VOICE,
                      tts: TTSConfig | None = None,
                      narrator_cfg: NarratorConfig | None = None,
                      language: str = "en",
                      max_questions: int | None = None,
                      progress=lambda *_a, **_k: None) -> dict:
    """Same as generate(), but sources questions/solutions directly from QBG
    unique_ids instead of two uploaded PDFs (see qbg_source.py for the
    fetch + synthetic-docx-assembly step). Returns a report dict (not just a
    path list) so the caller can also surface missing_ids/skipped_unsupported
    and bundle the generated intermediate docs into the download ZIP.

    `qbg_creds`: (token, user, user_id) — the same three values the rest of
    the app's QBG features read from the caller's saved vault key.
    """
    import qbg_source

    tts_cfg = tts or TTSConfig(engine="edge", voice=voice)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "_work"
    work.mkdir(exist_ok=True)

    progress("Fetching questions from QBG...")
    token, user, user_id = qbg_creds
    result = qbg_source.build_from_qbg_ids(unique_ids, token, user, user_id, work / "qbg_source")

    if result.missing_ids:
        progress(f"{len(result.missing_ids)} id(s) not found in QBG: {', '.join(result.missing_ids)}")
    if result.skipped_unsupported:
        for s in result.skipped_unsupported:
            progress(f"Skipped {s['qbg_id']}: {s['reason']}")

    solutions = {
        n: ParsedSolution(qnum=n, answer=result.answers.get(n),
                          image_path=result.sol_imgs.get(n, Path("")), raw_text="")
        for n in result.q_imgs
    }

    prefix = name_prefix or (
        "qbg_" + unique_ids[0] + (f"_plus{len(unique_ids) - 1}" if len(unique_ids) > 1 else "")
    )
    written = _render_all(result.q_imgs, solutions, out_dir, name_prefix=prefix, tts_cfg=tts_cfg,
                          narrator_cfg=narrator_cfg, language=language,
                          max_questions=max_questions, progress=progress, q_options=None)
    return {
        "videos": written,
        "missing_ids": result.missing_ids,
        "skipped_unsupported": result.skipped_unsupported,
        "question_doc": result.question_doc_path,
        "solutions_doc": result.solutions_doc_path,
    }


def _stderr(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("questions_pdf", nargs="?", default=None,
                    help="Question PDF path. Omit when using --qbg-ids.")
    ap.add_argument("solutions_pdf", nargs="?", default=None,
                    help="Solutions PDF path. Omit when using --qbg-ids.")
    ap.add_argument("out_dir")
    ap.add_argument("--qbg-ids", default=None,
                    help="Comma/newline-separated QBG unique_ids — alternate "
                         "source to the two PDF positional args. Requires "
                         "QBG_TOKEN + QBG_USER_ID env vars (QBG_USER "
                         "optional, defaults to 'Qbg sub admin').")
    ap.add_argument(
        "--tts-engine",
        choices=["edge", "elevenlabs", "chatterbox"],
        default="edge",
        help=(
            "TTS backend.\n"
            "  edge        — free Microsoft Edge TTS (default, needs internet).\n"
            "  elevenlabs  — premium multilingual TTS incl. Hindi "
            "(needs ELEVEN_API_KEY + --voice <voice_id>).\n"
            "  chatterbox  — external OpenAI-compatible Chatterbox HTTP server "
            "(set --chatterbox-url, e.g. http://localhost:8004)."
        ),
    )
    ap.add_argument("--voice", default=EDGE_DEFAULT_VOICE,
                    help="Voice name (edge: e.g. hi-IN-SwaraNeural; "
                         "elevenlabs: voice_id; "
                         "chatterbox: voice name from server's /v1/voices).")
    ap.add_argument("--eleven-model", default=ELEVEN_DEFAULT_MODEL,
                    help="ElevenLabs model id (ignored for non-elevenlabs engines).")
    ap.add_argument("--chatterbox-url", default="http://localhost:8004",
                    help="Base URL of the external Chatterbox TTS HTTP server. "
                         "POSTs go to {url}/v1/audio/speech (OpenAI-compatible).")
    ap.add_argument("--chatterbox-model", default="",
                    help="Model id to request from the Chatterbox server "
                         "(see {url}/v1/models). Empty → server default.")
    ap.add_argument("--language", default="en",
                    help="Narration language: 'hi' for Hindi (Devanagari), "
                         "anything else for English.")
    ap.add_argument("--ai-provider", default="anthropic",
                    help="LLM provider used for narration. One of: "
                         "anthropic, gemini, openai, groq, grok, openrouter, "
                         "nvidia, fireworks, custom_openai, local, g4f.")
    ap.add_argument("--ai-model", default=None,
                    help="Model id for the chosen provider (e.g. "
                         "claude-sonnet-4-6, gemini-2.0-flash, gpt-4o).")
    ap.add_argument("--ai-base-url", default="",
                    help="Custom base URL — required for custom_openai and "
                         "local providers; ignored otherwise.")
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--max-questions", type=int, default=None,
                    help="Only render the first N questions (for testing).")
    args = ap.parse_args()

    # For Chatterbox, the model field carries the Chatterbox model id;
    # for ElevenLabs, it carries the ElevenLabs model id. Same TTSConfig.model
    # field, different source flag depending on which engine is selected.
    tts_model = (
        args.chatterbox_model if args.tts_engine == "chatterbox"
        else args.eleven_model
    )
    tts_cfg = TTSConfig(
        engine=args.tts_engine,
        voice=args.voice,
        model=tts_model,
        api_key=os.environ.get("ELEVEN_API_KEY", ""),
        base_url=args.chatterbox_url,
        # Forward narrator language to TTS too — for Chatterbox-multilingual
        # this picks the right phonemizer (hi → Hindi, en → English, etc.).
        language=args.language,
    )

    # AI_API_KEY env var holds the user's key for the chosen provider —
    # passed through by the Node lib so it never appears in `ps`/command logs.
    narrator_cfg = NarratorConfig(
        provider=args.ai_provider,
        model_id=args.ai_model or MODEL_DEFAULTS.get(args.ai_provider, ""),
        api_key=os.environ.get("AI_API_KEY", "")
                or os.environ.get("ANTHROPIC_API_KEY", ""),
        base_url=args.ai_base_url,
    )

    if args.qbg_ids:
        if args.questions_pdf or args.solutions_pdf:
            _stderr("Pass either questions_pdf+solutions_pdf OR --qbg-ids, not both.")
            sys.exit(2)
        token = os.environ.get("QBG_TOKEN", "").strip()
        user = os.environ.get("QBG_USER", "Qbg sub admin").strip()
        user_id = os.environ.get("QBG_USER_ID", "").strip()
        if not (token and user_id):
            _stderr("Set QBG_TOKEN and QBG_USER_ID env vars for --qbg-ids mode.")
            sys.exit(2)
        ids = [i.strip() for i in re.split(r"[\s,]+", args.qbg_ids) if i.strip()]
        report = generate_from_qbg(
            ids, Path(args.out_dir),
            qbg_creds=(token, user, user_id),
            name_prefix=args.prefix, tts=tts_cfg,
            narrator_cfg=narrator_cfg,
            language=args.language,
            max_questions=args.max_questions,
            progress=_stderr,
        )
        json.dump({
            "videos": [str(p) for p in report["videos"]],
            "missing_ids": report["missing_ids"],
            "skipped_unsupported": report["skipped_unsupported"],
            "question_doc": str(report["question_doc"]),
            "solutions_doc": str(report["solutions_doc"]),
        }, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        if not (args.questions_pdf and args.solutions_pdf):
            _stderr("Provide questions_pdf and solutions_pdf, or use --qbg-ids.")
            sys.exit(2)
        paths = generate(
            Path(args.questions_pdf), Path(args.solutions_pdf),
            Path(args.out_dir),
            name_prefix=args.prefix, tts=tts_cfg,
            narrator_cfg=narrator_cfg,
            language=args.language,
            max_questions=args.max_questions,
            progress=_stderr,
        )
        json.dump({"videos": [str(p) for p in paths]}, sys.stdout, indent=2)
        sys.stdout.write("\n")
