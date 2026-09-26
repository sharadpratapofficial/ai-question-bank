# -*- coding: utf-8 -*-
"""
Thin CLI so the Next.js API route can shell out to a single executable
command, mirroring python/video_solution/slides_cli.py's shape:

    python cli.py detect <drive_url_or_local_path> <out_dir> [--fps 1.0] [--width 320]
    python cli.py crop <video_path> <questions.json> <out_dir> [--prefix Q]

`detect`: if the first arg is an existing local file path, it's used
directly (handy for testing/re-runs); otherwise it's treated as a Google
Drive share link/id and downloaded first via drive_download.py. Downloads
the video into <out_dir>/source.mp4, then runs detect_boundaries.detect_questions.

On success: exits 0, prints a JSON report to stdout. Progress goes to
stderr, line-buffered, exactly like the rest of this app's Python sidecars.
On failure: exits non-zero, prints the error to stderr.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

from detect_boundaries import detect_questions
from crop_clips import crop_question_clips
from drive_download import download_from_drive


def _stderr(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, flush=True, **kwargs)


def cmd_detect(args) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    source = Path(args.video)
    if source.exists():
        video_path = source
    else:
        _stderr("Downloading from Google Drive...")
        video_path = out_dir / "source.mp4"
        try:
            download_from_drive(args.video, video_path, progress=_stderr)
        except Exception as e:
            _stderr(f"Download failed: {e}")
            return 1

    try:
        result = detect_questions(
            video_path, out_dir, fps=args.fps, width=args.width,
            accuracy=getattr(args, "accuracy", "fast"), progress=_stderr,
        )
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1

    result["videoPath"] = str(video_path)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_crop(args) -> int:
    with open(args.questions_json, encoding="utf-8") as f:
        questions = json.load(f)
    try:
        clips = crop_question_clips(args.video, questions, args.out_dir, prefix=args.prefix, progress=_stderr)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1
    json.dump({"clips": [str(p) for p in clips]}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_detect = sub.add_parser("detect")
    p_detect.add_argument("video", help="Google Drive share link/id, or an existing local video path")
    p_detect.add_argument("out_dir")
    p_detect.add_argument("--fps", type=float, default=1.0)
    p_detect.add_argument("--width", type=int, default=320)
    p_detect.add_argument("--accuracy", choices=["fast", "high"], default="fast",
                          help="'high' OCRs each frame individually — slower but better on dense 2-digit numbers")

    p_crop = sub.add_parser("crop")
    p_crop.add_argument("video")
    p_crop.add_argument("questions_json")
    p_crop.add_argument("out_dir")
    p_crop.add_argument("--prefix", default="Q")

    args = ap.parse_args()
    if args.cmd == "detect":
        return cmd_detect(args)
    return cmd_crop(args)


if __name__ == "__main__":
    sys.exit(main())
