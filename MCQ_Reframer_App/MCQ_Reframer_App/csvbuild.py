# -*- coding: utf-8 -*-
"""Build CSV (content / bilingual_options / solutions) for the ORIGINAL questions
(as extracted from the Word file) and for the MODIFIED/reframed questions.

Cell formats (each cell is a JSON string, UTF-8, ensure_ascii=False):
  content          -> {"english":"<p>...</p>"}
  bilingual_options-> {"english":[{"isCorrect":true,"text":"<p>..</p>"}, ...x4]}
                      (or four {"isCorrect":null,"text":null} for numeric/no-option questions)
  solutions        -> [{"english":{"text":"<p>..</p>",
                        "videoSolution":{"type":0,"url":""},
                        "otherSolution":"<p>--Not Available--</p>"}}]
"""
import io, csv, json, os, re
from mathconv import field_html, sol_code

HEADER = ["content", "bilingual_options", "solutions"]
_NA = "<p>--Not Available--</p>"

# Blank out every <img> src (drops base64 data-URIs) -> empty img tag.
_IMG_SRC = re.compile(r'(<img\b[^>]*?\bsrc=")[^"]*(")', re.I)
def _empty_imgs(html):
    if not html:
        return html
    return _IMG_SRC.sub(r'\1\2', html)


def _content_cell(html):
    return json.dumps({"english": html or ""}, ensure_ascii=False)


def _options_cell(options):
    """options: list of (isCorrect, text_html). Empty/short -> four null entries."""
    arr = []
    for c, t in (options or []):
        arr.append({"isCorrect": c, "text": t})
    while len(arr) < 4:
        arr.append({"isCorrect": None, "text": None})
    return json.dumps({"english": arr[:4]}, ensure_ascii=False)


def _solution_cell(html):
    obj = [{"english": {"text": html or "",
                        "videoSolution": {"type": 0, "url": ""},
                        "otherSolution": _NA}}]
    return json.dumps(obj, ensure_ascii=False)


def build_csv(records):
    """records: list of dicts {content, options:[(isCorrect,text)...], solution}. -> CSV string."""
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    w.writerow(HEADER)
    for r in records:
        w.writerow([_content_cell(r.get("content", "")),
                    _options_cell(r.get("options")),
                    _solution_cell(r.get("solution", ""))])
    return buf.getvalue()


# ----------------- ORIGINAL questions (from extract()) -----------------
def original_records(data):
    """Uses data['originals'][N]=(q_html, ans_letter, sol_html) and
    data['questions'][i]['options_html'] + answer letter."""
    recs = []
    originals = data["originals"]
    by_num = {q["num"]: q for q in data["questions"]}
    for N in sorted(originals):
        q_html, ans, sol_html = originals[N]
        q = by_num.get(N, {})
        opt_html = q.get("options_html") or []
        ans_idx = "ABCD".find(ans) if ans else -1
        options = []
        if opt_html:
            for idx, oh in enumerate(opt_html[:4]):
                options.append((idx == ans_idx, _empty_imgs(oh)))
        # if no options parsed -> leave empty so _options_cell emits four nulls
        recs.append({"content": _empty_imgs(q_html), "options": options,
                     "solution": _empty_imgs(sol_html)})
    return recs


# ----------------- MODIFIED questions (reframed JSON) -----------------
def _parts(x):
    out = []
    for p in (x or []):
        if "t" in p: out.append(("t", p["t"]))
        elif "m" in p: out.append(("m", p["m"]))
    return out


def _img_tag(name):
    # Empty img tag (no src/base64); filename kept as title hint only.
    return '<p><img title="%s" src="" /></p>' % name


def modified_records(questions, figdir=None):
    """questions: reframed JSON list with stem/options/answer/solution/fig."""
    recs = []
    LET = "ABCD"
    for q in questions:
        content = field_html(_parts(q.get("stem")))
        if q.get("fig"):
            content = content + "\n" + _img_tag(q["fig"])
        ans = (q.get("answer") or "").strip().upper()
        ans_idx = LET.find(ans) if ans else -1
        opts = q.get("options") or []
        options = []
        has_opts = bool(opts)
        for idx, opt in enumerate(opts[:4]):
            if isinstance(opt, dict) and "img" in opt:
                text = _img_tag(opt["img"])
            else:
                text = field_html(_parts(opt))
            options.append((idx == ans_idx, text))
        # numeric questions sometimes have no options -> emit nulls
        if not has_opts:
            options = []
        solution = sol_code(_parts(q.get("solution")))
        recs.append({"content": content, "options": options, "solution": solution})
    return recs
