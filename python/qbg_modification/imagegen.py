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
    # Nano Banana 2. Mirrors IMG_DEFAULT_MODEL in src/lib/qbgAiDefaults.ts — this
    # one only applies when the CLI is run directly with no --img-model.
    "Google Gemini (nano banana)": "gemini-3.1-flash-image",
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


# Sent to the image-editing model verbatim (with {instruction} filled in from the
# reframe LLM's "fig_edit" field). Structured as a strict, minimal-change "surgical
# edit" rather than a loose "redraw" — image-edit models drift toward regenerating
# the whole scene (moving/restyling unrelated labels, misplacing the new value) when
# given vague instructions, which is the main source of diagrams coming back wrong.
_EDIT_PROMPT_TMPL = (
    "This is a PRECISE, SURGICAL edit of an existing exam diagram — not a new drawing. "
    "The attached image IS the original diagram; return that SAME diagram with ONLY the "
    "one described change applied, pixel-faithful everywhere else.\n\n"
    "CHANGE TO MAKE: {instruction}\n\n"
    "STRICT RULES — follow all of them:\n"
    "1. Every other label, number, arrow, symbol, and shape MUST stay in its EXACT original "
    "position, size, font, and color. Do not move, resize, restyle, recolor, or redraw anything "
    "that was not explicitly named in the change above.\n"
    "2. Keep the exact same line weights, colors, background, camera angle, and overall "
    "composition as the original image — this is an edit, not a re-render.\n"
    "3. Place the new/changed value in the EXACT same location as the value it replaces, in the "
    "same font size/style/orientation, so it reads naturally in place of the old one — do not "
    "shift it to a different spot in the diagram.\n"
    "4. Do not add any new labels, arrows, decorations, gridlines, or elements beyond what the "
    "change above asks for.\n"
    "5. Do not remove or blank out any element that the change above did not mention.\n"
    "6. Before finishing, double-check the edited text/value is spelled and formatted exactly as "
    "specified, fully inside the image bounds, legible, and not overlapping any other element.\n"
    "If the change's target position is ambiguous, infer it from the ORIGINAL diagram's own "
    "layout — never guess a new, different location for it."
)


# Sent verbatim (with {desc} filled in) when a question DESCRIBES a diagram but the
# Word file has no image for it (QBG Ingestion's "generate the diagram with AI"). Unlike
# _EDIT_PROMPT_TMPL this is a from-scratch draw, so it steers toward the clean,
# unambiguous, exam-style figure a student would see — not an artistic illustration.
_GEN_PROMPT_TMPL = (
    "Draw a single, clean, black-on-white EXAM DIAGRAM for the physics/chemistry/maths "
    "question described below — the kind of precise line figure printed next to a question "
    "in a textbook or test paper. This is a technical schematic, NOT an artistic or 3D "
    "rendered illustration.\n\n"
    "DIAGRAM TO DRAW: {desc}\n\n"
    "STRICT RULES — follow all of them:\n"
    "1. Plain white background, crisp thin black lines, no shading, no gradients, no "
    "textures, no color unless the description explicitly names a color.\n"
    "2. Label every point, length, angle, force, and value EXACTLY as named in the "
    "description, placed next to the element it belongs to. Do not invent extra labels or "
    "values, and do not omit any that were given.\n"
    "3. Keep it geometrically faithful: right angles look like right angles, equal lengths "
    "look equal, arrows point the stated direction, and the layout matches the description.\n"
    "4. Use standard exam notation (arrows for vectors/forces, tick marks, angle arcs, "
    "dashed construction lines) and keep everything legible and non-overlapping.\n"
    "5. No title text, no watermark, no question text, no answer — only the diagram itself.\n"
    "6. Before finishing, re-check every label and value is spelled exactly as specified and "
    "fully inside the image bounds."
)


def generate_image(provider, api_key, model, description, timeout=120):
    """Return image bytes for a brand-new diagram drawn from a plain-English `description`
    (used by QBG Ingestion when a figure is described but absent). Logs request/outcome
    (never the api_key) to logs/app.log."""
    model = model or DEFAULT_MODEL.get(provider, "")
    log.info("generate_image start: provider=%s model=%s desc=%r", provider, model, (description or "")[:200])
    try:
        result = _generate_image(provider, api_key, model, description, timeout=timeout)
        log.info("generate_image ok: provider=%s model=%s out_bytes=%d", provider, model, len(result or b""))
        return result
    except requests.exceptions.HTTPError as e:
        status = getattr(e.response, "status_code", "?")
        body = e.response.text[:500] if e.response is not None else ""
        log.error("generate_image HTTP error: provider=%s model=%s status=%s body=%s", provider, model, status, body)
        msg = body
        try:
            msg = e.response.json().get("error", {}).get("message") or body
        except Exception:
            pass
        raise RuntimeError("HTTP %s: %s" % (status, msg)) from e
    except Exception:
        log.exception("generate_image failed: provider=%s model=%s", provider, model)
        raise


def _generate_image(provider, api_key, model, description, timeout=120):
    prompt = _GEN_PROMPT_TMPL.format(desc=description)

    if provider.startswith("Google Gemini"):
        url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
               % (model, api_key))
        r = requests.post(url, headers={"Content-Type": "application/json"},
            json={"contents": [{"parts": [{"text": prompt}]}],
                  "generationConfig": {"responseModalities": ["IMAGE"]}},
            timeout=timeout)
        r.raise_for_status()
        payload = r.json()
        cand_list = payload.get("candidates") or []
        if not cand_list:
            raise RuntimeError("Gemini returned no candidates: " + str(payload)[:300])
        parts = (cand_list[0].get("content") or {}).get("parts") or []
        for p in parts:
            inline = p.get("inline_data") or p.get("inlineData")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
        raise RuntimeError("Gemini response had no image data: " + str(payload)[:300])

    if provider.startswith("OpenAI"):
        r = requests.post("https://api.openai.com/v1/images/generations",
            headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
            json={"model": model, "prompt": prompt, "n": 1, "size": "1024x1024"},
            timeout=timeout)
        r.raise_for_status()
        b64 = r.json()["data"][0]["b64_json"]
        return base64.b64decode(b64)

    raise ValueError("Unknown image provider: " + str(provider))


def _edit_image(provider, api_key, model, image_bytes, mime, instruction, timeout=120):
    prompt = _EDIT_PROMPT_TMPL.format(instruction=instruction)

    if provider.startswith("Google Gemini"):
        url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
               % (model, api_key))
        r = requests.post(url, headers={"Content-Type": "application/json"},
            json={"contents": [{"parts": [
                     {"text": prompt},
                     {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode()}}]}],
                  "generationConfig": {"responseModalities": ["IMAGE"]}},
            timeout=timeout)
        r.raise_for_status()
        payload = r.json()
        cand_list = payload.get("candidates") or []
        if not cand_list:
            raise RuntimeError("Gemini returned no candidates: " + str(payload)[:300])
        parts = (cand_list[0].get("content") or {}).get("parts") or []
        for p in parts:
            inline = p.get("inline_data") or p.get("inlineData")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
        raise RuntimeError("Gemini response had no image data: " + str(payload)[:300])

    if provider.startswith("OpenAI"):
        r = requests.post("https://api.openai.com/v1/images/edits",
            headers={"Authorization": "Bearer " + api_key},
            files={"image": ("figure.png", image_bytes, mime)},
            data={"model": model, "prompt": prompt},
            timeout=timeout)
        r.raise_for_status()
        b64 = r.json()["data"][0]["b64_json"]
        return base64.b64decode(b64)

    raise ValueError("Unknown image provider: " + str(provider))
