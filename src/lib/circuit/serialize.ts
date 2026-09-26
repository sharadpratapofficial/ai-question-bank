/**
 * Circuit model -> CircuiTikZ source.
 *
 * Runs of components that meet end-to-end at a node used by exactly two elements
 * are merged into one `\draw ... to[...] ... to[...] ...;` statement, so generated
 * code reads the way a person would have written it rather than one `\draw` per
 * component.
 */

import {
    Circuit,
    CircuitElement,
    CircuitNode,
    CircuitText,
    DEFAULT_FONT_SIZE_PT,
    FONT_FAMILIES,
    TextStyle,
    isDefaultStyle,
    spec,
} from "./types";

function num(n: number): string {
    const r = Math.round(n * 1000) / 1000;
    if (Object.is(r, -0)) return "0";
    return String(r);
}

function pointRef(n: CircuitNode): string {
    return n.name ? `(${n.name})` : `(${num(n.x)},${num(n.y)})`;
}

/** The LaTeX font switches for a style, e.g. `\\sffamily\\bfseries`. */
function styleCommands(st: TextStyle): string {
    const bits: string[] = [];
    if (Math.abs(st.fontSizePt - DEFAULT_FONT_SIZE_PT) > 0.01) {
        bits.push(`\\fontsize{${num(st.fontSizePt)}}{${num(Math.round(st.fontSizePt * 1.2 * 10) / 10)}}\\selectfont`);
    }
    const fam = FONT_FAMILIES.find((f) => f.id === st.fontFamily);
    if (fam && fam.id !== "serif") bits.push(fam.tex);
    if (st.bold) bits.push("\\bfseries");
    if (st.italic) bits.push("\\itshape");
    if (st.color && st.color !== "black") bits.push(`\\color{${st.color}}`);
    return bits.join("");
}

function labelOpt(e: CircuitElement): string | null {
    if (!e.label) return null;
    const key = e.labelSide === "below" ? "l_" : "l";
    const st = e.labelStyle;
    // A default-styled label stays in its plain, familiar `l=$...$` form.
    if (isDefaultStyle(st)) return `${key}=$${e.label}$`;
    const body = st && st.upright ? `\\mathrm{${e.label}}` : e.label;
    const cmds = styleCommands(st!);
    return `${key}={${cmds}$${body}$}`;
}

/** The `to[...]` option list for one element, in circuitikz order. */
function toOptions(e: CircuitElement, reversed: boolean): string {
    const s = spec(e.kind);
    const opts: string[] = [e.kind === "ground" ? "short" : s.tikzKey];
    // Traversing a polarised component backwards would flip how it draws, so the
    // inversion is toggled to keep the rendered orientation identical.
    const invert = Boolean(e.invert) !== (reversed && isPolarised(e));
    if (invert) opts.push("invert");
    // Only supply the meter letter if the imported options didn't already carry one.
    if (e.kind === "galvanometer" && !(e.extraOpts || []).some((o) => /^t\s*=/.test(o))) opts.push("t=$G$");
    const l = labelOpt(e);
    if (l) opts.push(l);
    if (e.extraOpts) opts.push(...e.extraOpts);
    return opts.join(",");
}

function isPolarised(e: CircuitElement): boolean {
    return (
        e.kind === "cell" ||
        e.kind === "battery" ||
        e.kind === "dc_source" ||
        e.kind === "diode" ||
        e.kind === "led"
    );
}

interface Step {
    element: CircuitElement;
    reversed: boolean;
    /** Node the step arrives at. */
    to: CircuitNode;
}

interface Chain {
    start: CircuitNode;
    steps: Step[];
}

function buildChains(c: Circuit): Chain[] {
    const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
    const touching = new Map<string, CircuitElement[]>();
    for (const e of c.elements) {
        for (const id of [e.from, e.to]) {
            const list = touching.get(id) || [];
            list.push(e);
            touching.set(id, list);
        }
    }

    const used = new Set<string>();
    const chains: Chain[] = [];

    /** The single other element at `nodeId`, if the node joins exactly two. */
    const continuation = (nodeId: string, fromElement: CircuitElement): CircuitElement | null => {
        const list = touching.get(nodeId) || [];
        if (list.length !== 2) return null;
        const other = list.find((x) => x.id !== fromElement.id);
        if (!other || used.has(other.id)) return null;
        // A self-loop can't chain.
        if (other.from === other.to) return null;
        return other;
    };

    for (const seed of c.elements) {
        if (used.has(seed.id)) continue;
        used.add(seed.id);

        const startNode = nodeById.get(seed.from);
        const endNode = nodeById.get(seed.to);
        if (!startNode || !endNode) continue;

        const steps: Step[] = [{ element: seed, reversed: false, to: endNode }];
        let head = startNode; // grows backwards
        let tail = endNode; // grows forwards

        // Forward — a ground terminates the run.
        let guard = 0;
        while (steps[steps.length - 1].element.kind !== "ground" && guard++ < 500) {
            const last = steps[steps.length - 1].element;
            const next = continuation(tail.id, last);
            if (!next) break;
            const reversed = next.to === tail.id;
            const nextTo = nodeById.get(reversed ? next.from : next.to);
            if (!nextTo) break;
            used.add(next.id);
            steps.push({ element: next, reversed, to: nextTo });
            tail = nextTo;
        }

        // Backwards.
        guard = 0;
        while (guard++ < 500) {
            const first = steps[0].element;
            const prev = continuation(head.id, first);
            if (!prev) break;
            if (prev.kind === "ground") break; // a ground can only end a run
            const reversed = prev.from === head.id;
            const prevFrom = nodeById.get(reversed ? prev.to : prev.from);
            if (!prevFrom) break;
            used.add(prev.id);
            steps.unshift({ element: prev, reversed, to: head });
            head = prevFrom;
        }

        chains.push({ start: head, steps });
    }

    return chains;
}

/** `font=` contents for a text node — omitted entirely when everything is default. */
function fontOption(t: CircuitText): string | null {
    const bits: string[] = [];
    if (Math.abs(t.fontSizePt - DEFAULT_FONT_SIZE_PT) > 0.01) {
        bits.push(`\\fontsize{${num(t.fontSizePt)}}{${num(Math.round(t.fontSizePt * 1.2 * 10) / 10)}}\\selectfont`);
    }
    const fam = FONT_FAMILIES.find((f) => f.id === t.fontFamily);
    if (fam && fam.id !== "serif") bits.push(fam.tex);
    if (t.bold) bits.push("\\bfseries");
    // Math text is already italic in LaTeX, so only ask for it on upright text.
    if (t.italic && !t.math) bits.push("\\itshape");
    return bits.length ? `font=${bits.join("")}` : null;
}

/** One `\node[...] at (...) {...};` for a text object. */
export function textStatement(t: CircuitText, nodeById: Map<string, CircuitNode>): string {
    const opts: string[] = [];
    if (t.anchor !== "center") {
        opts.push(t.offsetPt ? `${t.anchor}=${num(t.offsetPt)}pt` : t.anchor);
    }
    const f = fontOption(t);
    if (f) opts.push(f);
    if (t.color && t.color !== "black") opts.push(`text=${t.color}`);
    if (t.rotation) opts.push(`rotate=${num(t.rotation)}`);
    if (t.dx) opts.push(`xshift=${num(t.dx)}cm`);
    if (t.dy) opts.push(`yshift=${num(t.dy)}cm`);

    const anchored = t.nodeId ? nodeById.get(t.nodeId) : undefined;
    const at = anchored ? pointRef(anchored) : `(${num(t.x)},${num(t.y)})`;
    const body = t.math ? `$${t.text}$` : t.text;
    const optStr = opts.length ? `[${opts.join(",")}]` : "";
    return `\\node${optStr} at ${at} {${body}};`;
}

export function serializeCircuit(c: Circuit): string {
    const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
    const lines: string[] = [];

    lines.push("\\documentclass[border=6pt]{standalone}");
    lines.push(`\\usepackage[${c.style === "iec" ? "european" : "american"}]{circuitikz}`);
    lines.push("\\begin{document}");
    lines.push(`\\begin{circuitikz}[line width=${num(c.lineWidth)}pt]`);

    const named = c.nodes.filter((n) => n.name);
    for (const n of named) {
        lines.push(`\\coordinate (${n.name}) at (${num(n.x)},${num(n.y)});`);
    }
    if (named.length) lines.push("");

    for (const chain of buildChains(c)) {
        const parts: string[] = [pointRef(chain.start)];
        for (const st of chain.steps) {
            if (st.element.kind === "wire") {
                parts.push("--");
                parts.push(pointRef(st.to));
            } else if (st.element.kind === "ground") {
                parts.push(`to[${toOptions(st.element, st.reversed)}]`);
                parts.push(`${pointRef(st.to)} node[ground]{}`);
            } else {
                parts.push(`to[${toOptions(st.element, st.reversed)}]`);
                parts.push(pointRef(st.to));
            }
        }
        lines.push(`\\draw ${parts.join(" ")};`);
    }

    if (c.texts.length) lines.push("");
    for (const t of c.texts) {
        lines.push(textStatement(t, nodeById));
    }

    if (c.unparsed.length) {
        lines.push("");
        lines.push("% --- kept from the imported code (not editable on the canvas) ---");
        lines.push(...c.unparsed);
    }

    lines.push("\\end{circuitikz}");
    lines.push("\\end{document}");
    return lines.join("\n") + "\n";
}
