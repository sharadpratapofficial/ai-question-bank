# -*- coding: utf-8 -*-
"""Crawl a QBG category's concept tree into the tagging table.

The AI tagger picks subject / chapter / topic / subtopic from
tagging_data/qbg_tagging_table.csv. That file was crawled once, so a QBG category
created later has no rows and tagging fails with "no tagging rows for category X".
This rebuilds a category's slice from QBG itself:

    classes -> subjects -> chapters (per class) -> topics -> subtopics

and writes the same 11 columns the table already uses. Existing rows for other
categories are preserved; the crawled category's rows are replaced wholesale, so
re-running is idempotent and picks up chapters added since.

Usage (credentials come from the environment, like every other sidecar command):

    QBG_TOKEN=... QBG_USER=... QBG_USER_ID=... \
      python qbg_tag_crawl.py --category "RankUp Test Series"

    --category      a label from qbg.CATEGORIES, or a raw category_configuration_id
    --out           table to update (default: the bundled tagging_data csv)
    --workers       parallel requests (default 8)
    --dry-run       crawl and report, write nothing
"""
import argparse
import csv
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import qbg as _qbg
from logsetup import get_logger

log = get_logger("qbg_tag_crawl")

DEFAULT_TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "tagging_data", "qbg_tagging_table.csv")
COLUMNS = ["category", "class", "class_id", "subject", "subject_id",
           "chapter", "chapter_id", "topic", "topic_id", "subtopic", "subtopic_id"]

_print_lock = threading.Lock()


def _note(msg):
    with _print_lock:
        print(msg, file=sys.stderr)


def crawl_category(label, category_id, creds, workers=4):
    """Return (rows, stats) for one category. rows are dicts keyed by COLUMNS.

    stats["errors"] counts levels that failed even after qbg.taxonomy_list's
    retries. A non-zero count means the crawl is INCOMPLETE — the caller must not
    write it, because a missing chapter or topic is invisible in the finished
    table and silently unpickable by the tagger."""
    token, user, user_id = creds
    errors = []

    def fetch(level, **filters):
        return _qbg.taxonomy_list(level, token, user, user_id, **filters)

    classes = fetch("classes", category_id=category_id)
    subjects = fetch("subjects", category_id=category_id)
    _note("  %d class(es), %d subject(s)" % (len(classes), len(subjects)))
    if not subjects:
        return [], {"classes": len(classes), "subjects": 0, "chapters": 0,
                    "topics": 0, "subtopics": 0, "errors": 0}

    # ---- chapters: per (class, subject), because the class is a column of the
    # table and chapters only carry it through this filter.
    chapter_jobs = [(c, s) for c in classes for s in subjects]
    chapters = []   # (class, subject, chapter)

    def chapters_for(job):
        cls, subj = job
        try:
            return [(cls, subj, ch) for ch in fetch(
                "chapters", category_id=category_id,
                subject_id=subj["unique_id"], class_id=cls["unique_id"])]
        except Exception as e:
            errors.append("chapters %s/%s: %s" % (cls["name"], subj["name"], str(e)[:160]))
            _note("  ! " + errors[-1])
            return []

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for part in ex.map(chapters_for, chapter_jobs):
            chapters.extend(part)
    _note("  %d chapter(s)" % len(chapters))

    # ---- topics per chapter
    topics = []     # (class, subject, chapter, topic)

    def topics_for(item):
        cls, subj, ch = item
        try:
            return [(cls, subj, ch, t) for t in fetch(
                "topics", category_id=category_id, subject_id=subj["unique_id"],
                chapter_id=ch["unique_id"])]
        except Exception as e:
            errors.append("topics %s: %s" % (ch["name"], str(e)[:160]))
            _note("  ! " + errors[-1])
            return []

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for part in ex.map(topics_for, chapters):
            topics.extend(part)
    _note("  %d topic(s)" % len(topics))

    # ---- subtopics per topic
    leaves = []     # (class, subject, chapter, topic, subtopic|None)

    def subtopics_for(item):
        cls, subj, ch, t = item
        try:
            subs = fetch("subtopics", category_id=category_id,
                         subject_id=subj["unique_id"], chapter_id=ch["unique_id"],
                         topic_id=t["unique_id"])
        except Exception as e:
            errors.append("subtopics %s: %s" % (t["name"], str(e)[:160]))
            _note("  ! " + errors[-1])
            subs = []
        # A topic with no subtopics still has to be selectable, so it gets one row
        # with the subtopic columns blank — same as the existing table.
        return [(cls, subj, ch, t, s) for s in subs] or [(cls, subj, ch, t, None)]

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for part in ex.map(subtopics_for, topics):
            leaves.extend(part)

    # Chapters with no topics at all must survive too, or the AI can never pick them.
    with_topics = {(c["unique_id"], s["unique_id"], ch["unique_id"])
                   for c, s, ch, _t in topics}
    for cls, subj, ch in chapters:
        if (cls["unique_id"], subj["unique_id"], ch["unique_id"]) not in with_topics:
            leaves.append((cls, subj, ch, None, None))

    rows = []
    for cls, subj, ch, t, s in leaves:
        rows.append({
            "category": label,
            "class": cls["name"], "class_id": cls["unique_id"],
            "subject": subj["name"], "subject_id": subj["unique_id"],
            "chapter": ch["name"], "chapter_id": ch["unique_id"],
            "topic": t["name"] if t else "", "topic_id": t["unique_id"] if t else "",
            "subtopic": s["name"] if s else "", "subtopic_id": s["unique_id"] if s else "",
        })
    stats = {"classes": len(classes), "subjects": len(subjects),
             "chapters": len(chapters), "topics": len(topics), "subtopics": len(rows),
             "errors": len(errors), "error_detail": errors[:10]}
    return rows, stats


def merge_into_table(path, label, rows):
    """Replace `label`'s rows in the table with `rows`, leaving every other
    category untouched. Returns (removed, added, total)."""
    existing = []
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig", newline="") as f:
            existing = list(csv.DictReader(f))
    kept = [r for r in existing if r.get("category") != label]
    removed = len(existing) - len(kept)
    out = kept + rows
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in out:
            w.writerow(r)
    os.replace(tmp, path)
    return removed, len(rows), len(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--category", required=True,
                    help="Category label (from qbg.CATEGORIES) or a raw category_configuration_id")
    ap.add_argument("--out", default=DEFAULT_TABLE, help="Tagging table CSV to update")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel requests (QBG rate-limits; 4 is a safe default)")
    ap.add_argument("--dry-run", action="store_true", help="Crawl and report; write nothing")
    ap.add_argument("--allow-partial", action="store_true",
                    help="Write even if some requests failed. Off by default: a missing "
                         "chapter/topic is invisible in the finished table and can never "
                         "be picked by the tagger.")
    args = ap.parse_args()

    token = os.environ.get("QBG_TOKEN", "").strip()
    user = os.environ.get("QBG_USER", "").strip()
    user_id = os.environ.get("QBG_USER_ID", "").strip()
    if not (token and user and user_id):
        print("missing QBG credentials (set QBG_TOKEN / QBG_USER / QBG_USER_ID)", file=sys.stderr)
        return 3

    label = args.category
    category_id = _qbg.CATEGORIES.get(label)
    if not category_id:
        # A raw id was given — name it from the table when we can.
        category_id = label
        label = {v: k for k, v in _qbg.CATEGORIES.items()}.get(category_id, category_id)

    _note("crawling %s (%s)" % (label, category_id))
    rows, stats = crawl_category(label, category_id, (token, user, user_id), args.workers)
    _note("  -> %d row(s): %d chapter(s), %d topic(s)"
          % (len(rows), stats["chapters"], stats["topics"]))
    if not rows:
        print("no taxonomy rows found — nothing written", file=sys.stderr)
        return 3
    if stats["errors"] and not args.allow_partial:
        print("crawl INCOMPLETE: %d request(s) failed after retries — refusing to write a "
              "partial taxonomy (the missing entries would be silently unpickable). "
              "Re-run, lower --workers, or pass --allow-partial to accept it.\nFirst failures:\n  %s"
              % (stats["errors"], "\n  ".join(stats["error_detail"])), file=sys.stderr)
        return 4
    if args.dry_run:
        _note("dry run — not writing %s" % args.out)
        return 0
    removed, added, total = merge_into_table(args.out, label, rows)
    _note("updated %s: -%d +%d = %d row(s)" % (args.out, removed, added, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
