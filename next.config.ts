import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const buildBaseConfig = (): NextConfig => ({
    // Dev server is reached through the public Cloudflare tunnel hostname, not
    // localhost, so allow that origin to fetch /_next/* HMR + chunk resources.
    // (Dev-only setting; ignored by `next start`.)
    allowedDevOrigins: ["aiqb.loveemittal.online"],
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "static.pw.live",
            },
            {
                protocol: "https",
                hostname: "d1d34p8vz63oiq.cloudfront.net",
            },
        ],
    },
});

export default (phase: string): NextConfig => ({
    ...buildBaseConfig(),
    // Keep dev and build artifacts separate to avoid chunk/manifest corruption
    // when `next dev` and `next build` are run in parallel.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
});
