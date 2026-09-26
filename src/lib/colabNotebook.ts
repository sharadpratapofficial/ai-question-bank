/**
 * Generates a runnable Google Colab notebook (.ipynb) that detects
 * per-question TIMESTAMPS in a lecture recording, using Colab's own free
 * compute. No Google Drive mount is involved (that step was unreliable) —
 * the source video is fetched from its public share link, everything runs in
 * Colab's local /content storage, and the resulting timestamps.csv is both
 * printed inline (to copy) and auto-downloaded to the user's computer.
 *
 * Clip cutting is intentionally OFF for now (a separate tool cuts the video
 * from these timestamps); the notebook stops after writing timestamps.csv.
 * The crop step can be re-added later — crop_clips.py still lives in
 * python/question_wise_videos/.
 *
 * The notebook embeds the SAME Python source this app's server path runs
 * (passed in by the caller, read fresh off disk) via `%%writefile` cells —
 * one already-validated implementation, no separate copy to maintain.
 */

interface BuildNotebookArgs {
    driveUrl: string;
    accuracy?: "fast" | "high";
    detectBoundariesSource: string;
    driveDownloadSource: string;
}

function toSourceLines(text: string): string[] {
    const lines = text.split("\n");
    return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

function markdownCell(text: string) {
    return { cell_type: "markdown", metadata: {}, source: toSourceLines(text) };
}

function codeCell(text: string) {
    return { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: toSourceLines(text) };
}

export function buildColabNotebook(args: BuildNotebookArgs): object {
    // Colab renders `variable = "value" #@param {type:"string"}` as an editable
    // form field in the cell UI, so the Drive link can be pasted directly in
    // the notebook — no need to regenerate it from the app for a different
    // video. JSON.stringify gives a safe Python string literal.
    const driveUrlLiteral = JSON.stringify(args.driveUrl || "");
    const accuracyLiteral = JSON.stringify(args.accuracy || "fast");
    const endModeLiteral = JSON.stringify("silence");
    const aiKeyLiteral = JSON.stringify("");
    const aiModelLiteral = JSON.stringify("gpt-4o-mini");
    const aiBaseLiteral = JSON.stringify("https://api.openai.com/v1");

    const cells: unknown[] = [
        markdownCell(
            "# Question Wise Videos — timestamps\n\n" +
                "Detects the **per-question timestamps** in a lecture recording, on Colab's own " +
                "free compute. No Google Drive sign-in needed. **Paste your Drive video link " +
                "into the `DRIVE_URL` box in the Settings cell below**, then run the cells top " +
                "to bottom (Runtime → Run all).\n\n" +
                "The last cell prints the `timestamps.csv` (one row per question, with " +
                "`start`/`end`) so you can copy it, and also auto-downloads the file to your " +
                "computer. Each question's `end` is set to when the teacher finishes it — the " +
                "**silent gap before the next question is trimmed off**, so the next question's " +
                "slide isn't included at the boundary and the clip doesn't sit on a dead pause. " +
                "Feed the CSV to your own cutter.\n\n" +
                "_Clip cutting inside this notebook is turned off for now; it can be re-enabled " +
                "later._"
        ),
        codeCell(
            "#@title ⚙️ Settings — paste your Google Drive video link here { display-mode: \"form\" }\n" +
                `DRIVE_URL = ${driveUrlLiteral} #@param {type:"string"}\n` +
                `ACCURACY = ${accuracyLiteral} #@param ["fast", "high"]\n` +
                "#@markdown `high` reads each frame's number individually — slower, but better on videos with 2-digit question numbers.\n" +
                "#@markdown\n" +
                `END_MODE = ${endModeLiteral} #@param ["silence", "ai"]\n` +
                "#@markdown How each question's **end** is set. `silence` (free, default) ends it when the teacher stops talking, trimming the silent gap before the next question. `ai` additionally transcribes the audio (free Colab GPU) and uses **one** AI call to pin the exact moment the teacher moves on — best when the teacher talks continuously into the next slide with no pause to detect. `ai` needs an API key below.\n" +
                `AI_API_KEY = ${aiKeyLiteral} #@param {type:"string"}\n` +
                `AI_MODEL = ${aiModelLiteral} #@param {type:"string"}\n` +
                `AI_BASE_URL = ${aiBaseLiteral} #@param {type:"string"}\n` +
                "#@markdown For `ai` mode only — an OpenAI-compatible chat endpoint. Defaults to OpenAI. To use Claude, point `AI_BASE_URL` at a compatible gateway (e.g. OpenRouter `https://openrouter.ai/api/v1`) and set `AI_MODEL` (e.g. `anthropic/claude-sonnet-4`). For `ai` mode, enable a GPU runtime (Runtime → Change runtime type → GPU) so transcription is fast.\n" +
                "#@markdown\n" +
                "#@markdown Then run every cell top to bottom (Runtime → Run all, or ▶ on each).\n" +
                "assert DRIVE_URL.strip(), 'Paste a Google Drive share link into DRIVE_URL above.'\n" +
                "assert END_MODE != 'ai' or AI_API_KEY.strip(), 'END_MODE is \"ai\" but AI_API_KEY is empty — paste a key, or set END_MODE=\"silence\".'\n" +
                "print('Settings set (accuracy=' + ACCURACY + ', end_mode=' + END_MODE + '). Now run the cells below in order.')"
        ),
        codeCell(
            "#@title 1. Install dependencies\n" +
                "!apt-get -qq install -y tesseract-ocr ffmpeg\n" +
                "!pip -q install opencv-python-headless numpy requests pytesseract Pillow"
        ),
        codeCell(`#@title 2a. detect_boundaries.py\n%%writefile detect_boundaries.py\n${args.detectBoundariesSource}`),
        codeCell(`#@title 2b. drive_download.py\n%%writefile drive_download.py\n${args.driveDownloadSource}`),
        codeCell(
            "#@title 3. Download the source video\n" +
                "import os\n" +
                "from pathlib import Path\n" +
                "from drive_download import download_from_drive\n\n" +
                "def _progress(msg):\n" +
                "    print(msg)\n\n" +
                "OUTPUT_DIR = '/content/output'\n" +
                "os.makedirs(OUTPUT_DIR, exist_ok=True)\n" +
                "video_path = Path(OUTPUT_DIR) / 'source.mp4'\n" +
                "download_from_drive(DRIVE_URL, video_path, progress=_progress)"
        ),
        codeCell(
            "#@title 4. Detect question boundaries\n" +
                "from detect_boundaries import detect_questions\n\n" +
                "result = detect_questions(video_path, OUTPUT_DIR, accuracy=ACCURACY, progress=_progress)\n" +
                "questions = [{'index': q['index'], 'startSec': q['startSec'], 'endSec': q['endSec']} for q in result['questions']]\n" +
                'print(f"\\n{len(questions)} question(s) detected:")\n' +
                "for q in questions:\n" +
                "    print(q)"
        ),
        codeCell(
            "#@title 5. (optional) Review / edit boundaries before saving\n" +
                "# Example fixes:\n" +
                "#   drop a spurious split:      questions = [q for q in questions if q['index'] != 4]\n" +
                "#   nudge a start time (sec):   questions[2]['startSec'] = 185\n" +
                "questions"
        ),
        codeCell(
            "#@title 5b. (optional) AI end refinement — only runs when END_MODE == \"ai\"\n" +
                "# Silence mode already trimmed the gap. AI mode additionally reads the lecture\n" +
                "# transcript and asks ONE AI call to pin the exact second the teacher finishes\n" +
                "# each question — for lectures where the teacher talks continuously into the\n" +
                "# next slide and there is no silent gap to detect. Transcription runs on\n" +
                "# Colab's free GPU (enable a GPU runtime for speed).\n" +
                "if END_MODE == 'ai':\n" +
                "    assert AI_API_KEY.strip(), 'END_MODE is \"ai\" but AI_API_KEY is empty.'\n" +
                "    import json, subprocess, sys, urllib.request\n" +
                "    print('Installing faster-whisper (first run downloads the model)...')\n" +
                "    subprocess.run([sys.executable, '-m', 'pip', '-q', 'install', 'faster-whisper'], check=True)\n" +
                "    from faster_whisper import WhisperModel\n" +
                "    try:\n" +
                "        import torch\n" +
                "        _dev = 'cuda' if torch.cuda.is_available() else 'cpu'\n" +
                "    except Exception:\n" +
                "        _dev = 'cpu'\n" +
                "    _ctype = 'int8_float16' if _dev == 'cuda' else 'int8'\n" +
                "    if _dev == 'cpu':\n" +
                "        print('WARNING: no GPU — transcription will be slow. Runtime -> Change runtime type -> GPU.')\n" +
                "    print(f'Transcribing audio on {_dev} (this is the slow part)...')\n" +
                "    _model = WhisperModel('small', device=_dev, compute_type=_ctype)\n" +
                "    _segs, _info = _model.transcribe(str(video_path), vad_filter=True)\n" +
                "    transcript = [(round(float(s.start), 1), s.text.strip()) for s in _segs if s.text.strip()]\n" +
                "    print(f'{len(transcript)} transcript segments.')\n" +
                "    qs = sorted(questions, key=lambda q: q['startSec'])\n" +
                "    # Compact per-boundary context: transcript lines in the window where the\n" +
                "    # teacher wraps up the current question and starts the next.\n" +
                "    def _ctx(lo, hi):\n" +
                "        return [[t, txt] for (t, txt) in transcript if lo <= t <= hi]\n" +
                "    boundaries = []\n" +
                "    for i, q in enumerate(qs):\n" +
                "        nxt = int(qs[i + 1]['startSec']) if i + 1 < len(qs) else int(q['endSec'])\n" +
                "        lo = max(int(q['startSec']), nxt - 90)\n" +
                "        boundaries.append({'index': q['index'], 'question_start': int(q['startSec']),\n" +
                "                           'next_question_start': nxt, 'transcript': _ctx(lo, nxt + 15)})\n" +
                "    sys_prompt = ('You are given transcript excerpts from a lecture where a teacher solves numbered '\n" +
                "                  'questions one after another. For each boundary the transcript lines are [seconds, text]. '\n" +
                "                  'Find the second at which the teacher FINISHES the current question and is about to move '\n" +
                "                  'to the next (cues: \"next question\", \"moving on\", \"question 12\", \"so this was\"). '\n" +
                "                  'Return STRICT JSON only, no prose: {\"ends\": {\"<index>\": <end_seconds_int>, ...}}. '\n" +
                "                  'Each end must be > its question_start and <= its next_question_start.')\n" +
                "    body = json.dumps({'model': AI_MODEL, 'temperature': 0,\n" +
                "                       'messages': [{'role': 'system', 'content': sys_prompt},\n" +
                "                                    {'role': 'user', 'content': json.dumps({'boundaries': boundaries})}]}).encode()\n" +
                "    req = urllib.request.Request(AI_BASE_URL.rstrip('/') + '/chat/completions', data=body,\n" +
                "                                 headers={'Authorization': 'Bearer ' + AI_API_KEY.strip(),\n" +
                "                                          'Content-Type': 'application/json'})\n" +
                "    try:\n" +
                "        with urllib.request.urlopen(req, timeout=180) as r:\n" +
                "            resp = json.loads(r.read().decode())\n" +
                "        content = resp['choices'][0]['message']['content']\n" +
                "        ends = json.loads(content[content.find('{'): content.rfind('}') + 1]).get('ends', {})\n" +
                "        applied = 0\n" +
                "        for i, q in enumerate(qs):\n" +
                "            v = ends.get(str(q['index']))\n" +
                "            if v is None:\n" +
                "                continue\n" +
                "            nxt = int(qs[i + 1]['startSec']) if i + 1 < len(qs) else int(q['endSec'])\n" +
                "            q['endSec'] = max(int(q['startSec']) + 1, min(int(v), nxt))\n" +
                "            applied += 1\n" +
                "        questions = qs\n" +
                "        print(f'AI refined {applied} end time(s).')\n" +
                "    except Exception as _e:\n" +
                "        print('(AI end refinement failed — keeping silence-based ends.)', _e)\n" +
                "else:\n" +
                "    print('END_MODE=\"silence\" — using silence-trimmed ends (no AI call).')"
        ),
        codeCell(
            "#@title 6. Timestamps — copy below and/or download the CSV\n" +
                "import csv\n\n" +
                "def _fmt_ts(seconds):\n" +
                "    seconds = int(seconds)\n" +
                "    h, rem = divmod(seconds, 3600)\n" +
                "    m, s = divmod(rem, 60)\n" +
                "    return f'{h:02d}:{m:02d}:{s:02d}' if h else f'{m:02d}:{s:02d}'\n\n" +
                "# Sort by start time. Each question's `end` is the detected end, which already\n" +
                "# stops when the teacher finishes and BEFORE the next question's slide appears\n" +
                "# (the silent transition gap is trimmed out), so the next question's frame is\n" +
                "# not included at the boundary. Guard against any end spilling into the next\n" +
                "# question's start just in case.\n" +
                "questions = sorted(questions, key=lambda q: q['startSec'])\n" +
                "rows = []\n" +
                "for i, q in enumerate(questions):\n" +
                "    start = int(q['startSec'])\n" +
                "    end = int(q['endSec'])\n" +
                "    if i + 1 < len(questions):\n" +
                "        end = min(end, int(questions[i + 1]['startSec']) - 1)\n" +
                "    end = max(start, end)\n" +
                "    rows.append((q['index'], start, end))\n\n" +
                "csv_path = '/content/timestamps.csv'\n" +
                "with open(csv_path, 'w', newline='') as f:\n" +
                "    w = csv.writer(f)\n" +
                "    w.writerow(['index', 'start', 'end', 'start_seconds', 'end_seconds'])\n" +
                "    for idx, start, end in rows:\n" +
                "        w.writerow([idx, _fmt_ts(start), _fmt_ts(end), start, end])\n\n" +
                "# 1) Print the CSV so you can select-and-copy it directly.\n" +
                "print('===== timestamps.csv (copy from here) =====')\n" +
                "print(open(csv_path).read())\n" +
                "print('===========================================')\n\n" +
                "# 2) Show it as a table for easy reading.\n" +
                "try:\n" +
                "    import pandas as pd\n" +
                "    from IPython.display import display\n" +
                "    display(pd.DataFrame([\n" +
                "        {'index': idx, 'start': _fmt_ts(start), 'end': _fmt_ts(end),\n" +
                "         'start_seconds': start, 'end_seconds': end}\n" +
                "        for idx, start, end in rows\n" +
                "    ]))\n" +
                "except Exception:\n" +
                "    pass\n\n" +
                "# 3) Auto-download the CSV file to your computer.\n" +
                "try:\n" +
                "    from google.colab import files\n" +
                "    files.download(csv_path)\n" +
                "except Exception as _e:\n" +
                "    print('(Auto-download skipped — just copy the CSV text printed above.)', _e)"
        ),
    ];

    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            colab: { provenance: [], name: "question-wise-videos.ipynb" },
            kernelspec: { name: "python3", display_name: "Python 3" },
            language_info: { name: "python" },
        },
        cells,
    };
}
