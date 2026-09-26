# -*- coding: utf-8 -*-
"""Structured progress events for the long-running QBG pipelines (ingest / tag /
reframe). Each event is written to STDERR as a single line prefixed with
`@@PROGRESS@@` followed by compact JSON, so the Node caller can tee the child's
stderr, pick these lines out, and push them into the job store for the live UI —
while the final JSON report still comes out cleanly on STDOUT.

    @@PROGRESS@@{"stage":"solve","msg":"Solving batch 2/9","done":2,"total":9}
"""
import sys
import json

PREFIX = "@@PROGRESS@@"


def emit(stage, msg="", done=None, total=None):
    ev = {"stage": stage, "msg": msg}
    if done is not None:
        ev["done"] = done
    if total is not None:
        ev["total"] = total
    try:
        sys.stderr.write(PREFIX + json.dumps(ev, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass
