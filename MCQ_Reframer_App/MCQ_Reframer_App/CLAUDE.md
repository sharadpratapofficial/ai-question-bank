# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**MCQ Reframer** is a local Streamlit web app that turns a Word test (`.docx`) of
physics MCQs into:

1. An **interactive HTML folder** of *reframed* questions (rendered equations,
   per-field "copy MathML" buttons, side-by-side compare-with-original, diagrams as
   named files), and
2. Two **CSV exports** (`content` / `bilingual_options` / `solutions`) — one for the
   original questions and one for the reframed ones.

The actual rewording + fresh solutions are produced by an LLM. Two modes:
- **Automatic** — the app calls an AI API directly (OpenAI / Anthropic / Gemini / OpenRouter).
- **Assisted** — the app emits a prompt; the user runs it in Claude and pastes the JSON back.

## Expected input format

`.docx` laid out as: questions `1.`…`20.`, then an answer key with lines like `1. (B)`,
then `Text Solution:` blocks. Extraction keys off these patterns — if you change the
parser, keep those anchors working (`extract.py`).

## Run / dev

```bash
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt                   # pypandoc_binary bundles Pandoc
streamlit run app.py                              # opens http://localhost:8501
```

There is no test suite. To sanity-check a module without the UI, import it and feed a
small dict (see "Data shapes" below). Equation/CSV logic can be exercised headless.

## Architecture / data flow

```
.docx ──extract.py──> data{source_name, questions[], originals{N:(html,ans,sol)}, figdir, prompt}
                          │
            prompt ───────┴──> LLM (llm.py, automatic)  OR  user pastes JSON (assisted)
                          │
        reframed JSON ────┴──> htmlbuild.py ──> interactive HTML + zip (figures copied in)
                          └──> csvbuild.py  ──> original CSV (from `data`) + modified CSV (from JSON)
```

### Files
- `app.py` — Streamlit UI. 3 steps: upload→extract, choose reframe mode, build. Holds
  state in `st.session_state` keyed by the file's md5. Renders the CSV download +
  copy boxes (original CSV after extraction, modified CSV after build).
- `extract.py` — `extract(docx_path, workdir)`. Pandoc (`--mathml --extract-media`) →
  parses blocks; detects answer key / question starts / solutions; saves figures as
  `q{N}_figure.png` and image options `q{N}_opt{A-D}.png`; builds `originals` with
  base64-embedded images (for the HTML compare panel) and `options_html`; builds the
  LLM `prompt`.
- `htmlbuild.py` — `build_html(...)` + `write_project(...)`. Inline-base64 images for
  the self-contained preview; filename `src=` in the copyable code; PIL auto-sizes
  diagrams. Zips the folder.
- `csvbuild.py` — `build_csv(records)`, `original_records(data)`, `modified_records(questions, figdir)`.
  Emits the three JSON columns. **Images are written as empty `<img src="" />` tags**
  (no base64) via `_empty_imgs()` / `_img_tag()`.
- `mathconv.py` — the math core. `field_html`/`sol_code` produce editable HTML prose
  with inline MathML for equations; `l2h` (LaTeX→HTML, variables italic / units roman),
  `l2ml` (LaTeX→MathType-compatible MathML), `wrap_units`, `fix_mathml`.
- `llm.py` — `generate(provider, api_key, model, prompt)` over plain REST; `PROVIDERS`,
  `DEFAULT_MODEL`, `_extract_json` (strips ``` fences / finds the outer `{...}`).

### Data shapes
- **parts**: a list of `{"t": prose}` and `{"m": latex}` items. Used for stem, each
  option, and solution in the reframed JSON. `_parts()` normalizes to `('t'|'m', val)` tuples.
- **reframed JSON**: `{source_name, questions:[{chapter, stem(parts), fig|null,
  options:[parts | {"img":"q3_optA.png"}]×4, answer:"A", solution(parts)}]}`.
- **CSV cells** (JSON-encoded, `ensure_ascii=False`):
  - `content` → `{"english":"<p>…</p>"}`
  - `bilingual_options` → `{"english":[{"isCorrect":bool,"text":"<p>…</p>"}×4]}`
    (four `{"isCorrect":null,"text":null}` for numeric/no-option questions)
  - `solutions` → `[{"english":{"text":"<p>…</p>","videoSolution":{"type":0,"url":""},"otherSolution":"<p>--Not Available--</p>"}}]`

## Conventions / gotchas (important)
- **MathType-compatible MathML only**: no `display=` attribute, no outer `<mrow>`, and
  **no hex char refs** (`&#x…;`). Use named entities / decimal refs — `fix_mathml()`
  enforces this. Hex refs render as "null" in the team's editor; don't reintroduce them.
- **Variables italic, units roman**, with a space between value and unit. Unit wrapping
  lives in `wrap_units()` (`mathconv.py`); extend `_UNIT` there for new units.
- **CSV images must stay empty** (`<img src="" />`) — do not embed base64 in CSV cells.
- HTML templates use `.replace('__TOKEN__', …)`, not `%`/`.format`, because the CSS
  contains literal `%` and `{}`.
- Zips are written with Python `zipfile` to a fresh filename (sandbox can't always
  overwrite an existing zip).
- Always remind users to **spot-check the new answer key** — answers come from the model.

## When extending
- New output column/format → edit `csvbuild.py` only.
- New provider → add to `PROVIDERS`/`DEFAULT_MODEL` and a branch in `generate()` (`llm.py`).
- Different docx layout → adjust the regexes in `extract.py` (answer key, q-start, solution).
