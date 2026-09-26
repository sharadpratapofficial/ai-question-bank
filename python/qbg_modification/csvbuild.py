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
from mathconv import field_html, sol_code, parts_to_html

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


# QBG's own PUT carries as many options as the question has — a five-option
# paper posts five entries (confirmed 2026-09-08 from the platform's request) —
# so nothing here truncates. Four remains the FLOOR, because a question with
# fewer real options still needs the four null slots the CSV format expects.
MAX_OPTIONS = 6


def _options_cell(options):
    """options: list of (isCorrect, text_html). Padded to four; never truncated
    below the number the paper actually has."""
    arr = []
    for c, t in (options or []):
        arr.append({"isCorrect": c, "text": t})
    while len(arr) < 4:
        arr.append({"isCorrect": None, "text": None})
    return json.dumps({"english": arr[:MAX_OPTIONS]}, ensure_ascii=False)


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
        elif "h" in p: out.append(("h", p["h"]))  # verbatim markup (HTML ingestion)
    return out


def _img_tag(name):
    # Empty img tag (no src/base64); filename kept as title hint only.
    return '<p><img title="%s" src="" /></p>' % name


def _matching_table_html(list1, list2):
    """Render a Matching_List question's List-I/List-II as a real HTML table (not an
    image) — each entry is {"label": "I", "parts": [{"t"/"m"}...]}. Rows pair by index;
    a shorter list just leaves the other column's cell blank for that row."""
    def cell(entry):
        label = (entry or {}).get("label") or ""
        body = parts_to_html(_parts((entry or {}).get("parts")))
        return "<td><b>%s.</b> %s</td>" % (label, body) if label else "<td>%s</td>" % body
    rows = []
    n = max(len(list1 or []), len(list2 or []))
    for i in range(n):
        e1 = list1[i] if i < len(list1 or []) else None
        e2 = list2[i] if i < len(list2 or []) else None
        rows.append("<tr>%s%s</tr>" % (cell(e1) if e1 else "<td></td>", cell(e2) if e2 else "<td></td>"))
    return "<table>" + "".join(rows) + "</table>"


def _ar_content_html(assertion, reason):
    """Render an Assertion_Reason question's assertion/reason as labeled paragraphs —
    each is a parts list like 'stem' (list of {"t"/"m"})."""
    a = parts_to_html(_parts(assertion))
    r = parts_to_html(_parts(reason))
    return "<p><b>Assertion (A):</b> %s</p><p><b>Reason (R):</b> %s</p>" % (a, r)


def _answer_letters(ans):
    """Normalise q['answer'] to the set of correct option letters. Accepts a single
    letter string (SCQ — the historical/only shape) or a list of letters (MCQ,
    multi-correct — added for QBG Ingestion, which unlike the reframer can encounter
    "one or more correct" questions)."""
    if isinstance(ans, (list, tuple, set)):
        return {str(a).strip().upper() for a in ans if str(a).strip()}
    s = (ans or "").strip().upper()
    return {s} if s else set()


def modified_records(questions, figdir=None):
    """questions: reframed JSON list with stem/options/answer/solution/fig."""
    recs = []
    LET = "ABCDEF"
    for q in questions:
        content = field_html(_parts(q.get("stem")))
        if q.get("list1") or q.get("list2"):
            # Matching_List (and any question whose stem carried a List-I/List-II
            # table — see extract.build_prompt's "stem contains a TABLE" rule):
            # render the lists as a real HTML table instead of relying on an image.
            content = content + "\n" + _matching_table_html(q.get("list1"), q.get("list2"))
        elif q.get("assertion") or q.get("reason"):
            # Assertion_Reason: append the labeled Assertion (A) / Reason (R)
            # paragraphs after any lead-in "stem" prose (often empty for this type).
            content = content + "\n" + _ar_content_html(q.get("assertion"), q.get("reason"))
        # The figure is appended INDEPENDENTLY of the above: a question can have
        # both a diagram and a table (e.g. a PV-diagram match-the-column), and
        # chaining this as `elif` silently dropped the diagram. For a true
        # Matching_List "fig" is already forced null upstream (cli.py), so this
        # can't resurrect the stale table image it used to guard against.
        if q.get("fig"):
            content = content + "\n" + _img_tag(q["fig"])
        ans_letters = _answer_letters(q.get("answer"))
        opts = q.get("options") or []
        options = []
        has_opts = bool(opts)
        for idx, opt in enumerate(opts[:MAX_OPTIONS]):
            if isinstance(opt, dict) and "img" in opt:
                text = _img_tag(opt["img"])
            else:
                text = field_html(_parts(opt))
            options.append((LET[idx] in ans_letters, text))
        # numeric questions sometimes have no options -> emit nulls
        if not has_opts:
            options = []
        # Solution parts may contain INLINE {"img": name} diagrams (QBG Ingestion) —
        # emit the title-tagged <img> at its original position so QBG shows the
        # diagram where the source file had it (and the push uploads it).
        segs = []
        buf = []
        for p in (q.get("solution") or []):
            if isinstance(p, dict) and p.get("img") and "t" not in p and "m" not in p:
                if buf:
                    segs.append(sol_code(_parts(buf)))
                    buf = []
                segs.append(_img_tag(p["img"]))
            else:
                buf.append(p)
        if buf:
            segs.append(sol_code(_parts(buf)))
        solution = "\n".join(s for s in segs if s)
        # For a no-options (Numerical) question, keep the AI's plain numeric answer
        # alongside the record — content/options/solution alone can't carry it, and
        # the QBG push needs it (see cli.py's _maybe_qbg_push -> qbg.ingest(answer=...)).
        rec = {"content": content, "options": options, "solution": solution}
        if not has_opts:
            rec["answer"] = q.get("answer")
        recs.append(rec)
    return recs
