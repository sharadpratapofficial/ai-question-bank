"use client";

import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import localFont from "next/font/local";
import {
    AlertCircle,
    ArrowRight,
    BarChart3,
    Bot,
    CheckCircle2,
    Chrome,
    Database,
    FileUp,
    Languages,
    Loader2,
    ShieldCheck,
    Sparkles,
    Video,
    Wand2,
    Brain,
    ScanSearch,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// Self-hosted rather than next/font/google: that helper DOWNLOADS the font at
// BUILD time, so a build with no network fails outright — which is what happened
// when the machine's autostart built before its connection was up ("Failed to
// fetch `Manrope` from Google Fonts", 2026-09-10). The files below are the same
// ones Google would have served, committed to the repo, so the build is
// offline-safe and one round trip faster.
//
// Both are VARIABLE fonts: one file covers the whole weight range, declared here
// as a range rather than as separate files per weight.
const headingFont = localFont({
    src: "./fonts/Sora-latin.woff2",
    weight: "100 800",
    style: "normal",
    display: "swap",
    // Matches Sora's own metrics closely enough to stop the fallback reflowing
    // the headline before the webfont lands.
    fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
});

const bodyFont = localFont({
    src: "./fonts/Manrope-latin.woff2",
    weight: "200 800",
    style: "normal",
    display: "swap",
    fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
});

type AuthMode = "signin" | "signup";

// DEV-ONLY LOGIN BACKDOOR. Disabled automatically in production builds
// (NODE_ENV === "production" is inlined at build time, so this whole branch
// is dead-code-eliminated from the production bundle). Override the
// credentials for local dev via NEXT_PUBLIC_DEV_LOGIN_EMAIL / _PASSWORD.
const DEV_LOGIN_ENABLED = process.env.NODE_ENV !== "production";
const DEV_LOGIN_EMAIL = process.env.NEXT_PUBLIC_DEV_LOGIN_EMAIL || "test@admin.com";
const DEV_LOGIN_PASSWORD = process.env.NEXT_PUBLIC_DEV_LOGIN_PASSWORD || "admin123";

const AI_FEATURES = [
    { icon: <FileUp size={20} />, title: "AI PDF Import", color: "#38bdf8" },
    { icon: <Bot size={20} />, title: "AI Verification", color: "#22c55e" },
    { icon: <Languages size={20} />, title: "AI Translation", color: "#a78bfa" },
    { icon: <Wand2 size={20} />, title: "AI Generation", color: "#f472b6" },
    { icon: <ScanSearch size={20} />, title: "AI Quality Check", color: "#fb923c" },
    { icon: <BarChart3 size={20} />, title: "AI Analytics", color: "#facc15" },
    { icon: <Database size={20} />, title: "QBG Pipeline", color: "#34d399" },
    { icon: <Video size={20} />, title: "Video Solutions", color: "#60a5fa" },
];

const STATS = [
    { value: "8+", label: "AI Tools" },
    { value: "10x", label: "Faster QC" },
    { value: "100%", label: "AI-Powered" },
];

export default function LandingPage() {
    const router = useRouter();
    const supabase = useMemo(() => createClient(), []);
    const [nextPath, setNextPath] = useState("/questions");

    const [mode, setMode] = useState<AuthMode>("signin");
    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [checkingSession, setCheckingSession] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const rawNext = new URLSearchParams(window.location.search).get("next");
        if (rawNext && rawNext.startsWith("/")) {
            setNextPath(rawNext);
        }
        const authError = new URLSearchParams(window.location.search).get("authError");
        if (authError) {
            setError(authError);
        }
    }, []);

    function markLocalAuth() {
        document.cookie = "qbg_dev_auth=1; Path=/; Max-Age=604800; SameSite=Lax";
    }

    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            const {
                data: { session },
            } = await supabase.auth.getSession();

            if (!mounted) return;

            if (session) {                
                router.replace(nextPath);
                return;
            }

            setCheckingSession(false);
        }

        checkSession();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            if (session) {                
                router.replace(nextPath);
            }
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, [nextPath, router, supabase]);

    async function handleEmailAuth(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setMessage(null);

        if (!email.trim() || !password.trim()) {
            setError("Email and password are required.");
            return;
        }

        if (mode === "signup" && !fullName.trim()) {
            setError("Full name is required for sign up.");
            return;
        }

        setLoading(true);
        try {
            if (
                DEV_LOGIN_ENABLED &&
                mode === "signin" &&
                email.trim().toLowerCase() === DEV_LOGIN_EMAIL &&
                password === DEV_LOGIN_PASSWORD
            ) {
                markLocalAuth();
                setMessage("Logged in with temporary local test credentials.");
                router.replace(nextPath);
                return;
            }

            if (mode === "signup") {
                const { data, error: signUpError } = await supabase.auth.signUp({
                    email: email.trim(),
                    password,
                    options: {
                        data: { full_name: fullName.trim() },
                        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
                    },
                });

                if (signUpError) throw signUpError;

                if (!data.session) {
                    setMessage("Account created. Please verify your email before signing in.");
                } else {                    
                    router.replace(nextPath);
                }
            } else {
                const { error: signInError } = await supabase.auth.signInWithPassword({
                    email: email.trim(),
                    password,
                });
                if (signInError) throw signInError;                
                router.replace(nextPath);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    async function handleGoogleSignIn() {
        setError(null);
        setMessage(null);
        setGoogleLoading(true);

        try {
            const { error: signInError } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: `${window.location.origin}/auth/callback?provider=google&next=${encodeURIComponent(nextPath)}`,
                },
            });

            if (signInError) throw signInError;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setGoogleLoading(false);
        }
    }

    if (checkingSession) {
        return (
            <main
                style={{
                    minHeight: "100vh",
                    display: "grid",
                    placeItems: "center",
                    background: "#06080f",
                    color: "#94a3b8",
                    fontFamily: bodyFont.style.fontFamily,
                }}
            >
                <div style={{ display: "inline-flex", alignItems: "center", gap: "12px" }}>
                    <Loader2 size={20} className="animate-spin" />
                    <span style={{ fontSize: "0.95rem", fontWeight: 500 }}>Preparing workspace…</span>
                </div>
            </main>
        );
    }

    return (
        <main
            className="landing-root"
            style={{
                minHeight: "100vh",
                background: "#06080f",
                color: "#e2e8f0",
                fontFamily: bodyFont.style.fontFamily,
                overflow: "hidden",
                position: "relative",
            }}
        >
            {/* Ambient glow orbs */}
            <div className="orb orb-1" />
            <div className="orb orb-2" />
            <div className="orb orb-3" />

            {/* Floating particles */}
            <div className="particles">
                {Array.from({ length: 20 }).map((_, i) => (
                    <div
                        key={i}
                        className="particle"
                        style={{
                            left: `${Math.random() * 100}%`,
                            top: `${Math.random() * 100}%`,
                            animationDelay: `${Math.random() * 6}s`,
                            animationDuration: `${4 + Math.random() * 4}s`,
                        }}
                    />
                ))}
            </div>

            {/* Subtle grid overlay */}
            <div className="grid-overlay" />

            {/* Navigation */}
            <nav className="landing-nav" style={{ fontFamily: bodyFont.style.fontFamily }}>
                <div className="nav-brand">
                    <div className="brand-icon">
                        <Sparkles size={18} />
                    </div>
                    <span className="brand-text" style={{ fontFamily: headingFont.style.fontFamily }}>
                        PW Question Bank AI
                    </span>
                </div>
            </nav>

            {/* Main content grid */}
            <div className="landing-content">
                {/* Left side: Hero */}
                <div className="hero-side">
                    <div className="hero-tagline">
                        <Brain size={14} />
                        AI-First Academic Platform
                    </div>

                    <h1
                        className="hero-title"
                        style={{ fontFamily: headingFont.style.fontFamily }}
                    >
                        Smarter question banking
                        <span className="hero-title-gradient"> powered by AI.</span>
                    </h1>

                    <p className="hero-subtitle">
                        Import, verify, generate & translate — all in one workspace.
                    </p>

                    {/* Stats row */}
                    <div className="stats-row">
                        {STATS.map((stat) => (
                            <div key={stat.label} className="stat-item">
                                <div className="stat-value" style={{ fontFamily: headingFont.style.fontFamily }}>
                                    {stat.value}
                                </div>
                                <div className="stat-label">{stat.label}</div>
                            </div>
                        ))}
                    </div>

                    {/* AI Features grid */}
                    <div className="features-grid">
                        {AI_FEATURES.map((feature, index) => (
                            <div
                                key={feature.title}
                                className="feature-chip"
                                style={{
                                    animationDelay: `${index * 0.08}s`,
                                    ["--accent" as string]: feature.color,
                                }}
                            >
                                <div className="feature-chip-icon" style={{ color: feature.color }}>
                                    {feature.icon}
                                </div>
                                <span className="feature-chip-text">{feature.title}</span>
                            </div>
                        ))}
                    </div>

                    {/* Hero banner image */}
                    <div className="hero-banner">
                        <img
                            src="/hero-banner.png"
                            alt="AI Question Bank Platform Preview"
                            className="hero-banner-img"
                        />
                        <div className="hero-banner-overlay" />
                    </div>
                </div>

                {/* Right side: Auth */}
                <div className="auth-side">
                    <div className="auth-card">
                        <div className="auth-card-glow" />

                        <div className="auth-header">
                            <div className="auth-icon">
                                <ShieldCheck size={20} />
                            </div>
                            <h2
                                className="auth-title"
                                style={{ fontFamily: headingFont.style.fontFamily }}
                            >
                                {mode === "signin" ? "Welcome back" : "Create account"}
                            </h2>
                            <p className="auth-desc">
                                {mode === "signin"
                                    ? "Sign in to access your workspace"
                                    : "Get started with your team workspace"}
                            </p>
                        </div>

                        {/* Mode toggle */}
                        <div className="auth-toggle">
                            <button
                                type="button"
                                onClick={() => { setMode("signin"); setError(null); setMessage(null); }}
                                className={`auth-toggle-btn ${mode === "signin" ? "active" : ""}`}
                            >
                                Login
                            </button>
                            <button
                                type="button"
                                onClick={() => { setMode("signup"); setError(null); setMessage(null); }}
                                className={`auth-toggle-btn ${mode === "signup" ? "active" : ""}`}
                                disabled
                                style={{ opacity: 0.5, cursor: "not-allowed" }}
                            >
                                Sign up
                            </button>
                        </div>

                        {/* Auth form */}
                        <form onSubmit={handleEmailAuth} className="auth-form">
                            {mode === "signup" && (
                                <label className="form-field">
                                    <span className="form-label">Full Name</span>
                                    <input
                                        type="text"
                                        value={fullName}
                                        onChange={(e) => setFullName(e.target.value)}
                                        placeholder="Enter your full name"
                                        autoComplete="name"
                                        className="form-input"
                                    />
                                </label>
                            )}

                            <label className="form-field">
                                <span className="form-label">Email</span>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="name@organization.com"
                                    autoComplete="email"
                                    className="form-input"
                                    required
                                />
                            </label>

                            <label className="form-field">
                                <span className="form-label">Password</span>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="Enter password"
                                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                                    className="form-input"
                                    required
                                />
                            </label>

                            <button
                                type="submit"
                                disabled={loading}
                                className="auth-submit"
                            >
                                {loading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                                {mode === "signin" ? "Sign In" : "Create Account"}
                            </button>
                        </form>

                        {mode === "signin" && (
                            <>
                                <div className="auth-divider">
                                    <span>or</span>
                                </div>

                                <button
                                    type="button"
                                    onClick={handleGoogleSignIn}
                                    disabled={googleLoading || loading}
                                    className="google-auth-button"
                                >
                                    {googleLoading ? (
                                        <Loader2 size={16} className="animate-spin" />
                                    ) : (
                                        <Chrome size={16} />
                                    )}
                                    Continue with Google
                                </button>
                            </>
                        )}

                        {/* Error / success messages */}
                        {error && (
                            <div className="auth-alert auth-alert-error">
                                <AlertCircle size={14} />
                                <span>{error}</span>
                            </div>
                        )}

                        {message && (
                            <div className="auth-alert auth-alert-success">
                                <CheckCircle2 size={14} />
                                <span>{message}</span>
                            </div>
                        )}

                        {/* Minimal bottom chips */}
                        <div className="auth-chips">
                            {["Question Bank", "AI Tools", "Test Builder", "Analytics"].map((item) => (
                                <div key={item} className="auth-chip">
                                    {item}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <style>{`
                /* ===== AMBIENT ORBS ===== */
                .orb {
                    position: fixed;
                    border-radius: 999px;
                    filter: blur(120px);
                    pointer-events: none;
                    z-index: 0;
                    opacity: 0.4;
                }
                .orb-1 {
                    width: 600px; height: 600px;
                    background: radial-gradient(circle, rgba(99,102,241,0.35), transparent 70%);
                    top: -200px; left: -100px;
                    animation: orbFloat1 12s ease-in-out infinite;
                }
                .orb-2 {
                    width: 500px; height: 500px;
                    background: radial-gradient(circle, rgba(14,165,233,0.3), transparent 70%);
                    bottom: -150px; right: -50px;
                    animation: orbFloat2 14s ease-in-out infinite;
                }
                .orb-3 {
                    width: 400px; height: 400px;
                    background: radial-gradient(circle, rgba(168,85,247,0.25), transparent 70%);
                    top: 50%; left: 45%;
                    animation: orbFloat3 10s ease-in-out infinite;
                }

                @keyframes orbFloat1 {
                    0%, 100% { transform: translate(0, 0); }
                    50% { transform: translate(60px, 40px); }
                }
                @keyframes orbFloat2 {
                    0%, 100% { transform: translate(0, 0); }
                    50% { transform: translate(-40px, -50px); }
                }
                @keyframes orbFloat3 {
                    0%, 100% { transform: translate(0, 0); }
                    50% { transform: translate(30px, -30px); }
                }

                /* ===== PARTICLES ===== */
                .particles {
                    position: fixed;
                    inset: 0;
                    pointer-events: none;
                    z-index: 0;
                }
                .particle {
                    position: absolute;
                    width: 2px;
                    height: 2px;
                    background: rgba(148, 163, 184, 0.4);
                    border-radius: 999px;
                    animation: particlePulse 5s ease-in-out infinite;
                }
                @keyframes particlePulse {
                    0%, 100% { opacity: 0.2; transform: scale(1); }
                    50% { opacity: 0.7; transform: scale(2); }
                }

                /* ===== GRID OVERLAY ===== */
                .grid-overlay {
                    position: fixed;
                    inset: 0;
                    background-image:
                        linear-gradient(rgba(148,163,184,0.03) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(148,163,184,0.03) 1px, transparent 1px);
                    background-size: 60px 60px;
                    pointer-events: none;
                    z-index: 0;
                }

                /* ===== NAV ===== */
                .landing-nav {
                    position: relative;
                    z-index: 10;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 20px 40px;
                    max-width: 1440px;
                    margin: 0 auto;
                }
                .nav-brand {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .brand-icon {
                    width: 40px;
                    height: 40px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    display: grid;
                    place-items: center;
                    color: #fff;
                    box-shadow: 0 8px 24px rgba(99,102,241,0.3);
                }
                .brand-text {
                    font-size: 1.1rem;
                    font-weight: 800;
                    color: #f1f5f9;
                    letter-spacing: -0.02em;
                }
                /* ===== MAIN CONTENT ===== */
                .landing-content {
                    position: relative;
                    z-index: 5;
                    display: grid;
                    grid-template-columns: 1.1fr 0.9fr;
                    gap: 60px;
                    max-width: 1440px;
                    margin: 0 auto;
                    padding: 40px 40px 60px;
                    align-items: start;
                    min-height: calc(100vh - 80px);
                }

                /* ===== HERO SIDE ===== */
                .hero-side {
                    display: flex;
                    flex-direction: column;
                    gap: 28px;
                    padding-top: 20px;
                    animation: fadeUp 0.6s ease-out both;
                }
                .hero-tagline {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    width: fit-content;
                    padding: 8px 16px;
                    border-radius: 999px;
                    background: rgba(99,102,241,0.08);
                    border: 1px solid rgba(99,102,241,0.15);
                    color: #a5b4fc;
                    font-size: 0.8rem;
                    font-weight: 700;
                    letter-spacing: 0.02em;
                }
                .hero-title {
                    margin: 0;
                    font-size: clamp(2.4rem, 4.5vw, 3.6rem);
                    line-height: 1.08;
                    letter-spacing: -0.04em;
                    color: #f1f5f9;
                }
                .hero-title-gradient {
                    background: linear-gradient(135deg, #6366f1, #38bdf8, #a78bfa);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .hero-subtitle {
                    margin: 0;
                    font-size: 1.05rem;
                    line-height: 1.6;
                    color: #94a3b8;
                    max-width: 42ch;
                }

                /* ===== STATS ===== */
                .stats-row {
                    display: flex;
                    gap: 32px;
                    padding: 20px 0;
                    border-top: 1px solid rgba(148,163,184,0.1);
                    border-bottom: 1px solid rgba(148,163,184,0.1);
                }
                .stat-item {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                .stat-value {
                    font-size: 1.6rem;
                    font-weight: 800;
                    background: linear-gradient(135deg, #e2e8f0, #cbd5e1);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .stat-label {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: #64748b;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                }

                /* ===== FEATURES GRID ===== */
                .features-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 10px;
                }
                .feature-chip {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 14px 16px;
                    border-radius: 14px;
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(148,163,184,0.08);
                    transition: all 0.25s ease;
                    animation: fadeUp 0.5s ease-out both;
                    cursor: default;
                }
                .feature-chip:hover {
                    background: rgba(255,255,255,0.06);
                    border-color: var(--accent, rgba(148,163,184,0.15));
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
                }
                .feature-chip-icon {
                    width: 36px;
                    height: 36px;
                    border-radius: 10px;
                    display: grid;
                    place-items: center;
                    background: rgba(255,255,255,0.04);
                    flex-shrink: 0;
                }
                .feature-chip-text {
                    font-size: 0.85rem;
                    font-weight: 700;
                    color: #cbd5e1;
                }

                /* ===== HERO BANNER ===== */
                .hero-banner {
                    position: relative;
                    border-radius: 20px;
                    overflow: hidden;
                    border: 1px solid rgba(148,163,184,0.1);
                }
                .hero-banner-img {
                    width: 100%;
                    height: 200px;
                    object-fit: cover;
                    display: block;
                }
                .hero-banner-overlay {
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(180deg, transparent 40%, rgba(6,8,15,0.8) 100%);
                    pointer-events: none;
                }

                /* ===== AUTH SIDE ===== */
                .auth-side {
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                    padding-top: 20px;
                    animation: fadeUp 0.7s ease-out both;
                    animation-delay: 0.15s;
                }

                .auth-card {
                    position: relative;
                    width: 100%;
                    max-width: 420px;
                    border-radius: 24px;
                    background: rgba(15,20,30,0.7);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(148,163,184,0.1);
                    padding: 32px;
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                    box-shadow: 0 24px 64px rgba(0,0,0,0.4);
                    overflow: hidden;
                }
                .auth-card-glow {
                    position: absolute;
                    top: -100px;
                    right: -100px;
                    width: 250px;
                    height: 250px;
                    border-radius: 999px;
                    background: radial-gradient(circle, rgba(99,102,241,0.12), transparent 65%);
                    pointer-events: none;
                }

                .auth-header {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .auth-icon {
                    width: 44px;
                    height: 44px;
                    border-radius: 14px;
                    background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15));
                    border: 1px solid rgba(99,102,241,0.2);
                    display: grid;
                    place-items: center;
                    color: #a5b4fc;
                    margin-bottom: 4px;
                }
                .auth-title {
                    margin: 0;
                    font-size: 1.5rem;
                    font-weight: 800;
                    color: #f1f5f9;
                    letter-spacing: -0.03em;
                }
                .auth-desc {
                    margin: 0;
                    font-size: 0.88rem;
                    color: #64748b;
                    line-height: 1.5;
                }

                /* ===== AUTH TOGGLE ===== */
                .auth-toggle {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 4px;
                    padding: 4px;
                    border-radius: 14px;
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(148,163,184,0.08);
                }
                .auth-toggle-btn {
                    border: none;
                    border-radius: 11px;
                    padding: 10px;
                    font-size: 0.84rem;
                    font-weight: 700;
                    cursor: pointer;
                    background: transparent;
                    color: #64748b;
                    font-family: inherit;
                    transition: all 0.2s ease;
                }
                .auth-toggle-btn.active {
                    background: rgba(99,102,241,0.12);
                    color: #a5b4fc;
                    box-shadow: 0 2px 8px rgba(99,102,241,0.1);
                }

                /* ===== FORM ===== */
                .auth-form {
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                }
                .form-field {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .form-label {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: #94a3b8;
                    letter-spacing: 0.01em;
                }
                .form-input {
                    width: 100%;
                    padding: 12px 14px;
                    border-radius: 12px;
                    border: 1px solid rgba(148,163,184,0.12);
                    background: rgba(255,255,255,0.04);
                    color: #e2e8f0;
                    font-size: 0.9rem;
                    font-family: inherit;
                    outline: none;
                    transition: all 0.2s ease;
                }
                .form-input::placeholder {
                    color: #475569;
                }
                .form-input:focus {
                    border-color: rgba(99,102,241,0.4);
                    background: rgba(99,102,241,0.04);
                    box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
                }
                .auth-submit {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    padding: 13px;
                    border: none;
                    border-radius: 14px;
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    color: #fff;
                    font-size: 0.9rem;
                    font-weight: 800;
                    font-family: inherit;
                    cursor: pointer;
                    transition: all 0.25s ease;
                    box-shadow: 0 8px 24px rgba(99,102,241,0.25);
                    margin-top: 4px;
                }
                .auth-submit:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 12px 32px rgba(99,102,241,0.35);
                }
                .auth-submit:disabled {
                    opacity: 0.6;
                    cursor: default;
                }

                .auth-divider {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    color: #64748b;
                    font-size: 0.74rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                }
                .auth-divider::before,
                .auth-divider::after {
                    content: "";
                    height: 1px;
                    flex: 1;
                    background: rgba(148,163,184,0.12);
                }
                .google-auth-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    width: 100%;
                    padding: 12px 14px;
                    border-radius: 14px;
                    border: 1px solid rgba(148,163,184,0.16);
                    background: rgba(255,255,255,0.05);
                    color: #e2e8f0;
                    font-size: 0.88rem;
                    font-weight: 800;
                    font-family: inherit;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .google-auth-button:hover:not(:disabled) {
                    border-color: rgba(148,163,184,0.28);
                    background: rgba(255,255,255,0.08);
                    transform: translateY(-1px);
                }
                .google-auth-button:disabled {
                    opacity: 0.6;
                    cursor: default;
                }

                /* ===== ALERTS ===== */
                .auth-alert {
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    padding: 11px 14px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    line-height: 1.4;
                }
                .auth-alert svg {
                    margin-top: 1px;
                    flex-shrink: 0;
                }
                .auth-alert-error {
                    background: rgba(239,68,68,0.08);
                    border: 1px solid rgba(239,68,68,0.15);
                    color: #fca5a5;
                }
                .auth-alert-success {
                    background: rgba(34,197,94,0.08);
                    border: 1px solid rgba(34,197,94,0.15);
                    color: #86efac;
                }

                /* ===== AUTH CHIPS ===== */
                .auth-chips {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                    padding-top: 4px;
                    border-top: 1px solid rgba(148,163,184,0.06);
                }
                .auth-chip {
                    padding: 6px 12px;
                    border-radius: 8px;
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(148,163,184,0.06);
                    font-size: 0.72rem;
                    font-weight: 700;
                    color: #475569;
                }

                /* ===== ANIMATION ===== */
                @keyframes fadeUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                /* ===== RESPONSIVE ===== */
                @media (max-width: 1100px) {
                    .landing-content {
                        grid-template-columns: 1fr;
                        gap: 40px;
                        padding: 30px 24px 50px;
                    }
                    .auth-side {
                        justify-content: flex-start;
                    }
                    .auth-card {
                        max-width: 100%;
                    }
                }

                @media (max-width: 700px) {
                    .landing-nav {
                        padding: 16px 20px;
                    }
                    .landing-content {
                        padding: 20px 16px 40px;
                        gap: 32px;
                    }
                    .features-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    .stats-row {
                        gap: 20px;
                    }
                    .hero-title {
                        font-size: 2rem;
                    }
                }

                @media (max-width: 480px) {
                    .features-grid {
                        grid-template-columns: 1fr;
                    }
                    .stats-row {
                        flex-wrap: wrap;
                        gap: 16px;
                    }
                    .auth-card {
                        padding: 24px;
                    }
                }
            `}</style>
        </main>
    );
}
