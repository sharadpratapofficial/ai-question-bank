"use client";

/**
 * Circuit Designer — a two-way editor for CircuiTikZ diagrams.
 *
 * The Circuit model is the single source of truth. Dragging on the canvas mutates
 * the model and the code pane is re-serialised from it; pressing "Apply to diagram"
 * parses the code back into a model. Neither side edits the other's text directly.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Check,
    Copy,
    Download,
    Grid3x3,
    Hand,
    Image as ImageIcon,
    Maximize2,
    MousePointer2,
    Redo2,
    RotateCcw,
    RotateCw,
    Keyboard,
    Trash2,
    Type,
    Undo2,
} from "lucide-react";

import { EXAMPLES, DEFAULT_EXAMPLE_ID } from "@/lib/circuit/examples";
import { parseCircuitTikz } from "@/lib/circuit/parse";
import { serializeCircuit } from "@/lib/circuit/serialize";
import { CircuitGraphics, Selection, U, toPx } from "@/lib/circuit/graphics";
import { PalettePreview, latexLabelToText } from "@/lib/circuit/symbols";
import {
    COMPONENTS,
    Circuit,
    CircuitElement,
    CircuitNode,
    CircuitText,
    ComponentKind,
    FONT_FAMILIES,
    FontFamily,
    SymbolStyle,
    TEXT_COLORS,
    TextAnchor,
    TextStyle,
    colorCss,
    defaultText,
    defaultTextStyle,
    emptyCircuit,
    newId,
    spec,
} from "@/lib/circuit/types";

const STORAGE_KEY = "circuit-designer:v1";

type Tool = "select" | "text" | ComponentKind;

interface View {
    scale: number;
    tx: number;
    ty: number;
}

const card: React.CSSProperties = {
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    padding: 14,
};

const label: React.CSSProperties = {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--text-tertiary)",
};

const btn = (active = false): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 11px",
    borderRadius: 9,
    border: `1px solid ${active ? "var(--accent-primary)" : "var(--border-primary)"}`,
    background: active ? "var(--accent-primary)" : "var(--bg-tertiary)",
    color: active ? "#fff" : "var(--text-primary)",
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
});

const input: React.CSSProperties = {
    width: "100%",
    padding: "7px 9px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "0.82rem",
};

const SHORTCUT_GROUPS: { title: string; items: { keys: string; what: string }[] }[] = [
    {
        title: "Editing",
        items: [
            { keys: "Ctrl+Z", what: "Undo" },
            { keys: "Ctrl+Shift+Z / Ctrl+Y", what: "Redo" },
            { keys: "Ctrl+D", what: "Duplicate the selection" },
            { keys: "Ctrl+C / Ctrl+V", what: "Copy / paste" },
            { keys: "Delete", what: "Delete the selection" },
            { keys: "Esc", what: "Deselect, cancel placing, back to Select" },
        ],
    },
    {
        title: "Moving",
        items: [
            { keys: "Drag", what: "Move a component, point or text" },
            { keys: "Shift + drag", what: "Constrain to horizontal or vertical" },
            { keys: "Alt + drag", what: "Drag off a duplicate" },
            { keys: "Arrow keys", what: "Nudge by one grid step" },
            { keys: "Shift + arrows", what: "Nudge five steps" },
            { keys: "Alt + arrows", what: "Fine nudge (0.05)" },
        ],
    },
    {
        title: "Components",
        items: [
            { keys: "Click", what: "Select — its value box opens on the right" },
            { keys: "Double-click", what: "Jump straight into the value box" },
            { keys: "R / Shift+R", what: "Rotate 90° anticlockwise / clockwise" },
            { keys: "F", what: "Flip polarity" },
        ],
    },
    {
        title: "Tools & view",
        items: [
            { keys: "V / W / T", what: "Select / Wire / Text tool" },
            { keys: "G", what: "Toggle the grid" },
            { keys: "Scroll", what: "Zoom at the pointer" },
            { keys: "Ctrl + / Ctrl -", what: "Zoom in / out" },
            { keys: "Ctrl+0", what: "Fit the diagram to the view" },
            { keys: "Drag empty space", what: "Pan" },
            { keys: "?", what: "Show this list" },
        ],
    },
];

/* ------------------------------------------------------------------ helpers -- */

function circuitBounds(c: Circuit) {
    if (!c.nodes.length) return { minX: -1, maxX: 5, minY: -3, maxY: 2 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of c.nodes) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
    }
    return { minX, maxX, minY, maxY };
}

function snapTo(v: number, step: number) {
    if (!step) return Math.round(v * 1000) / 1000;
    return Math.round(v / step) * step;
}

/* ------------------------------------------------------------------- canvas -- */

/* ------------------------------------------------------------------- editor -- */

export default function CircuitDesigner() {
    const [circuit, setCircuit] = useState<Circuit>(emptyCircuit);
    const [past, setPast] = useState<Circuit[]>([]);
    const [future, setFuture] = useState<Circuit[]>([]);
    const [code, setCode] = useState("");
    const [codeDirty, setCodeDirty] = useState(false);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [tool, setTool] = useState<Tool>("select");
    const [selection, setSelection] = useState<Selection>(null);
    const [pendingFrom, setPendingFrom] = useState<string | null>(null);
    const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
    const [view, setView] = useState<View>({ scale: 1, tx: 320, ty: 260 });
    const [snap, setSnap] = useState(0.25);
    const [showGrid, setShowGrid] = useState(true);
    const [pngScale, setPngScale] = useState(3);
    const [transparent, setTransparent] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(false);
    /** Internal clipboard for copy/paste and duplicate. */
    const [clip, setClip] = useState<{ kind: "element" | "text"; payload: unknown } | null>(null);

    const svgRef = useRef<SVGSVGElement | null>(null);
    /** Set below; lets the keyboard handler rotate without a declaration cycle. */
    const rotateElementRef = useRef<((id: string, degrees: number) => void) | null>(null);
    const exportRef = useRef<SVGSVGElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const labelInputRef = useRef<HTMLInputElement | null>(null);
    const textInputRef = useRef<HTMLInputElement | null>(null);
    /**
     * An in-progress drag. `node` moves one point, `element` moves a whole
     * component (both of its endpoints), `text` moves a free text box.
     */
    const dragRef = useRef<
        | { kind: "node"; id: string; before: Circuit }
        | { kind: "element"; id: string; before: Circuit; start: { x: number; y: number }; origin: Record<string, { x: number; y: number }> }
        | {
              kind: "text";
              id: string;
              before: Circuit;
              start: { x: number; y: number };
              origin: { x: number; y: number };
              pinned: boolean;
          }
        | null
    >(null);
    const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

    /** Apply a new model: records undo history and re-generates the code pane. */
    const commit = useCallback(
        (next: Circuit, previous?: Circuit) => {
            setPast((p) => [...p.slice(-49), previous ?? circuit]);
            setFuture([]);
            setCircuit(next);
            setCode(serializeCircuit(next));
            setCodeDirty(false);
        },
        [circuit]
    );

    /** Replace the model without touching history (used on load). */
    const load = useCallback((next: Circuit) => {
        setCircuit(next);
        setCode(serializeCircuit(next));
        setCodeDirty(false);
        setSelection(null);
        setPendingFrom(null);
    }, []);

    const fitToContent = useCallback(
        (c: Circuit) => {
            const el = wrapRef.current;
            const w = el?.clientWidth || 800;
            const h = el?.clientHeight || 520;
            const b = circuitBounds(c);
            const padUnits = 1.2;
            const worldW = (b.maxX - b.minX + padUnits * 2) * U;
            const worldH = (b.maxY - b.minY + padUnits * 2) * U;
            const scale = Math.min(w / worldW, h / worldH, 2.2);
            const cx = ((b.minX + b.maxX) / 2) * U;
            const cy = -((b.minY + b.maxY) / 2) * U;
            setView({ scale, tx: w / 2 - cx * scale, ty: h / 2 - cy * scale });
        },
        []
    );

    // First load: restore the last session, else the default example.
    useEffect(() => {
        let source = EXAMPLES.find((e) => e.id === DEFAULT_EXAMPLE_ID)?.code || EXAMPLES[0].code;
        try {
            const saved = window.localStorage.getItem(STORAGE_KEY);
            if (saved && saved.trim()) source = saved;
        } catch {
            /* localStorage unavailable — fall back to the example */
        }
        const { circuit: c, warnings: w } = parseCircuitTikz(source);
        load(c);
        setWarnings(w);
        // Wait for layout so the fit uses real canvas dimensions.
        requestAnimationFrame(() => fitToContent(c));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Best-effort autosave so a refresh doesn't lose the drawing.
    useEffect(() => {
        if (!code) return;
        const t = window.setTimeout(() => {
            try {
                window.localStorage.setItem(STORAGE_KEY, code);
            } catch {
                /* quota or private mode — autosave is optional */
            }
        }, 600);
        return () => window.clearTimeout(t);
    }, [code]);

    const undo = useCallback(() => {
        setPast((p) => {
            if (!p.length) return p;
            const prev = p[p.length - 1];
            setFuture((f) => [circuit, ...f]);
            setCircuit(prev);
            setCode(serializeCircuit(prev));
            setCodeDirty(false);
            setSelection(null);
            return p.slice(0, -1);
        });
    }, [circuit]);

    const redo = useCallback(() => {
        setFuture((f) => {
            if (!f.length) return f;
            const next = f[0];
            setPast((p) => [...p, circuit]);
            setCircuit(next);
            setCode(serializeCircuit(next));
            setCodeDirty(false);
            setSelection(null);
            return f.slice(1);
        });
    }, [circuit]);

    /* ------------------------------------------------------------ interaction */

    const clientToWorld = useCallback(
        (clientX: number, clientY: number) => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return { x: 0, y: 0 };
            const sx = (clientX - rect.left - view.tx) / view.scale;
            const sy = (clientY - rect.top - view.ty) / view.scale;
            return { x: sx / U, y: -sy / U };
        },
        [view]
    );

    /** Nearest existing node within `tolPx` screen pixels. */
    const nodeNear = useCallback(
        (world: { x: number; y: number }, tolPx = 14) => {
            const tol = tolPx / view.scale / U;
            let best: CircuitNode | null = null;
            let bestD = Infinity;
            for (const n of circuit.nodes) {
                const d = Math.hypot(n.x - world.x, n.y - world.y);
                if (d < tol && d < bestD) {
                    best = n;
                    bestD = d;
                }
            }
            return best;
        },
        [circuit.nodes, view.scale]
    );

    const onNodeDown = useCallback(
        (ev: React.MouseEvent, id: string) => {
            ev.stopPropagation();
            if (tool === "select") {
                setSelection({ type: "node", id });
                dragRef.current = { kind: "node", id, before: circuit };
                return;
            }
            // Placing a component: this node is an endpoint.
            handlePlacePoint(id);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tool, circuit]
    );

    const onElementDown = useCallback(
        (ev: React.MouseEvent, id: string) => {
            if (tool !== "select") return;
            ev.stopPropagation();
            setSelection({ type: "element", id });
            let source = circuit;
            let dragId = id;
            let el = circuit.elements.find((e) => e.id === id);
            if (!el) return;

            if (ev.altKey) {
                // Alt+drag peels off a copy and drags that, leaving the original.
                const a = circuit.nodes.find((n) => n.id === el!.from);
                const b = circuit.nodes.find((n) => n.id === el!.to);
                if (a && b) {
                    const na: CircuitNode = { id: newId("n"), name: "", x: a.x, y: a.y };
                    const nb: CircuitNode = { id: newId("n"), name: "", x: b.x, y: b.y };
                    const copy: CircuitElement = { ...el, id: newId("e"), from: na.id, to: nb.id };
                    source = {
                        ...circuit,
                        nodes: [...circuit.nodes, na, nb],
                        elements: [...circuit.elements, copy],
                    };
                    setCircuit(source);
                    dragId = copy.id;
                    el = copy;
                    setSelection({ type: "element", id: copy.id });
                }
            }

            // Dragging the body moves the component as a whole — both endpoints
            // together — so the shape it sits in keeps its wiring.
            const origin: Record<string, { x: number; y: number }> = {};
            for (const nid of [el.from, el.to]) {
                const n = source.nodes.find((x) => x.id === nid);
                if (n) origin[nid] = { x: n.x, y: n.y };
            }
            dragRef.current = {
                kind: "element",
                id: dragId,
                before: circuit,
                start: clientToWorld(ev.clientX, ev.clientY),
                origin,
            };
        },
        [circuit, clientToWorld, tool]
    );

    const onTextDown = useCallback(
        (ev: React.MouseEvent, id: string) => {
            if (tool !== "select") return;
            ev.stopPropagation();
            setSelection({ type: "text", id });
            const t = circuit.texts.find((x) => x.id === id);
            if (!t) return;
            // A pinned label still follows its point; dragging it adjusts the
            // nudge (xshift/yshift) rather than detaching it.
            dragRef.current = {
                kind: "text",
                id,
                before: circuit,
                start: clientToWorld(ev.clientX, ev.clientY),
                origin: t.nodeId ? { x: t.dx || 0, y: t.dy || 0 } : { x: t.x, y: t.y },
                pinned: Boolean(t.nodeId),
            };
        },
        [circuit, clientToWorld, tool]
    );

    /** Double-clicking a component jumps focus to its value box. */
    const onElementDoubleClick = useCallback((id: string) => {
        setSelection({ type: "element", id });
        window.setTimeout(() => labelInputRef.current?.focus(), 0);
    }, []);

    const handlePlacePoint = useCallback(
        (nodeId: string) => {
            if (!pendingFrom) {
                setPendingFrom(nodeId);
                return;
            }
            if (pendingFrom === nodeId) {
                setPendingFrom(null);
                return;
            }
            const kind = tool as ComponentKind;
            const el: CircuitElement = {
                id: newId("e"),
                kind,
                from: pendingFrom,
                to: nodeId,
                label: spec(kind).defaultLabel || undefined,
                labelSide: "above",
            };
            commit({ ...circuit, elements: [...circuit.elements, el] });
            setPendingFrom(null);
            setSelection({ type: "element", id: el.id });
        },
        [circuit, commit, pendingFrom, tool]
    );

    const onCanvasDown = useCallback(
        (ev: React.MouseEvent) => {
            if (tool === "text") {
                const world = clientToWorld(ev.clientX, ev.clientY);
                const t = defaultText({
                    id: newId("t"),
                    x: snapTo(world.x, snap),
                    y: snapTo(world.y, snap),
                    text: "Text",
                });
                commit({ ...circuit, texts: [...circuit.texts, t] });
                setSelection({ type: "text", id: t.id });
                setTool("select");
                window.setTimeout(() => textInputRef.current?.focus(), 0);
                return;
            }
            if (tool === "select") {
                setSelection(null);
                panRef.current = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
                return;
            }
            // Placement mode: snap onto an existing node, else create one.
            const world = clientToWorld(ev.clientX, ev.clientY);
            const hit = nodeNear(world);
            if (hit) {
                handlePlacePoint(hit.id);
                return;
            }
            const n: CircuitNode = {
                id: newId("n"),
                name: "",
                x: snapTo(world.x, snap),
                y: snapTo(world.y, snap),
            };
            const next = { ...circuit, nodes: [...circuit.nodes, n] };
            if (!pendingFrom) {
                // First click only adds the anchor point; no history entry until the
                // component itself lands, so an abandoned click is cheap to undo.
                setCircuit(next);
                setPendingFrom(n.id);
                return;
            }
            const kind = tool as ComponentKind;
            const el: CircuitElement = {
                id: newId("e"),
                kind,
                from: pendingFrom,
                to: n.id,
                label: spec(kind).defaultLabel || undefined,
                labelSide: "above",
            };
            commit({ ...next, elements: [...next.elements, el] });
            setPendingFrom(null);
            setSelection({ type: "element", id: el.id });
        },
        [circuit, clientToWorld, commit, handlePlacePoint, nodeNear, pendingFrom, snap, tool, view.tx, view.ty]
    );

    // Drag / pan / rubber-band preview.
    useEffect(() => {
        const move = (ev: MouseEvent) => {
            const d = dragRef.current;
            if (d) {
                const world = clientToWorld(ev.clientX, ev.clientY);
                if (d.kind === "node") {
                    setCircuit((c) => ({
                        ...c,
                        nodes: c.nodes.map((n) => {
                            if (n.id !== d.id) return n;
                            let { x, y } = world;
                            if (ev.shiftKey) {
                                // Keep the point on its original row or column.
                                const o = d.before.nodes.find((k) => k.id === d.id);
                                if (o) {
                                    if (Math.abs(x - o.x) > Math.abs(y - o.y)) y = o.y;
                                    else x = o.x;
                                }
                            }
                            return { ...n, x: snapTo(x, snap), y: snapTo(y, snap) };
                        }),
                    }));
                } else if (d.kind === "element") {
                    // Snap the offset rather than each endpoint: snapping them
                    // separately can land them on different sub-grid phases and
                    // stretch the component instead of moving it rigidly.
                    let rawX = world.x - d.start.x;
                    let rawY = world.y - d.start.y;
                    if (ev.shiftKey) {
                        // Shift locks the move to one axis, as in every drawing app.
                        if (Math.abs(rawX) > Math.abs(rawY)) rawY = 0;
                        else rawX = 0;
                    }
                    const dx = snapTo(rawX, snap);
                    const dy = snapTo(rawY, snap);
                    setCircuit((c) => ({
                        ...c,
                        nodes: c.nodes.map((n) => {
                            const o = d.origin[n.id];
                            return o
                                ? {
                                      ...n,
                                      x: Math.round((o.x + dx) * 1000) / 1000,
                                      y: Math.round((o.y + dy) * 1000) / 1000,
                                  }
                                : n;
                        }),
                    }));
                } else {
                    let dx = world.x - d.start.x;
                    let dy = world.y - d.start.y;
                    if (ev.shiftKey) {
                        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
                        else dx = 0;
                    }
                    setCircuit((c) => ({
                        ...c,
                        texts: c.texts.map((t) => {
                            if (t.id !== d.id) return t;
                            // A nudge is a free offset, so it is not grid-snapped.
                            if (d.pinned) {
                                return {
                                    ...t,
                                    dx: Math.round((d.origin.x + dx) * 1000) / 1000,
                                    dy: Math.round((d.origin.y + dy) * 1000) / 1000,
                                };
                            }
                            return { ...t, x: snapTo(d.origin.x + dx, snap), y: snapTo(d.origin.y + dy, snap) };
                        }),
                    }));
                }
                return;
            }
            if (panRef.current) {
                const p = panRef.current;
                setView((v) => ({ ...v, tx: p.tx + (ev.clientX - p.x), ty: p.ty + (ev.clientY - p.y) }));
                return;
            }
            if (tool !== "select" && pendingFrom) {
                const world = clientToWorld(ev.clientX, ev.clientY);
                setGhost({ x: snapTo(world.x, snap), y: snapTo(world.y, snap) });
            }
        };
        const up = () => {
            if (dragRef.current) {
                const before = dragRef.current.before;
                dragRef.current = null;
                // One history entry per drag, not per mouse-move.
                setCircuit((c) => {
                    setPast((p) => [...p.slice(-49), before]);
                    setFuture([]);
                    setCode(serializeCircuit(c));
                    setCodeDirty(false);
                    return c;
                });
            }
            panRef.current = null;
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
    }, [clientToWorld, pendingFrom, snap, tool]);

    const onWheel = useCallback((ev: React.WheelEvent) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        setView((v) => {
            const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
            const scale = Math.min(4, Math.max(0.2, v.scale * factor));
            const k = scale / v.scale;
            return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
        });
    }, []);

    const deleteSelection = useCallback(() => {
        if (!selection) return;
        if (selection.type === "element") {
            const elements = circuit.elements.filter((e) => e.id !== selection.id);
            const used = new Set<string>();
            for (const e of elements) {
                used.add(e.from);
                used.add(e.to);
            }
            for (const t of circuit.texts) if (t.nodeId) used.add(t.nodeId);
            commit({ ...circuit, elements, nodes: circuit.nodes.filter((n) => used.has(n.id)) });
        } else if (selection.type === "text") {
            commit({ ...circuit, texts: circuit.texts.filter((t) => t.id !== selection.id) });
        } else {
            const elements = circuit.elements.filter((e) => e.from !== selection.id && e.to !== selection.id);
            commit({
                ...circuit,
                elements,
                nodes: circuit.nodes.filter((n) => n.id !== selection.id),
                texts: circuit.texts.filter((t) => t.nodeId !== selection.id),
            });
        }
        setSelection(null);
    }, [circuit, commit, selection]);

    /**
     * Copy the current selection, offset by (dx, dy). A component is cloned along
     * with fresh endpoints so the copy is independent of the original.
     */
    const duplicateSelection = useCallback(
        (dx = 0.5, dy = -0.5): Circuit | null => {
            if (!selection) return null;
            if (selection.type === "element") {
                const el = circuit.elements.find((e) => e.id === selection.id);
                if (!el) return null;
                const a = circuit.nodes.find((n) => n.id === el.from);
                const b = circuit.nodes.find((n) => n.id === el.to);
                if (!a || !b) return null;
                const na: CircuitNode = { id: newId("n"), name: "", x: a.x + dx, y: a.y + dy };
                const nb: CircuitNode = { id: newId("n"), name: "", x: b.x + dx, y: b.y + dy };
                const copy: CircuitElement = { ...el, id: newId("e"), from: na.id, to: nb.id };
                const next = {
                    ...circuit,
                    nodes: [...circuit.nodes, na, nb],
                    elements: [...circuit.elements, copy],
                };
                commit(next);
                setSelection({ type: "element", id: copy.id });
                return next;
            }
            if (selection.type === "text") {
                const t = circuit.texts.find((x) => x.id === selection.id);
                if (!t) return null;
                const base = t.nodeId ? { x: t.x, y: t.y } : { x: t.x, y: t.y };
                // A copy is always free-standing, so it can be placed anywhere.
                const copy: CircuitText = {
                    ...t,
                    id: newId("t"),
                    nodeId: undefined,
                    x: base.x + dx,
                    y: base.y + dy,
                };
                const next = { ...circuit, texts: [...circuit.texts, copy] };
                commit(next);
                setSelection({ type: "text", id: copy.id });
                return next;
            }
            return null;
        },
        [circuit, commit, selection]
    );

    /** Arrow-key nudge for whatever is selected. */
    const nudgeSelection = useCallback(
        (dx: number, dy: number) => {
            if (!selection) return;
            if (selection.type === "node") {
                commit({
                    ...circuit,
                    nodes: circuit.nodes.map((n) =>
                        n.id === selection.id
                            ? { ...n, x: Math.round((n.x + dx) * 1000) / 1000, y: Math.round((n.y + dy) * 1000) / 1000 }
                            : n
                    ),
                });
                return;
            }
            if (selection.type === "element") {
                const el = circuit.elements.find((e) => e.id === selection.id);
                if (!el) return;
                commit({
                    ...circuit,
                    nodes: circuit.nodes.map((n) =>
                        n.id === el.from || n.id === el.to
                            ? { ...n, x: Math.round((n.x + dx) * 1000) / 1000, y: Math.round((n.y + dy) * 1000) / 1000 }
                            : n
                    ),
                });
                return;
            }
            const t = circuit.texts.find((x) => x.id === selection.id);
            if (!t) return;
            commit({
                ...circuit,
                texts: circuit.texts.map((x) => {
                    if (x.id !== t.id) return x;
                    return t.nodeId
                        ? { ...x, dx: Math.round(((x.dx || 0) + dx) * 1000) / 1000, dy: Math.round(((x.dy || 0) + dy) * 1000) / 1000 }
                        : { ...x, x: Math.round((x.x + dx) * 1000) / 1000, y: Math.round((x.y + dy) * 1000) / 1000 };
                }),
            });
        },
        [circuit, commit, selection]
    );

    const zoomBy = useCallback((factor: number) => {
        setView((v) => {
            const el = wrapRef.current;
            const w = el?.clientWidth || 800;
            const h = el?.clientHeight || 540;
            const scale = Math.min(4, Math.max(0.2, v.scale * factor));
            const k = scale / v.scale;
            return { scale, tx: w / 2 - (w / 2 - v.tx) * k, ty: h / 2 - (h / 2 - v.ty) * k };
        });
    }, []);

    // Keyboard map. Anything typed into a field is left alone.
    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            const t = ev.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            const mod = ev.ctrlKey || ev.metaKey;
            const key = ev.key;
            const lower = key.toLowerCase();

            if (key === "Delete" || key === "Backspace") {
                ev.preventDefault();
                deleteSelection();
                return;
            }
            if (key === "Escape") {
                ev.preventDefault();
                setPendingFrom(null);
                setTool("select");
                setSelection(null);
                setShowShortcuts(false);
                return;
            }
            if (key === "?" || (mod && key === "/")) {
                ev.preventDefault();
                setShowShortcuts((v) => !v);
                return;
            }
            if (mod && lower === "z") {
                ev.preventDefault();
                if (ev.shiftKey) redo();
                else undo();
                return;
            }
            if (mod && lower === "y") {
                ev.preventDefault();
                redo();
                return;
            }
            if (mod && lower === "d") {
                ev.preventDefault();
                duplicateSelection();
                return;
            }
            if (mod && lower === "c") {
                if (selection?.type === "element") {
                    const el = circuit.elements.find((e) => e.id === selection.id);
                    const a = circuit.nodes.find((n) => n.id === el?.from);
                    const b = circuit.nodes.find((n) => n.id === el?.to);
                    if (el && a && b) setClip({ kind: "element", payload: { el, a, b } });
                } else if (selection?.type === "text") {
                    const tx = circuit.texts.find((x) => x.id === selection.id);
                    if (tx) setClip({ kind: "text", payload: tx });
                }
                return;
            }
            if (mod && lower === "v") {
                if (!clip) return;
                ev.preventDefault();
                if (clip.kind === "element") {
                    const { el, a, b } = clip.payload as { el: CircuitElement; a: CircuitNode; b: CircuitNode };
                    const na: CircuitNode = { id: newId("n"), name: "", x: a.x + 0.5, y: a.y - 0.5 };
                    const nb: CircuitNode = { id: newId("n"), name: "", x: b.x + 0.5, y: b.y - 0.5 };
                    const copy: CircuitElement = { ...el, id: newId("e"), from: na.id, to: nb.id };
                    commit({ ...circuit, nodes: [...circuit.nodes, na, nb], elements: [...circuit.elements, copy] });
                    setSelection({ type: "element", id: copy.id });
                } else {
                    const tx = clip.payload as CircuitText;
                    const copy: CircuitText = { ...tx, id: newId("t"), nodeId: undefined, x: tx.x + 0.5, y: tx.y - 0.5 };
                    commit({ ...circuit, texts: [...circuit.texts, copy] });
                    setSelection({ type: "text", id: copy.id });
                }
                return;
            }
            if (mod && (key === "0" || key === ")")) {
                ev.preventDefault();
                fitToContent(circuit);
                return;
            }
            if (mod && (key === "=" || key === "+")) {
                ev.preventDefault();
                zoomBy(1.2);
                return;
            }
            if (mod && key === "-") {
                ev.preventDefault();
                zoomBy(1 / 1.2);
                return;
            }
            if (key.startsWith("Arrow")) {
                if (!selection) return;
                ev.preventDefault();
                // Alt = fine nudge, Shift = five steps, otherwise one grid step.
                const step = ev.altKey ? 0.05 : (snap || 0.25) * (ev.shiftKey ? 5 : 1);
                const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
                const dy = key === "ArrowUp" ? step : key === "ArrowDown" ? -step : 0;
                nudgeSelection(dx, dy);
                return;
            }
            if (mod) return; // leave the browser's own shortcuts alone

            if (lower === "v") setTool("select");
            else if (lower === "w") { setTool("wire"); setPendingFrom(null); }
            else if (lower === "t") { setTool("text"); setPendingFrom(null); }
            else if (lower === "g") setShowGrid((g) => !g);
            else if (lower === "r" && selection?.type === "element") {
                ev.preventDefault();
                rotateElementRef.current?.(selection.id, ev.shiftKey ? -90 : 90);
            } else if (lower === "f" && selection?.type === "element") {
                const el = circuit.elements.find((e) => e.id === selection.id);
                if (el) commit({ ...circuit, elements: circuit.elements.map((x) => (x.id === el.id ? { ...x, invert: !x.invert || undefined } : x)) });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [circuit, clip, commit, deleteSelection, duplicateSelection, fitToContent, nudgeSelection, redo, selection, snap, undo, zoomBy]);

    /* -------------------------------------------------------------- code pane */

    const applyCode = useCallback(() => {
        const { circuit: c, warnings: w } = parseCircuitTikz(code);
        setPast((p) => [...p.slice(-49), circuit]);
        setFuture([]);
        setCircuit(c);
        setCode(serializeCircuit(c));
        setCodeDirty(false);
        setWarnings(w);
        setSelection(null);
        setPendingFrom(null);
    }, [circuit, code]);

    const loadExample = useCallback(
        (id: string) => {
            const ex = EXAMPLES.find((e) => e.id === id);
            if (!ex) return;
            const { circuit: c, warnings: w } = parseCircuitTikz(ex.code);
            setPast((p) => [...p.slice(-49), circuit]);
            setFuture([]);
            load(c);
            setWarnings(w);
            requestAnimationFrame(() => fitToContent(c));
        },
        [circuit, fitToContent, load]
    );

    const copyCode = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            /* clipboard blocked — the textarea is still selectable by hand */
        }
    }, [code]);

    /* ---------------------------------------------------------------- export */

    const exportBox = useMemo(() => {
        const b = circuitBounds(circuit);
        const pad = 0.75;
        const x = (b.minX - pad) * U;
        const y = -(b.maxY + pad) * U;
        const w = (b.maxX - b.minX + pad * 2) * U;
        const h = (b.maxY - b.minY + pad * 2) * U;
        return { x, y, w: Math.max(w, 40), h: Math.max(h, 40) };
    }, [circuit]);

    const downloadBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    const exportSvgString = useCallback(() => {
        const svg = exportRef.current;
        if (!svg) return null;
        const clone = svg.cloneNode(true) as SVGSVGElement;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        // CSS variables don't survive rasterisation — resolve them to real colours.
        const styles = getComputedStyle(document.documentElement);
        const ink = styles.getPropertyValue("--text-primary").trim() || "#111827";
        clone.innerHTML = clone.innerHTML.replace(/var\(--text-primary\)/g, ink);
        return new XMLSerializer().serializeToString(clone);
    }, []);

    const downloadSvg = useCallback(() => {
        const str = exportSvgString();
        if (!str) return;
        downloadBlob(new Blob([str], { type: "image/svg+xml;charset=utf-8" }), "circuit.svg");
    }, [exportSvgString]);

    const downloadPng = useCallback(() => {
        const str = exportSvgString();
        if (!str) return;
        const blob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const img = new window.Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(exportBox.w * pngScale);
            canvas.height = Math.round(exportBox.h * pngScale);
            const ctx = canvas.getContext("2d");
            if (ctx) {
                if (!transparent) {
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((b) => {
                    if (b) downloadBlob(b, "circuit.png");
                }, "image/png");
            }
            URL.revokeObjectURL(url);
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
    }, [exportBox, exportSvgString, pngScale, transparent]);

    /* ------------------------------------------------------------------- UI  */

    const selectedElement = selection?.type === "element" ? circuit.elements.find((e) => e.id === selection.id) : undefined;
    const selectedNode = selection?.type === "node" ? circuit.nodes.find((n) => n.id === selection.id) : undefined;
    const selectedText = selection?.type === "text" ? circuit.texts.find((t) => t.id === selection.id) : undefined;

    const labelStyleOf = (el: CircuitElement): TextStyle => el.labelStyle || defaultTextStyle();

    const patchLabelStyle = (el: CircuitElement, patch: Partial<TextStyle>) => {
        commit({
            ...circuit,
            elements: circuit.elements.map((e) =>
                e.id === el.id ? { ...e, labelStyle: { ...labelStyleOf(el), ...patch } } : e
            ),
        });
    };

    const updateText = (id: string, patch: Partial<CircuitText>) => {
        commit({ ...circuit, texts: circuit.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    };

    /**
     * Rotate a component about its own midpoint by turning both endpoints. Any
     * point shared with another component is left alone — moving it would drag
     * the rest of the circuit along with it — and the rotation is reported.
     */
    const rotateElement = (id: string, degrees: number) => {
        const el = circuit.elements.find((e) => e.id === id);
        if (!el) return;
        const a = circuit.nodes.find((n) => n.id === el.from);
        const b = circuit.nodes.find((n) => n.id === el.to);
        if (!a || !b) return;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const rad = (degrees * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const spin = (n: CircuitNode) => {
            const dx = n.x - cx;
            const dy = n.y - cy;
            return {
                ...n,
                x: Math.round((cx + dx * cos - dy * sin) * 1000) / 1000,
                y: Math.round((cy + dx * sin + dy * cos) * 1000) / 1000,
            };
        };
        commit({
            ...circuit,
            nodes: circuit.nodes.map((n) => (n.id === a.id || n.id === b.id ? spin(n) : n)),
        });
    };

    rotateElementRef.current = rotateElement;

    const elementAngle = (el: CircuitElement): number => {
        const a = circuit.nodes.find((n) => n.id === el.from);
        const b = circuit.nodes.find((n) => n.id === el.to);
        if (!a || !b) return 0;
        return Math.round(((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) * 10) / 10;
    };

    /** Re-aim a component to an absolute angle, keeping its midpoint and length. */
    const setElementAngle = (el: CircuitElement, degrees: number) => {
        rotateElement(el.id, degrees - elementAngle(el));
    };

    const updateElement = (id: string, patch: Partial<CircuitElement>) => {
        commit({ ...circuit, elements: circuit.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
    };
    const updateNode = (id: string, patch: Partial<CircuitNode>) => {
        commit({ ...circuit, nodes: circuit.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
    };

    const groups = useMemo(() => {
        const g: Record<string, typeof COMPONENTS> = {};
        for (const c of COMPONENTS) {
            if (c.kind === "wire") continue;
            (g[c.group] = g[c.group] || []).push(c);
        }
        return g;
    }, []);

    const gridStep = U * view.scale * (snap || 0.5);

    return (
        <div style={{ display: "grid", gap: 14 }}>
            {/* Action bar */}
            <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <select
                    value=""
                    onChange={(e) => e.target.value && loadExample(e.target.value)}
                    style={{ ...input, width: "auto", minWidth: 190 }}
                    aria-label="Load an example circuit"
                >
                    <option value="">Load an example…</option>
                    {EXAMPLES.map((e) => (
                        <option key={e.id} value={e.id}>
                            {e.name}
                        </option>
                    ))}
                </select>

                <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" style={btn(circuit.style === "american")} onClick={() => commit({ ...circuit, style: "american" as SymbolStyle })}>
                        Zigzag (American)
                    </button>
                    <button type="button" style={btn(circuit.style === "iec")} onClick={() => commit({ ...circuit, style: "iec" as SymbolStyle })}>
                        Box (NCERT / IEC)
                    </button>
                </div>

                <div style={{ flex: 1 }} />

                <button type="button" style={btn()} onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">
                    <Undo2 size={14} /> Undo
                </button>
                <button type="button" style={btn()} onClick={redo} disabled={!future.length} title="Redo (Ctrl+Shift+Z)">
                    <Redo2 size={14} /> Redo
                </button>
                <button type="button" style={btn()} onClick={() => fitToContent(circuit)} title="Fit to view (Ctrl+0)">
                    <Maximize2 size={14} /> Fit
                </button>
                <button type="button" style={btn(showShortcuts)} onClick={() => setShowShortcuts((v) => !v)} title="Keyboard shortcuts (?)">
                    <Keyboard size={14} /> Shortcuts
                </button>
                <button type="button" style={btn()} onClick={downloadSvg}>
                    <Download size={14} /> SVG
                </button>
                <button type="button" style={{ ...btn(true), background: "var(--accent-primary)" }} onClick={downloadPng}>
                    <ImageIcon size={14} /> Download PNG
                </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "210px minmax(0,1fr) 340px", gap: 14, alignItems: "start" }}>
                {/* Palette */}
                <div style={{ ...card, display: "grid", gap: 12 }}>
                    <div>
                        <div style={{ ...label, marginBottom: 6 }}>Tool</div>
                        <div style={{ display: "grid", gap: 6 }}>
                            <button type="button" style={btn(tool === "select")} onClick={() => { setTool("select"); setPendingFrom(null); }}>
                                <MousePointer2 size={14} /> Select &amp; move
                            </button>
                            <button type="button" style={btn(tool === "wire")} onClick={() => { setTool("wire"); setPendingFrom(null); }}>
                                <Hand size={14} /> Wire
                            </button>
                            <button type="button" style={btn(tool === "text")} onClick={() => { setTool("text"); setPendingFrom(null); }}>
                                <Type size={14} /> Text
                            </button>
                        </div>
                    </div>

                    {Object.entries(groups).map(([group, list]) => (
                        <div key={group}>
                            <div style={{ ...label, marginBottom: 6 }}>{group}</div>
                            <div style={{ display: "grid", gap: 5 }}>
                                {list.map((c) => {
                                    const active = tool === c.kind;
                                    return (
                                        <button
                                            key={c.kind}
                                            type="button"
                                            onClick={() => {
                                                setTool(c.kind);
                                                setPendingFrom(null);
                                            }}
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: "60px 1fr",
                                                alignItems: "center",
                                                gap: 6,
                                                padding: "5px 7px",
                                                borderRadius: 8,
                                                border: `1px solid ${active ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                background: active ? "var(--accent-primary-soft, rgba(99,102,241,0.10))" : "var(--bg-tertiary)",
                                                cursor: "pointer",
                                                textAlign: "left",
                                            }}
                                        >
                                            <PalettePreview kind={c.kind} style={circuit.style} color={active ? "var(--accent-primary)" : "var(--text-primary)"} />
                                            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-primary)" }}>{c.label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Canvas */}
                <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                    <div
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 10,
                            alignItems: "center",
                            padding: "9px 12px",
                            borderBottom: "1px solid var(--border-primary)",
                            fontSize: "0.75rem",
                            color: "var(--text-tertiary)",
                        }}
                    >
                        <button type="button" style={btn(showGrid)} onClick={() => setShowGrid((v) => !v)}>
                            <Grid3x3 size={14} /> Grid
                        </button>
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            Snap
                            <select value={snap} onChange={(e) => setSnap(parseFloat(e.target.value))} style={{ ...input, width: "auto", padding: "5px 7px" }}>
                                <option value={0}>Off</option>
                                <option value={0.1}>0.1</option>
                                <option value={0.25}>0.25</option>
                                <option value={0.5}>0.5</option>
                                <option value={1}>1.0</option>
                            </select>
                        </label>
                        <div style={{ flex: 1 }} />
                        <span>
                            {tool === "select"
                                ? "Click a component to edit its value · drag it to move · drag a point to reshape · scroll to zoom"
                                : tool === "text"
                                ? "Click where the text should go"
                                : pendingFrom
                                ? "Click the second point to place it — Esc to cancel"
                                : `Click where the ${spec(tool as ComponentKind).label.toLowerCase()} should start`}
                        </span>
                    </div>

                    <div ref={wrapRef} style={{ height: 540, position: "relative", background: "var(--bg-primary)" }}>
                        <svg
                            ref={svgRef}
                            width="100%"
                            height="100%"
                            onMouseDown={onCanvasDown}
                            onWheel={onWheel}
                            style={{ display: "block", cursor: tool === "select" ? "default" : "crosshair" }}
                        >
                            {showGrid && gridStep > 6 && (
                                <>
                                    <defs>
                                        <pattern
                                            id="cd-grid"
                                            width={gridStep}
                                            height={gridStep}
                                            patternUnits="userSpaceOnUse"
                                            x={view.tx}
                                            y={view.ty}
                                        >
                                            <circle cx={0} cy={0} r={1} fill="var(--border-primary)" />
                                        </pattern>
                                    </defs>
                                    <rect width="100%" height="100%" fill="url(#cd-grid)" />
                                </>
                            )}
                            <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
                                {/* Rubber band while placing */}
                                {pendingFrom && ghost
                                    ? (() => {
                                          const a = circuit.nodes.find((n) => n.id === pendingFrom);
                                          if (!a) return null;
                                          const pa = toPx(a);
                                          const pb = toPx(ghost);
                                          return (
                                              <line
                                                  x1={pa.x}
                                                  y1={pa.y}
                                                  x2={pb.x}
                                                  y2={pb.y}
                                                  stroke="var(--accent-primary)"
                                                  strokeWidth={1.5}
                                                  strokeDasharray="5 4"
                                              />
                                          );
                                      })()
                                    : null}
                                <CircuitGraphics
                                    circuit={circuit}
                                    stroke="var(--text-primary)"
                                    interactive
                                    selection={selection}
                                    pendingFrom={pendingFrom}
                                    onElementDown={onElementDown}
                                    onNodeDown={onNodeDown}
                                    onTextDown={onTextDown}
                                    onElementDoubleClick={onElementDoubleClick}
                                />
                            </g>
                        </svg>
                    </div>
                </div>

                {/* Right column: properties + code */}
                <div style={{ display: "grid", gap: 14 }}>
                    <div style={{ ...card, display: "grid", gap: 10 }}>
                        <div style={label}>Properties</div>

                        {!selection && (
                            <div style={{ fontSize: "0.78rem", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                                Click a component to change its value, drag it to move it, or use the rotate buttons. Drag a point to reshape the circuit. Pick a component from the palette, then click two points to place it.
                            </div>
                        )}

                        {selectedElement && (
                            <>
                                <label style={{ display: "grid", gap: 4 }}>
                                    <span style={label}>Component</span>
                                    <select
                                        value={selectedElement.kind}
                                        onChange={(e) => updateElement(selectedElement.id, { kind: e.target.value as ComponentKind })}
                                        style={input}
                                    >
                                        {COMPONENTS.map((c) => (
                                            <option key={c.kind} value={c.kind}>
                                                {c.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label style={{ display: "grid", gap: 4 }}>
                                    <span style={label}>Value / label (LaTeX, no $)</span>
                                    <input
                                        ref={labelInputRef}
                                        value={selectedElement.label || ""}
                                        onChange={(e) => updateElement(selectedElement.id, { label: e.target.value || undefined })}
                                        placeholder="e.g. 3\,\Omega"
                                        style={{ ...input, fontFamily: "ui-monospace, Menlo, monospace" }}
                                    />
                                    {selectedElement.label ? (
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            renders as <strong>{latexLabelToText(selectedElement.label)}</strong>
                                        </span>
                                    ) : null}
                                </label>

                                {selectedElement.label ? (
                                    <div style={{ display: "grid", gap: 6 }}>
                                        <span style={label}>Label font</span>
                                        <div style={{ display: "grid", gridTemplateColumns: "1fr 76px", gap: 8 }}>
                                            <select
                                                value={labelStyleOf(selectedElement).fontFamily}
                                                onChange={(e) => patchLabelStyle(selectedElement, { fontFamily: e.target.value as FontFamily })}
                                                style={input}
                                            >
                                                {FONT_FAMILIES.map((f) => (
                                                    <option key={f.id} value={f.id}>
                                                        {f.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <input
                                                type="number"
                                                min={4}
                                                max={48}
                                                step={0.5}
                                                value={labelStyleOf(selectedElement).fontSizePt}
                                                onChange={(e) => patchLabelStyle(selectedElement, { fontSizePt: parseFloat(e.target.value) || 10 })}
                                                style={input}
                                                title="Size in pt"
                                            />
                                        </div>
                                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                            <button
                                                type="button"
                                                style={{ ...btn(labelStyleOf(selectedElement).bold), fontWeight: 800, padding: "6px 10px" }}
                                                onClick={() => patchLabelStyle(selectedElement, { bold: !labelStyleOf(selectedElement).bold })}
                                            >
                                                B
                                            </button>
                                            <button
                                                type="button"
                                                style={{ ...btn(labelStyleOf(selectedElement).italic), fontStyle: "italic", padding: "6px 10px" }}
                                                onClick={() => patchLabelStyle(selectedElement, { italic: !labelStyleOf(selectedElement).italic, upright: false })}
                                                title="Force italics"
                                            >
                                                I
                                            </button>
                                            <button
                                                type="button"
                                                style={{ ...btn(labelStyleOf(selectedElement).upright), padding: "6px 10px" }}
                                                onClick={() => patchLabelStyle(selectedElement, { upright: !labelStyleOf(selectedElement).upright, italic: false })}
                                                title="Force upright (roman), overriding the automatic maths italics"
                                            >
                                                Aa
                                            </button>
                                            {TEXT_COLORS.map((c) => (
                                                <button
                                                    key={c}
                                                    type="button"
                                                    onClick={() => patchLabelStyle(selectedElement, { color: c })}
                                                    title={c}
                                                    aria-label={c}
                                                    style={{
                                                        width: 22,
                                                        height: 22,
                                                        borderRadius: 6,
                                                        cursor: "pointer",
                                                        background: colorCss(c),
                                                        border: `2px solid ${labelStyleOf(selectedElement).color === c ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                                    }}
                                                />
                                            ))}
                                        </div>
                                        <div style={{ fontSize: "0.71rem", color: "var(--text-tertiary)", lineHeight: 1.45 }}>
                                            Variables slant and numbers/units stay upright automatically, the way LaTeX
                                            sets maths. Use <strong>Aa</strong> to force the whole label upright.
                                        </div>
                                    </div>
                                ) : null}
                                <div style={{ display: "flex", gap: 6 }}>
                                    <button
                                        type="button"
                                        style={btn(selectedElement.labelSide !== "below")}
                                        onClick={() => updateElement(selectedElement.id, { labelSide: "above" })}
                                    >
                                        Label above
                                    </button>
                                    <button
                                        type="button"
                                        style={btn(selectedElement.labelSide === "below")}
                                        onClick={() => updateElement(selectedElement.id, { labelSide: "below" })}
                                    >
                                        Below
                                    </button>
                                </div>
                                <div style={{ display: "grid", gap: 5 }}>
                                    <span style={label}>Rotate</span>
                                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                        <button type="button" style={{ ...btn(), padding: "6px 8px" }} onClick={() => rotateElement(selectedElement.id, 90)} title="Rotate 90° anticlockwise">
                                            <RotateCcw size={13} /> 90°
                                        </button>
                                        <button type="button" style={{ ...btn(), padding: "6px 8px" }} onClick={() => rotateElement(selectedElement.id, 15)} title="Rotate 15° anticlockwise">
                                            <RotateCcw size={13} /> 15°
                                        </button>
                                        <button type="button" style={{ ...btn(), padding: "6px 8px" }} onClick={() => rotateElement(selectedElement.id, -15)} title="Rotate 15° clockwise">
                                            <RotateCw size={13} /> 15°
                                        </button>
                                        <button type="button" style={{ ...btn(), padding: "6px 8px" }} onClick={() => rotateElement(selectedElement.id, -90)} title="Rotate 90° clockwise">
                                            <RotateCw size={13} /> 90°
                                        </button>
                                    </div>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>Angle (degrees)</span>
                                        <input
                                            type="number"
                                            step={1}
                                            value={elementAngle(selectedElement)}
                                            onChange={(e) => setElementAngle(selectedElement, parseFloat(e.target.value) || 0)}
                                            style={input}
                                        />
                                    </label>
                                </div>
                                <div style={{ display: "flex", gap: 6 }}>
                                    <button
                                        type="button"
                                        style={btn(Boolean(selectedElement.invert))}
                                        onClick={() => updateElement(selectedElement.id, { invert: !selectedElement.invert || undefined })}
                                    >
                                        Flip polarity
                                    </button>
                                    <button type="button" style={{ ...btn(), color: "var(--accent-danger)" }} onClick={deleteSelection}>
                                        <Trash2 size={14} /> Delete
                                    </button>
                                </div>
                            </>
                        )}

                        {selectedText && (
                            <>
                                <label style={{ display: "grid", gap: 4 }}>
                                    <span style={label}>Text</span>
                                    <input
                                        ref={textInputRef}
                                        value={selectedText.text}
                                        onChange={(e) => updateText(selectedText.id, { text: e.target.value })}
                                        style={{ ...input, fontFamily: selectedText.math ? "ui-monospace, Menlo, monospace" : undefined }}
                                    />
                                </label>
                                <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.78rem", color: "var(--text-primary)" }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedText.math}
                                        onChange={(e) => updateText(selectedText.id, { math: e.target.checked })}
                                    />
                                    Maths mode (italic, LaTeX symbols, wrapped in $…$)
                                </label>
                                {selectedText.math ? (
                                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        renders as <strong>{latexLabelToText(selectedText.text)}</strong>
                                    </span>
                                ) : null}

                                <div style={{ display: "grid", gridTemplateColumns: "1fr 84px", gap: 8 }}>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>Font</span>
                                        <select
                                            value={selectedText.fontFamily}
                                            onChange={(e) => updateText(selectedText.id, { fontFamily: e.target.value as FontFamily })}
                                            style={input}
                                        >
                                            {FONT_FAMILIES.map((f) => (
                                                <option key={f.id} value={f.id}>
                                                    {f.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>Size (pt)</span>
                                        <input
                                            type="number"
                                            min={4}
                                            max={72}
                                            step={0.5}
                                            value={selectedText.fontSizePt}
                                            onChange={(e) => updateText(selectedText.id, { fontSizePt: parseFloat(e.target.value) || 10 })}
                                            style={input}
                                        />
                                    </label>
                                </div>

                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    <button
                                        type="button"
                                        style={{ ...btn(selectedText.bold), fontWeight: 800 }}
                                        onClick={() => updateText(selectedText.id, { bold: !selectedText.bold })}
                                    >
                                        B
                                    </button>
                                    <button
                                        type="button"
                                        style={{ ...btn(selectedText.italic), fontStyle: "italic" }}
                                        onClick={() => updateText(selectedText.id, { italic: !selectedText.italic })}
                                    >
                                        I
                                    </button>
                                    {TEXT_COLORS.map((c) => (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => updateText(selectedText.id, { color: c })}
                                            title={c}
                                            aria-label={c}
                                            style={{
                                                width: 26,
                                                height: 26,
                                                borderRadius: 7,
                                                cursor: "pointer",
                                                background: colorCss(c),
                                                border: `2px solid ${selectedText.color === c ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                            }}
                                        />
                                    ))}
                                </div>

                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>Placement</span>
                                        <select
                                            value={selectedText.anchor}
                                            onChange={(e) => updateText(selectedText.id, { anchor: e.target.value as TextAnchor })}
                                            style={input}
                                        >
                                            <option value="center">centre</option>
                                            <option value="left">left</option>
                                            <option value="right">right</option>
                                            <option value="above">above</option>
                                            <option value="below">below</option>
                                        </select>
                                    </label>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>Rotation</span>
                                        <input
                                            type="number"
                                            step={5}
                                            value={selectedText.rotation}
                                            onChange={(e) => updateText(selectedText.id, { rotation: parseFloat(e.target.value) || 0 })}
                                            style={input}
                                        />
                                    </label>
                                </div>

                                {!selectedText.nodeId && (
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                        <label style={{ display: "grid", gap: 4 }}>
                                            <span style={label}>x</span>
                                            <input
                                                type="number"
                                                step={0.1}
                                                value={selectedText.x}
                                                onChange={(e) => updateText(selectedText.id, { x: parseFloat(e.target.value) || 0 })}
                                                style={input}
                                            />
                                        </label>
                                        <label style={{ display: "grid", gap: 4 }}>
                                            <span style={label}>y</span>
                                            <input
                                                type="number"
                                                step={0.1}
                                                value={selectedText.y}
                                                onChange={(e) => updateText(selectedText.id, { y: parseFloat(e.target.value) || 0 })}
                                                style={input}
                                            />
                                        </label>
                                    </div>
                                )}
                                {selectedText.nodeId ? (
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        Pinned to a circuit point — it moves when that point moves.
                                    </div>
                                ) : null}

                                <button type="button" style={{ ...btn(), color: "var(--accent-danger)" }} onClick={deleteSelection}>
                                    <Trash2 size={14} /> Delete text
                                </button>
                            </>
                        )}

                        {selectedNode && (
                            <>
                                <label style={{ display: "grid", gap: 4 }}>
                                    <span style={label}>Point name (optional)</span>
                                    <input
                                        value={selectedNode.name}
                                        onChange={(e) => updateNode(selectedNode.id, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                                        placeholder="e.g. A"
                                        style={{ ...input, fontFamily: "ui-monospace, Menlo, monospace" }}
                                    />
                                    <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                        Named points become <code>\coordinate</code> lines; unnamed ones are written
                                        inline as coordinates.
                                    </span>
                                </label>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>x</span>
                                        <input
                                            type="number"
                                            step={0.1}
                                            value={selectedNode.x}
                                            onChange={(e) => updateNode(selectedNode.id, { x: parseFloat(e.target.value) || 0 })}
                                            style={input}
                                        />
                                    </label>
                                    <label style={{ display: "grid", gap: 4 }}>
                                        <span style={label}>y</span>
                                        <input
                                            type="number"
                                            step={0.1}
                                            value={selectedNode.y}
                                            onChange={(e) => updateNode(selectedNode.id, { y: parseFloat(e.target.value) || 0 })}
                                            style={input}
                                        />
                                    </label>
                                </div>

                                <div style={{ ...label, marginTop: 2 }}>Labels at this point</div>
                                {circuit.texts.filter((t) => t.nodeId === selectedNode.id).length === 0 && (
                                    <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)" }}>
                                        None yet — add one below, then click it on the canvas to set its font.
                                    </div>
                                )}
                                {circuit.texts
                                    .filter((t) => t.nodeId === selectedNode.id)
                                    .map((t) => (
                                        <div key={t.id} style={{ display: "grid", gridTemplateColumns: "1fr 84px 28px 28px", gap: 5 }}>
                                            <input
                                                value={t.text}
                                                onChange={(e) => updateText(t.id, { text: e.target.value })}
                                                style={{ ...input, fontFamily: "ui-monospace, Menlo, monospace" }}
                                            />
                                            <select
                                                value={t.anchor}
                                                onChange={(e) => updateText(t.id, { anchor: e.target.value as TextAnchor })}
                                                style={{ ...input, padding: "6px 4px" }}
                                            >
                                                <option value="left">left</option>
                                                <option value="right">right</option>
                                                <option value="above">above</option>
                                                <option value="below">below</option>
                                                <option value="center">centre</option>
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() => setSelection({ type: "text", id: t.id })}
                                                style={{ ...btn(), padding: "6px 6px" }}
                                                title="Edit font, size and colour"
                                            >
                                                <Type size={12} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => commit({ ...circuit, texts: circuit.texts.filter((x) => x.id !== t.id) })}
                                                style={{ ...btn(), padding: "6px 6px", color: "var(--accent-danger)" }}
                                                aria-label="Remove label"
                                            >
                                                x
                                            </button>
                                        </div>
                                    ))}
                                <div style={{ display: "flex", gap: 6 }}>
                                    <button
                                        type="button"
                                        style={btn()}
                                        onClick={() => {
                                            const t = defaultText({
                                                id: newId("t"),
                                                nodeId: selectedNode.id,
                                                x: selectedNode.x,
                                                y: selectedNode.y,
                                                text: "A",
                                                math: true,
                                                anchor: "left",
                                            });
                                            commit({ ...circuit, texts: [...circuit.texts, t] });
                                        }}
                                    >
                                        + Add label
                                    </button>
                                    <button type="button" style={{ ...btn(), color: "var(--accent-danger)" }} onClick={deleteSelection}>
                                        <Trash2 size={14} /> Delete point
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    <div style={{ ...card, display: "grid", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={label}>CircuiTikZ code</div>
                            <div style={{ flex: 1 }} />
                            <button type="button" style={{ ...btn(), padding: "5px 9px" }} onClick={copyCode}>
                                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <textarea
                            value={code}
                            onChange={(e) => {
                                setCode(e.target.value);
                                setCodeDirty(true);
                            }}
                            onKeyDown={(e) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") applyCode();
                            }}
                            spellCheck={false}
                            style={{
                                ...input,
                                minHeight: 300,
                                fontFamily: "ui-monospace, Menlo, monospace",
                                fontSize: "0.72rem",
                                lineHeight: 1.55,
                                resize: "vertical",
                                whiteSpace: "pre",
                                overflowWrap: "normal",
                                overflowX: "auto",
                            }}
                        />
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <button
                                type="button"
                                style={{ ...btn(codeDirty), background: codeDirty ? "var(--accent-primary)" : "var(--bg-tertiary)" }}
                                onClick={applyCode}
                            >
                                Apply to diagram
                            </button>
                            <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                                {codeDirty ? "Edited — apply to redraw (Ctrl+Enter)" : "In sync with the diagram"}
                            </span>
                        </div>

                        {warnings.length > 0 && (
                            <div
                                style={{
                                    fontSize: "0.72rem",
                                    color: "var(--text-tertiary)",
                                    background: "var(--bg-tertiary)",
                                    borderRadius: 8,
                                    padding: "8px 10px",
                                    display: "grid",
                                    gap: 3,
                                }}
                            >
                                {warnings.slice(0, 6).map((w, i) => (
                                    <div key={i}>• {w}</div>
                                ))}
                                {warnings.length > 6 ? <div>…and {warnings.length - 6} more</div> : null}
                            </div>
                        )}
                    </div>

                    <div style={{ ...card, display: "grid", gap: 8 }}>
                        <div style={label}>PNG export</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: "var(--text-primary)" }}>
                                Scale
                                <select value={pngScale} onChange={(e) => setPngScale(parseInt(e.target.value, 10))} style={{ ...input, width: "auto", padding: "5px 7px" }}>
                                    <option value={1}>1×</option>
                                    <option value={2}>2×</option>
                                    <option value={3}>3×</option>
                                    <option value={4}>4×</option>
                                </select>
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: "var(--text-primary)" }}>
                                <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
                                Transparent background
                            </label>
                        </div>
                        <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                            {Math.round(exportBox.w * pngScale)} × {Math.round(exportBox.h * pngScale)} px
                        </div>
                    </div>
                </div>
            </div>

            {showShortcuts && (
                <div
                    onClick={() => setShowShortcuts(false)}
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.45)",
                        display: "grid",
                        placeItems: "center",
                        zIndex: 1000,
                        padding: 20,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            ...card,
                            maxWidth: 720,
                            width: "100%",
                            maxHeight: "84vh",
                            overflowY: "auto",
                            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                            <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 800, color: "var(--text-primary)" }}>
                                Keyboard &amp; mouse
                            </h2>
                            <div style={{ flex: 1 }} />
                            <button type="button" style={btn()} onClick={() => setShowShortcuts(false)}>
                                Close
                            </button>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 18 }}>
                            {SHORTCUT_GROUPS.map((grp) => (
                                <div key={grp.title}>
                                    <div style={{ ...label, marginBottom: 7 }}>{grp.title}</div>
                                    <div style={{ display: "grid", gap: 5 }}>
                                        {grp.items.map((it) => (
                                            <div
                                                key={it.keys}
                                                style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: "0.79rem" }}
                                            >
                                                <kbd
                                                    style={{
                                                        fontFamily: "ui-monospace, Menlo, monospace",
                                                        fontSize: "0.72rem",
                                                        background: "var(--bg-tertiary)",
                                                        border: "1px solid var(--border-primary)",
                                                        borderRadius: 6,
                                                        padding: "2px 6px",
                                                        whiteSpace: "nowrap",
                                                        color: "var(--text-primary)",
                                                    }}
                                                >
                                                    {it.keys}
                                                </kbd>
                                                <span style={{ color: "var(--text-tertiary)" }}>{it.what}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden, chrome-free copy used for SVG/PNG export. */}
            <svg
                ref={exportRef}
                xmlns="http://www.w3.org/2000/svg"
                width={exportBox.w}
                height={exportBox.h}
                viewBox={`${exportBox.x} ${exportBox.y} ${exportBox.w} ${exportBox.h}`}
                style={{ position: "absolute", left: -100000, top: 0, pointerEvents: "none" }}
                aria-hidden
            >
                <CircuitGraphics circuit={circuit} stroke="var(--text-primary)" interactive={false} />
            </svg>
        </div>
    );
}
