/**
 * Which AI models can actually LOOK at a diagram.
 *
 * The QC pass sends each question's figure to the model as an image, because
 * the commonest defect in a reframed question is the picture disagreeing with
 * the words. A text-only model cannot see that at all — it will read the stem,
 * find it self-consistent, and pass a question whose diagram says something
 * else. So the model picker has to tell the user which models can see, rather
 * than leaving them to guess from the name.
 *
 * Matching is by family, because provider model lists are long, change often,
 * and (except OpenRouter) carry no capability flag we can read. Three answers:
 *
 *   "yes"     — the family is known to accept images
 *   "no"      — the family is known NOT to (a text-only or embedding model)
 *   "unknown" — not recognised; shown as such rather than guessed at
 *
 * A wrong "yes" is the expensive error — QC would silently stop checking the
 * figures — so a family only earns "yes" when the whole family takes images.
 */

export type VisionSupport = "yes" | "no" | "unknown";

/** Families that read images. Matched case-insensitively against the model id. */
const VISION_PATTERNS: RegExp[] = [
    // Google — every Gemini serves multimodal input.
    /(^|\/)gemini[-.]/i,
    // Anthropic — Claude 3 and everything after.
    /(^|\/)claude[-.]?(3|4|5|opus|sonnet|haiku)/i,
    // OpenAI — the 4o / 4.1 / 5 families and the o-series reasoning models.
    /(^|\/)gpt[-.]?4o/i,
    /(^|\/)gpt[-.]?4\.1/i,
    /(^|\/)gpt[-.]?5/i,
    /(^|\/)o[134](-|$|\/)/i,
    /(^|\/)chatgpt-4o/i,
    // Meta — Llama 4 is natively multimodal; Llama 3.2's vision variants say so.
    /(^|\/)llama[-.]?4/i,
    /llama[-.]?3\.2[-.]?(11b|90b)?[-.]?vision/i,
    // xAI
    /(^|\/)grok[-.]?(2-vision|3|4)/i,
    // Open-weight vision families
    /qwen.*(vl|omni)/i,
    /(^|\/)pixtral/i,
    /internvl/i,
    /(^|\/)molmo/i,
    /(^|\/)llava/i,
    /(^|\/)phi[-.]?[34].*vision/i,
    /(^|\/)mistral[-.]?(medium[-.]?3|small[-.]?3\.[12])/i,
    /gemma[-.]?3/i,
    /(^|\/)step[-.]?1o/i,
    /vision/i,
];

/** Families that are known to be text-only, so we can say "no" rather than shrug. */
const TEXT_ONLY_PATTERNS: RegExp[] = [
    /(^|\/)deepseek(?!.*vl)/i,
    /(^|\/)gpt[-.]?3\.5/i,
    /(^|\/)gpt[-.]?4[-.]?(turbo|0613|0314)/i,
    /(^|\/)o[13][-.]?mini/i,
    /(^|\/)text[-.]|embedding/i,
    /(^|\/)mixtral/i,
    /(^|\/)llama[-.]?[23](?!.*vision)/i,
    /(^|\/)qwen(?!.*(vl|omni))/i,
    /(^|\/)codestral|(^|\/)codellama/i,
    /(^|\/)command[-.]?r/i,
    /(^|\/)kimi(?!.*vl)/i,
    /(^|\/)glm[-.]?[45](?!.*v)/i,
];

/**
 * Whole providers whose model lists are single-family enough to answer directly.
 * Only used when the model id itself is unrecognised.
 */
const PROVIDER_DEFAULT: Record<string, VisionSupport> = {
    gemini: "yes",
    anthropic: "yes",
};

/** Can this model read an image? */
export function visionSupport(provider: string, modelId: string): VisionSupport {
    const id = (modelId || "").trim();
    if (!id) return "unknown";
    for (const re of TEXT_ONLY_PATTERNS) if (re.test(id)) return "no";
    for (const re of VISION_PATTERNS) if (re.test(id)) return "yes";
    return PROVIDER_DEFAULT[(provider || "").toLowerCase()] || "unknown";
}

/** Short label for a picker entry. */
export function visionLabel(support: VisionSupport): string {
    if (support === "yes") return "reads diagrams";
    if (support === "no") return "text only — cannot see the figure";
    return "unknown — may not read diagrams";
}

export const VISION_COLOR: Record<VisionSupport, string> = {
    yes: "var(--accent-success)",
    no: "var(--accent-danger)",
    unknown: "var(--text-tertiary)",
};

/**
 * Sort a provider's models so the ones that can see come first, each keeping the
 * provider's own ordering — the point of the QC picker is to make the usable
 * models the easy choice.
 */
export function sortByVision<T extends { id: string }>(provider: string, models: T[]): T[] {
    const rank: Record<VisionSupport, number> = { yes: 0, unknown: 1, no: 2 };
    return [...models]
        .map((m, i) => ({ m, i, r: rank[visionSupport(provider, m.id)] }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.m);
}
