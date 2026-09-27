/**
 * Supabase connection settings, in one place.
 *
 * Browser-safe values only. The publishable key (sb_publishable_…) is the new
 * name for what Supabase used to call the anon key; both work as the client
 * "apikey". NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is preferred and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY is still accepted so existing .env files keep
 * working. Each variable is referenced literally so Next.js can inline it into
 * client bundles.
 *
 * The server-only secret key lives in src/lib/supabase/admin.ts, never here.
 */

export function getSupabaseUrl(): string {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
    return url;
}

export function getSupabasePublishableKey(): string {
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy NEXT_PUBLIC_SUPABASE_ANON_KEY) is not set.");
    return key;
}
