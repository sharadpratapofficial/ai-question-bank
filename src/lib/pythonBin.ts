/**
 * Resolves the Python interpreter used to run the sidecars.
 *
 * Every sidecar used to do `process.env.QBG_PYTHON || "python"`, which fails in
 * two ways that both showed up in practice:
 *
 *   1. If the server process didn't get `.env.local` (started from another
 *      working directory, e.g. an autostart shortcut), `QBG_PYTHON` is undefined
 *      and Node tries to spawn the literal name `python`. When that isn't on
 *      PATH the job dies with a bare `spawn python ENOENT`.
 *   2. Worse, when a `python` *is* on PATH it is often the wrong one — a virtualenv
 *      belonging to some other tool, without python-docx / pypandoc — so the job
 *      fails later with a confusing ModuleNotFoundError instead.
 *
 * So resolution no longer relies on the environment being right: it probes real
 * filesystem locations, verifies the candidate actually runs, and caches the
 * answer. `QBG_PYTHON` still wins when it points at something that exists.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

let cached: string | null = null;
let cachedAttempts: string[] = [];

/** True if `bin` runs and reports a Python version. */
function works(bin: string): boolean {
    try {
        const r = spawnSync(bin, ["--version"], { timeout: 8000, windowsHide: true });
        if (r.error || r.status !== 0) return false;
        const out = `${r.stdout || ""}${r.stderr || ""}`;
        return /Python\s+3\./i.test(out);
    } catch {
        return false;
    }
}

/** QBG_PYTHON from the environment, or read straight out of .env.local. */
function configuredPython(): string | null {
    const fromEnv = (process.env.QBG_PYTHON || "").trim();
    if (fromEnv) return fromEnv;

    // The env file may simply not have been loaded (wrong working directory).
    // Reading it directly costs nothing and rescues that case.
    for (const dir of [process.cwd(), path.resolve(process.cwd(), "..")]) {
        for (const name of [".env.local", ".env"]) {
            const file = path.join(dir, name);
            try {
                if (!existsSync(file)) continue;
                const line = readFileSync(file, "utf8")
                    .split(/\r?\n/)
                    .find((l) => /^\s*QBG_PYTHON\s*=/.test(l));
                if (!line) continue;
                const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
                if (value) return value;
            } catch {
                /* unreadable env file — keep probing */
            }
        }
    }
    return null;
}

/** Python installs in the usual per-user locations, newest version first. */
function installedCandidates(): string[] {
    const out: string[] = [];
    const local = process.env.LOCALAPPDATA;
    const roots = [
        local ? path.join(local, "Python") : null,
        local ? path.join(local, "Programs", "Python") : null,
        "C:\\Python",
        "C:\\Program Files\\Python",
    ].filter(Boolean) as string[];

    for (const root of roots) {
        try {
            if (!existsSync(root)) continue;
            const entries = readdirSync(root)
                .filter((d) => /python|pythoncore/i.test(d))
                .sort()
                .reverse(); // newest version first
            for (const d of entries) {
                const exe = path.join(root, d, "python.exe");
                if (existsSync(exe)) out.push(exe);
            }
        } catch {
            /* unreadable directory — skip it */
        }
    }
    return out;
}

/** Logged once, so the server's output records which interpreter the sidecars use. */
function announce(bin: string): void {
    try {
        console.info(`[pythonBin] sidecars will run: ${bin}`);
    } catch {
        /* logging must never break resolution */
    }
}

/**
 * The interpreter to run sidecars with. Throws a message naming everything it
 * tried if nothing usable is found, which is far more actionable than ENOENT.
 */
export function resolvePythonBin(): string {
    if (cached) return cached;

    const attempts: string[] = [];
    const configured = configuredPython();

    if (configured) {
        attempts.push(`QBG_PYTHON=${configured}`);
        // An absolute path only needs to exist; a bare name has to be runnable.
        const isPathLike = configured.includes("/") || configured.includes("\\");
        if (isPathLike ? existsSync(configured) : works(configured)) {
            cached = configured;
            cachedAttempts = attempts;
            announce(cached);
            return cached;
        }
    }

    for (const exe of installedCandidates()) {
        attempts.push(exe);
        if (works(exe)) {
            cached = exe;
            cachedAttempts = attempts;
            announce(cached);
            return cached;
        }
    }

    // PATH last: it is the most likely to point at some other tool's virtualenv.
    for (const name of ["py", "python3", "python"]) {
        attempts.push(`${name} (PATH)`);
        if (works(name)) {
            cached = name;
            cachedAttempts = attempts;
            announce(cached);
            return cached;
        }
    }

    cachedAttempts = attempts;
    throw new Error(
        "No usable Python 3 interpreter found. Set QBG_PYTHON in .env.local to the " +
            "full path of python.exe and restart the server. Tried: " +
            attempts.join(", ")
    );
}

/** Same as resolvePythonBin but returns null instead of throwing. */
export function tryResolvePythonBin(): string | null {
    try {
        return resolvePythonBin();
    } catch {
        return null;
    }
}

/** What resolution tried — for diagnostics in error messages. */
export function pythonResolutionAttempts(): string[] {
    return [...cachedAttempts];
}

/** Testing hook: drop the memoised interpreter. */
export function resetPythonBinCache(): void {
    cached = null;
    cachedAttempts = [];
}
