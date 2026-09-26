# -*- coding: utf-8 -*-
"""AI tagging: given a QBG question, pick the nearest subject -> chapter -> topic ->
subtopic from the crawled tagging table (qbg_tagging_table.csv) plus a difficulty
(1=easy, 2=medium, 3=hard).

Matching is hierarchical and index-based so the model never has to reproduce a 25-char
unique_id (it picks a NUMBER from a shortlist; we map that back to the real ids):

  1. pick the subject (small list, scoped to the question's category)
  2. pick the chapter within that subject (fixes subject + class + chapter)
  3. pick the topic + subtopic within that chapter, and rate difficulty

The question's category (JEE / NEET / ...) is derived from its category_configuration_id,
so we only ever search that category's slice of the table.
"""
import os
import re
import csv
import html as _html

import llm as _llm
import qbg as _qbg

# category_configuration_id -> label used in the tagging CSV's "category" column.
CATEGORY_BY_ID = {cid: label for label, cid in _qbg.CATEGORIES.items()}

_SYS = ("You are a precise exam-question classifier. You output ONLY a single valid JSON "
        "object matching the schema in the user's message — no markdown, no commentary.")


def _txt(h, limit=1200):
    """HTML -> compact plain text (drop MathML annotations, unescape entities)."""
    t = re.sub(r"<annotation[^>]*>.*?</annotation>", "", str(h or ""), flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = _html.unescape(t)
    return re.sub(r"\s+", " ", t).strip()[:limit]


def question_text(q, solution_limit=500):
    """Build a compact text view of a QBG question (stem + options + a little solution).

    `solution_limit` is raised for the chapter step, which also asks what the
    solution RELIES on — the concept a solution reaches for (a work-energy
    theorem, an SHM argument) is usually past the first few hundred characters."""
    parts = [_txt((q.get("content") or {}).get("english"))]
    opts = (q.get("bilingual_options") or {}).get("english") or []
    for i, o in enumerate(opts):
        parts.append("(%s) %s" % ("ABCD"[i] if i < 4 else i + 1, _txt(o.get("text"), 300)))
    sol = (q.get("solutions") or [{}])[0].get("english") or {}
    if sol.get("text"):
        parts.append("Solution: " + _txt(sol.get("text"), solution_limit))
    return "\n".join(p for p in parts if p).strip()


def load_table(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def category_label_for(q, rows):
    """Which tagging-CSV category slice applies to this question."""
    cid = q.get("category_configuration_id")
    return CATEGORY_BY_ID.get(cid)


def taxonomy_categories(rows):
    """Category slices the tagging table actually covers, largest first — what a
    caller can legitimately pass as `taxonomy_category`."""
    counts = {}
    for r in rows:
        c = r.get("category")
        if c:
            counts[c] = counts.get(c, 0) + 1
    return [c for c, _n in sorted(counts.items(), key=lambda kv: -kv[1])]


def _uniq(seq):
    seen, out = set(), []
    for key, val in seq:
        if key not in seen:
            seen.add(key)
            out.append(val)
    return out


def _ask_index(prompt, provider, api_key, model, base_url, n):
    """One JSON call that must return {"index": int, ...}. Returns the parsed dict, with
    'index' clamped into [0, n-1].

    The output we ask for is tiny ({"index": N}), but a *thinking* model spends output
    tokens reasoning first, so a small max_tokens truncates the JSON mid-string. We give a
    generous budget and escalate + retry on any parse/transient failure."""
    budgets = [6000, 12000, 24000]
    last_err = None
    for attempt in range(len(budgets)):
        try:
            payload = _llm.generate(provider, api_key, model, prompt, system=_SYS,
                                    base_url=base_url, max_tokens=budgets[attempt])
            if not isinstance(payload, dict):
                raise RuntimeError("classifier did not return a JSON object")
            idx = int(payload.get("index"))
            payload["index"] = max(0, min(n - 1, idx))
            return payload
        except Exception as e:   # JSON truncation / transient API error -> retry bigger
            last_err = e
    raise RuntimeError("classifier failed after %d attempts: %s" % (len(budgets), last_err))


def match_question(q, rows, provider, api_key, model, base_url=None,
                   taxonomy_category=None, allowed_subjects=None):
    """Return (tags, meta) where tags = {class_id, subject_id, chapter_id, topic_id,
    subtopic_id, difficulty} and meta carries the human-readable names + reasons.

    `taxonomy_category` overrides which slice of the table is offered to the model.
    It exists because a QBG category can be newer than the bundled tagging table
    (RankUp Test Series has no rows of its own), while subject/chapter/topic/subtopic
    IDs are GLOBAL — the categories are overlapping views of one tree, not separate
    trees (NEET's 104 chapters are a strict subset of NEET-JEE's, which is a strict
    subset of Real Test's). So matching a RankUp question against, say, the Real Test
    slice yields ids QBG accepts; only the shortlist the model chooses from changes.

    `allowed_subjects` (list of subject NAMES) narrows what the model may choose
    from; empty/None means every subject in the category. See the note at the
    subject step for why filtering beats correcting afterwards.

    Raises ValueError, naming the usable slices, when no rows can be matched."""
    explicit = bool(taxonomy_category)
    cat = taxonomy_category or category_label_for(q, rows)
    if not cat:
        raise ValueError(
            "question category (%s) is not in the tagging list — pick a taxonomy to "
            "match against instead. Available: %s"
            % (q.get("category_configuration_id"), ", ".join(taxonomy_categories(rows))))
    cat_rows = [r for r in rows if r.get("category") == cat]
    if not cat_rows:
        raise ValueError(
            "no tagging rows for category %s%s. Available taxonomies: %s"
            % (cat,
               "" if explicit else " — its taxonomy is not in the bundled table, so "
                                   "choose one to match against",
               ", ".join(taxonomy_categories(rows))))

    qtext = question_text(q)

    # Reference-table column names (from qbg_tag_crawl.py): category, class, class_id,
    # subject, subject_id, chapter, chapter_id, topic, topic_id, subtopic, subtopic_id.
    # ---- 1) subject ----
    subjects = _uniq((r["subject_id"], (r["subject_id"], r["subject"]))
                     for r in cat_rows if r.get("subject_id"))

    # Restricting the shortlist is the only reliable way to stop a cross-subject
    # mis-tag: a Physics "Mathematical Tools / Vectors" question reads exactly like
    # a Maths one, and the model routinely filed it under Maths (2026-08-31 bug
    # report). Chapters with the same name exist under several subjects, so this
    # has to be decided before the model sees the list, not corrected afterwards.
    if allowed_subjects:
        wanted = {s.strip().lower() for s in allowed_subjects if s and s.strip()}
        if wanted:
            narrowed = [s for s in subjects if (s[1] or "").strip().lower() in wanted]
            if not narrowed:
                raise ValueError(
                    "none of the chosen subjects (%s) exist in the %s taxonomy — available: %s"
                    % (", ".join(sorted(wanted)), cat,
                       ", ".join(sorted({s[1] for s in subjects}))))
            subjects = narrowed

    if len(subjects) == 1:
        # Narrowed to one — the answer is settled, so skip the model call entirely.
        subj_id, subj_name = subjects[0]
    else:
        slist = "\n".join("%d. %s" % (i, s[1]) for i, s in enumerate(subjects))
        p1 = ("Category: %s\n\nQuestion:\n%s\n\nPick the SUBJECT this question belongs to. "
              "Reply ONLY JSON: {\"index\": <number from the list>}\n\nSUBJECTS:\n%s"
              % (cat, qtext, slist))
        r1 = _ask_index(p1, provider, api_key, model, base_url, len(subjects))
        subj_id, subj_name = subjects[r1["index"]]

    # ---- 2) chapter (within subject; fixes class too) ----
    chapters = _uniq(
        (r["chapter_id"], (r["chapter_id"], r["chapter"], r["class_id"], r["class"]))
        for r in cat_rows if r.get("subject_id") == subj_id and r.get("chapter_id"))
    if not chapters:
        raise ValueError("no chapters for subject %s in %s" % (subj_name, cat))
    clist = "\n".join("%d. %s (class %s)" % (i, c[1], c[3]) for i, c in enumerate(chapters))
    # The same call also reports which OTHER chapters the question depends on. A
    # question is filed under the chapter it is about, but it can still need a
    # later chapter to solve: a spring-and-string problem is "Laws of Motion", yet a
    # solution that finds the maximum extension with the work-energy theorem needs
    # "Work, Energy and Power" (2026-09-22 report). The filed chapter alone can
    # never show that, so the syllabus audit reads this list instead.
    p2 = ("Category: %s · Subject: %s\n\nQuestion:\n%s\n\n"
          "1. Pick the single best CHAPTER this question belongs to.\n"
          "2. List every OTHER chapter from the same list whose concepts are NEEDED to "
          "solve it the way the solution does — a theorem, law or technique the working "
          "applies (e.g. a solution using the work-energy theorem needs Work, Energy and "
          "Power; one using conservation of angular momentum needs Rotational Motion). "
          "Count only what the working actually uses, not topics mentioned in passing, "
          "and not general algebra or calculus. Use [] when nothing beyond the chosen "
          "chapter is needed.\n\n"
          "Reply ONLY JSON: {\"index\": <number>, \"uses\": [<numbers>]}\n\nCHAPTERS:\n%s"
          % (cat, subj_name, question_text(q, solution_limit=2500), clist))
    r2 = _ask_index(p2, provider, api_key, model, base_url, len(chapters))
    chap_id, chap_name, class_id, class_name = chapters[r2["index"]]
    chapters_used = []
    uses = r2.get("uses")
    for u in (uses if isinstance(uses, list) else []):
        try:
            k = int(u)
        except (TypeError, ValueError):
            continue
        if 0 <= k < len(chapters) and k != r2["index"]:
            name = chapters[k][1]
            if name not in chapters_used:
                chapters_used.append(name)

    # ---- 3) topic + subtopic + difficulty (within chapter) ----
    leaves = [r for r in cat_rows if r.get("chapter_id") == chap_id]
    # de-dup by (topic_id, sub_topic_id)
    seen, leaf_list = set(), []
    for r in leaves:
        key = (r.get("topic_id"), r.get("subtopic_id"))
        if key in seen:
            continue
        seen.add(key)
        leaf_list.append(r)
    llist = "\n".join(
        "%d. %s%s" % (i, r.get("topic") or "(no topic)",
                      " > " + r["subtopic"] if r.get("subtopic") else " > (no subtopic)")
        for i, r in enumerate(leaf_list))
    p3 = ("Category: %s · Subject: %s · Chapter: %s\n\nQuestion:\n%s\n\nPick the best "
          "TOPIC > SUBTOPIC for this question, and rate its difficulty (1=easy, 2=medium, "
          "3=hard). Reply ONLY JSON: {\"index\": <number>, \"difficulty\": 1|2|3}\n\n"
          "TOPICS:\n%s" % (cat, subj_name, chap_name, qtext, llist))
    r3 = _ask_index(p3, provider, api_key, model, base_url, len(leaf_list))
    leaf = leaf_list[r3["index"]]
    try:
        difficulty = int(r3.get("difficulty"))
    except (TypeError, ValueError):
        difficulty = 2
    difficulty = difficulty if difficulty in (1, 2, 3) else 2

    tags = {
        "class_id": class_id, "subject_id": subj_id, "chapter_id": chap_id,
        "topic_id": leaf.get("topic_id") or "", "subtopic_id": leaf.get("subtopic_id") or "",
        "difficulty": difficulty,
    }
    meta = {
        "class_name": class_name, "subject_name": subj_name, "chapter_name": chap_name,
        "topic_name": leaf.get("topic") or "", "subtopic_name": leaf.get("subtopic") or "",
        "difficulty_name": {1: "Easy", 2: "Medium", 3: "Hard"}[difficulty],
        "category": cat,
        # Other chapters the question relies on (see the chapter step). Read by the
        # syllabus audit; never written to QBG.
        "chapters_used": chapters_used,
        # Set when the question's OWN category was not what we matched against, so
        # the UI can say which tree the tags actually came from.
        "taxonomy_category": cat if explicit else None,
    }
    return tags, meta
