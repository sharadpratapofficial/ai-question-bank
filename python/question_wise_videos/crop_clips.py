# -*- coding: utf-8 -*-
"""
crop_clips
==========

Cuts a source video into one clip per question, given the (possibly
user-edited) boundary list from detect_boundaries.py / the review UI.

Full re-encode per clip, not stream-copy: stream-copy snaps cut points to
the nearest keyframe, which can bleed several seconds of the previous/next
question's audio and video across the boundary. A full re-encode cuts at the
exact requested timestamp. Since each question's `end` is always the next
question's `start` (enforced by the review UI, never left as a gap), there
is neither a gap nor an overlap in the audio between consecutive clips.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

_FFMPEG = "ffmpeg"


def _fmt_ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def crop_question_clips(video_path: str | Path, questions: list[dict], out_dir: str | Path,
                        *, prefix: str = "Q", progress=lambda *_a: None) -> list[Path]:
    """`questions`: [{"index": int, "startSec": float, "endSec": float}, ...],
    already sorted and gap-free (caller's responsibility — the review UI
    enforces this). Returns the list of written clip paths, one per question,
    in the same order."""
    video_path = Path(video_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    total = len(questions)
    for n, q in enumerate(questions, 1):
        idx = int(q["index"])
        start = float(q["startSec"])
        end = float(q["endSec"])
        if end <= start:
            progress(f"Q{idx}: skipping — end <= start ({start}s -> {end}s)")
            continue
        out_path = out_dir / f"{prefix}{idx:02d}.mp4"
        progress(f"Cropping {n}/{total}: {out_path.name} ({_fmt_ts(start)} -> {_fmt_ts(end)})")
        cmd = [
            _FFMPEG, "-y",
            "-ss", _fmt_ts(start),
            "-to", _fmt_ts(end),
            "-i", str(video_path),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k",
            "-avoid_negative_ts", "make_zero",
            str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not out_path.exists():
            raise RuntimeError(f"ffmpeg crop failed for Q{idx}: {proc.stderr[-2000:]}")
        written.append(out_path)

    return written


if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(description="Crop a video into one clip per question.")
    ap.add_argument("video")
    ap.add_argument("questions_json", help="Path to a JSON file: [{index,startSec,endSec}, ...]")
    ap.add_argument("out_dir")
    ap.add_argument("--prefix", default="Q")
    args = ap.parse_args()

    def _progress(msg: str) -> None:
        print(msg, file=sys.stderr)

    with open(args.questions_json, encoding="utf-8") as f:
        questions = json.load(f)

    paths = crop_question_clips(args.video, questions, args.out_dir, prefix=args.prefix, progress=_progress)
    json.dump({"clips": [str(p) for p in paths]}, sys.stdout, indent=2)
    sys.stdout.write("\n")
