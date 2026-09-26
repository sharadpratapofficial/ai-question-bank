import { saveAs } from "file-saver";
import { Document, Packer, Paragraph, TextRun } from "docx";

export interface TranslationDocumentDownloadOptions {
    title: string;
    targetLanguage: string;
    html: string;
    plainText?: string;
    filename?: string;
}

function stripHtmlToText(html: string): string {
    if (typeof document !== "undefined") {
        const element = document.createElement("div");
        element.innerHTML = html;
        return (element.textContent || element.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    }
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function safeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "translated-document";
}

export async function downloadTranslationAsDocx(options: TranslationDocumentDownloadOptions): Promise<void> {
    const text = (options.plainText || stripHtmlToText(options.html)).trim();
    const paragraphs = text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

    const doc = new Document({
        sections: [
            {
                children: [
                    new Paragraph({
                        children: [new TextRun({ text: options.title, bold: true, size: 30 })],
                        spacing: { after: 120 },
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: `Language: ${options.targetLanguage}`, color: "666666", size: 20 })],
                        spacing: { after: 240 },
                    }),
                    ...paragraphs.map(
                        (paragraph) =>
                            new Paragraph({
                                children: [new TextRun({ text: paragraph, size: 22 })],
                                spacing: { after: 160, line: 320 },
                            })
                    ),
                ],
            },
        ],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${safeFilename(options.filename || options.title)}.docx`);
}

export async function downloadTranslationAsPDF(options: TranslationDocumentDownloadOptions): Promise<void> {
    const [{ jsPDF }, html2canvasModule] = await Promise.all([
        import("jspdf"),
        import("html2canvas"),
    ]);
    const html2canvas = html2canvasModule.default;

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-10000px";
    container.style.top = "0";
    container.style.width = "794px";
    container.style.background = "#ffffff";
    container.style.color = "#111827";
    container.style.fontFamily = "Arial, sans-serif";
    container.style.fontSize = "14px";
    container.style.lineHeight = "1.6";
    container.style.padding = "36px";
    container.innerHTML = `
        <h1 style="font-size:22px;margin:0 0 6px 0;">${options.title}</h1>
        <div style="font-size:12px;color:#64748b;margin-bottom:18px;">Language: ${options.targetLanguage}</div>
        <div>${options.html || `<pre style="white-space:pre-wrap;">${options.plainText || ""}</pre>`}</div>
    `;
    document.body.appendChild(container);

    try {
        const canvas = await html2canvas(container, {
            scale: 2,
            backgroundColor: "#ffffff",
            useCORS: true,
        });
        const pdf = new jsPDF("p", "mm", "a4");
        const pageWidth = 210;
        const pageHeight = 297;
        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const imgData = canvas.toDataURL("image/png");

        let y = 0;
        pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight);
        let remaining = imgHeight - pageHeight;
        while (remaining > 0) {
            y -= pageHeight;
            pdf.addPage();
            pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight);
            remaining -= pageHeight;
        }

        pdf.save(`${safeFilename(options.filename || options.title)}.pdf`);
    } finally {
        document.body.removeChild(container);
    }
}
