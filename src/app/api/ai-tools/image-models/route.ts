/**
 * GET /api/ai-tools/image-models?provider=gemini|openai
 *
 * Live image-capable model list for the QBG Modification "redraw diagrams"
 * feature — mirrors python/qbg_modification/imagegen.py's list_models()
 * filtering so the dropdown only shows models that can actually edit images
 * (Gemini "image" models with generateContent, OpenAI dall-e/gpt-image ids).
 *
 * Separate from /api/ai-tools/models (full chat-model lists used everywhere
 * else) so that route's behavior for existing callers is untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeUserApiKeys } from "@/lib/userApiKeys";

function resolveKey(req: NextRequest, userKey: string): string {
    return userKey || req.headers.get("x-dev-img-key")?.trim() || req.headers.get("x-dev-api-key")?.trim() || "";
}

export async function GET(req: NextRequest) {
    try {
        const provider = new URL(req.url).searchParams.get("provider");
        if (provider !== "gemini" && provider !== "openai") {
            return NextResponse.json(
                { success: false, error: "provider must be 'gemini' or 'openai'." },
                { status: 400 }
            );
        }

        let userKey = "";
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            userKey = sanitizeUserApiKeys(user.user_metadata?.api_keys)[provider] || "";
        }
        const apiKey = resolveKey(req, userKey);
        if (!apiKey) {
            return NextResponse.json(
                { success: false, error: `No API key found for ${provider}. Add it from the user icon → Manage API Keys.` },
                { status: 400 }
            );
        }

        if (provider === "gemini") {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
                { cache: "no-store" }
            );
            if (!response.ok) {
                throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);
            }
            const data = await response.json();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawModels: any[] = Array.isArray(data?.models) ? data.models : [];
            const models = rawModels
                .map((m) => {
                    const id = String(m.name || "").replace("models/", "");
                    const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                    return { id, label: m.displayName || id, methods };
                })
                .filter((m) => m.id.toLowerCase().includes("image") && m.methods.includes("generateContent"))
                .map((m) => ({ id: m.id, label: m.label }));
            models.sort((a, b) => a.label.localeCompare(b.label));
            if (models.length === 0) {
                return NextResponse.json(
                    { success: false, error: "No image-capable Gemini models found on this key." },
                    { status: 404 }
                );
            }
            return NextResponse.json({ success: true, models });
        }

        // openai
        const response = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(`OpenAI returned ${response.status}: ${await response.text()}`);
        }
        const data = await response.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawIds: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => String(m.id)) : [];
        const models = rawIds
            .filter((id) => id.toLowerCase().includes("dall-e") || id.toLowerCase().includes("image"))
            .map((id) => ({ id, label: id }));
        models.sort((a, b) => a.label.localeCompare(b.label));
        if (models.length === 0) {
            return NextResponse.json(
                { success: false, error: "No image-capable OpenAI models found on this key." },
                { status: 404 }
            );
        }
        return NextResponse.json({ success: true, models });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}
