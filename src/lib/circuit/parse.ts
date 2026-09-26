/**
 * CircuiTikZ (a practical subset) -> Circuit model.
 *
 * Deliberately forgiving: anything it cannot interpret is preserved in
 * `circuit.unparsed` and re-emitted by serialize.ts, so pasting real-world code
 * never silently deletes part of someone's diagram. What it *does* understand is
 * everything the canvas can edit:
 *
 *   \coordinate (A) at (0,0);
 *   \draw (A) to[R,l=$3\,\Omega$] (P) to[R,l=$6\,\Omega$] (B);
 *   \draw (A) -- (-0.5,0) -- (-0.5,-2.6) to[battery1,l=$12\,\mathrm{V}$] (4.5,-2.6);
 *   \draw (A) to[short] (0,-1) node[ground]{};
 *   \node[left] at (A) {$A$};
 *   \node[above=2pt] at (-0.5,-2.6) {$+$};
 */

import {
    Circuit,
    CircuitElement,
    CircuitNode,
    CircuitText,
    ComponentKind,
    FontFamily,
    SymbolStyle,
    TextAnchor,
    TextStyle,
    defaultText,
    defaultTextStyle,
    emptyCircuit,
    kindFromTikzKey,
    newId,
} from "./types";

export interface ParseResult {
    circuit: Circuit;
    warnings: string[];
}

const EPS = 1e-6;

/** Split on commas that sit at brace/bracket/dollar depth 0. */
function splitTopLevel(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let inMath = false;
    let cur = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\\" && i + 1 < s.length) {
            cur += ch + s[i + 1];
            i += 1;
            continue;
        }
        if (ch === "$") inMath = !inMath;
        else if (!inMath && (ch === "{" || ch === "[" || ch === "(")) depth += 1;
        else if (!inMath && (ch === "}" || ch === "]" || ch === ")")) depth -= 1;
        if (ch === sep && depth === 0 && !inMath) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Read a balanced group starting at `open` (which must be at s[i]). Returns [inner, indexAfter]. */
function readGroup(s: string, i: number, open: string, close: string): [string, number] | null {
    if (s[i] !== open) return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === "\\") {
            j += 1;
            continue;
        }
        if (s[j] === open) depth += 1;
        else if (s[j] === close) {
            depth -= 1;
            if (depth === 0) return [s.slice(i + 1, j), j + 1];
        }
    }
    return null;
}

function stripMath(s: string): string {
    const t = s.trim();
    if (t.startsWith("$") && t.endsWith("$") && t.length >= 2) return t.slice(1, -1).trim();
    return t;
}

/** Statements are `\...;` — split the body on semicolons at depth 0. */
function splitStatements(body: string): string[] {
    return splitTopLevel(body, ";");
}

interface Ctx {
    circuit: Circuit;
    warnings: string[];
}

/** Find an existing node at (x,y), or make one. Named lookups win over positional. */
function nodeAt(ctx: Ctx, x: number, y: number): CircuitNode {
    const hit = ctx.circuit.nodes.find((n) => Math.abs(n.x - x) < EPS && Math.abs(n.y - y) < EPS);
    if (hit) return hit;
    const n: CircuitNode = { id: newId("n"), name: "", x, y };
    ctx.circuit.nodes.push(n);
    return n;
}

function nodeNamed(ctx: Ctx, name: string): CircuitNode | null {
    return ctx.circuit.nodes.find((n) => n.name === name) || null;
}

type Point = { node: CircuitNode };

/**
 * Read one point at s[i]: `(Name)`, `(x,y)`, or `++(dx,dy)` relative to `cur`.
 * Returns null if s[i] doesn't start a point.
 */
function readPoint(ctx: Ctx, s: string, i: number, cur: CircuitNode | null): [Point, number] | null {
    let relative = false;
    let j = i;
    if (s.startsWith("++", j)) {
        relative = true;
        j += 2;
    } else if (s.startsWith("+", j) && s[j + 1] === "(") {
        relative = true;
        j += 1;
    }
    if (s[j] !== "(") return null;
    const grp = readGroup(s, j, "(", ")");
    if (!grp) return null;
    const [inner, after] = grp;
    const raw = inner.trim();

    const coords = raw.split(",").map((p) => p.trim());
    if (coords.length === 2 && coords.every((p) => /^-?\d*\.?\d+$/.test(p))) {
        let x = parseFloat(coords[0]);
        let y = parseFloat(coords[1]);
        if (relative) {
            if (!cur) return null;
            x += cur.x;
            y += cur.y;
        }
        return [{ node: nodeAt(ctx, x, y) }, after];
    }

    if (relative) return null; // ++(named) isn't meaningful
    if (!/^[A-Za-z][A-Za-z0-9_\-.]*$/.test(raw)) return null;
    const existing = nodeNamed(ctx, raw);
    if (existing) return [{ node: existing }, after];
    // Referenced before it was declared — create a placeholder that a later
    // \coordinate can fill in.
    const n: CircuitNode = { id: newId("n"), name: raw, x: 0, y: 0 };
    ctx.circuit.nodes.push(n);
    return [{ node: n }, after];
}

interface ParsedOpts {
    kind: ComponentKind;
    label?: string;
    labelSide?: "above" | "below";
    labelStyle?: TextStyle;
    invert?: boolean;
    extraOpts: string[];
}

/** Pull the font switches out of a `font=`-style command run. */
function readStyleCommands(src: string): TextStyle {
    const st = defaultTextStyle();
    const size = /\\fontsize\s*\{\s*([\d.]+)\s*\}/.exec(src);
    if (size) st.fontSizePt = parseFloat(size[1]);
    else {
        const named: Record<string, number> = {
            tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10,
            large: 12, Large: 14.4, LARGE: 17.3, huge: 20.7, Huge: 24.9,
        };
        for (const [k, v] of Object.entries(named)) {
            if (new RegExp("\\\\" + k + "\\b").test(src)) {
                st.fontSizePt = v;
                break;
            }
        }
    }
    if (/\\sffamily/.test(src)) st.fontFamily = "sans";
    else if (/\\ttfamily/.test(src)) st.fontFamily = "mono";
    if (/\\bfseries|\\bf\b/.test(src)) st.bold = true;
    if (/\\itshape|\\it\b/.test(src)) st.italic = true;
    const col = /\\color\s*\{\s*([A-Za-z]+)\s*\}/.exec(src);
    if (col) st.color = col[1];
    return st;
}

/**
 * A component label is either the plain `l=$3\,\Omega$` or a styled
 * `l={\sffamily\bfseries$3\,\Omega$}` produced by the editor's font controls.
 */
function parseLabelValue(val: string): { text: string; style?: TextStyle } {
    const raw = val.trim();
    if (!raw.startsWith("{")) return { text: stripMath(raw) };
    const inner = raw.slice(1, raw.endsWith("}") ? -1 : undefined);
    const mathM = /\$([\s\S]*)\$/.exec(inner);
    const cmds = mathM ? inner.slice(0, mathM.index) : inner;
    let text = mathM ? mathM[1] : inner.replace(/\\[A-Za-z]+(\{[^}]*\})?/g, "").trim();
    const style = readStyleCommands(cmds);
    const upM = /^\\mathrm\s*\{([\s\S]*)\}$/.exec(text.trim());
    if (upM) {
        text = upM[1];
        style.upright = true;
    }
    return { text, style };
}

function parseToOpts(ctx: Ctx, optStr: string): ParsedOpts {
    const parts = splitTopLevel(optStr, ",");
    let kind: ComponentKind | null = null;
    let label: string | undefined;
    let labelSide: "above" | "below" | undefined;
    let labelStyle: TextStyle | undefined;
    let invert = false;
    const extra: string[] = [];

    for (const p of parts) {
        const eq = p.indexOf("=");
        const key = (eq >= 0 ? p.slice(0, eq) : p).trim();
        const val = eq >= 0 ? p.slice(eq + 1).trim() : "";

        if (key === "l" || key === "l_" || key === "l^") {
            const parsed = parseLabelValue(val);
            label = parsed.text;
            labelStyle = parsed.style;
            labelSide = key === "l_" ? "below" : "above";
            continue;
        }
        if (key === "invert" || key === "mirror") {
            invert = true;
            continue;
        }
        if (eq < 0 && kind === null) {
            const k = kindFromTikzKey(key);
            if (k) {
                kind = k;
                continue;
            }
        }
        extra.push(p);
    }

    if (kind === null) {
        // A `to[...]` whose component key we don't recognise: keep it as a resistor
        // body so it stays visible and editable, and preserve the original key.
        const bare = parts.find((p) => !p.includes("="));
        if (bare) {
            kind = "resistor";
            ctx.warnings.push(`Unknown component "${bare}" — shown as a resistor (its options were kept).`);
        } else {
            kind = "wire";
        }
    }
    return { kind, label, labelSide, labelStyle, invert, extraOpts: extra };
}

/** `node[...]{...}` immediately after a point — used for ground symbols and inline labels. */
function readTrailingNode(s: string, i: number): { opts: string; text: string; next: number } | null {
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    if (!s.startsWith("node", j)) return null;
    j += 4;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    let opts = "";
    if (s[j] === "[") {
        const g = readGroup(s, j, "[", "]");
        if (!g) return null;
        opts = g[0];
        j = g[1];
    }
    while (j < s.length && /\s/.test(s[j])) j += 1;
    let text = "";
    if (s[j] === "{") {
        const g = readGroup(s, j, "{", "}");
        if (!g) return null;
        text = g[0];
        j = g[1];
    }
    return { opts, text, next: j };
}

function parseDraw(ctx: Ctx, stmt: string): boolean {
    // Strip the leading \draw and any global options like \draw[thick].
    let i = stmt.indexOf("\\draw") + 5;
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
    if (stmt[i] === "[") {
        const g = readGroup(stmt, i, "[", "]");
        if (!g) return false;
        i = g[1];
    }

    let cur: CircuitNode | null = null;
    const made: CircuitElement[] = [];
    let sawAny = false;

    while (i < stmt.length) {
        while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
        if (i >= stmt.length) break;

        const pt = readPoint(ctx, stmt, i, cur);
        if (pt) {
            cur = pt[0].node;
            i = pt[1];
            sawAny = true;

            // A `node[ground]{}` right after a point turns the segment that arrived
            // here into a ground symbol.
            const tn = readTrailingNode(stmt, i);
            if (tn) {
                if (/\bground\b|\brground\b|\bsground\b/.test(tn.opts)) {
                    const last = made[made.length - 1];
                    if (last) last.kind = "ground";
                    else ctx.warnings.push("A ground symbol with no wire attached was skipped.");
                } else if (tn.text.trim()) {
                    pushText(ctx, tn.opts, tn.text, cur);
                }
                i = tn.next;
            }
            continue;
        }

        if (stmt.startsWith("--", i)) {
            i += 2;
            let k = i;
            while (k < stmt.length && /\s/.test(stmt[k])) k += 1;
            const next: [Point, number] | null = readPoint(ctx, stmt, k, cur);
            if (!cur || !next) return false;
            const target: CircuitNode = next[0].node;
            made.push({ id: newId("e"), kind: "wire", from: cur.id, to: target.id });
            cur = target;
            i = next[1];
            sawAny = true;
            const tn = readTrailingNode(stmt, i);
            if (tn) {
                if (/\bground\b|\brground\b|\bsground\b/.test(tn.opts)) {
                    made[made.length - 1].kind = "ground";
                } else if (tn.text.trim()) {
                    pushText(ctx, tn.opts, tn.text, target);
                }
                i = tn.next;
            }
            continue;
        }

        if (stmt.startsWith("to", i)) {
            let j = i + 2;
            while (j < stmt.length && /\s/.test(stmt[j])) j += 1;
            let optStr = "";
            if (stmt[j] === "[") {
                const g = readGroup(stmt, j, "[", "]");
                if (!g) return false;
                optStr = g[0];
                j = g[1];
            }
            while (j < stmt.length && /\s/.test(stmt[j])) j += 1;
            const next = readPoint(ctx, stmt, j, cur);
            if (!cur || !next) return false;
            const target = next[0].node;
            const o = parseToOpts(ctx, optStr);
            made.push({
                id: newId("e"),
                kind: o.kind,
                from: cur.id,
                to: target.id,
                label: o.label,
                labelSide: o.labelSide,
                labelStyle: o.labelStyle,
                invert: o.invert || undefined,
                extraOpts: o.extraOpts.length ? o.extraOpts : undefined,
            });
            cur = target;
            i = next[1];
            sawAny = true;
            const tn = readTrailingNode(stmt, i);
            if (tn) {
                if (/\bground\b|\brground\b|\bsground\b/.test(tn.opts)) {
                    made[made.length - 1].kind = "ground";
                } else if (tn.text.trim()) {
                    pushText(ctx, tn.opts, tn.text, target);
                }
                i = tn.next;
            }
            continue;
        }

        return false; // something we don't handle — keep the whole statement verbatim
    }

    if (!sawAny) return false;
    ctx.circuit.elements.push(...made);
    return true;
}

interface NodeOpts {
    anchor: TextAnchor;
    offsetPt: number;
    dx: number;
    dy: number;
    fontFamily: FontFamily;
    fontSizePt: number;
    bold: boolean;
    italic: boolean;
    color: string;
    rotation: number;
}

/** Read the options of a `\node[...]`: placement, `font=`, `text=`, `rotate=`. */
function readNodeOpts(opts: string, fallbackAnchor: TextAnchor): NodeOpts {
    const out: NodeOpts = {
        anchor: fallbackAnchor,
        offsetPt: 0,
        dx: 0,
        dy: 0,
        fontFamily: "serif",
        fontSizePt: 10,
        bold: false,
        italic: false,
        color: "black",
        rotation: 0,
    };
    for (const raw of splitTopLevel(opts, ",")) {
        const p = raw.trim();
        const place = /^(left|right|above|below|center|centre)\s*(?:=\s*([\d.]+)\s*pt)?$/.exec(p);
        if (place) {
            out.anchor = (place[1] === "centre" ? "center" : place[1]) as TextAnchor;
            out.offsetPt = place[2] ? parseFloat(place[2]) : 0;
            continue;
        }
        const rot = /^rotate\s*=\s*(-?[\d.]+)$/.exec(p);
        if (rot) {
            out.rotation = parseFloat(rot[1]);
            continue;
        }
        const shift = /^([xy])shift\s*=\s*(-?[\d.]+)\s*(cm|mm|pt)?$/.exec(p);
        if (shift) {
            const raw = parseFloat(shift[2]);
            const unit = shift[3] || "cm";
            const cm = unit === "mm" ? raw / 10 : unit === "pt" ? raw / 28.4527 : raw;
            if (shift[1] === "x") out.dx = cm;
            else out.dy = cm;
            continue;
        }
        const col = /^text\s*=\s*([A-Za-z]+)$/.exec(p);
        if (col) {
            out.color = col[1];
            continue;
        }
        if (/^font\s*=/.test(p)) {
            const f = p.slice(p.indexOf("=") + 1);
            const size = /\\fontsize\s*\{\s*([\d.]+)\s*\}/.exec(f);
            if (size) out.fontSizePt = parseFloat(size[1]);
            else {
                // The classic size macros, mapped to their usual 10pt-base values.
                const named: Record<string, number> = {
                    tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10,
                    large: 12, Large: 14.4, LARGE: 17.3, huge: 20.7, Huge: 24.9,
                };
                for (const [k, v] of Object.entries(named)) {
                    if (new RegExp("\\\\" + k + "\\b").test(f)) {
                        out.fontSizePt = v;
                        break;
                    }
                }
            }
            if (/\\sffamily/.test(f)) out.fontFamily = "sans";
            else if (/\\ttfamily/.test(f)) out.fontFamily = "mono";
            if (/\\bfseries|\\bf\b/.test(f)) out.bold = true;
            if (/\\itshape|\\it\b/.test(f)) out.italic = true;
            continue;
        }
    }
    return out;
}

/** Build a CircuitText from node options + body, optionally bound to a point. */
function pushText(ctx: Ctx, opts: string, body: string, at: CircuitNode | null, x = 0, y = 0): void {
    const raw = body.trim();
    const math = raw.startsWith("$") && raw.endsWith("$") && raw.length >= 2;
    const o = readNodeOpts(opts, at ? "above" : "center");
    ctx.circuit.texts.push(
        defaultText({
            id: newId("t"),
            nodeId: at ? at.id : undefined,
            x: at ? at.x : x,
            y: at ? at.y : y,
            text: stripMath(raw),
            math,
            anchor: o.anchor,
            offsetPt: o.offsetPt,
            dx: o.dx,
            dy: o.dy,
            fontFamily: o.fontFamily,
            fontSizePt: o.fontSizePt,
            bold: o.bold,
            italic: o.italic,
            color: o.color,
            rotation: o.rotation,
        })
    );
}

function parseCoordinate(ctx: Ctx, stmt: string): boolean {
    const m = /\\coordinate\s*(?:\[[^\]]*\])?\s*\(\s*([A-Za-z][A-Za-z0-9_\-.]*)\s*\)\s*at\s*\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/.exec(
        stmt
    );
    if (!m) return false;
    const [, name, xs, ys] = m;
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    const existing = nodeNamed(ctx, name);
    if (existing) {
        existing.x = x;
        existing.y = y;
        return true;
    }
    // Reuse an anonymous node already sitting at that spot so a later \coordinate
    // naming an existing point doesn't create a duplicate on top of it.
    const coincident = ctx.circuit.nodes.find(
        (n) => !n.name && Math.abs(n.x - x) < EPS && Math.abs(n.y - y) < EPS
    );
    if (coincident) {
        coincident.name = name;
        return true;
    }
    ctx.circuit.nodes.push({ id: newId("n"), name, x, y });
    return true;
}

function parseNode(ctx: Ctx, stmt: string): boolean {
    let i = stmt.indexOf("\\node") + 5;
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
    let opts = "";
    if (stmt[i] === "[") {
        const g = readGroup(stmt, i, "[", "]");
        if (!g) return false;
        opts = g[0];
        i = g[1];
    }
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
    if (!stmt.startsWith("at", i)) return false;
    i += 2;
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
    const pt = readPoint(ctx, stmt, i, null);
    if (!pt) return false;
    i = pt[1];
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1;
    if (stmt[i] !== "{") return false;
    const g = readGroup(stmt, i, "{", "}");
    if (!g) return false;
    if (!g[0].trim()) return true; // an empty label is a no-op, not an error
    // A node that only carries text (no font/colour/rotation of its own) and sits
    // on a circuit point stays bound to it, so moving the point moves the label.
    // Anything styled, or standing away from the circuit, becomes free text.
    const styled = /\bfont\s*=|\btext\s*=|\brotate\s*=/.test(opts);
    const target = pt[0].node;
    const boundElsewhere = ctx.circuit.elements.some((e) => e.from === target.id || e.to === target.id);
    if (!styled && boundElsewhere) {
        pushText(ctx, opts, g[0], target);
    } else {
        pushText(ctx, opts, g[0], null, target.x, target.y);
    }
    return true;
}

export function parseCircuitTikz(code: string): ParseResult {
    const ctx: Ctx = { circuit: emptyCircuit(), warnings: [] };

    // Preamble hints (outside the environment).
    const styleM = /\\usepackage\s*\[([^\]]*)\]\s*\{circuitikz\}/.exec(code);
    if (styleM) {
        const opts = styleM[1].toLowerCase();
        const style: SymbolStyle = opts.includes("european") || opts.includes("iec") ? "iec" : "american";
        ctx.circuit.style = style;
    }

    // Body of the circuitikz environment; if there's no environment, treat the
    // whole input as the body so a bare fragment still works.
    const envM = /\\begin\s*\{circuitikz\}\s*(\[[^\]]*\])?([\s\S]*?)\\end\s*\{circuitikz\}/.exec(code);
    const envOpts = envM?.[1] || "";
    const lw = /line width\s*=\s*([\d.]+)\s*pt/.exec(envOpts);
    if (lw) ctx.circuit.lineWidth = parseFloat(lw[1]);
    const body = envM ? envM[2] : stripPreamble(code);

    for (const rawStmt of splitStatements(body)) {
        const stmt = rawStmt.trim();
        if (!stmt) continue;
        if (stmt.startsWith("%")) continue;

        let ok = false;
        if (stmt.includes("\\coordinate")) ok = parseCoordinate(ctx, stmt);
        else if (stmt.startsWith("\\draw") || stmt.startsWith("\\path")) ok = parseDraw(ctx, stmt);
        else if (stmt.startsWith("\\node")) ok = parseNode(ctx, stmt);

        if (!ok) {
            ctx.circuit.unparsed.push(stmt + ";");
            ctx.warnings.push(`Kept as-is (not editable on the canvas): ${short(stmt)}`);
        }
    }

    // Drop nodes nothing references — placeholders from a forward reference that
    // was never declared, for example.
    const used = new Set<string>();
    for (const e of ctx.circuit.elements) {
        used.add(e.from);
        used.add(e.to);
    }
    for (const t of ctx.circuit.texts) if (t.nodeId) used.add(t.nodeId);
    ctx.circuit.nodes = ctx.circuit.nodes.filter((n) => used.has(n.id));

    return { circuit: ctx.circuit, warnings: ctx.warnings };
}

function stripPreamble(code: string): string {
    return code
        .split("\n")
        .filter(
            (l) =>
                !/^\s*\\(documentclass|usepackage|begin\s*\{document\}|end\s*\{document\}|begin\s*\{circuitikz\}|end\s*\{circuitikz\})/.test(
                    l
                )
        )
        .join("\n");
}

function short(s: string): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > 70 ? one.slice(0, 70) + "…" : one;
}
