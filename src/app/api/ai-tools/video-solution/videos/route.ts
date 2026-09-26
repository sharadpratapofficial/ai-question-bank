/**
 * POST /api/ai-tools/video-solution/videos
 *
 * Starts an async video-generation job. Returns { jobId } immediately; the
 * client polls GET /api/ai-tools/video-solution/videos/[id]/status for
 * progress, then downloads via GET .../download.
 *
 * Two input modes:
 *   multipart/form-data
 *     - question_pdf:  PDF
 *     - solutions_pdf: PDF
 *   application/json
 *     - qbg_ids: string  comma/newline-separated QBG unique_ids — fetches
 *       questions directly from QBG instead of two uploaded PDFs (see
 *       python/video_solution/qbg_source.py). QBG credentials are read from
 *       the caller's saved "qbg" vault key, same as qbg-modification.
 *
 * Both modes share these knobs (form fields or JSON body keys, same names):
 *   - tts_engine (optional): "edge" (default, free) or "elevenlabs"
 *   - voice (optional): voice name (edge-tts) or voice id (ElevenLabs).
 *     Defaults to en-IN-PrabhatNeural when edge.
 *   - eleven_model (optional): ElevenLabs model id, default eleven_multilingual_v2
 *   - max_questions (optional): "0" or empty = render every question
 *   - anthropic_api_key (optional): one-off override (else server falls back
 *     to the user's stored Anthropic key in user_metadata.api_keys.anthropic,
 *     then to ANTHROPIC_API_KEY env var, then to the no-key generic narration).
 *
 * The ElevenLabs API key is *always* read from the user's saved key
 * (user_metadata.api_keys.elevenlabs) — never accepted from the client body,
 * to avoid round-tripping it through the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAnyPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import {
    getProviderApiCredential,
    providerNeedsApiKey,
    getProviderBaseUrl,
    sanitizeUserApiKeys,
    parseQbgProviderConfig,
    type SupportedApiProvider,
} from "@/lib/userApiKeys";
import { startVideoJob, type QbgCreds } from "@/lib/api/videoSolution";

const ALLOWED_AI_PROVIDERS: ReadonlySet<SupportedApiProvider> = new Set([
    "anthropic",
    "gemini",
    "openai",
    "groq",
    "grok",
    "openrouter",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
]);

export const maxDuration = 60; // route returns immediately; render is in background
export const runtime = "nodejs";

interface SharedKnobs {
    ttsEngine: "edge" | "elevenlabs" | "chatterbox";
    voice: string;
    chatterboxUrl: string;
    chatterboxModel: string;
    elevenModel: string;
    language: string;
    maxQuestions: number;
    aiProvider: SupportedApiProvider;
    aiModelId: string;
}

function parseSharedKnobs(get: (key: string) => string | null): SharedKnobs {
    const rawEngine = (get("tts_engine") || "edge").trim().toLowerCase();
    const ttsEngine: SharedKnobs["ttsEngine"] =
        (["edge", "elevenlabs", "chatterbox"] as const).includes(
            rawEngine as "edge" | "elevenlabs" | "chatterbox"
        )
            ? (rawEngine as "edge" | "elevenlabs" | "chatterbox")
            : "edge";
    const defaultVoice = ttsEngine === "edge" ? "hi-IN-SwaraNeural" : "";
    const voice = (get("voice") || defaultVoice).trim();
    const chatterboxUrl = (get("chatterbox_url") || "http://localhost:8004").trim();
    const chatterboxModel = (get("chatterbox_model") || "").trim();
    const elevenModel = (get("eleven_model") || "eleven_multilingual_v2").trim();
    const rawLanguage = (get("language") || "").trim().toLowerCase();
    const language = /^[a-z]{2}$/.test(rawLanguage) ? rawLanguage : "en";
    const rawMax = (get("max_questions") || "").trim();
    const maxQuestions = rawMax ? Math.max(0, Number(rawMax) || 0) : 0;
    const rawProvider = (get("ai_provider") || "anthropic").trim();
    const aiProvider: SupportedApiProvider = (
        ALLOWED_AI_PROVIDERS.has(rawProvider as SupportedApiProvider)
            ? rawProvider
            : "anthropic"
    ) as SupportedApiProvider;
    const aiModelId = (get("ai_model_id") || "").trim();
    return { ttsEngine, voice, chatterboxUrl, chatterboxModel, elevenModel, language, maxQuestions, aiProvider, aiModelId };
}

export async function POST(request: NextRequest) {
    const forbid = await checkAnyPermission(["use_video_solution", "use_qbg"]);
    if (forbid) return forbid;

    const isJson = (request.headers.get("content-type") || "").includes("application/json");

    let qBuf: Buffer | undefined;
    let qName: string | undefined;
    let sBuf: Buffer | undefined;
    let sName: string | undefined;
    let qbgIds: string[] | undefined;
    let knobs: SharedKnobs;

    if (isJson) {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) {
            return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
        }
        qbgIds = String(body.qbg_ids || "")
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (qbgIds.length === 0) {
            return NextResponse.json(
                { success: false, error: "qbg_ids is required (at least one QBG unique_id)." },
                { status: 400 }
            );
        }
        knobs = parseSharedKnobs((key) => (body[key] != null ? String(body[key]) : null));
    } else {
        const form = await request.formData().catch(() => null);
        if (!form) {
            return NextResponse.json(
                { success: false, error: "Expected multipart/form-data or application/json." },
                { status: 400 }
            );
        }
        const q = form.get("question_pdf");
        const s = form.get("solutions_pdf");
        if (!(q instanceof File) || !(s instanceof File)) {
            return NextResponse.json(
                { success: false, error: "Both question_pdf and solutions_pdf are required." },
                { status: 400 }
            );
        }
        for (const f of [q, s]) {
            if (!f.name.toLowerCase().endsWith(".pdf")) {
                return NextResponse.json(
                    { success: false, error: "Only .pdf files are accepted." },
                    { status: 400 }
                );
            }
            if (f.size > 50 * 1024 * 1024) {
                return NextResponse.json(
                    { success: false, error: `File too large (max 50 MB): ${f.name}` },
                    { status: 413 }
                );
            }
        }
        qBuf = Buffer.from(await q.arrayBuffer());
        qName = q.name;
        sBuf = Buffer.from(await s.arrayBuffer());
        sName = s.name;
        knobs = parseSharedKnobs((key) => form.get(key)?.toString() ?? null);
    }
    const { ttsEngine, voice, chatterboxUrl, chatterboxModel, elevenModel, language, maxQuestions, aiProvider, aiModelId } = knobs;

    // Resolve the chosen provider's key + base URL (and QBG creds, when
    // needed) from the user's saved settings. Never accept keys in the
    // request body — they stay on the server. Falls back to
    // ANTHROPIC_API_KEY env var only when provider is anthropic (legacy
    // single-provider path).
    let aiApiKey = "";
    let aiBaseUrl = "";
    let anthropicApiKey = "";  // legacy fallback path
    let elevenApiKey = "";
    let qbgCreds: QbgCreds | undefined;
    let userId: string | undefined;
    let supabaseAccessToken: string | undefined;
    try {
        const supabase = await createClient();
        const [{ data: { user } }, { data: { session } }] = await Promise.all([
            supabase.auth.getUser(),
            supabase.auth.getSession(),
        ]);
        if (user) {
            const saved = sanitizeUserApiKeys(user.user_metadata?.api_keys);
            const stored = saved[aiProvider] || "";
            aiApiKey = getProviderApiCredential(aiProvider, stored);
            aiBaseUrl = getProviderBaseUrl(aiProvider, stored);
            anthropicApiKey = saved.anthropic || "";
            elevenApiKey = saved.elevenlabs || "";
            qbgCreds = parseQbgProviderConfig(saved.qbg);
            userId = user.id;
        }
        supabaseAccessToken = session?.access_token;
    } catch {
        // fall through to env
    }
    if (aiProvider === "anthropic" && !aiApiKey && process.env.ANTHROPIC_API_KEY) {
        aiApiKey = process.env.ANTHROPIC_API_KEY;
    }
    if (providerNeedsApiKey(aiProvider) && !aiApiKey) {
        return NextResponse.json(
            {
                success: false,
                error: `No API key saved for ${aiProvider}. Open Manage API Keys and paste your key.`,
            },
            { status: 400 }
        );
    }

    if (qbgIds && !(qbgCreds && qbgCreds.token && qbgCreds.user && qbgCreds.userId)) {
        return NextResponse.json(
            {
                success: false,
                error: "QBG token / user / user-id are required. Add them under Manage API Keys → QBG (PenPencil) API.",
            },
            { status: 400 }
        );
    }

    if (ttsEngine === "elevenlabs") {
        if (!elevenApiKey) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "ElevenLabs TTS selected but no ElevenLabs API key is saved. Open Manage API Keys → ElevenLabs (TTS) and paste your key.",
                },
                { status: 400 }
            );
        }
        if (!voice) {
            return NextResponse.json(
                {
                    success: false,
                    error: "ElevenLabs requires a voice. Select one from the dropdown.",
                },
                { status: 400 }
            );
        }
    }
    // Chatterbox runs as a separate HTTP server the user hosts themselves —
    // no API key validation needed at this layer.

    try {
        const { jobId } = await startVideoJob({
            ...(qbgIds
                ? { source: "qbg" as const, qbgIds, qbgCreds }
                : {
                      source: "pdf" as const,
                      questionPdfBuffer: qBuf,
                      questionPdfName: qName,
                      solutionsPdfBuffer: sBuf,
                      solutionsPdfName: sName,
                  }),
            aiProvider,
            aiModelId: aiModelId || undefined,
            aiApiKey: aiApiKey || undefined,
            aiBaseUrl: aiBaseUrl || undefined,
            // legacy fallback — still passed so older Python paths work
            anthropicApiKey: anthropicApiKey || undefined,
            ttsEngine,
            voice,
            chatterboxUrl: ttsEngine === "chatterbox" ? chatterboxUrl : undefined,
            chatterboxModel: ttsEngine === "chatterbox" ? chatterboxModel : undefined,
            elevenModel: ttsEngine === "elevenlabs" ? elevenModel : undefined,
            elevenApiKey: ttsEngine === "elevenlabs" ? elevenApiKey : undefined,
            language,
            maxQuestions: maxQuestions || undefined,
            userId,
            supabaseAccessToken,
        });
        return NextResponse.json({ success: true, jobId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { success: false, error: `Failed to start job: ${msg}` },
            { status: 500 }
        );
    }
}
