"use client";

import { useEffect, useRef, useMemo } from "react";
import katex from "katex";

interface MathContentProps {
    html: string;
    className?: string;
    style?: React.CSSProperties;
}

/**
 * Renders HTML content with LaTeX math expressions.
 * Supports:
 *   - \( ... \)  inline math  (LaTeX)
 *   - \[ ... \]  display math (LaTeX)
 *   - $$ ... $$  display math (LaTeX)
 *   - <math>...</math>  MathML (browser-native, left untouched)
 *
 * Handles cases where delimiters span across multiple HTML elements
 * (e.g. \[ in one <p> and \] in another).
 */
export default function MathContent({ html, className, style }: MathContentProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    // Pre-process: render LaTeX in the HTML string itself
    const processedHtml = useMemo(() => renderLatexInHtml(html), [html]);

    // Post-process: handle any remaining text-node-level LaTeX
    // (edge cases where regex on HTML missed something)
    useEffect(() => {
        if (!containerRef.current) return;
        renderLatexInTextNodes(containerRef.current);
    }, [processedHtml]);

    return (
        <div
            ref={containerRef}
            className={className}
            style={style}
            dangerouslySetInnerHTML={{ __html: processedHtml }}
        />
    );
}

/**
 * Strip HTML tags from a string to extract pure LaTeX content.
 * Preserves meaningful whitespace/newlines from <br> and <p> boundaries.
 */
function stripHtmlForLatex(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/p>\s*<p[^>]*>/gi, " \n ")
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
        .trim();
}

/**
 * Render a LaTeX string to HTML via KaTeX, returning the original on failure.
 */
function renderKatex(latex: string, displayMode: boolean): string | null {
    const cleaned = stripHtmlForLatex(latex);
    if (!cleaned) return null;

    try {
        return katex.renderToString(cleaned, {
            throwOnError: false,
            displayMode,
            output: "html",
            strict: false,
            trust: true,
            fleqn: false,
        });
    } catch {
        return null;
    }
}

/**
 * Process the raw HTML string to find and render LaTeX delimiters,
 * even when they span across HTML elements like <p> tags.
 */
function renderLatexInHtml(html: string): string {
    let result = html;

    // 1. Display math: \[...\]  (can span across tags)
    //    The regex uses [\s\S] to match across newlines/tags
    result = result.replace(
        /\\\[([\s\S]*?)\\\]/g,
        (match, inner) => {
            const rendered = renderKatex(inner, true);
            if (rendered) {
                return `<div class="katex-display-wrapper">${rendered}</div>`;
            }
            return match;
        }
    );

    // 2. Display math: $$...$$ (can span across tags)
    result = result.replace(
        /\$\$([\s\S]*?)\$\$/g,
        (match, inner) => {
            const rendered = renderKatex(inner, true);
            if (rendered) {
                return `<div class="katex-display-wrapper">${rendered}</div>`;
            }
            return match;
        }
    );

    // 3. Inline math: \(...\)
    //    Use a non-greedy match; limit to avoid matching across paragraphs unnecessarily
    result = result.replace(
        /\\\(([\s\S]*?)\\\)/g,
        (match, inner) => {
            const rendered = renderKatex(inner, false);
            if (rendered) {
                return rendered;
            }
            return match;
        }
    );

    // 4. Inline math: $...$ (single dollar — NOT $$)
    //    Matches $content$ where content is non-empty and doesn't contain $
    //    Avoids matching inside already-rendered katex or $$ blocks
    result = result.replace(
        /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g,
        (match, inner) => {
            const rendered = renderKatex(inner, false);
            if (rendered) {
                return rendered;
            }
            return match;
        }
    );

    return result;
}

// ─── Fallback: text-node-level processing ──────────────────────────────────

/**
 * Walk through text nodes for any remaining LaTeX delimiters
 * that weren't caught by the HTML-level regex pass.
 */
function renderLatexInTextNodes(element: HTMLElement) {
    const delimiters = [
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
    ];

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (parent) {
                // Skip already-rendered KaTeX and special elements
                if (parent.closest(".katex") || parent.closest(".katex-display-wrapper")) {
                    return NodeFilter.FILTER_REJECT;
                }
                const tag = parent.tagName.toLowerCase();
                if (["math", "script", "style", "code", "pre"].includes(tag)) {
                    return NodeFilter.FILTER_REJECT;
                }
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
        textNodes.push(node);
    }

    for (const textNode of textNodes) {
        const text = textNode.textContent || "";

        let hasLatex = false;
        for (const d of delimiters) {
            if (text.includes(d.left)) {
                hasLatex = true;
                break;
            }
        }
        if (!hasLatex) continue;

        const fragment = processTextWithLatex(text, delimiters);
        if (fragment && textNode.parentNode) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
    }
}

interface Delimiter {
    left: string;
    right: string;
    display: boolean;
}

function processTextWithLatex(text: string, delimiters: Delimiter[]): DocumentFragment | null {
    const fragment = document.createDocumentFragment();
    let remaining = text;
    let foundAny = false;

    while (remaining.length > 0) {
        let earliestIndex = Infinity;
        let matchedDelimiter: Delimiter | null = null;

        for (const d of delimiters) {
            const idx = remaining.indexOf(d.left);
            if (idx !== -1 && idx < earliestIndex) {
                earliestIndex = idx;
                matchedDelimiter = d;
            }
        }

        if (!matchedDelimiter || earliestIndex === Infinity) {
            fragment.appendChild(document.createTextNode(remaining));
            break;
        }

        if (earliestIndex > 0) {
            fragment.appendChild(document.createTextNode(remaining.slice(0, earliestIndex)));
        }

        const afterOpen = earliestIndex + matchedDelimiter.left.length;
        const closeIndex = remaining.indexOf(matchedDelimiter.right, afterOpen);

        if (closeIndex === -1) {
            fragment.appendChild(document.createTextNode(remaining.slice(earliestIndex)));
            break;
        }

        const latex = remaining.slice(afterOpen, closeIndex);

        try {
            const span = document.createElement("span");
            katex.render(latex, span, {
                throwOnError: false,
                displayMode: matchedDelimiter.display,
                output: "html",
                strict: false,
                trust: true,
                fleqn: false,
            });
            fragment.appendChild(span);
            foundAny = true;
        } catch {
            fragment.appendChild(
                document.createTextNode(
                    matchedDelimiter.left + latex + matchedDelimiter.right
                )
            );
        }

        remaining = remaining.slice(closeIndex + matchedDelimiter.right.length);
    }

    return foundAny ? fragment : null;
}
