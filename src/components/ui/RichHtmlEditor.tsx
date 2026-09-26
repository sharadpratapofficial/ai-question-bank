"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useState } from "react";

const TinyMCEEditor = dynamic(
    () => import("@tinymce/tinymce-react").then((mod) => mod.Editor),
    { ssr: false }
);

export interface RichHtmlEditorProps {
    value: string;
    onChange: (value: string) => void;
    minHeight?: number;
    maxHeight?: number;
    placeholder?: string;
    onFocus?: () => void;
}

interface BlobInfoLike {
    blob: () => Blob;
    base64: () => string;
}

interface EditorLike {
    on: (eventName: string, callback: () => void) => void;
}

function resolveTheme(): "light" | "dark" {
    if (typeof document === "undefined") return "dark";
    return document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark";
}

export default function RichHtmlEditor({
    value,
    onChange,
    minHeight = 180,
    maxHeight = 560,
    placeholder = "",
    onFocus,
}: RichHtmlEditorProps) {
    const [theme, setTheme] = useState<"light" | "dark">("dark");
    const editorId = useId();

    useEffect(() => {
        if (typeof document === "undefined") return;
        const updateTheme = () => setTheme(resolveTheme());
        updateTheme();

        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });

        return () => observer.disconnect();
    }, []);

    const isLight = theme === "light";

    const initConfig = useMemo(
        () => ({
            menubar: false,
            branding: false,
            resize: false,
            autoresize_bottom_margin: 10,
            autoresize_overflow_padding: 8,
            min_height: minHeight,
            max_height: maxHeight,
            toolbar_sticky: false,
            toolbar_mode: "wrap",
            skin: isLight ? "oxide" : "oxide-dark",
            content_css: isLight ? "default" : "dark",
            toolbar:
                "undo redo blocks bold italic superscript subscript forecolor backcolor " +
                "alignleft aligncenter alignright alignjustify bullist numlist outdent indent table image link code preview removeformat",
            plugins: [
                "advlist",
                "autoresize",
                "autolink",
                "charmap",
                "code",
                "image",
                "link",
                "lists",
                "preview",
                "searchreplace",
                "table",
                "visualblocks",
                "wordcount",
            ],
            paste_data_images: true,
            automatic_uploads: true,
            image_caption: true,
            image_title: true,
            convert_urls: false,
            verify_html: false,
            valid_elements: "*[*]",
            custom_elements:
                "math,mrow,mi,mn,mo,msup,msub,msubsup,mfrac,msqrt,mroot,mtable,mtr,mtd,semantics,annotation,annotation-xml",
            entity_encoding: "raw",
            placeholder,
            content_style: `
                @import url("https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css");
                body {
                    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 14px;
                    line-height: 1.6;
                    margin: 12px;
                    background: ${isLight ? "#ffffff" : "#0b1220"};
                    color: ${isLight ? "#111827" : "#e5e7eb"};
                }
                p {
                    margin: 0.35rem 0;
                }
                img {
                    max-width: 100%;
                    height: auto;
                }
                .katex {
                    color: ${isLight ? "#111827" : "#e5e7eb"};
                }
                math {
                    color: ${isLight ? "#111827" : "#e5e7eb"};
                }
            `,
            images_upload_handler: (blobInfo: BlobInfoLike) => {
                const mime = blobInfo.blob().type || "image/png";
                return Promise.resolve(`data:${mime};base64,${blobInfo.base64()}`);
            },
            file_picker_types: "image",
            file_picker_callback: (
                callback: (url: string, meta?: Record<string, string>) => void,
                _value: string,
                meta: { filetype?: string }
            ) => {
                if (meta.filetype !== "image") return;
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.onchange = () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = String(reader.result || "");
                        if (!result) return;
                        callback(result, { title: file.name });
                    };
                    reader.readAsDataURL(file);
                };
                input.click();
            },
            setup: (editor: EditorLike) => {
                if (!onFocus) return;
                editor.on("focus", () => onFocus());
            },
        }),
        [isLight, maxHeight, minHeight, onFocus, placeholder]
    );

    return (
        <div
            style={{
                borderRadius: "10px",
                border: "1px solid var(--border-primary)",
                overflow: "hidden",
                background: "var(--bg-secondary)",
            }}
        >
            <TinyMCEEditor
                id={editorId}
                key={`tinymce-${editorId}-${theme}`}
                tinymceScriptSrc="https://cdn.tiny.cloud/1/fdkig9zyp8jaz0gj1ifzyvkdpcm6t0zd5ixwlzghjpon3sw1/tinymce/8/tinymce.min.js"
                value={value}
                onEditorChange={onChange}
                init={initConfig}
            />
        </div>
    );
}
