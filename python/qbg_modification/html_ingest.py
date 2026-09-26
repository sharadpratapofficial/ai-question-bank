# -*- coding: utf-8 -*-
"""
Deterministic ingestion of a QBG-ready HTML paper — no AI model, no tokens.

A .docx has to be read by a model because its structure is typographic: what
makes a line an option is that it *looks* like one. The HTML papers this module
reads are already structured, so nothing has to be guessed:

    <h2>Question 3</h2>          the question, and its number
      <p>…</p>                     stem
      <p><strong>(A)</strong> …</p>  option A — content on this line, or on the
                                     next block, up to the (B) marker
      <figure><img src="data:…">   the question's diagram (may sit after the
      <p><img src="data:…"></p>      options; it still belongs to the question)
    <h2>Solution 3 Question 3</h2>
      <p><strong>Verified Correct Answer: Option (C)</strong></p>
      <h3>Effective Approach</h3>          }
      <h3>Detailed Solution</h3>           } the solution's sections, whatever
      <h3>Domain and Consistency Checks</h3>  they are named
      <h3>Wrong Answer Analysis</h3>

Both RankUp house layouts are read by the same code: the section names are not
hardcoded (only "Detailed Solution" is, to pick the working out when rich mode
is off), the option marker may be bold or plain and may carry its content or
hand it to the next block, and the answer line may say "(C)" or "Option (C)".

Inline formatting is carried through as well — <strong>/<em> become <b>/<i>,
which survive QBG's sanitiser where the originals did not (2026-09-06 report).

The maths matters as much as the structure: these files carry presentation
MathML that QBG accepts as-is, so it is passed through verbatim as an "h" part
rather than being round-tripped through LaTeX, which would lose exactly the
markup that made the file worth using.

Output is the same question shape ingest_extract builds from a .docx, so
everything downstream — the review pack, the CSV, the QBG push — is unchanged.

Returns None when the file is not in this shape, which is the caller's cue to
fall back to the ordinary AI path.
"""
import base64
import binascii
import logging
import os
import re

from bs4 import BeautifulSoup, NavigableString, Tag

log = logging.getLogger("qbg.html_ingest")

_LET = ["A", "B", "C", "D", "E", "F"]

# "Question 3", "Q3", "Question 3 (Single Correct)"
_Q_HEAD = re.compile(r"^\s*(?:question|ques\.?|q)\s*[:.\-]?\s*(\d+)", re.I)
# "Solution 3", "Solution 3 Question 3", "Answer 3"
_S_HEAD = re.compile(r"^\s*(?:solution|answer|sol)\D{0,12}?(\d+)", re.I)
# "(A)", "(A)." or "A)" at the start of a line
_OPT_MARK = re.compile(r"^\s*\(?\s*([A-F])\s*\)\s*[.:]?\s*", re.I)
_ANSWER_LINE = re.compile(r"(verified\s+correct\s+answer|correct\s+answer|answer\s*key)\s*[:\-]?", re.I)
_ANSWER_VALUE = re.compile(r"\(?\s*([A-F])\s*\)|(-?\d+(?:\.\d+)?)")

# Section headings kept when rich mode is off — the working, and nothing else.
_DETAILED = re.compile(r"detailed\s+solution|solution\s*$|working", re.I)
# Lines that are metadata about the solution rather than part of it.
_SKIP_LINE = re.compile(r"^\s*(ideal\s+time|time\s+to\s+solve|difficulty)\s*[:\-]", re.I)

_DATA_URI = re.compile(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$", re.S)


def looks_like_html(path):
    """True for a file this module should be offered — by extension only; whether
    it is really in the expected shape is decided by parse_html_paper."""
    return os.path.splitext(path)[1].lower() in (".html", ".htm", ".xhtml")


# --------------------------------------------------------------------------- #
#  inline parts
# --------------------------------------------------------------------------- #
def _clean(text):
    """Collapse HTML whitespace, keeping the single spaces that separate words."""
    return re.sub(r"\s+", " ", text or "")


def _save_data_uri(src, figdir, name):
    """Write a data: URI image into figdir. Returns the file name, or None."""
    m = _DATA_URI.match((src or "").strip())
    if not m:
        return None
    ext = m.group(1).lower()
    if ext == "jpeg":
        ext = "jpg"
    if ext == "svg+xml":
        ext = "svg"
    try:
        blob = base64.b64decode(re.sub(r"\s+", "", m.group(2)), validate=False)
    except (binascii.Error, ValueError):
        log.warning("html_ingest: undecodable data URI for %s", name)
        return None
    if not blob:
        return None
    fname = "%s.%s" % (name, ext if ext in ("png", "jpg", "gif", "webp", "svg") else "png")
    try:
        with open(os.path.join(figdir, fname), "wb") as f:
            f.write(blob)
    except OSError:
        log.exception("html_ingest: could not write %s", fname)
        return None
    return fname


# Inline formatting worth carrying into QBG. <strong>/<em> are rewritten to the
# legacy <b>/<i>: the paper's own bold was arriving in QBG stripped (2026-09-06
# report), and <b>/<i> survive the sanitisers that drop <strong>/<em>.
_INLINE_WRAP = {"strong": "b", "b": "b", "em": "i", "i": "i", "u": "u",
                "sub": "sub", "sup": "sup", "mark": "b", "s": "s"}

# Matches mathconv._esc, so text inside a wrapper is escaped exactly as a plain
# "t" part would have been.
def _esc(text):
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _parts_to_markup(parts):
    """Render parts to one HTML fragment: prose escaped, MathML verbatim.

    None when an image is in there — a figure is a file reference resolved later,
    so it cannot be folded into a markup string."""
    out = []
    for p in parts:
        if "img" in p:
            return None
        out.append(_esc(p["t"]) if "t" in p else p["h"])
    return "".join(out)


def _inline_parts(node, ctx):
    """One element's contents as ingest parts: {"t": prose}, {"h": raw MathML},
    {"img": file name}. `ctx` carries figdir and the image-naming counter."""
    out = []

    def add_text(s):
        s = _clean(s)
        if not s.strip():
            # A pure-whitespace node still separates two words ("x" </em> "is").
            if out and not str(out[-1].get("t", "")).endswith(" "):
                out.append({"t": " "})
            return
        out.append({"t": s})

    def walk(n):
        if isinstance(n, NavigableString):
            add_text(str(n))
            return
        if not isinstance(n, Tag):
            return
        name = (n.name or "").lower()
        if name == "math":
            # Verbatim: this markup is the reason the HTML path exists.
            out.append({"h": str(n)})
            return
        if name == "img":
            ctx["img_n"] += 1
            fname = _save_data_uri(n.get("src", ""), ctx["figdir"],
                                   "%s_img%d" % (ctx["prefix"], ctx["img_n"]))
            if fname:
                out.append({"img": fname})
            else:
                alt = _clean(n.get("alt") or n.get("aria-label") or "")
                if alt:
                    add_text("[%s]" % alt)
            return
        if name == "br":
            add_text(" ")
            return
        wrap = _INLINE_WRAP.get(name)
        if wrap:
            # Recurse over the CHILDREN, never over `n` itself — handing `n` back
            # to _inline_parts would re-enter this same branch forever.
            inner = []
            for child in n.children:
                if isinstance(child, NavigableString):
                    txt = _clean(str(child))
                    if txt:
                        inner.append({"t": txt})
                else:
                    inner.extend(_inline_parts(child, ctx))
            markup = _parts_to_markup(inner)
            if markup is None:
                out.extend(inner)  # holds an image: keep the parts, drop the wrapper
            elif markup.strip():
                out.append({"h": "<%s>%s</%s>" % (wrap, markup, wrap)})
            return
        for child in n.children:
            walk(child)

    walk(node)
    # Merge adjacent prose so downstream step-splitting sees whole sentences.
    merged = []
    for p in out:
        if "t" in p and merged and "t" in merged[-1]:
            merged[-1] = {"t": merged[-1]["t"] + p["t"]}
        else:
            merged.append(p)
    return [p for p in merged if not ("t" in p and not p["t"].strip())]


_TAG = re.compile(r"<[^>]+>")


def _text_of(parts):
    """The readable text of these parts.

    It has to look inside "h" parts as well: with bold preserved, an option's
    "(A)" marker now arrives as <b>(A)</b>, and a text-only reading would have
    missed every marker in the paper. MathML is skipped — its symbols are not
    prose, and nothing here wants to match against them."""
    buf = []
    for p in parts:
        if "t" in p:
            buf.append(p["t"])
        elif "h" in p and "<math" not in p["h"]:
            buf.append(_TAG.sub("", p["h"]))
    return "".join(buf).strip()


def _strip_leading_marker(part):
    """Remove the "(A)" from the front of a part, wrapper or not."""
    if "t" in part:
        return {"t": _OPT_MARK.sub("", part["t"], count=1)}
    if "h" in part:
        # Strip it from the first text run inside the markup.
        def once(m):
            inner = m.group(1)
            return m.group(0) if not inner.strip() else ">" + _OPT_MARK.sub("", inner, count=1)
        return {"h": re.sub(r">([^<>]+)", once, part["h"], count=1)}
    return part


# --------------------------------------------------------------------------- #
#  block splitting
# --------------------------------------------------------------------------- #
def _blocks(container):
    """The container's own block-level children, in document order."""
    return [c for c in container.children if isinstance(c, Tag)]


def _leaf_blocks(blk):
    """One block, or a list's items as separate blocks.

    A <ul> holding "Recognition Cue: …", "Micro Concept: …" is four lines, not one
    paragraph; flattening it here keeps each on its own line downstream instead of
    running them together into a single wall of prose.
    """
    name = (blk.name or "").lower()
    if name in ("ul", "ol"):
        items = [li for li in blk.children if isinstance(li, Tag) and (li.name or "").lower() == "li"]
        return items or [blk]
    return [blk]


def _is_picture_block(blk):
    """A block whose point is the picture: a <figure>, or a bare <p> holding an
    image and no words of its own (a caption alongside it still counts)."""
    name = (blk.name or "").lower()
    if name == "figure":
        return True
    if name in ("p", "div") and blk.find("img") is not None:
        text = _clean(blk.get_text(" ")).strip()
        return not text
    return False


def _split_options(blocks, ctx):
    """Split a question's blocks into (stem parts, options, figure name).

    An option starts at the block whose text begins with "(A)".."(D)" and runs
    until the next marker, so an option whose content sits in the FOLLOWING
    paragraph — which is how these files carry a MathML option — stays with its
    letter instead of being lost.
    """
    stem, options, fig = [], [], None
    current = None  # index into `options` while inside one

    flat = [b for blk in blocks for b in _leaf_blocks(blk)]
    for blk in flat:
        # These papers print the question's diagram AFTER the options, so position
        # alone would file it under (D). A picture belongs to an option only when
        # that option has been opened and is still empty (a genuine picture
        # option); otherwise it is the question's, and it ends the option list —
        # the caption that follows it is question material too.
        if _is_picture_block(blk):
            parts = _inline_parts(blk, ctx)
            imgs = [p for p in parts if "img" in p]
            rest = [p for p in parts if "img" not in p]
            if imgs:
                if current is not None and not options[current]:
                    options[current].extend(imgs)
                else:
                    if fig is None:
                        fig = imgs[0]["img"]
                        stem.extend(imgs[1:])
                    else:
                        stem.extend(imgs)
                    if _text_of(rest):
                        stem.extend(rest)
                    current = None
                continue

        # "Verified Correct Answer: (A), (B) and (C)" is printed after the options
        # in some papers; it is the key, not part of option (D).
        blk_text = _clean(blk.get_text(" ")).strip()
        if _ANSWER_LINE.search(blk_text) and len(blk_text) < 200:
            continue

        parts = _inline_parts(blk, ctx)
        if not parts:
            continue
        lead = _text_of(parts[:1])
        m = _OPT_MARK.match(lead) if lead else None
        if m:
            letter = m.group(1).upper()
            idx = _LET.index(letter)
            while len(options) <= idx:
                options.append([])
            current = idx
            # "(A)" alone: the content is in the next block. "(A) 300 s": the rest
            # of this line is the content.
            if len(lead.strip()) <= 4:
                # "(A)" is the whole first part: the content is what follows it,
                # either later in this block or in the next one.
                tail = parts[1:]
            else:
                # "(A) 300 s" — the marker leads the content it belongs to.
                tail = list(parts)
                tail[0] = _strip_leading_marker(tail[0])
            options[current].extend([p for p in tail if not ("t" in p and not p["t"].strip())])
            continue

        if current is None:
            stem.extend(parts)
        else:
            options[current].extend(parts)

    return stem, options, fig


# "(A), (B) and (C)" — every option letter the line names.
_ANSWER_LETTERS = re.compile(r"\(?\s*([A-Fa-f])\s*\)?(?=\s*(?:[,;/&]|and\b|\)|$))")


def _answer_from_text(txt):
    """The answer stated on one line: a list of letters, a single letter, or a number.

    Multi-correct keys are written as "(A), (B) and (C)" in these papers. Taking
    only the first match made every one of them single-correct, which is how they
    reached QBG as type 1 (2026-09-08 report).
    """
    if not txt or not _ANSWER_LINE.search(txt):
        return None
    after = _ANSWER_LINE.split(txt, 1)[-1]
    letters = sorted({m.upper() for m in _ANSWER_LETTERS.findall(after)})
    if len(letters) > 1:
        return letters
    if letters:
        return letters[0]
    m = re.search(r"-?\d+(?:\.\d+)?", after)
    return m.group(0) if m else None


def _parse_answer(blocks, ctx):
    """The stated answer from a "Verified Correct Answer:" line in these blocks."""
    for blk in blocks:
        txt = _clean(blk.get_text(" ")) if isinstance(blk, Tag) else ""
        found = _answer_from_text(txt)
        if found:
            return found
    return ""


def _solution_parts(blocks, ctx, rich):
    """A solution block's parts.

    Rich keeps every section, each introduced by its own heading; otherwise only
    the worked solution is kept, which is what ordinary ingestion produces.
    """
    parts, section, keeping = [], None, not rich
    seen_heading = False

    for blk in [b for raw in blocks for b in _leaf_blocks(raw)]:
        name = (blk.name or "").lower()
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            section = _clean(blk.get_text(" ")).strip()
            seen_heading = True
            if rich:
                keeping = True
                # Bold, on its own line: the source prints these as <h3>, and a
                # solution that runs "Effective Approach" into its first sentence
                # is exactly the formatting loss this path exists to avoid.
                parts.append({"t": "\n"})
                parts.append({"h": "<b>%s</b>" % _esc(section)})
                parts.append({"t": "\n"})
            else:
                keeping = bool(_DETAILED.search(section))
            continue

        txt = _clean(blk.get_text(" ")).strip()
        if _ANSWER_LINE.search(txt) and len(txt) < 120:
            continue  # the answer itself, carried in q["answer"]
        if _SKIP_LINE.match(txt):
            continue
        # Prose before the first heading is a lead-in; keep it only in rich mode,
        # where the whole solution is wanted.
        if not seen_heading and rich:
            keeping = True
        if not keeping:
            continue
        blk_parts = _inline_parts(blk, ctx)
        if blk_parts:
            if parts:
                parts.append({"t": "\n"})
            parts.extend(blk_parts)

    # Whitespace-only parts are dropped EXCEPT the newlines above — those are the
    # paragraph breaks, and stripping them is what glued the sections together.
    return [p for p in parts
            if "t" not in p or p["t"].strip() or "\n" in p["t"]]


def _question_type(options, answer):
    if not options:
        return "Numerical"
    if isinstance(answer, (list, tuple)) and len(answer) > 1:
        return "MCQ"
    return "SCQ"


# --------------------------------------------------------------------------- #
#  entry point
# --------------------------------------------------------------------------- #
def parse_html_paper(path, figdir, rich_solution=False):
    """Parse a QBG-ready HTML paper into ingest questions.

    Returns {"questions": [...], "warnings": [...]} or None when the file has no
    recognisable "Question N" headings — the caller then falls back to the AI.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        soup = BeautifulSoup(f.read(), "html.parser")

    body = soup.body or soup
    os.makedirs(figdir, exist_ok=True)

    # Group the document into question / solution sections by their headings.
    q_blocks, s_blocks = {}, {}
    order = []
    current, bucket = None, None
    for blk in _blocks(body):
        name = (blk.name or "").lower()
        if name in ("h1", "h2"):
            head = _clean(blk.get_text(" ")).strip()
            mq, ms = _Q_HEAD.match(head), _S_HEAD.match(head)
            # "Solution 3 Question 3" matches both — solution wins, since the
            # question number is only there to say which question it solves.
            if ms:
                current, bucket = ms.group(1), s_blocks
                bucket.setdefault(current, [])
                continue
            if mq:
                current, bucket = mq.group(1), q_blocks
                bucket.setdefault(current, [])
                if current not in order:
                    order.append(current)
                continue
            # Any other h1/h2 (the title, "QUESTION SOLUTION SET") ends the block.
            current, bucket = None, None
            continue
        if bucket is not None and current is not None:
            bucket[current].append(blk)

    if not order:
        return None

    questions, warnings = [], []
    for num in order:
        ctx = {"figdir": figdir, "prefix": "q%s" % num, "img_n": 0}
        stem, options, fig = _split_options(q_blocks.get(num, []), ctx)
        if not stem and not options:
            warnings.append("Q%s: heading found but no question content under it" % num)
            continue

        sblocks = s_blocks.get(num, [])
        # The answer line lives under the solution in some papers and at the end of
        # the question in others, so look in both — question first, since that is
        # where the newer layout puts it.
        answer = _parse_answer(q_blocks.get(num, []), ctx) or (
            _parse_answer(sblocks, ctx) if sblocks else "")
        solution = _solution_parts(sblocks, ctx, rich_solution) if sblocks else []

        qtype = _question_type(options, answer)
        if qtype == "Numerical":
            options = []

        questions.append({
            "num": num,
            "type": qtype,
            "chapter": "",
            "stem": stem,
            "options": options,
            "fig": fig,
            "answer": answer,
            "solution": solution,
            "answer_source": "stated" if answer else None,
            "solution_source": "stated" if solution else None,
            "diagram_generated": False,
            "diagram_desc": None,
        })
        if not answer:
            warnings.append("Q%s: no stated answer found in the HTML" % num)

    if not questions:
        return None
    return {"questions": questions, "warnings": warnings}
