"use client";

import { useRouter } from "next/navigation";
import { Video } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import VideoSolutionPageContent from "@/components/video-solution/VideoSolutionPageContent";

export default function VideoSolutionPage() {
    return (
        <RequirePermission permission="use_video_solution">
            <VideoSolutionPageInner />
        </RequirePermission>
    );
}

function VideoSolutionPageInner() {
    const router = useRouter();

    const handleTabChange = (t: string) => {
        if (t === "questions") router.push("/questions");
        else if (t === "tests") router.push("/tests");
        else if (t === "analytics") router.push("/analytics");
        else if (t === "upload") router.push("/upload");
        else if (t === "ai") router.push("/ai-tools");
        else if (t === "admin") router.push("/admin/users");
        else if (t === "agentic-qc") router.push("/agentic-qc");
        else if (t === "qbg") router.push("/qbg");
        else if (t === "question-wise-videos") router.push("/question-wise-videos");
        else if (t === "circuit-designer") router.push("/circuit-designer");
        // "video-solution" is already this page — no navigation needed.
    };

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar activeTab="video-solution" onTabChange={handleTabChange} />

            <main style={{ flex: 1, padding: "28px 32px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 11,
                            background: "linear-gradient(135deg,#f59e0b,#f97316)",
                            display: "grid",
                            placeItems: "center",
                            color: "#fff",
                        }}
                    >
                        <Video size={20} />
                    </div>
                    <div>
                        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800, color: "var(--text-primary)" }}>
                            Video Solution
                        </h1>
                        <p style={{ margin: "2px 0 0", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                            Turn a question paper into narrated solution videos or a slide deck.
                        </p>
                    </div>
                </div>

                <VideoSolutionPageContent />
            </main>
        </div>
    );
}
