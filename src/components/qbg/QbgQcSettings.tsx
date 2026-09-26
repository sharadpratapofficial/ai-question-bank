"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
    getProviderApiCredential,
    readDevApiKeysFromStorage,
    type SupportedApiProvider,
} from "@/lib/userApiKeys";
import {
    AI_PROVIDER_LABELS,
    AI_PROVIDER_MODELS,
    type AIModelProvider,
    type ModelOption,
} from "@/types/extraction";
import { sortByVision, visionLabel, visionSupport, VISION_COLOR } from "@/lib/visionModels";

/**
 * "QC before pushing" — the opt-in, and the model that will do it.
 *
 * The model picker is not the ordinary one. QC sends each question's FIGURE to
 * the model as an image, because the commonest defect in a reframed question is
 * the diagram disagreeing with the words — and a text-only model cannot see that
 * at all. So every model is labelled with whether it can read a diagram, the
 * ones that can are listed first, and picking one that cannot earns a warning
 * rather than silent uselessness.
 *
 * Shared by QBG Modification and the QBG Pipeline so the two cannot drift.
 */

export interface QcConfig {
    enabled: boolean;
    provider: AIModelProvider;
    modelId: string;
}

const card: React.CSSProperties = {
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    background: "var(--bg-secondary)",
    padding: 16,
};

export default function QbgQcSettings({
    value,
    onChange,
    compact,
}: {
    value: QcConfig;
    onChange: (next: QcConfig) => void;
    /** Tighter type sizes, for the Pipeline's denser stage list. */
    compact?: boolean;
}) {
    const [models, setModels] = useState<ModelOption[]>(AI_PROVIDER_MODELS[value.provider] || []);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const reqRef = useRef(0);

    const loadModels = useCallback(async (prov: AIModelProvider) => {
        const reqId = ++reqRef.current;
        setLoading(true);
        setLoadError(null);
        try {
            const headers: Record<string, string> = {};
            if (typeof document !== "undefined" && document.cookie.includes("qbg_dev_auth=1")) {
                const devKeys = readDevApiKeysFromStorage();
                const cred = getProviderApiCredential(
                    prov as SupportedApiProvider,
                    devKeys[prov as SupportedApiProvider] || ""
                );
                if (cred) headers["x-dev-api-key"] = cred;
            }
            const res = await fetch(`/api/ai-tools/models?provider=${prov}`, { headers, cache: "no-store" });
            const payload = (await res.json()) as { success?: boolean; models?: ModelOption[]; error?: string };
            if (!res.ok || !payload.success || !Array.isArray(payload.models) || payload.models.length === 0) {
                throw new Error(payload.error || "Could not load live models.");
            }
            if (reqRef.current !== reqId) return;
            setModels(payload.models);
        } catch (err) {
            if (reqRef.current !== reqId) return;
            setModels(AI_PROVIDER_MODELS[prov] || []);
            setLoadError(
                (err instanceof Error ? err.message : "Could not load live models.") +
                    " Showing the built-in list."
            );
        } finally {
            if (reqRef.current === reqId) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!value.enabled) return;
        void loadModels(value.provider);
    }, [value.enabled, value.provider, loadModels]);

    // Keep the chosen model inside the loaded list, preferring one that can see.
    useEffect(() => {
        if (!value.enabled || models.length === 0) return;
        if (models.some((m) => m.id === value.modelId)) return;
        const best = sortByVision(value.provider, models)[0];
        if (best) onChange({ ...value, modelId: best.id });
        // onChange identity is not stable in the parents; the guard above makes
        // this idempotent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [models, value.enabled, value.provider]);

    const sorted = sortByVision(value.provider, models);
    const support = visionSupport(value.provider, value.modelId);
    const label = compact ? "0.8rem" : "0.85rem";

    return (
        <div style={card}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                    type="checkbox"
                    checked={value.enabled}
                    onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
                />
                <ShieldCheck size={15} color="var(--accent-primary)" />
                <span style={{ fontSize: label, fontWeight: 600, color: "var(--text-primary)" }}>
                    QC each question with AI before pushing, and apply its corrections
                </span>
            </label>

            {!value.enabled && (
                <div style={{ marginTop: 6, marginLeft: 23, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                    Off: questions go to QBG exactly as the reframe produced them.
                </div>
            )}

            {value.enabled && (
                <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                    <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                        Each question is re-solved from scratch, then its answer, options, solution,
                        data and <b>figure</b> are checked against one another. What is wrong is
                        corrected in place — and the report shows the before and after, so you can see
                        exactly what QC did.
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                        <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                QC provider
                            </span>
                            <select
                                value={value.provider}
                                onChange={(e) =>
                                    onChange({ ...value, provider: e.target.value as AIModelProvider, modelId: "" })
                                }
                                style={selectStyle}
                            >
                                {(Object.keys(AI_PROVIDER_MODELS) as AIModelProvider[]).map((p) => (
                                    <option key={p} value={p}>
                                        {AI_PROVIDER_LABELS[p] || p}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                                QC model{" "}
                                <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>
                                    — diagram readers first
                                </span>
                            </span>
                            <div style={{ display: "flex", gap: 6 }}>
                                <select
                                    value={value.modelId}
                                    onChange={(e) => onChange({ ...value, modelId: e.target.value })}
                                    style={{ ...selectStyle, flex: 1 }}
                                >
                                    {!sorted.some((m) => m.id === value.modelId) && value.modelId && (
                                        <option value={value.modelId}>{value.modelId}</option>
                                    )}
                                    {sorted.map((m) => {
                                        const v = visionSupport(value.provider, m.id);
                                        const mark = v === "yes" ? "✓ " : v === "no" ? "✕ " : "? ";
                                        return (
                                            <option key={m.id} value={m.id}>
                                                {mark}
                                                {m.label || m.id}
                                                {v === "yes" ? " — reads diagrams" : v === "no" ? " — text only" : ""}
                                            </option>
                                        );
                                    })}
                                </select>
                                <button
                                    type="button"
                                    onClick={() => void loadModels(value.provider)}
                                    title="Reload this provider's model list"
                                    style={{
                                        border: "1px solid var(--border-primary)",
                                        borderRadius: 8,
                                        background: "var(--bg-tertiary)",
                                        color: "var(--text-secondary)",
                                        width: 34,
                                        cursor: "pointer",
                                        display: "grid",
                                        placeItems: "center",
                                    }}
                                >
                                    {loading ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <RefreshCw size={14} />
                                    )}
                                </button>
                            </div>
                        </label>
                    </div>

                    <div
                        style={{
                            fontSize: "0.74rem",
                            color: VISION_COLOR[support],
                            fontWeight: support === "yes" ? 500 : 600,
                        }}
                    >
                        {support === "yes" && <>✓ This model can see the figure — {visionLabel(support)}.</>}
                        {support === "no" && (
                            <>
                                ✕ This model is {visionLabel(support)}. It will still check the wording,
                                the options, the answer and the solution — but it cannot catch a diagram
                                that contradicts the question, which is the most common defect. Pick a
                                model marked ✓.
                            </>
                        )}
                        {support === "unknown" && (
                            <>
                                ? This model&rsquo;s image support is {visionLabel(support)}. If the QC report
                                says it never saw a figure, choose one marked ✓.
                            </>
                        )}
                    </div>

                    {loadError && (
                        <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>{loadError}</div>
                    )}
                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                        One extra AI call per question. Its key comes from your saved keys for the
                        provider above.
                    </div>
                </div>
            )}
        </div>
    );
}

const selectStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.85rem",
    padding: "8px 10px",
    outline: "none",
};
