/**
 * GET /api/ai-tools/video-solution/chatterbox-meta?url=<base>
 *
 * Proxies the Chatterbox-TTS-Server (https://github.com/...) metadata
 * endpoints so the UI can populate its model / voice / language pickers.
 *
 * Calls, in parallel, against {base}:
 *   - GET /api/model-info               → which model is loaded + supported langs
 *   - GET /v1/audio/voices?model=tts-1  → OpenAI-compatible voice list
 *   - GET /get_predefined_voices        → curated predefined voices
 *   - GET /get_reference_files          → user-uploaded reference clips for
 *                                          voice cloning (custom trained voices)
 *
 * Returns:
 *   {
 *     success: true,
 *     modelInfo: {            // null if /api/model-info isn't available
 *       loaded, type, className, sampleRate,
 *       supportsMultilingual, supportedLanguages: {code: name},
 *     } | null,
 *     voices: string[],          // OpenAI + predefined voices, de-duped
 *     referenceFiles: string[],  // reference .wav/.mp3 names for voice cloning
 *   }
 *
 * Errors are reported with status 502 — the user's Chatterbox server isn't
 * reachable / isn't a Chatterbox server.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";

export const runtime = "nodejs";

type UnknownObject = Record<string, unknown>;

interface NormalizedModelInfo {
    loaded: boolean;
    type: string;
    className: string;
    sampleRate: number;
    supportsMultilingual: boolean;
    supportedLanguages: Record<string, string>;
}

/** Try several common shapes and pull out a flat string[] of voice ids. */
function normalizeVoiceList(body: unknown): string[] {
    if (!body) return [];

    // Raw array of strings.
    if (Array.isArray(body)) {
        const out: string[] = [];
        for (const x of body) {
            if (typeof x === "string") {
                out.push(x);
            } else if (x && typeof x === "object") {
                const o = x as UnknownObject;
                // OpenAI-style: {id, name}; Chatterbox /get_predefined_voices
                // returns objects like {display_name: "...", filename: "..."}
                const id =
                    (o.id as string | undefined) ??
                    (o.display_name as string | undefined) ??
                    (o.name as string | undefined) ??
                    (o.filename as string | undefined) ??
                    (o.voice_id as string | undefined) ??
                    "";
                if (id) out.push(String(id));
            }
        }
        return out;
    }

    // OpenAI-style envelope: {object:"list", data:[...]}
    if (typeof body === "object" && body !== null) {
        const b = body as UnknownObject;
        const candidate =
            (b.data as unknown) ??
            (b.voices as unknown) ??
            (b.results as unknown);
        if (Array.isArray(candidate)) {
            return normalizeVoiceList(candidate);
        }
        // Dict shape from Chatterbox /get_predefined_voices in some builds:
        // {"Display Name": "filename.wav", ...}
        if (typeof candidate === "undefined") {
            const dictKeys = Object.keys(b);
            const allStringValues = dictKeys.every(
                (k) => typeof b[k] === "string"
            );
            if (allStringValues && dictKeys.length > 0) {
                return dictKeys;
            }
        }
    }

    return [];
}

/** Normalize the /api/model-info response (which has a stable shape). */
function normalizeModelInfo(body: unknown): NormalizedModelInfo | null {
    if (!body || typeof body !== "object") return null;
    const b = body as UnknownObject;
    const langs = (b.supported_languages as UnknownObject) || {};
    const supportedLanguages: Record<string, string> = {};
    for (const [code, name] of Object.entries(langs)) {
        if (typeof name === "string") supportedLanguages[code] = name;
    }
    return {
        loaded: Boolean(b.loaded),
        type: String(b.type ?? ""),
        className: String(b.class_name ?? ""),
        sampleRate: Number(b.sample_rate ?? 0),
        supportsMultilingual: Boolean(b.supports_multilingual),
        supportedLanguages,
    };
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.json();
}

export async function GET(request: NextRequest) {
    const forbid = await checkPermission("use_video_solution");
    if (forbid) return forbid;

    const rawUrl = request.nextUrl.searchParams.get("url")?.trim() || "";
    if (!rawUrl) {
        return NextResponse.json(
            { success: false, error: "Missing ?url= query param." },
            { status: 400 }
        );
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return NextResponse.json(
            { success: false, error: `Invalid URL: ${rawUrl}` },
            { status: 400 }
        );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return NextResponse.json(
            { success: false, error: `Only http/https URLs are supported, got ${parsed.protocol}` },
            { status: 400 }
        );
    }

    const base = rawUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
        // Fire all four lookups in parallel; tolerate individual failures.
        const [modelInfoRaw, openaiVoicesRaw, predefinedVoicesRaw, referenceFilesRaw] =
            await Promise.all([
                fetchJson(`${base}/api/model-info`, controller.signal).catch(() => null),
                fetchJson(`${base}/v1/audio/voices?model=tts-1`, controller.signal).catch(() => null),
                fetchJson(`${base}/get_predefined_voices`, controller.signal).catch(() => null),
                fetchJson(`${base}/get_reference_files`, controller.signal).catch(() => null),
            ]);

        const modelInfo = normalizeModelInfo(modelInfoRaw);
        const openaiVoices = normalizeVoiceList(openaiVoicesRaw);
        const predefinedVoices = normalizeVoiceList(predefinedVoicesRaw);
        const referenceFiles = normalizeVoiceList(referenceFilesRaw);

        // De-dupe in encounter order: OpenAI-compatible voices first (those
        // are the ones /v1/audio/speech accepts directly), then predefined.
        const seen = new Set<string>();
        const voices: string[] = [];
        for (const v of [...openaiVoices, ...predefinedVoices]) {
            if (!seen.has(v)) {
                seen.add(v);
                voices.push(v);
            }
        }

        if (!modelInfo && voices.length === 0 && referenceFiles.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        `No model info, voices, or reference files returned from ${base}. ` +
                        `Verify the server is running and that /api/model-info, ` +
                        `/v1/audio/voices, /get_predefined_voices, or /get_reference_files ` +
                        `are reachable.`,
                },
                { status: 502 }
            );
        }

        return NextResponse.json({ success: true, modelInfo, voices, referenceFiles });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { success: false, error: `Failed to reach ${base}: ${msg}` },
            { status: 502 }
        );
    } finally {
        clearTimeout(timer);
    }
}
