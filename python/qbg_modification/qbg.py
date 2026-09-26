# -*- coding: utf-8 -*-
"""Ingest reframed questions into the QBG software via its REST API.

Reuses the same three columns built for the CSV (content / bilingual_options /
solutions) as the per-question request body. One POST per question to
https://api.penpencil.co/qbg/questions ; returns the unique_id from each response.
"""
import os, re, io, json, time, base64, html, requests
from PIL import Image
from csvbuild import _content_cell, _options_cell, _solution_cell, original_records, _empty_imgs
from mathconv import fix_mathml_in_html
from logsetup import get_logger

log = get_logger("qbg")

# Strip a leading "N. Text Solution:" label from a solution. The number may be wrapped in
# tags (e.g. <strong>3.</strong> Text Solution:), so we work tag-tolerantly on the 1st paragraph.
_FIRST_P = re.compile(r'(\s*<p[^>]*>)(.*?)(</p>)(.*)', re.S | re.I)
_LABEL_UPTO = re.compile(r'^.*?Text\s*Solution\s*:?\s*', re.S | re.I)
_LABEL_BARE = re.compile(r'^\s*(?:\d+\.\s*)?Text\s*Solution\s*:?\s*', re.I)


def _strip_sol_label(sol):
    m = _FIRST_P.match(sol)
    if m:
        open_, inner, close, rest = m.groups()
        if re.search(r'Text\s*Solution', re.sub(r'<[^>]+>', '', inner), re.I):
            inner = _LABEL_UPTO.sub('', inner, count=1)   # drop "N. Text Solution:" (and any tags)
            return (open_ + inner + close + rest) if inner.strip() else rest  # drop empty para
    return _LABEL_BARE.sub('', sol, count=1)


def _strip_lead_num(htmlstr):
    """Drop a leading question number ("1.", "3." ...) from the first paragraph, even when it
    is wrapped in tags like <strong>1.</strong>."""
    m = _FIRST_P.match(htmlstr)
    if not m:
        return re.sub(r'^\s*\d+\.\s*', '', htmlstr, count=1)
    open_, inner, close, rest = m.groups()
    new = re.sub(r'^\s*<(\w+)[^>]*>\s*\d+\.\s*</\1>\s*', '', inner, count=1)   # <strong>1.</strong>
    if new == inner:
        new = re.sub(r'^(\s*<[^>]+>\s*)\d+\.\s*', r'\1', inner, count=1)       # <strong>1. text
    if new == inner:
        new = re.sub(r'^\s*\d+\.\s*', '', inner, count=1)                      # bare 1.
    return open_ + new + close + rest

URL = "https://api.penpencil.co/qbg/questions"
BULK_URL = "https://api.penpencil.co/qbg/questions/get-bulk-questions"   # query string TBD — see caller
QUESTION_ONE_URL = "https://api.penpencil.co/qbg/questions/%s"   # GET/PUT a single question by unique_id
ORG_ID = "5eb393ee95fab7468a79d189"          # constant
LANGUAGE_ID = "m1d8spij3nyi5xw565kp1a2za"    # English, from the sample curl
# Fallback role-id (Lovee's). We normally read the real one out of the JWT (per user),
# see _role_id_from_token — this is only used if the token can't be decoded.
DEFAULT_ROLE_ID = "64cb9aad976ffe2d94ed0e4f"

# Constant headers (the user supplies authorization / user / user-id at runtime).
_CONST_HEADERS = {
    "client-type": "QBG",
    "organization-id": ORG_ID,
    "Content-Type": "application/json",
}

# dropdown label -> category_configuration_id
# MIRROR of src/lib/qbgCategories.ts — the web UI cannot import this file, so a
# new category has to be added in both. Note that AI tagging additionally needs
# rows for the category in tagging_data/qbg_tagging_table.csv (see
# tagmatch.category_label_for); pushing/ingesting works without them.
CATEGORIES = {
    "NEET-JEE":   "vckzned6mqjlkub8wsfh605rp",
    "JEE":        "cx68ito6el81m1ec6eqv43x5u",
    "Foundation": "lx10i0wrdv7mvy95slphkhow7",
    "NEET":       "1l81g6ggobyxxgllarkcjg5vj",
    "Boards":     "sttwbg8nyyicizp9b47194mpf",
    "Real Test":  "rb9u45ap0rqyi7ll9lj59ijtw",
    "RankUp Test Series": "viz514z85nacy6sl0xylkipit",
}

# name -> user-id (header). User can also type a custom id.
USER_IDS = {
    "Lovee":    "66115a54d14edc0018f92bf8",
    "Kishan":   "67bc5f6da5a0cdbb40103809",
    "Kuldeep":  "68c962ddd28f3abd7877e17e",
    "Deepansh": "6347c77daddd6100182fb9a0",
    "Priyanka": "65803006132e260018425d6c",
    "Saurabh":  "66115a80fc9baf0018bc4098",
    "Shiv":     "67bc6096f64bd0a02489bb5c",
    "Devendra": "67bc5e2921a6eb4ef5328f6a",
    "Jainabee": "6900942bc13842aca1c55860",
}

# Each ingested question is viewable here (unique_id appended).
QUESTION_URL = "https://qbg-admin.penpencil.co/question-details?question="


# ----------------- image hosting (QBG native S3 upload) -----------------
# modified_records emits images as <img title="q3_figure.png" src="" /> ; the title is the
# filename in figdir. We upload that file to PenPencil's S3 (via a signed URL) and drop the
# resulting public URL into src="". Reuses the same auth headers as the ingest call.
_IMG_TAG   = re.compile(r'<img\b[^>]*>', re.I)
_TITLE     = re.compile(r'\btitle="([^"]*)"', re.I)
_SRC_EMPTY = re.compile(r'\bsrc="\s*"', re.I)

SIGNED_URL = "https://api.penpencil.co/core-utilities/files/s3-signed-url"


def _content_type(name):
    ext = (os.path.splitext(name)[1].lstrip(".") or "png").lower()
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/" + ext
    return ext, mime


def _find_signed_url(obj):
    """Recursively find the pre-signed S3 PUT URL in the signed-url response."""
    if isinstance(obj, str):
        return obj if "X-Amz-Signature" in obj else None
    if isinstance(obj, dict):
        for v in obj.values():
            r = _find_signed_url(v)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_signed_url(v)
            if r:
                return r
    return None


def qbg_uploader(token, user, user_id, timeout=120):
    """Returns up(file_path)->public_url using QBG's own S3 signed-URL upload.
    Step 1: GET signed URL (QBG auth). Step 2: PUT bytes to S3. Public URL = PUT URL sans query."""
    get_headers = _headers(token, user, user_id)   # authorization / client-type / org-id / user / user-id

    def up(path):
        name = os.path.basename(path)
        ext, ctype = _content_type(name)
        try:
            r = requests.get(SIGNED_URL, headers=get_headers,
                             params={"type": "QBG", "name": name,
                                     "extension": ext, "contentType": ctype}, timeout=timeout)
            if not r.ok:
                raise RuntimeError("signed-url HTTP %d: %s" % (r.status_code, r.text[:300]))
            signed = _find_signed_url(r.json())
            if not signed:
                raise RuntimeError("no signed URL in response: " + r.text[:300])
            with open(path, "rb") as f:
                body = f.read()
            pr = requests.put(signed, data=body, headers={"Content-Type": ctype}, timeout=timeout)
            if not pr.ok:
                raise RuntimeError("S3 PUT HTTP %d: %s" % (pr.status_code, pr.text[:300]))
            url = signed.split("?")[0]
            log.info("qbg upload ok: %s -> %s", name, url)
            return url
        except Exception:
            log.exception("qbg upload failed: %s", name)
            raise

    return up


def _fill_imgs(htmlstr, figdir, uploader, cache):
    if not htmlstr or 'src="' not in htmlstr:
        return htmlstr

    def repl(m):
        tag = m.group(0)
        if not _SRC_EMPTY.search(tag):
            return tag                          # already has a src
        tm = _TITLE.search(tag)
        if not tm or not tm.group(1):
            return tag
        fn = tm.group(1)
        if fn not in cache:
            path = os.path.join(figdir, fn)
            cache[fn] = uploader(path) if os.path.exists(path) else None
        url = cache[fn]
        if not url:
            return tag
        return _SRC_EMPTY.sub('src="%s"' % url, tag, count=1)

    return _IMG_TAG.sub(repl, htmlstr)


# ----------------- QBG as an input SOURCE (alternate to uploading a .docx) -----------------
# get_bulk_questions() already returns each question in the same content/bilingual_options/
# solutions shape csvbuild.py uses, so qbg_extract() below builds the same `data` dict shape
# extract.extract() does, and everything downstream (Step 2/3, htmlbuild, csvbuild) works
# unchanged. Diagram images are already hosted at a public URL (static.pw.live via CloudFront)
# — no need to re-upload them — but we still pull a local copy into figdir since the rest of
# the pipeline (LLM vision calls, the final build, QBG re-ingest) all key off local files there.
_RENDER_WRAP = re.compile(r'<div\s+class="card">\s*<div\s+class="render">(.*?)</div>\s*</div>', re.S | re.I)
_IMG_SRC_RE = re.compile(r'<img\b[^>]*\bsrc="([^"]*)"[^>]*>', re.I)


def _strip_render_wrapper(htmlstr):
    """QBG's editor sometimes wraps a field in <div class="card"><div class="render">...
    </div></div> for its own preview; unwrap back to plain paragraph HTML."""
    if not htmlstr:
        return htmlstr
    return _RENDER_WRAP.sub(lambda m: m.group(1), htmlstr)


def _img_srcs(htmlstr):
    return _IMG_SRC_RE.findall(htmlstr or "")


def _plain_text(htmlstr):
    """Like extract._txt but with full HTML-entity decoding (QBG's MathML leans on numeric
    refs like &#8722; that a purely-alphabetic entity strip would leave untouched)."""
    t = re.sub(r'<annotation[^>]*>.*?</annotation>', '', htmlstr or '', flags=re.S)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = html.unescape(t)
    return re.sub(r'\s+', ' ', t).strip()


_TABLE_RE = re.compile(r'<table\b.*?</table>', re.S | re.I)
_TR_RE = re.compile(r'<tr\b.*?</tr>', re.S | re.I)
_TD_RE = re.compile(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', re.S | re.I)


def _table_rows_text(htmlstr):
    """Render every <table> in `htmlstr` as readable "cell | cell" rows.

    Match-the-column questions carry their List-I/List-II inside a <table> in the
    stem. `_plain_text` flattens that into one undifferentiated run of words, so a
    model asked to rewrite the stem cannot tell which entry pairs with which and
    silently drops the table (2026-08-03 bug report: the table vanished from the
    modified question). Giving it the rows explicitly preserves the structure.

    Returns [] when the stem has no table."""
    out = []
    for tbl in _TABLE_RE.findall(htmlstr or ""):
        for tr in _TR_RE.findall(tbl):
            cells = [_plain_text(c) for c in _TD_RE.findall(tr)]
            cells = [c for c in cells if c]
            if cells:
                out.append(" | ".join(cells))
    return out


def _download_img(url, dst_path, timeout=30):
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    Image.open(io.BytesIO(r.content)).convert("RGB").save(dst_path, "PNG")


def qbg_extract(unique_ids, token, user, user_id, workdir):
    """Fetch already-authored QBG questions by unique_id — alternate to uploading a .docx.
    Returns the same data dict shape as extract.extract():
    {source_name, questions[], originals{N:(html,ans,sol)}, figdir, prompt}, plus
    fig_urls{filename:original public url}, missing_ids (ids QBG didn't return), and
    skipped_unsupported ({"qbg_id","reason"} for questions of a type this pipeline
    doesn't reframe, e.g. Subjective/Assertion_Reason/Comprehension)."""
    from extract import build_prompt   # local import: avoids a qbg<->extract import cycle
    figdir = os.path.join(workdir, "figures"); os.makedirs(figdir, exist_ok=True)
    log.info("qbg_extract start: %d id(s)", len(unique_ids))
    fetched = get_bulk_questions(unique_ids, token, user, user_id)
    by_id = {d.get("unique_id"): d for d in fetched}
    missing = [u for u in unique_ids if u not in by_id]
    if missing:
        log.error("qbg_extract: %d id(s) not returned by QBG: %s", len(missing), missing)

    questions = []; originals = {}; fig_urls = {}; skipped_unsupported = []
    for N, uid in enumerate(unique_ids, 1):
        d = by_id.get(uid)
        if not d:
            continue
        unsupported_name = UNSUPPORTED_TYPE_CODES.get(d.get("type"))
        if unsupported_name:
            log.info("qbg_extract: skipping %s (q%d) — unsupported type %s", uid, N, unsupported_name)
            skipped_unsupported.append({"qbg_id": uid,
                "reason": "%s questions aren't supported by AI reframe yet" % unsupported_name})
            continue
        content_html = _strip_render_wrapper(d.get("content", {}).get("english") or "")
        opts = d.get("bilingual_options", {}).get("english") or []
        sol_block = (d.get("solutions") or [{}])[0].get("english") or {}
        sol_html = _strip_render_wrapper(sol_block.get("text") or "")
        ans_idx = next((i for i, o in enumerate(opts) if o.get("isCorrect")), -1)
        answer = "ABCDEF"[ans_idx] if 0 <= ans_idx < 6 else ""

        # figure: first <img> found in the stem
        fig_name = None
        stem_imgs = _img_srcs(content_html)
        if stem_imgs:
            fig_name = "q%d_figure.png" % N
            try:
                _download_img(stem_imgs[0], os.path.join(figdir, fig_name))
                fig_urls[fig_name] = stem_imgs[0]
            except Exception:
                log.exception("qbg_extract: figure download failed for %s (q%d)", uid, N)
                fig_name = None

        # options: image options only if EVERY option carries an <img> (mirrors extract.py)
        opt_texts = []; opt_html = []; opt_img_names = None
        per_opt_imgs = [_img_srcs(o.get("text") or "") for o in opts]
        if opts and all(per_opt_imgs):
            opt_img_names = []
            for idx, o in enumerate(opts[:6]):
                let = "ABCDEF"[idx]
                nm = "q%d_opt%s.png" % (N, let)
                oh = _strip_render_wrapper(o.get("text") or "")
                opt_html.append(oh)
                try:
                    _download_img(per_opt_imgs[idx][0], os.path.join(figdir, nm))
                    opt_img_names.append(nm)
                    fig_urls[nm] = per_opt_imgs[idx][0]
                except Exception:
                    log.exception("qbg_extract: option image download failed for %s opt %s", uid, let)
        else:
            for o in opts:
                oh = _strip_render_wrapper(o.get("text") or "")
                opt_html.append(oh)
                opt_texts.append(_plain_text(oh))

        # solution images, in order
        sol_img_names = []
        for k, url in enumerate(_img_srcs(sol_html), 1):
            nm = "q%d_sol%d.png" % (N, k)
            try:
                _download_img(url, os.path.join(figdir, nm))
                sol_img_names.append(nm)
            except Exception:
                log.exception("qbg_extract: solution image download failed for %s", uid)

        # Trust QBG's own "type" code first — it's authoritative, unlike guessing from
        # "bilingual_options" shape. This matters because QBG's API can return a
        # Numerical question's bilingual_options as four {"isCorrect":null,"text":null}
        # placeholder slots rather than a truly empty array/list, which used to make
        # "not opts" (checking for zero options) miss real Numerical questions and fall
        # through to the SCQ default — exactly the bug this fixes (2026-07-19: user
        # reported Numerical-selected questions coming back modified as SCQ).
        # TYPE_CODES is defined further down in this module; that's fine — it's
        # resolved at call time, not at definition time.
        qbg_type_code = d.get("type")
        has_real_options = opts and any((o.get("text") or "").strip() for o in opts)
        if qbg_type_code == TYPE_CODES.get("NUMERICAL"):
            q_type = "NUMERICAL"
        elif qbg_type_code == TYPE_CODES.get("MCQ"):
            q_type = "MCQ"
        elif qbg_type_code == TYPE_CODES.get("MATCHING_LIST"):
            q_type = "MATCHING_LIST"
        elif qbg_type_code == TYPE_CODES.get("ASSERTION_REASON"):
            q_type = "ASSERTION_REASON"
        elif not has_real_options:
            # Unknown/unexpected type code, but genuinely no real option text —
            # safer to treat as Numerical than to fabricate SCQ options for it.
            q_type = "NUMERICAL"
        else:
            q_type = "SCQ"

        # A match-the-column table lives inside the stem HTML. Capture its rows
        # separately so the reframe prompt can show the model the actual
        # structure (see extract.build_prompt) — without this the table is
        # flattened into prose and lost from the modified question.
        table_rows = _table_rows_text(content_html)

        originals[N] = (content_html, answer, sol_html)
        questions.append({
            "num": N, "q_text": _plain_text(content_html), "options_text": opt_texts,
            "options_html": opt_html, "stem_html": content_html, "answer": answer,
            "sol_text": _plain_text(sol_html), "fig_name": fig_name,
            "opt_img_names": opt_img_names, "sol_img_names": sol_img_names, "type": q_type,
            "table_rows": table_rows,
            # Which QBG question this is. "num" is only a position; a per-question
            # instruction from the caller (e.g. "rewrite this one as a Numerical")
            # is keyed by id.
            "qbg_id": uid,
        })

    source_name = "qbg_" + unique_ids[0] + ("_plus%d" % (len(unique_ids) - 1) if len(unique_ids) > 1 else "")
    prompt = build_prompt(source_name, questions)
    nfig = sum(1 for q in questions if q["fig_name"])
    log.info("qbg_extract ok: source=%s questions=%d figures=%d missing=%d skipped_unsupported=%d",
              source_name, len(questions), nfig, len(missing), len(skipped_unsupported))
    return {"source_name": source_name, "questions": questions, "originals": originals,
            "figdir": figdir, "prompt": prompt, "fig_urls": fig_urls, "missing_ids": missing,
            "skipped_unsupported": skipped_unsupported}


def resolve_images(record, figdir, uploader, cache):
    """Return a copy of the record with empty <img src=""> filled from uploaded URLs.
    cache: shared {filename: url|None} dict so each image uploads only once per batch."""
    r = dict(record)
    r["content"] = _fill_imgs(r.get("content"), figdir, uploader, cache)
    r["options"] = [(c, _fill_imgs(t, figdir, uploader, cache))
                    for c, t in (r.get("options") or [])]
    r["solution"] = _fill_imgs(r.get("solution"), figdir, uploader, cache)
    return r


# ----------------- pushing records that no longer have a figdir -----------------
# A push run AFTER extraction (the "Push to QBG" button on a finished ingestion, or
# a re-upload of the generated CSV) has no working directory any more — that is
# deleted with the job. What it does have is the preview HTML, where each diagram
# is inlined as a base64 data: URL. These upload those inline images to QBG's S3
# exactly like _fill_imgs uploads files, so a post-hoc push keeps its diagrams.
_SRC_DATA = re.compile(r'\bsrc="(data:image/([A-Za-z0-9.+-]+);base64,([^"]*))"', re.I)


def _upload_data_uri(mime_ext, b64, uploader_bytes, cache):
    """Upload one base64 image, memoised on its content so a figure repeated across
    stem and solution is uploaded once. Returns the public URL, or None."""
    key = b64[:96] + str(len(b64))
    if key not in cache:
        try:
            raw = base64.b64decode(b64, validate=False)
        except Exception:
            log.warning("undecodable inline image (%d chars)", len(b64))
            cache[key] = None
            return None
        ext = (mime_ext or "png").lower()
        if ext == "jpeg":
            ext = "jpg"
        try:
            cache[key] = uploader_bytes(raw, "figure.%s" % ext)
        except Exception:
            log.exception("inline image upload failed")
            cache[key] = None
    return cache[key]


def _fill_inline_imgs(htmlstr, uploader_bytes, cache):
    if not htmlstr or "data:image/" not in htmlstr:
        return htmlstr

    def repl(m):
        url = _upload_data_uri(m.group(2), m.group(3), uploader_bytes, cache)
        return 'src="%s"' % url if url else m.group(0)

    return _SRC_DATA.sub(repl, htmlstr)


def resolve_inline_images(record, uploader_bytes, cache):
    """resolve_images for records whose figures are base64 data: URLs rather than
    files in a figdir."""
    r = dict(record)
    r["content"] = _fill_inline_imgs(r.get("content"), uploader_bytes, cache)
    r["options"] = [(c, _fill_inline_imgs(t, uploader_bytes, cache))
                    for c, t in (r.get("options") or [])]
    r["solution"] = _fill_inline_imgs(r.get("solution"), uploader_bytes, cache)
    return r


def qbg_bytes_uploader(token, user, user_id, timeout=120):
    """Like qbg_uploader but takes raw bytes + a filename instead of a path."""
    up = qbg_uploader(token, user, user_id, timeout=timeout)

    def up_bytes(raw, name):
        import tempfile
        ext = os.path.splitext(name)[1] or ".png"
        fd, path = tempfile.mkstemp(suffix=ext)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            return up(path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    return up_bytes


def count_blank_images(record):
    """How many <img> tags in this record would reach QBG with no source at all —
    i.e. neither an uploaded URL nor an inline data: URL. An ORIGINAL-questions CSV
    is built with every src blanked (csvbuild._empty_imgs), so re-uploading one
    reports the loss up front instead of silently creating questions with missing
    diagrams. A modified CSV keeps its images inline and counts zero."""
    n = 0
    for chunk in ([record.get("content"), record.get("solution")] +
                  [t for _c, t in (record.get("options") or [])]):
        for tag in _IMG_TAG.findall(chunk or ""):
            if _SRC_EMPTY.search(tag) or 'src="' not in tag:
                n += 1
    return n


def original_qbg_records(data):
    """Records for the ORIGINAL (unmodified) questions, QBG-ready:
    pandoc MathML run through fix_mathml (MathType-compatible, like the reframed output),
    and diagram <img> tags title-tagged with their figdir filename so they can be uploaded."""
    base = original_records(data)                       # [{content, options, solution}]
    by_num = {q["num"]: q for q in data["questions"]}
    nums = sorted(data["originals"])
    out = []
    for rec, N in zip(base, nums):
        q = by_num.get(N, {})
        # content = STEM ONLY (no options), number stripped, images blanked, MathType MathML
        stem = q.get("stem_html")
        stem = _empty_imgs(stem) if stem else (rec.get("content") or "")
        content = fix_mathml_in_html(_strip_lead_num(stem))
        fig = q.get("fig_name")
        if fig:
            if "<img" in content:                       # tag the existing stem image
                content = _tag_first_img(content, fig)
            else:                                        # no inline <img> -> append one
                content += '\n<p><img title="%s" src="" /></p>' % fig
        opt_names = q.get("opt_img_names")
        options = []
        for idx, (c, t) in enumerate(rec.get("options") or []):
            if opt_names and idx < len(opt_names):       # image options
                t = '<p><img title="%s" src="" /></p>' % opt_names[idx]
            else:
                t = fix_mathml_in_html(t or "")
            options.append((c, t))
        solution = _strip_sol_label(rec.get("solution") or "")
        solution = _tag_imgs_in_order(solution, q.get("sol_img_names") or [])
        solution = fix_mathml_in_html(solution)
        out.append({"content": content, "options": options, "solution": solution})
    return out


def _set_img_title(tag, name):
    """Return the <img> tag with a single clean title="<name>" (dropping any existing title)."""
    tag = re.sub(r'\s+title="[^"]*"', '', tag, flags=re.I)
    return '<img title="%s"%s' % (name, tag[4:])


def _tag_first_img(htmlstr, name):
    return re.sub(r'<img\b[^>]*>', lambda m: _set_img_title(m.group(0), name), htmlstr, count=1)


def _tag_imgs_in_order(htmlstr, names):
    """Give each <img> (in order) title="<figdir filename>", so blanked solution/stem images
    can be matched to their saved files and uploaded to QBG."""
    if not names or not htmlstr:
        return htmlstr
    it = iter(names)

    def repl(m):
        try:
            return _set_img_title(m.group(0), next(it))
        except StopIteration:
            return m.group(0)

    return re.sub(r'<img\b[^>]*>', repl, htmlstr)


# QBG question "type" integer codes. SCQ (single-correct) = 1 is confirmed from the
# reframer's existing pushes. MCQ (one-or-more correct) and NUMERICAL (integer/decimal
# answer, no options) codes are confirmed by inspecting real QBG questions of each kind
# (see _inspect_types.py) and set here. MATCHING_LIST (List-I/List-II, 4 combination
# options) = 9, confirmed from QBG_data.csv. Codes 5 (Subjective), 7 (Assertion_Reason),
# 8 (Comprehension) are real QBG types too but are NOT modeled by this pipeline — see
# UNSUPPORTED_TYPE_CODES below.
TYPE_CODES = {"SCQ": 1, "MCQ": 2, "NUMERICAL": 3, "ASSERTION_REASON": 7, "MATCHING_LIST": 9}

# QBG type codes this pipeline deliberately does not reframe: Subjective (free-text
# answer), Comprehension (shared-passage parent + child questions). Reframing these
# would need a different question schema entirely; questions of these types are
# skipped (not silently mis-tagged as SCQ) — see qbg_extract()'s "skipped_unsupported"
# list. Assertion_Reason (was also here) is now supported — see ASSERTION_REASON_OPTIONS.
UNSUPPORTED_TYPE_CODES = {5: "Subjective", 8: "Comprehension"}

# Assertion_Reason questions always offer exactly these 4 fixed-wording options — QBG
# never varies this text, only which one is correct — confirmed from real QBG_data.csv
# rows. Reframed AR questions reuse this constant verbatim rather than trusting the AI
# to reproduce the exact canonical wording; the AI only supplies which letter is correct.
ASSERTION_REASON_OPTIONS = [
    "A is true but R is false.",
    "A is false but R is true.",
    "Both A and R are true and R is the correct explanation of A.",
    "Both A and R are true but R is not the correct explanation of A.",
]


def _looks_integer(val):
    v = (str(val or "")).strip()
    if not v:
        return False
    try:
        f = float(v)
        return f == int(f)
    except ValueError:
        return False


def build_payload(record, category_configuration_id, qtype="SCQ", answer=None):
    """record: {content, options:[(isCorrect,text)...], solution} (from modified_records).
    Reuses the exact JSON shapes of the CSV cells for content/bilingual_options/solutions.

    qtype: "SCQ" (default — one correct option), "MCQ" (one-or-more correct options; the
    isCorrect flags already carry the multi-correct set from modified_records), or
    "NUMERICAL" (no options; the numeric answer goes in the `answer` field).
    answer: only used for NUMERICAL — the numeric value string.
    """
    content = json.loads(_content_cell(record.get("content", "")))
    bilingual_options = json.loads(_options_cell(record.get("options")))
    solutions = json.loads(_solution_cell(record.get("solution", "")))

    qtype = (qtype or "SCQ").upper()
    type_code = TYPE_CODES.get(qtype, 1)
    is_int = False
    is_range = False
    answer_field = {"english": None}
    if qtype == "NUMERICAL":
        val = str(answer).strip() if answer not in (None, "") else None
        answer_field = {"english": val}
        is_int = _looks_integer(val)

    return {
        "content": content,
        "bilingual_options": bilingual_options,
        "category_configuration_id": category_configuration_id,
        "languages": [{"language_id": LANGUAGE_ID}],
        "solutions": solutions,
        "type": type_code,
        "organization_id": ORG_ID,
        "difficulty": None,
        "examDetails": [{"exam_id": None, "positive_marks": None,
                         "negative_marks": None, "partial_positive_marks": None}],
        "sources": [{"book_id": None, "page_no": ""}],
        "averageTime": 0,
        "conceptTags": [{"stream_id": None, "section_id": None, "subject_id": None,
                         "chapter_id": None, "topic_id": None, "subtopic_id": None,
                         "unit_id": None, "class_id": None, "academic_year_id": None}],
        "relevance_last_updated_at": "2026-06-27",
        "readinessTags": [{"name": "Not Paraphrased", "isChecked": False}],
        "xCategoryTags": None,
        "answer": answer_field,
        "is_range_numerical": is_range,
        "is_int_answer": is_int,
    }


def _headers(token, user, user_id):
    h = dict(_CONST_HEADERS)
    tok = (token or "").strip()
    if tok and not tok.lower().startswith("bearer "):
        tok = "Bearer " + tok
    h["authorization"] = tok
    h["user"] = user
    h["user-id"] = user_id
    return h


def _find_key(obj, key):
    """Recursively find the first non-empty value for `key` anywhere in the JSON."""
    if isinstance(obj, dict):
        v = obj.get(key)
        if v:
            return v
        for vv in obj.values():
            r = _find_key(vv, key)
            if r:
                return r
    elif isinstance(obj, list):
        for vv in obj:
            r = _find_key(vv, key)
            if r:
                return r
    return None


def get_bulk_questions(unique_ids, token, user, user_id, params=None, timeout=60):
    """Fetch already-authored QBG questions by unique_id (alternate to uploading a .docx).
    Returns the list of question dicts (content/bilingual_options/solutions/... — already the
    same JSON shapes csvbuild.py uses) from response[0]['data']. Raises on HTTP/API error."""
    log.info("qbg get_bulk_questions: %d id(s)", len(unique_ids))
    try:
        r = requests.post(BULK_URL, headers=_headers(token, user, user_id),
                          json={"uniqueIds": unique_ids}, params=params or {}, timeout=timeout)
        if not r.ok:
            raise RuntimeError("HTTP %d: %s" % (r.status_code, r.text[:500]))
        payload = r.json()
        block = payload[0] if isinstance(payload, list) and payload else payload
        if not isinstance(block, dict):
            raise RuntimeError("Unexpected response shape: " + str(payload)[:300])
        if block.get("error"):
            raise RuntimeError("QBG error: %s" % block.get("message"))
        data = block.get("data") or []
        log.info("qbg get_bulk_questions ok: got %d/%d question(s)", len(data), len(unique_ids))
        return data
    except Exception:
        log.exception("qbg get_bulk_questions failed")
        raise


def ingest(record, category_configuration_id, token, user, user_id, timeout=60,
           qtype="SCQ", answer=None):
    """POST one question. Returns (unique_id, response_json). Raises on HTTP error.
    qtype/answer let ingestion push MCQ (multi-correct) and Numerical questions; the
    reframer path omits them and gets the historical SCQ behaviour."""
    try:
        payload = build_payload(record, category_configuration_id, qtype=qtype, answer=answer)
        r = requests.post(URL, headers=_headers(token, user, user_id),
                          json=payload, timeout=timeout)
        if not r.ok:
            raise RuntimeError("HTTP %d: %s" % (r.status_code, r.text[:400]))
        try:
            data = r.json()
        except Exception:
            raise RuntimeError("Non-JSON response: " + r.text[:400])
        uid = _find_key(data, "unique_id") or _find_key(data, "_id")
        log.info("qbg ingest ok: category=%s unique_id=%s", category_configuration_id, uid)
        return uid, data
    except Exception:
        log.exception("qbg ingest failed: category=%s", category_configuration_id)
        raise


# ----------------- TAXONOMY (the concept tree behind the tagging table) -----------------
# The lists the QBG admin UI's tag dropdowns are built from. Each level filters by
# the ids above it, and every level is category-scoped — which is why a category
# missing from the bundled tagging table (e.g. RankUp Test Series) can be crawled
# into it rather than borrowed from another category. See qbg_tag_crawl.py.
TAXONOMY_URL = "https://api.penpencil.co/qbg/%s"
_TAXONOMY_LEVELS = ("classes", "subjects", "chapters", "topics", "subtopics")


# A full-category crawl is thousands of requests and QBG rate-limits it (HTTP 429).
# Backing off and retrying matters more than speed here: a dropped page silently
# becomes a missing chapter/topic in the tagging table, which the AI then can never
# choose. Transient 5xx get the same treatment.
_RETRY_STATUS = (429, 500, 502, 503, 504)
_RETRY_WAITS = (1, 3, 7, 15, 30, 60)


def taxonomy_list(level, token, user, user_id, timeout=60, page_size=200, **filters):
    """GET one taxonomy level, following pagination. `filters` are the query params
    that scope it (category_id, subject_id, chapter_id, topic_id).

    Returns [{"unique_id":..., "name":...}]. `totalCount` comes back as 0 even when
    rows are returned, so pagination stops on a short page, not on a count.
    Retries rate-limits/5xx with backoff; raises if they outlast the retries.
    """
    if level not in _TAXONOMY_LEVELS:
        raise ValueError("unknown taxonomy level: %s" % level)
    out, seen = [], set()
    page = 1
    while True:
        params = {"page": page, "limit": page_size, "status": "visible"}
        params.update({k: v for k, v in filters.items() if v})
        r = None
        last = None
        for attempt in range(len(_RETRY_WAITS) + 1):
            try:
                r = requests.get(TAXONOMY_URL % level, headers=_headers(token, user, user_id),
                                 params=params, timeout=timeout)
            except requests.RequestException as e:      # connection reset / timeout
                last = str(e)
                r = None
            if r is not None and r.ok:
                break
            if r is not None and r.status_code not in _RETRY_STATUS:
                raise RuntimeError("%s HTTP %d: %s" % (level, r.status_code, r.text[:300]))
            if attempt >= len(_RETRY_WAITS):
                detail = ("HTTP %d: %s" % (r.status_code, r.text[:200])) if r is not None else last
                raise RuntimeError("%s failed after %d retries — %s"
                                   % (level, len(_RETRY_WAITS), detail))
            wait = _RETRY_WAITS[attempt]
            if r is not None:
                try:                                    # honour Retry-After when sent
                    wait = max(wait, int(r.headers.get("Retry-After", 0)))
                except (TypeError, ValueError):
                    pass
            time.sleep(wait)
        rows = (r.json() or {}).get("data") or []
        for row in rows:
            uid = row.get("unique_id")
            if not uid or uid in seen:
                continue
            seen.add(uid)
            out.append({"unique_id": uid,
                        "name": (row.get("english_name") or row.get("name") or "").strip()})
        if len(rows) < page_size:
            break
        page += 1
    return out


# ----------------- TAGGING (GET one question -> override tags -> PUT) -----------------
# Replicates the n8n "qbg backend sheet tagging" flow natively: fetch the existing
# question, rebuild its payload preserving everything, and override ONLY the concept
# tags (subject/chapter/topic/subtopic/class) and difficulty, then PUT it back. This
# never touches the question's content/options/solution.

def _role_id_from_token(token):
    """QBG's GET/PUT question endpoints want a roleid header, which is per-user. It lives
    inside the JWT (data.roles[0]), so decode it from the token rather than hard-coding."""
    try:
        tok = (token or "").strip()
        if tok.lower().startswith("bearer "):
            tok = tok[7:]
        payload_b64 = tok.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)   # pad base64
        data = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
        roles = (data.get("data") or {}).get("roles") or []
        return roles[0] if roles else DEFAULT_ROLE_ID
    except Exception:
        return DEFAULT_ROLE_ID


def _question_headers(token, user, user_id, with_content_type=False):
    """Headers for the single-question GET/PUT endpoints — like _headers() but adds the
    roleid + user-name the tagging endpoints expect (mirrors the n8n flow)."""
    h = dict(_headers(token, user, user_id))
    h.pop("Content-Type", None)
    h["accept"] = "application/json, text/plain, */*"
    h["roleid"] = _role_id_from_token(token)
    h["user-name"] = (user or "").split()[0] if user else "Lovee"
    if with_content_type:
        h["content-type"] = "application/json"
    return h


def get_question(qbg_id, token, user, user_id, timeout=60):
    """GET one question by unique_id. Returns the question dict (unwraps [{data:{...}}])."""
    r = requests.get(QUESTION_ONE_URL % qbg_id, headers=_question_headers(token, user, user_id), timeout=timeout)
    if not r.ok:
        raise RuntimeError("GET question HTTP %d: %s" % (r.status_code, r.text[:300]))
    payload = r.json()
    if isinstance(payload, list) and payload:
        payload = payload[0]
    q = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
    if not q or not q.get("unique_id"):
        raise RuntimeError("GET question response missing data/unique_id: " + str(payload)[:300])
    return q


def build_tag_payload(q, tags):
    """Rebuild the PUT body from an existing question `q`, overriding only the concept
    tags + difficulty. `tags` = {class_id, subject_id, chapter_id, topic_id, subtopic_id,
    difficulty}. Mirrors the n8n Build Payload node exactly."""
    languages = [{"language_id": l.get("language_id")} for l in (q.get("languages") or [])]
    exam_details = [{"exam_id": e.get("exam_id") or e.get("unique_id"),
                     "positive_marks": e.get("positive_marks"),
                     "negative_marks": e.get("negative_marks"),
                     "partial_positive_marks": e.get("partial_positive_marks")}
                    for e in (q.get("examDetails") or [])]
    sources = [{"book_id": s.get("book_id") or "", "page_no": s.get("page_no") or ""}
               for s in (q.get("sources") or [])]
    if not sources:
        sources = [{"book_id": "", "page_no": ""}]
    relevance = (q.get("relevance_last_updated_at") or "")[:10] or None
    concept_tags = [{
        "subject_id": tags.get("subject_id"),
        "chapter_id": tags.get("chapter_id"),
        "topic_id": tags.get("topic_id"),
        "subtopic_id": tags.get("subtopic_id"),   # sheet's sub_topic_id -> payload subtopic_id
        "class_id": tags.get("class_id"),
    }]
    return {
        "content": q.get("content"),
        "bilingual_options": q.get("bilingual_options"),
        "category_configuration_id": q.get("category_configuration_id"),
        "languages": languages,
        "solutions": q.get("solutions"),
        "type": q.get("type"),
        "organization_id": q.get("organization_id"),
        "difficulty": int(tags["difficulty"]),
        "examDetails": exam_details,
        "sources": sources,
        "averageTime": 0 if q.get("averageTime") is None else q.get("averageTime"),
        "conceptTags": concept_tags,
        "relevance_last_updated_at": relevance,
        "readinessTags": q.get("readinessTags") or [],
        "answer": q.get("answer") or {"english": None},
        "is_range_numerical": bool(q.get("is_range_numerical")),
        "is_int_answer": bool(q.get("is_int_answer")),
    }


def _randomid():
    import uuid
    return str(uuid.uuid4())


def tag_question(qbg_id, tags, token, user, user_id, timeout=60, question=None):
    """GET the question (unless `question` is supplied), override its tags, and PUT it back.
    Returns (ok, detail). `tags` needs class_id/subject_id/chapter_id/topic_id/subtopic_id/difficulty."""
    try:
        q = question or get_question(qbg_id, token, user, user_id, timeout=timeout)
        payload = build_tag_payload(q, tags)
        headers = _question_headers(token, user, user_id, with_content_type=True)
        headers["randomid"] = _randomid()
        r = requests.put(QUESTION_ONE_URL % qbg_id, headers=headers, json=payload, timeout=timeout)
        if not r.ok:
            return False, "PUT HTTP %d: %s" % (r.status_code, r.text[:300])
        log.info("qbg tag ok: %s -> subject=%s chapter=%s topic=%s subtopic=%s diff=%s",
                 qbg_id, tags.get("subject_id"), tags.get("chapter_id"), tags.get("topic_id"),
                 tags.get("subtopic_id"), tags.get("difficulty"))
        return True, "tagged"
    except Exception as e:
        log.exception("qbg tag failed: %s", qbg_id)
        return False, str(e)[:300]


# ----------------- results HTML (modified questions + unique_ids) -----------------
_LET = "ABCD"
_SRC_ANY = re.compile(r'\bsrc="[^"]*"', re.I)


def _data_uri(path):
    _, mime = _content_type(os.path.basename(path))
    with open(path, "rb") as f:
        return "data:%s;base64,%s" % (mime, base64.b64encode(f.read()).decode())


def _embed_local_imgs(htmlstr, figdir):
    """For the local preview only: inline each <img> as base64 from figdir/<title>,
    so diagrams always render regardless of S3 public-read access."""
    if not htmlstr or not figdir:
        return htmlstr

    def repl(m):
        tag = m.group(0)
        tm = _TITLE.search(tag)
        if not tm or not tm.group(1):
            return tag
        path = os.path.join(figdir, tm.group(1))
        if not os.path.exists(path):
            return tag
        return _SRC_ANY.sub('src="%s"' % _data_uri(path), tag, count=1)

    return _IMG_TAG.sub(repl, htmlstr)


def results_html(src, records, results, figdir=None):
    """Self-contained HTML listing each modified question (content/options/solution,
    MathML already inline) with its QBG unique_id. results: list aligned to records,
    each {num, unique_id, ok, error?}."""
    css = (
        "body{font-family:system-ui,Arial,sans-serif;max-width:900px;margin:24px auto;"
        "padding:0 16px;color:#1a1a1a;line-height:1.5}"
        ".q{border:1px solid #e2e2e2;border-radius:10px;padding:16px 20px;margin:18px 0}"
        ".hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}"
        ".num{font-weight:700;font-size:1.05em}"
        ".uid{font-family:ui-monospace,Menlo,monospace;font-size:.85em;background:#eef6ff;"
        "color:#0b5cad;padding:3px 8px;border-radius:6px;text-decoration:none}"
        "a.uid:hover{text-decoration:underline}"
        ".uid.bad{background:#fdecec;color:#b3261e}"
        ".opts{list-style:upper-alpha;margin:8px 0 8px 24px;padding:0}"
        ".opts li{margin:4px 0}.opts li.correct{background:#eafbe7;border-radius:6px;"
        "padding:2px 8px;font-weight:600}"
        ".sol{margin-top:10px;padding-top:10px;border-top:1px dashed #ddd}"
        ".lbl{font-weight:600;color:#555;font-size:.85em;text-transform:uppercase;"
        "letter-spacing:.04em}img{max-width:100%}"
    )
    by_num = {r["num"]: r for r in results}
    rows = []
    for i, rec in enumerate(records, 1):
        res = by_num.get(i, {})
        uid = res.get("unique_id")
        if res.get("ok") and uid:
            link = QUESTION_URL + html.escape(str(uid), quote=True)
            badge = ('<a class="uid" href="%s" target="_blank" rel="noopener">%s</a>'
                     % (link, html.escape(str(uid))))
        else:
            msg = res.get("error") or "no unique_id returned"
            badge = '<span class="uid bad">FAILED — %s</span>' % html.escape(str(msg)[:120])
        opts = rec.get("options") or []
        if opts:
            lis = "".join(
                '<li class="%s">%s</li>' % ("correct" if c else "",
                                            _embed_local_imgs(t or "", figdir))
                for c, t in opts
            )
            opts_html = '<ol class="opts">%s</ol>' % lis
        else:
            opts_html = '<p><em>(numeric / no options)</em></p>'
        sol = _embed_local_imgs(rec.get("solution") or "", figdir)
        content = _embed_local_imgs(rec.get("content") or "", figdir)
        rows.append(
            '<div class="q"><div class="hd"><span class="num">Q%d</span>%s</div>'
            '<div class="stem">%s</div>%s'
            '<div class="sol"><span class="lbl">Solution</span>%s</div></div>'
            % (i, badge, content, opts_html, sol)
        )
    ok = sum(1 for r in results if r.get("ok") and r.get("unique_id"))
    head = ('<h1>%s — QBG ingest results</h1><p>%d of %d questions ingested.</p>'
            % (html.escape(src), ok, len(records)))
    return ("<!doctype html><html><head><meta charset='utf-8'><style>%s</style></head>"
            "<body>%s%s</body></html>" % (css, head, "".join(rows)))
