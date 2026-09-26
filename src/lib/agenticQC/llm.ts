/**
 * LLM call helpers extracted from the original /api/agentic-qc/run route so
 * both the old (paper-level) and new (per-question) executors can share them.
 *
 * Each provider's request shape is normalised to:
 *   callAI(provider, modelId, apiKey, prompt, files) → raw text response
 *
 * For per-question mode `files` is typically empty (the question text is in
 * the prompt). For paper-level mode `files` is the uploaded PDF(s).
 */
import type { AIModelProvider } from "@/types/extraction";

export interface FileInput {
    fileBase64: string;
    fileName: string;
}

/** A diagram/image to hand to a vision-capable model alongside the prompt. */
export interface ImageInput {
    /** Raw base64 (no data: prefix). */
    base64: string;
    /** e.g. "image/png", "image/jpeg", "image/webp". */
    mimeType: string;
}

/** Per-image hard cap so a stray huge asset can't blow up the request. */
const MAX_IMAGE_BYTES = Number(process.env.QBG_QC_MAX_IMAGE_BYTES || String(6 * 1024 * 1024));

/**
 * Download diagram images referenced by a question so they can be passed
 * inline to a vision model. This is the "tool" that lets the AI actually see
 * the figure: the URL lives in the question HTML, we fetch the bytes here and
 * forward them as image content. Failures (404 / CORS / oversize / non-image)
 * are skipped silently — the model still gets the text, just no picture.
 */
export async function fetchImagesForPrompt(
    urls: string[],
    signal?: AbortSignal
): Promise<ImageInput[]> {
    const out: ImageInput[] = [];
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal });
            if (!res.ok) continue;
            let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) continue;
            // Fall back to sniffing the extension when the server doesn't send a
            // usable image content-type.
            if (!mime.startsWith("image/")) {
                const ext = url.toLowerCase().split("?")[0].split(".").pop();
                mime =
                    ext === "jpg" || ext === "jpeg"
                        ? "image/jpeg"
                        : ext === "webp"
                        ? "image/webp"
                        : ext === "gif"
                        ? "image/gif"
                        : ext === "png"
                        ? "image/png"
                        : "";
                if (!mime) continue;
            }
            out.push({ base64: buf.toString("base64"), mimeType: mime });
        } catch {
            // Skip this image; never let a diagram fetch fail the whole call.
        }
    }
    return out;
}

/** Token usage reported by the provider for a single call. */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

/** Result of an LLM call: the raw text plus the provider-reported token usage. */
export interface AICallResult {
    text: string;
    usage: TokenUsage;
}

const OPENAI_COMPATIBLE_CONFIGS: Record<
    string,
    { baseUrl: string; extraHeaders?: Record<string, string> }
> = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: {
            "HTTP-Referer": "https://question-bank.app",
            "X-Title": "QBG Agentic QC",
        },
    },
    groq: { baseUrl: "https://api.groq.com/openai/v1" },
    grok: { baseUrl: "https://api.x.ai/v1" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
    local: { baseUrl: "http://localhost:11434/v1" },
};

function mimeFor(fileName: string): string {
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "docx")
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "doc") return "application/msword";
    return "application/pdf";
}

/**
 * Per-LLM-call hard timeout. Without this, a stalled provider connection
 * keeps the fetch open indefinitely — which is exactly the "running for
 * hours" failure mode. 3 minutes is generous for big reasoning models on a
 * single question while bounding the worst case: when one chosen model hangs,
 * every question otherwise waited the full timeout for that agent before
 * failing, dragging the whole run out. Override with QBG_LLM_TIMEOUT_MS.
 */
const LLM_CALL_TIMEOUT_MS = Number(process.env.QBG_LLM_TIMEOUT_MS || "180000");

/**
 * Combine the executor's cancellation signal with a per-call timeout so
 * either firing aborts the fetch. AbortSignal.any is available on Node 20+;
 * falls back to manual coordination otherwise.
 */
function withTimeout(userSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS);
    if (!userSignal) return timeoutSignal;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyImpl = (AbortSignal as any).any as
        | ((sigs: AbortSignal[]) => AbortSignal)
        | undefined;
    if (typeof anyImpl === "function") {
        return anyImpl([userSignal, timeoutSignal]);
    }
    // Fallback: forward whichever fires first into a fresh controller.
    const c = new AbortController();
    const onAbort = () => c.abort();
    userSignal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    if (userSignal.aborted || timeoutSignal.aborted) c.abort();
    return c.signal;
}

export async function callAI(
    provider: AIModelProvider,
    modelId: string,
    apiKey: string,
    prompt: string,
    files: FileInput[],
    signal?: AbortSignal,
    images: ImageInput[] = []
): Promise<AICallResult> {
    // ─── Anthropic ──────────────────────────────────────────────────────
    if (provider === "anthropic") {
        const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
        for (const f of files) {
            content.push({
                type: "document",
                source: {
                    type: "base64",
                    media_type: mimeFor(f.fileName),
                    data: f.fileBase64,
                },
            });
        }
        for (const img of images) {
            content.push({
                type: "image",
                source: {
                    type: "base64",
                    media_type: img.mimeType,
                    data: img.base64,
                },
            });
        }
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: modelId,
                max_tokens: 32768,
                system:
                    "You are a JSON-only response generator. Your entire response MUST be a single valid JSON object. Do NOT include any preamble, explanation, markdown fences, or trailing commentary. Begin your response with `{` and end it with `}` — nothing else.",
                messages: [{ role: "user", content }],
            }),
            signal: withTimeout(signal),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${err}`);
        }
        const data = await response.json();
        const blocks = data?.content || [];
        const text = Array.isArray(blocks)
            ? blocks
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text)
                  .join("")
            : "";
        if (!text) throw new Error("Anthropic returned empty response.");
        return {
            text,
            usage: {
                inputTokens: Number(data?.usage?.input_tokens) || 0,
                outputTokens: Number(data?.usage?.output_tokens) || 0,
            },
        };
    }

    // ─── Gemini ─────────────────────────────────────────────────────────
    if (provider === "gemini") {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        parts.push({ text: prompt });
        for (const f of files) {
            parts.push({
                inlineData: { mimeType: mimeFor(f.fileName), data: f.fileBase64 },
            });
        }
        for (const img of images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 65536,
                        responseMimeType: "application/json",
                    },
                }),
                // Bound every call with the per-call timeout (combined with the
                // cancel signal). Without this a stalled connection hangs the
                // worker forever and the whole run never reaches "done".
                signal: withTimeout(signal),
            }
        );
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${err}`);
        }
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini returned empty response.");
        return {
            text,
            usage: {
                inputTokens: Number(data?.usageMetadata?.promptTokenCount) || 0,
                outputTokens:
                    Number(data?.usageMetadata?.candidatesTokenCount) ||
                    // some Gemini responses only report total + prompt
                    (Number(data?.usageMetadata?.totalTokenCount) || 0) -
                        (Number(data?.usageMetadata?.promptTokenCount) || 0) ||
                    0,
            },
        };
    }

    // ─── OpenAI-compatible ─────────────────────────────────────────────
    const config = OPENAI_COMPATIBLE_CONFIGS[provider] ?? OPENAI_COMPATIBLE_CONFIGS.openai;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [{ type: "text", text: prompt }];
    for (const f of files) {
        const mime = mimeFor(f.fileName);
        const isPdf = mime === "application/pdf";
        if (isPdf || mime.includes("officedocument") || mime === "application/msword") {
            contentParts.push({
                type: "file",
                file: {
                    filename: f.fileName || "document.pdf",
                    file_data: `data:${mime};base64,${f.fileBase64}`,
                },
            });
        } else {
            contentParts.push({
                type: "image_url",
                image_url: { url: `data:${mime};base64,${f.fileBase64}` },
            });
        }
    }
    for (const img of images) {
        contentParts.push({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        });
    }
    const isReasoningModel = /^(o[1-4]|gpt-5)/i.test(modelId);
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...config.extraHeaders,
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: contentParts }],
            ...(isReasoningModel ? {} : { temperature: 0.1 }),
            max_completion_tokens: 32768,
            response_format: { type: "json_object" },
        }),
        // Bound every call with the per-call timeout (see Gemini note above).
        signal: withTimeout(signal),
    });
    if (!response.ok) {
        const err = await response.text();
        const hint =
            provider === "openrouter" && /file type is not supported/i.test(err)
                ? " — this OpenRouter model doesn't accept PDF input. Pick a vision/file-capable model."
                : provider === "openai" && /Invalid MIME type|invalid_image_format/i.test(err)
                ? " — this OpenAI model doesn't accept PDFs via chat-completions. Use gpt-4o / gpt-5.x."
                : "";
        throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${err}${hint}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider.toUpperCase()} returned empty response.`);
    return {
        text,
        usage: {
            inputTokens: Number(data?.usage?.prompt_tokens) || 0,
            outputTokens: Number(data?.usage?.completion_tokens) || 0,
        },
    };
}

/**
 * Robust JSON extractor — handles preambles, code fences, and truncated
 * responses (closes open braces/strings as a last resort).
 */
export function parseJSONResponse(rawText: string): Record<string, unknown> {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7).trim();
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3).trim();
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trim();

    try {
        return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
        // fall through
    }

    const start = cleaned.indexOf("{");
    if (start === -1) {
        throw new Error(`Model did not return JSON. First 200 chars: ${cleaned.slice(0, 200)}`);
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\" && inString) {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) {
        const repaired = repairTruncatedJSON(cleaned.slice(start));
        try {
            return JSON.parse(repaired) as Record<string, unknown>;
        } catch (e) {
            throw new Error(
                `Model returned truncated JSON and repair failed: ${e instanceof Error ? e.message : String(e)}. Tail: ...${cleaned.slice(-200)}`
            );
        }
    }
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function repairTruncatedJSON(input: string): string {
    let s = input;
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    let lastSafeBreakIdx = -1;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (ch === "\\") escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "{" || ch === "[") {
            stack.push(ch);
            lastSafeBreakIdx = i + 1;
        } else if (ch === "}" || ch === "]") {
            stack.pop();
            lastSafeBreakIdx = i + 1;
        } else if (ch === "," && stack.length > 0) {
            lastSafeBreakIdx = i + 1;
        }
    }
    if (inString && lastSafeBreakIdx >= 0) {
        s = s.slice(0, lastSafeBreakIdx);
        stack.length = 0;
        let s2In = false;
        let s2Esc = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (s2Esc) {
                s2Esc = false;
                continue;
            }
            if (s2In) {
                if (ch === "\\") s2Esc = true;
                else if (ch === '"') s2In = false;
                continue;
            }
            if (ch === '"') {
                s2In = true;
                continue;
            }
            if (ch === "{" || ch === "[") stack.push(ch);
            else if (ch === "}" || ch === "]") stack.pop();
        }
    }
    s = s.replace(/,\s*$/, "");
    s = s.replace(/,\s*"[^"]*"\s*:\s*$/, "");
    s = s.replace(/{\s*"[^"]*"\s*:\s*$/, "{");
    let out = s;
    while (stack.length > 0) {
        const opener = stack.pop()!;
        out += opener === "{" ? "}" : "]";
    }
    return out;
}
