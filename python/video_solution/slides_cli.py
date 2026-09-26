"""
Thin CLI wrapper around pdf_to_pptx.convert() / docx_to_pptx.convert() so the
Next.js API route can shell out to a single executable command:

    python slides_cli.py <input.pdf|input.docx|input.doc> <output.pptx>
    python slides_cli.py --qbg-ids "id1,id2,..." <output.pptx>

Dispatches on the input file's extension: .pdf goes through the PyMuPDF
column-crop pipeline, .docx/.doc goes through the LibreOffice-backed
docx pipeline (see docx_to_pptx.py). --qbg-ids fetches the questions from
QBG (see qbg_source.py), assembles a synthetic question-paper docx, and
hands it to the SAME docx_to_pptx.convert() unchanged — no separate
pptx-assembly code needed for the QBG-id source.

On success: exits 0, prints a JSON report to stdout
On failure: exits non-zero, prints error message to stderr
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path

from pdf_to_pptx import convert as convert_pdf
from docx_to_pptx import convert as convert_docx

DOCX_EXTS = {".docx", ".doc"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", default=None,
                    help="input.pdf|.docx|.doc — omit when using --qbg-ids")
    ap.add_argument("output", help="output .pptx path")
    ap.add_argument("--qbg-ids", default=None,
                    help="Comma/newline-separated QBG unique_ids — alternate "
                         "source to the input positional arg. Requires "
                         "QBG_TOKEN + QBG_USER_ID env vars (QBG_USER "
                         "optional, defaults to 'Qbg sub admin').")
    args = ap.parse_args()
    out_path = Path(args.output)

    if args.qbg_ids:
        if args.input:
            print("Pass either an input file OR --qbg-ids, not both.", file=sys.stderr)
            return 2
        token = os.environ.get("QBG_TOKEN", "").strip()
        user = os.environ.get("QBG_USER", "Qbg sub admin").strip()
        user_id = os.environ.get("QBG_USER_ID", "").strip()
        if not (token and user_id):
            print("Set QBG_TOKEN and QBG_USER_ID env vars for --qbg-ids mode.", file=sys.stderr)
            return 2
        ids = [i.strip() for i in re.split(r"[\s,]+", args.qbg_ids) if i.strip()]

        import qbg_source
        workdir = out_path.parent / (out_path.stem + "_qbg_source")
        try:
            result = qbg_source.build_from_qbg_ids(ids, token, user, user_id, workdir)
        except Exception:
            traceback.print_exc()
            return 1

        try:
            report = convert_docx(result.question_doc_path, out_path)
        except ValueError as e:
            print(f"convert rejected the input: {e}", file=sys.stderr)
            return 3
        except Exception:
            traceback.print_exc()
            return 1
        report["missing_ids"] = result.missing_ids
        report["skipped_unsupported"] = result.skipped_unsupported
        json.dump({"ok": True, "report": report, "path": str(out_path)}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    if not args.input:
        print("usage: slides_cli.py <input.pdf|input.docx|input.doc> <output.pptx>", file=sys.stderr)
        print("   or: slides_cli.py --qbg-ids <ids> <output.pptx>", file=sys.stderr)
        return 2
    in_path = Path(args.input)
    if not in_path.exists():
        print(f"input not found: {in_path}", file=sys.stderr)
        return 2
    convert = convert_docx if in_path.suffix.lower() in DOCX_EXTS else convert_pdf
    try:
        report = convert(in_path, out_path)
    except ValueError as e:
        print(f"convert rejected the input: {e}", file=sys.stderr)
        return 3
    except Exception:
        traceback.print_exc()
        return 1
    json.dump({"ok": True, "report": report, "path": str(out_path)}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
