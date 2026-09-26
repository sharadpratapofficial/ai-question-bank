import type { Config } from "tailwindcss";

const config: Config = {
    darkMode: "class",
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
            },
            colors: {
                physics: {
                    50: "#eff6ff",
                    500: "#3b82f6",
                    600: "#2563eb",
                    700: "#1d4ed8",
                },
                chemistry: {
                    50: "#f0fdf4",
                    500: "#22c55e",
                    600: "#16a34a",
                    700: "#15803d",
                },
                maths: {
                    50: "#fff7ed",
                    500: "#f97316",
                    600: "#ea580c",
                    700: "#c2410c",
                },
            },
        },
    },
    plugins: [],
};

export default config;
