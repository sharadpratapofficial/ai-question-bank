"use client";

import { useRouter } from "next/navigation";
import { CircuitBoard } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import RequirePermission from "@/components/auth/RequirePermission";
import CircuitDesigner from "@/components/circuit/CircuitDesigner";

export default function CircuitDesignerPage() {
    return (
        <RequirePermission permission="use_circuit_designer">
            <CircuitDesignerPageInner />
        </RequirePermission>
    );
}

function CircuitDesignerPageInner() {
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
        else if (t === "video-solution") router.push("/video-solution");
        else if (t === "question-wise-videos") router.push("/question-wise-videos");
        // "circuit-designer" is already this page — no navigation needed.
    };

    return (
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-primary)" }}>
            <Sidebar activeTab="circuit-designer" onTabChange={handleTabChange} />

            <main style={{ flex: 1, padding: "28px 32px", maxWidth: 1600, margin: "0 auto", width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 11,
                            background: "linear-gradient(135deg,#0ea5e9,#6366f1)",
                            display: "grid",
                            placeItems: "center",
                            color: "#fff",
                        }}
                    >
                        <CircuitBoard size={20} />
                    </div>
                    <div>
                        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800, color: "var(--text-primary)" }}>
                            Circuit Designer
                        </h1>
                        <p style={{ margin: "2px 0 0", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                            Draw circuits or paste CircuiTikZ code — the diagram and the code stay in sync both ways.
                            Export as PNG.
                        </p>
                    </div>
                </div>

                <CircuitDesigner />
            </main>
        </div>
    );
}
