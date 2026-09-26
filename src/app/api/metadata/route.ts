import { NextResponse } from "next/server";
import { fetchMetadataHierarchy } from "@/lib/api/questions";

// Cache metadata for 5 minutes to avoid repeated full-table scans
let cachedMetadata: Awaited<ReturnType<typeof fetchMetadataHierarchy>> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET() {
    try {
        const now = Date.now();
        if (!cachedMetadata || now - cacheTimestamp > CACHE_TTL) {
            cachedMetadata = await fetchMetadataHierarchy();
            cacheTimestamp = now;
        }

        return NextResponse.json(cachedMetadata);
    } catch (err) {
        console.error("API /metadata error:", err);
        return NextResponse.json(
            { error: "Failed to fetch metadata", details: String(err) },
            { status: 500 }
        );
    }
}
