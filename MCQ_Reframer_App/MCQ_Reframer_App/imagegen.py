# -*- coding: utf-8 -*-
"""Optional diagram regeneration (experimental): image-edit call that redraws a question's
original figure to match a described change (app.py's "Let AI redraw the diagram" option).
Only called for questions whose reframed JSON sets a non-null "fig_edit" — see extract.py's
build_prompt(allow_diagram_changes=True)."""
import base64, requests
from logsetup import get_logger
import modelcache

log = get_logger("imagegen")

PROVIDERS = ["Google Gemini (nano banana)", "OpenAI (gpt-image-1)"]
DEFAULT_MODEL = {
    "Google Gemini (nano banana)": "gemini-2.5-flash-image",
    "OpenAI (gpt-image-1)": "gpt-image-1",
}

def list_models(provider, api_key):
    """Return a list of image-capable model ids for `provider`: the live list merged with
    every model id ever seen before for this provider (modelcache.py, logs/model_cache.json).
    Falls back to just the remembered list on a failed live call, and finally to
    [DEFAULT_MODEL[provider]] if nothing was ever seen."""
    ids = []
    try:
        if api_key:
            if provider.startswith("Google Gemini"):
                r = requests.get("https://generativelanguage.googleapis.com/v1beta/models",
                    params={"key": api_key}, timeout=15)
                r.raise_for_status()
                for m in r.json().get("models", []):
                    name = m.get("name", "").split("/")[-1]
                    methods = m.get("supportedGenerationMethods") or []
                    if "image" in name.lower() and "generateContent" in methods:
                        ids.append(name)
            elif provider.startswith("OpenAI"):
                r = requests.get("https://api.openai.com/v1/models",
                    headers={"Authorization": "Bearer " + api_key}, timeout=15)
                r.raise_for_status()
                raw = [m["id"] for m in r.json().get("data", [])]
                ids = [i for i in raw if "dall-e" in i.lower() or "image" in i.lower()]
    except Exception:
        log.exception("list_models failed for provider=%s", provider)

    if ids:
        modelcache.remember(provider, ids)
        return modelcache.recall(provider)   # merged with everything seen before
    recalled = modelcache.recall(provider)
    return recalled or [DEFAULT_MODEL.get(provider, "")]

def edit_image(provider, api_key, model, image_bytes, mime, instruction, timeout=120):
    """Return new image bytes redrawn from `image_bytes` per `instruction` (plain English
    description of what should change / stay the same). Logs request/outcome (never the
    api_key or image bytes) to logs/app.log."""
    model = model or DEFAULT_MODEL.get(provider, "")
    log.info("edit_image start: provider=%s model=%s bytes=%d instruction=%r",
              provider, model, len(image_bytes or b""), instruction[:200])
    try:
        result = _edit_image(provider, api_key, model, image_bytes, mime, instruction, timeout=timeout)
        log.info("edit_image ok: provider=%s model=%s out_bytes=%d", provider, model, len(result or b""))
        return result
    except requests.exceptions.HTTPError as e:
        status = getattr(e.response, "status_code", "?")
        body = e.response.text[:500] if e.response is not None else ""
        log.error("edit_image HTTP error: provider=%s model=%s status=%s body=%s", provider, model, status, body)
        # Surface the provider's actual error message (e.g. OpenAI's org-verification notice)
        # instead of the generic "403 Forbidden" requests.raise_for_status() gives.
        msg = body
        try:
            msg = e.response.json().get("error", {}).get("message") or body
        except Exception:
            pass
        raise RuntimeError("HTTP %s: %s" % (status, msg)) from e
    except Exception:
        log.exception("edit_image failed: provider=%s model=%s", provider, model)
        raise


def _edit_image(provider, api_key, model, image_bytes, mime, instruction, timeout=120):
    if provider.startswith("Google Gemini"):
        url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
               % (model, api_key))
        r = requests.post(url, headers={"Content-Type": "application/json"},
            json={"contents": [{"parts": [
                     {"text": "Redraw this physics diagram with the following change, keeping the "
                              "same style/layout otherwise: " + instruction},
                     {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode()}}]}],
                  "generationConfig": {"responseModalities": ["IMAGE"]}},
            timeout=timeout)
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
        for p in parts:
            inline = p.get("inline_data") or p.get("inlineData")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
        raise RuntimeError("Gemini response had no image data: " + str(r.json())[:300])

    if provider.startswith("OpenAI"):
        r = requests.post("https://api.openai.com/v1/images/edits",
            headers={"Authorization": "Bearer " + api_key},
            files={"image": ("figure.png", image_bytes, mime)},
            data={"model": model,
                  "prompt": "Redraw this physics diagram with the following change, keeping the "
                            "same style/layout otherwise: " + instruction},
            timeout=timeout)
        r.raise_for_status()
        b64 = r.json()["data"][0]["b64_json"]
        return base64.b64decode(b64)

    raise ValueError("Unknown image provider: " + str(provider))
