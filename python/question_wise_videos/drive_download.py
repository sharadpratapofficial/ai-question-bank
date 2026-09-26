# -*- coding: utf-8 -*-
"""
drive_download
==============

Downloads a file from a PUBLIC ("Anyone with the link can view") Google
Drive share link — no API key or OAuth needed. Handles Drive's "Google Drive
can't scan this file for viruses" interstitial that replaces the direct
download for files large enough to trigger it (most lecture-length videos):
the interstitial is an HTML page (not the file) carrying a `confirm` token
that must be replayed on a second request.

Public API
----------
    extract_file_id(url_or_id: str) -> str
    download_from_drive(url_or_id, dest_path, *, progress=lambda *_a: None) -> Path
"""
from __future__ import annotations

import re
from pathlib import Path

import requests

_ID_PATTERNS = [
    re.compile(r"/file/d/([a-zA-Z0-9_-]+)"),
    re.compile(r"[?&]id=([a-zA-Z0-9_-]+)"),
]
_BARE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{20,}$")

_CONFIRM_RE = re.compile(r"confirm=([0-9A-Za-z_-]+)")
_HIDDEN_FIELD_RE = re.compile(r'name="([^"]+)"\s+value="([^"]*)"')
_DOWNLOAD_URL = "https://drive.google.com/uc"
# As of 2026, Drive's virus-scan interstitial submits its "Download anyway"
# form to a DIFFERENT domain than the one that served the interstitial —
# retrying against drive.google.com/uc (even with a confirm param) still
# returns HTML. The form's own `action` attribute is this URL.
_CONFIRM_DOWNLOAD_URL = "https://drive.usercontent.google.com/download"


def extract_file_id(url_or_id: str) -> str:
    url_or_id = url_or_id.strip()
    if _BARE_ID_RE.match(url_or_id):
        return url_or_id
    for pat in _ID_PATTERNS:
        m = pat.search(url_or_id)
        if m:
            return m.group(1)
    raise ValueError(f"Could not find a Google Drive file id in: {url_or_id!r}")


def _parse_interstitial_form_fields(html: str) -> dict[str, str] | None:
    """The 2026-era 'can't scan for viruses' interstitial is an HTML <form>
    (id/export/confirm/uuid as hidden inputs) whose own `action` submits to a
    DIFFERENT domain than the one that served the page. `confirm`'s value is
    a fixed literal ("t"), not a per-file token, but `uuid` is per-request and
    required — so all hidden fields must be replayed together."""
    fields = dict(_HIDDEN_FIELD_RE.findall(html))
    return fields if "confirm" in fields else None


def _find_confirm_token(resp: requests.Response) -> str | None:
    """Older/fallback interstitial format: a `download_warning*` cookie or a
    literal `confirm=TOKEN` substring in the page, replayed against the same
    drive.google.com/uc endpoint. Kept alongside the newer form-based parser
    above in case Drive serves this format for smaller files."""
    for name, value in resp.cookies.items():
        if name.startswith("download_warning"):
            return value
    m = _CONFIRM_RE.search(resp.text)
    if m:
        return m.group(1)
    return None


def download_from_drive(url_or_id: str, dest_path: str | Path, *,
                        progress=lambda *_a: None, timeout: int = 60) -> Path:
    file_id = extract_file_id(url_or_id)
    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    params = {"id": file_id, "export": "download"}
    resp = session.get(_DOWNLOAD_URL, params=params, stream=True, timeout=timeout)
    resp.raise_for_status()

    content_type = resp.headers.get("Content-Type", "")
    if "text/html" in content_type:
        # This is the "can't scan for viruses" interstitial, not the file —
        # read it fully (small page) to pull the confirm token, then retry.
        resp = session.get(_DOWNLOAD_URL, params=params, timeout=timeout)
        form_fields = _parse_interstitial_form_fields(resp.text)
        if form_fields:
            resp = session.get(_CONFIRM_DOWNLOAD_URL, params=form_fields, stream=True, timeout=timeout)
        else:
            token = _find_confirm_token(resp)
            if not token:
                raise RuntimeError(
                    "Google Drive returned an interstitial page with no confirm "
                    "token — the link may be private, deleted, or Drive changed "
                    "its interstitial format. Make sure the file is shared as "
                    '"Anyone with the link" and try again.'
                )
            params["confirm"] = token
            resp = session.get(_DOWNLOAD_URL, params=params, stream=True, timeout=timeout)
        resp.raise_for_status()
        if "text/html" in resp.headers.get("Content-Type", ""):
            raise RuntimeError(
                "Google Drive still returned an HTML page after supplying a "
                "confirm token — the file may be private or not shared "
                'with "Anyone with the link".'
            )

    total = int(resp.headers.get("Content-Length") or 0)
    written = 0
    chunk_size = 1024 * 1024
    last_reported_mb = -1
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=chunk_size):
            if not chunk:
                continue
            f.write(chunk)
            written += len(chunk)
            mb = written // (5 * 1024 * 1024)
            if mb != last_reported_mb:
                last_reported_mb = mb
                if total:
                    progress(f"Downloading... {written / 1e6:.0f}MB / {total / 1e6:.0f}MB")
                else:
                    progress(f"Downloading... {written / 1e6:.0f}MB")

    if written == 0:
        raise RuntimeError("Downloaded 0 bytes — the Drive link may be invalid or inaccessible.")
    progress(f"Downloaded {written / 1e6:.0f}MB -> {dest_path.name}")
    return dest_path


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Download a public Google Drive file.")
    ap.add_argument("url_or_id")
    ap.add_argument("dest_path")
    args = ap.parse_args()

    def _progress(msg: str) -> None:
        print(msg, file=sys.stderr)

    path = download_from_drive(args.url_or_id, args.dest_path, progress=_progress)
    print(str(path))
