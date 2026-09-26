"""
narrator
========

Multi-provider narrator. Given (question image, solution image, answer) it
asks the configured LLM to return a JSON array of synced narration tokens.

Each token is one small chunk synchronised with exactly one symbol/word
appearing on screen — so the video looks like a tutor writing while speaking:

    {
      "newline": true|false,   # start a new line on the right panel
      "say":     "...",        # spoken phrase for this token (1-5 words)
      "write":   "..."         # plain-text/unicode chunk to write on screen
    }

Conventions for `write`:
- Plain text or inline math only — NO LaTeX backslashes.
- Use Unicode for math symbols where possible: ² ³ Δ π √ · ∫ ≤ ≥ ⇒ → etc.
- Fractions are inline with a slash: "dv/dx", "Δm/m", "8F/9".
- Equality and operators with surrounding spaces: " = ", " + ", " · ".

The video builder appends each token's `write` to the right of the current
line at the moment its `say` finishes. `newline:true` flushes the current
line and starts a new one.

Provider support
----------------
The narrator dispatches to the chosen provider via HTTP. All providers must
support vision (multi-modal image input) — the JEE question and solution are
sent as images. Non-vision providers will fail with a clear API error.

Currently supported (mirrors the rest of the app's aiAdapters):

| provider       | endpoint                                            |
|----------------|-----------------------------------------------------|
| anthropic      | https://api.anthropic.com/v1/messages               |
| gemini         | https://generativelanguage.googleapis.com/v1beta    |
| openai         | https://api.openai.com/v1/chat/completions          |
| groq           | https://api.groq.com/openai/v1/chat/completions     |
| grok           | https://api.x.ai/v1/chat/completions                |
| openrouter     | https://openrouter.ai/api/v1/chat/completions       |
| nvidia         | https://integrate.api.nvidia.com/v1/chat/completions|
| fireworks      | https://api.fireworks.ai/inference/v1/chat/...      |
| custom_openai  | <user-supplied base URL>/chat/completions           |
| local          | <user-supplied base URL>/chat/completions           |
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


# Default model used when caller doesn't pass one — kept for backward compat
# with older call sites (e.g. ad-hoc CLI use).
MODEL = "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_BASE = r"""You are an experienced JEE/NEET physics, chemistry, and \
mathematics tutor recording a video solution. The viewer should believe a \
real human teacher recorded this — NEVER mention AI, NEVER say "Here is \
the solution" or "Let me solve this step by step" or anything that sounds \
mechanical.

You receive: question image, worked-solution image (reference only — \
RECREATE the solution in your own teacher voice, do not transcribe), and \
the correct answer.

Return a JSON array of synchronized narration tokens. Each token:
  "newline": bool — start a new line on the right panel.
  "say":     str — what the narrator speaks. Natural conversational \
             language. NO symbols, NO LaTeX (write "delta m by m" not \
             "Δm/m", write "v squared" not "v²").
  "write":   str — what gets drawn on screen synchronously with the speech. \
             Plain text / Unicode math: ² ³ √ Δ π · ⇒ → ∫ ≤ ≥. \
             Subscripts: single char as x_0, K_M; MULTI-character subscripts \
             MUST be wrapped in braces — write W_{total}, v_{max}, F_{net}, \
             K_{cat} (NOT W_total). Superscripts likewise: v^2, x^{n+1}. \
             The renderer turns these into true sub/superscripts. Fractions inline: \
             dv/dx, Δm/m, 8F/9. NO LaTeX backslashes ever. \
             Empty string ("") = pure narration, nothing appears on screen.

═══════════════════════════════════════════════════════════════════════
REQUIRED VIDEO STRUCTURE (in this exact order — every video must have
all four parts):
═══════════════════════════════════════════════════════════════════════

PART 1 — GREET + READ THE QUESTION ALOUD (2-4 tokens, write="")
The video opens with a WARM GREETING followed by READING the question \
naturally, like a teacher would. The question image is already shown on \
the left panel so the right panel stays empty (write="").

Structure:
  • Token 1: Greeting only. English: "Hello students!" or "Hi everyone!". \
    Hindi: "Hello बच्चों!" or "नमस्ते बच्चों!" (Devanagari — NOT the Latin \
    "bacho"/"Namaste", which the TTS mispronounces). Keep it short and warm.
  • Token 2 (and optionally 3): Read the question naturally — what's given, \
    what's asked, and the options if MCQ.
  • LAST TOKEN OF PART 1: A SHORT BRIDGE that transitions to the solution. \
    Don't jump straight into solving — pause and connect. Examples: \
      "Let's see how to solve this."          (EN)
      "Toh chaliye, iss question ko solve karte hain."   (HI)
      "Now let's think about what concept we'll need."   (EN)
      "Yahan hum kaun sa concept use karenge?"           (HI)
    This bridge prevents the jarring jump from reading to solving.

Example opener (English):
  {"newline": true, "write": "",
   "say": "Hello students!"}
  {"newline": true, "write": "",
   "say": "Today's question gives us a 5 kilogram block on a frictionless \
surface, with a horizontal force of 20 newtons applied to it. We need to \
find the velocity after 3 seconds. Options are 6, 10, 12, and 15 meters \
per second."}
  {"newline": true, "write": "",
   "say": "Let's see how to solve this."}

PART 2 — SET UP THE CONCEPT (1-3 tokens)
Introduce the physics/chemistry/math concept we'll use. Use teacher \
phrases: "We'll apply...", "The key idea here is...", "Notice we can use...". \
The MOST IMPORTANT token here SHOULD write the concept LABEL on screen \
(2-5 words max). Examples of good concept-label `write` values:
  "Newton's 2nd Law"
  "Conservation of Momentum"
  "Energy conservation"
  "Kinematic eqn: v = u + at"
  "Ohm's Law: V = IR"

PART 3 — SOLVE STEP BY STEP (the bulk of the video)
Walk through the derivation as a real teacher would. For each step:
  • Explain the LOGIC in `say` (why this step, what it means, what cancels \
    or substitutes)
  • Write the EQUATION in `write`, BROKEN INTO 3-6 SMALL TOKENS PER \
    EQUATION so writing keeps pace with speech
  • Before a sub-step or substitution, write a short LABEL token first: \
    "Substituting:", "Simplifying:", "From energy balance:", \
    "Applying initial conditions:", "Cross-multiplying:"
  • Use natural transitions in `say`: "Now let's…", "Notice the m's \
    cancel…", "This simplifies to…", "Taking the square root of both \
    sides…", "Solving for x we get…"

Equation splitting example — F = ma + ½at² over ONE line:
  {"newline": true,  "say": "F",                          "write": "F"}
  {"newline": false, "say": "equals m a",                 "write": " = ma"}
  {"newline": false, "say": "plus half a t squared",      "write": " + ½at²"}

After each equation, often a fresh-line label + the next equation on a new \
line. Mix labels and equations naturally — like writing on a blackboard.

PART 4 — ANNOUNCE THE ANSWER (1 token)
For MCQ:    write "Answer: (X)", say "So the correct option is X, …"
For value:  write "Answer: 10 m/s", say "So the velocity comes out to 10 \
            meters per second."

═══════════════════════════════════════════════════════════════════════
WRITE-FIELD POLICY (what appears on the right panel)
═══════════════════════════════════════════════════════════════════════

• The right panel shows EQUATIONS + a few short CONCEPT LABELS. That's it.
• Never write full sentences in `write`. Sentences belong in `say`.
• Concept labels in `write` stay short: 2-5 words. Capitalise the first \
  word. Add a trailing colon for sub-step labels ("Substituting:").
• The viewer LEARNS by listening; they SEE only the math + a few words \
  to anchor each section. This mimics a teacher at the board.

═══════════════════════════════════════════════════════════════════════
VARIABLE PRONUNCIATION — CRITICAL FOR TTS QUALITY
═══════════════════════════════════════════════════════════════════════

TTS engines mispronounce isolated single Latin letters (especially under \
non-English language mode). When the `say` field mentions a single-letter \
variable, write it PHONETICALLY as it should be pronounced — never as the \
raw letter alone:

  Variable   say it as       Variable   say it as
  ────────   ──────────      ────────   ──────────
    F        "ef"              v        "vee"
    a        "ay"              h        "ech"
    m        "em"              g        "jee"
    t        "tee"             p        "pee"
    s        "es"              r        "aar"
    k        "kay"             x        "eks"
    y        "why"             n        "en"
    E        "ee"              I        "eye"
    P        "pee"             T        "tee"
    Q        "kyoo"            R        "aar"
    u        "yoo"             d        "dee"
    b        "bee"             c        "see"
    l        "el"              j        "jay"

Greek letters: use English names — "delta", "alpha", "beta", "gamma", \
"theta", "phi", "omega", "lambda", "pi", "mu", "rho", "sigma".

Examples — WRONG vs RIGHT:
  ❌ {"say": "h ki value 10 hai",    "write": "h = 10"}
  ✅ {"say": "ech ki value 10 hai", "write": "h = 10"}
  ❌ {"say": "F equals m a",         "write": " = ma"}
  ✅ {"say": "ef equals em ay",     "write": " = ma"}
  ❌ {"say": "v squared",            "write": "v²"}
  ✅ {"say": "vee squared",         "write": "v²"}

The `write` field still shows the actual variable symbol — only the `say` \
gets the phonetic spelling. The viewer sees "F = ma" but the audio says \
"ef equals em ay".

═══════════════════════════════════════════════════════════════════════
HUMAN-TEACHER STYLE (critical — this is what makes it not feel AI)
═══════════════════════════════════════════════════════════════════════

• NEVER number steps mechanically ("Step 1", "Step 2"). Say "First we…", \
  "Now…", "Next…", "Then…", "Finally…".
• Vary sentence openings. Don't start consecutive tokens with the same word.
• Use teacher phrases: "Let's see", "Notice that", "Observe", "Here we \
  have", "So we get", "Therefore", "From this", "Plug in", "Cancel out", \
  "Rearrange", "On simplification", "Comparing both sides".
• Sound CONVERSATIONAL, not formal. Like a teacher chatting at a blackboard.
• It's OK to add a small aside: "this is a standard result", "remember this \
  formula", "be careful with signs here" — these humanise the explanation.
• Token count target: 25-50 tokens.
• Spoken duration target: 60-180 seconds.

OUTPUT ONLY the JSON array. No prose. No markdown fences."""


LANGUAGE_CLAUSE_HI = r"""

LANGUAGE: Generate EVERY `say` value in HINDI written in DEVANAGARI SCRIPT \
(हिन्दी), the way actual Hindi-medium classroom teachers in India speak — \
NOT the way translation apps render Hindi.

═══════ SCRIPT — THIS IS RULE #1, IT OVERRIDES EVERYTHING ═══════
Every Hindi word MUST be written in Devanagari (देवनागरी). NEVER write Hindi \
in Latin/roman letters ("romanized Hindi" / Hinglish spelling). The narration \
is fed to a text-to-speech engine that reads Latin letters with ENGLISH \
phonetics — so romanized Hindi comes out mispronounced and garbled. \
Devanagari is what makes it sound like a real Hindi teacher.

  ❌ WRONG — romanized (TTS mispronounces every Hindi word):
     "Iss question mein humein force nikalna hai."
     "Toh chaliye, iss question ko solve karte hain."
     "Yahan se humein milta hai."
     "Dekhiye, yahan par acceleration constant hai."
  ✅ RIGHT — Devanagari Hindi + English technical terms:
     "इस question में हमें force निकालना है।"
     "तो चलिए, इस question को solve करते हैं।"
     "यहाँ से हमें मिलता है।"
     "देखिए, यहाँ पर acceleration constant है।"

The ONLY things that stay in Latin letters are the four categories listed \
below (technical terms, numbers, variables, units). EVERY other word — every \
ordinary Hindi word, every verb, every connector — is Devanagari.

═══════ TECHNICAL TERMS — KEEP THEM IN ENGLISH (Latin letters) ═══════
Real classroom Hindi mixes English for academic vocabulary. Keep every \
technical / scientific / mathematical term in ENGLISH, in Latin letters, \
sitting inside the Devanagari sentence. Do NOT translate such a term into \
pure Hindi, and do NOT transliterate it into Devanagari.

  Keep in English (Latin): force, acceleration, velocity, speed, displacement, \
  momentum, energy, kinetic energy, potential energy, work, power, friction, \
  reflection, refraction, mass, weight, pressure, density, current, voltage, \
  resistance, frequency, wavelength, charge, field, torque, equation, question, \
  answer, option, value, ratio, root, square root, unit, units, graph, angle, \
  radius, area, volume, concept, formula, method, solve, substitute, simplify, \
  cancel, derivative, integration, constant, initial, final, maximum, minimum.

  ❌ "इस प्रश्न में हमें बल निकालना है।"          ← translated to pure Hindi (robotic)
  ❌ "इस क्वेश्चन में हमें फ़ोर्स निकालना है।"      ← transliterated into Devanagari (wrong)
  ✅ "इस question में हमें force निकालना है।"     ← correct
  ✅ "Newton's second law लगाएंगे।"
  ✅ "Velocity equals to distance by time."
  ✅ "यहाँ friction काम कर रहा है, इसलिए acceleration कम हो जाएगा।"
  ✅ "दोनों तरफ़ mass cancel हो जाएगा।"

═══════ GREETING ═══════
PART 1 must START with a warm greeting in its own token (write=""). Write it \
in Devanagari: "Hello बच्चों!" or "नमस्ते बच्चों!". Never the Latin "bacho" — \
the TTS mispronounces it on the very first word.

═══════ NUMBERS — ALWAYS IN ENGLISH ═══════
Pronounce EVERY number in ENGLISH, never in Hindi. Write number words in the \
`say` field in English ("six", "ten", "thirty-seven") or as digits — NEVER as \
Hindi number words, in either script (NOT "das", NOT "दस"). This applies to \
counts, values, options, question numbers, units — everything.
  ✅ "Options हैं six, ten, twelve और fifteen।"
  ✅ "Force equals to twenty newton है।"   (twenty — not 'बीस')
  ❌ "Options हैं छह, दस, बारह…"            ← never Hindi numbers

═══════ THE "=" SIGN — SAY "EQUALS TO" ═══════
When narrating an equals sign, say "equals to" (English) — do NOT say \
"बराबर". This keeps the math clear and consistent.
  ✅ "Velocity equals to distance by time."
  ✅ "यहाँ F equals to m a लगाएंगे।"
  ❌ "यहाँ F बराबर m a लगाएंगे।"

═══════ NATURAL TEACHER TRANSITIONS (Devanagari) ═══════
  "देखिए"                  (Let's see / Look here)
  "Notice कीजिए"            (Notice)
  "अब"                     (Now)
  "फिर"                    (Then / next)
  "तो"                     (So)
  "इसलिए"                  (Therefore)
  "यहाँ से हमें मिलता है"     (From here we get)
  "Substitute करते हैं"      (Substituting)
  "Simplify करने पर"         (On simplifying)
  "दोनों तरफ़"               (Both sides)
  "Cross multiply करके"      (Cross-multiplying)
  "ध्यान दीजिए"              (Pay attention)
  "समझ गए?"                 (Got it?)

═══════ WRITE FIELD ═══════
The `write` field stays exactly as for English — plain text / Unicode math, \
Latin letters only. NEVER put Devanagari in `write`. DO NOT translate \
equations, variables, numbers, or units. Concept labels in `write` stay in \
English: "Newton's 2nd Law", "Substituting:", "Energy balance:".

═══════ VARIABLE PRONUNCIATION (extra critical in Hindi mode) ═══════
The variable-pronunciation rule above is ESPECIALLY important when the TTS \
is running in Hindi mode — single Latin letters often get read as Hindi \
consonants (e.g. "h" pronounced as "ha"). Spell variables phonetically in \
the `say` field, keeping that phonetic spelling itself in LATIN letters \
inside the Devanagari sentence:
  ✅ "ech की value ten है।"
  ✅ "ef equals to em ay लगाएंगे।"
  ✅ "vee squared minus yoo squared निकालते हैं।"
(If a "TTS OVERRIDE" section appears at the very end of this prompt, it wins \
over this one — write the plain letter instead of the phonetic spelling. The \
Devanagari script rule still applies either way.)"""


LANGUAGE_CLAUSE_EN = r"""

LANGUAGE: Generate every `say` value in clear, conversational English \
suitable for an Indian student audience. Use natural teacher phrasing — \
"Let's see what we have here", "Notice that", "So we get", "From this", \
"Plug this back in" — NOT formal textbook language.

GREETING: PART 1 must START with a warm greeting in its own token \
(write=""): "Hello students!" or "Hi everyone!"."""


# Appended only for high-quality neural engines (e.g. ElevenLabs). Those voices
# pronounce single letters and symbols correctly on their own, so the phonetic
# respelling in the base prompt ("eks", "ef", "vee") sounds robotic — this
# clause overrides it and asks for the letters/symbols written normally.
TTS_NATURAL_LETTERS_CLAUSE = r"""

═══════════════════════════════════════════════════════════════════════
TTS OVERRIDE — NATURAL PRONUNCIATION (read this LAST, it WINS)
═══════════════════════════════════════════════════════════════════════
This narration is voiced by a HIGH-QUALITY neural TTS that reads single \
letters and math symbols correctly on its own. The "VARIABLE PRONUNCIATION" \
table earlier DOES NOT APPLY — ignore it completely.

In the `say` field, write variables and letters the NORMAL way — NEVER \
phonetically respelled:
  • Single letters: "x" (NOT "eks"), "F" (NOT "ef"), "h" (NOT "ech"), \
    "v" (NOT "vee"), "t" (NOT "tee"), "m" (NOT "em"), "a" (NOT "ay").
  • Powers: "x squared", "v squared", "r cubed" (the WORD square/cube is \
    fine; just don't respell the letter — say "x squared", not "eks squared").
  • Greek letters: keep their English names — "delta", "pi", "theta", "omega".
  • Equals: still say "equals" / "equals to".
Phonetic respelling like "eks", "ef", "vee", "em ay" sounds robotic on this \
engine. Just write the actual letter or word.

SCOPE: this override applies ONLY to how single letters and math symbols are \
spelled. It does NOT change the LANGUAGE or SCRIPT rules stated above — those \
still apply in full."""


# Extra reinforcement appended (Hindi + neural engine only) so the "it WINS"
# framing of the override above can never be read as permission to drop the
# Devanagari script requirement.
TTS_NATURAL_LETTERS_HI_NOTE = r"""
In particular, every Hindi word still MUST be written in DEVANAGARI \
(देवनागरी) — e.g. "इस question में हमें force निकालना है।" — with technical \
terms, numbers, variables and units in English/Latin. Romanized Hindi is \
never acceptable."""


_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English", "hi": "Hindi", "es": "Spanish", "fr": "French",
    "de": "German", "it": "Italian", "pt": "Portuguese", "ru": "Russian",
    "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ar": "Arabic",
    "he": "Hebrew", "tr": "Turkish", "pl": "Polish", "nl": "Dutch",
    "sv": "Swedish", "no": "Norwegian", "da": "Danish", "fi": "Finnish",
    "el": "Greek", "ms": "Malay", "sw": "Swahili",
}


# TTS engines that pronounce isolated letters/symbols well enough that the
# phonetic respelling ("eks", "ef", "vee") should be turned OFF. ElevenLabs's
# neural voices are the prime case.
_NATURAL_PRONUNCIATION_ENGINES = frozenset({"elevenlabs"})


def _build_system_prompt(language: str, tts_engine: str = "edge") -> str:
    """Append the appropriate language clause to the base system prompt.

    `tts_engine` selects pronunciation handling: high-quality neural engines
    (ElevenLabs) get a trailing override that disables the phonetic
    single-letter respelling so "x" is spoken as "x", not "eks".
    """
    code = (language or "en").lower()[:2]
    if code == "hi":
        prompt = SYSTEM_PROMPT_BASE + LANGUAGE_CLAUSE_HI
    elif code == "en" or code not in _LANGUAGE_NAMES:
        prompt = SYSTEM_PROMPT_BASE + LANGUAGE_CLAUSE_EN
    else:
        # Other supported languages — generic clause asking for natural teacher
        # narration in that language, equations / labels still in plain text.
        name = _LANGUAGE_NAMES[code]
        clause = (
            f"\n\nLANGUAGE: Generate every `say` value in {name}, in the natural "
            f"conversational style a {name}-speaking teacher would use at a "
            f"blackboard. The PART 1 question-reading must restate the full "
            f"question fluently in {name}. The `write` field stays as plain text "
            f"and Unicode math — DO NOT translate equations, variables, numbers, "
            f"or units. Concept labels in `write` may stay in English."
        )
        prompt = SYSTEM_PROMPT_BASE + clause

    # Disable phonetic letter respelling on engines that don't need it. The
    # override goes LAST so it takes precedence over the base prompt's table.
    if (tts_engine or "").lower() in _NATURAL_PRONUNCIATION_ENGINES:
        prompt += TTS_NATURAL_LETTERS_CLAUSE
        if code == "hi":
            prompt += TTS_NATURAL_LETTERS_HI_NOTE
    return prompt


# ---------------------------------------------------------------------------
# Provider config
# ---------------------------------------------------------------------------

OPENAI_COMPATIBLE_BASES: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "grok": "https://api.x.ai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
}

OPENAI_EXTRA_HEADERS: dict[str, dict[str, str]] = {
    "openrouter": {
        "HTTP-Referer": "https://question-bank.app",
        "X-Title": "QBG AI Tools",
    },
}


@dataclass(frozen=True)
class NarratorConfig:
    """Provider/model selection for the LLM call.

    `provider` and `model_id` follow the same keys the rest of the app uses
    (see src/lib/userApiKeys.ts). `api_key` is the secret for that provider.

    `base_url` is required for "custom_openai" / "local" and ignored
    otherwise. For OpenAI-compatible providers (including custom_openai and
    local), the chat completions endpoint is `{base_url}/chat/completions`.
    """
    provider: str = "anthropic"
    model_id: str = MODEL
    api_key: str = ""
    base_url: str = ""


# ---------------------------------------------------------------------------
# Image helper
# ---------------------------------------------------------------------------

def _b64_image(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    ext = path.suffix.lower().lstrip(".")
    mt = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, "image/png")
    return mt, base64.standard_b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

def _http_post_json(url: str, headers: dict[str, str], body: dict, *,
                    timeout: int = 180) -> dict:
    """POST JSON, return parsed JSON. Raises RuntimeError on non-2xx."""
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=raw, method="POST",
        headers={**headers, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            txt = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"{url} -> HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"{url} -> network error: {e.reason}") from None
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        raise RuntimeError(f"{url} -> non-JSON response: {txt[:300]}")


# ---------------------------------------------------------------------------
# Per-provider call
# ---------------------------------------------------------------------------

def _call_anthropic(cfg: NarratorConfig, system_prompt: str, user_text: str,
                    images: list[tuple[str, str]]) -> str:
    body = {
        "model": cfg.model_id or MODEL,
        "max_tokens": 8192,
        "system": [{
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"},
        }],
        "messages": [{
            "role": "user",
            "content": [
                *(
                    {"type": "image",
                     "source": {"type": "base64", "media_type": mt, "data": b64}}
                    for mt, b64 in images
                ),
                {"type": "text", "text": user_text},
            ],
        }],
    }
    data = _http_post_json(
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"},
        body,
    )
    blocks = data.get("content") or []
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


def _call_gemini(cfg: NarratorConfig, system_prompt: str, user_text: str,
                 images: list[tuple[str, str]]) -> str:
    parts: list[dict] = [{"text": user_text}]
    for mt, b64 in images:
        parts.append({"inline_data": {"mime_type": mt, "data": b64}})
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.2,
            # Hindi narration with Devanagari uses ~1.5x more tokens than
            # the equivalent English, so bump generously to avoid mid-string
            # truncation that the JSON parser can't recover from.
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{cfg.model_id or 'gemini-2.0-flash'}:generateContent?key={cfg.api_key}"
    )
    data = _http_post_json(url, {}, body)
    candidates = data.get("candidates") or []
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts).strip()


def _uses_max_completion_tokens(model_id: str) -> bool:
    """OpenAI's newer reasoning + GPT-5 models REJECT the legacy `max_tokens`
    parameter and require `max_completion_tokens` instead. Detect by name
    prefix — covers o1/o3/o4 reasoning models and gpt-5.* releases.
    """
    m = (model_id or "").lower()
    # Reasoning models
    if m.startswith("o1") or m.startswith("o3") or m.startswith("o4"):
        return True
    # GPT-5.x family (gpt-5, gpt-5.2, gpt-5.3, gpt-5-mini, …) — note we
    # carefully do NOT match "gpt-5-turbo-instruct" style legacy names if
    # they ever appear, but at the time of writing all gpt-5.* use the new
    # parameter.
    if m.startswith("gpt-5"):
        return True
    return False


def _call_openai_compatible(cfg: NarratorConfig, system_prompt: str,
                            user_text: str,
                            images: list[tuple[str, str]]) -> str:
    """Works for openai, groq, grok, openrouter, nvidia, fireworks,
    custom_openai, and local. All accept the chat-completions schema with
    image_url data URIs."""
    base = (
        cfg.base_url.rstrip("/")
        if cfg.provider in ("custom_openai", "local", "g4f")
        else OPENAI_COMPATIBLE_BASES.get(cfg.provider, "")
    )
    if not base:
        raise RuntimeError(f"No base URL configured for provider '{cfg.provider}'.")
    url = f"{base}/chat/completions"

    content: list[dict] = [{"type": "text", "text": user_text}]
    for mt, b64 in images:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mt};base64,{b64}"},
        })
    body: dict = {
        "model": cfg.model_id,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
    }
    # `temperature` — reasoning + GPT-5 models on OpenAI reject anything
    # other than the default (1). Skip it for those; everyone else gets a
    # low temperature for more deterministic JSON.
    if not (cfg.provider == "openai" and _uses_max_completion_tokens(cfg.model_id)):
        body["temperature"] = 0.2
    # Token-cap parameter name depends on the model. For OpenAI itself we
    # detect by model id; for OpenAI-compatible third parties we default to
    # the legacy `max_tokens` which is broadly accepted.
    if cfg.provider == "openai" and _uses_max_completion_tokens(cfg.model_id):
        body["max_completion_tokens"] = 8192
    else:
        body["max_tokens"] = 8192

    headers: dict[str, str] = {}
    if cfg.provider not in ("local", "g4f"):
        # local (Ollama) may not need an Authorization header
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
    headers.update(OPENAI_EXTRA_HEADERS.get(cfg.provider, {}))

    # Retry policy: if the API rejects a specific parameter (max_tokens /
    # max_completion_tokens / temperature), strip or swap it and resend.
    # Covers third-party "compatible" endpoints (OpenRouter routing to
    # o-models, custom proxies) that we can't predict from the model id.
    for _attempt in range(3):
        try:
            data = _http_post_json(url, headers, body)
            break
        except RuntimeError as err:
            msg = str(err).lower()
            mutated = False
            if "max_tokens" in msg and "max_completion_tokens" not in body:
                body.pop("max_tokens", None)
                body["max_completion_tokens"] = 8192
                mutated = True
            elif "max_completion_tokens" in msg and "max_tokens" not in body:
                body.pop("max_completion_tokens", None)
                body["max_tokens"] = 8192
                mutated = True
            elif "temperature" in msg and "temperature" in body:
                body.pop("temperature", None)
                mutated = True
            elif "response_format" in msg and "response_format" in body:
                body.pop("response_format", None)
                mutated = True
            if not mutated:
                raise
    else:
        raise RuntimeError(f"{url}: API kept rejecting parameters after 3 retries.")

    choices = data.get("choices") or []
    if not choices:
        return ""
    msg_obj = choices[0].get("message", {}) or {}
    return (msg_obj.get("content") or "").strip()


def _call_llm(cfg: NarratorConfig, system_prompt: str, user_text: str,
              images: list[tuple[str, str]]) -> str:
    """Dispatch to provider-specific impl. Returns the raw text response."""
    p = cfg.provider
    if p == "anthropic":
        return _call_anthropic(cfg, system_prompt, user_text, images)
    if p == "gemini":
        return _call_gemini(cfg, system_prompt, user_text, images)
    if p in OPENAI_COMPATIBLE_BASES or p in ("custom_openai", "local", "g4f"):
        return _call_openai_compatible(cfg, system_prompt, user_text, images)
    raise RuntimeError(f"Unknown provider: {p!r}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _parse_tokens(raw: str) -> list[dict]:
    """Extract the JSON array of tokens from the model response. Some models
    wrap the array in an object ({"tokens": [...]} when forced to
    json_object mode) — handle that too."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("Narrator returned empty response.")

    # Direct JSON array.
    m = re.search(r"\[\s*\{.*\}\s*\]", raw, re.S)
    payload = m.group(0) if m else raw
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        raise ValueError(f"Narrator returned unparseable JSON: {raw[:200]}")

    # If the model wrapped the array (typical for response_format=json_object),
    # find the first list value in the object.
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list):
                data = v
                break

    if not isinstance(data, list) or not data:
        raise ValueError(f"Narrator returned no tokens: {raw[:200]}")

    tokens: list[dict] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        say = (item.get("say") or "").strip()
        write = item.get("write") or ""
        if not isinstance(write, str):
            continue
        if not say:
            continue
        write = write.replace("\\\\", "").replace("\\,", " ").replace("\\;", " ")
        newline = bool(item.get("newline")) or (i == 0)
        tokens.append({"newline": newline, "say": say, "write": write})

    if not tokens:
        raise ValueError(f"Narrator returned no usable tokens: {raw[:200]}")
    return tokens


# Devanagari occupies U+0900–U+097F.
_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_LATIN_RE = re.compile(r"[A-Za-z]")

# A correct Hindi script is Devanagari prose carrying English technical terms,
# which lands around 40-60% Devanagari letters. Fully romanized output sits at
# 0%. 15% separates the two cleanly without flagging a legitimately
# English-heavy (equation-dense) script as broken.
_MIN_DEVANAGARI_RATIO = 0.15

_DEVANAGARI_RETRY_NOTE = (
    "CORRECTION — your previous response wrote the Hindi in Latin/roman "
    'letters (e.g. "Iss question mein humein force nikalna hai"). That is '
    "WRONG: the text-to-speech engine reads Latin letters with English "
    "phonetics, so the narration comes out mispronounced. Regenerate the same "
    "narration with every Hindi word in DEVANAGARI script (e.g. "
    '"इस question में हमें force निकालना है।"). Keep technical terms (force, '
    "acceleration, velocity, …), numbers, variables and units in English/Latin, "
    "and keep every `write` field exactly as it was."
)


def _is_devanagari_hindi(tokens: list[dict]) -> bool:
    """True when the spoken text is genuinely written in Devanagari.

    Guards against the model replying in romanized Hindi ("Iss question mein
    humein force nikalna hai") — TTS engines read those Latin letters with
    English phonetics, which is the exact cause of garbled Hindi narration.
    """
    speech = " ".join(t.get("say", "") for t in tokens)
    deva = len(_DEVANAGARI_RE.findall(speech))
    latin = len(_LATIN_RE.findall(speech))
    if deva + latin == 0:
        return True  # nothing to judge — don't trigger a pointless retry
    return deva / (deva + latin) >= _MIN_DEVANAGARI_RATIO


def narrate(question_img: Path,
            solution_img: Path,
            qnum: int,
            answer: str | None,
            *,
            language: str = "en",
            cfg: NarratorConfig | None = None,
            tts_engine: str = "edge") -> list[dict]:
    """Return list of token dicts {newline, say, write}. Raises on API
    failure or unparseable response.

    `cfg` carries provider/model selection. If omitted, falls back to
    Anthropic with ANTHROPIC_API_KEY env var (legacy behaviour).

    `tts_engine` is the voice backend the tokens will be spoken with. Neural
    engines (ElevenLabs) get natural letter pronunciation — no "eks"/"ef"
    respelling; weaker engines (edge) keep the phonetic spelling.
    """
    if cfg is None:
        cfg = NarratorConfig(
            provider="anthropic",
            model_id=MODEL,
            api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        )

    q_mt, q_b64 = _b64_image(question_img)
    s_mt, s_b64 = _b64_image(solution_img)

    answer_clause = (
        f"The correct answer is ({answer})." if answer else
        "The correct answer was not provided."
    )
    system_prompt = _build_system_prompt(language, tts_engine)
    user_text = (
        f"Question number {qnum}. {answer_clause}\n\n"
        "Image 1 is the question. Image 2 is the worked solution. "
        "Return the JSON tokens array now."
    )

    images = [(q_mt, q_b64), (s_mt, s_b64)]
    tokens = _parse_tokens(_call_llm(cfg, system_prompt, user_text, images))

    # Hindi MUST come back in Devanagari — romanized Hindi is read with English
    # phonetics by every TTS engine and comes out garbled. Models occasionally
    # ignore the script rule, so verify and retry once rather than shipping a
    # mispronounced video (re-rendering costs a full TTS + video build).
    if (language or "").lower().startswith("hi") and not _is_devanagari_hindi(tokens):
        print("[narrator] Hindi narration came back romanized — retrying for Devanagari.",
              file=sys.stderr, flush=True)
        try:
            retry = _parse_tokens(_call_llm(
                cfg, system_prompt,
                f"{user_text}\n\n{_DEVANAGARI_RETRY_NOTE}", images))
        except (RuntimeError, ValueError) as exc:
            print(f"[narrator] Devanagari retry failed ({exc}); keeping first response.",
                  file=sys.stderr, flush=True)
        else:
            if not _is_devanagari_hindi(retry):
                print("[narrator] Retry still romanized; proceeding — Hindi "
                      "pronunciation may be off.", file=sys.stderr, flush=True)
            return retry
    return tokens


def fallback_steps(qnum: int, answer: str | None, *, language: str = "en") -> list[dict]:
    """Generic 2-step script when no API key / API failure."""
    is_hindi = (language or "").lower().startswith("hi")
    if is_hindi:
        # Devanagari for the Hindi words, English/Latin for technical terms and
        # numbers — same contract as LANGUAGE_CLAUSE_HI, since romanized Hindi
        # gets read with English phonetics by the TTS and comes out garbled.
        intro = {"newline": True,
                 "say": f"Question number {qnum} का solution देखते हैं।",
                 "write": ""}
        if answer:
            outro = {"newline": True,
                     "say": f"इसलिए सही answer option {answer} है।",
                     "write": f"Answer: ({answer})"}
        else:
            outro = {"newline": True,
                     "say": "कृपया screen पर दिया गया solution देखिए।",
                     "write": ""}
        return [intro, outro]
    intro = {"newline": True,
             "say": f"Here is the solution to question {qnum}.",
             "write": ""}
    if answer:
        outro = {"newline": True,
                 "say": f"Therefore the answer is option {answer}.",
                 "write": f"Answer: ({answer})"}
    else:
        outro = {"newline": True,
                 "say": "Please refer to the worked solution.",
                 "write": ""}
    return [intro, outro]
