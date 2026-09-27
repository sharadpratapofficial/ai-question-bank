/**
 * SERVER-ONLY Supabase client authenticated with the project's secret key
 * (sb_secret_… / legacy service_role). It bypasses Row Level Security.
 *
 * Use it only from API routes and server libraries that have ALREADY checked
 * the caller's permission (checkPermission / requirePermission), and from
 * background jobs that run after the response (they have no user session).
 * Anything that must act AS the user (auth.uid() in SQL, owner-scoped rows,
 * the restore RPC) uses the cookie client from ./server instead.
 *
 * The key is read from SUPABASE_SECRET_KEY, falling back to the legacy name
 * SUPABASE_SERVICE_ROLE_KEY. Neither is NEXT_PUBLIC_, so Next.js never inlines
 * it into a browser bundle; the guard below also fails loudly if this module
 * is ever evaluated in a browser.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseUrl } from "./env";

let admin: SupabaseClient | null = null;

export function isSupabaseAdminConfigured(): boolean {
    return Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Typed loosely, like the rest of the app's server clients (no generated DB types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabaseAdmin(): any {
    if (typeof window !== "undefined") {
        throw new Error("getSupabaseAdmin() must never run in the browser.");
    }
    if (!admin) {
        const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) {
            throw new Error("SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is not set; server data access is unavailable.");
        }
        admin = createClient(getSupabaseUrl(), key, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
    }
    return admin;
}
