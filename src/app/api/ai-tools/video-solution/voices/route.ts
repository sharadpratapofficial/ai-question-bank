/**
 * GET /api/ai-tools/video-solution/voices
 *
 * Proxies ElevenLabs's /v1/voices for the *current user's* saved API key
 * (Manage API Keys → ElevenLabs (TTS)). The key never leaves the server.
 *
 * Response shape:
 *   {
 *     success: true,
 *     voices: Array<{ id: string; name: string; language: string;
 *                     isHindi: boolean; previewUrl: string | null;
 *                     description: string | null; category: string | null }>
 *   }
 *
 * On missing/invalid key returns 400 with success: false. The UI uses
 * that to prompt the user to save a key.
 */
import { NextResponse } from "next/server";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ElevenLabsVoice {
    voice_id: string;
    name: string;
    category?: string;
    description?: string | null;
    preview_url?: string | null;
    labels?: Record<string, string> | null;
    fine_tuning?: {
        language?: string | null;
        verified_languages?: Array<{ language?: string }> | null;
    } | null;
    high_quality_base_model_ids?: string[] | null;
    verified_languages?: Array<{ language?: string }> | null;
}

interface ElevenLabsVoicesResponse {
    voices?: ElevenLabsVoice[];
}

function extractLanguage(v: ElevenLabsVoice): string {
    // ElevenLabs surfaces language inconsistently: sometimes in labels.language,
    // sometimes labels.accent, sometimes fine_tuning.language. Normalize.
    const labels = v.labels || {};
    const raw =
        labels.language ||
        labels.accent ||
        v.fine_tuning?.language ||
        "";
    return String(raw).trim();
}

function isHindi(v: ElevenLabsVoice): boolean {
    const labels = v.labels || {};
    // 1) Explicit language / accent labels.
    const lang = extractLanguage(v).toLowerCase();
    if (
        lang === "hi" ||
        lang === "hin" ||
        lang.includes("hindi") ||
        lang.includes("indian")
    ) {
        return true;
    }
    // 2) `verified_languages` field (newer ElevenLabs voices) — both top-level
    //    and nested under `fine_tuning`.
    const verifiedLists = [v.verified_languages, v.fine_tuning?.verified_languages];
    for (const list of verifiedLists) {
        if (Array.isArray(list) && list.some((entry) => {
            const lg = (entry?.language || "").toLowerCase();
            return lg === "hi" || lg === "hin" || lg.includes("hindi");
        })) {
            return true;
        }
    }
    // 3) Hindi/Indian keywords anywhere in name, description, or labels.
    const haystack = [
        v.name,
        v.description || "",
        ...Object.values(labels),
    ].join(" ").toLowerCase();
    if (/\b(hindi|hindustani|hi[-_]?in|indian)\b/.test(haystack)) {
        return true;
    }
    return false;
}

export async function GET() {
    const forbid = await checkPermission("use_video_solution");
    if (forbid) return forbid;

    let apiKey = "";
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            apiKey = sanitizeUserApiKeys(user.user_metadata?.api_keys).elevenlabs || "";
        }
    } catch {
        // Fall through — treat as "no key".
    }

    if (!apiKey) {
        return NextResponse.json(
            {
                success: false,
                error:
                    "No ElevenLabs API key saved. Open Manage API Keys → ElevenLabs (TTS) and paste your key.",
            },
            { status: 400 }
        );
    }

    let resp: Response;
    try {
        resp = await fetch("https://api.elevenlabs.io/v1/voices", {
            method: "GET",
            headers: { "xi-api-key": apiKey, Accept: "application/json" },
            cache: "no-store",
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { success: false, error: `Network error reaching ElevenLabs: ${msg}` },
            { status: 502 }
        );
    }

    if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return NextResponse.json(
            {
                success: false,
                error: `ElevenLabs returned ${resp.status}: ${body.slice(0, 250)}`,
            },
            { status: resp.status === 401 ? 401 : 502 }
        );
    }

    const data = (await resp.json().catch(() => ({}))) as ElevenLabsVoicesResponse;
    const voices = (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        language: extractLanguage(v),
        isHindi: isHindi(v),
        previewUrl: v.preview_url ?? null,
        description: v.description ?? null,
        category: v.category ?? null,
    }));

    // Sort: Hindi first (alpha), then everything else alpha.
    voices.sort((a, b) => {
        if (a.isHindi !== b.isHindi) return a.isHindi ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ success: true, voices });
}
