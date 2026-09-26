# MCQ Reframer

A local web app that turns a Word test (`.docx`) into a self-contained **interactive HTML folder** of
*reframed* questions — with rendered equations, per-field "copy MathML code" buttons, a side-by-side
**compare-with-original** panel, and the diagrams saved as separate named files.

The wording change + new solutions are done by **Claude** (assisted flow): the app extracts the originals
and hands you a ready prompt; you run it in Claude and paste the JSON back; the app builds the folder.

---

## 1. Install (one time)

You need Python 3.9+.

```bash
cd MCQ_Reframer_App
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

`pypandoc_binary` bundles Pandoc, so you do **not** need to install Pandoc separately.

## 2. Run

```bash
streamlit run app.py
```

Your browser opens at `http://localhost:8501`.

## 3. Use it

1. **Upload** the `.docx` (format: questions 1–20, then an answer key like `1. (B)`, then `Text Solution:` blocks — same layout as the sample files).
2. Pick a **reframe mode**:

   **A) Automatic — call an AI API (one click):**
   - Choose a **provider**: OpenAI, Anthropic (Claude), Google Gemini, or OpenRouter.
   - Set the **model** (a sensible default is pre-filled) and paste your **API key** (used only for that one request, never stored).
   - Click **Generate with AI** → it reframes all questions and builds the folder automatically.

   **B) Assisted — no API key:**
   - Download/copy the **prompt**, paste it into Claude, copy the JSON it returns, paste it back, and click **Build HTML folder**.
3. **Download the ZIP** — it contains `<TestName>.html` plus the diagram PNGs. Open the HTML in any browser.

### API keys / models
- **OpenAI** — key from platform.openai.com; e.g. model `gpt-4o`.
- **Anthropic (Claude)** — key from console.anthropic.com; e.g. `claude-sonnet-4-6`.
- **Google Gemini** — key from aistudio.google.com; e.g. `gemini-1.5-pro`.
- **OpenRouter** — key from openrouter.ai; e.g. `anthropic/claude-3.5-sonnet` (one key, many models).

If a model name is rejected, just type a model your account has access to.

---

## CSV export (content / bilingual_options / solutions)

Two CSVs are offered, each downloadable **and** copyable from a code box:

- **`<TestName>_original.csv`** — appears right after extraction; the questions exactly as in the uploaded Word file.
- **`<TestName>_modified.csv`** — appears after building; the reframed questions.

Each row has three JSON columns:

- `content` → `{"english":"<p>…</p>"}`
- `bilingual_options` → `{"english":[{"isCorrect":true,"text":"<p>…</p>"}, …×4]}` (four `{"isCorrect":null,"text":null}` for numeric/no-option questions)
- `solutions` → `[{"english":{"text":"<p>…</p>","videoSolution":{"type":0,"url":""},"otherSolution":"<p>--Not Available--</p>"}}]`

## What the output contains

For each question: the modified **question / 4 options / answer / step-style solution**, each with a
**Copy code** button (HTML with inline MathML), a **⧉ Copy entire question** button, a **⇄ Compare with
original** toggle, and **red notes** naming the diagram file to upload. Variables render italic; units roman.

## Notes / limits

- The app expects the same document structure as your sample tests. If the answer key isn't found
  (lines like `1. (B)`), it will tell you.
- Match-lists or equations stored as *embedded objects* (not images) may not extract as figures; in those
  cases Claude can rebuild the list as text (the prompt allows this).
- **Always spot-check the new answer key** — the reframing/answers come from the model.

## Files

- `app.py` — Streamlit UI (3 steps).
- `extract.py` — docx → originals + diagrams + prompt (Pandoc).
- `htmlbuild.py` — reframed JSON → interactive HTML folder/zip.
- `csvbuild.py` — original/modified questions → content/bilingual_options/solutions CSV.
- `mathconv.py` — LaTeX → editable HTML / MathType MathML.
