/**
 * Circuit model for the Circuit Designer.
 *
 * The model — not the LaTeX text — is the single source of truth. The canvas and
 * the CircuiTikZ code are both *views* on it: parse.ts turns code into a Circuit,
 * serialize.ts turns a Circuit back into code. That round trip is what makes
 * dragging a component on the canvas rewrite the code, and vice versa.
 *
 * Coordinates are TikZ units (cm), y-up — exactly what appears in the code. The
 * canvas flips y when it draws, so nothing here has to know about screen space.
 */

export type ComponentKind =
    | "wire"
    | "resistor"
    | "rheostat"
    | "cell"
    | "battery"
    | "dc_source"
    | "ac_source"
    | "capacitor"
    | "inductor"
    | "bulb"
    | "switch_open"
    | "switch_closed"
    | "ammeter"
    | "voltmeter"
    | "galvanometer"
    | "diode"
    | "led"
    | "ground";

/** Which symbol set to draw (and which circuitikz package option to emit). */
export type SymbolStyle = "iec" | "american";

export interface CircuitNode {
    id: string;
    /**
     * Name as it appears in `\coordinate (A) at (...)`. Empty for a point that was
     * written inline in a path (e.g. `-- (-0.5,0)`); those serialize back as literal
     * coordinates instead of gaining an invented name.
     */
    name: string;
    x: number;
    y: number;
}

export interface CircuitElement {
    id: string;
    kind: ComponentKind;
    /** Node ids. */
    from: string;
    to: string;
    /** Label in LaTeX source form, e.g. `3\,\Omega` — no surrounding `$`. */
    label?: string;
    /** circuitikz `l=` draws above the component, `l_=` below. */
    labelSide?: "above" | "below";
    /** Font for this component's label. Absent means the plain default. */
    labelStyle?: TextStyle;
    /** circuitikz `invert` — flips the component's polarity/direction. */
    invert?: boolean;
    /**
     * Options inside `to[...]` that the editor has no UI for (`i=`, `v=`, `a=`,
     * styling keys…). Kept verbatim and re-emitted so importing rich code and
     * dragging one node doesn't quietly strip the rest of the author's options.
     */
    extraOpts?: string[];
}

export type FontFamily = "serif" | "sans" | "mono";
export type TextAnchor = "center" | "left" | "right" | "above" | "below";

export interface FontFamilySpec {
    id: FontFamily;
    label: string;
    css: string;
    /** LaTeX family switch used inside `font=`. */
    tex: string;
}

export const FONT_FAMILIES: FontFamilySpec[] = [
    { id: "serif", label: "Serif (Times)", css: "Georgia, 'Times New Roman', serif", tex: "\\rmfamily" },
    { id: "sans", label: "Sans (Arial)", css: "Arial, Helvetica, sans-serif", tex: "\\sffamily" },
    { id: "mono", label: "Monospace", css: "ui-monospace, Menlo, Consolas, monospace", tex: "\\ttfamily" },
];

export function fontCss(f: FontFamily): string {
    return (FONT_FAMILIES.find((x) => x.id === f) || FONT_FAMILIES[0]).css;
}

/** xcolor names, so the emitted LaTeX needs no colour definitions of its own. */
export const TEXT_COLORS = ["black", "red", "blue", "green", "orange", "purple", "gray"] as const;
export type TextColor = (typeof TEXT_COLORS)[number];

const COLOR_CSS: Record<TextColor, string> = {
    black: "var(--text-primary)",
    red: "#dc2626",
    blue: "#2563eb",
    green: "#16a34a",
    orange: "#ea580c",
    purple: "#9333ea",
    gray: "#6b7280",
};

export function colorCss(c: string): string {
    return COLOR_CSS[(c as TextColor)] || COLOR_CSS.black;
}

export const DEFAULT_FONT_SIZE_PT = 10;

/** Font styling shared by component labels and free text. */
export interface TextStyle {
    fontFamily: FontFamily;
    fontSizePt: number;
    bold: boolean;
    /** Forces italics on. Maths content slants on its own without this. */
    italic: boolean;
    /** Forces upright, overriding the automatic maths italics. */
    upright: boolean;
    color: string;
}

export function defaultTextStyle(): TextStyle {
    return {
        fontFamily: "serif",
        fontSizePt: DEFAULT_FONT_SIZE_PT,
        bold: false,
        italic: false,
        upright: false,
        color: "black",
    };
}

export function isDefaultStyle(st: TextStyle | undefined): boolean {
    if (!st) return true;
    const d = defaultTextStyle();
    return (
        st.fontFamily === d.fontFamily &&
        Math.abs(st.fontSizePt - d.fontSizePt) < 0.01 &&
        st.bold === d.bold &&
        st.italic === d.italic &&
        st.upright === d.upright &&
        st.color === d.color
    );
}

/**
 * A `\node[...] at (point) {text};` — both the A/B/P/Q point markers and free
 * standing text boxes. When `nodeId` is set the text is anchored to that circuit
 * point and follows it; otherwise it sits at its own (x, y).
 */
export interface CircuitText {
    id: string;
    /** Anchored to this circuit point, if any. */
    nodeId?: string;
    /** Absolute position — authoritative only when `nodeId` is unset. */
    x: number;
    y: number;
    /** Source form, no surrounding `$` even when `math` is true. */
    text: string;
    /** Rendered as math (italic, LaTeX symbols) and re-emitted wrapped in `$...$`. */
    math: boolean;
    anchor: TextAnchor;
    /** Extra offset in pt, as in `above=2pt`. 0 emits a bare anchor. */
    offsetPt: number;
    /** Free nudge in TikZ units, emitted as `xshift=`/`yshift=`. Lets a label
     *  pinned to a point be dragged anywhere while still following that point. */
    dx: number;
    dy: number;
    fontFamily: FontFamily;
    fontSizePt: number;
    bold: boolean;
    /** Explicit `\itshape`. Math text renders italic regardless. */
    italic: boolean;
    color: string;
    /** Degrees, counter-clockwise — `rotate=` on the node. */
    rotation: number;
}

export function defaultText(partial: Partial<CircuitText> & { id: string; x: number; y: number }): CircuitText {
    return {
        text: "Text",
        math: false,
        anchor: "center",
        offsetPt: 0,
        dx: 0,
        dy: 0,
        fontFamily: "serif",
        fontSizePt: DEFAULT_FONT_SIZE_PT,
        bold: false,
        italic: false,
        color: "black",
        rotation: 0,
        ...partial,
    };
}

export interface Circuit {
    nodes: CircuitNode[];
    elements: CircuitElement[];
    texts: CircuitText[];
    style: SymbolStyle;
    /** `line width=` value for the circuitikz environment. */
    lineWidth: number;
    /**
     * Lines from imported code that the parser did not understand. They are kept
     * and re-emitted verbatim so importing someone's code can never silently throw
     * part of their diagram away — they just aren't editable on the canvas.
     */
    unparsed: string[];
}

export interface ComponentSpec {
    kind: ComponentKind;
    label: string;
    /** Short group name for the palette. */
    group: "Basic" | "Sources" | "Meters" | "Other";
    /** The circuitikz key this serializes to, e.g. `R` for a resistor. */
    tikzKey: string;
    /** Every key that should parse *into* this kind (first entry is tikzKey). */
    aliases: string[];
    /** Body length along the wire, in TikZ units. */
    bodyLength: number;
    /** Half-height of the body, in TikZ units — used for label clearance. */
    bodyHalfHeight: number;
    /** False for `wire`, which has no symbol and no label anchor of its own. */
    hasBody: boolean;
    /** Default label to prefill when the component is placed. */
    defaultLabel: string;
}

export const COMPONENTS: ComponentSpec[] = [
    {
        kind: "wire",
        label: "Wire",
        group: "Basic",
        tikzKey: "short",
        aliases: ["short"],
        bodyLength: 0,
        bodyHalfHeight: 0,
        hasBody: false,
        defaultLabel: "",
    },
    {
        kind: "resistor",
        label: "Resistor",
        group: "Basic",
        tikzKey: "R",
        aliases: ["R", "resistor", "american resistor", "european resistor", "generic"],
        bodyLength: 0.9,
        bodyHalfHeight: 0.2,
        hasBody: true,
        defaultLabel: "R",
    },
    {
        kind: "rheostat",
        label: "Rheostat",
        group: "Basic",
        tikzKey: "vR",
        aliases: ["vR", "variable resistor", "rheostat", "pR", "potentiometer"],
        bodyLength: 0.9,
        bodyHalfHeight: 0.28,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "capacitor",
        label: "Capacitor",
        group: "Basic",
        tikzKey: "C",
        aliases: ["C", "capacitor", "eC", "cC", "pC"],
        bodyLength: 0.35,
        bodyHalfHeight: 0.32,
        hasBody: true,
        defaultLabel: "C",
    },
    {
        kind: "inductor",
        label: "Inductor",
        group: "Basic",
        tikzKey: "L",
        aliases: ["L", "inductor", "cute inductor", "american inductor", "european inductor"],
        bodyLength: 0.9,
        bodyHalfHeight: 0.22,
        hasBody: true,
        defaultLabel: "L",
    },
    {
        kind: "bulb",
        label: "Bulb / lamp",
        group: "Basic",
        tikzKey: "lamp",
        aliases: ["lamp", "bulb", "lightbulb"],
        bodyLength: 0.6,
        bodyHalfHeight: 0.3,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "switch_open",
        label: "Switch (open)",
        group: "Basic",
        tikzKey: "ospst",
        aliases: ["ospst", "switch", "spst", "nos", "opening switch", "normally open switch"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.3,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "switch_closed",
        label: "Switch (closed)",
        group: "Basic",
        tikzKey: "cspst",
        aliases: ["cspst", "ncs", "closing switch", "normally closed switch"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.24,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "cell",
        label: "Cell",
        group: "Sources",
        tikzKey: "battery1",
        aliases: ["battery1"],
        bodyLength: 0.35,
        bodyHalfHeight: 0.32,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "battery",
        label: "Battery",
        group: "Sources",
        tikzKey: "battery2",
        aliases: ["battery2", "battery"],
        bodyLength: 0.6,
        bodyHalfHeight: 0.32,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "dc_source",
        label: "DC source",
        group: "Sources",
        tikzKey: "V",
        aliases: ["V", "vsource", "american voltage source", "european voltage source"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.35,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "ac_source",
        label: "AC source",
        group: "Sources",
        tikzKey: "sV",
        aliases: ["sV", "sinusoidal voltage source", "vsourcesin", "sqV"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.35,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "ammeter",
        label: "Ammeter",
        group: "Meters",
        tikzKey: "ammeter",
        aliases: ["ammeter"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.35,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "voltmeter",
        label: "Voltmeter",
        group: "Meters",
        tikzKey: "voltmeter",
        aliases: ["voltmeter"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.35,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "galvanometer",
        label: "Galvanometer",
        group: "Meters",
        tikzKey: "rmeter",
        aliases: ["rmeter", "galvanometer", "smeter"],
        bodyLength: 0.7,
        bodyHalfHeight: 0.35,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "diode",
        label: "Diode",
        group: "Other",
        tikzKey: "D",
        aliases: ["D", "diode", "empty diode", "full diode", "Do", "D*"],
        bodyLength: 0.6,
        bodyHalfHeight: 0.26,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "led",
        label: "LED",
        group: "Other",
        tikzKey: "leD",
        aliases: ["leD", "led", "empty led"],
        bodyLength: 0.6,
        bodyHalfHeight: 0.34,
        hasBody: true,
        defaultLabel: "",
    },
    {
        kind: "ground",
        label: "Ground",
        group: "Other",
        tikzKey: "short",
        aliases: [],
        bodyLength: 0,
        bodyHalfHeight: 0.3,
        hasBody: true,
        defaultLabel: "",
    },
];

const BY_KIND = new Map<ComponentKind, ComponentSpec>(COMPONENTS.map((c) => [c.kind, c]));

export function spec(kind: ComponentKind): ComponentSpec {
    return BY_KIND.get(kind) || BY_KIND.get("wire")!;
}

/**
 * circuitikz key (as written inside `to[...]`) to our kind. Matching is
 * case-insensitive on the alias list; unknown keys fall back to a resistor so an
 * exotic component still shows up as an editable two-terminal box rather than
 * vanishing from the diagram.
 */
export function kindFromTikzKey(key: string): ComponentKind | null {
    const k = key.trim();
    if (!k) return null;
    for (const c of COMPONENTS) {
        if (c.aliases.some((a) => a.toLowerCase() === k.toLowerCase())) return c.kind;
    }
    return null;
}

let idCounter = 0;
export function newId(prefix: string): string {
    idCounter += 1;
    return `${prefix}${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyCircuit(): Circuit {
    return { nodes: [], elements: [], texts: [], style: "american", lineWidth: 0.8, unparsed: [] };
}

export function findNode(c: Circuit, id: string): CircuitNode | undefined {
    return c.nodes.find((n) => n.id === id);
}

/** How many elements touch this node — used for chain merging and orphan cleanup. */
export function nodeDegree(c: Circuit, nodeId: string): number {
    let d = 0;
    for (const e of c.elements) {
        if (e.from === nodeId) d += 1;
        if (e.to === nodeId) d += 1;
    }
    return d;
}
