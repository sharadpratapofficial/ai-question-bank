/**
 * Default AI + image models for the QBG tools.
 *
 * QBG Modification, QBG Ingestion and the QBG Pipeline each carried their own
 * copy of these constants, so changing a default meant three identical edits —
 * the same drift that made adding a QBG category a three-file job (see
 * qbgCategories.ts). One place now.
 *
 * Model IDs, not labels: the dropdowns show whatever display name the provider
 * returns from its live model list ("Nano Banana 2" is Google's own name for
 * gemini-3.1-flash-image), and those names change without notice. The lists here
 * are only the fallback shown before that fetch lands, or if it fails.
 */
import type { AIModelProvider } from "@/types/extraction";

/** Text model used by Modify + Tag + narration. */
export const DEFAULT_AI_PROVIDER: AIModelProvider = "gemini";
export const DEFAULT_AI_MODEL = "gemini-3.8-flash";

/** Image model used for diagram redraw / generation. */
export type ImgProvider = "gemini" | "openai";
export const DEFAULT_IMG_PROVIDER: ImgProvider = "gemini";

export const IMG_PROVIDER_LABELS: Record<ImgProvider, string> = {
    gemini: "Google Gemini (nano banana)",
    openai: "OpenAI (gpt-image-1)",
};

export const IMG_DEFAULT_MODEL: Record<ImgProvider, string> = {
    gemini: "gemini-3.1-flash-image",
    openai: "gpt-image-1",
};

/** Shown until the provider's real model list arrives (see /api/ai-tools/image-models). */
export const IMG_FALLBACK_MODELS: Record<ImgProvider, { id: string; label: string }[]> = {
    gemini: [
        { id: "gemini-3.1-flash-image", label: "Nano Banana 2" },
        { id: "gemini-2.5-flash-image", label: "Nano Banana" },
    ],
    openai: [{ id: "gpt-image-1", label: "gpt-image-1" }],
};
