import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";
import { AIJobQueueProvider } from "@/context/AIJobQueueContext";
import AIJobNotifier from "@/components/ui/AIJobNotifier";
import { QuestionTaskQueueProvider } from "@/context/QuestionTaskQueueContext";
import QuestionTaskNotifier from "@/components/ui/QuestionTaskNotifier";
import { UserProfileProvider } from "@/context/UserProfileContext";
import { ExtractionQueueProvider } from "@/context/ExtractionQueueContext";
import ExtractionQueueNotifier from "@/components/ui/ExtractionQueueNotifier";

export const metadata: Metadata = {
    title: "AI QB — Question Bank Manager",
    description:
        "Browse, manage, and generate tests from thousands of JEE/NEET questions with AI-powered tools.",
    keywords: ["JEE", "NEET", "question bank", "test generation", "education"],
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" data-theme="dark" suppressHydrationWarning>
            <head>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){try{var t=localStorage.getItem('qbg-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
                    }}
                />
                {/* The fonts are served from this origin now (public/fonts +
                    @font-face in globals.css), so there is nothing to preconnect
                    to. Preloaded instead, because a webfont referenced from a CSS
                    file is discovered late — the browser has to parse the CSS
                    first. */}
                <link
                    rel="preload"
                    href="/fonts/Inter-latin.woff2"
                    as="font"
                    type="font/woff2"
                    crossOrigin="anonymous"
                />
                <link
                    rel="stylesheet"
                    href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"
                    integrity="sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+"
                    crossOrigin="anonymous"
                />
            </head>
            <body className="antialiased">
                <ThemeProvider>
                    <UserProfileProvider>
                        <AIJobQueueProvider>
                            <QuestionTaskQueueProvider>
                                <ExtractionQueueProvider>
                                    {children}
                                    <AIJobNotifier />
                                    <QuestionTaskNotifier />
                                    <ExtractionQueueNotifier />
                                </ExtractionQueueProvider>
                            </QuestionTaskQueueProvider>
                        </AIJobQueueProvider>
                    </UserProfileProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
