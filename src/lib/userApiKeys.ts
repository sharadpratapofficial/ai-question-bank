import type { AIModelProvider } from "@/types/extraction";

export type SupportedApiProvider = AIModelProvider | "anthropic" | "elevenlabs" | "qbg" | "google_drive";

/** Subset of SupportedApiProvider that represents chat/LLM providers (i.e.
 *  everything except TTS-only or other non-LLM keys). Use this for Record
 *  types that map provider → model list, and for AI provider dropdowns. */
export type ChatApiProvider = Exclude<SupportedApiProvider, "elevenlabs" | "qbg" | "google_drive">;

export const SUPPORTED_API_PROVIDERS: SupportedApiProvider[] = [
    "gemini",
    "anthropic",
    "openai",
    "groq",
    "grok",
    "openrouter",
    "nvidia",
    "fireworks",
    "custom_openai",
    "local",
    "g4f",
    "elevenlabs",
    "qbg",
    "google_drive",
];

// Providers that are NOT chat/LLM (e.g. TTS-only, the QBG REST API token, or
// the Google Drive OAuth connection). Exclude these from AI provider/model
// dropdowns that pick an LLM to call.
const NON_LLM_PROVIDERS: ReadonlySet<SupportedApiProvider> = new Set(["elevenlabs", "qbg", "google_drive"]);

export const CHAT_API_PROVIDERS: SupportedApiProvider[] = SUPPORTED_API_PROVIDERS.filter(
    (p) => !NON_LLM_PROVIDERS.has(p)
);

export const API_KEY_PROVIDER_LABELS: Record<SupportedApiProvider, string> = {
    gemini: "Gemini",
    anthropic: "Anthropic",
    openai: "OpenAI",
    groq: "Groq",
    grok: "Grok",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA NIM",
    fireworks: "Fireworks AI",
    custom_openai: "OpenAI Compatible",
    local: "Local Server URL",
    g4f: "gpt4free (g4f server URL)",
    elevenlabs: "ElevenLabs (TTS)",
    qbg: "QBG (PenPencil) API",
    google_drive: "Google Drive",
};

export type UserApiKeys = Record<SupportedApiProvider, string>;

export const EMPTY_USER_API_KEYS: UserApiKeys = {
    gemini: "",
    anthropic: "",
    openai: "",
    groq: "",
    grok: "",
    openrouter: "",
    nvidia: "",
    fireworks: "",
    custom_openai: JSON.stringify({ baseUrl: "", apiKey: "" }),
    local: "http://localhost:11434/v1",
    // g4f's own OpenAI-compatible server (`g4f api`) listens here by default.
    g4f: "http://localhost:1337/v1",
    elevenlabs: "",
    qbg: JSON.stringify({ token: "", user: "", userId: "" }),
    google_drive: JSON.stringify({ refreshToken: "", email: "", folderId: "" }),
};

export interface CustomOpenAIProviderConfig {
    baseUrl: string;
    apiKey: string;
}

export function parseCustomOpenAIProviderConfig(value: string | undefined | null): CustomOpenAIProviderConfig {
    const raw = String(value || "").trim();
    if (!raw) return { baseUrl: "", apiKey: "" };
    try {
        const parsed = JSON.parse(raw) as Partial<CustomOpenAIProviderConfig>;
        return {
            baseUrl: String(parsed.baseUrl || "").trim().replace(/\/+$/, ""),
            apiKey: String(parsed.apiKey || "").trim(),
        };
    } catch {
        return { baseUrl: "", apiKey: raw };
    }
}

export function stringifyCustomOpenAIProviderConfig(config: CustomOpenAIProviderConfig): string {
    return JSON.stringify({
        baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: config.apiKey.trim(),
    });
}

/** QBG (PenPencil) REST API credentials — a Bearer token plus the `user` and
 *  `user-id` headers qbg.py sends. Stored as JSON in the "qbg" key. */
export interface QbgProviderConfig {
    token: string;
    user: string;
    userId: string;
}

export function parseQbgProviderConfig(value: string | undefined | null): QbgProviderConfig {
    const raw = String(value || "").trim();
    if (!raw) return { token: "", user: "", userId: "" };
    try {
        const parsed = JSON.parse(raw) as Partial<QbgProviderConfig>;
        return {
            token: String(parsed.token || "").trim(),
            user: String(parsed.user || "").trim(),
            userId: String(parsed.userId || "").trim(),
        };
    } catch {
        // Legacy / bare-token value.
        return { token: raw, user: "", userId: "" };
    }
}

export function stringifyQbgProviderConfig(config: QbgProviderConfig): string {
    return JSON.stringify({
        token: config.token.trim(),
        user: config.user.trim(),
        userId: config.userId.trim(),
    });
}

/** Google Drive OAuth connection — a long-lived refresh token (obtained via
 *  the drive.file-scoped consent flow, see src/lib/googleDrive.ts), the
 *  connected account's email (display only), and the shared "Question Wise
 *  Videos" folder's id once created (cached so repeat uploads/notebook
 *  saves reuse the same folder instead of creating a new one each time). */
export interface GoogleDriveProviderConfig {
    refreshToken: string;
    email: string;
    folderId: string;
}

export function parseGoogleDriveProviderConfig(value: string | undefined | null): GoogleDriveProviderConfig {
    const raw = String(value || "").trim();
    if (!raw) return { refreshToken: "", email: "", folderId: "" };
    try {
        const parsed = JSON.parse(raw) as Partial<GoogleDriveProviderConfig>;
        return {
            refreshToken: String(parsed.refreshToken || "").trim(),
            email: String(parsed.email || "").trim(),
            folderId: String(parsed.folderId || "").trim(),
        };
    } catch {
        return { refreshToken: "", email: "", folderId: "" };
    }
}

export function stringifyGoogleDriveProviderConfig(config: GoogleDriveProviderConfig): string {
    return JSON.stringify({
        refreshToken: config.refreshToken.trim(),
        email: config.email.trim(),
        folderId: config.folderId.trim(),
    });
}

/** Providers that run on the user's own machine and authenticate nothing: the
 *  value stored against them is an endpoint URL, not a secret. Callers use this
 *  instead of comparing against "local" by hand, so adding another self-hosted
 *  provider does not mean hunting down forty `provider !== "local"` checks. */
export function providerNeedsApiKey(provider: SupportedApiProvider): boolean {
    return provider !== "local" && provider !== "g4f";
}

export function getProviderApiCredential(provider: SupportedApiProvider, storedValue: string): string {
    if (provider === "custom_openai") {
        return parseCustomOpenAIProviderConfig(storedValue).apiKey;
    }
    if (provider === "qbg") {
        return parseQbgProviderConfig(storedValue).token;
    }
    return storedValue.trim();
}

export function getProviderBaseUrl(provider: SupportedApiProvider, storedValue: string): string {
    if (provider === "custom_openai") {
        return parseCustomOpenAIProviderConfig(storedValue).baseUrl;
    }
    if (provider === "local") {
        return storedValue.trim() || "http://localhost:11434/v1";
    }
    if (provider === "g4f") {
        return storedValue.trim() || "http://localhost:1337/v1";
    }
    return "";
}

const DEV_KEYS_STORAGE_KEY = "qbg_dev_user_api_keys_v1";

export function sanitizeUserApiKeys(payload: unknown): UserApiKeys {
    const safe: UserApiKeys = { ...EMPTY_USER_API_KEYS };
    if (!payload || typeof payload !== "object") return safe;

    const map = payload as Record<string, unknown>;
    for (const provider of SUPPORTED_API_PROVIDERS) {
        const value = map[provider];
        if (typeof value === "string") {
            safe[provider] = value.trim();
        }
    }

    return safe;
}

export function readDevApiKeysFromStorage(): UserApiKeys {
    if (typeof window === "undefined") return { ...EMPTY_USER_API_KEYS };

    try {
        const raw = localStorage.getItem(DEV_KEYS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const sanitized = sanitizeUserApiKeys(parsed);

        // Backward compatibility for old single-key storage.
        if (!sanitized.gemini) {
            const legacyKey = localStorage.getItem("pdf_extract_api_key");
            if (legacyKey && legacyKey.trim()) {
                sanitized.gemini = legacyKey.trim();
            }
        }

        return sanitized;
    } catch {
        return { ...EMPTY_USER_API_KEYS };
    }
}

export function writeDevApiKeysToStorage(apiKeys: UserApiKeys): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(DEV_KEYS_STORAGE_KEY, JSON.stringify(sanitizeUserApiKeys(apiKeys)));
}
