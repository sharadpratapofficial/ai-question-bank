/**
 * The circuit drawing itself, split out from the editor so it has no client-only
 * dependencies: the live canvas, the hidden export SVG, and the headless render
 * used by tests all draw through this one component.
 *
 * Hit targets live in a single layer drawn last, above every painted mark, and
 * every painted mark is `pointer-events: none`. That ordering matters: a label
 * sitting over its own component used to swallow the click, so clicking the "3 Ω"
 * you wanted to edit did nothing at all.
 */

import React, { useMemo } from "react";

import { bodyPx, latexLabelToRuns, latexLabelToText, renderBody, renderGround } from "./symbols";
import {
    Circuit,
    CircuitText,
    DEFAULT_FONT_SIZE_PT,
    TextStyle,
    colorCss,
    defaultTextStyle,
    fontCss,
    nodeDegree,
    spec,
} from "./types";

export type Selection =
    | { type: "node"; id: string }
    | { type: "element"; id: string }
    | { type: "text"; id: string }
    | null;

/** px per TikZ unit at zoom 1. */
export const U = 60;

export function toPx(n: { x: number; y: number }) {
    return { x: n.x * U, y: -n.y * U };
}

/** Where a text object sits, following its anchor point when it has one. */
export function textPos(t: CircuitText, circuit: Circuit): { x: number; y: number } {
    if (t.nodeId) {
        const n = circuit.nodes.find((x) => x.id === t.nodeId);
        if (n) return { x: n.x, y: n.y };
    }
    return { x: t.x, y: t.y };
}

/** Screen offset applied for a text's anchor plus its free nudge, in px. */
export function textOffset(t: CircuitText): { dx: number; dy: number } {
    const off = 11 + t.offsetPt * 1.2;
    return {
        dx: (t.anchor === "left" ? -off : t.anchor === "right" ? off : 0) + (t.dx || 0) * U,
        dy: (t.anchor === "above" ? -off : t.anchor === "below" ? off : 0) - (t.dy || 0) * U,
    };
}

/** Renders a LaTeX-ish label as styled tspans, honouring an explicit style. */
function StyledLabel({
    source,
    math,
    style,
    fallbackColor,
}: {
    source: string;
    math: boolean;
    style?: TextStyle;
    fallbackColor: string;
}) {
    const st = style || defaultTextStyle();
    const runs = latexLabelToRuns(source, math);
    return (
        <>
            {runs.map((r, i) => (
                <tspan
                    key={i}
                    fontStyle={st.upright ? "normal" : st.italic || r.italic ? "italic" : "normal"}
                    fontWeight={st.bold || r.bold ? 700 : 400}
                >
                    {r.text}
                </tspan>
            ))}
        </>
    );
}

const NO_POINTER: React.CSSProperties = { pointerEvents: "none", userSelect: "none" };

export interface DrawOpts {
    circuit: Circuit;
    stroke: string;
    /** Editing chrome (node handles, selection highlight, hit targets). */
    interactive: boolean;
    selection?: Selection;
    pendingFrom?: string | null;
    onElementDown?: (e: React.MouseEvent, id: string) => void;
    onNodeDown?: (e: React.MouseEvent, id: string) => void;
    onTextDown?: (e: React.MouseEvent, id: string) => void;
    onElementDoubleClick?: (id: string) => void;
}

export function CircuitGraphics({
    circuit,
    stroke,
    interactive,
    selection,
    pendingFrom,
    onElementDown,
    onNodeDown,
    onTextDown,
    onElementDoubleClick,
}: DrawOpts) {
    const nodeById = useMemo(() => new Map(circuit.nodes.map((n) => [n.id, n])), [circuit.nodes]);
    const sw = circuit.lineWidth * 1.6;
    const accent = "var(--accent-primary)";

    /** Geometry shared by the painted pass and the hit-target pass. */
    const geom = useMemo(
        () =>
            circuit.elements.map((el) => {
                const a = nodeById.get(el.from);
                const b = nodeById.get(el.to);
                if (!a || !b) return null;
                const pa = toPx(a);
                const pb = toPx(b);
                const dx = pb.x - pa.x;
                const dy = pb.y - pa.y;
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len;
                const uy = dy / len;
                const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
                const L = el.kind === "ground" || el.kind === "wire" ? 0 : Math.min(bodyPx(el.kind, U), len * 0.8);
                const mx = (pa.x + pb.x) / 2;
                const my = (pa.y + pb.y) / 2;
                return { el, pa, pb, ux, uy, ang, len, L, mx, my };
            }),
        [circuit.elements, nodeById]
    );

    return (
        <>
            {geom.map((g) => {
                if (!g) return null;
                const { el, pa, pb, ux, uy, ang, L, mx, my } = g;
                const selected = interactive && selection?.type === "element" && selection.id === el.id;
                const color = selected ? accent : stroke;
                const leadA = { x: mx - ux * (L / 2), y: my - uy * (L / 2) };
                const leadB = { x: mx + ux * (L / 2), y: my + uy * (L / 2) };

                // Perpendicular pointing "up" on screen, for the label.
                const px = uy;
                const py = -ux;
                const clearance = (spec(el.kind).bodyHalfHeight || 0.12) * U + 13;
                const side = el.labelSide === "below" ? -1 : 1;
                const lx = mx + px * clearance * side;
                const ly = my + py * clearance * side;
                let labelAng = ang;
                if (labelAng > 90) labelAng -= 180;
                if (labelAng < -90) labelAng += 180;

                return (
                    <g key={el.id} style={NO_POINTER}>
                        {selected && (
                            <line
                                x1={pa.x}
                                y1={pa.y}
                                x2={pb.x}
                                y2={pb.y}
                                stroke={accent}
                                strokeWidth={sw * 4}
                                strokeLinecap="round"
                                opacity={0.16}
                            />
                        )}
                        {L > 0 ? (
                            <>
                                <line x1={pa.x} y1={pa.y} x2={leadA.x} y2={leadA.y} stroke={color} strokeWidth={sw} strokeLinecap="round" />
                                <line x1={leadB.x} y1={leadB.y} x2={pb.x} y2={pb.y} stroke={color} strokeWidth={sw} strokeLinecap="round" />
                                <g transform={`translate(${mx},${my}) rotate(${ang})${el.invert ? " scale(-1,1)" : ""}`}>
                                    {renderBody(el.kind, circuit.style, U, sw, color)}
                                </g>
                            </>
                        ) : (
                            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={color} strokeWidth={sw} strokeLinecap="round" />
                        )}

                        {el.kind === "ground" && (
                            <g transform={`translate(${pb.x},${pb.y})`}>{renderGround(U, sw, color)}</g>
                        )}

                        {el.label ? (
                            <text
                                x={lx}
                                y={ly}
                                transform={`rotate(${labelAng},${lx},${ly})`}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={(el.labelStyle?.fontSizePt ?? DEFAULT_FONT_SIZE_PT) * 1.5}
                                fontFamily={fontCss(el.labelStyle?.fontFamily ?? "serif")}
                                fill={selected ? accent : colorCss(el.labelStyle?.color ?? "black")}
                                style={NO_POINTER}
                            >
                                <StyledLabel source={el.label} math style={el.labelStyle} fallbackColor={color} />
                            </text>
                        ) : null}
                    </g>
                );
            })}

            {/* Junction dots wherever three or more elements meet. */}
            {circuit.nodes.map((n) => {
                const deg = nodeDegree(circuit, n.id);
                if (deg < 3) return null;
                const p = toPx(n);
                return <circle key={`j${n.id}`} cx={p.x} cy={p.y} r={sw * 1.5} fill={stroke} style={NO_POINTER} />;
            })}

            {circuit.texts.map((t) => {
                const base = toPx(textPos(t, circuit));
                const { dx, dy } = textOffset(t);
                const x = base.x + dx;
                const y = base.y + dy;
                const anchor = t.anchor === "left" ? "end" : t.anchor === "right" ? "start" : "middle";
                const baseline = t.anchor === "above" ? "auto" : t.anchor === "below" ? "hanging" : "central";
                const selected = interactive && selection?.type === "text" && selection.id === t.id;
                // pt -> px at the canvas's own scale; 10pt reads like the old 16px label.
                const size = t.fontSizePt * 1.6;
                return (
                    <text
                        key={t.id}
                        x={x}
                        y={y}
                        transform={t.rotation ? `rotate(${-t.rotation},${x},${y})` : undefined}
                        textAnchor={anchor}
                        dominantBaseline={baseline}
                        fontSize={size}
                        fontFamily={fontCss(t.fontFamily)}
                        fill={selected ? accent : colorCss(t.color)}
                        style={NO_POINTER}
                    >
                        <StyledLabel
                            source={t.text}
                            math={t.math}
                            style={{
                                fontFamily: t.fontFamily,
                                fontSizePt: t.fontSizePt,
                                bold: t.bold,
                                italic: t.italic,
                                upright: false,
                                color: t.color,
                            }}
                            fallbackColor={colorCss(t.color)}
                        />
                    </text>
                );
            })}

            {/* ---- hit layer: last, so nothing painted can swallow a click ---- */}
            {interactive && (
                <g>
                    {geom.map((g) => {
                        if (!g) return null;
                        return (
                            <line
                                key={`hit${g.el.id}`}
                                x1={g.pa.x}
                                y1={g.pa.y}
                                x2={g.pb.x}
                                y2={g.pb.y}
                                stroke="transparent"
                                strokeWidth={18}
                                style={{ cursor: "move" }}
                                onMouseDown={(ev) => onElementDown?.(ev, g.el.id)}
                                onDoubleClick={() => onElementDoubleClick?.(g.el.id)}
                            />
                        );
                    })}

                    {/* A component's own label is part of its hit area. */}
                    {geom.map((g) => {
                        if (!g || !g.el.label) return null;
                        const { el, ux, uy, mx, my } = g;
                        const px = uy;
                        const py = -ux;
                        const clearance = (spec(el.kind).bodyHalfHeight || 0.12) * U + 13;
                        const side = el.labelSide === "below" ? -1 : 1;
                        const fs = (el.labelStyle?.fontSizePt ?? DEFAULT_FONT_SIZE_PT) * 1.5;
                        const w = Math.max(22, latexLabelToText(el.label || "").length * fs * 0.6);
                        const h = fs * 1.5;
                        return (
                            <rect
                                key={`lh${el.id}`}
                                x={mx + px * clearance * side - w / 2}
                                y={my + py * clearance * side - h / 2}
                                width={w}
                                height={h}
                                fill="transparent"
                                style={{ cursor: "move" }}
                                onMouseDown={(ev) => onElementDown?.(ev, el.id)}
                                onDoubleClick={() => onElementDoubleClick?.(el.id)}
                            />
                        );
                    })}

                    {circuit.texts.map((t) => {
                        const base = toPx(textPos(t, circuit));
                        const { dx, dy } = textOffset(t);
                        const x = base.x + dx;
                        const y = base.y + dy;
                        const size = t.fontSizePt * 1.6;
                        const w = Math.max(20, (t.math ? latexLabelToText(t.text) : t.text).length * size * 0.62);
                        const left = t.anchor === "left" ? x - w : t.anchor === "right" ? x : x - w / 2;
                        const top = t.anchor === "above" ? y - size : t.anchor === "below" ? y : y - size * 0.62;
                        return (
                            <rect
                                key={`th${t.id}`}
                                x={left}
                                y={top}
                                width={w}
                                height={size * 1.25}
                                transform={t.rotation ? `rotate(${-t.rotation},${x},${y})` : undefined}
                                fill="transparent"
                                style={{ cursor: "move" }}
                                onMouseDown={(ev) => onTextDown?.(ev, t.id)}
                            />
                        );
                    })}

                    {circuit.nodes.map((n) => {
                        const p = toPx(n);
                        const selected = selection?.type === "node" && selection.id === n.id;
                        const pending = pendingFrom === n.id;
                        return (
                            <g key={`h${n.id}`}>
                                <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={7}
                                    fill={selected || pending ? "var(--accent-primary)" : "var(--bg-secondary)"}
                                    stroke={selected || pending ? "var(--accent-primary)" : "var(--text-tertiary)"}
                                    strokeWidth={1.5}
                                    opacity={selected || pending ? 1 : 0.7}
                                    style={{ cursor: "grab" }}
                                    onMouseDown={(ev) => onNodeDown?.(ev, n.id)}
                                />
                                {n.name && selected ? (
                                    <text
                                        x={p.x + 11}
                                        y={p.y - 11}
                                        fontSize={11}
                                        fontFamily="ui-monospace, Menlo, monospace"
                                        fill="var(--accent-primary)"
                                        style={NO_POINTER}
                                    >
                                        {n.name}
                                    </text>
                                ) : null}
                            </g>
                        );
                    })}
                </g>
            )}
        </>
    );
}
