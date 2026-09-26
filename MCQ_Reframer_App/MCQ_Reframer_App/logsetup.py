# -*- coding: utf-8 -*-
"""Shared file logger. Every module logs here so a run's activity/errors can be read
straight from logs/app.log instead of needing a screenshot/paste of what went wrong."""
import logging, os
from logging.handlers import RotatingFileHandler

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "app.log")

_root = logging.getLogger("mcq_reframer")
if not _root.handlers:
    _root.setLevel(logging.INFO)
    _h = RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    _root.addHandler(_h)
    _root.propagate = False

def get_logger(name=None):
    return _root.getChild(name) if name else _root
