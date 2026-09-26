# -*- coding: utf-8 -*-
"""One-off: fetch a few QBG questions by unique_id and print ONLY the schema
fields that decide question type / answer encoding — so we can map SCQ / MCQ /
Numerical correctly when pushing. Never prints the token.

Run it yourself (keeps your token out of the chat):

    set QBG_TOKEN=<your bearer token>        (PowerShell:  $env:QBG_TOKEN="...")
    set QBG_USER=Qbg sub admin
    set QBG_USER_ID=<your user-id>
    python _inspect_types.py

Then paste the printed block back.
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import qbg

IDS = [
    "0l36p8gwsll1uhcsd112z9z8w",
    "6egga3c4nzs0w3nzjt0pvos64",
    "dqxyknnfhwftps79550rhxzfk",
    "4zu6d74uwjuf48dy9vae3bgjb",
]

token = os.environ.get("QBG_TOKEN", "").strip()
user = os.environ.get("QBG_USER", "Qbg sub admin").strip()
user_id = os.environ.get("QBG_USER_ID", "").strip()
if not (token and user and user_id):
    print("Set QBG_TOKEN, QBG_USER, QBG_USER_ID env vars first.")
    sys.exit(1)


def brief(html, n=90):
    import re
    t = re.sub(r"<[^>]+>", "", str(html or ""))
    t = re.sub(r"\s+", " ", t).strip()
    return t[:n]


data = qbg.get_bulk_questions(IDS, token, user, user_id)
print("Fetched %d question(s)\n" % len(data))
for d in data:
    opts = (d.get("bilingual_options") or {}).get("english") or []
    correct = [i + 1 for i, o in enumerate(opts) if o and o.get("isCorrect")]
    sol0 = (d.get("solutions") or [{}])[0].get("english") or {}
    print("=" * 70)
    print("unique_id            :", d.get("unique_id"))
    print("type                 :", repr(d.get("type")))
    print("is_int_answer        :", repr(d.get("is_int_answer")))
    print("is_range_numerical   :", repr(d.get("is_range_numerical")))
    print("answer               :", repr(d.get("answer")))
    print("range_answer keys    :", [k for k in d.keys() if "answer" in k.lower() or "range" in k.lower() or "numeric" in k.lower()])
    print("n_options            :", len(opts), "| correct option #s:", correct)
    print("stem (first 90 chars):", brief(d.get("content", {}).get("english")))
    print("solution present     :", bool(brief(sol0.get("text"))))
