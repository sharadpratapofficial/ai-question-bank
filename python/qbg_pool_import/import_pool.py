# -*- coding: utf-8 -*-
"""Import/refresh QBG_data.csv into the self-hosted Supabase's
public.qbg_question_pool table (see scripts/sql/create_qbg_question_pool.sql).

Re-runnable and idempotent: rows are matched by unique_id and upserted. The
one column NEVER touched by this script is `used_in_exam` — that is written by
the app itself (QBG Pipeline feature, see src/lib/api/qbgPoolSelection.ts) the
moment a question is picked into a batch, and must survive re-imports of a CSV
that always has this column empty. See _MERGE_SQL below — it is deliberately
absent from every UPDATE SET list.

No new Python package is required: the self-hosted Postgres container has no
port exposed to the host (confirmed via `docker port supabase-db` — empty), so
a direct psycopg2/TCP connection isn't possible here. Instead this pipes a
cleaned, validated CSV into a staging table via `docker exec -i ... psql`'s
COPY, then merges staging -> the real table with a single SQL statement — the
same "docker exec psql" pattern already used elsewhere in this repo (see
scripts/sql/*.sql and this session's qbg_tasks table).

Usage:
    python import_pool.py --csv "../../QBG_data.csv"
    python import_pool.py --csv sample.csv --dry-run     # clean + validate only, no DB writes
    python import_pool.py --csv sample.csv --limit 500   # only process the first N data rows
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

csv.field_size_limit(10_000_000)  # solutions/conceptTags blobs can be large

CONTAINER = os.environ.get("QBG_POOL_DB_CONTAINER", "supabase-db")
STAGING_TABLE = "qbg_pool_staging"
TARGET_TABLE = "public.qbg_question_pool"

# CSV column -> staging/pool column, and how to clean each value.
# kind: "text" | "int" | "bool" | "json"
_COLUMNS = [
    ("qbg_id", "qbg_id", "text"),
    ("link", "link", "text"),
    ("question_type", "question_type", "text"),
    ("difficulty_level", "difficulty_level", "text"),
    ("Source", "source", "text"),
    ("subject", "subject", "text"),
    ("chapter", "chapter", "text"),
    ("topic", "topic", "text"),
    ("SubtopicName", "subtopic", "text"),
    ("Class", "class_level", "text"),
    ("created_at", "source_created_at", "text"),
    ("updated_at", "source_updated_at", "text"),
    ("unique_id", "unique_id", "text"),
    ("xCategoryTags", "x_category_tags", "json"),
    ("readinessTags", "readiness_tags", "json"),
    ("difficulty", "difficulty", "int"),
    ("answer", "answer", "json"),
    ("organization_id", "organization_id", "text"),
    ("slug", "slug", "text"),
    ("parent_question_id", "parent_question_id", "text"),
    ("verification_status", "verification_status", "int"),
    ("category_configuration_id", "category_configuration_id", "text"),
    ("is_int_answer", "is_int_answer", "bool"),
    ("is_range_numerical", "is_range_numerical", "bool"),
    ("exam_year", "exam_year", "text"),
    ("languages", "languages", "json"),
    ("category_name", "category_name", "text"),
    ("child_questions", "child_questions", "json"),
    ("conceptTags", "concept_tags", "json"),
    ("sources", "sources", "json"),
    ("examDetails", "exam_details", "json"),
    ("bilingual_solutions", "bilingual_solutions", "json"),
    ("QC_Status", "qc_status", "text"),
    ("content", "content", "json"),
    ("bilingual_options", "bilingual_options", "json"),
    ("solutions", "solutions", "json"),
]
POOL_COLUMNS = [pool for _csv, pool, _kind in _COLUMNS] + [
    "has_video_solution", "has_text_solution", "row_hash",
]


def _solution_flags(solutions_raw, bilingual_solutions_raw):
    """Derive (has_video_solution, has_text_solution) for the English variant
    from the raw solutions (JSON array, e.g. [{"english": {...}}]) and
    bilingual_solutions (JSON object, e.g. {"english": {...}}) cells.
    Mirrors scripts/sql/add_pool_solution_flags.sql's logic so a re-import
    stays consistent with that one-time backfill."""
    has_video = False
    has_text = False
    for raw, is_array in ((solutions_raw, True), (bilingual_solutions_raw, False)):
        raw = (raw or "").strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        root = obj[0] if is_array and isinstance(obj, list) and obj else obj
        if not isinstance(root, dict):
            continue
        english = root.get("english")
        if not isinstance(english, dict):
            continue
        url = ((english.get("videoSolution") or {}).get("url") or "").strip()
        if url:
            has_video = True
        text = re.sub(r"<[^>]*>", "", english.get("text") or "").strip()
        if text:
            has_text = True
    return has_video, has_text


# Successive QBG exports spell the same field differently (QBG_data.csv vs
# QBG_data2.csv). csv.DictReader matches by header NAME, so an unrecognised
# spelling silently imports as blank — which would quietly wipe source /
# subtopic / difficulty_level for a whole dump. Map each canonical header to
# the alternates seen in real exports.
#
# NOTE: column ORDER differences (QBG_data2.csv swaps subject/chapter) need no
# handling — DictReader keys by name, and the values were verified correct.
_HEADER_ALIASES = {
    "qbg_id":           ["qbgid"],
    "difficulty_level": ["difficulty_level000"],
    "Source":           ["source"],
    "SubtopicName":     ["subtopic"],
    "Class":            ["class"],
    "QC_Status":        ["qc_status", "QC Status"],
}


def _row_get(row, csv_col):
    """row.get(csv_col), falling back to any known alias spelling."""
    v = row.get(csv_col)
    if v not in (None, ""):
        return v
    for alt in _HEADER_ALIASES.get(csv_col, ()):
        v = row.get(alt)
        if v not in (None, ""):
            return v
    return None


# A class level is a bare standard ("11", "12", "Class 11", "XI") — anything
# else in that column is a mislabelled export (QBG_data2.csv puts batch names
# like "AI Guru" / "DPP Online" there), in which case we recover the real class
# from conceptTags instead of importing a value the class filter can't use.
_CLASS_RE = re.compile(r"^\s*(?:class\s*)?(?:1[0-2]|[6-9]|IX|X|XI|XII)\s*$", re.I)


def _looks_like_class(v):
    return bool(_CLASS_RE.match((v or "").strip()))


def _class_from_concept_tags(raw):
    """Pull class.english_name out of the conceptTags JSON blob, e.g.
    [{"class": {"english_name": "12", ...}, ...}] -> "12"."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
    except Exception:
        return ""
    if isinstance(obj, list):
        obj = obj[0] if obj else {}
    if not isinstance(obj, dict):
        return ""
    cls = obj.get("class")
    if isinstance(cls, dict):
        name = (cls.get("english_name") or "").strip()
        if name:
            return name
    return ""


def _resolve_class_level(row, warnings, unique_id):
    """Class level from the Class/class column when it really is one, else from
    conceptTags. Returns "" when neither yields a usable value."""
    direct = (_row_get(row, "Class") or "").strip()
    if _looks_like_class(direct):
        return direct
    derived = _class_from_concept_tags(row.get("conceptTags"))
    if derived:
        if direct:
            warnings.append("%s: Class column %r is not a class level; used conceptTags %r"
                            % (unique_id, direct[:40], derived[:20]))
        return derived
    return direct  # nothing better available — keep whatever was there


def _clean_cell(raw, kind, warnings, unique_id, col_name):
    raw = (raw or "").strip()
    if not raw:
        return ""  # unquoted empty CSV field -> SQL NULL under COPY FORMAT csv
    if kind == "text":
        return raw
    if kind == "int":
        try:
            return str(int(float(raw)))
        except ValueError:
            warnings.append("%s: non-numeric %s %r -> NULL" % (unique_id, col_name, raw[:40]))
            return ""
    if kind == "bool":
        v = raw.strip().upper()
        if v in ("TRUE", "T", "1"):
            return "true"
        if v in ("FALSE", "F", "0"):
            return "false"
        warnings.append("%s: unrecognised bool %s %r -> NULL" % (unique_id, col_name, raw[:40]))
        return ""
    if kind == "json":
        try:
            json.loads(raw)
            return raw
        except Exception as e:
            warnings.append("%s: invalid JSON in %s (%s) -> NULL" % (unique_id, col_name, str(e)[:80]))
            return ""
    return raw


def clean_csv(src_path, dst_path, limit=None):
    """Stream QBG_data.csv -> a cleaned/validated CSV matching POOL_COLUMNS,
    ready for COPY into the staging table. Returns a stats dict."""
    stats = {"read": 0, "skipped_na_subject": 0, "skipped_no_id": 0, "written": 0,
              "warnings": 0}
    warnings = []
    t0 = time.time()
    with open(src_path, encoding="utf-8", newline="") as fin, \
         open(dst_path, "w", encoding="utf-8", newline="") as fout:
        reader = csv.DictReader(fin)
        writer = csv.writer(fout)
        writer.writerow(POOL_COLUMNS)
        for row in reader:
            stats["read"] += 1
            if limit and stats["read"] > limit:
                stats["read"] -= 1
                break
            subject = (row.get("subject") or "").strip()
            unique_id = (row.get("unique_id") or "").strip()
            if not unique_id:
                stats["skipped_no_id"] += 1
                continue
            if subject == "#N/A":
                stats["skipped_na_subject"] += 1
                continue
            # row_hash covers the RAW row (every source column) so any upstream
            # change is detected even in a column we don't explicitly store.
            raw_repr = json.dumps(row, sort_keys=True, ensure_ascii=False)
            row_hash = hashlib.sha256(raw_repr.encode("utf-8")).hexdigest()
            class_level = _resolve_class_level(row, warnings, unique_id)
            out_row = []
            for csv_col, pool_col, kind in _COLUMNS:
                # class_level is resolved specially (column may hold a batch
                # name rather than a class — see _resolve_class_level).
                value = class_level if pool_col == "class_level" else _row_get(row, csv_col)
                out_row.append(_clean_cell(value, kind, warnings, unique_id, pool_col))
            has_video, has_text = _solution_flags(row.get("solutions"), row.get("bilingual_solutions"))
            out_row.append("true" if has_video else "false")
            out_row.append("true" if has_text else "false")
            out_row.append(row_hash)
            writer.writerow(out_row)
            stats["written"] += 1
            if stats["read"] % 5000 == 0:
                print("  ...cleaned %d rows (%.1fs)" % (stats["read"], time.time() - t0), flush=True)
    stats["warnings"] = len(warnings)
    if warnings:
        warn_path = dst_path + ".warnings.log"
        with open(warn_path, "w", encoding="utf-8") as wf:
            wf.write("\n".join(warnings))
        print("  %d field-level warnings written to %s" % (len(warnings), warn_path))
    return stats


def _run_psql(sql, stdin_path=None, label=""):
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
          "-v", "ON_ERROR_STOP=1", "-c", sql]
    stdin_fh = open(stdin_path, "rb") if stdin_path else None
    try:
        r = subprocess.run(cmd, stdin=stdin_fh, capture_output=True, text=False, timeout=600)
    finally:
        if stdin_fh:
            stdin_fh.close()
    if r.returncode != 0:
        raise RuntimeError("psql failed (%s): %s" % (label, r.stderr.decode("utf-8", "replace")[:2000]))
    return r.stdout.decode("utf-8", "replace")


def load_into_db(cleaned_csv_path):
    col_list = ", ".join(POOL_COLUMNS)
    print("Creating staging table...")
    _run_psql(
        "DROP TABLE IF EXISTS %s; "
        "CREATE TABLE %s (LIKE %s INCLUDING DEFAULTS EXCLUDING CONSTRAINTS EXCLUDING INDEXES);"
        % (STAGING_TABLE, STAGING_TABLE, TARGET_TABLE),
        label="create staging",
    )

    print("Copying cleaned CSV into staging (this streams the file, may take a while)...")
    copy_sql = "\\copy %s (%s) FROM STDIN WITH (FORMAT csv, HEADER true)" % (STAGING_TABLE, col_list)
    # \copy is a psql meta-command (reads from psql's own stdin) — use -c is fine
    # since it's the only command in this invocation and stdin carries the CSV.
    out = _run_psql(copy_sql, stdin_path=cleaned_csv_path, label="copy into staging")
    print(" ", out.strip())

    # Real exports repeat the same unique_id (QBG_data2.csv carries 2359 such
    # rows). Postgres rejects that outright — "ON CONFLICT DO UPDATE command
    # cannot affect row a second time" — and the whole merge rolls back, so the
    # staging set MUST be deduplicated first. Keep the most recently updated
    # copy of each id, with ctid as a deterministic tiebreaker.
    dupes = _run_psql(
        "SELECT count(*) - count(DISTINCT unique_id) FROM %s;" % STAGING_TABLE,
        label="count staging dupes",
    ).strip()
    if dupes and dupes != "0":
        print("  %s duplicate unique_id row(s) in this export — keeping the "
              "most recently updated copy of each." % dupes)

    print("Merging staging -> %s (upsert by unique_id, used_in_exam preserved)..." % TARGET_TABLE)
    update_cols = [c for c in POOL_COLUMNS if c not in ("unique_id",)]
    set_clause = ", ".join("%s = EXCLUDED.%s" % (c, c) for c in update_cols) + ", updated_at = now()"
    merge_sql = (
        "INSERT INTO %s (%s) "
        "SELECT DISTINCT ON (unique_id) %s FROM %s "
        "ORDER BY unique_id, source_updated_at DESC NULLS LAST, ctid "
        "ON CONFLICT (unique_id) DO UPDATE SET %s "
        "WHERE %s.row_hash IS DISTINCT FROM EXCLUDED.row_hash;"
        % (TARGET_TABLE, col_list, col_list, STAGING_TABLE, set_clause, TARGET_TABLE)
    )
    out = _run_psql(merge_sql, label="merge")
    print(" ", out.strip())

    print("Dropping staging table...")
    _run_psql("DROP TABLE IF EXISTS %s;" % STAGING_TABLE, label="drop staging")
    _run_psql("NOTIFY pgrst, 'reload schema';", label="reload schema")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--csv", required=True, help="Path to QBG_data.csv")
    ap.add_argument("--limit", type=int, default=None, help="Only process the first N data rows (testing)")
    ap.add_argument("--dry-run", action="store_true", help="Clean/validate only — no DB writes")
    ap.add_argument("--keep-cleaned", action="store_true", help="Don't delete the intermediate cleaned CSV")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        print("CSV not found: %s" % args.csv, file=sys.stderr)
        return 2

    tmp_dir = tempfile.mkdtemp(prefix="qbg_pool_import_")
    cleaned_path = os.path.join(tmp_dir, "cleaned.csv")

    print("Reading + cleaning %s ..." % args.csv)
    stats = clean_csv(args.csv, cleaned_path, limit=args.limit)
    print("Cleaned: read=%(read)d written=%(written)d skipped_na_subject=%(skipped_na_subject)d "
          "skipped_no_id=%(skipped_no_id)d warnings=%(warnings)d" % stats)

    if args.dry_run:
        print("Dry run — stopping before any DB write. Cleaned CSV at: %s" % cleaned_path)
        return 0

    load_into_db(cleaned_path)
    print("Done.")

    if not args.keep_cleaned:
        try:
            os.remove(cleaned_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
