import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseUrl, getSupabasePublishableKey } from "./env";

export function createClient() {
    return createBrowserClient(
        getSupabaseUrl(),
        getSupabasePublishableKey()
    );
}
