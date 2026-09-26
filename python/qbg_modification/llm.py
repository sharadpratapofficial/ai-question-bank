# -*- coding: utf-8 -*-
"""Provider-agnostic LLM call for the optional 'Automatic' mode.
Supports OpenAI, Anthropic (Claude), Google Gemini and OpenRouter via plain REST."""
import os, json, re, base64, requests
import time as _time
from logsetup import get_logger
import modelcache

log = get_logger("llm")

# App-style provider ids (match src/types/extraction.ts AI_PROVIDER_MODELS keys),
# so the sidecar accepts every provider the rest of the app offers.
PROVIDERS = ["gemini", "anthropic", "openai", "openrouter", "groq", "grok",
             "nvidia", "fireworks", "custom_openai", "local", "g4f"]
DEFAULT_MODEL = {
    "gemini": "gemini-1.5-pro",
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "openrouter": "anthropic/claude-3.5-sonnet",
    "groq": "llama-3.3-70b-versatile",
    "grok": "grok-2-latest",
    "nvidia": "meta/llama-3.1-70b-instruct",
    "fireworks": "accounts/fireworks/models/llama-v3p1-70b-instruct",
    "custom_openai": "",
    "local": "",
    "g4f": "gpt-4o",
}

# Providers whose endpoint the user runs themselves; they supply their own base
# URL and need no API key.
SELF_HOSTED = ("custom_openai", "local", "g4f")
# The address `g4f api` binds to out of the box, so the sidecar can be pointed at
# a default-configured g4f server without QBG_MOD_BASE_URL being set.
G4F_DEFAULT_BASE = "http://localhost:1337/v1"

# OpenAI-compatible providers → base URL (custom_openai / local / g4f supply their own).
_OPENAI_COMPAT_BASE = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "grok": "https://api.x.ai/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
}
_OPENAI_COMPAT_HEADERS = {
    "openrouter": {"HTTP-Referer": "https://question-bank.app", "X-Title": "QBG AI Tools"},
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


def _scrub_secrets(text, api_key):
    """Remove the API key (and any key=... query param) from an error string before it
    can reach logs shown to users, task history, or the UI."""
    t = str(text or "")
    if api_key:
        t = t.replace(api_key, "***")
    return re.sub(r"([?&]key=)[^&\s\"']+", r"\1***", t)


def _first_json_object(text):
    """Return the substring of the first balanced top-level {...} object (respecting
    strings/escapes), or None. Robust to trailing prose after the JSON ('Extra data')."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
    return None   # never balanced (truncated mid-object)


def _strip_trailing_commas(s):
    return re.sub(r",(\s*[}\]])", r"\1", s)


# Only these follow a backslash in real JSON we care about. We deliberately EXCLUDE
# b/f/n/r/t: this repair runs only as a fallback after json.loads already failed, on
# exam/LaTeX content where "\frac", "\theta", "\rho", "\beta", "\tau" are far more likely
# than an intended form-feed/newline — so we double those backslashes to recover the LaTeX.
_VALID_ESC = set('"\\/u')
_CTRL_MAP = {"\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f"}


def _repair_json_strings(s):
    """Best-effort repair of the ways LLMs most often emit invalid JSON, operating ONLY
    inside string literals (structure untouched):
      * a backslash not forming a JSON escape we keep — LaTeX like \\frac, \\sqrt, \\sin,
        \\theta — gets doubled so it survives json.loads instead of raising, and the LaTeX
        is preserved rather than silently turning into a control char.
      * a raw control char (literal newline/tab) inside a string gets escaped.
    Doesn't try to fix unescaped inner quotes (ambiguous); retries handle those."""
    out = []
    i, n = 0, len(s)
    in_str = False
    while i < n:
        c = s[i]
        if not in_str:
            out.append(c)
            if c == '"':
                in_str = True
            i += 1
            continue
        if c == "\\":
            nxt = s[i + 1] if i + 1 < n else ""
            if nxt in _VALID_ESC:
                out.append(c)
                out.append(nxt)
                i += 2
            else:
                out.append("\\\\")   # stray backslash -> escape it
                i += 1
            continue
        if c == '"':
            out.append(c)
            in_str = False
            i += 1
            continue
        if ord(c) < 0x20:
            out.append(_CTRL_MAP.get(c, "\\u%04x" % ord(c)))
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _extract_json(text):
    """Pull the first JSON object out of a model response, tolerating markdown fences,
    trailing prose after the object, and trailing commas."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    obj = _first_json_object(text)
    if obj is not None:
        for candidate in (obj, _strip_trailing_commas(obj),
                          _repair_json_strings(_strip_trailing_commas(obj))):
            try:
                return json.loads(candidate)
            except Exception:
                continue
    # last resort: greedy first"{" .. last"}", with repair
    a = text.find("{"); b = text.rfind("}")
    last_err = None
    if a != -1 and b != -1 and b > a:
        chunk = _strip_trailing_commas(text[a:b + 1])
        for candidate in (chunk, _repair_json_strings(chunk)):
            try:
                return json.loads(candidate)
            except Exception as e:
                last_err = e
    if a == -1:
        raise ValueError("no JSON object found in model output")
    # Braces exist but nothing parsed — usually a response truncated mid-JSON.
    # Surface the real parse error so the failure is diagnosable (not mislabeled).
    raise ValueError("model output looks like truncated/invalid JSON: %s"
                     % (str(last_err)[:200] if last_err else "unbalanced braces"))

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


def _api_error_message(body):
    """Pull the human-readable reason out of a provider's error body.

    OpenAI/OpenRouter: {"error": {"message": "..."}}. Gemini returns a list
    wrapper. Falls back to a trimmed snippet of the raw body so SOMETHING
    useful always surfaces, and returns "" when there's nothing to show."""
    raw = (body or "").strip()
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
        if isinstance(obj, list) and obj:
            obj = obj[0]
        if isinstance(obj, dict):
            err = obj.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            if isinstance(err, str) and err:
                return err
            if obj.get("message"):
                return str(obj["message"])
    except Exception:
        pass
    return re.sub(r"\s+", " ", raw)[:400]


def generate(provider, api_key, model, prompt, images=None, timeout=300, system=None,
            base_url=None, max_tokens=None):
    """Return parsed JSON dict from the chosen provider. Logs the request/outcome to
    logs/app.log (never the api_key) so failures can be diagnosed from the log file.
    `system` overrides the default author SYSTEM prompt (used by ai_extract).
    `base_url` supplies the endpoint for custom_openai / local providers.
    `max_tokens` caps the output budget — IMPORTANT for large batches: without an
    explicit (generous) budget, some providers silently truncate a big JSON response
    mid-array, which can look like "only 1 of 20 questions came back". Defaults to
    8000 (20000 for Anthropic, which comfortably supports it) when not given."""
    model = model or DEFAULT_MODEL.get(provider, "")
    n_images = len(images or [])
    mt = max_tokens or (20000 if provider == "anthropic" else 8000)
    log.info("generate start: provider=%s model=%s images=%d prompt_chars=%d max_tokens=%d",
              provider, model, n_images, len(prompt or ""), mt)
    # Rate limits (HTTP 429) and transient outages (5xx) get a real backoff-and-retry
    # here so EVERY caller (ingest, reframe, tagging) benefits — previously a burst of
    # free-tier 429s failed the whole job instantly.
    _RETRYABLE = (429, 500, 502, 503, 529)
    for attempt in range(4):
        try:
            result = _generate(provider, api_key, model, prompt, images=images,
                               timeout=timeout, system=system, base_url=base_url, max_tokens=mt)
            n_q = len((result or {}).get("questions") or [])
            log.info("generate ok: provider=%s model=%s questions=%d", provider, model, n_q)
            return result
        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            body = e.response.text[:500] if e.response is not None else ""
            log.error("generate HTTP error: provider=%s model=%s status=%s body=%s",
                       provider, model, status, body)
            if status in _RETRYABLE and attempt < 3:
                ra = (e.response.headers.get("Retry-After") if e.response is not None else None)
                wait = float(ra) if (ra and str(ra).replace(".", "", 1).isdigit()) else 15 * (2 ** attempt)
                wait = min(wait, 120)
                log.warning("generate: HTTP %s — backing off %.0fs (attempt %d/4)", status, wait, attempt + 1)
                _time.sleep(wait)
                continue
            # NEVER let the API key leak into error messages (Gemini puts it in the
            # URL, and the raised text ends up in task history / UI).
            #
            # str(e) is only requests' generic "400 Client Error: Bad Request for
            # url: ..." — the ACTUAL reason lives in the response body, which used
            # to reach app.log alone. Surface it, so a failed run says what to fix
            # instead of leaving the user to dig through logs (2026-08-17: seven
            # chunks failed with an opaque 400 that was really "use
            # max_completion_tokens").
            msg = _scrub_secrets(str(e), api_key)
            detail = _api_error_message(body)
            if detail:
                raise RuntimeError("HTTP %s from %s: %s"
                                   % (status, provider,
                                      _scrub_secrets(detail, api_key)[:400])) from None
            raise RuntimeError("HTTP %s from %s: %s" % (status, provider, msg[:300])) from None
        except requests.exceptions.RequestException as e:
            log.error("generate network error: provider=%s model=%s err=%s", provider, model, str(e)[:200])
            if attempt < 3:
                _time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError("network error calling %s: %s"
                               % (provider, _scrub_secrets(str(e), api_key)[:300])) from None
        except Exception:
            log.exception("generate failed: provider=%s model=%s", provider, model)
            raise


def _wants_completion_tokens(model):
    """True for OpenAI families that REJECT the legacy `max_tokens` (they require
    `max_completion_tokens`) and refuse any temperature but the default.

    Covers the o-series and the whole GPT-5 line, including release names we
    can't predict — "gpt-5.6-terra" 400'd every reframe chunk with
    "Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens'"
    (2026-08-17 bug report). The adaptive retry in _openai_single_call is the
    real safety net; this just gets the first request right so a whole run
    doesn't pay an extra round-trip per chunk."""
    m = (model or "").lower()
    return m.startswith(("o1", "o3", "o4", "gpt-5"))


def _openai_single_call(base, headers, model, prompt, images, sys_prompt, timeout, max_tokens):
    """One HTTP attempt: tries JSON mode (response_format) first, retries without it
    if the provider rejects it. Returns (text, finish_reason).

    Falls back on 400 OR 404: OpenRouter (and likely other gateways) return 404
    "No endpoints found that support the requested parameters" — NOT 400 — when a
    model exists but none of its current providers support response_format/
    structured outputs (common for brand-new models where only some backing
    providers have added support yet). Only checking 400 meant a real 404 for this
    reason permanently failed the call, misread as "the model doesn't exist"
    (2026-07-19 bug: z-ai/glm-5.2 — a valid, listed OpenRouter model — 404'd on
    every request because json_object mode wasn't yet supported for it)."""
    body = {"model": model,
            "messages": [{"role": "system", "content": sys_prompt},
                         {"role": "user", "content": _openai_content(prompt, images)}]}
    if _wants_completion_tokens(model):
        body["max_completion_tokens"] = max_tokens
    else:
        body["max_tokens"] = max_tokens
        body["temperature"] = 0.4

    use_json_mode = True
    r = None
    # Up to 4 passes: each 400/404 tells us which parameter the model rejects,
    # we drop/swap that one and retry. Bounded, and every branch either mutates
    # the payload or stops, so it can't spin.
    for _attempt in range(4):
        payload = dict(body)
        if use_json_mode:
            payload["response_format"] = {"type": "json_object"}
        r = requests.post(base + "/chat/completions", headers=headers, json=payload, timeout=timeout)
        if r.status_code not in (400, 404):
            break
        err = (r.text or "").lower()
        # Newer OpenAI families renamed the output cap and froze temperature.
        if "max_completion_tokens" in err and "max_tokens" in body:
            body["max_completion_tokens"] = body.pop("max_tokens")
            continue
        if "temperature" in err and "temperature" in body:
            body.pop("temperature")
            continue
        if use_json_mode:
            use_json_mode = False  # provider likely lacks response_format support
            continue
        break
    r.raise_for_status()
    choice = (r.json().get("choices") or [{}])[0]
    return (choice.get("message") or {}).get("content") or "", choice.get("finish_reason")
    r.raise_for_status()
    choice = (r.json().get("choices") or [{}])[0]
    return (choice.get("message") or {}).get("content") or "", choice.get("finish_reason")


def _openai_compatible(base, api_key, model, prompt, images, sys_prompt, timeout,
                       extra_headers=None, max_tokens=None):
    """POST to an OpenAI-compatible /chat/completions endpoint. If the response was
    cut off mid-JSON (finish_reason == "length"), retries with a doubled max_tokens
    budget (up to 3 attempts) instead of failing outright — mirrors the Gemini
    retry-on-truncation pattern in _generate(). Previously this only recognized
    truncation when the response was entirely EMPTY, so a response that got most of
    the way through a multi-question chunk before running out of budget (the common
    case — you get several complete questions, then the array cuts off mid-object)
    was a silent, permanent, unrecoverable failure of the whole chunk."""
    base = (base or "").rstrip("/")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    if extra_headers:
        headers.update(extra_headers)
    budget = max_tokens or 8000
    for attempt in range(3):
        text, finish_reason = _openai_single_call(base, headers, model, prompt, images,
                                                   sys_prompt, timeout, budget)
        if finish_reason == "length" and not text.strip():
            raise RuntimeError("Model hit its token limit before producing any output — "
                               "try a smaller batch or increase max_tokens.")
        try:
            return _extract_json(text)
        except ValueError:
            if finish_reason == "length" and attempt < 2:
                log.warning("openai-compatible JSON truncated at finish_reason=length "
                            "(model=%s budget=%d text_chars=%d) — retrying with a bigger budget",
                            model, budget, len(text))
                budget = min(budget * 2, 32000)
                continue
            raise


def _generate(provider, api_key, model, prompt, images=None, timeout=300, system=None,
              base_url=None, max_tokens=None):
    images = images or []
    sys_prompt = system or SYSTEM

    if provider == "gemini":
        url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
               % (model, api_key))
        # Thinking models (gemini-2.5/3.x) emit internal "thought" parts BEFORE the
        # answer, and those thoughts count against maxOutputTokens — measured 4.7k
        # thinking tokens for a single reframed question, 6.7k for a 5-question chunk.
        # Callers size max_tokens for the ANSWER alone, so: (1) give every call a
        # generous thinking headroom up front; (2) exclude thought parts from the text
        # we parse as JSON; (3) if the answer still comes back empty or truncated at
        # MAX_TOKENS, retry with a doubled budget instead of failing.
        budget = min((max_tokens or 8000) + 16384, 65536)
        last_detail = ""
        for _attempt in range(3):
            gen_cfg = {"temperature": 0.4, "response_mime_type": "application/json",
                       "maxOutputTokens": budget}
            r = requests.post(url,
                headers={"Content-Type": "application/json"},
                json={"systemInstruction": {"parts": [{"text": sys_prompt}]},
                      "contents": [{"parts": _gemini_parts(prompt, images)}],
                      "generationConfig": gen_cfg},
                timeout=timeout)
            r.raise_for_status()
            payload = r.json()
            cand_list = payload.get("candidates") or []
            if not cand_list:
                raise RuntimeError("Gemini returned no candidates: " + str(payload)[:300])
            cand0 = cand_list[0]
            finish_reason = cand0.get("finishReason")
            parts = (cand0.get("content") or {}).get("parts") or []
            answer = "".join(p.get("text", "") for p in parts if not p.get("thought"))
            if answer.strip():
                try:
                    return _extract_json(answer)
                except ValueError:
                    if finish_reason == "MAX_TOKENS":
                        # Truncated mid-JSON because thinking ate the budget — retry bigger.
                        log.warning("gemini JSON truncated at MAX_TOKENS (model=%s budget=%d "
                                    "answer_chars=%d) — retrying with a bigger budget",
                                    model, budget, len(answer))
                        last_detail = "finishReason=MAX_TOKENS truncated_answer_chars=%d budget=%d" % (len(answer), budget)
                        budget = min(budget * 2, 65536)
                        continue
                    # Log what actually came back so parse failures are diagnosable
                    # from app.log (part keys + first 600 chars of the answer).
                    log.error("gemini non-JSON answer (model=%s finish=%s part_keys=%s): %r",
                              model, finish_reason,
                              [sorted(p.keys()) for p in parts][:6], answer[:600])
                    raise
            thought_chars = sum(len(p.get("text", "")) for p in parts if p.get("thought"))
            last_detail = ("finishReason=%s thought_chars=%d budget=%d"
                           % (finish_reason, thought_chars, budget))
            log.warning("gemini answer empty (%s): %s — %s", model, last_detail,
                        "retrying with a bigger budget" if finish_reason == "MAX_TOKENS" else "not retrying")
            if finish_reason != "MAX_TOKENS":
                break  # empty for some other reason; a bigger budget won't help
            budget = min(budget * 2, 65536)
        raise RuntimeError(
            "Gemini produced no answer text (%s) — the 'thinking' model likely spent its "
            "whole output budget reasoning. Try a smaller batch or a non-thinking model."
            % last_detail)

    if provider == "anthropic":
        # Retry with a doubled budget when the response was cut off mid-JSON
        # (stop_reason == "max_tokens") — mirrors the Gemini retry-on-truncation
        # pattern above. Previously this only recognized truncation when the
        # response was entirely EMPTY, so a response that got most of the way
        # through a multi-question chunk before running out of budget (several
        # complete questions, then cut off mid-object) was a silent, permanent,
        # unrecoverable failure of the whole chunk.
        budget = max_tokens or 20000
        for attempt in range(3):
            r = requests.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                         "Content-Type": "application/json"},
                json={"model": model, "max_tokens": budget, "temperature": 0.4,
                      "system": sys_prompt,
                      "messages": [{"role": "user", "content": _anthropic_content(prompt, images)}]},
                timeout=timeout)
            r.raise_for_status()
            body = r.json()
            parts = body["content"]
            text = "".join(p.get("text", "") for p in parts)
            stop_reason = body.get("stop_reason")
            if stop_reason == "max_tokens" and not text.strip():
                raise RuntimeError("Anthropic hit max_tokens before producing any output — "
                                   "try a smaller batch or increase max_tokens.")
            try:
                return _extract_json(text)
            except ValueError:
                if stop_reason == "max_tokens" and attempt < 2:
                    log.warning("anthropic JSON truncated at stop_reason=max_tokens (model=%s "
                                "budget=%d text_chars=%d) — retrying with a bigger budget",
                                model, budget, len(text))
                    budget = min(budget * 2, 32000)
                    continue
                raise

    # Everything else is OpenAI-compatible (openai / openrouter / groq / grok /
    # nvidia / fireworks / custom_openai / local / g4f).
    base = base_url or _OPENAI_COMPAT_BASE.get(provider)
    if not base and provider == "g4f":
        base = G4F_DEFAULT_BASE
    if not base:
        raise ValueError("Unknown provider or missing base_url: " + str(provider))
    # A server the user runs themselves authenticates however it likes (usually
    # not at all), so an empty key is normal rather than a misconfiguration.
    key = "" if provider in ("local", "g4f") else api_key
    return _openai_compatible(base, key, model, prompt, images, sys_prompt, timeout,
                              extra_headers=_OPENAI_COMPAT_HEADERS.get(provider),
                              max_tokens=max_tokens)
