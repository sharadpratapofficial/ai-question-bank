/**
 * Test-only preload (node --import) for CLI tests. Never used by the importer itself.
 *   NEWBANK_TEST_SUPABASE=forbid  loading @supabase/supabase-js throws (proves a run never reaches the DB client)
 *   NEWBANK_TEST_SUPABASE=fake    @supabase/supabase-js resolves to ./fake-supabase.mjs (file-backed, no network)
 * Network is blocked in both modes.
 */
import { registerHooks } from "node:module";

const mode = process.env.NEWBANK_TEST_SUPABASE;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "@supabase/supabase-js") {
            if (mode === "fake") return { url: new URL("./fake-supabase.mjs", import.meta.url).href, shortCircuit: true };
            throw new Error("TEST GUARD: @supabase/supabase-js was loaded");
        }
        return next(specifier, context);
    },
});
globalThis.fetch = () => { throw new Error("TEST GUARD: network access attempted"); };
