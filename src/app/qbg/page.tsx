"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wand2, Upload, Tags, Sparkles, Workflow } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import QbgModifierPanel from "@/components/qbg/QbgModifierPanel";
import QbgIngestionPanel from "@/components/qbg/QbgIngestionPanel";
import QbgTaggingPanel from "@/components/qbg/QbgTaggingPanel";
import QbgPipelinePanel from "@/components/qbg/QbgPipelinePanel";

type QbgTab = "modifier" | "ingestion" | "tagging" | "pipeline";

interface TabDef {
    id: QbgTab;
    label: string;
    icon: React.ReactNode;
}

const TABS: TabDef[] = [
    { id: "pipeline", label: "QBG Pipeline", icon: <Workflow size={15} /> },
    { id: "modifier", label: "QBG Modifier", icon: <Wand2 size={15} /> },
    { id: "ingestion", label: "QBG Ingestion", icon: <Upload size={15} /> },
    { id: "tagging", label: "QBG Tagging", icon: <Tags size={15} /> },
];

export default function QbgHubPage() {
    return (
        <RequirePermission permission="use_qbg">
            <QbgHubInner />
        </RequirePermission>
    );
}

function QbgHubInner() {
    const router = useRouter();
    const [tab, setTab] = useState<QbgTab>("pipeline");

    const handleTabChange = (t: string) => {
        if (t === "questions") router.push("/questions");
        else if (t === "tests") router.push("/tests");
        else if (t === "analytics") router.push("/analytics");
        else if (t === "upload") router.push("/upload");
        else if (t === "ai") router.push("/ai-tools");
        else if (t === "admin") router.push("/admin/users");
        else if (t === "agentic-qc") router.push("/agentic-qc");
        else if (t === "video-solution") router.push("/video-solution");
        else if (t === "question-wise-videos") router.push("/question-wise-videos");
        else if (t === "circuit-designer") router.push("/circuit-designer");
        // "qbg" is already this page — no navigation needed.
    };

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar activeTab="qbg" onTabChange={handleTabChange} />

            <main style={{ flex: 1, padding: "28px 32px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
                {/* Page header */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 11,
                            background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                            display: "grid",
                            placeItems: "center",
                            color: "#fff",
                        }}
                    >
                        <Sparkles size={20} />
                    </div>
                    <div>
                        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800, color: "var(--text-primary)" }}>
                            QBG
                        </h1>
                        <p style={{ margin: "2px 0 0", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                            AI-powered tools built around the QBG (PenPencil) question bank.
                        </p>
                    </div>
                </div>

                {/* Tab bar */}
                <div
                    style={{
                        display: "flex",
                        gap: 4,
                        borderBottom: "1px solid var(--border-primary)",
                        marginBottom: 24,
                    }}
                >
                    {TABS.map((t) => {
                        const active = tab === t.id;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 7,
                                    border: "none",
                                    borderBottom: active ? "2px solid var(--accent-primary)" : "2px solid transparent",
                                    background: "transparent",
                                    color: active ? "var(--accent-primary-hover)" : "var(--text-tertiary)",
                                    fontSize: "0.85rem",
                                    fontWeight: 650,
                                    padding: "10px 14px",
                                    cursor: "pointer",
                                    marginBottom: -1,
                                }}
                            >
                                {t.icon}
                                {t.label}
                            </button>
                        );
                    })}
                </div>

                {/* Tab content */}
                {tab === "pipeline" && <QbgPipelinePanel />}
                {tab === "modifier" && <QbgModifierPanel />}
                {tab === "ingestion" && <QbgIngestionPanel />}
                {tab === "tagging" && <QbgTaggingPanel />}
            </main>
        </div>
    );
}
