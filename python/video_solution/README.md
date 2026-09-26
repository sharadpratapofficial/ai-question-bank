# Video Solution pipeline (Python sidecar)

Two CLI commands the Next.js API routes shell out to:

| Command | Purpose | Speed |
|---|---|---|
| `python slides_cli.py <question.pdf\|question.docx\|question.doc> <out.pptx>` | Convert a question paper into a `.pptx`, one cropped slide per question. PDFs go through the PyMuPDF 2-column crop pipeline (`pdf_to_pptx.py`); Word docs go through the LibreOffice-backed pipeline (`docx_to_pptx.py`), dispatched automatically by file extension. | ~5 seconds |
| `python slides_cli.py --qbg-ids "id1,id2,..." <out.pptx>` | Same output, sourced directly from QBG unique_ids instead of an uploaded file — fetches via `qbg_source.py`, assembles a synthetic question-paper docx, and hands it to the same `docx_to_pptx.convert()`. Requires `QBG_TOKEN`/`QBG_USER_ID` env vars (`QBG_USER` optional). | ~10 s |
| `python generate_videos.py <question.pdf> <solutions.pdf> <out_dir> [--prefix NAME] [--voice ID] [--max-questions N]` | Render one MP4 per question with Claude-narrated voice-over. Reads `ANTHROPIC_API_KEY` from env (falls back to a generic "Here is the solution to question N" script when missing). Prints progress to **stderr**, JSON summary to **stdout** on completion. | ~30 s / question |
| `python generate_videos.py --qbg-ids "id1,id2,..." <out_dir> [same flags]` | Same, sourced from QBG unique_ids instead of two uploaded PDFs — no "Hints and Solution" PDF needed, since QBG already has the answer and solution text for each question. Ids that fail to fetch, or are a type this pipeline doesn't support (Subjective/Comprehension), are skipped with a reason rather than failing the whole batch (see the `missing_ids`/`skipped_unsupported` fields in the JSON summary). | ~30 s / question |

## Install

```bash
# 1) Python 3.11+ (3.13 tested), ffmpeg, and LibreOffice on PATH
python -m pip install -r python/video_solution/requirements.txt

# 2) ffmpeg (used by generate_videos.py)
#    Windows:    winget install Gyan.FFmpeg
#    macOS:      brew install ffmpeg
#    Debian/Ubuntu: sudo apt install ffmpeg

# 3) LibreOffice (used by docx_to_pptx.py to render .docx/.doc question papers)
#    Windows:    winget install TheDocumentFoundation.LibreOffice
#    macOS:      brew install --cask libreoffice
#    Debian/Ubuntu: sudo apt install libreoffice
#    If `soffice` isn't on PATH, set QBG_SOFFICE to its full binary path.
```

### Why docx needs LibreOffice

The PDF path crops directly from rendered pixels, so it never needs to
understand Word formatting. A .docx question paper can contain native OMML
equations, embedded diagrams, and super/subscripts that only render correctly
through an actual Word-compatible layout engine — so `docx_to_pptx.py` forces
one question per page (`paragraph_format.page_break_before`) and shells out to
LibreOffice to produce a PDF, then reuses the same crop/branding pipeline as
`pdf_to_pptx.py` on that PDF.

### How the QBG-id source mode works

`qbg_source.py` fetches question/option/solution HTML directly from QBG
(reusing `qbg_modification/qbg.py`'s `qbg_extract()` for the fetch, image
download, and type classification — imported via an explicit `sys.path`
insert, since the two `python/` feature directories don't share an import
path), assembles it into two synthetic Word documents ("question paper" and
"solutions key", each question numbered `"N. "` to match
`docx_to_pptx.py`'s plain-text question-boundary detector) via
`pypandoc.convert_text(html, 'docx', ...)`, and renders both through
`docx_to_pptx.render_question_images()` — the exact same crop/trim/branded
slide pipeline the manual-docx upload path already uses. This is why a
QBG-sourced deck/video comes out in the same visual format without a
bespoke renderer, and why the answer is always known exactly (no OCR of an
answer-key page needed, unlike the PDF `solutions_parser.py` path).

## Invocation from Next.js

The Next.js routes (`/api/ai-tools/video-solution/slides`, `…/videos`) spawn
`python` as a subprocess with these CLIs. The path is resolved with
`process.env.QBG_PYTHON ?? "python"`, so if your `python` interpreter is
named differently (e.g. `python3.13` or a virtualenv), set `QBG_PYTHON` in
the deploy env.

The `ANTHROPIC_API_KEY` env var passed to the subprocess comes from the
user's per-account API key (Sidebar → Manage API Keys → Anthropic). The
server-side process inherits it for the lifetime of one request.

## Files

- `pdf_to_pptx.py` — question-paper PDF → cropped images → PPTX deck
- `docx_to_pptx.py` — question-paper .docx/.doc → LibreOffice → cropped images → PPTX deck (same style as pdf_to_pptx.py). Exposes `render_question_images()`, the per-question image step, reused directly by `qbg_source.py`.
- `qbg_source.py` — fetches questions by QBG unique_id, assembles a synthetic question-paper + solutions-key docx, renders both via `docx_to_pptx.render_question_images()`
- `slides_cli.py` — thin wrapper so the Next.js route can shell out (dispatches on file extension, or `--qbg-ids`)
- `solutions_parser.py` — parses "Hints and Solution" PDFs → per-question
  image + answer-key letter (PDF source path only — the QBG-id path already
  knows the answer directly, no OCR needed)
- `narrator.py` — Anthropic API call that returns the token-by-token
  narration / write-on-screen script
- `video_builder.py` — composes question image + per-step right-panel +
  Edge-TTS audio into a 1280×720 H.264 MP4
- `generate_videos.py` — orchestrator + CLI (`generate()` for the PDF source, `generate_from_qbg()` for the QBG-id source, sharing narration/TTS/render logic via `_render_all()`)
- `assets/PatrickHand-Regular.ttf` — handwriting font for the right panel
