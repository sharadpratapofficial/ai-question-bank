/**
 * LLM token-cost pricing for Agentic QC reports.
 *
 * The final QC report shows how many tokens each model consumed and what that
 * cost in ₹. Costs come from a MAINTAINED price table below (USD per 1M
 * tokens) rather than a live per-run lookup — there is no single pricing API
 * that spans every provider, and a curated table is fast, deterministic, and
 * easy to keep current. Update the numbers (and `PRICING_AS_OF`) whenever
 * providers change their rates.
 *
 * Matching is fuzzy: model IDs vary wildly ("claude-3-5-sonnet-20241022",
 * "anthropic/claude-sonnet-4.5", "gpt-5-mini", "gemini-2.5-pro-preview-05-06"),
 * so we normalise both the incoming ID and each table key to alphanumerics and
 * pick the LONGEST key that is a substring of the model ID. Unknown models
 * return null and the report flags them as "price not in table".
 */

/** USD → INR conversion. Override with QBG_USD_TO_INR. Matches the deck ($1≈₹97). */
export const USD_TO_INR = Number(process.env.NEXT_PUBLIC_QBG_USD_TO_INR || process.env.QBG_USD_TO_INR || "97");

/** Human-readable date the prices below were last verified. Shown in the report. */
export const PRICING_AS_OF = "2026-06-05";

export interface ModelPrice {
    /** USD per 1,000,000 input (prompt) tokens. */
    input: number;
    /** USD per 1,000,000 output (completion) tokens. */
    output: number;
}

/**
 * Maintained price table — USD per 1M tokens. Keys are model-name fragments;
 * the matcher normalises away separators/casing and does longest-substring
 * matching, so one key (e.g. "claude-sonnet-4.5") covers dated variants
 * ("claude-sonnet-4-5-20250929"). Order does not matter; the matcher sorts by
 * normalised length so the most specific key wins.
 *
 * Prices verified 2026-05-30 from public pricing pages / comparison trackers.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
    // ── OpenAI ──────────────────────────────────────────────────────────
    "gpt-5.5": { input: 5.0, output: 30.0 },
    "gpt-5.2": { input: 1.75, output: 14.0 },
    "gpt-5-mini": { input: 0.25, output: 2.0 },
    "gpt-5-nano": { input: 0.05, output: 0.4 },
    "gpt-5": { input: 1.25, output: 10.0 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "o4-mini": { input: 1.1, output: 4.4 },
    "o3-mini": { input: 1.1, output: 4.4 },
    "o3": { input: 2.0, output: 8.0 },

    // ── Anthropic ───────────────────────────────────────────────────────
    "claude-opus-4.6": { input: 5.0, output: 25.0 },
    "claude-opus-4": { input: 5.0, output: 25.0 },
    "claude-sonnet-4.6": { input: 3.0, output: 15.0 },
    "claude-sonnet-4.5": { input: 3.0, output: 15.0 },
    "claude-sonnet-4": { input: 3.0, output: 15.0 },
    "claude-3.7-sonnet": { input: 3.0, output: 15.0 },
    "claude-3-7-sonnet": { input: 3.0, output: 15.0 },
    "claude-3.5-sonnet": { input: 3.0, output: 15.0 },
    "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "claude-haiku-4.5": { input: 1.0, output: 5.0 },
    "claude-3.5-haiku": { input: 0.8, output: 4.0 },
    "claude-3-5-haiku": { input: 0.8, output: 4.0 },
    "claude-3-haiku": { input: 0.25, output: 1.25 },
    "claude-3-opus": { input: 15.0, output: 75.0 },
    // family fallbacks (least specific)
    "claude-opus": { input: 5.0, output: 25.0 },
    "claude-sonnet": { input: 3.0, output: 15.0 },
    "claude-haiku": { input: 1.0, output: 5.0 },

    // ── Google Gemini ───────────────────────────────────────────────────
    "gemini-3.1-pro": { input: 2.0, output: 12.0 },
    "gemini-3-pro": { input: 2.0, output: 12.0 },
    "gemini-3.5-flash": { input: 0.5, output: 3.0 },
    "gemini-3-flash": { input: 0.5, output: 3.0 },
    "gemini-2.5-pro": { input: 1.25, output: 10.0 },
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5 },
    "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
    "gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "gemini-1.5-pro": { input: 1.25, output: 5.0 },
    "gemini-1.5-flash": { input: 0.075, output: 0.3 },

    // ── xAI Grok ────────────────────────────────────────────────────────
    "grok-4": { input: 3.0, output: 15.0 },
    "grok-3-mini": { input: 0.3, output: 0.5 },
    "grok-3": { input: 3.0, output: 15.0 },
    "grok-2": { input: 2.0, output: 10.0 },

    // ── Misc open models (commonly via Groq / Fireworks / OpenRouter) ───
    "llama-3.3-70b": { input: 0.59, output: 0.79 },
    "llama-3.1-8b": { input: 0.05, output: 0.08 },
    // DeepSeek — OpenRouter IDs vary a lot (deepseek/deepseek-chat,
    // deepseek/deepseek-chat-v3.1, deepseek/deepseek-r1-0528, deepseek-reasoner).
    // Specific variants first, then a family fallback so EVERY deepseek model
    // is priced rather than showing "price n/a".
    "deepseek-v3.2": { input: 0.27, output: 0.42 },
    "deepseek-v3.1": { input: 0.27, output: 1.0 },
    "deepseek-v3": { input: 0.27, output: 1.1 },
    "deepseek-r1": { input: 0.55, output: 2.19 },
    "deepseek-reasoner": { input: 0.55, output: 2.19 },
    "deepseek-chat": { input: 0.27, output: 1.1 },
    "deepseek": { input: 0.27, output: 1.1 }, // family fallback (least specific)

    // ── OpenRouter-hosted models ────────────────────────────────────────
    // The matcher strips the provider prefix and matches the LAST path
    // segment, so "openrouter/minimax/minimax-m3" matches on "minimax-m3".
    // MiniMax
    "minimax-m3": { input: 0.3, output: 1.65 },
    "minimax-m2": { input: 0.3, output: 1.2 },
    "minimax-01": { input: 0.2, output: 1.1 },
    "minimax": { input: 0.3, output: 1.2 },
    // Qwen
    "qwen3.6-flash": { input: 0.05, output: 0.4 },
    "qwen3-max": { input: 1.2, output: 6.0 },
    "qwen3-235b": { input: 0.2, output: 0.85 },
    "qwen3-72b": { input: 0.35, output: 0.4 },
    "qwen3-32b": { input: 0.1, output: 0.3 },
    "qwen3-coder": { input: 0.22, output: 0.95 },
    "qwen-2.5-72b": { input: 0.35, output: 0.4 },
    "qwen2.5-72b": { input: 0.35, output: 0.4 },
    "qwen3-flash": { input: 0.05, output: 0.4 },
    "qwen3": { input: 0.1, output: 0.3 },
    "qwen": { input: 0.2, output: 0.6 },
    // Other popular OpenRouter open models
    "mistral-large": { input: 2.0, output: 6.0 },
    "mistral-small": { input: 0.2, output: 0.6 },
    "mixtral-8x7b": { input: 0.24, output: 0.24 },
    "kimi-k2": { input: 0.55, output: 2.2 },
    // GLM (Zhipu / z-ai) — variants: z-ai/glm-4.6, z-ai/glm-4.5-air, etc.
    "glm-4.7": { input: 0.4, output: 1.75 },
    "glm-4.6": { input: 0.4, output: 1.75 },
    "glm-4.5-air": { input: 0.2, output: 1.1 },
    "glm-4.5": { input: 0.35, output: 1.5 },
    "glm": { input: 0.4, output: 1.75 }, // family fallback (least specific)
    "gemma-3-27b": { input: 0.1, output: 0.2 },
    "gemma-2-27b": { input: 0.1, output: 0.2 },
    "gemma-3": { input: 0.1, output: 0.2 },
    "gemma-2": { input: 0.1, output: 0.2 },
    "gemma": { input: 0.1, output: 0.2 },
    "nemotron-70b": { input: 0.35, output: 0.4 },
    "nemotron": { input: 0.35, output: 0.4 },
    "command-r-plus": { input: 2.5, output: 10.0 },
    "command-r": { input: 0.15, output: 0.6 },
    "command-a": { input: 2.5, output: 10.0 },

    // ── Amazon Nova (often via OpenRouter / Bedrock) ────────────────────
    "nova-premier": { input: 2.5, output: 12.5 },
    "nova-pro": { input: 0.8, output: 3.2 },
    "nova-lite": { input: 0.06, output: 0.24 },
    "nova-micro": { input: 0.035, output: 0.14 },
    "nova": { input: 0.8, output: 3.2 }, // family fallback

    // ── Xiaomi MiMo / other newer OpenRouter models ─────────────────────
    "mimo-v2.5": { input: 0.3, output: 1.2 },
    "mimo": { input: 0.3, output: 1.2 },

    // ── Meta Llama (Groq / Fireworks / OpenRouter / NVIDIA) ─────────────
    "llama-4-behemoth": { input: 1.0, output: 3.0 },
    "llama-4-maverick": { input: 0.2, output: 0.85 },
    "llama-4-scout": { input: 0.11, output: 0.34 },
    "llama-4": { input: 0.2, output: 0.85 },
    "llama-3.1-405b": { input: 0.9, output: 0.9 },
    "llama-3.1-70b": { input: 0.59, output: 0.79 },
    "llama-3.3": { input: 0.59, output: 0.79 },
    "llama-3.1": { input: 0.2, output: 0.3 },
    "llama-3": { input: 0.2, output: 0.3 },
    "llama": { input: 0.2, output: 0.3 }, // family fallback

    // ── Mistral family fallbacks ────────────────────────────────────────
    "mistral-large-2": { input: 2.0, output: 6.0 },
    "mistral": { input: 0.2, output: 0.6 }, // family fallback

    // ── OpenAI open-weight / GPT family fallbacks ───────────────────────
    "gpt-oss-120b": { input: 0.15, output: 0.6 },
    "gpt-oss-20b": { input: 0.05, output: 0.2 },
    "gpt-oss": { input: 0.1, output: 0.4 },
    "gpt-4": { input: 2.5, output: 10.0 }, // family fallback for any gpt-4*
    "gpt": { input: 1.25, output: 10.0 }, // last-resort gpt family
};

/**
 * Per-provider fallback pricing — used when a model ID matches NO key in the
 * table above. Keeps the report from ever showing "price n/a"; the numbers are
 * deliberately mid-range estimates for that provider's typical model. Marked
 * as an approximation in the report footnote.
 */
export const PROVIDER_FALLBACK_PRICING: Record<string, ModelPrice> = {
    openai: { input: 2.5, output: 10.0 },
    anthropic: { input: 3.0, output: 15.0 },
    gemini: { input: 1.25, output: 5.0 },
    grok: { input: 3.0, output: 15.0 },
    openrouter: { input: 0.5, output: 1.5 },
    groq: { input: 0.3, output: 0.6 },
    nvidia: { input: 0.3, output: 0.6 },
    fireworks: { input: 0.3, output: 0.9 },
    custom_openai: { input: 1.0, output: 3.0 },
    // Runs on the user's own machine against upstream endpoints it does not
    // bill for, so there is no per-token price to report.
    g4f: { input: 0, output: 0 },
    local: { input: 0.0, output: 0.0 }, // self-hosted — no API cost
};

/** Strip separators/casing so "claude-3-5-sonnet" and "Claude 3.5 Sonnet" match. */
function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Pre-sort keys by normalised length (desc) so the most specific key wins.
const SORTED_KEYS: { key: string; norm: string }[] = Object.keys(MODEL_PRICING)
    .map((key) => ({ key, norm: normalize(key) }))
    .sort((a, b) => b.norm.length - a.norm.length);

/**
 * Look up the per-1M price for a model. `provider` is currently unused for
 * matching (the model ID is specific enough) but kept for future per-provider
 * overrides. Returns null if the model isn't in the table.
 */
export function lookupModelPrice(provider: string, modelId: string): ModelPrice | null {
    const norm = normalize(modelId.includes("/") ? modelId.split("/").pop()! : modelId);
    for (const { key, norm: keyNorm } of SORTED_KEYS) {
        if (keyNorm && norm.includes(keyNorm)) return MODEL_PRICING[key];
    }
    // No exact/substring match — fall back to a per-provider mid-range estimate
    // so the report shows an approximate cost rather than "price n/a".
    const fb = PROVIDER_FALLBACK_PRICING[(provider || "").toLowerCase()];
    return fb ?? null;
}

export interface TokenCost {
    inputTokens: number;
    outputTokens: number;
    /** Price used (per 1M), or null if model not in the table. */
    price: ModelPrice | null;
    /** Cost in USD; 0 if unpriced. */
    costUsd: number;
    /** Cost in INR; 0 if unpriced. */
    costInr: number;
    /** True when a price was found. */
    priced: boolean;
}

/** Compute the USD + INR cost for a single model's token totals. */
export function computeTokenCost(
    provider: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number
): TokenCost {
    const price = lookupModelPrice(provider, modelId);
    const costUsd = price
        ? (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output
        : 0;
    return {
        inputTokens,
        outputTokens,
        price,
        costUsd,
        costInr: costUsd * USD_TO_INR,
        priced: !!price,
    };
}

/**
 * One agent's (QC1 / QC2 / QC3 / Aggregator) accumulated token usage. Tracked
 * separately from the per-model rollup so the report can show tokens and ₹ cost
 * for EACH agent individually, even when two agents share the same model.
 */
export interface AgentTokenUsage {
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
}

/** One model's accumulated usage as stored on the job. */
export interface ModelTokenUsage {
    provider: string;
    modelId: string;
    /** Agent labels that used this model (e.g. ["QC1", "Aggregator"]). */
    labels: string[];
    inputTokens: number;
    outputTokens: number;
    calls: number;
}

export interface CostRow extends ModelTokenUsage, TokenCost {
    totalTokens: number;
}

export interface CostSummary {
    rows: CostRow[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    totalCostInr: number;
    /** True if any model in the run had no price in the table. */
    hasUnpriced: boolean;
    usdToInr: number;
    pricedAsOf: string;
}

/**
 * Turn the job's per-model usage map into a costed, sorted summary for the
 * report/exports. Most expensive model first.
 */
export function buildCostSummary(
    usage: Record<string, ModelTokenUsage> | undefined | null
): CostSummary {
    const rows: CostRow[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let hasUnpriced = false;

    for (const u of Object.values(usage || {})) {
        const cost = computeTokenCost(u.provider, u.modelId, u.inputTokens, u.outputTokens);
        if (!cost.priced) hasUnpriced = true;
        totalInputTokens += u.inputTokens;
        totalOutputTokens += u.outputTokens;
        totalCostUsd += cost.costUsd;
        rows.push({
            ...u,
            ...cost,
            totalTokens: u.inputTokens + u.outputTokens,
        });
    }

    rows.sort((a, b) => b.costInr - a.costInr || b.totalTokens - a.totalTokens);

    return {
        rows,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCostUsd,
        totalCostInr: totalCostUsd * USD_TO_INR,
        hasUnpriced,
        usdToInr: USD_TO_INR,
        pricedAsOf: PRICING_AS_OF,
    };
}

/** Format a ₹ amount compactly for the report (e.g. ₹12.34, ₹1,234.50). */
export function formatInr(amount: number): string {
    return "₹" + amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a token count with thousands separators. */
export function formatTokens(n: number): string {
    return n.toLocaleString("en-IN");
}
