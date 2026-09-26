"use client";

/**
 * Video Solution mode panel — mirrors the layout of other AI-tool mode
 * sections in /ai-tools (AI QC, AI Solution, AI Modification, …).
 *
 * Concerns are split with the parent page (`src/app/ai-tools/page.tsx`):
 *   - Parent owns the shared AI provider + model picker and the shared file
 *     upload (question PDF in `uploadedFile`, optional solutions PDF in
 *     `solutionFile`).
 *   - This component owns the video-specific knobs:
 *       * TTS engine (Edge / ElevenLabs)
 *       * Voice (Hindi voices grouped on top)
 *       * ElevenLabs model + voice list (loaded from /voices proxy)
 *       * "Slides only" vs "Slides + narrated videos"
 *       * Max-questions cap (so the user can try 1–2 before a 25-Q run)
 *   - It POSTs to /api/ai-tools/video-solution/{slides|videos}, polls the
 *     status endpoint for live progress, and on completion triggers a
 *     reloadReports() so the new ai_reports row (saved server-side) shows
 *     up in the shared Report History without a page refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertCircle,
    Download,
    FileText,
    Loader2,
    Mic2,
    PlayCircle,
    RefreshCw,
    Sparkles,
    Video as VideoIcon,
    XCircle,
} from "lucide-react";
import {
    providerNeedsApiKey,
    type SupportedApiProvider,
    type UserApiKeys,
} from "@/lib/userApiKeys";
import { useAIJobQueue } from "@/context/AIJobQueueContext";

type JobState = "queued" | "running" | "done" | "error";
type TTSEngine = "edge" | "elevenlabs" | "chatterbox";

interface ElevenVoice {
    id: string;
    name: string;
    language: string;
    isHindi: boolean;
    previewUrl: string | null;
    description: string | null;
    category: string | null;
}

interface VoicesResponse {
    success: boolean;
    voices?: ElevenVoice[];
    error?: string;
}

interface VideoJobStatus {
    success: boolean;
    jobId: string;
    state: JobState;
    log: string;
    videoCount: number;
    error?: string;
    questionPdfName?: string;
    solutionsPdfName?: string;
    qbgIds?: string[];
    missingIds?: string[];
    skippedUnsupported?: { qbgId: string; reason: string }[];
    createdAt: string;
}

const ELEVEN_MODELS: { id: string; label: string; note: string }[] = [
    {
        id: "eleven_multilingual_v2",
        label: "Multilingual v2 — best quality for Hindi (recommended)",
        note: "Highest quality across 29 languages including Hindi. Slower + costlier than turbo.",
    },
    {
        id: "eleven_v3",
        label: "v3 (alpha) — most expressive, 70+ languages",
        note: "Newest model. Most natural emotional delivery; still in alpha and pricier.",
    },
    {
        id: "eleven_turbo_v2_5",
        label: "Turbo v2.5 — fast, multilingual incl. Hindi",
        note: "Low latency, ~50% cheaper than multilingual_v2. Hindi supported. Slight quality drop.",
    },
    {
        id: "eleven_flash_v2_5",
        label: "Flash v2.5 — fastest, 32 languages",
        note: "Ultra-low latency (~75ms). Best for real-time; quality lower than multilingual_v2.",
    },
    {
        id: "eleven_multilingual_v1",
        label: "Multilingual v1 (legacy)",
        note: "Older multilingual model. Use only if v2/v3 give odd results for a particular voice.",
    },
];

const CUSTOM_VOICE_SENTINEL = "__custom__";

// Curated Microsoft Edge-TTS voices. Microsoft ships only TWO Hindi voices
// publicly (Swara + Madhur) — the "younger" voices that show up in some
// docs (Aarav/Ananya/Kavya/Kunal/Rehaan) are NOT served by the public
// edge-tts endpoint and respond with NoAudioReceived. We only list ones we
// have verified work with a sample render at startup.
const EDGE_VOICES: { id: string; label: string; group: "Hindi" | "Indian English" | "Other" }[] = [
    { id: "hi-IN-SwaraNeural",   label: "Swara — Hindi, female",            group: "Hindi" },
    { id: "hi-IN-MadhurNeural",  label: "Madhur — Hindi, male",             group: "Hindi" },
    { id: "en-IN-NeerjaNeural",  label: "Neerja — Indian English, female",  group: "Indian English" },
    { id: "en-IN-PrabhatNeural", label: "Prabhat — Indian English, male",   group: "Indian English" },
    { id: "en-US-JennyNeural",   label: "Jenny — US English, female",       group: "Other" },
    { id: "en-US-GuyNeural",     label: "Guy — US English, male",           group: "Other" },
    { id: "en-US-AriaNeural",    label: "Aria — US English, female",        group: "Other" },
];

function isHindiEdgeVoice(voiceId: string): boolean {
    return voiceId.toLowerCase().startsWith("hi-in-");
}

export interface VideoSolutionPanelProps {
    /** Question PDF picked in the shared upload section. Null when sourcing
     *  from QBG ids instead. */
    questionPdf: File | null;
    /** Solutions PDF picked in the shared upload section (required for
     *  videos in upload mode). Null when sourcing from QBG ids instead. */
    solutionsPdf: File | null;
    /** QBG unique_ids to fetch questions/solutions from directly, instead of
     *  an uploaded PDF pair. When set (non-empty), takes precedence over
     *  questionPdf/solutionsPdf. */
    qbgIds?: string[];
    /** AI provider chosen in the shared picker. */
    aiProvider: SupportedApiProvider;
    /** Model id chosen in the shared picker. */
    aiModelId: string;
    /** All saved user API keys (used only to surface a friendly key-missing
     *  warning; the actual key is looked up server-side). */
    userApiKeys: UserApiKeys;
    /** Called after a video job successfully finishes so the parent can
     *  refresh the Report History list. */
    onReportSaved?: () => void;
}

export default function VideoSolutionPanel({
    questionPdf,
    solutionsPdf,
    qbgIds,
    aiProvider,
    aiModelId,
    userApiKeys,
    onReportSaved,
}: VideoSolutionPanelProps) {
    const [maxQuestions, setMaxQuestions] = useState("2");
    const [busy, setBusy] = useState<"slides" | "videos" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [slidesNotice, setSlidesNotice] = useState<string | null>(null);

    // TTS configuration
    const [ttsEngine, setTtsEngine] = useState<TTSEngine>("edge");
    const [edgeVoice, setEdgeVoice] = useState("hi-IN-SwaraNeural");
    // Chatterbox is an external OpenAI-compatible HTTP server the user runs
    // themselves (default http://localhost:8004). We fetch /api/model-info
    // (model + supported languages) and /v1/audio/voices through a Next.js
    // proxy to populate the dropdowns.
    interface ChatterboxModelInfo {
        loaded: boolean;
        type: string;
        className: string;
        sampleRate: number;
        supportsMultilingual: boolean;
        supportedLanguages: Record<string, string>;
    }
    const [chatterboxUrl, setChatterboxUrl] = useState("http://localhost:8004");
    const [chatterboxVoices, setChatterboxVoices] = useState<string[]>([]);
    // Reference / cloned voices the user trained inside Chatterbox-TTS-Server
    // (returned by /get_reference_files). These get their own optgroup so the
    // user can clearly see + pick their custom-trained voice.
    const [chatterboxReferenceFiles, setChatterboxReferenceFiles] = useState<string[]>([]);
    const [chatterboxVoice, setChatterboxVoice] = useState("");
    const [chatterboxModelInfo, setChatterboxModelInfo] = useState<ChatterboxModelInfo | null>(null);
    const [chatterboxLanguage, setChatterboxLanguage] = useState("en");
    const [chatterboxLoading, setChatterboxLoading] = useState(false);
    const [chatterboxError, setChatterboxError] = useState<string | null>(null);
    const [elevenVoiceId, setElevenVoiceId] = useState("");
    /** When the user picks "Custom voice ID…" from the dropdown we toggle
     *  this to true and show a text input. Lets them paste any voice_id
     *  from elevenlabs.io (e.g. a Hindi-tuned voice not in their library). */
    const [elevenUseCustomVoice, setElevenUseCustomVoice] = useState(false);
    const [elevenCustomVoiceId, setElevenCustomVoiceId] = useState("");
    const [elevenModel, setElevenModel] = useState(ELEVEN_MODELS[0].id);
    const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([]);
    const [elevenVoicesLoading, setElevenVoicesLoading] = useState(false);
    const [elevenVoicesError, setElevenVoicesError] = useState<string | null>(null);

    const [jobId, setJobId] = useState<string | null>(null);
    const [jobStatus, setJobStatus] = useState<VideoJobStatus | null>(null);
    // "Connected" / "Reconnecting…" indicator for the live log panel.
    // We don't surface transient poll failures as full-page errors — the
    // Python render keeps going even if a poll request blips.
    const [pollState, setPollState] = useState<"idle" | "live" | "reconnecting">("idle");
    const pollRef = useRef<NodeJS.Timeout | null>(null);
    const pollFailuresRef = useRef(0);
    const reportSavedFiredRef = useRef(false);
    const { trackVideoJob, forgetVideoJob, activeVideoJobs } = useAIJobQueue();

    const loadElevenVoices = useCallback(async () => {
        setElevenVoicesError(null);
        setElevenVoicesLoading(true);
        try {
            const res = await fetch("/api/ai-tools/video-solution/voices", {
                cache: "no-store",
            });
            const body = (await res.json()) as VoicesResponse;
            if (!res.ok || !body.success) {
                throw new Error(body.error || `Status ${res.status}`);
            }
            const voices = body.voices || [];
            setElevenVoices(voices);
            setElevenVoiceId((prev) => {
                if (prev && voices.some((v) => v.id === prev)) return prev;
                const hindi = voices.find((v) => v.isHindi);
                return (hindi || voices[0])?.id || "";
            });
        } catch (err) {
            setElevenVoicesError(err instanceof Error ? err.message : String(err));
            setElevenVoices([]);
        } finally {
            setElevenVoicesLoading(false);
        }
    }, []);

    useEffect(() => {
        if (ttsEngine !== "elevenlabs") return;
        if (elevenVoices.length > 0 || elevenVoicesLoading) return;
        void loadElevenVoices();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ttsEngine]);

    const loadChatterboxMeta = useCallback(async () => {
        const url = chatterboxUrl.trim();
        if (!url) {
            setChatterboxError("Enter the Chatterbox server URL first.");
            return;
        }
        setChatterboxError(null);
        setChatterboxLoading(true);
        try {
            const res = await fetch(
                `/api/ai-tools/video-solution/chatterbox-meta?url=${encodeURIComponent(url)}`,
                { cache: "no-store" }
            );
            const body = (await res.json()) as {
                success?: boolean;
                modelInfo?: ChatterboxModelInfo | null;
                voices?: string[];
                referenceFiles?: string[];
                error?: string;
            };
            if (!res.ok || !body.success) {
                throw new Error(body.error || `Status ${res.status}`);
            }
            const voices = body.voices || [];
            const refFiles = body.referenceFiles || [];
            const info = body.modelInfo || null;
            setChatterboxModelInfo(info);
            setChatterboxVoices(voices);
            setChatterboxReferenceFiles(refFiles);
            // Preserve user's selection if still present in either list;
            // otherwise default to the first reference file (custom-trained
            // voice — most likely what they want), then to the first built-in.
            const all = [...voices, ...refFiles];
            setChatterboxVoice((prev) =>
                prev && all.includes(prev)
                    ? prev
                    : (refFiles[0] || voices[0] || "")
            );
            // Default language: keep user's pick if still supported, else "en",
            // else first supported language.
            const supported = info?.supportedLanguages || {};
            setChatterboxLanguage((prev) => {
                if (Object.keys(supported).length === 0) return prev || "en";
                if (prev && supported[prev]) return prev;
                if (supported["en"]) return "en";
                return Object.keys(supported)[0];
            });
        } catch (err) {
            setChatterboxError(err instanceof Error ? err.message : String(err));
            setChatterboxModelInfo(null);
            setChatterboxVoices([]);
            setChatterboxReferenceFiles([]);
        } finally {
            setChatterboxLoading(false);
        }
    }, []);   // chatterboxUrl read at call-time — keeps the effect below stable

    // Auto-fetch model-info + voices the first time the user switches to
    // Chatterbox. Re-runs if the user changes the URL and re-selects the engine.
    useEffect(() => {
        if (ttsEngine !== "chatterbox") return;
        if (chatterboxModelInfo || chatterboxVoices.length > 0) return;
        if (chatterboxLoading) return;
        void loadChatterboxMeta();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ttsEngine]);

    const { hindiVoices, otherVoices } = useMemo(() => {
        return {
            hindiVoices: elevenVoices.filter((v) => v.isHindi),
            otherVoices: elevenVoices.filter((v) => !v.isHindi),
        };
    }, [elevenVoices]);

    // Poll the status endpoint while a video job is running.
    //
    // Resilience: a single poll failure (404 from a hot-reloaded dev server,
    // network blip, 5xx) MUST NOT clear the live-log panel or stop polling.
    // The Python render is still running; we just keep retrying with a small
    // backoff and surface a "Reconnecting…" badge instead of a hard error.
    // We give up only after ~20 consecutive failures (≈1 minute) — at that
    // point the user almost certainly killed the server or the process died.
    useEffect(() => {
        if (!jobId) return;
        let cancelled = false;
        reportSavedFiredRef.current = false;
        pollFailuresRef.current = 0;
        setPollState("live");

        async function tick() {
            try {
                const res = await fetch(
                    `/api/ai-tools/video-solution/videos/${jobId}/status`,
                    { cache: "no-store" }
                );
                const data = (await res.json().catch(() => ({}))) as Partial<VideoJobStatus> & {
                    success?: boolean;
                    error?: string;
                };
                if (cancelled) return;
                if (!res.ok || !data.success) {
                    pollFailuresRef.current += 1;
                    setPollState("reconnecting");
                    if (pollFailuresRef.current > 20) {
                        // ~1 min of consecutive failures. Surface a soft error
                        // but keep the last-known log + state on screen so the
                        // user has something to look at.
                        setError(
                            (data.error || `Status ${res.status}`) +
                            " — gave up after 20 retries. The job may still be running; check AI Reports when done."
                        );
                        return;
                    }
                    // Try again with mild backoff (2 s → 4 s after a few fails).
                    const delay = pollFailuresRef.current < 3 ? 2000 : 4000;
                    pollRef.current = setTimeout(tick, delay);
                    return;
                }
                // Successful poll.
                pollFailuresRef.current = 0;
                setPollState("live");
                setJobStatus(data as VideoJobStatus);
                if (data.state === "done") {
                    if (!reportSavedFiredRef.current) {
                        reportSavedFiredRef.current = true;
                        onReportSaved?.();
                    }
                    setPollState("idle");
                    return;
                }
                if (data.state === "error") {
                    setPollState("idle");
                    return;
                }
                pollRef.current = setTimeout(tick, 2000);
            } catch (err) {
                if (cancelled) return;
                // Transient — network error or JSON parse. Same retry policy.
                pollFailuresRef.current += 1;
                setPollState("reconnecting");
                if (pollFailuresRef.current > 20) {
                    setError(err instanceof Error ? err.message : String(err));
                    return;
                }
                pollRef.current = setTimeout(tick, 2000);
            }
        }
        void tick();
        return () => {
            cancelled = true;
            if (pollRef.current) clearTimeout(pollRef.current);
        };
    }, [jobId, onReportSaved]);

    // Reset the visible busy spinner as soon as the job is queued OR reaches a
    // terminal state — the render itself keeps running in the background, so
    // the user should be able to submit ANOTHER video job immediately.
    useEffect(() => {
        if (!jobStatus) return;
        if (
            jobStatus.state === "queued" ||
            jobStatus.state === "running" ||
            jobStatus.state === "done" ||
            jobStatus.state === "error"
        ) {
            setBusy(null);
        }
    }, [jobStatus]);

    const handleSlides = useCallback(async () => {
        setError(null);
        setSlidesNotice(null);
        const usingQbg = !!qbgIds?.length;
        if (!usingQbg && !questionPdf) {
            setError("Pick a question PDF in the upload section above first.");
            return;
        }
        setBusy("slides");
        try {
            const res = usingQbg
                ? await fetch("/api/ai-tools/video-solution/slides", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ qbg_ids: qbgIds!.join("\n") }),
                  })
                : await fetch("/api/ai-tools/video-solution/slides", {
                      method: "POST",
                      body: (() => {
                          const form = new FormData();
                          form.append("question_pdf", questionPdf!);
                          return form;
                      })(),
                  });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Status ${res.status}`);
            }
            const count = res.headers.get("X-Question-Count");
            const missingIdsHeader = res.headers.get("X-Missing-Ids");
            const skippedHeader = res.headers.get("X-Skipped-Unsupported");
            const blob = await res.blob();
            const filename = usingQbg
                ? `qbg_${qbgIds!.length}_ids.pptx`
                : (questionPdf!.name.replace(/\.(pdf|docx?)$/i, "") || "slides") + ".pptx";
            triggerDownload(blob, filename);
            let notice = `Built ${count ?? "?"} slides — ${filename} downloaded.`;
            if (missingIdsHeader) {
                const ids = JSON.parse(missingIdsHeader) as string[];
                notice += ` ${ids.length} id(s) not found in QBG.`;
            }
            if (skippedHeader) {
                const skipped = JSON.parse(skippedHeader) as { qbgId: string; reason: string }[];
                notice += ` ${skipped.length} skipped (unsupported type).`;
            }
            setSlidesNotice(notice);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }, [questionPdf, qbgIds]);

    const handleVideos = useCallback(async () => {
        setError(null);
        const usingQbg = !!qbgIds?.length;
        if (!usingQbg && (!questionPdf || !solutionsPdf)) {
            setError("Both question PDF and solutions PDF are required for video generation (upload them above).");
            return;
        }
        if (usingQbg && qbgIds!.length === 0) {
            setError("Paste at least one QBG unique_id above.");
            return;
        }
        const resolvedElevenVoiceId = elevenUseCustomVoice
            ? elevenCustomVoiceId.trim()
            : elevenVoiceId;
        if (ttsEngine === "elevenlabs" && !resolvedElevenVoiceId) {
            setError(
                elevenUseCustomVoice
                    ? "Paste a voice ID first (e.g. TX3LPaxmHKxFdv7VOQHJ)."
                    : "Pick an ElevenLabs voice from the dropdown first."
            );
            return;
        }
        if (ttsEngine === "chatterbox") {
            if (!chatterboxUrl.trim()) {
                setError("Set the Chatterbox server URL first (e.g. http://localhost:8004).");
                return;
            }
            if (!chatterboxVoice) {
                setError("Click 'Connect / Refresh' to load voices, then pick one.");
                return;
            }
        }
        const providerKey = (userApiKeys[aiProvider] || "").trim();
        if (providerNeedsApiKey(aiProvider) && !providerKey) {
            setError(`No API key saved for ${aiProvider}. Open Manage API Keys (top-right user icon).`);
            return;
        }
        // Chatterbox: the user picks the language explicitly. For other engines
        // we infer it from the voice name.
        let narrationLanguage: string;
        if (ttsEngine === "chatterbox") {
            narrationLanguage = chatterboxLanguage || "en";
        } else {
            const selectedVoiceIsHindi =
                ttsEngine === "edge"
                    ? isHindiEdgeVoice(edgeVoice)
                    : elevenUseCustomVoice
                        ? false
                        : !!elevenVoices.find((v) => v.id === resolvedElevenVoiceId)?.isHindi;
            narrationLanguage = selectedVoiceIsHindi ? "hi" : "en";
        }

        setBusy("videos");
        setJobStatus(null);
        try {
            const voiceForForm =
                ttsEngine === "edge" ? edgeVoice :
                ttsEngine === "elevenlabs" ? resolvedElevenVoiceId :
                ttsEngine === "chatterbox" ? chatterboxVoice :
                "";
            const chatterboxModelName = chatterboxModelInfo?.className || "tts-1";

            let res: Response;
            if (usingQbg) {
                const jsonBody: Record<string, string> = {
                    qbg_ids: qbgIds!.join("\n"),
                    ai_provider: aiProvider,
                    ai_model_id: aiModelId,
                    tts_engine: ttsEngine,
                    voice: voiceForForm,
                    language: narrationLanguage,
                    max_questions: maxQuestions.trim(),
                };
                if (ttsEngine === "elevenlabs") jsonBody.eleven_model = elevenModel;
                if (ttsEngine === "chatterbox") {
                    jsonBody.chatterbox_url = chatterboxUrl.trim();
                    jsonBody.chatterbox_model = chatterboxModelName;
                }
                res = await fetch("/api/ai-tools/video-solution/videos", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(jsonBody),
                });
            } else {
                const form = new FormData();
                form.append("question_pdf", questionPdf!);
                form.append("solutions_pdf", solutionsPdf!);
                form.append("ai_provider", aiProvider);
                form.append("ai_model_id", aiModelId);
                form.append("tts_engine", ttsEngine);
                form.append("voice", voiceForForm);
                if (ttsEngine === "elevenlabs") {
                    form.append("eleven_model", elevenModel);
                }
                if (ttsEngine === "chatterbox") {
                    form.append("chatterbox_url", chatterboxUrl.trim());
                    // The Chatterbox-TTS-Server has exactly one model loaded at a
                    // time (selected server-side via /restart_server). The OpenAI
                    // /v1/audio/speech contract still requires a model string —
                    // we pass the loaded class name when available, else "tts-1".
                    form.append("chatterbox_model", chatterboxModelName);
                }
                form.append("language", narrationLanguage);
                form.append("max_questions", maxQuestions.trim());
                res = await fetch("/api/ai-tools/video-solution/videos", {
                    method: "POST",
                    body: form,
                });
            }
            const body = await res.json();
            if (!res.ok || !body.success) {
                throw new Error(body.error || `Status ${res.status}`);
            }
            const newJobId = body.jobId as string;
            setJobId(newJobId);
            // Register with the global tracker so polling continues even if
            // the user navigates away from /ai-tools or refreshes the page.
            trackVideoJob({
                jobId: newJobId,
                fileName: usingQbg ? `qbg_${qbgIds!.length}_ids` : questionPdf!.name,
                startedAt: new Date().toISOString(),
            });
            // Unblock the UI immediately — render runs in the background.
            // User can submit ANOTHER video job right away; previous ones
            // keep going server-side and surface in AI Reports when done.
            setBusy(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(null);
        }
    }, [
        questionPdf,
        solutionsPdf,
        qbgIds,
        aiProvider,
        aiModelId,
        userApiKeys,
        ttsEngine,
        edgeVoice,
        chatterboxUrl,
        chatterboxVoice,
        chatterboxLanguage,
        chatterboxModelInfo,
        elevenVoiceId,
        elevenUseCustomVoice,
        elevenCustomVoiceId,
        elevenModel,
        elevenVoices,
        maxQuestions,
        trackVideoJob,
    ]);

    const handleDownloadZip = useCallback(async () => {
        if (!jobId) return;
        try {
            const res = await fetch(`/api/ai-tools/video-solution/videos/${jobId}/download`);
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const blob = await res.blob();
            const filename = qbgIds?.length
                ? `qbg_${qbgIds.length}_ids_videos.zip`
                : (questionPdf?.name.replace(/\.pdf$/i, "") || "solution-videos") + "_videos.zip";
            triggerDownload(blob, filename);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [jobId, questionPdf, qbgIds]);

    const canSlides = (!!questionPdf || !!qbgIds?.length) && busy !== "slides";
    const canVideos = (!!(questionPdf && solutionsPdf) || !!qbgIds?.length) && busy !== "videos";

    return (
        <div style={{ display: "grid", gap: "16px" }}>
            <section
                style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "12px",
                    padding: "20px",
                    background: "var(--bg-secondary)",
                    display: "grid",
                    gap: "14px",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <VideoIcon size={18} color="var(--accent-primary, #818cf8)" />
                    <h2
                        style={{
                            margin: 0,
                            fontSize: "0.95rem",
                            fontWeight: 700,
                            color: "var(--text-primary)",
                        }}
                    >
                        Video Solution Configuration
                    </h2>
                </div>
                <p
                    style={{
                        margin: 0,
                        fontSize: "0.78rem",
                        color: "var(--text-tertiary)",
                        lineHeight: 1.6,
                    }}
                >
                    Generates a <strong>.pptx</strong> deck (slides only, ~5 s) or a narrated{" "}
                    <strong>.mp4 per question</strong> (slow, ~30 s per question). Uses the{" "}
                    <strong>AI provider + model</strong> picked above for narration; the
                    voice and TTS engine are chosen here. Picking a Hindi voice
                    automatically asks the model to narrate in Hindi.
                </p>

                {/* TTS engine picker — 2 × 2 grid */}
                <div style={{ display: "grid", gap: "6px" }}>
                    <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                        Narration engine
                    </span>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr 1fr",
                            gap: "6px",
                            padding: "4px",
                            background: "var(--bg-tertiary)",
                            border: "1px solid var(--border-primary)",
                            borderRadius: "10px",
                        }}
                    >
                        {([
                            { id: "edge",        label: "Edge TTS",      sub: "Free • EN + Hindi",       icon: "🌐" },
                            { id: "elevenlabs",  label: "ElevenLabs",    sub: "Premium • multilingual",  icon: "✨" },
                            { id: "chatterbox",  label: "Chatterbox",    sub: "Self-hosted HTTP server",  icon: "🎙️" },
                        ] as { id: TTSEngine; label: string; sub: string; icon: string }[]).map((opt) => {
                            const active = ttsEngine === opt.id;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setTtsEngine(opt.id)}
                                    style={{
                                        display: "inline-flex",
                                        flexDirection: "column",
                                        alignItems: "center",
                                        gap: "1px",
                                        padding: "8px 10px",
                                        borderRadius: "8px",
                                        border: "none",
                                        background: active ? "var(--accent-glow)" : "transparent",
                                        color: active ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                                        cursor: "pointer",
                                        fontWeight: active ? 700 : 500,
                                        fontSize: "0.8rem",
                                        transition: "all 0.15s ease",
                                    }}
                                >
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                        <span>{opt.icon}</span>
                                        {opt.label}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: "0.63rem",
                                            color: active ? "var(--accent-primary-hover)" : "var(--text-muted)",
                                            opacity: 0.85,
                                        }}
                                    >
                                        {opt.sub}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                </div>

                <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "1fr 1fr" }}>
                    {ttsEngine === "edge" ? (
                        <label style={{ display: "grid", gap: "4px" }}>
                            <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                Edge voice{" "}
                                <span style={{ color: "#f59e0b", fontWeight: 700 }}>(2 Hindi available)</span>
                            </span>
                            <select
                                value={edgeVoice}
                                onChange={(e) => setEdgeVoice(e.target.value)}
                                style={inputStyle()}
                            >
                                {(["Hindi", "Indian English", "Other"] as const).map((g) => {
                                    const voices = EDGE_VOICES.filter((v) => v.group === g);
                                    if (voices.length === 0) return null;
                                    const flag = g === "Hindi" ? "🇮🇳 " : "";
                                    return (
                                        <optgroup key={g} label={`${flag}${g}`}>
                                            {voices.map((v) => (
                                                <option key={v.id} value={v.id}>
                                                    {v.label}
                                                </option>
                                            ))}
                                        </optgroup>
                                    );
                                })}
                            </select>
                        </label>
                    ) : (
                        <label style={{ display: "grid", gap: "4px" }}>
                            <span
                                style={{
                                    fontSize: "0.76rem",
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "8px",
                                }}
                            >
                                <span>
                                    ElevenLabs voice{" "}
                                    {hindiVoices.length > 0 && (
                                        <span style={{ color: "#f59e0b", fontWeight: 700, marginLeft: 4 }}>
                                            ({hindiVoices.length} Hindi available)
                                        </span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void loadElevenVoices()}
                                    disabled={elevenVoicesLoading}
                                    title="Reload voice list from ElevenLabs"
                                    style={{
                                        background: "transparent",
                                        border: "none",
                                        color: "var(--text-tertiary)",
                                        cursor: elevenVoicesLoading ? "default" : "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "3px",
                                        fontSize: "0.7rem",
                                        padding: 0,
                                    }}
                                >
                                    <RefreshCw size={11} className={elevenVoicesLoading ? "animate-spin" : ""} />
                                    Refresh
                                </button>
                            </span>
                            <select
                                value={elevenUseCustomVoice ? CUSTOM_VOICE_SENTINEL : elevenVoiceId}
                                onChange={(e) => {
                                    if (e.target.value === CUSTOM_VOICE_SENTINEL) {
                                        setElevenUseCustomVoice(true);
                                    } else {
                                        setElevenUseCustomVoice(false);
                                        setElevenVoiceId(e.target.value);
                                    }
                                }}
                                disabled={elevenVoicesLoading}
                                style={inputStyle()}
                            >
                                {elevenVoicesLoading && <option>Loading voices…</option>}
                                {!elevenVoicesLoading && elevenVoices.length === 0 && (
                                    <option value="">No voices loaded yet</option>
                                )}
                                {hindiVoices.length > 0 && (
                                    <optgroup label="🇮🇳 Hindi voices">
                                        {hindiVoices.map((v) => (
                                            <option key={v.id} value={v.id}>
                                                {v.name}
                                                {v.language ? ` (${v.language})` : ""}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {otherVoices.length > 0 && (
                                    <optgroup label="English / other voices">
                                        {otherVoices.map((v) => (
                                            <option key={v.id} value={v.id}>
                                                {v.name}
                                                {v.language ? ` (${v.language})` : ""}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                <option value={CUSTOM_VOICE_SENTINEL}>
                                    ✎ Paste a custom voice ID…
                                </option>
                            </select>
                            {elevenUseCustomVoice && (
                                <input
                                    type="text"
                                    value={elevenCustomVoiceId}
                                    onChange={(e) => setElevenCustomVoiceId(e.target.value)}
                                    placeholder="e.g. TX3LPaxmHKxFdv7VOQHJ"
                                    style={inputStyle()}
                                />
                            )}
                            {elevenUseCustomVoice && (
                                <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                    Find a voice on{" "}
                                    <a
                                        href="https://elevenlabs.io/app/voice-library"
                                        target="_blank"
                                        rel="noreferrer"
                                        style={{ color: "var(--accent-primary)" }}
                                    >
                                        elevenlabs.io/voice-library
                                    </a>
                                    {" "}→ copy its <strong>voice ID</strong> and paste above.
                                </span>
                            )}
                            {elevenVoicesError && (
                                <span style={{ fontSize: "0.72rem", color: "#ef4444" }}>
                                    {elevenVoicesError}
                                </span>
                            )}
                            {!elevenVoicesError && !elevenVoicesLoading && elevenVoices.length === 0 && (
                                <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                    Save an ElevenLabs key in <strong>Manage API Keys → ElevenLabs (TTS)</strong>, then click Refresh — or paste a voice ID directly.
                                </span>
                            )}
                        </label>
                    )}
                    {ttsEngine === "chatterbox" ? (
                        /* Chatterbox voice dropdown — splits user-trained
                           reference voices into their own optgroup at the top
                           so they're easy to spot. */
                        <label style={{ display: "grid", gap: "4px" }}>
                            <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                Chatterbox voice{" "}
                                {chatterboxReferenceFiles.length > 0 && (
                                    <span style={{ color: "#22c55e", fontWeight: 700 }}>
                                        ({chatterboxReferenceFiles.length} custom)
                                    </span>
                                )}
                            </span>
                            <select
                                value={chatterboxVoice}
                                onChange={(e) => setChatterboxVoice(e.target.value)}
                                disabled={
                                    chatterboxLoading ||
                                    (chatterboxVoices.length === 0 && chatterboxReferenceFiles.length === 0)
                                }
                                style={inputStyle()}
                            >
                                {chatterboxLoading && <option>Loading voices…</option>}
                                {!chatterboxLoading &&
                                 chatterboxVoices.length === 0 &&
                                 chatterboxReferenceFiles.length === 0 && (
                                    <option value="">No voices loaded — click Connect below</option>
                                )}
                                {chatterboxReferenceFiles.length > 0 && (
                                    <optgroup label="🎙️ Your trained / reference voices">
                                        {chatterboxReferenceFiles.map((v) => (
                                            <option key={`ref-${v}`} value={v}>{v}</option>
                                        ))}
                                    </optgroup>
                                )}
                                {chatterboxVoices.length > 0 && (
                                    <optgroup label="Built-in voices">
                                        {chatterboxVoices.map((v) => (
                                            <option key={`built-${v}`} value={v}>{v}</option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                            {chatterboxReferenceFiles.length === 0 && !chatterboxLoading && chatterboxVoices.length > 0 && (
                                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                    No reference files found. Trained voices live in your
                                    server's reference_audio folder — upload via Chatterbox's UI
                                    or the <code>/upload_reference</code> endpoint, then Refresh.
                                </span>
                            )}
                        </label>
                    ) : null}

                    <label style={{ display: "grid", gap: "4px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            Max questions for videos (0 = all)
                        </span>
                        <input
                            type="number"
                            min={0}
                            step={1}
                            value={maxQuestions}
                            onChange={(e) => setMaxQuestions(e.target.value)}
                            style={inputStyle()}
                            placeholder="2"
                        />
                    </label>
                </div>

                {ttsEngine === "chatterbox" && (
                    <div style={{ display: "grid", gap: "10px" }}>
                        {/* URL + Connect button */}
                        <label style={{ display: "grid", gap: "4px" }}>
                            <span
                                style={{
                                    fontSize: "0.76rem",
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "8px",
                                }}
                            >
                                <span>Chatterbox server URL</span>
                                <button
                                    type="button"
                                    onClick={() => void loadChatterboxMeta()}
                                    disabled={chatterboxLoading || !chatterboxUrl.trim()}
                                    style={{
                                        background: "transparent",
                                        border: "none",
                                        color: "var(--text-tertiary)",
                                        cursor: chatterboxLoading ? "default" : "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "3px",
                                        fontSize: "0.7rem",
                                        padding: 0,
                                    }}
                                    title="Re-fetch /api/model-info and /v1/audio/voices from this URL."
                                >
                                    <RefreshCw size={11} className={chatterboxLoading ? "animate-spin" : ""} />
                                    {chatterboxLoading ? "Connecting…" : "Connect / Refresh"}
                                </button>
                            </span>
                            <input
                                type="text"
                                value={chatterboxUrl}
                                onChange={(e) => setChatterboxUrl(e.target.value)}
                                placeholder="http://localhost:8004"
                                style={inputStyle()}
                            />
                            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                The Chatterbox-TTS-Server you're hosting. Open{" "}
                                <code>{(chatterboxUrl.replace(/\/+$/, "") || "http://…")}/docs</code>{" "}
                                to verify it's running.
                            </span>
                        </label>

                        {/* Loaded model badge */}
                        {chatterboxModelInfo && (
                            <div
                                style={{
                                    padding: "8px 12px",
                                    borderRadius: "8px",
                                    background: chatterboxModelInfo.loaded ? "#22c55e10" : "#ef444410",
                                    border: chatterboxModelInfo.loaded
                                        ? "1px solid #22c55e44"
                                        : "1px solid #ef444444",
                                    fontSize: "0.74rem",
                                    color: "var(--text-secondary)",
                                    lineHeight: 1.5,
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: "6px 12px",
                                    alignItems: "center",
                                }}
                            >
                                <span style={{ fontWeight: 700, color: chatterboxModelInfo.loaded ? "#15803d" : "#b91c1c" }}>
                                    {chatterboxModelInfo.loaded ? "● Loaded" : "○ Not loaded"}
                                </span>
                                {chatterboxModelInfo.className && (
                                    <span>
                                        <strong>{chatterboxModelInfo.className}</strong>
                                    </span>
                                )}
                                {chatterboxModelInfo.type && (
                                    <span style={{ color: "var(--text-tertiary)" }}>
                                        {chatterboxModelInfo.type}
                                    </span>
                                )}
                                {chatterboxModelInfo.sampleRate > 0 && (
                                    <span style={{ color: "var(--text-tertiary)" }}>
                                        {chatterboxModelInfo.sampleRate} Hz
                                    </span>
                                )}
                                {chatterboxModelInfo.supportsMultilingual && (
                                    <span style={{ color: "#f59e0b", fontWeight: 600 }}>
                                        🌐 {Object.keys(chatterboxModelInfo.supportedLanguages).length} languages
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Language picker (when multilingual) */}
                        {chatterboxModelInfo &&
                         Object.keys(chatterboxModelInfo.supportedLanguages).length > 1 && (
                            <label style={{ display: "grid", gap: "4px" }}>
                                <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                    Narration language{" "}
                                    {chatterboxModelInfo.supportedLanguages["hi"] && (
                                        <span style={{ color: "#f59e0b", fontWeight: 700 }}>
                                            (🇮🇳 Hindi available)
                                        </span>
                                    )}
                                </span>
                                <select
                                    value={chatterboxLanguage}
                                    onChange={(e) => setChatterboxLanguage(e.target.value)}
                                    style={inputStyle()}
                                >
                                    {Object.entries(chatterboxModelInfo.supportedLanguages)
                                        .sort(([a], [b]) => {
                                            // Hindi + English bubble to top.
                                            const pri = (c: string) => (c === "hi" ? 0 : c === "en" ? 1 : 2);
                                            return pri(a) - pri(b);
                                        })
                                        .map(([code, name]) => (
                                            <option key={code} value={code}>
                                                {name} ({code})
                                            </option>
                                        ))}
                                </select>
                                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                    Sent as <code>language</code> to <code>/v1/audio/speech</code> so the
                                    server picks the right phonemizer. Also drives the LLM narrator
                                    (Hindi script ↔ Hindi audio).
                                </span>
                            </label>
                        )}

                        {chatterboxError && (
                            <div style={noticeStyle("err")}>
                                <AlertCircle size={13} />
                                <span style={{ whiteSpace: "pre-wrap" }}>{chatterboxError}</span>
                            </div>
                        )}
                    </div>
                )}

                {ttsEngine === "elevenlabs" && (
                    <label style={{ display: "grid", gap: "4px" }}>
                        <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                            ElevenLabs model
                        </span>
                        <select
                            value={elevenModel}
                            onChange={(e) => setElevenModel(e.target.value)}
                            style={inputStyle()}
                        >
                            {ELEVEN_MODELS.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.label}
                                </option>
                            ))}
                        </select>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                            {ELEVEN_MODELS.find((m) => m.id === elevenModel)?.note}
                        </span>
                    </label>
                )}

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button
                        type="button"
                        onClick={handleSlides}
                        disabled={!canSlides}
                        style={primaryButton(canSlides)}
                        title="Convert the question PDF or Word doc into a .pptx deck (one slide per question)."
                    >
                        {busy === "slides" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                        {busy === "slides" ? "Generating slides…" : "Generate slides (.pptx)"}
                    </button>
                    <button
                        type="button"
                        onClick={handleVideos}
                        disabled={!canVideos}
                        style={secondaryButton(canVideos)}
                        title="Render narrated MP4s for every question (or up to the cap). Job runs in the background — you can queue more."
                    >
                        {busy === "videos" ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                        {busy === "videos"
                            ? "Submitting…"
                            : activeVideoJobs.length > 0
                                ? `Queue another video job (${activeVideoJobs.length} running)`
                                : "Generate solution videos (.zip)"}
                    </button>
                </div>
                <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    Videos take ~20–40 seconds each. A 25-question paper takes 10–20 minutes.
                    Jobs run server-side <strong>in the background</strong> — you can queue more
                    while one renders, switch AI tools, or close this tab. Finished videos
                    appear in <strong>AI Reports</strong> below.
                </p>
            </section>

            {slidesNotice && (
                <div style={noticeStyle("ok")}>
                    <Sparkles size={14} />
                    <span>{slidesNotice}</span>
                </div>
            )}

            {error && (
                <div style={noticeStyle("err")}>
                    <AlertCircle size={14} />
                    <span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
                </div>
            )}

            {jobId && (
                <section
                    style={{
                        border: "1px solid var(--border-primary)",
                        borderRadius: "12px",
                        padding: "16px",
                        background: "var(--bg-secondary)",
                        display: "grid",
                        gap: "10px",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: 700, color: "var(--text-primary)" }}>
                            Video job {jobId.slice(0, 8)}
                        </h3>
                        <StateBadge state={jobStatus?.state || "queued"} />
                        {pollState === "reconnecting" && (
                            <span
                                style={{
                                    fontSize: "0.7rem",
                                    fontWeight: 700,
                                    color: "#f59e0b",
                                    background: "#f59e0b15",
                                    border: "1px solid #f59e0b55",
                                    padding: "2px 8px",
                                    borderRadius: "5px",
                                    letterSpacing: "0.04em",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "5px",
                                }}
                                title="Status endpoint is unreachable but the Python render is still going. Will retry automatically."
                            >
                                <Loader2 size={10} className="animate-spin" />
                                RECONNECTING…
                            </span>
                        )}
                        {typeof jobStatus?.videoCount === "number" && jobStatus.videoCount > 0 && (
                            <span style={{ fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
                                {jobStatus.videoCount} video{jobStatus.videoCount === 1 ? "" : "s"}
                            </span>
                        )}
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                            Runs in the background — you can queue another job above.
                        </span>
                    </div>

                    <pre
                        style={{
                            margin: 0,
                            padding: "10px",
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-primary)",
                            borderRadius: "8px",
                            color: "var(--text-secondary)",
                            fontSize: "0.74rem",
                            lineHeight: 1.5,
                            maxHeight: "320px",
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        }}
                    >
                        {jobStatus?.log
                            ? jobStatus.log
                            : pollState === "reconnecting"
                                ? "Waiting for status endpoint to respond…"
                                : "Starting job — first log lines will appear here in a few seconds…"}
                    </pre>

                    {jobStatus?.state === "done" && (
                        <button
                            type="button"
                            onClick={handleDownloadZip}
                            style={primaryButton(true)}
                        >
                            <Download size={14} />
                            Download {jobStatus.videoCount} video{jobStatus.videoCount === 1 ? "" : "s"} (.zip)
                        </button>
                    )}
                    {jobStatus?.state === "done" &&
                        ((jobStatus.missingIds?.length ?? 0) > 0 || (jobStatus.skippedUnsupported?.length ?? 0) > 0) && (
                        <div style={noticeStyle("warn")}>
                            <AlertCircle size={14} />
                            <span>
                                {jobStatus.missingIds?.length ? `${jobStatus.missingIds.length} id(s) not found in QBG: ${jobStatus.missingIds.join(", ")}. ` : ""}
                                {jobStatus.skippedUnsupported?.length
                                    ? `${jobStatus.skippedUnsupported.length} skipped (unsupported type): ${jobStatus.skippedUnsupported.map((s) => `${s.qbgId} (${s.reason})`).join("; ")}.`
                                    : ""}
                            </span>
                        </div>
                    )}
                    {jobStatus?.state === "error" && (
                        <div style={noticeStyle("err")}>
                            <XCircle size={14} />
                            <span>{jobStatus.error || "Job failed (see log above)."}</span>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: JobState }) {
    const color = state === "done" ? "#22c55e" : state === "error" ? "#ef4444" : "#f59e0b";
    const label =
        state === "done" ? "Completed" :
        state === "error" ? "Failed" :
        state === "running" ? "Running" : "Queued";
    return (
        <span
            style={{
                fontSize: "0.7rem",
                fontWeight: 700,
                color,
                background: `${color}15`,
                border: `1px solid ${color}55`,
                padding: "2px 8px",
                borderRadius: "5px",
                letterSpacing: "0.04em",
            }}
        >
            {label.toUpperCase()}
        </span>
    );
}

function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function inputStyle(): React.CSSProperties {
    return {
        width: "100%",
        padding: "7px 10px",
        borderRadius: "8px",
        border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        color: "var(--text-primary)",
        fontSize: "0.82rem",
        outline: "none",
    };
}

function primaryButton(enabled: boolean): React.CSSProperties {
    return {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "9px 14px",
        borderRadius: "10px",
        border: "1px solid var(--accent-primary, #818cf8)",
        background: enabled ? "var(--accent-primary, #818cf8)" : "var(--bg-tertiary)",
        color: enabled ? "#fff" : "var(--text-tertiary)",
        fontSize: "0.82rem",
        fontWeight: 700,
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.6,
    };
}

function secondaryButton(enabled: boolean): React.CSSProperties {
    return {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "9px 14px",
        borderRadius: "10px",
        border: "1px solid var(--border-primary)",
        background: enabled ? "var(--bg-tertiary)" : "var(--bg-tertiary)",
        color: "var(--text-primary)",
        fontSize: "0.82rem",
        fontWeight: 700,
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.55,
    };
}

function noticeStyle(kind: "ok" | "err" | "warn"): React.CSSProperties {
    const color = kind === "ok" ? "#22c55e" : kind === "warn" ? "#f59e0b" : "#ef4444";
    return {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 12px",
        borderRadius: "9px",
        border: `1px solid ${color}55`,
        background: `${color}10`,
        color,
        fontSize: "0.78rem",
    };
}
