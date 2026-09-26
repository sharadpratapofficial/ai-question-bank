/**
 * POST /api/question-wise-videos/[id]/upload-to-drive
 *
 * Uploads a finished job's clips (or timestamps.csv, for a timestamps-only
 * job) into the caller's Google Drive, under a shared "Question Wise Videos"
 * folder with one subfolder per job. Prefers the job's still-on-disk local
 * files (same directory startCropJob wrote them into); falls back to
 * downloading + unzipping the Storage artifact if the server has since
 * restarted and the local temp dir is gone.
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { parseGoogleDriveProviderConfig, sanitizeUserApiKeys, stringifyGoogleDriveProviderConfig } from "@/lib/userApiKeys";
import { refreshAccessToken, ensureFolder, uploadFile } from "@/lib/googleDrive";
import { workDirFor } from "@/lib/api/questionWiseVideos";

export const runtime = "nodejs";
export const maxDuration = 120;

const ARTIFACT_BUCKET = "question-video-artifacts";
const DRIVE_ROOT_FOLDER_NAME = "Question Wise Videos";

interface FileToUpload {
    name: string;
    mimeType: string;
    bytes: Buffer;
}

async function collectFromLocalDisk(jobId: string, wantClips: boolean): Promise<FileToUpload[] | null> {
    const workDir = workDirFor(jobId);
    const files: FileToUpload[] = [];
    try {
        const csvBytes = await fs.readFile(path.join(workDir, "timestamps.csv"));
        files.push({ name: "timestamps.csv", mimeType: "text/csv", bytes: csvBytes });
    } catch {
        return null; // local temp dir is gone — caller falls back to Storage
    }
    if (wantClips) {
        const clipsDir = path.join(workDir, "clips");
        let entries: string[];
        try {
            entries = await fs.readdir(clipsDir);
        } catch {
            return null;
        }
        for (const name of entries.filter((n) => n.toLowerCase().endsWith(".mp4")).sort()) {
            const bytes = await fs.readFile(path.join(clipsDir, name));
            files.push({ name, mimeType: "video/mp4", bytes });
        }
        if (files.length <= 1) return null; // csv only, no clips found — treat as missing
    }
    return files;
}

async function collectFromStorage(
    supabase: Awaited<ReturnType<typeof createClient>>,
    storagePath: string
): Promise<FileToUpload[]> {
    const { data, error } = await supabase.storage.from(ARTIFACT_BUCKET).download(storagePath);
    if (error || !data) {
        throw new Error(`Could not read stored artifact: ${error?.message || "not found"}`);
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (storagePath.toLowerCase().endsWith(".csv")) {
        return [{ name: "timestamps.csv", mimeType: "text/csv", bytes }];
    }
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const files: FileToUpload[] = [];
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const entryBytes = Buffer.from(await entry.async("nodebuffer"));
        files.push({
            name,
            mimeType: name.toLowerCase().endsWith(".csv") ? "text/csv" : "video/mp4",
            bytes: entryBytes,
        });
    }
    return files;
}

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const { id } = await params;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const apiKeys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
    const driveConfig = parseGoogleDriveProviderConfig(apiKeys.google_drive);
    if (!driveConfig.refreshToken) {
        return NextResponse.json(
            { success: false, error: "Connect Google Drive first (user icon → Manage API Keys → Google Drive)." },
            { status: 400 }
        );
    }

    const { data: row, error: rowErr } = await supabase
        .from("question_video_jobs")
        .select("id, status, want_clips, video_label, source_url, crop_result, created_at")
        .eq("id", id)
        .maybeSingle();
    if (rowErr || !row) {
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
    }
    if (row.status !== "done") {
        return NextResponse.json(
            { success: false, error: `Job is not done yet (status: ${row.status}).` },
            { status: 400 }
        );
    }
    const cropResult = (row.crop_result || {}) as { storagePath?: string };

    try {
        let files = await collectFromLocalDisk(id, row.want_clips);
        if (!files) {
            if (!cropResult.storagePath) {
                throw new Error("This job has no stored artifact to upload.");
            }
            files = await collectFromStorage(supabase, cropResult.storagePath);
        }
        if (files.length === 0) {
            throw new Error("No files found to upload for this job.");
        }

        const accessToken = await refreshAccessToken(driveConfig.refreshToken);

        let rootFolderId = driveConfig.folderId;
        if (!rootFolderId) {
            rootFolderId = await ensureFolder(accessToken, DRIVE_ROOT_FOLDER_NAME);
            const userMetadata =
                user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
            const nextApiKeys = {
                ...apiKeys,
                google_drive: stringifyGoogleDriveProviderConfig({ ...driveConfig, folderId: rootFolderId }),
            };
            await supabase.auth.updateUser({ data: { ...userMetadata, api_keys: nextApiKeys } });
        }

        const dateLabel = new Date(row.created_at).toISOString().slice(0, 10);
        const jobFolderName = `${row.video_label || row.source_url.slice(0, 40)} (${dateLabel})`;
        const jobFolderId = await ensureFolder(accessToken, jobFolderName, rootFolderId);

        let uploaded = 0;
        for (const file of files) {
            await uploadFile(accessToken, { name: file.name, mimeType: file.mimeType, bytes: file.bytes, parentId: jobFolderId });
            uploaded++;
        }

        return NextResponse.json({
            success: true,
            uploadedCount: uploaded,
            folderUrl: `https://drive.google.com/drive/folders/${jobFolderId}`,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
