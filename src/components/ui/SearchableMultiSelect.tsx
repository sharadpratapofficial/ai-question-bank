"use client";

/**
 * A searchable multi-select combobox.
 *
 * Built for lists that keep growing — question sources, for instance, gain an
 * entry every time a paper is uploaded, so a flat grid of chips stops being
 * usable well before the list stops growing. Selected values stay visible as
 * removable tokens; everything else lives behind a type-to-filter dropdown.
 *
 * Keyboard: ArrowUp/Down move the highlight, Enter toggles, Esc closes,
 * Backspace on an empty search box removes the last token.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

export interface SearchableMultiSelectProps {
    options: string[];
    selected: string[];
    onChange: (next: string[]) => void;
    /** Shown in the closed control when nothing is selected. */
    placeholder?: string;
    /** Word for one item, used in the summary line ("12 of 32 sources"). */
    noun?: string;
    /** Optional per-option count, rendered on the right of each row. */
    counts?: Record<string, number>;
    disabled?: boolean;
    /** Tokens shown before collapsing into "+N more". */
    maxTokens?: number;
}

export default function SearchableMultiSelect({
    options,
    selected,
    onChange,
    placeholder = "Search and select…",
    noun = "item",
    counts,
    disabled = false,
    maxTokens = 8,
}: SearchableMultiSelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlight, setHighlight] = useState(0);
    const [showAllTokens, setShowAllTokens] = useState(false);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    const selectedSet = useMemo(() => new Set(selected), [selected]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return options;
        // Every word must appear, so "jee 2024" finds "…JEE Main_13-10-2024…".
        const words = q.split(/\s+/);
        return options.filter((o) => {
            const lower = o.toLowerCase();
            return words.every((w) => lower.includes(w));
        });
    }, [options, query]);

    // Keep the highlight inside the (possibly re-filtered) list.
    useEffect(() => {
        setHighlight((h) => (filtered.length === 0 ? 0 : Math.min(h, filtered.length - 1)));
    }, [filtered.length]);

    useEffect(() => {
        if (!open) return;
        const onDocDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
    }, [open]);

    useEffect(() => {
        if (open) window.setTimeout(() => searchRef.current?.focus(), 0);
        else setQuery("");
    }, [open]);

    // Scroll the highlighted row into view while arrowing through a long list.
    useEffect(() => {
        if (!open) return;
        const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [highlight, open]);

    const toggle = useCallback(
        (value: string) => {
            onChange(
                selectedSet.has(value) ? selected.filter((s) => s !== value) : [...selected, value]
            );
        },
        [onChange, selected, selectedSet]
    );

    const addAllFiltered = useCallback(() => {
        const merged = [...selected];
        for (const o of filtered) if (!merged.includes(o)) merged.push(o);
        onChange(merged);
    }, [filtered, onChange, selected]);

    const removeAllFiltered = useCallback(() => {
        const drop = new Set(filtered);
        onChange(selected.filter((s) => !drop.has(s)));
    }, [filtered, onChange, selected]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => (filtered.length ? (h - 1 + filtered.length) % filtered.length : 0));
        } else if (e.key === "Enter") {
            if (open && filtered[highlight]) {
                e.preventDefault();
                toggle(filtered[highlight]);
            }
        } else if (e.key === "Escape") {
            if (open) {
                e.preventDefault();
                setOpen(false);
            }
        } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
            onChange(selected.slice(0, -1));
        }
    };

    const filteredSelectedCount = filtered.filter((o) => selectedSet.has(o)).length;
    const visibleTokens = showAllTokens ? selected : selected.slice(0, maxTokens);
    const hiddenTokenCount = selected.length - visibleTokens.length;

    const chipStyle: React.CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        padding: "3px 6px 3px 9px",
        borderRadius: 7,
        border: "1px solid rgba(var(--accent-success-rgb), 0.45)",
        background: "rgba(var(--accent-success-rgb), 0.10)",
        color: "var(--text-primary)",
        fontSize: "0.75rem",
        lineHeight: 1.4,
    };

    const toolBtn: React.CSSProperties = {
        padding: "4px 9px",
        borderRadius: 7,
        border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        color: "var(--text-secondary)",
        fontSize: "0.72rem",
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
    };

    return (
        <div ref={rootRef} style={{ position: "relative", display: "grid", gap: 8 }}>
            {/* Closed control — selected values stay visible as removable tokens. */}
            <div
                role="combobox"
                aria-expanded={open}
                aria-haspopup="listbox"
                tabIndex={disabled ? -1 : 0}
                onKeyDown={onKeyDown}
                onClick={() => !disabled && setOpen((v) => !v)}
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                    minHeight: 40,
                    padding: "7px 34px 7px 10px",
                    borderRadius: 9,
                    border: `1px solid ${open ? "var(--accent-primary)" : "var(--border-primary)"}`,
                    background: disabled ? "var(--bg-tertiary)" : "var(--bg-elevated)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.6 : 1,
                    position: "relative",
                }}
            >
                {selected.length === 0 && (
                    <span style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>{placeholder}</span>
                )}

                {visibleTokens.map((value) => (
                    <span key={value} style={chipStyle}>
                        <span
                            style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: 230,
                            }}
                            title={value}
                        >
                            {value}
                        </span>
                        <button
                            type="button"
                            aria-label={`Remove ${value}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange(selected.filter((s) => s !== value));
                            }}
                            style={{
                                display: "grid",
                                placeItems: "center",
                                width: 16,
                                height: 16,
                                borderRadius: 4,
                                border: "none",
                                background: "transparent",
                                color: "var(--text-tertiary)",
                                cursor: "pointer",
                                padding: 0,
                            }}
                        >
                            <X size={11} />
                        </button>
                    </span>
                ))}

                {hiddenTokenCount > 0 && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowAllTokens(true);
                        }}
                        style={{ ...toolBtn, padding: "3px 8px" }}
                    >
                        +{hiddenTokenCount} more
                    </button>
                )}
                {showAllTokens && selected.length > maxTokens && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowAllTokens(false);
                        }}
                        style={{ ...toolBtn, padding: "3px 8px" }}
                    >
                        Show fewer
                    </button>
                )}

                <ChevronDown
                    size={15}
                    style={{
                        position: "absolute",
                        right: 10,
                        top: "50%",
                        transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
                        color: "var(--text-tertiary)",
                        transition: "transform 120ms",
                        pointerEvents: "none",
                    }}
                />
            </div>

            {open && (
                <div
                    style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        right: 0,
                        zIndex: 60,
                        borderRadius: 10,
                        border: "1px solid var(--border-primary)",
                        background: "var(--bg-elevated)",
                        boxShadow: "0 16px 40px rgba(0,0,0,0.28)",
                        overflow: "hidden",
                    }}
                >
                    <div style={{ padding: 8, borderBottom: "1px solid var(--border-secondary)" }}>
                        <div style={{ position: "relative" }}>
                            <Search
                                size={13}
                                style={{
                                    position: "absolute",
                                    left: 9,
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    color: "var(--text-tertiary)",
                                    pointerEvents: "none",
                                }}
                            />
                            <input
                                ref={searchRef}
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setHighlight(0);
                                }}
                                onKeyDown={onKeyDown}
                                placeholder={`Type to filter ${options.length} ${noun}s…`}
                                style={{
                                    width: "100%",
                                    padding: "7px 10px 7px 27px",
                                    borderRadius: 8,
                                    border: "1px solid var(--border-primary)",
                                    background: "var(--bg-tertiary)",
                                    color: "var(--text-primary)",
                                    fontSize: "0.8rem",
                                }}
                            />
                        </div>
                        <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                            <button type="button" style={toolBtn} onClick={addAllFiltered} disabled={filtered.length === 0}>
                                {query.trim() ? `Select these ${filtered.length}` : "Select all"}
                            </button>
                            <button
                                type="button"
                                style={toolBtn}
                                onClick={removeAllFiltered}
                                disabled={filteredSelectedCount === 0}
                            >
                                {query.trim() ? `Clear these ${filteredSelectedCount}` : "Clear all"}
                            </button>
                            <span
                                style={{
                                    marginLeft: "auto",
                                    alignSelf: "center",
                                    fontSize: "0.72rem",
                                    color: "var(--text-tertiary)",
                                }}
                            >
                                {selected.length} of {options.length} selected
                            </span>
                        </div>
                    </div>

                    <div ref={listRef} role="listbox" aria-multiselectable style={{ maxHeight: 260, overflowY: "auto" }}>
                        {filtered.length === 0 && (
                            <div style={{ padding: "14px 12px", fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
                                Nothing matches “{query}”.
                            </div>
                        )}
                        {filtered.map((option, idx) => {
                            const isSelected = selectedSet.has(option);
                            const isHighlighted = idx === highlight;
                            return (
                                <div
                                    key={option}
                                    data-idx={idx}
                                    role="option"
                                    aria-selected={isSelected}
                                    onMouseEnter={() => setHighlight(idx)}
                                    onClick={() => toggle(option)}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 9,
                                        padding: "7px 11px",
                                        cursor: "pointer",
                                        background: isHighlighted ? "var(--bg-tertiary)" : "transparent",
                                        fontSize: "0.8rem",
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <span
                                        style={{
                                            display: "grid",
                                            placeItems: "center",
                                            width: 15,
                                            height: 15,
                                            flexShrink: 0,
                                            borderRadius: 4,
                                            border: `1px solid ${isSelected ? "var(--accent-primary)" : "var(--border-primary)"}`,
                                            background: isSelected ? "var(--accent-primary)" : "transparent",
                                            color: "#fff",
                                        }}
                                    >
                                        {isSelected && <Check size={10} />}
                                    </span>
                                    <span
                                        style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                        title={option}
                                    >
                                        {option}
                                    </span>
                                    {counts && counts[option] !== undefined && (
                                        <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
                                            {counts[option]}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
