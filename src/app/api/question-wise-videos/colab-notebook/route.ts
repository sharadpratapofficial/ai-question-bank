/**
 * GET /api/question-wise-videos/colab-notebook?driveUrl=...&wantClips=true|false
 *
 * Generates a ready-to-run Google Colab notebook for the detect(+crop)
 * pipeline, embedding this app's own (already-validated) Python module
 * source. If the caller has Google Drive connected (src/lib/googleDrive.ts),
 * the notebook is uploaded there too and a one-click
 * colab.research.google.com/drive/<id> URL is returned instead of a raw
 * file, skipping the manual "upload notebook to Colab" step.
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkPermission } from "@/lib/auth/serverAuth";
import { createClient } from "@/lib/supabase/server";
import { parseGoogleDriveProviderConfig, sanitizeUserApiKeys, stringifyGoogleDriveProviderConfig } from "@/lib/userApiKeys";
import { refreshAccessToken, ensureFolder, uploadFile } from "@/lib/googleDrive";
import { looksLikeDriveUrl } from "@/lib/api/questionWiseVideos";
import { buildColabNotebook } from "@/lib/colabNotebook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PYTHON_DIR = path.resolve(process.cwd(), "python", "question_wise_videos");
const DRIVE_ROOT_FOLDER_NAME = "Question Wise Videos";

export async function GET(request: NextRequest) {
    const forbid = await checkPermission("use_question_wise_videos");
    if (forbid) return forbid;

    const driveUrl = (request.nextUrl.searchParams.get("driveUrl") || "").trim();
    const accuracy = request.nextUrl.searchParams.get("accuracy") === "high" ? "high" : "fast";
    if (!driveUrl || !looksLikeDriveUrl(driveUrl)) {
        return NextResponse.json(
            { success: false, error: "driveUrl (a Google Drive share link) is required." },
            { status: 400 }
        );
    }

    const [detectBoundariesSource, driveDownloadSource] = await Promise.all([
        fs.readFile(path.join(PYTHON_DIR, "detect_boundaries.py"), "utf8"),
        fs.readFile(path.join(PYTHON_DIR, "drive_download.py"), "utf8"),
    ]);

    const notebook = buildColabNotebook({
        driveUrl,
        accuracy,
        detectBoundariesSource,
        driveDownloadSource,
    });
    const notebookBytes = Buffer.from(JSON.stringify(notebook, null, 1), "utf8");

    // If Drive is connected, upload the notebook itself and hand back a
    // direct "open in Colab" link instead of a raw download.
    try {
        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (user) {
            const apiKeys = sanitizeUserApiKeys(user.user_metadata?.api_keys);
            const driveConfig = parseGoogleDriveProviderConfig(apiKeys.google_drive);
            if (driveConfig.refreshToken) {
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

                const fileName = `question-wise-videos-${Date.now()}.ipynb`;
                const { id: fileId } = await uploadFile(accessToken, {
                    name: fileName,
                    mimeType: "application/vnd.google.colaboratory",
                    bytes: notebookBytes,
                    parentId: rootFolderId,
                });
                return NextResponse.json({
                    success: true,
                    colabUrl: `https://colab.research.google.com/drive/${fileId}`,
                });
            }
        }
    } catch (err) {
        // Fall through to a plain download — the user still gets the
        // notebook, just without the one-click Drive-linked open.
        console.error("[colab-notebook] Drive upload failed, falling back to direct download:", err);
    }

    return new NextResponse(new Uint8Array(notebookBytes), {
        status: 200,
        headers: {
            "Content-Type": "application/x-ipynb+json",
            "Content-Disposition": 'attachment; filename="question-wise-videos.ipynb"',
        },
    });
}
