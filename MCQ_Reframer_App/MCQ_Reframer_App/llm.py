# -*- coding: utf-8 -*-
"""Provider-agnostic LLM call for the optional 'Automatic' mode.
Supports OpenAI, Anthropic (Claude), Google Gemini and OpenRouter via plain REST."""
import os, json, re, base64, requests
from logsetup import get_logger
import modelcache

log = get_logger("llm")

PROVIDERS = ["OpenAI", "Anthropic (Claude)", "Google Gemini", "OpenRouter"]
DEFAULT_MODEL = {
    "OpenAI": "gpt-4o",
    "Anthropic (Claude)": "claude-sonnet-4-6",
    "Google Gemini": "gemini-1.5-pro",
    "OpenRouter": "anthropic/claude-3.5-sonnet",
}
SYSTEM = ("You are an expert physics problem author. You output ONLY a single valid JSON object "
          "matching the schema in the user's message — no markdown, no commentary.")

def list_models(provider, api_key):
    """Return a list of model ids for `provider` (using `api_key` where required): the live
    list from the provider, merged with every model id ever seen before for this provider
    (modelcache.py, logs/model_cache.json) so the dropdown only grows across sessions. If the
    live call fails (missing/bad key, network error, unexpected response shape), falls back to
    just the remembered list, and finally to [DEFAULT_MODEL[provider]] if nothing was ever seen."""
    ids = []
    try:
        if provider == "OpenRouter":
            r = requests.get("https://openrouter.ai/api/v1/models", timeout=15)
            r.raise_for_status()
            ids = sorted({m["id"] for m in r.json().get("data", [])})
        elif api_key:
            if provider == "OpenAI":
                r = requests.get("https://api.openai.com/v1/models",
                    headers={"Authorization": "Bearer " + api_key}, timeout=15)
                r.raise_for_status()
                raw = [m["id"] for m in r.json().get("data", [])]
                ids = [i for i in raw if re.match(r"^(gpt|o[1-9]|chatgpt)", i)
                       and not any(x in i for x in
                           ("audio", "realtime", "embedding", "whisper", "tts", "moderation", "image", "dall-e"))]
            elif provider == "Anthropic (Claude)":
                r = requests.get("https://api.anthropic.com/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"}, timeout=15)
                r.raise_for_status()
                ids = [m["id"] for m in r.json().get("data", [])]
            elif provider == "Google Gemini":
                r = requests.get("https://generativelanguage.googleapis.com/v1beta/models",
                    params={"key": api_key}, timeout=15)
                r.raise_for_status()
                for m in r.json().get("models", []):
                    name = m.get("name", "").split("/")[-1]
                    methods = m.get("supportedGenerationMethods") or []
                    if "generateContent" in methods and "embedding" not in name.lower():
                        ids.append(name)
    except Exception:
        log.exception("list_models failed for provider=%s", provider)

    if ids:
        modelcache.remember(provider, ids)
        return modelcache.recall(provider)   # merged with everything seen before
    recalled = modelcache.recall(provider)
    return recalled or [DEFAULT_MODEL.get(provider, "")]

def collect_images(questions, figdir):
    """Gather every diagram/option-image saved to figdir for this batch, as
    [{"name":filename, "b64":..., "mime":"image/png"}, ...] — same filenames already
    referenced in the prompt text ("figure available: qN_figure.png" etc.), so the
    model can match each image to its question."""
    names = []
    for q in questions:
        if q.get("fig_name"):
            names.append(q["fig_name"])
        for n in (q.get("opt_img_names") or []):
            names.append(n)
    images = []
    for name in names:
        path = os.path.join(figdir, name)
        if os.path.exists(path):
            with open(path, "rb") as f:
                images.append({"name": name, "mime": "image/png",
                               "b64": base64.b64encode(f.read()).decode()})
    return images


def _extract_json(text):
    """Pull the first JSON object out of a model response."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        a = text.find("{"); b = text.rfind("}")
        if a != -1 and b != -1 and b > a:
            return json.loads(text[a:b+1])
        raise

def _openai_content(prompt, images):
    if not images:
        return prompt
    content = [{"type": "text", "text": prompt}]
    for im in images:
        content.append({"type": "text", "text": "Image file: %s" % im["name"]})
        content.append({"type": "image_url",
                        "image_url": {"url": "data:%s;base64,%s" % (im["mime"], im["b64"])}})
    return content


def _anthropic_content(prompt, images):
    content = [{"type": "text", "text": prompt}]
    for im in images:
        content.append({"type": "text", "text": "Image file: %s" % im["name"]})
        content.append({"type": "image",
                        "source": {"type": "base64", "media_type": im["mime"], "data": im["b64"]}})
    return content


def _gemini_parts(prompt, images):
    parts = [{"text": prompt}]
    for im in images:
        parts.append({"text": "Image file: %s" % im["name"]})
        parts.append({"inline_data": {"mime_type": im["mime"], "data": im["b64"]}})
    return parts


def generate(provider, api_key, model, prompt, images=None, timeout=300):
    """Return parsed JSON dict from the chosen provider. Logs the request/outcome to
    logs/app.log (never the api_key) so failures can be diagnosed from the log file."""
    model = model or DEFAULT_MODEL.get(provider, "")
    n_images = len(images or [])
    log.info("generate start: provider=%s model=%s images=%d prompt_chars=%d",
              provider, model, n_images, len(prompt or ""))
    try:
        result = _generate(provider, api_key, model, prompt, images=images, timeout=timeout)
        log.info("generate ok: provider=%s model=%s questions=%d",
                  provider, model, len((result or {}).get("questions") or []))
        return result
    except requests.exceptions.HTTPError as e:
        body = e.response.text[:500] if e.response is not None else ""
        log.error("generate HTTP error: provider=%s model=%s status=%s body=%s",
                   provider, model, getattr(e.response, "status_code", "?"), body)
        raise
    except Exception:
        log.exception("generate failed: provider=%s model=%s", provider, model)
        raise


def _generate(provider, api_key, model, prompt, images=None, timeout=300):
    images = images or []
    if provider == "OpenAI":
        r = requests.post("https://api.openai.com/v1/chat/completions",
            headers={"Authorization": "Bearer "+api_key, "Content-Type": "application/json"},
            json={"model": model, "temperature": 0.4,
                  "response_format": {"type": "json_object"},
                  "messages": [{"role": "system", "content": SYSTEM},
                               {"role": "user", "content": _openai_content(prompt, images)}]},
            timeout=timeout)
        r.raise_for_status()
        return _extract_json(r.json()["choices"][0]["message"]["content"])

    if provider == "OpenRouter":
        r = requests.post("https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": "Bearer "+api_key, "Content-Type": "application/json"},
            json={"model": model, "temperature": 0.4,
                  "messages": [{"role": "system", "content": SYSTEM},
                               {"role": "user", "content": _openai_content(prompt, images)}]},
            timeout=timeout)
        r.raise_for_status()
        return _extract_json(r.json()["choices"][0]["message"]["content"])

    if provider == "Anthropic (Claude)":
        r = requests.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "Content-Type": "application/json"},
            json={"model": model, "max_tokens": 20000, "temperature": 0.4,
                  "system": SYSTEM,
                  "messages": [{"role": "user", "content": _anthropic_content(prompt, images)}]},
            timeout=timeout)
        r.raise_for_status()
        parts = r.json()["content"]
        text = "".join(p.get("text", "") for p in parts)
        return _extract_json(text)

    if provider == "Google Gemini":
        url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
               % (model, api_key))
        r = requests.post(url,
            headers={"Content-Type": "application/json"},
            json={"systemInstruction": {"parts": [{"text": SYSTEM}]},
                  "contents": [{"parts": _gemini_parts(prompt, images)}],
                  "generationConfig": {"temperature": 0.4, "response_mime_type": "application/json"}},
            timeout=timeout)
        r.raise_for_status()
        cand = r.json()["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in cand)
        return _extract_json(text)

    raise ValueError("Unknown provider: "+str(provider))
