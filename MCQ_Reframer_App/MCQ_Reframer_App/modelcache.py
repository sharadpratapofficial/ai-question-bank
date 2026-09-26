# -*- coding: utf-8 -*-
"""Persists previously-seen model ids per provider (logs/model_cache.json) so the model
dropdowns in app.py still have real options when a live fetch fails (expired/bad key,
network hiccup, rate limit) — and so a provider's dropdown keeps growing to include every
model you've ever pulled for it, not just whatever the live call returns right now."""
import os, json, threading

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "model_cache.json")
_lock = threading.Lock()

def _load():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def remember(provider, model_ids):
    """Merge model_ids into the persisted list for `provider`. No-op if model_ids is empty."""
    if not model_ids:
        return
    with _lock:
        data = _load()
        merged = sorted(set(data.get(provider, [])) | set(model_ids))
        data[provider] = merged
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=0)
        except Exception:
            pass

def recall(provider):
    """Return the persisted model ids previously seen for `provider` (possibly empty)."""
    return _load().get(provider, [])
