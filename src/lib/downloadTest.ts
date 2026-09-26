import katex from "katex";
import { saveAs } from "file-saver";
import {
    Document,
    ImageRun,
    Math as DocxMath,
    MathFraction,
    MathRadical,
    MathRun,
    MathSubScript,
    MathSubSuperScript,
    MathSuperScript,
    Packer,
    Paragraph,
    TextRun,
} from "docx";
import type { MathComponent, ParagraphChild } from "docx";
import type { GeneratedTest, Question } from "@/types";
import { resolveAnswerKey } from "@/types";

export interface DownloadTestOptions {
    tests: GeneratedTest[];
    contentMode: "QUESTIONS_ONLY" | "QUESTIONS_WITH_ANSWER_KEY" | "QUESTIONS_ANSWER_KEY_SOLUTION";
    labelFormat: "ABCD" | "1234";
    deliveryMode: "PAPER_WISE" | "QUESTION_WISE";
    showAnswerKeyBeforeSolution: boolean;
    twoColumnFormat: boolean;
    instructions: string;
    includeMetadata: boolean;
    metadataFields: string[];
    filename?: string;
}

function getOptionLabel(index: number, format: "ABCD" | "1234"): string {
    if (format === "1234") return String(index + 1);
    return String.fromCharCode(65 + index);
}

function formatAnswerKey(question: Question, labelFormat: "ABCD" | "1234"): string {
    const values = resolveAnswerKey(question);
    if (values.length === 0) return "—";
    const hasTextOptions =
        Array.isArray(question.options) &&
        question.options.some((o) => Boolean(o?.text));
    if (!hasTextOptions) return values.map(String).join(", ");
    return values
        .map((value) => {
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric < 1) return String(value);
            return getOptionLabel(numeric - 1, labelFormat);
        })
        .join(", ");
}

const SUBJECT_OUTPUT_ORDER = ["Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"];
const PAPER_OUTPUT_ORDER = ["Paper 1", "Paper 2"] as const;

function subjectOrderValue(subject: string): number {
    const index = SUBJECT_OUTPUT_ORDER.findIndex(
        (name) => name.toLowerCase() === subject.toLowerCase()
    );
    return index === -1 ? SUBJECT_OUTPUT_ORDER.length : index;
}

function sortSectionsBySubject(
    sections: GeneratedTest["sections"]
): GeneratedTest["sections"] {
    return [...sections].sort((a, b) => {
        const av = subjectOrderValue(a.subject);
        const bv = subjectOrderValue(b.subject);
        if (av !== bv) return av - bv;
        return a.subject.localeCompare(b.subject);
    });
}

function collectQuestionsFromTest(
    test: GeneratedTest
): Array<{ question: Question; subject: string; paper?: "Paper 1" | "Paper 2" }> {
    const items: Array<{ question: Question; subject: string; paper?: "Paper 1" | "Paper 2" }> = [];
    const hasPaperSections = test.sections.some((section) => Boolean(section.paper));

    if (hasPaperSections) {
        PAPER_OUTPUT_ORDER.forEach((paper) => {
            const paperSections = sortSectionsBySubject(
                test.sections.filter((section) => section.paper === paper)
            );
            paperSections.forEach((section) => {
                section.questionTypes.forEach((group) => {
                    group.questions.forEach((question) => {
                        items.push({ question, subject: section.subject, paper });
                    });
                });
            });
        });
        return items;
    }

    sortSectionsBySubject(test.sections).forEach((section) => {
        section.questionTypes.forEach((group) => {
            group.questions.forEach((question) => {
                items.push({ question, subject: section.subject });
            });
        });
    });
    return items;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function decodeHtmlEntities(text: string): string {
    if (!text || !text.includes("&")) return text;

    let decoded = text;
    if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = decoded;
        decoded = textarea.value;
    }

    return decoded
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanLatexForKatex(latex: string): string {
    return decodeHtmlEntities(
        latex
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<p[^>]*>/gi, " ")
            .replace(/<\/p>/gi, " ")
            .replace(/<[^>]+>/g, "")
    ).trim();
}

function renderLatex(latex: string, displayMode: boolean): string {
    const cleaned = cleanLatexForKatex(latex);
    try {
        return katex.renderToString(cleaned, {
            throwOnError: false,
            displayMode,
            output: "html",
            strict: false,
            trust: true,
        });
    } catch {
        return escapeHtml(latexToUnicode(cleaned) || cleaned);
    }
}

function preRenderMathForPDF(html: string): string {
    if (!html) return "";
    let result = replaceMathImagesWithText(html);
    result = result.replace(/<math[\s\S]*?<\/math>/gi, (match) => {
        const annotationLatex = extractLatexFromMathMarkup(match);
        if (annotationLatex) {
            return `<span class="pdf-math-inline">${renderLatex(annotationLatex, false)}</span>`;
        }
        const fallbackText = mathmlHtmlToText(match).trim();
        return fallbackText ? `<span class="pdf-math-text">${escapeHtml(fallbackText)}</span>` : match;
    });
    result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) =>
        `<div class="katex-display-wrapper">${renderLatex(latex, true)}</div>`
    );
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) =>
        renderLatex(latex, false)
    );
    result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) =>
        `<div class="katex-display-wrapper">${renderLatex(latex, true)}</div>`
    );
    result = result.replace(/(?<!\$)\$([^\$\n]{1,200}?)\$(?!\$)/g, (_, latex) =>
        renderLatex(latex, false)
    );
    return result;
}

const SUPERSCRIPT_MAP: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ", "a": "ᵃ", "b": "ᵇ", "x": "ˣ", "m": "ᵐ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "o": "ₒ", "x": "ₓ", "n": "ₙ",
};

const GREEK_MAP: Record<string, string> = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
    varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
    pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς",
    tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε", Theta: "Θ",
    Lambda: "Λ", Mu: "Μ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const WORD_FONT = "Calibri";
const WORD_BODY_SIZE = 22; // 11pt (half-points)
const WORD_META_SIZE = 20; // 10pt
const WORD_TITLE_SIZE = 28; // 14pt
const WORD_LINE_SPACING = 320;

type WordInlinePart =
    | { type: "text"; value: string }
    | { type: "math_latex"; value: string }
    | { type: "math_mathml"; value: string };

function toSuperscript(text: string): string {
    if (/^[0-9\-+]+$/.test(text)) {
        return text.split("").map(c => SUPERSCRIPT_MAP[c] ?? c).join("");
    }
    return `^(${text})`;
}

function toSubscript(text: string): string {
    if (/^[0-9\-+a-z]+$/.test(text)) {
        return text.split("").map(c => SUBSCRIPT_MAP[c] ?? c).join("");
    }
    return `_(${text})`;
}

function mathmlNodeToText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return decodeHtmlEntities(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node as Element;
    const tag = el.tagName.toLowerCase().replace(/^m:/, "");
    const kids = Array.from(el.childNodes);

    switch (tag) {
        case "math":
        case "mrow":
        case "mstyle":
        case "mpadded":
        case "mphantom":
        case "merror":
            return kids.map(mathmlNodeToText).join("");

        case "mfrac": {
            const num = mathmlNodeToText(kids[0]);
            const den = mathmlNodeToText(kids[1] ?? kids[0]);
            return `(${num})/(${den})`;
        }
        case "msup": {
            const base = mathmlNodeToText(kids[0]);
            const sup = mathmlNodeToText(kids[1] ?? kids[0]);
            return base + toSuperscript(sup);
        }
        case "msub": {
            const base = mathmlNodeToText(kids[0]);
            const sub = mathmlNodeToText(kids[1] ?? kids[0]);
            return base + toSubscript(sub);
        }
        case "msubsup": {
            const base = mathmlNodeToText(kids[0]);
            const sub = mathmlNodeToText(kids[1] ?? kids[0]);
            const sup = mathmlNodeToText(kids[2] ?? kids[0]);
            return base + toSubscript(sub) + toSuperscript(sup);
        }
        case "msqrt":
            return "√(" + kids.map(mathmlNodeToText).join("") + ")";
        case "mroot": {
            const content = mathmlNodeToText(kids[0]);
            const degree = mathmlNodeToText(kids[1] ?? kids[0]);
            return degree + "√(" + content + ")";
        }
        case "mover":
        case "munder":
        case "munderover":
            return mathmlNodeToText(kids[0]);

        case "mfenced": {
            const open = el.getAttribute("open") ?? "(";
            const close = el.getAttribute("close") ?? ")";
            return open + kids.map(mathmlNodeToText).join("") + close;
        }
        case "semantics": {
            const first = kids.find(
                c => (c as Element).tagName?.toLowerCase() !== "annotation" &&
                    (c as Element).tagName?.toLowerCase() !== "annotation-xml"
            );
            return first ? mathmlNodeToText(first) : "";
        }
        case "annotation":
        case "annotation-xml":
            return "";

        case "mi":
        case "mn":
        case "mo":
        case "mtext":
        case "ms": {
            const raw = el.textContent || "";
            return decodeHtmlEntities(raw);
        }
        case "mtable": {
            const rows = Array.from(el.querySelectorAll("mtr"));
            return rows.map(row =>
                Array.from(row.querySelectorAll("mtd")).map(mathmlNodeToText).join(" | ")
            ).join("\n");
        }
        default:
            return kids.map(mathmlNodeToText).join("");
    }
}

function extractLatexFromMathMarkup(mathMarkup: string): string {
    const annotationMatch = mathMarkup.match(
        /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/i
    );
    if (annotationMatch?.[1]) {
        const latex = cleanLatexForKatex(annotationMatch[1]);
        if (latex) return latex;
    }

    const altTextMatch = mathMarkup.match(/\balttext\s*=\s*["']([\s\S]*?)["']/i);
    if (altTextMatch?.[1]) {
        const latex = cleanLatexForKatex(altTextMatch[1]);
        if (latex) return latex;
    }

    return "";
}

function mathmlHtmlToText(html: string): string {
    if (!html || !html.includes("<math")) return html;
    const parser = new DOMParser();
    return html.replace(/<math[\s\S]*?<\/math>/gi, (match) => {
        const annotationLatex = extractLatexFromMathMarkup(match);
        if (annotationLatex) return latexToUnicode(annotationLatex);

        try {
            const doc = parser.parseFromString(match, "text/html");
            const mathEl = doc.querySelector("math");
            if (mathEl) {
                const parsed = mathmlNodeToText(mathEl).trim();
                if (parsed && !/this page contains the following errors|parsererror|error on line/i.test(parsed)) {
                    return parsed;
                }
            }
        } catch {
            // Fallback below.
        }

        const fallback = decodeHtmlEntities(
            match
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
        );
        return fallback;
    });
}

function latexToUnicode(latex: string): string {
    let s = cleanLatexForKatex(latex);

    for (const [name, char] of Object.entries(GREEK_MAP)) {
        s = s.replace(new RegExp(`\\\\${name}(?![a-zA-Z])`, "g"), char);
    }

    s = s.replace(/\\text\{([^}]*)\}/g, "$1");
    s = s.replace(/\\mathrm\{([^}]*)\}/g, "$1");
    s = s.replace(/\\mathbf\{([^}]*)\}/g, "$1");
    s = s.replace(/\\mathit\{([^}]*)\}/g, "$1");
    s = s.replace(/\\textbf\{([^}]*)\}/g, "$1");
    s = s.replace(/\\textrm\{([^}]*)\}/g, "$1");
    s = s.replace(/\\operatorname\{([^}]*)\}/g, "$1");
    s = s.replace(/\\underbrace\{([^}]*)\}_\{[^}]*\}/g, "$1");
    s = s.replace(/\\overbrace\{([^}]*)\}\^\{[^}]*\}/g, "$1");

    for (let i = 0; i < 4; i++) {
        s = s.replace(/\\frac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
            (_, num, den) => `(${num})/(${den})`);
        s = s.replace(/\\dfrac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
            (_, num, den) => `(${num})/(${den})`);
        s = s.replace(/\\cfrac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
            (_, num, den) => `(${num})/(${den})`);
    }

    for (let i = 0; i < 3; i++) {
        s = s.replace(/\^\{([^{}]*)\}/g, (_, content) => toSuperscript(content.trim()));
        s = s.replace(/_\{([^{}]*)\}/g, (_, content) => toSubscript(content.trim()));
    }
    s = s.replace(/\^([a-zA-Z0-9\-+])/g, (_, c) => SUPERSCRIPT_MAP[c] ?? `^${c}`);
    s = s.replace(/_([a-zA-Z0-9])/g, (_, c) => SUBSCRIPT_MAP[c] ?? `_${c}`);

    s = s.replace(/\\sqrt\[([^\]]*)\]\{([^}]*)\}/g, (_, n, content) => `${n}√(${content})`);
    s = s.replace(/\\sqrt\{([^}]*)\}/g, (_, content) => `√(${content})`);
    s = s.replace(/\\sqrt\s/g, "√");

    s = s.replace(/\\vec\{([^}]*)\}/g, "$1⃗");
    s = s.replace(/\\hat\{([^}]*)\}/g, "$1̂");
    s = s.replace(/\\bar\{([^}]*)\}/g, "$1̄");
    s = s.replace(/\\dot\{([^}]*)\}/g, "$1̇");
    s = s.replace(/\\ddot\{([^}]*)\}/g, "$1̈");
    s = s.replace(/\\tilde\{([^}]*)\}/g, "$1̃");
    s = s.replace(/\\overrightarrow\{([^}]*)\}/g, "$1⃗");
    s = s.replace(/\\overleftarrow\{([^}]*)\}/g, "$1⃖");

    const SYMBOLS: Record<string, string> = {
        "\\times": "×", "\\cdot": "·", "\\div": "÷", "\\pm": "±", "\\mp": "∓",
        "\\infty": "∞", "\\neq": "≠", "\\ne": "≠", "\\leq": "≤", "\\le": "≤",
        "\\geq": "≥", "\\ge": "≥", "\\approx": "≈", "\\equiv": "≡", "\\propto": "∝",
        "\\sim": "∼", "\\simeq": "≃", "\\cong": "≅", "\\ll": "≪", "\\gg": "≫",
        "\\sum": "Σ", "\\prod": "Π", "\\int": "∫", "\\iint": "∬", "\\iiint": "∭",
        "\\partial": "∂", "\\nabla": "∇", "\\forall": "∀", "\\exists": "∃",
        "\\in": "∈", "\\notin": "∉", "\\subset": "⊂", "\\supset": "⊃",
        "\\cup": "∪", "\\cap": "∩", "\\emptyset": "∅", "\\varnothing": "∅",
        "\\rightarrow": "→", "\\to": "→", "\\leftarrow": "←", "\\gets": "←",
        "\\leftrightarrow": "↔", "\\Rightarrow": "⇒", "\\Leftarrow": "⇐",
        "\\Leftrightarrow": "⇔", "\\uparrow": "↑", "\\downarrow": "↓",
        "\\ldots": "…", "\\cdots": "⋯", "\\vdots": "⋮", "\\ddots": "⋱",
        "\\angle": "∠", "\\circ": "°", "\\degree": "°", "\\perp": "⊥",
        "\\parallel": "∥", "\\because": "∵", "\\therefore": "∴",
        "\\left(": "(", "\\right)": ")", "\\left[": "[", "\\right]": "]",
        "\\left\\{": "{", "\\right\\}": "}", "\\left|": "|", "\\right|": "|",
        "\\langle": "⟨", "\\rangle": "⟩", "\\lfloor": "⌊", "\\rfloor": "⌋",
        "\\lceil": "⌈", "\\rceil": "⌉", "\\{": "{", "\\}": "}",
        "\\hbar": "ℏ", "\\ell": "ℓ", "\\Re": "ℜ", "\\Im": "ℑ",
        "\\aleph": "ℵ", "\\wp": "℘", "\\otimes": "⊗", "\\oplus": "⊕",
        "\\odot": "⊙", "\\ast": "∗", "\\star": "★", "\\dagger": "†",
        "\\ddagger": "‡", "\\bullet": "•", "\\diamond": "◇",
        "\\triangleright": "▷", "\\triangleleft": "◁",
        "\\quad": " ", "\\qquad": "  ", "\\,": " ", "\\;": " ", "\\:": " ",
        "\\!": "", "\\ ": " ", "\\|": "‖",
    };

    for (const [cmd, sym] of Object.entries(SYMBOLS)) {
        const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        s = s.replace(new RegExp(escaped + "(?![a-zA-Z])", "g"), sym);
    }

    s = s.replace(/\\[a-zA-Z]+/g, "");
    s = s.replace(/[{}]/g, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

function readHtmlAttribute(attrs: string, name: string): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    const match = attrs.match(regex);
    return decodeHtmlEntities((match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim());
}

function decodeUrlMathValue(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, "%20"));
    } catch {
        return value;
    }
}

function parseMathFromImageTagAttributesDetailed(
    attrs: string
): { latex?: string; text?: string } {
    const className = readHtmlAttribute(attrs, "class");
    const src = readHtmlAttribute(attrs, "src");
    const sourceHint = `${className} ${src}`;
    const looksMathFromSource = /math|latex|equation|katex|mathjax|codecogs|tex/i.test(sourceHint);

    const directCandidates = [
        readHtmlAttribute(attrs, "data-latex"),
        readHtmlAttribute(attrs, "data-tex"),
        readHtmlAttribute(attrs, "data-math"),
        readHtmlAttribute(attrs, "latex"),
        readHtmlAttribute(attrs, "alt"),
        readHtmlAttribute(attrs, "title"),
    ].filter(Boolean);

    for (const raw of directCandidates) {
        const candidate = raw.trim();
        if (!candidate) continue;
        if (/^(math|equation)$/i.test(candidate)) continue;
        if (/\\[a-zA-Z]+|[\^_{}]|(?:\$\$|\\\(|\\\[|\$[^$]+\$)/.test(candidate)) {
            return { latex: candidate };
        }
        if (looksMathFromSource) {
            return { text: candidate };
        }
    }

    if (src) {
        try {
            const parsed = new URL(src, "https://example.com");
            const codecogs = parsed.searchParams.get("latex") || parsed.searchParams.get("eq");
            if (codecogs) return { latex: decodeUrlMathValue(codecogs) };

            const googleChartMath = parsed.searchParams.get("chl");
            if (googleChartMath) return { latex: decodeUrlMathValue(googleChartMath) };

            const rawQuery = parsed.search.replace(/^\?/, "").trim();
            if (rawQuery && /\\|frac|sqrt|pi|theta|alpha|beta|gamma|delta/i.test(rawQuery)) {
                return { latex: decodeUrlMathValue(rawQuery) };
            }
        } catch {
            // Ignore invalid URLs and leave image as-is.
        }
    }

    return {};
}

function parseMathFromImageTagAttributes(attrs: string): string {
    const parsed = parseMathFromImageTagAttributesDetailed(attrs);
    if (parsed.latex) return latexToUnicode(parsed.latex);
    return parsed.text ?? "";
}

function replaceMathImagesWithText(html: string): string {
    if (!html || !/<img\b/i.test(html)) return html;
    return html.replace(/<img\b([^>]*)\/?>/gi, (match, attrs) => {
        const mathText = parseMathFromImageTagAttributes(attrs || "");
        return mathText ? ` ${mathText} ` : match;
    });
}

const LATEX_MATH_COMMAND_SYMBOLS: Record<string, string> = {
    times: "×",
    cdot: "·",
    div: "÷",
    pm: "±",
    mp: "∓",
    infty: "∞",
    neq: "≠",
    ne: "≠",
    leq: "≤",
    le: "≤",
    geq: "≥",
    ge: "≥",
    approx: "≈",
    equiv: "≡",
    propto: "∝",
    sim: "∼",
    sum: "Σ",
    prod: "Π",
    int: "∫",
    iint: "∬",
    iiint: "∭",
    partial: "∂",
    nabla: "∇",
    forall: "∀",
    exists: "∃",
    in: "∈",
    notin: "∉",
    subset: "⊂",
    supset: "⊃",
    cup: "∪",
    cap: "∩",
    emptyset: "∅",
    varnothing: "∅",
    to: "→",
    rightarrow: "→",
    leftarrow: "←",
    leftrightarrow: "↔",
    Rightarrow: "⇒",
    Leftarrow: "⇐",
    Leftrightarrow: "⇔",
    ldots: "…",
    cdots: "⋯",
    vdots: "⋮",
    ddots: "⋱",
    angle: "∠",
    circ: "°",
    degree: "°",
    perp: "⊥",
    parallel: "∥",
    because: "∵",
    therefore: "∴",
    langle: "⟨",
    rangle: "⟩",
    lfloor: "⌊",
    rfloor: "⌋",
    lceil: "⌈",
    rceil: "⌉",
    hbar: "ℏ",
    ell: "ℓ",
    Re: "ℜ",
    Im: "ℑ",
    aleph: "ℵ",
    wp: "℘",
    otimes: "⊗",
    oplus: "⊕",
    odot: "⊙",
    ast: "∗",
    star: "★",
    dagger: "†",
    ddagger: "‡",
    bullet: "•",
    diamond: "◇",
    triangleright: "▷",
    triangleleft: "◁",
};

function normalizeLatexMathCommand(command: string): string | null {
    if (GREEK_MAP[command]) return GREEK_MAP[command];
    if (LATEX_MATH_COMMAND_SYMBOLS[command]) return LATEX_MATH_COMMAND_SYMBOLS[command];

    switch (command) {
        case "{":
            return "{";
        case "}":
            return "}";
        case "|":
            return "|";
        case "_":
            return "_";
        case "^":
            return "^";
        case "%":
            return "%";
        case "#":
            return "#";
        case "$":
            return "$";
        case "&":
            return "&";
        default:
            return null;
    }
}

function parseLatexToMathComponents(latex: string): MathComponent[] {
    const source = cleanLatexForKatex(latex);
    if (!source) return [new MathRun("")];

    let i = 0;

    const skipSpaces = (): void => {
        while (i < source.length && /\s/.test(source[i])) i++;
    };

    const readEnclosed = (open: string, close: string): string => {
        if (source[i] !== open) return "";
        i++;
        const start = i;
        let depth = 1;
        while (i < source.length) {
            const ch = source[i];
            if (ch === "\\" && i + 1 < source.length) {
                i += 2;
                continue;
            }
            if (ch === open) depth++;
            else if (ch === close) depth--;
            if (depth === 0) {
                const content = source.slice(start, i);
                i++;
                return content;
            }
            i++;
        }
        return source.slice(start);
    };

    const parseArgumentComponents = (): MathComponent[] => {
        skipSpaces();
        if (i >= source.length) return [new MathRun("")];
        if (source[i] === "{") return parseLatexToMathComponents(readEnclosed("{", "}"));
        if (source[i] === "\\") return parseAtom();
        const ch = source[i++];
        return [new MathRun(ch)];
    };

    const readDelimiterAfterLeftRight = (): string => {
        skipSpaces();
        if (i >= source.length) return "";
        if (source[i] === "\\") {
            i++;
            if (i >= source.length) return "";
            if (!/[a-zA-Z]/.test(source[i])) return source[i++];
            const start = i;
            while (i < source.length && /[a-zA-Z]/.test(source[i])) i++;
            const cmd = source.slice(start, i);
            const normalized = normalizeLatexMathCommand(cmd);
            return normalized ?? cmd;
        }
        return source[i++];
    };

    const parseCommand = (command: string): MathComponent[] => {
        if (command === "frac" || command === "dfrac" || command === "cfrac") {
            const numerator = parseArgumentComponents();
            const denominator = parseArgumentComponents();
            return [new MathFraction({ numerator, denominator })];
        }

        if (command === "sqrt") {
            skipSpaces();
            let degree: MathComponent[] | undefined;
            if (source[i] === "[") {
                degree = parseLatexToMathComponents(readEnclosed("[", "]"));
            }
            const children = parseArgumentComponents();
            return [new MathRadical({ children, degree })];
        }

        if (
            command === "text" ||
            command === "mathrm" ||
            command === "mathbf" ||
            command === "mathit" ||
            command === "textbf" ||
            command === "textrm" ||
            command === "operatorname"
        ) {
            return parseArgumentComponents();
        }

        if (command === "left" || command === "right") {
            const delimiter = readDelimiterAfterLeftRight();
            return delimiter ? [new MathRun(delimiter)] : [];
        }

        if (command === "quad") return [new MathRun(" ")];
        if (command === "qquad") return [new MathRun("  ")];

        const normalized = normalizeLatexMathCommand(command);
        if (normalized !== null) return [new MathRun(normalized)];
        return [new MathRun(command)];
    };

    const parseAtom = (): MathComponent[] => {
        if (i >= source.length) return [];
        const ch = source[i];

        if (ch === "{") {
            return parseLatexToMathComponents(readEnclosed("{", "}"));
        }

        if (ch === "\\") {
            i++;
            if (i >= source.length) return [new MathRun("\\")];
            if (!/[a-zA-Z]/.test(source[i])) {
                const escaped = source[i++];
                return [new MathRun(escaped)];
            }
            const start = i;
            while (i < source.length && /[a-zA-Z]/.test(source[i])) i++;
            return parseCommand(source.slice(start, i));
        }

        i++;
        return [new MathRun(ch)];
    };

    const parseSequence = (): MathComponent[] => {
        const components: MathComponent[] = [];

        while (i < source.length) {
            if (source[i] === "}") break;
            if (/\s/.test(source[i])) {
                i++;
                components.push(new MathRun(" "));
                continue;
            }

            const base = parseAtom();
            if (base.length === 0) continue;

            let subScript: MathComponent[] | undefined;
            let superScript: MathComponent[] | undefined;

            while (i < source.length) {
                if (source[i] === "_") {
                    i++;
                    subScript = parseArgumentComponents();
                    continue;
                }
                if (source[i] === "^") {
                    i++;
                    superScript = parseArgumentComponents();
                    continue;
                }
                break;
            }

            if (subScript && superScript) {
                components.push(new MathSubSuperScript({
                    children: base,
                    subScript,
                    superScript,
                }));
                continue;
            }

            if (subScript) {
                components.push(new MathSubScript({
                    children: base,
                    subScript,
                }));
                continue;
            }

            if (superScript) {
                components.push(new MathSuperScript({
                    children: base,
                    superScript,
                }));
                continue;
            }

            components.push(...base);
        }

        return components;
    };

    const parsed = parseSequence();
    return parsed.length > 0 ? parsed : [new MathRun(latexToUnicode(source))];
}

function mathmlNodeToMathComponents(node: Node): MathComponent[] {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = decodeHtmlEntities(node.textContent || "");
        return text ? [new MathRun(text)] : [];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];

    const el = node as Element;
    const tag = el.tagName.toLowerCase().replace(/^m:/, "");
    const kids = Array.from(el.childNodes);

    switch (tag) {
        case "math":
        case "mrow":
        case "mstyle":
        case "mpadded":
        case "mphantom":
        case "merror":
            return kids.flatMap(mathmlNodeToMathComponents);

        case "mfrac": {
            const numerator = mathmlNodeToMathComponents(kids[0]);
            const denominator = mathmlNodeToMathComponents(kids[1] ?? kids[0]);
            return [new MathFraction({ numerator, denominator })];
        }

        case "msup": {
            const children = mathmlNodeToMathComponents(kids[0]);
            const superScript = mathmlNodeToMathComponents(kids[1] ?? kids[0]);
            return [new MathSuperScript({ children, superScript })];
        }

        case "msub": {
            const children = mathmlNodeToMathComponents(kids[0]);
            const subScript = mathmlNodeToMathComponents(kids[1] ?? kids[0]);
            return [new MathSubScript({ children, subScript })];
        }

        case "msubsup": {
            const children = mathmlNodeToMathComponents(kids[0]);
            const subScript = mathmlNodeToMathComponents(kids[1] ?? kids[0]);
            const superScript = mathmlNodeToMathComponents(kids[2] ?? kids[0]);
            return [new MathSubSuperScript({ children, subScript, superScript })];
        }

        case "msqrt":
            return [new MathRadical({ children: kids.flatMap(mathmlNodeToMathComponents) })];

        case "mroot": {
            const children = mathmlNodeToMathComponents(kids[0]);
            const degree = mathmlNodeToMathComponents(kids[1] ?? kids[0]);
            return [new MathRadical({ children, degree })];
        }

        case "mover":
        case "munder":
        case "munderover":
            return mathmlNodeToMathComponents(kids[0]);

        case "mfenced": {
            const open = el.getAttribute("open") ?? "(";
            const close = el.getAttribute("close") ?? ")";
            return [new MathRun(open), ...kids.flatMap(mathmlNodeToMathComponents), new MathRun(close)];
        }

        case "semantics": {
            const first = kids.find(
                c => (c as Element).tagName?.toLowerCase() !== "annotation" &&
                    (c as Element).tagName?.toLowerCase() !== "annotation-xml"
            );
            return first ? mathmlNodeToMathComponents(first) : [];
        }

        case "annotation":
        case "annotation-xml":
            return [];

        case "mi":
        case "mn":
        case "mo":
        case "mtext":
        case "ms": {
            const text = decodeHtmlEntities(el.textContent || "");
            return text ? [new MathRun(text)] : [];
        }

        default:
            return kids.flatMap(mathmlNodeToMathComponents);
    }
}

function parseMathMarkupToComponents(mathMarkup: string): MathComponent[] {
    const latex = extractLatexFromMathMarkup(mathMarkup);
    if (latex) return parseLatexToMathComponents(latex);

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(mathMarkup, "text/html");
        const mathEl = doc.querySelector("math");
        if (mathEl) {
            const components = mathmlNodeToMathComponents(mathEl);
            if (components.length > 0) return components;
        }
    } catch {
        // Fallback below.
    }

    const fallback = mathmlHtmlToText(mathMarkup);
    return fallback ? [new MathRun(fallback)] : [];
}

function htmlToWordInlineParts(html: string): WordInlinePart[][] {
    if (!html) return [[{ type: "text", value: "" }]];
    const parts: Array<WordInlinePart> = [];
    const tokenFor = (part: WordInlinePart): string => {
        const idx = parts.push(part) - 1;
        return `[[MATH_${idx}]]`;
    };

    let result = html;
    result = result.replace(/<img\b([^>]*)\/?>/gi, (match, attrs) => {
        const parsed = parseMathFromImageTagAttributesDetailed(attrs || "");
        if (parsed.latex) return ` ${tokenFor({ type: "math_latex", value: parsed.latex })} `;
        if (parsed.text) return ` ${parsed.text} `;
        return match;
    });

    result = result.replace(/<math[\s\S]*?<\/math>/gi, (match) => {
        const latex = extractLatexFromMathMarkup(match);
        if (latex) return ` ${tokenFor({ type: "math_latex", value: latex })} `;
        return ` ${tokenFor({ type: "math_mathml", value: match })} `;
    });

    result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) =>
        ` ${tokenFor({ type: "math_latex", value: cleanLatexForKatex(latex) })} `
    );
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) =>
        tokenFor({ type: "math_latex", value: cleanLatexForKatex(latex) })
    );
    result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) =>
        ` ${tokenFor({ type: "math_latex", value: cleanLatexForKatex(latex) })} `
    );
    result = result.replace(/(?<!\$)\$([^\$\n]{1,200}?)\$(?!\$)/g, (_, latex) =>
        tokenFor({ type: "math_latex", value: cleanLatexForKatex(latex) })
    );

    result = result
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)>\s*/gi, "\n")
        .replace(/<(td|th)[^>]*>/gi, " ")
        .replace(/<\/(td|th)>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\u00a0/g, " ");

    result = decodeHtmlEntities(result)
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!result) return [[{ type: "text", value: "" }]];

    return result.split("\n").map((line) => {
        const lineParts: WordInlinePart[] = [];
        const re = /\[\[MATH_(\d+)\]\]/g;
        let last = 0;
        let match: RegExpExecArray | null;

        while ((match = re.exec(line))) {
            const before = line.slice(last, match.index);
            if (before) lineParts.push({ type: "text", value: before });
            const idx = Number(match[1]);
            const tokenPart = parts[idx];
            if (tokenPart) lineParts.push(tokenPart);
            last = match.index + match[0].length;
        }

        const tail = line.slice(last);
        if (tail) lineParts.push({ type: "text", value: tail });
        if (lineParts.length === 0) lineParts.push({ type: "text", value: "" });
        return lineParts;
    });
}

function inlinePartsToParagraphChildren(
    lineParts: WordInlinePart[],
    options: { textBold?: boolean; size?: number } = {}
): ParagraphChild[] {
    const children: ParagraphChild[] = [];

    lineParts.forEach((part) => {
        if (part.type === "text") {
            if (!part.value) return;
            children.push(new TextRun({
                text: part.value,
                bold: options.textBold ?? false,
                size: options.size ?? WORD_BODY_SIZE,
                font: WORD_FONT,
            }));
            return;
        }

        const mathComponents =
            part.type === "math_latex"
                ? parseLatexToMathComponents(part.value)
                : parseMathMarkupToComponents(part.value);

        if (mathComponents.length > 0) {
            children.push(new DocxMath({ children: mathComponents }));
        }
    });

    if (children.length === 0) {
        children.push(new TextRun({
            text: " ",
            bold: options.textBold ?? false,
            size: options.size ?? WORD_BODY_SIZE,
            font: WORD_FONT,
        }));
    }

    return children;
}

function htmlToWordText(html: string): string {
    if (!html) return "";
    let result = replaceMathImagesWithText(html);

    result = result.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_, content) =>
        toSuperscript(cleanLatexForKatex(content))
    );
    result = result.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_, content) =>
        toSubscript(cleanLatexForKatex(content))
    );
    result = result.replace(
        /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/gi,
        (_, latex) => latexToUnicode(latex)
    );

    result = mathmlHtmlToText(result);

    result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) =>
        " " + latexToUnicode(latex) + " "
    );
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) =>
        latexToUnicode(latex)
    );
    result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) =>
        " " + latexToUnicode(latex) + " "
    );
    result = result.replace(/(?<!\$)\$([^\$\n]{1,200}?)\$(?!\$)/g, (_, latex) =>
        latexToUnicode(latex)
    );

    result = result
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)>\s*/gi, "\n")
        .replace(/<(td|th)[^>]*>/gi, " ")
        .replace(/<\/(td|th)>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\u00a0/g, " ");

    result = decodeHtmlEntities(result)
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return result;
}

function splitWordLines(text: string): string[] {
    if (!text) return [""];
    const normalized = text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!normalized) return [""];
    return normalized.split("\n");
}

function appendLabeledTextParagraphs(
    docChildren: Paragraph[],
    text: string,
    options: {
        label?: string;
        labelBold?: boolean;
        textBold?: boolean;
        size?: number;
        indentLeft?: number;
        continuationIndentLeft?: number;
        afterEach?: number;
        afterLast?: number;
    } = {}
): void {
    const lines = splitWordLines(text);
    const size = options.size ?? WORD_BODY_SIZE;
    const afterEach = options.afterEach ?? 20;
    const afterLast = options.afterLast ?? 80;

    lines.forEach((line, index) => {
        const runs: TextRun[] = [];
        if (index === 0 && options.label) {
            runs.push(
                new TextRun({
                    text: options.label,
                    bold: options.labelBold ?? true,
                    size,
                    font: WORD_FONT,
                })
            );
        }
        runs.push(
            new TextRun({
                text: line || " ",
                bold: options.textBold ?? false,
                size,
                font: WORD_FONT,
            })
        );

        const indentValue = index > 0
            ? options.continuationIndentLeft ?? options.indentLeft
            : options.indentLeft;

        docChildren.push(
            new Paragraph({
                children: runs,
                spacing: {
                    line: WORD_LINE_SPACING,
                    after: index === lines.length - 1 ? afterLast : afterEach,
                },
                indent: typeof indentValue === "number" ? { left: indentValue } : undefined,
            })
        );
    });
}

function appendLabeledHtmlParagraphs(
    docChildren: Paragraph[],
    html: string,
    options: {
        label?: string;
        labelBold?: boolean;
        textBold?: boolean;
        size?: number;
        indentLeft?: number;
        continuationIndentLeft?: number;
        afterEach?: number;
        afterLast?: number;
    } = {}
): void {
    const lines = htmlToWordInlineParts(html);
    const size = options.size ?? WORD_BODY_SIZE;
    const afterEach = options.afterEach ?? 20;
    const afterLast = options.afterLast ?? 80;

    lines.forEach((lineParts, index) => {
        const children: ParagraphChild[] = [];
        if (index === 0 && options.label) {
            children.push(
                new TextRun({
                    text: options.label,
                    bold: options.labelBold ?? true,
                    size,
                    font: WORD_FONT,
                })
            );
        }
        children.push(...inlinePartsToParagraphChildren(lineParts, {
            size,
            textBold: options.textBold,
        }));

        const indentValue = index > 0
            ? options.continuationIndentLeft ?? options.indentLeft
            : options.indentLeft;

        docChildren.push(
            new Paragraph({
                children,
                spacing: {
                    line: WORD_LINE_SPACING,
                    after: index === lines.length - 1 ? afterLast : afterEach,
                },
                indent: typeof indentValue === "number" ? { left: indentValue } : undefined,
            })
        );
    });
}

async function fetchAsBase64(url: string): Promise<string | null> {
    try {
        const absoluteUrl = url.startsWith("//") ? "https:" + url : url;
        const res = await fetch(absoluteUrl, { mode: "cors" });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

async function embedImagesAsBase64(html: string): Promise<string> {
    const matches = [...html.matchAll(/src=["']([^"']+)["']/gi)];
    const urls = [
        ...new Set(
            matches
                .map((m) => m[1])
                .filter((u) => u.startsWith("http") || u.startsWith("//"))
        ),
    ];
    if (urls.length === 0) return html;
    const base64Map: Record<string, string> = {};
    await Promise.allSettled(
        urls.map(async (url) => {
            const b64 = await fetchAsBase64(url);
            if (b64) base64Map[url] = b64;
        })
    );
    let result = html;
    for (const [url, b64] of Object.entries(base64Map)) {
        result = result.split(url).join(b64);
    }
    return result;
}

const SHARED_STYLES = `
  @import url("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css");
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 4mm; }
  body {
    font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
    font-size: 12pt;
    color: #111;
    background: #fff;
    padding: 4mm;
    line-height: 1.65;
  }
  h2 { font-size: 15pt; font-weight: 700; margin-bottom: 4px; }
  .test-wrapper { margin-bottom: 40px; }
  .test-header { border-bottom: 2px solid #222; padding-bottom: 10px; margin-bottom: 16px; }
  .test-meta { font-size: 10pt; color: #555; margin-top: 4px; }
  .instructions-box { border: 1px solid #bbb; border-radius: 6px; padding: 10px 14px; margin-bottom: 18px; background: #f9f9f9; }
  .instructions-text { font-size: 10.5pt; color: #333; white-space: pre-wrap; margin-top: 6px; }
  .section-title { font-size: 13pt; font-weight: 700; color: #111; margin-bottom: 10px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .questions-section { display: flex; flex-direction: column; gap: 18px; }
  .question-block { page-break-inside: avoid; display: flex; flex-direction: column; gap: 8px; padding: 10px 0; border-bottom: 1px solid #eee; }
  .question-row { display: block; }
  .q-number { display: inline-block; font-weight: 700; font-size: 10.5pt; margin-bottom: 4px; }
  .options-grid { margin-left: 0; display: flex; flex-direction: column; gap: 4px; }
  .options-grid.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .options-grid.split-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: start; }
  .options-col { display: grid; gap: 6px; min-width: 0; }
  .option-row { display: grid; grid-template-columns: 26px 1fr; gap: 6px; align-items: start; min-width: 0; }
  .opt-label { font-weight: 600; font-size: 10pt; color: #444; }
  .answer-box { padding: 2px 0; font-size: 10.5pt; color: #111; }
  .solution-box { padding: 2px 0; }
  .solution-label { font-size: 9.5pt; font-weight: 700; color: #111; margin-bottom: 4px; }
  .question-metadata { display: grid; grid-template-columns: repeat(auto-fit, minmax(34mm, 1fr)); gap: 3px 8px; margin: 5px 0 2px; padding: 5px 0; border-top: 1px dashed #cbd5e1; border-bottom: 1px dashed #cbd5e1; font-size: 8.8pt; line-height: 1.35; color: #333; }
  .metadata-pill { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .metadata-label { font-weight: 700; color: #111; }
  .answer-key-section, .solutions-section { margin-top: 30px; }
  .answer-key-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-top: 10px; }
  .answer-key-column { display: flex; flex-direction: column; gap: 4px; }
  .subject-label { font-weight: 700; font-size: 10.5pt; text-align: center; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .answer-entry { font-size: 10pt; padding-bottom: 3px; border-bottom: 1px dashed #ddd; }
  .solution-block { margin-bottom: 14px; page-break-inside: avoid; }
  .sol-num { font-weight: 700; font-size: 11pt; margin-bottom: 4px; }
  .page-break-before { page-break-before: always; }
  .test-wrapper.two-column-format .questions-section:not(.explicit-two-column-section) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px 4mm;
    align-items: start;
  }
  .test-wrapper.two-column-format .question-block {
    break-inside: avoid;
    page-break-inside: avoid;
    width: 100%;
  }
  .test-wrapper.two-column-format .questions-section > .section-title,
  .test-wrapper.two-column-format .questions-section > .subject-label {
    grid-column: 1 / -1;
  }
  .questions-section.explicit-two-column-section { display: block; }
  .pdf-two-column-group { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 7mm; align-items: start; margin-bottom: 8px; }
  .pdf-column { display: grid; gap: 8px; align-content: start; min-width: 0; }
  .pdf-column:first-child { padding-right: 2mm; }
  .pdf-column + .pdf-column { border-left: 1px solid #b8c0cc; padding-left: 5mm; }
  .question-html { font-size: 11pt; line-height: 1.65; color: #111; overflow-wrap: anywhere; word-break: break-word; min-width: 0; }
  .question-html p { margin: 0.2em 0; }
  .question-html img { max-width: 100%; height: auto; background: white; display: block; margin: 6px 0; }
  .question-html svg, .question-html canvas { max-width: 100% !important; height: auto !important; }
  .question-html table { border-collapse: collapse; margin: 4px 0; width: 100%; max-width: 100%; display: block; overflow-x: auto; white-space: normal; }
  .question-html th, .question-html td { border: 1px solid #aaa; padding: 3px 6px; font-size: 10pt; }
  .katex { color: #111 !important; font-size: 1em; white-space: normal; }
  .katex-html { color: #111 !important; }
  .katex svg { fill: #111 !important; }
  .katex-display { margin: 0.35em 0; overflow: visible; }
  .katex-display-wrapper { display: block; text-align: left; margin: 0.3em 0; overflow: visible; }
  .pdf-math-inline, .pdf-math-text { color: #111; font-family: 'Cambria Math', 'STIX Two Math', serif; }
  .question-html .katex-html { overflow: visible; }
  math { font-family: 'Cambria Math', 'STIX Two Math', serif; }
`;

type PDFQuestionRow = {
    html: string;
    fullWidth?: boolean;
};

function renderPDFQuestionRows(rows: PDFQuestionRow[], twoColumnFormat: boolean): string {
    if (!twoColumnFormat) {
        return `<div class="questions-section">${rows.map((row) => row.html).join("")}</div>`;
    }

    let html = `<div class="questions-section explicit-two-column-section">`;
    let columnBuffer: string[] = [];

    const flushColumnBuffer = () => {
        if (columnBuffer.length === 0) return;

        const splitIndex = Math.ceil(columnBuffer.length / 2);
        const leftColumn = columnBuffer.slice(0, splitIndex).join("");
        const rightColumn = columnBuffer.slice(splitIndex).join("");

        html += `<div class="pdf-two-column-group">
            <div class="pdf-column">${leftColumn}</div>
            <div class="pdf-column">${rightColumn}</div>
        </div>`;
        columnBuffer = [];
    };

    rows.forEach((row) => {
        if (row.fullWidth) {
            flushColumnBuffer();
            html += row.html;
            return;
        }

        columnBuffer.push(row.html);
    });

    flushColumnBuffer();
    html += `</div>`;
    return html;
}

function formatQuestionTypeLabel(questionType: string): string {
    return questionType
        .replace(/\(([^)]+)\)/g, " ($1)")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getPDFMetadataRows(
    question: Question,
    sectionSubject: string,
    includeMetadata: boolean,
    metadataFields: string[]
): Array<{ label: string; value: string }> {
    if (!includeMetadata || metadataFields.length === 0) return [];

    const values: Record<string, string> = {
        Subject: question.subject || sectionSubject || "-",
        Chapter: question.chapter || "-",
        Topic: question.topic || "-",
        Subtopic: question.subtopic || "-",
        Difficulty: question.difficutly_level || "-",
        Source: question.source || "-",
        "Question Type": formatQuestionTypeLabel(question.question_type || ""),
        Exam: Array.isArray(question.exam) && question.exam.length > 0 ? question.exam.join(", ") : "-",
        "Class Level": question.class_level || "-",
        "Question ID": question.question_id || "-",
        "QBG ID": question.qbg_id || "-",
    };

    return metadataFields
        .map((field) => ({ label: field, value: values[field] || "-" }))
        .filter((row) => row.value.trim().length > 0 && row.value !== "-");
}

function buildPDFBodyContent(
    tests: GeneratedTest[],
    contentMode: DownloadTestOptions["contentMode"],
    labelFormat: DownloadTestOptions["labelFormat"],
    deliveryMode: DownloadTestOptions["deliveryMode"],
    showAnswerKeyBeforeSolution: boolean,
    instructions: string,
    twoColumnFormat: boolean,
    includeMetadata: boolean,
    metadataFields: string[]
): string {
    let body = "";

    tests.forEach((test) => {
        const items = collectQuestionsFromTest(test);
        body += `<div class="test-wrapper ${twoColumnFormat ? "two-column-format" : ""}">
            <div class="test-header">
                <h2>${escapeHtml(test.batchName)} — Test ${test.testNumber}</h2>
                <div class="test-meta">${escapeHtml(test.examPreset.replace("_", " "))} · ${items.length} Questions${test.testDate ? ` · ${test.testDate}` : ""}</div>
            </div>`;

        if (instructions.trim()) {
            body += `<div class="instructions-box">
                <div class="section-title">Instructions</div>
                <div class="instructions-text">${escapeHtml(instructions)}</div>
            </div>`;
        }

        const questionRows: PDFQuestionRow[] = [];
        let currentSubjectForQuestionWise: string | null = null;
        let questionCounterForQuestionWise = 0;

        items.forEach((item, index) => {
            const { question } = item;
            if (deliveryMode === "QUESTION_WISE") {
                if (item.subject !== currentSubjectForQuestionWise) {
                    currentSubjectForQuestionWise = item.subject;
                    questionRows.push({
                        html: `<div class="subject-label">${escapeHtml(item.subject)}</div>`,
                        fullWidth: true,
                    });
                }
            }

            const qNum =
                deliveryMode === "QUESTION_WISE"
                    ? ++questionCounterForQuestionWise
                    : index + 1;
            const qHtml = preRenderMathForPDF(question.question_text || "");
            const options = (question.options || []).filter((o) => Boolean(o?.text));
            const answerKey = formatAnswerKey(question, labelFormat);
            const hasOptions = options.length > 0;
            const useBalancedOptionColumns = !twoColumnFormat && options.length >= 3;
            const splitIndex = options.length <= 3 ? 1 : Math.ceil(options.length / 2);

            const canTwoCol =
                !twoColumnFormat && hasOptions && options.length >= 2 && options.length <= 4 &&
                options.every((o) => {
                    const plain = (o.text || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
                    return plain.length <= 120 && !/<img|<table/i.test(o.text || "");
                });
            const metadataRows = getPDFMetadataRows(question, item.subject, includeMetadata, metadataFields);

            let questionHtml = `<div class="question-block">
                <div class="question-row">
                    <span class="q-number">${qNum}.</span>
                    <div class="q-text question-html">${qHtml}</div>
                </div>`;

            if (metadataRows.length > 0) {
                questionHtml += `<div class="question-metadata">`;
                metadataRows.forEach((row) => {
                    questionHtml += `<span class="metadata-pill"><span class="metadata-label">${escapeHtml(row.label)}:</span> ${escapeHtml(row.value)}</span>`;
                });
                questionHtml += `</div>`;
            }

            if (hasOptions) {
                if (useBalancedOptionColumns) {
                    const columns = [
                        options.slice(0, splitIndex).map((opt, localIndex) => ({
                            opt,
                            index: localIndex,
                        })),
                        options.slice(splitIndex).map((opt, localIndex) => ({
                            opt,
                            index: splitIndex + localIndex,
                        })),
                    ];
                    questionHtml += `<div class="options-grid split-cols">`;
                    columns.forEach((column) => {
                        questionHtml += `<div class="options-col">`;
                        column.forEach(({ opt, index }) => {
                            const optHtml = preRenderMathForPDF(opt.text || "");
                            questionHtml += `<div class="option-row">
                                <span class="opt-label">${getOptionLabel(index, labelFormat)}.</span>
                                <div class="opt-text question-html">${optHtml}</div>
                            </div>`;
                        });
                        questionHtml += `</div>`;
                    });
                    questionHtml += `</div>`;
                } else {
                    questionHtml += `<div class="options-grid ${canTwoCol ? "two-col" : "one-col"}">`;
                    options.forEach((opt, i) => {
                        const optHtml = preRenderMathForPDF(opt.text || "");
                        questionHtml += `<div class="option-row">
                            <span class="opt-label">${getOptionLabel(i, labelFormat)}.</span>
                            <div class="opt-text question-html">${optHtml}</div>
                        </div>`;
                    });
                    questionHtml += `</div>`;
                }
            }

            if (deliveryMode === "QUESTION_WISE" && contentMode !== "QUESTIONS_ONLY") {
                questionHtml += `<div class="answer-box"><strong>Answer:</strong> ${escapeHtml(answerKey)}</div>`;
                if (contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" && question.solution_text?.trim()) {
                    const solHtml = preRenderMathForPDF(question.solution_text);
                    questionHtml += `<div class="solution-box"><div class="solution-label">Solution</div><div class="question-html">${solHtml}</div></div>`;
                }
            }

            questionHtml += `</div>`;
            questionRows.push({ html: questionHtml });
        });

        body += renderPDFQuestionRows(questionRows, twoColumnFormat);

        if (contentMode !== "QUESTIONS_ONLY" && deliveryMode !== "QUESTION_WISE") {
            body += `<div class="answer-key-section page-break-before">
                <div class="section-title">Answer Key</div>
                <div class="answer-key-grid">`;

            const bySubject: Record<string, Array<{ qNum: number; answer: string }>> = {};
            items.forEach((item, i) => {
                const subj = item.subject || "General";
                if (!bySubject[subj]) bySubject[subj] = [];
                bySubject[subj].push({ qNum: i + 1, answer: formatAnswerKey(item.question, labelFormat) });
            });

            Object.entries(bySubject).forEach(([subject, entries]) => {
                body += `<div class="answer-key-column">`;
                if (Object.keys(bySubject).length > 1) {
                    body += `<div class="subject-label">${escapeHtml(subject)}</div>`;
                }
                entries.forEach(e => {
                    body += `<div class="answer-entry"><strong>${e.qNum}.</strong> ${escapeHtml(e.answer)}</div>`;
                });
                body += `</div>`;
            });

            body += `</div></div>`;

            if (contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION") {
                body += `<div class="solutions-section page-break-before">
                    <div class="section-title">Solutions</div>`;
                const solutionRows: PDFQuestionRow[] = [];
                items.forEach((item, i) => {
                    if (!item.question.solution_text?.trim()) return;
                    const ans = formatAnswerKey(item.question, labelFormat);
                    const solHtml = preRenderMathForPDF(item.question.solution_text);
                    solutionRows.push({
                        html: `<div class="solution-block">
                        <div class="sol-num">${i + 1}.</div>
                        ${showAnswerKeyBeforeSolution ? `<div class="answer-box"><strong>Answer:</strong> ${escapeHtml(ans)}</div>` : ""}
                        <div class="question-html">${solHtml}</div>
                    </div>`,
                    });
                });
                body += renderPDFQuestionRows(solutionRows, twoColumnFormat);
                body += `</div>`;
            }
        }

        body += `</div>`;
    });

    return body;
}

function sanitizeDownloadFilename(filename: string | undefined, fallback: string): string {
    const raw = (filename || fallback).trim() || fallback;
    return raw
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 120);
}

async function waitForImages(root: HTMLElement): Promise<void> {
    const images = Array.from(root.querySelectorAll("img"));
    await Promise.all(
        images.map(
            (img) =>
                new Promise<void>((resolve) => {
                    if (img.complete) {
                        resolve();
                        return;
                    }
                    img.onload = () => resolve();
                    img.onerror = () => resolve();
                })
        )
    );
}

async function waitForPDFLayout(root: HTMLElement): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));

    const katexNodes = root.querySelectorAll(".katex");
    if (katexNodes.length > 0 && document.fonts?.ready) {
        await document.fonts.ready;
    }
}

export async function downloadTestAsPDF(options: DownloadTestOptions): Promise<void> {
    const { tests, contentMode, labelFormat, deliveryMode, showAnswerKeyBeforeSolution, instructions, twoColumnFormat, includeMetadata, metadataFields, filename } = options;

    const bodyContent = await embedImagesAsBase64(buildPDFBodyContent(
        tests, contentMode, labelFormat, deliveryMode, showAnswerKeyBeforeSolution, instructions, twoColumnFormat, includeMetadata, metadataFields
    ));

    const [{ jsPDF }, html2canvasModule] = await Promise.all([
        import("jspdf"),
        import("html2canvas"),
    ]);
    const html2canvas = html2canvasModule.default;

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-10000px";
    container.style.top = "0";
    container.style.width = "210mm";
    container.style.minHeight = "297mm";
    container.style.background = "#ffffff";
    container.style.padding = "4mm";
    container.style.zIndex = "-1";
    container.style.fontFamily = "'Calibri', 'Segoe UI', Arial, sans-serif";
    container.innerHTML = `<style>${SHARED_STYLES}</style>${bodyContent}`;
    document.body.appendChild(container);

    try {
        if (document.fonts?.ready) {
            await document.fonts.ready;
        }
        await waitForImages(container);
        await waitForPDFLayout(container);

        const canvas = await html2canvas(container, {
            backgroundColor: "#ffffff",
            scale: 2,
            useCORS: true,
            allowTaint: false,
            windowWidth: container.scrollWidth,
            windowHeight: container.scrollHeight,
        });

        const pageWidthMm = 210;
        const pageHeightMm = Math.max(297, (canvas.height * pageWidthMm) / canvas.width);
        const pdf = new jsPDF({
            orientation: "p",
            unit: "mm",
            format: [pageWidthMm, pageHeightMm],
        });

        pdf.addImage(
            canvas.toDataURL("image/jpeg", 0.96),
            "JPEG",
            0,
            0,
            pageWidthMm,
            pageHeightMm
        );

        pdf.save(`${sanitizeDownloadFilename(filename, "Test_Paper")}.pdf`);
    } finally {
        container.remove();
    }
}

function buildWordBodyContent(
    tests: GeneratedTest[],
    contentMode: DownloadTestOptions["contentMode"],
    labelFormat: DownloadTestOptions["labelFormat"],
    deliveryMode: DownloadTestOptions["deliveryMode"],
    showAnswerKeyBeforeSolution: boolean,
    instructions: string
): string {
    let body = "";

    tests.forEach((test) => {
        const items = collectQuestionsFromTest(test);

        body += `<div class="test-wrapper">
            <div class="test-header">
                <h2>${escapeHtml(test.batchName)} — Test ${test.testNumber}</h2>
                <div class="test-meta">${escapeHtml(test.examPreset.replace("_", " "))} · ${items.length} Questions${test.testDate ? ` · ${test.testDate}` : ""}</div>
            </div>`;

        if (instructions.trim()) {
            body += `<div class="instructions-box">
                <div class="section-title">Instructions</div>
                <div class="instructions-text">${escapeHtml(instructions)}</div>
            </div>`;
        }

        body += `<div class="questions-section">`;

        items.forEach((item, index) => {
            const { question } = item;
            const qNum = index + 1;
            const qText = htmlToWordText(question.question_text || "");
            const options = (question.options || []).filter((o) => Boolean(o?.text));
            const answerKey = formatAnswerKey(question, labelFormat);
            const hasOptions = options.length > 0;

            body += `<div class="question-block">
                <div class="question-row">
                    <span class="q-number">${qNum}.</span>
                    <div class="q-text">${escapeHtml(qText)}</div>
                </div>`;

            if (hasOptions) {
                body += `<div class="options-grid one-col">`;
                options.forEach((opt, i) => {
                    const optText = htmlToWordText(opt.text || "");
                    body += `<div class="option-row">
                        <span class="opt-label">${getOptionLabel(i, labelFormat)}.</span>
                        <div class="opt-text">${escapeHtml(optText)}</div>
                    </div>`;
                });
                body += `</div>`;
            }

            body += `</div>`;
        });

        body += `</div>`;

        if (contentMode !== "QUESTIONS_ONLY") {
            body += `<div class="answer-key-section page-break-before">
                <div class="section-title">Answer Key</div>
                <div class="answer-key-grid">`;

            const bySubject: Record<string, Array<{ qNum: number; answer: string }>> = {};
            items.forEach((item, i) => {
                const subj = item.subject || "General";
                if (!bySubject[subj]) bySubject[subj] = [];
                bySubject[subj].push({ qNum: i + 1, answer: formatAnswerKey(item.question, labelFormat) });
            });

            Object.entries(bySubject).forEach(([subject, entries]) => {
                body += `<div class="answer-key-column">`;
                if (Object.keys(bySubject).length > 1) {
                    body += `<div class="subject-label">${escapeHtml(subject)}</div>`;
                }
                entries.forEach(e => {
                    body += `<div class="answer-entry"><strong>${e.qNum}.</strong> ${escapeHtml(e.answer)}</div>`;
                });
                body += `</div>`;
            });

            body += `</div></div>`;

            if (contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION") {
                body += `<div class="solutions-section page-break-before">
                    <div class="section-title">Solutions</div>`;
                items.forEach((item, i) => {
                    if (!item.question.solution_text?.trim()) return;
                    const ans = formatAnswerKey(item.question, labelFormat);
                    const solText = htmlToWordText(item.question.solution_text);
                    body += `<div class="solution-block">
                        <div class="sol-num">${i + 1}.</div>
                        ${showAnswerKeyBeforeSolution ? `<div class="answer-box"><strong>Answer:</strong> ${escapeHtml(ans)}</div>` : ""}
                        <div>${escapeHtml(solText)}</div>
                    </div>`;
                });
                body += `</div>`;
            }
        }

        body += `</div>`;
    });

    return body;
}

type WordImageType = "jpg" | "png" | "gif" | "bmp";

function parseDataUrlImage(dataUrl: string): { data: Uint8Array; type: WordImageType } | null {
    const headerMatch = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/i);
    if (!headerMatch) return null;

    const format = headerMatch[1].toLowerCase();
    const type: WordImageType | null =
        format === "jpeg" || format === "jpg" ? "jpg"
            : format === "png" ? "png"
                : format === "gif" ? "gif"
                    : format === "bmp" ? "bmp"
                        : null;
    if (!type) return null;

    const [, base64] = dataUrl.split(",", 2);
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { data: bytes, type };
}

async function extractImageDataUrls(html: string): Promise<string[]> {
    if (!html) return [];
    const withMathText = replaceMathImagesWithText(html);
    const withEmbedded = await embedImagesAsBase64(withMathText);
    const urls: string[] = [];
    const regex = /src=["'](data:image\/[^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(withEmbedded))) {
        urls.push(match[1]);
    }
    return urls;
}

async function getScaledImageTransformation(
    dataUrl: string,
    maxWidth: number,
    maxHeight: number
): Promise<{ width: number; height: number }> {
    return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const naturalWidth = Math.max(1, img.naturalWidth || maxWidth);
            const naturalHeight = Math.max(1, img.naturalHeight || maxHeight);
            const ratio = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
            resolve({
                width: Math.max(40, Math.round(naturalWidth * ratio)),
                height: Math.max(40, Math.round(naturalHeight * ratio)),
            });
        };
        img.onerror = () => resolve({ width: maxWidth, height: maxHeight });
        img.src = dataUrl;
    });
}

async function appendImageParagraphs(
    docChildren: Paragraph[],
    dataUrls: string[],
    maxWidth: number,
    maxHeight: number,
    options: { indentLeft?: number; afterEach?: number } = {}
): Promise<void> {
    for (const dataUrl of dataUrls) {
        const parsedImage = parseDataUrlImage(dataUrl);
        if (!parsedImage) continue;
        const transformation = await getScaledImageTransformation(dataUrl, maxWidth, maxHeight);
        docChildren.push(
            new Paragraph({
                children: [
                    new ImageRun({
                        type: parsedImage.type,
                        data: parsedImage.data,
                        transformation,
                    }),
                ],
                spacing: { after: options.afterEach ?? 80 },
                indent: typeof options.indentLeft === "number" ? { left: options.indentLeft } : undefined,
            })
        );
    }
}

export async function downloadTestAsDocx(options: DownloadTestOptions): Promise<void> {
    const { tests, contentMode, labelFormat, deliveryMode, showAnswerKeyBeforeSolution, twoColumnFormat, instructions, filename } = options;

    const docChildren: Paragraph[] = [];

    for (let testIndex = 0; testIndex < tests.length; testIndex++) {
        const test = tests[testIndex];
        const items = collectQuestionsFromTest(test);

        docChildren.push(
            new Paragraph({
                pageBreakBefore: testIndex > 0,
                children: [
                    new TextRun({
                        text: `${test.batchName} — Test ${test.testNumber}`,
                        bold: true,
                        size: WORD_TITLE_SIZE,
                        font: WORD_FONT,
                    }),
                ],
                spacing: { after: 200 },
            })
        );
        docChildren.push(
            new Paragraph({
                children: [
                    new TextRun({
                        text: `${test.examPreset.replace("_", " ")} · ${items.length} Questions${test.testDate ? ` · ${test.testDate}` : ""}`,
                        color: "555555",
                        size: WORD_META_SIZE,
                        font: WORD_FONT,
                    }),
                ],
                spacing: { after: 260 },
            })
        );

        if (instructions.trim()) {
            docChildren.push(
                new Paragraph({
                    children: [new TextRun({ text: "Instructions", bold: true, size: WORD_BODY_SIZE, font: WORD_FONT })],
                    spacing: { after: 120 },
                })
            );
            appendLabeledTextParagraphs(docChildren, instructions, {
                size: WORD_BODY_SIZE,
                afterLast: 260,
            });
        }

        let currentPaperForQuestionWise: string | null = null;
        let currentSubjectForQuestionWise: string | null = null;
        let questionCounterForCurrentPaper = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const { question } = item;

            if (deliveryMode === "QUESTION_WISE") {
                if (item.paper && item.paper !== currentPaperForQuestionWise) {
                    const hasPreviousPaper = currentPaperForQuestionWise !== null;
                    currentPaperForQuestionWise = item.paper;
                    currentSubjectForQuestionWise = null;
                    questionCounterForCurrentPaper = 0;
                    docChildren.push(
                        new Paragraph({
                            pageBreakBefore: hasPreviousPaper,
                            children: [
                                new TextRun({
                                    text: item.paper,
                                    bold: true,
                                    size: WORD_BODY_SIZE,
                                    font: WORD_FONT,
                                }),
                            ],
                            alignment: "center",
                            spacing: { after: 120 },
                        })
                    );
                }

                if (item.subject !== currentSubjectForQuestionWise) {
                    currentSubjectForQuestionWise = item.subject;
                    docChildren.push(
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: item.subject,
                                    bold: true,
                                    size: WORD_BODY_SIZE,
                                    font: WORD_FONT,
                                }),
                            ],
                            alignment: "center",
                            spacing: { after: 100 },
                        })
                    );
                }
            }

            const qNum =
                deliveryMode === "QUESTION_WISE"
                    ? ++questionCounterForCurrentPaper
                    : index + 1;
            const optionItems = (question.options || []).filter((o) => Boolean(o?.text));
            const answerKey = formatAnswerKey(question, labelFormat);
            const hasOptions = optionItems.length > 0;

            const qHtml = question.question_text || "";
            const qImages = await extractImageDataUrls(qHtml);

            appendLabeledHtmlParagraphs(docChildren, qHtml, {
                label: `${qNum}. `,
                labelBold: true,
                size: WORD_BODY_SIZE,
                afterLast: 80,
            });
            await appendImageParagraphs(docChildren, qImages, 500, 340, { afterEach: 80 });

            if (hasOptions) {
                for (let i = 0; i < optionItems.length; i++) {
                    const opt = optionItems[i];
                    const optHtml = opt.text || "";
                    const optImages = await extractImageDataUrls(optHtml);

                    appendLabeledHtmlParagraphs(docChildren, optHtml, {
                        label: `${getOptionLabel(i, labelFormat)}. `,
                        labelBold: true,
                        size: WORD_BODY_SIZE,
                        indentLeft: 280,
                        continuationIndentLeft: 280,
                        afterLast: 40,
                    });
                    await appendImageParagraphs(docChildren, optImages, 420, 280, {
                        indentLeft: 280,
                        afterEach: 60,
                    });
                }
            }

            if (deliveryMode === "QUESTION_WISE" && contentMode !== "QUESTIONS_ONLY") {
                appendLabeledTextParagraphs(docChildren, answerKey, {
                    label: "Answer: ",
                    labelBold: true,
                    size: WORD_BODY_SIZE,
                    afterLast: 80,
                });

                if (contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION" && question.solution_text?.trim()) {
                    const solutionHtml = question.solution_text;
                    const solImages = await extractImageDataUrls(solutionHtml);

                    appendLabeledHtmlParagraphs(docChildren, solutionHtml, {
                        label: "Solution: ",
                        labelBold: true,
                        size: WORD_BODY_SIZE,
                        afterLast: 80,
                    });
                    await appendImageParagraphs(docChildren, solImages, 420, 300, { afterEach: 80 });
                }
            }

            docChildren.push(new Paragraph({ spacing: { after: 40 } }));
        }

        if (contentMode !== "QUESTIONS_ONLY") {
            docChildren.push(
                new Paragraph({
                    pageBreakBefore: true,
                    children: [
                        new TextRun({
                            text: "Answer Key",
                            bold: true,
                            size: WORD_TITLE_SIZE,
                            font: WORD_FONT,
                        }),
                    ],
                    spacing: { after: 160 },
                })
            );

            const bySubject: Record<string, Array<{ qNum: number; answer: string }>> = {};
            items.forEach((item, i) => {
                const subj = item.subject || "General";
                if (!bySubject[subj]) bySubject[subj] = [];
                bySubject[subj].push({ qNum: i + 1, answer: formatAnswerKey(item.question, labelFormat) });
            });

            for (const [subject, entries] of Object.entries(bySubject)) {
                if (Object.keys(bySubject).length > 1) {
                    docChildren.push(
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: subject,
                                    bold: true,
                                    size: WORD_BODY_SIZE,
                                    font: WORD_FONT,
                                }),
                            ],
                            spacing: { after: 80 },
                        })
                    );
                }

                for (const entry of entries) {
                    appendLabeledTextParagraphs(docChildren, entry.answer, {
                        label: `${entry.qNum}. `,
                        size: WORD_BODY_SIZE,
                        afterLast: 40,
                    });
                }
                docChildren.push(new Paragraph({ spacing: { after: 80 } }));
            }

            if (contentMode === "QUESTIONS_ANSWER_KEY_SOLUTION") {
                docChildren.push(
                    new Paragraph({
                        pageBreakBefore: true,
                        children: [
                            new TextRun({
                                text: "Solutions",
                                bold: true,
                                size: WORD_TITLE_SIZE,
                                font: WORD_FONT,
                            }),
                        ],
                        spacing: { after: 160 },
                    })
                );

                for (let i = 0; i < items.length; i++) {
                    const question = items[i].question;
                    if (!question.solution_text?.trim()) continue;
                    const answer = formatAnswerKey(question, labelFormat);
                    const solutionHtml = question.solution_text;
                    const solutionImages = await extractImageDataUrls(solutionHtml);

                    appendLabeledTextParagraphs(docChildren, "", {
                        label: `${i + 1}. `,
                        labelBold: true,
                        size: WORD_BODY_SIZE,
                        afterLast: 20,
                    });

                    if (showAnswerKeyBeforeSolution) {
                        appendLabeledTextParagraphs(docChildren, answer, {
                            label: "Answer: ",
                            labelBold: true,
                            size: WORD_BODY_SIZE,
                            indentLeft: 220,
                            continuationIndentLeft: 220,
                            afterLast: 40,
                        });
                    }

                    appendLabeledHtmlParagraphs(docChildren, solutionHtml, {
                        label: "Solution: ",
                        labelBold: true,
                        size: WORD_BODY_SIZE,
                        indentLeft: 220,
                        continuationIndentLeft: 220,
                        afterLast: 80,
                    });
                    await appendImageParagraphs(docChildren, solutionImages, 420, 300, {
                        indentLeft: 220,
                        afterEach: 80,
                    });
                }
            }
        }
    }

    const doc = new Document({
        styles: {
            default: {
                document: {
                    run: {
                        font: WORD_FONT,
                        size: WORD_BODY_SIZE,
                    },
                    paragraph: {
                        spacing: {
                            line: WORD_LINE_SPACING,
                        },
                    },
                },
            },
        },
        sections: [
            {
                properties: twoColumnFormat
                    ? {
                          column: {
                              space: 708,
                              count: 2,
                              separate: true,
                          },
                          page: {
                              margin: {
                                  top: 340,
                                  right: 340,
                                  bottom: 340,
                                  left: 340,
                              },
                          },
                      }
                    : undefined,
                children: docChildren,
            },
        ],
    });

    const blob = await Packer.toBlob(doc);
    const safeName = filename ? `${filename}.docx` : "test-paper.docx";
    saveAs(blob, safeName);
}
