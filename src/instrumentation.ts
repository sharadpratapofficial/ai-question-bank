/**
 * Next.js startup hook — runs once when the server boots.
 *
 * Resolves the Python interpreter up front so the choice is recorded in the
 * server log at boot rather than being discovered the first time somebody runs
 * a sidecar job. A misconfigured interpreter used to surface as a cryptic
 * `spawn python ENOENT` in the middle of an ingestion or reframe run; now it is
 * visible the moment the server starts.
 */

export async function register(): Promise<void> {
    // Only the Node runtime can spawn processes; skip the edge runtime.
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    try {
        const { tryResolvePythonBin, pythonResolutionAttempts } = await import("@/lib/pythonBin");
        const bin = tryResolvePythonBin();
        if (!bin) {
            console.error(
                "[startup] No usable Python 3 interpreter found — sidecar features " +
                    "(QBG Ingestion/Modification/Tagging, Video Solution, Question Wise Videos) " +
                    "will fail until QBG_PYTHON is set in .env.local. Tried: " +
                    pythonResolutionAttempts().join(", ")
            );
        }
    } catch (err) {
        console.error("[startup] Python interpreter check failed:", err);
    }
}
