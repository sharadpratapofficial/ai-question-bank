/**
 * Component symbols, drawn as plain SVG.
 *
 * Each body is drawn in a local frame: the wire runs along +x, the body is centred
 * on the origin and spans -bodyPx/2 .. +bodyPx/2, and y is screen-down (so "above
 * the wire" is negative y). The canvas supplies the translate+rotate.
 *
 * Two symbol sets are supported, matching circuitikz's own package options:
 *   "iec"      — european/IEC: the rectangular resistor Indian school texts use
 *   "american" — the zigzag resistor
 * Everything else (cells, sources, meters, switches) is drawn the same way in
 * both, which is also how NCERT/CBSE/JEE books draw them.
 */

import React from "react";
import { ComponentKind, SymbolStyle, spec } from "./types";

/* ------------------------------------------------------------------ labels -- */

const GREEK: Record<string, string> = {
    Omega: "Ω", omega: "ω", mu: "μ", alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ",
    Delta: "Δ", delta: "δ", theta: "θ", Theta: "Θ", phi: "φ", Phi: "Φ", varphi: "φ",
    epsilon: "ε", varepsilon: "ε", lambda: "λ", Lambda: "Λ", pi: "π", Pi: "Π",
    rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", eta: "η", nu: "ν", psi: "ψ", Psi: "Ψ",
    xi: "ξ", zeta: "ζ", kappa: "κ", chi: "χ",
};

const SYMS: Record<string, string> = {
    times: "×", cdot: "·", pm: "±", mp: "∓", infty: "∞", degree: "°", circ: "°",
    ohm: "Ω", approx: "≈", neq: "≠", leq: "≤", geq: "≥", ll: "≪", gg: "≫",
    rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", ldots: "…", dots: "…",
    sim: "∼", propto: "∝", partial: "∂", nabla: "∇", prime: "′",
};

const FONT_CMDS = ["mathrm", "text", "mathbf", "mathit", "mathsf", "mathtt", "textrm", "textbf", "operatorname"];

const SUB: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇",
    "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ",
    p: "ₚ", s: "ₛ", t: "ₜ", i: "ᵢ", j: "ⱼ", r: "ᵣ", u: "ᵤ", v: "ᵥ",
};

const SUP: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷",
    "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    n: "ⁿ", i: "ⁱ",
};

/** Read the argument after a command: `{...}` or a single character. */
function readArg(s: string, i: number): [string, number] {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (s[i] === "{") {
        let depth = 0;
        for (let j = i; j < s.length; j++) {
            if (s[j] === "\\") {
                j += 1;
                continue;
            }
            if (s[j] === "{") depth += 1;
            else if (s[j] === "}") {
                depth -= 1;
                if (depth === 0) return [s.slice(i + 1, j), j + 1];
            }
        }
        return [s.slice(i + 1), s.length];
    }
    if (i < s.length && s[i] === "\\") {
        const m = /^\\[A-Za-z]+/.exec(s.slice(i));
        if (m) return [m[0], i + m[0].length];
    }
    return [s.slice(i, i + 1), i + 1];
}

function mapScript(text: string, table: Record<string, string>): string | null {
    let out = "";
    for (const ch of text) {
        const m = table[ch];
        if (!m) return null;
        out += m;
    }
    return out;
}

/** One styled piece of a rendered label. */
export interface TextRun {
    text: string;
    italic: boolean;
    bold: boolean;
}

const UPRIGHT_CMDS = ["mathrm", "text", "textrm", "mathsf", "mathtt", "operatorname"];
const BOLD_CMDS = ["mathbf", "textbf", "bm", "boldsymbol"];

/**
 * A small LaTeX subset -> styled Unicode runs, so labels render as crisp SVG
 * `<text>`/`<tspan>` and the PNG export stays pixel-identical to the canvas (real
 * KaTeX markup in a `<foreignObject>` does not survive rasterisation).
 *
 * Italics follow LaTeX's own maths rules rather than being applied wholesale:
 * single Latin letters and lowercase Greek are variables and slant, while digits,
 * units, punctuation, uppercase Greek and anything inside `\mathrm`/`\text` stay
 * upright. That is why `12\,\mathrm{V}` reads as upright "12 V" and `R` slants.
 * Anything it cannot convert is left as written rather than dropped.
 */
export function latexLabelToRuns(latex: string, mathMode = true): TextRun[] {
    const runs: TextRun[] = [];
    if (!latex) return runs;

    const push = (text: string, italic: boolean, bold: boolean) => {
        if (!text) return;
        const last = runs[runs.length - 1];
        if (last && last.italic === italic && last.bold === bold) last.text += text;
        else runs.push({ text, italic, bold });
    };

    const walk = (src: string, upright: boolean, bold: boolean) => {
        const s = src.replace(/\$/g, "");
        let i = 0;
        while (i < s.length) {
            const ch = s[i];

            if (ch === "\\") {
                const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
                if (m) {
                    const name = m[1];
                    const j = i + m[0].length;
                    if (UPRIGHT_CMDS.includes(name)) {
                        const [arg, after] = readArg(s, j);
                        walk(arg, true, bold);
                        i = after;
                        continue;
                    }
                    if (BOLD_CMDS.includes(name)) {
                        const [arg, after] = readArg(s, j);
                        walk(arg, upright, true);
                        i = after;
                        continue;
                    }
                    if (name === "mathit" || name === "textit") {
                        const [arg, after] = readArg(s, j);
                        walk(arg, false, bold);
                        i = after;
                        continue;
                    }
                    if (name === "frac" || name === "dfrac" || name === "tfrac") {
                        const [a, afterA] = readArg(s, j);
                        const [b, afterB] = readArg(s, afterA);
                        walk(a, upright, bold);
                        push("/", true, bold);
                        walk(b, upright, bold);
                        i = afterB;
                        continue;
                    }
                    if (name === "sqrt") {
                        const [a, afterA] = readArg(s, j);
                        push("√(", true, bold);
                        walk(a, upright, bold);
                        push(")", true, bold);
                        i = afterA;
                        continue;
                    }
                    if (GREEK[name]) {
                        // LaTeX slants lowercase Greek and leaves the capitals upright.
                        const isLower = name[0] === name[0].toLowerCase();
                        push(GREEK[name], !upright && mathMode && isLower, bold);
                        i = j;
                        if (s[i] === " ") i += 1;
                        continue;
                    }
                    if (SYMS[name]) {
                        push(SYMS[name], false, bold);
                        i = j;
                        if (s[i] === " ") i += 1;
                        continue;
                    }
                    // Unknown command: emit its name so nothing silently disappears.
                    push(name, !upright && mathMode, bold);
                    i = j;
                    continue;
                }
                const next = s[i + 1];
                if (next === "," || next === ";" || next === ":" || next === " ") {
                    push(" ", false, bold);
                    i += 2;
                    continue;
                }
                if (next === "!") {
                    i += 2;
                    continue;
                }
                push(next ?? "", false, bold);
                i += 2;
                continue;
            }

            if (ch === "_" || ch === "^") {
                const [arg, after] = readArg(s, i + 1);
                const plain = latexLabelToText(arg);
                const mapped = mapScript(plain, ch === "_" ? SUB : SUP);
                push(mapped ?? `${ch}${plain}`, false, bold);
                i = after;
                continue;
            }

            if (ch === "{" || ch === "}") {
                i += 1;
                continue;
            }

            // Letters are variables (italic); digits, spaces and punctuation are not.
            const isLetter = /[A-Za-z]/.test(ch);
            push(ch, isLetter && !upright && mathMode, bold);
            i += 1;
        }
    };

    walk(latex, !mathMode, false);
    return runs;
}

/** Plain-text form of a label — the runs joined, styling discarded. */
export function latexLabelToText(latex: string): string {
    return latexLabelToRuns(latex)
        .map((r) => r.text)
        .join("");
}

/* ----------------------------------------------------------------- symbols -- */

export function bodyPx(kind: ComponentKind, u: number): number {
    return spec(kind).bodyLength * u;
}

interface Ctx {
    u: number;
    sw: number;
    color: string;
}

function circleWithText(text: string, r: number, c: Ctx): React.ReactNode {
    return (
        <>
            <circle cx={0} cy={0} r={r} fill="none" stroke={c.color} strokeWidth={c.sw} />
            <text
                x={0}
                y={0}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={r * 1.2}
                fontFamily="Georgia, 'Times New Roman', serif"
                fontStyle="italic"
                fill={c.color}
            >
                {text}
            </text>
        </>
    );
}

/**
 * Body for one component. `L` is the body length in px; the caller draws the
 * leads from each terminal up to ±L/2.
 */
export function renderBody(kind: ComponentKind, style: SymbolStyle, u: number, sw: number, color: string): React.ReactNode {
    const c: Ctx = { u, sw, color };
    const L = bodyPx(kind, u);
    const half = L / 2;
    const stroke = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

    switch (kind) {
        case "wire":
            return null;

        case "resistor": {
            if (style === "iec") {
                const h = 0.19 * u;
                return <rect x={-half} y={-h} width={L} height={2 * h} {...stroke} fill="none" />;
            }
            const a = 0.17 * u;
            const seg = L / 6;
            const pts: string[] = [`${-half},0`];
            const ys = [-a, a, -a, a, -a, a];
            for (let k = 0; k < 6; k++) pts.push(`${-half + seg / 2 + k * seg},${ys[k]}`);
            pts.push(`${half},0`);
            return <polyline points={pts.join(" ")} {...stroke} />;
        }

        case "rheostat": {
            const h = 0.19 * u;
            const body =
                style === "iec" ? (
                    <rect x={-half} y={-h} width={L} height={2 * h} {...stroke} />
                ) : (
                    (() => {
                        const a = 0.17 * u;
                        const seg = L / 6;
                        const pts: string[] = [`${-half},0`];
                        const ys = [-a, a, -a, a, -a, a];
                        for (let k = 0; k < 6; k++) pts.push(`${-half + seg / 2 + k * seg},${ys[k]}`);
                        pts.push(`${half},0`);
                        return <polyline points={pts.join(" ")} {...stroke} />;
                    })()
                );
            const ah = 0.34 * u;
            return (
                <>
                    {body}
                    <line x1={-half * 0.9} y1={ah} x2={half * 0.9} y2={-ah} {...stroke} />
                    <polygon
                        points={`${half * 0.9},${-ah} ${half * 0.9 - 0.11 * u},${-ah + 0.05 * u} ${half * 0.9 - 0.04 * u},${-ah + 0.13 * u}`}
                        fill={color}
                        stroke="none"
                    />
                </>
            );
        }

        case "capacitor": {
            const h = 0.3 * u;
            const g = L / 2;
            return (
                <>
                    <line x1={-g} y1={-h} x2={-g} y2={h} {...stroke} />
                    <line x1={g} y1={-h} x2={g} y2={h} {...stroke} />
                </>
            );
        }

        case "inductor": {
            const n = 4;
            const w = L / n;
            const r = w / 2;
            let d = `M ${-half} 0`;
            for (let k = 0; k < n; k++) {
                const x0 = -half + k * w;
                // sweep 0 bulges upward, because y is screen-down here
                d += ` A ${r} ${r} 0 0 1 ${x0 + w} 0`;
            }
            return <path d={d} {...stroke} transform="scale(1,-1)" />;
        }

        case "cell": {
            const longH = 0.32 * u;
            const shortH = 0.17 * u;
            const g = L / 2;
            return (
                <>
                    <line x1={-g} y1={-longH} x2={-g} y2={longH} {...stroke} />
                    <line x1={g} y1={-shortH} x2={g} y2={shortH} {...stroke} strokeWidth={sw * 2.2} />
                </>
            );
        }

        case "battery": {
            const longH = 0.32 * u;
            const shortH = 0.17 * u;
            const g = L / 2;
            const q = L / 6;
            return (
                <>
                    <line x1={-g} y1={-longH} x2={-g} y2={longH} {...stroke} />
                    <line x1={-q} y1={-shortH} x2={-q} y2={shortH} {...stroke} strokeWidth={sw * 2.2} />
                    <line x1={q} y1={-longH} x2={q} y2={longH} {...stroke} />
                    <line x1={g} y1={-shortH} x2={g} y2={shortH} {...stroke} strokeWidth={sw * 2.2} />
                </>
            );
        }

        case "dc_source": {
            const r = L / 2;
            const s = 0.1 * u;
            return (
                <>
                    <circle cx={0} cy={0} r={r} {...stroke} />
                    <line x1={-r * 0.5 - s} y1={0} x2={-r * 0.5 + s} y2={0} {...stroke} />
                    <line x1={-r * 0.5} y1={-s} x2={-r * 0.5} y2={s} {...stroke} />
                    <line x1={r * 0.5 - s} y1={0} x2={r * 0.5 + s} y2={0} {...stroke} />
                </>
            );
        }

        case "ac_source": {
            const r = L / 2;
            const a = r * 0.45;
            const w = r * 1.1;
            return (
                <>
                    <circle cx={0} cy={0} r={r} {...stroke} />
                    <path
                        d={`M ${-w / 2} 0 Q ${-w / 4} ${-a * 1.6} 0 0 Q ${w / 4} ${a * 1.6} ${w / 2} 0`}
                        {...stroke}
                    />
                </>
            );
        }

        case "bulb": {
            const r = L / 2;
            const d = r * Math.SQRT1_2;
            return (
                <>
                    <circle cx={0} cy={0} r={r} {...stroke} />
                    <line x1={-d} y1={-d} x2={d} y2={d} {...stroke} />
                    <line x1={-d} y1={d} x2={d} y2={-d} {...stroke} />
                </>
            );
        }

        case "switch_open": {
            const r = 0.055 * u;
            const g = L / 2;
            return (
                <>
                    <circle cx={-g} cy={0} r={r} fill={color} stroke="none" />
                    <circle cx={g} cy={0} r={r} fill={color} stroke="none" />
                    <line x1={-g} y1={0} x2={g * 0.85} y2={-0.34 * u} {...stroke} />
                </>
            );
        }

        case "switch_closed": {
            const r = 0.055 * u;
            const g = L / 2;
            return (
                <>
                    <circle cx={-g} cy={0} r={r} fill={color} stroke="none" />
                    <circle cx={g} cy={0} r={r} fill={color} stroke="none" />
                    <line x1={-g} y1={0} x2={g} y2={-0.1 * u} {...stroke} />
                </>
            );
        }

        case "ammeter":
            return circleWithText("A", L / 2, c);
        case "voltmeter":
            return circleWithText("V", L / 2, c);
        case "galvanometer":
            return circleWithText("G", L / 2, c);

        case "diode": {
            const h = 0.22 * u;
            return (
                <>
                    <polygon points={`${-half},${-h} ${-half},${h} ${half},0`} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
                    <line x1={half} y1={-h} x2={half} y2={h} {...stroke} />
                </>
            );
        }

        case "led": {
            const h = 0.22 * u;
            const arrow = (dx: number) => (
                <>
                    <line x1={dx} y1={-h * 1.2} x2={dx + 0.13 * u} y2={-h * 2.1} {...stroke} />
                    <polygon
                        points={`${dx + 0.13 * u},${-h * 2.1} ${dx + 0.05 * u},${-h * 1.75} ${dx + 0.11 * u},${-h * 1.42}`}
                        fill={color}
                        stroke="none"
                    />
                </>
            );
            return (
                <>
                    <polygon points={`${-half},${-h} ${-half},${h} ${half},0`} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
                    <line x1={half} y1={-h} x2={half} y2={h} {...stroke} />
                    {arrow(-0.1 * u)}
                    {arrow(0.12 * u)}
                </>
            );
        }

        default:
            return null;
    }
}

/**
 * The ground symbol. Unlike every other component this is drawn axis-aligned at
 * the terminal (bars horizontal, stack going down) no matter which way the wire
 * runs — same as circuitikz's `node[ground]`.
 */
export function renderGround(u: number, sw: number, color: string): React.ReactNode {
    const stroke = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const };
    const w = 0.34 * u;
    return (
        <>
            <line x1={-w} y1={0} x2={w} y2={0} {...stroke} />
            <line x1={-w * 0.62} y1={0.1 * u} x2={w * 0.62} y2={0.1 * u} {...stroke} />
            <line x1={-w * 0.28} y1={0.2 * u} x2={w * 0.28} y2={0.2 * u} {...stroke} />
        </>
    );
}

/** Small preview used by the palette buttons. */
export function PalettePreview({ kind, style, color }: { kind: ComponentKind; style: SymbolStyle; color: string }) {
    const u = 42;
    const w = 60;
    const h = 30;
    const L = kind === "ground" ? 0 : bodyPx(kind, u);
    return (
        <svg width={w} height={h} viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} aria-hidden>
            {kind === "ground" ? (
                <g>
                    <line x1={0} y1={-10} x2={0} y2={-2} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
                    <g transform="translate(0,-2)">{renderGround(u, 1.6, color)}</g>
                </g>
            ) : (
                <>
                    <line x1={-w / 2 + 4} y1={0} x2={-L / 2} y2={0} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
                    <line x1={L / 2} y1={0} x2={w / 2 - 4} y2={0} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
                    {renderBody(kind, style, u, 1.6, color)}
                </>
            )}
        </svg>
    );
}
