# -*- coding: utf-8 -*-
"""Format-pattern learning for QBG Ingestion — extract questions WITHOUT an AI model
when the uploaded Word file matches a format seen before.

How it works
------------
* A "spec" names one combination from a curated candidate library (question-start
  style x option-marker style). Parsing with a spec is fully deterministic regex work
  over the pandoc markdown (whose MathType equations mtef.py already turned into $..$).
* LEARN: after a successful AI extraction, every spec combo is parsed and scored
  against the AI's result (question count, answers, option counts). A spec that
  reproduces the AI's output is saved to patterns_data/specs.json.
* APPLY: on the next upload, saved specs are tried first; if one parses cleanly
  (internal validation — no AI needed to judge), the AI extraction step is skipped
  entirely. Anything that doesn't match falls back to the AI path unchanged.
"""
import os
import re
import json
import time

from logsetup import get_logger

log = get_logger("patterns")

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patterns_data")
_SPECS_PATH = os.path.join(_DIR, "specs.json")

# --------------------------------------------------------------------------- #
#  candidate library (spec stores the IDs, so parsing stays reproducible)
# --------------------------------------------------------------------------- #
Q_STYLES = {
    "bold_num": r"^\*\*(\d{1,3})\.\*\*\s*",          # **12.** question…
    "num_dot": r"^(\d{1,3})\.\s+",                    # 12. question…
    "q_num": r"^\*{0,2}Q\.?\s*(\d{1,3})\s*[.:)]\*{0,2}\s*",  # Q12. / Q.12:
}
OPT_STYLES = {
    "paren_num": (r"\\?\((\d)\\?\)", ["1", "2", "3", "4"]),
    "paren_alpha": (r"\\?\(([A-Da-d])\\?\)", ["A", "B", "C", "D"]),
}
# Answer-key line: **12. (3)** / 12. (B) / **21. (82)** (numerical) / **37.** **(25)**
_KEY_LINE = re.compile(
    r"^[>\s]*\*{0,2}(\d{1,3})\.?\*{0,2}\s*\*{0,2}(?:\\?\((-?\d+(?:\.\d+)?|[A-Da-d])\\?\)|"
    r"(-?\d+(?:\.\d+)?))\s*\*{0,2}\s*$")
_ANS_INLINE = re.compile(
    r"\*{0,2}Ans(?:wer)?\.?\*{0,2}\s*[:.]?\s*\\?\((\d|[A-Da-d])\\?\)", re.I)
# A worked solution that OPENS with its answer in bold parens: **21.** **(82)** work…
_BLOCK_LEAD_ANS = re.compile(r"^\s*\*{0,2}\\?\((-?\d+(?:\.\d+)?|[A-Da-d])\\?\)\*{0,2}\s*")
_SECTION = re.compile(r"^[>\s]*\*{1,3}\[?([^\]*]{4,80})\]?(?:\{[^}]*\})?\*{1,3}\s*$")
_IMG = re.compile(r"!\[[^\]]*\]\(([^)]+?)\)(\{[^}]*\})?")

_LETTER_BY_NUM = {"1": "A", "2": "B", "3": "C", "4": "D"}


def _norm_letter(v):
    v = (v or "").strip().upper()
    return _LETTER_BY_NUM.get(v, v if v in "ABCD" else v)


# --------------------------------------------------------------------------- #
#  markdown text -> [{"t":..},{"m":..}] parts
# --------------------------------------------------------------------------- #
_MD_JUNK = [
    (re.compile(r"\{\.[a-zA-Z-]+\}"), ""),           # {.underline} {.smallcaps}
    (re.compile(r"^\s*>\s?", re.M), ""),               # blockquote markers
    (re.compile(r"\\\r?$", re.M), ""),                 # pandoc hard line-break: trailing backslash
    (re.compile(r"\\ "), " "),                          # pandoc escaped space
    (re.compile(r"\\([()\[\]#'\"<>|~$%&_-])"), r"\1"),  # pandoc escapes
]
# Sub/superscripts. Bases may be identifiers OR numbers ("10^-8^", "10^10^"), and the
# exponent may use the unicode minus sign.
_SUBSUP = [
    (re.compile(r"\*([A-Za-z][A-Za-z0-9]{0,6})\*~([^~]{1,12})~"), r"$\1_{\2}$"),
    (re.compile(r"\*([A-Za-z][A-Za-z0-9]{0,6})\*\^([^^]{1,12})\^"), r"$\1^{\2}$"),
    (re.compile(r"(?<![\w$])([A-Za-z0-9]{1,7})~([^~]{1,12})~"), r"$\1_{\2}$"),
    (re.compile(r"(?<![\w$])([A-Za-z0-9]{1,7})\^([^^]{1,12})\^"), r"$\1^{\2}$"),
]
_UNI_MINUS = (u"−", "-")
# Word's autocorrect/spellcheck often splits a typed word into one <w:r> run PER
# LETTER (e.g. a squiggly-underline boundary mid-word), so pandoc emits each letter as
# its own emphasis span with no gap between them. Pandoc also ALTERNATES the "*"/"_"
# delimiter for touching spans (to avoid an ambiguous "**" reading), so real output
# looks like "*l*_o_*g*", not uniformly "*l**o**g*". Left alone, _ITAL_VAR below would
# treat each single letter as an isolated math variable, rendering "log" as three
# separate <i> tags. Merge any RUN of 2+ adjacent single-letter italics (either
# delimiter) back into one word BEFORE the single-letter -> math-variable conversion.
_ITAL_RUN = re.compile(r"(?:[*_][A-Za-z][*_]){2,}")
_ITAL_LETTER = re.compile(r"[*_]([A-Za-z])[*_]")
def _merge_ital_run(m):
    return "*" + "".join(_ITAL_LETTER.findall(m.group(0))) + "*"


# A merged word like "*log*" is still just a bare identifier to mathconv.is_struct
# ("log" has no "\log" token), so it renders letter-by-letter italic the same as before
# merging — the merge alone isn't enough. When the merged word IS a recognised math
# function name, emit the real backslash operator ("\log") with any attached
# sub/superscript folded in, so mathconv treats it as a structural function call
# (upright text, proper spacing) exactly like the AI-extraction path would.
_FUNC_NAMES = {"log", "ln", "sin", "cos", "tan", "cot", "sec", "csc",
              "lim", "min", "max", "exp", "det", "dim", "gcd", "mod"}
_FUNC_SUBSUP = re.compile(r"\*([A-Za-z]{2,5})\*(?:~([^~]{1,6})~)?(?:\^([^^]{1,8})\^)?")
def _func_repl(m):
    word = m.group(1)
    if word.lower() not in _FUNC_NAMES:
        return m.group(0)
    tex = "\\" + word.lower()
    if m.group(2):
        tex += "_{%s}" % m.group(2)
    if m.group(3):
        tex += "^{%s}" % m.group(3)
    return "$" + tex + "$"


_ITAL_VAR = re.compile(r"\*([A-Za-z])\*")             # *x* -> math var
_BOLD = re.compile(r"\*\*([^*]*)\*\*")
_ITAL = re.compile(r"\*([^*]*)\*")
# pandoc's smart-typography markdown writer renders a Word en-dash/minus glyph back as
# literal "--" (and em-dash as "---") in the source text — outside any $..$ span this
# reaches the reader as "x >--2" instead of "x > -2". Collapse any dash run to one "-".
_DASH_RUN = re.compile(r"-{2,}")


def _clean_text(t):
    t = t.replace(*_UNI_MINUS)
    for rx, rep in _MD_JUNK:
        t = rx.sub(rep, t)
    t = _ITAL_RUN.sub(_merge_ital_run, t)
    t = _FUNC_SUBSUP.sub(_func_repl, t)
    for rx, rep in _SUBSUP:
        t = rx.sub(rep, t)
    t = _ITAL_VAR.sub(r"$\1$", t)
    t = _BOLD.sub(r"\1", t)
    t = _ITAL.sub(r"\1", t)
    t = _DASH_RUN.sub("-", t)
    return t


_IMG_TOKEN = re.compile("\x00IMG\x00([^\x00]+)\x00")


def _norm_ws(s):
    """Collapse horizontal whitespace but KEEP line breaks as a single "\n" — a
    solution's reasoning steps are usually separate lines in the source Word file
    (manual line breaks or paragraphs), and htmlbuild.sol_code uses embedded "\n" to
    split the rendered solution back into separate <p> steps. Losing this (the earlier
    behaviour) glued every prose step between equations into one unbroken wall of text."""
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n[\n ]*", "\n", s)
    return s.strip(" \n")


def _to_parts(text, keep_images=False):
    """Split cleaned text on $...$ into [{"t":..},{"m":..}] parts. With keep_images,
    image references stay INLINE as {"img": basename} parts at their original position
    (a solution's diagram often belongs BEFORE its equations, not appended at the end)."""
    if keep_images:
        text = _IMG.sub(lambda m: "\x00IMG\x00%s\x00" % os.path.basename(m.group(1).strip()), text)
    text = _clean_text(text)

    def _text_parts(seg, parts):
        pos = 0
        for m in re.finditer(r"\$([^$]+)\$", seg):
            pre = seg[pos:m.start()]
            if pre.strip():
                parts.append({"t": _norm_ws(pre)})
            parts.append({"m": m.group(1).strip()})
            pos = m.end()
        tail = seg[pos:]
        if tail.strip():
            parts.append({"t": _norm_ws(tail)})

    parts = []
    pos = 0
    for im in _IMG_TOKEN.finditer(text):
        _text_parts(text[pos:im.start()], parts)
        parts.append({"img": im.group(1)})
        pos = im.end()
    _text_parts(text[pos:], parts)
    return parts or [{"t": ""}]


def _pull_images(text):
    """Remove image refs; return (text_without_images, [image_basenames])."""
    names = []

    def repl(m):
        names.append(os.path.basename(m.group(1).strip()))
        return " "

    return _IMG.sub(repl, text), names


def _section_type(header):
    h = header.lower()
    if "numerical" in h or "integer" in h:
        return "Numerical"
    if "one or more" in h or "multiple" in h or "multi" in h:
        return "MCQ"
    if "single" in h:
        return "SCQ"
    return None


# --------------------------------------------------------------------------- #
#  deterministic parse with one spec
# --------------------------------------------------------------------------- #
def parse_questions(md, spec):
    """Parse the question markdown with a spec. Returns a list of raw question dicts
    in the same shape the AI extractor emits (stem/options as parts, fig basename)."""
    q_rx = re.compile(Q_STYLES[spec["q_style"]])
    opt_rx_src, _labels = OPT_STYLES[spec["opt_style"]]
    opt_rx = re.compile(opt_rx_src)

    lines = [l.rstrip("\r") for l in md.split("\n")]
    # locate question starts + track section type headers
    blocks = []   # (num, [lines], qtype_at_start)
    cur = None
    cur_type = "SCQ"
    # Rescue matcher for a question whose number lost the spec's decoration — e.g. a
    # Word hard line-break glued "**27.** …\<br>28. next question…" so Q28's line has a
    # bare "28." header. Only fires for the EXACT next sequential number, so numbered
    # lists inside a question can't cause a false split.
    next_rx = re.compile(r"^(\d{1,3})\.\s+")
    for line in lines:
        sec = _SECTION.match(line)
        if sec and not q_rx.match(line):
            t = _section_type(sec.group(1))
            if t:
                cur_type = t
                continue
        s = line.strip()
        m = q_rx.match(s)
        if m:
            if cur:
                blocks.append(cur)
            cur = [int(m.group(1)), [s[m.end():]], cur_type]
            continue
        if cur:
            nm = next_rx.match(s)
            if nm and int(nm.group(1)) == cur[0] + 1:
                blocks.append(cur)
                cur = [int(nm.group(1)), [s[nm.end():]], cur_type]
                continue
            cur[1].append(line)
    if cur:
        blocks.append(cur)
    if not blocks:
        return []

    questions = []
    for num, blines, qtype in blocks:
        text = "\n".join(blines)
        # inline answer (rare in question files, common in combined files) — kept RAW
        answer = None
        am = _ANS_INLINE.search(text)
        if am:
            answer = am.group(1)
            text = text[:am.start()] + text[am.end():]

        # options: markers must appear in order 1..4 (or A..D). Images are pulled PER
        # SEGMENT afterwards so an option that is itself a graph/diagram survives as an
        # image option ({"img": name}) instead of being silently dropped.
        seq = ["1", "2", "3", "4"] if spec["opt_style"] == "paren_num" else ["A", "B", "C", "D"]
        marks = []
        want = 0
        for m in opt_rx.finditer(text):
            val = m.group(1).upper()
            if want < 4 and val == seq[want]:
                marks.append((m.start(), m.end()))
                want += 1
        if qtype == "Numerical" or len(marks) < 4:
            stem_txt, opts_txt = text, []
            qtype2 = "Numerical" if qtype == "Numerical" else (qtype if len(marks) >= 4 else "Numerical")
        else:
            stem_txt = text[:marks[0][0]]
            opts_txt = [text[marks[k][1]:(marks[k + 1][0] if k < 3 else len(text))] for k in range(4)]
            qtype2 = qtype

        stem_txt, stem_imgs = _pull_images(stem_txt)
        fig = stem_imgs[0] if stem_imgs else None
        options = []
        for o in opts_txt:
            o2, o_imgs = _pull_images(o)
            if o_imgs:
                options.append({"img": o_imgs[0]})   # graph/diagram option
            else:
                options.append(_to_parts(o2))

        questions.append({
            "num": num,
            "type": qtype2,
            "chapter": "",
            "stem": _to_parts(stem_txt),
            "fig": fig,
            "diagram_desc": None,
            "options": options,
            "answer": answer,
            "solution": None,
        })
    return questions


def parse_solutions(md, spec):
    """Parse the solutions markdown: answer key lines + numbered worked solutions.
    Returns {num_str: {"num": n, "answer": .., "solution": parts or None}}."""
    q_rx = re.compile(Q_STYLES[spec["q_style"]])
    out = {}
    lines = [l.rstrip("\r") for l in md.split("\n")]

    # 1) answer-key lines anywhere in the doc. Values are kept RAW (e.g. "3", "B",
    #    "82") — the ingest merge normalises them per question type (SCQ 1-4 -> A-D,
    #    Numerical keeps the number), so "(1)" is never mis-read as option A for a
    #    numerical question.
    for line in lines:
        km = _KEY_LINE.match(line.strip())
        if km:
            n = km.group(1)
            ans = km.group(2) if km.group(2) else km.group(3)
            rec = out.setdefault(n, {"num": int(n), "answer": None, "solution": None})
            if rec["answer"] is None:
                rec["answer"] = ans

    # 2) numbered solution blocks. TWO header styles observed in real files:
    #      "**19.** **(2)** work…"  (question-style header; leading bold answer)
    #      "**1. (1)**" + following content lines  (key-line style header)
    #    Key-style headers also matched pass 1, so the answer is already recorded;
    #    a block whose remaining text is empty simply records no solution.
    cur = None
    next_rx = re.compile(r"^(\d{1,3})\.\s+")
    for line in lines:
        s = line.strip()
        m = q_rx.match(s)
        if m:
            if cur:
                _finish_sol(out, cur)
            cur = [m.group(1), [s[m.end():]]]
            continue
        km = _KEY_LINE.match(s)
        if km:
            if cur:
                _finish_sol(out, cur)
            cur = [km.group(1), []]
            continue
        if cur:
            # next-sequential-number rescue (see parse_questions)
            nm = next_rx.match(s)
            if nm and nm.group(1).isdigit() and int(nm.group(1)) == int(cur[0]) + 1:
                _finish_sol(out, cur)
                cur = [nm.group(1), [s[nm.end():]]]
                continue
            cur[1].append(line)
    if cur:
        _finish_sol(out, cur)
    return out


def _finish_sol(out, cur):
    n, blines = cur
    text = "\n".join(blines)
    ans = None
    am = _ANS_INLINE.search(text)
    if am:
        ans = am.group(1)
    else:
        lead = _BLOCK_LEAD_ANS.match(text)
        if lead:
            ans = lead.group(1)
            text = text[lead.end():]
    text = re.sub(r"^\s*\*{0,2}Sol(?:ution)?\.?\*{0,2}\s*[:.]?\s*", "", text, flags=re.I)
    rec = out.setdefault(n, {"num": int(n), "answer": None, "solution": None})
    has_img = bool(_IMG.search(text))
    if text.strip() or has_img:
        # keep_images=True: diagrams stay INLINE at their original position in the parts
        rec["solution"] = _to_parts(text, keep_images=True)
    if rec["answer"] is None and ans:
        rec["answer"] = ans


# --------------------------------------------------------------------------- #
#  validation / learning / storage
# --------------------------------------------------------------------------- #
def _opt_nonempty(o):
    if isinstance(o, dict):
        return bool(o.get("img"))
    return any(str(p.get("t", p.get("m", ""))).strip() for p in (o or []))


def _wellformed_ratio(questions):
    if not questions:
        return 0.0
    ok = 0
    for q in questions:
        stem_len = sum(len(p.get("t", p.get("m", ""))) for p in q["stem"])
        opts_ok = (q["type"] == "Numerical" and not q["options"]) or (
            len(q["options"]) == 4 and all(_opt_nonempty(o) for o in q["options"]))
        if stem_len >= 10 and opts_ok:
            ok += 1
    return ok / len(questions)


def validate(questions, sols):
    """Internal validation for APPLY (no AI reference): enough questions, well-formed,
    and answers resolvable for most of them."""
    if len(questions) < 4:
        return False
    if _wellformed_ratio(questions) < 0.9:
        return False
    nums = [q["num"] for q in questions]
    if len(set(nums)) != len(nums):
        return False
    with_ans = sum(1 for q in questions
                   if q.get("answer") or (sols.get(str(q["num"])) or {}).get("answer"))
    return with_ans >= 0.7 * len(questions)


def _plain(parts):
    return re.sub(r"\s+", " ", " ".join(str(p.get("t", p.get("m", ""))) for p in (parts or []))).strip().lower()


def _score_against_ai(parsed, sols, ai_questions):
    """How well a spec's parse reproduces the AI's extraction on the SAME file."""
    if not parsed or not ai_questions:
        return 0.0
    by_num = {q["num"]: q for q in parsed}
    n_match = sum(1 for a in ai_questions if a.get("num") in by_num)
    count_score = n_match / max(len(ai_questions), len(parsed))
    ans_pairs = ans_agree = 0
    stem_pairs = stem_agree = 0
    for a in ai_questions:
        p = by_num.get(a.get("num"))
        if not p:
            continue
        a_ans = a.get("answer")
        p_ans = p.get("answer") or (sols.get(str(p["num"])) or {}).get("answer")
        if a_ans and p_ans and not isinstance(a_ans, list):
            ans_pairs += 1
            av = _norm_letter(str(a_ans)) if str(a_ans).strip().upper() in "ABCD1234" else str(a_ans).strip()
            pv = _norm_letter(str(p_ans)) if str(p_ans).strip().upper() in "ABCD1234" else str(p_ans).strip()
            if av.upper() == pv.upper():
                ans_agree += 1
        a_stem = _plain(a.get("stem"))[:40]
        p_stem = _plain(p.get("stem"))[:40]
        if a_stem and p_stem:
            stem_pairs += 1
            if a_stem[:20] == p_stem[:20]:
                stem_agree += 1
    ans_score = (ans_agree / ans_pairs) if ans_pairs else 1.0
    stem_score = (stem_agree / stem_pairs) if stem_pairs else 0.0
    return min(count_score, ans_score, stem_score)


def _load_specs():
    try:
        with open(_SPECS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_specs(specs):
    os.makedirs(_DIR, exist_ok=True)
    with open(_SPECS_PATH, "w", encoding="utf-8") as f:
        json.dump(specs, f, ensure_ascii=False, indent=1)


def learn(q_md, s_md, ai_questions, source_name=""):
    """After a successful AI extraction: find a spec that reproduces it and save it.
    Returns the spec id or None."""
    best = (0.0, None)
    for qs in Q_STYLES:
        for os_ in OPT_STYLES:
            spec = {"q_style": qs, "opt_style": os_}
            try:
                parsed = parse_questions(q_md, spec)
                sols = parse_solutions(s_md, spec)
            except Exception:
                continue
            score = _score_against_ai(parsed, sols, ai_questions)
            if score > best[0]:
                best = (score, spec)
    score, spec = best
    if not spec or score < 0.9:
        log.info("patterns.learn: no spec reproduced the AI output (best=%.2f)", score)
        return None
    spec_id = "%s/%s" % (spec["q_style"], spec["opt_style"])
    specs = _load_specs()
    for s in specs:
        if s["id"] == spec_id:
            s["seen"] = s.get("seen", 1) + 1
            s["last_source"] = source_name
            _save_specs(specs)
            return spec_id
    specs.append({"id": spec_id, "q_style": spec["q_style"], "opt_style": spec["opt_style"],
                  "score": round(score, 3), "learned_from": source_name,
                  "learned_at": time.strftime("%Y-%m-%d %H:%M"), "seen": 1})
    _save_specs(specs)
    log.info("patterns.learn: saved spec %s (score %.2f) from %s", spec_id, score, source_name)
    return spec_id


def apply_saved(q_md, s_md):
    """Try every saved spec against a new upload. Returns
    {questions, solutions, spec_id} on a clean match, else None."""
    for s in _load_specs():
        spec = {"q_style": s["q_style"], "opt_style": s["opt_style"]}
        try:
            parsed = parse_questions(q_md, spec)
            sols = parse_solutions(s_md, spec)
        except Exception:
            log.exception("patterns.apply: spec %s crashed", s.get("id"))
            continue
        if validate(parsed, sols):
            log.info("patterns.apply: matched spec %s — %d questions, no AI needed",
                     s["id"], len(parsed))
            return {"questions": parsed, "solutions": sols, "spec_id": s["id"]}
    return None
