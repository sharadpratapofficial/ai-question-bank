import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
    EMPTY_USER_API_KEYS,
    sanitizeUserApiKeys,
    type UserApiKeys,
} from "@/lib/userApiKeys";

interface UserApiKeysResponse {
    success: boolean;
    apiKeys: UserApiKeys;
    error?: string;
}

export async function GET() {
    try {
        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json(
                {
                    success: false,
                    apiKeys: { ...EMPTY_USER_API_KEYS },
                    error: "Unauthorized",
                } as UserApiKeysResponse,
                { status: 401 }
            );
        }

        const apiKeys = sanitizeUserApiKeys(user.user_metadata?.api_keys);

        return NextResponse.json({
            success: true,
            apiKeys,
        } as UserApiKeysResponse);
    } catch (err) {
        console.error("GET /api/user/api-keys failed:", err);
        return NextResponse.json(
            {
                success: false,
                apiKeys: { ...EMPTY_USER_API_KEYS },
                error: "Failed to load user API keys",
            } as UserApiKeysResponse,
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json(
                {
                    success: false,
                    apiKeys: { ...EMPTY_USER_API_KEYS },
                    error: "Unauthorized",
                } as UserApiKeysResponse,
                { status: 401 }
            );
        }

        const body = (await request.json()) as { apiKeys?: unknown };
        const nextApiKeys = sanitizeUserApiKeys(body.apiKeys);
        const userMetadata =
            user.user_metadata && typeof user.user_metadata === "object"
                ? user.user_metadata
                : {};

        const { data, error } = await supabase.auth.updateUser({
            data: {
                ...userMetadata,
                api_keys: nextApiKeys,
            },
        });

        if (error) {
            throw error;
        }

        const savedApiKeys = sanitizeUserApiKeys(data.user?.user_metadata?.api_keys);

        return NextResponse.json({
            success: true,
            apiKeys: savedApiKeys,
        } as UserApiKeysResponse);
    } catch (err) {
        console.error("POST /api/user/api-keys failed:", err);
        return NextResponse.json(
            {
                success: false,
                apiKeys: { ...EMPTY_USER_API_KEYS },
                error: "Failed to save user API keys",
            } as UserApiKeysResponse,
            { status: 500 }
        );
    }
}
