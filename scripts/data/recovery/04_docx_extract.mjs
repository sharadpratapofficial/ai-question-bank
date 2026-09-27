#!/usr/bin/env node
/**
 * Stage 04: recover question content from local .docx source documents (read-only).
 *
 * Only the AITS Test-03 question/solution pair is extracted. The other two
 * .docx files are app fixtures with no QBG linkage; they are registered but not
 * extracted (see source_document_registry).
 *
 * Equations in these files are MathType OLE objects. MathType (MT6.dll), which
 * the app's own converter (python/qbg_modification/mtef.py) needs, is not
 * installed, and no equation is ever guessed. Each OLE object is therefore kept
 * as an explicit placeholder that records the embedded object and its WMF
 * preview image, and questions containing one are marked NEEDS_REVIEW.
 *
 * Outputs:
 *   data/extracted/docx_questions.jsonl       one record per question found
 *   data/extracted/docx_media/<doc>/...       media referenced by those questions (copied out)
 *   data/extracted/docx_summary.json
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DATA_DIR, REPO_ROOT, ensureDir, writeJsonl, writeJson, sha256File, rel } from "./lib/common.mjs";
import { normalizeAnswer, normalizeOptions, normalizeRichText, dedupeKey } from "./lib/normalize.mjs";
import { SOURCES } from "./sources.mjs";

const OUT_DIR = path.join(DATA_DIR, "extracted");

/** Adobe Symbol font encoding (published mapping) for the code points seen in exam papers. */
const SYMBOL_FONT = {
    0x22: "∀", 0x24: "∃", 0x27: "∋", 0x2a: "∗", 0x2d: "−", 0x40: "≅",
    0x41: "Α", 0x42: "Β", 0x43: "Χ", 0x44: "Δ", 0x45: "Ε", 0x46: "Φ", 0x47: "Γ", 0x48: "Η", 0x49: "Ι", 0x4b: "Κ", 0x4c: "Λ", 0x4d: "Μ", 0x4e: "Ν", 0x4f: "Ο", 0x50: "Π", 0x51: "Θ", 0x52: "Ρ", 0x53: "Σ", 0x54: "Τ", 0x55: "Υ", 0x57: "Ω", 0x58: "Ξ", 0x59: "Ψ", 0x5a: "Ζ",
    0x5c: "∴", 0x5e: "⊥",
    0x61: "α", 0x62: "β", 0x63: "χ", 0x64: "δ", 0x65: "ε", 0x66: "φ", 0x67: "γ", 0x68: "η", 0x69: "ι", 0x6a: "ϕ", 0x6b: "κ", 0x6c: "λ", 0x6d: "μ", 0x6e: "ν", 0x6f: "ο", 0x70: "π", 0x71: "θ", 0x72: "ρ", 0x73: "σ", 0x74: "τ", 0x75: "υ", 0x76: "ϖ", 0x77: "ω", 0x78: "ξ", 0x79: "ψ", 0x7a: "ζ",
    0x7e: "∼", 0xa2: "′", 0xa3: "≤", 0xa5: "∞", 0xab: "↔", 0xac: "←", 0xad: "↑", 0xae: "→", 0xaf: "↓", 0xb0: "°", 0xb1: "±", 0xb2: "″", 0xb3: "≥", 0xb4: "×", 0xb5: "∝", 0xb6: "∂", 0xb7: "•", 0xb8: "÷", 0xb9: "≠", 0xba: "≡", 0xbb: "≈", 0xc5: "⊕", 0xc6: "∅", 0xc7: "∩", 0xc8: "∪", 0xce: "∈", 0xcf: "∉", 0xd0: "∠", 0xd1: "∇", 0xd5: "∏", 0xd6: "√", 0xd7: "⋅", 0xd8: "¬", 0xd9: "∧", 0xda: "∨", 0xdb: "⇔", 0xdc: "⇐", 0xde: "⇒", 0xe5: "∑", 0xf2: "∫",
};

const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parse document.xml into paragraphs of ordered tokens. */
export function parseDocxParagraphs(xml, rels) {
    let body = xml.slice(xml.indexOf("<w:body"));
    body = body.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "").replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g, "");
    const paras = body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    return paras.map((p, index) => {
        const tokens = [];
        for (const run of p.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
            const rPr = (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [""])[0];
            const va = (rPr.match(/<w:vertAlign w:val="(\w+)"/) || [])[1] || null;
            const pieces = run.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "").match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t\/>|<w:tab\/>|<w:br\/>|<w:sym [^>]*\/>|<w:drawing>[\s\S]*?<\/w:drawing>|<w:object[\s\S]*?<\/w:object>|<w:pict>[\s\S]*?<\/w:pict>/g) || [];
            for (const piece of pieces) {
                if (piece === "<w:tab/>") tokens.push({ t: "tab" });
                else if (piece.startsWith("<w:t")) tokens.push({ t: "text", v: decodeXml(piece.replace(/<[^>]+>/g, "")), va });
                else if (piece === "<w:br/>") tokens.push({ t: "br" });
                else if (piece.startsWith("<w:sym")) {
                    const font = (piece.match(/w:font="([^"]+)"/) || [])[1];
                    const code = parseInt((piece.match(/w:char="([0-9A-Fa-f]+)"/) || [])[1] || "0", 16);
                    const low = code >= 0xf000 ? code - 0xf000 : code;
                    const ch = /symbol/i.test(font || "") ? SYMBOL_FONT[low] : null;
                    tokens.push(ch ? { t: "text", v: ch, va, sym: `${font}:${code.toString(16)}` } : { t: "sym_unmapped", font, code: code.toString(16).toUpperCase() });
                } else if (piece.startsWith("<w:object")) {
                    const img = (piece.match(/<v:imagedata [^>]*r:id="([^"]+)"/) || [])[1];
                    const ole = (piece.match(/<o:OLEObject [^>]*r:id="([^"]+)"/) || [])[1];
                    const progId = (piece.match(/ProgID="([^"]+)"/) || [])[1] || null;
                    tokens.push({ t: "ole", progId, ole: ole ? rels.get(ole) : null, preview: img ? rels.get(img) : null });
                } else {
                    const emb = (piece.match(/r:embed="([^"]+)"/) || piece.match(/<v:imagedata [^>]*r:id="([^"]+)"/) || [])[1];
                    tokens.push({ t: "image", src: emb ? rels.get(emb) : null });
                }
            }
        }
        const text = tokens.map((k) => (k.t === "text" ? k.v : k.t === "tab" ? "\t" : k.t === "br" ? "\n" : k.t === "ole" ? "[EQ]" : k.t === "image" ? "[IMG]" : "[SYM?]")).join("");
        return { index, tokens, text };
    });
}

/** Render tokens to HTML. Tabs become spaces; OLE equations become explicit placeholders (never guessed). */
function tokensToHtml(tokens, docSlug) {
    let out = "";
    for (const k of tokens) {
        if (k.t === "text") {
            const s = escHtml(k.v);
            out += k.va === "superscript" ? `<sup>${s}</sup>` : k.va === "subscript" ? `<sub>${s}</sub>` : s;
        } else if (k.t === "tab") out += " ";
        else if (k.t === "br") out += "<br>";
        else if (k.t === "image") out += k.src ? `<img src="docx-media/${docSlug}/${path.basename(k.src)}" data-source-part="word/${k.src}">` : `<span data-missing-image="1">[IMAGE]</span>`;
        else if (k.t === "ole") {
            out += `<span class="unconverted-equation" data-ole-object="${k.ole ? "word/" + k.ole : ""}" data-ole-progid="${k.progId || ""}" data-preview="${k.preview ? "word/" + k.preview : ""}">[EQUATION NOT CONVERTED]</span>`;
        } else if (k.t === "sym_unmapped") out += `<span data-symbol-font="${k.font}" data-char="${k.code}">[SYMBOL]</span>`;
    }
    return out.replace(/ {2,}/g, " ").trim();
}

const Q_START = /^\s*(\d{1,3})\.\s*\t?/;
const OPT_SPLIT = /\((\d)\)\t/;

function stripLeading(tokens, re) {
    // remove the leading "N.\t" or "(k)\t" marker from the first text tokens
    const out = tokens.map((k) => ({ ...k }));
    let acc = "";
    for (let i = 0; i < out.length; i++) {
        if (out[i].t === "tab") { acc += "\t"; out[i] = null; if (re.test(acc)) break; continue; }
        if (out[i].t !== "text") break;
        acc += out[i].v;
        const m = acc.match(re);
        if (m) {
            const rest = acc.slice(m[0].length);
            out[i] = { ...out[i], v: rest };
            for (let j = 0; j < i; j++) out[j] = out[j] && out[j].t === "text" ? null : out[j];
            break;
        }
    }
    return out.filter(Boolean);
}

/** Split an option paragraph "(1)\ta\t(2)\tb" into [{n, tokens}]. */
function splitOptions(tokens) {
    const opts = [];
    let cur = null;
    let pending = "";
    const flushPending = () => { if (pending && cur) cur.tokens.push({ t: "text", v: pending }); pending = ""; };
    for (const k of tokens) {
        if (k.t === "text") {
            let s = k.v;
            let m;
            while ((m = s.match(/\((\d)\)/))) {
                const before = s.slice(0, m.index);
                if (cur && before.trim()) cur.tokens.push({ ...k, v: before });
                cur = { n: Number(m[1]), tokens: [] };
                opts.push(cur);
                s = s.slice(m.index + m[0].length);
            }
            if (s && cur) cur.tokens.push({ ...k, v: s });
        } else if (k.t === "tab") { if (cur && cur.tokens.length) cur.tokens.push(k); }
        else if (cur) cur.tokens.push(k);
    }
    flushPending();
    return opts;
}

export function segmentQuestionPaper(paras) {
    const questions = [];
    let section = null, qtypeHeading = null, cur = null;
    for (const p of paras) {
        const t = p.text.trim();
        const sec = t.match(/^SECTION-[IVX]+\s*\((PHYSICS|CHEMISTRY|MATHEMATICS)\)/i);
        if (sec) { section = sec[1]; cur = null; continue; }
        if (/^Single Correct Type Questions$/i.test(t)) { qtypeHeading = "Single_Choice(SCQ)"; cur = null; continue; }
        if (/^Integer Type Questions$/i.test(t)) { qtypeHeading = "Integer"; cur = null; continue; }
        if (!section) continue;
        const m = p.text.match(/^\s*(\d{1,3})\.\t/);
        if (m) {
            cur = { number: Number(m[1]), section, type_heading: qtypeHeading, stem: [stripLeading(p.tokens, /^\s*\d{1,3}\.\t?/)], stem_paras: [p.index], options: [], option_paras: [] };
            questions.push(cur);
            continue;
        }
        if (!cur || !t && !p.tokens.some((k) => k.t === "ole" || k.t === "image")) continue;
        if (/^\s*\(\d\)\t/.test(p.text)) { cur.options.push(...splitOptions(p.tokens)); cur.option_paras.push(p.index); continue; }
        if (cur.options.length) { cur.options[cur.options.length - 1].tokens.push({ t: "br" }, ...p.tokens); cur.option_paras.push(p.index); continue; }
        cur.stem.push(p.tokens);
        cur.stem_paras.push(p.index);
    }
    return questions;
}

export function segmentSolutions(paras) {
    const key = new Map();
    const sols = new Map();
    let mode = "key", section = null, cur = null;
    for (const p of paras) {
        const t = p.text.trim();
        if (/^SECTION-[IVX]+\s*\(/i.test(t)) { mode = "solutions"; section = t; cur = null; continue; }
        const m = p.text.match(/^\s*(\d{1,3})\.\t\s*\(([^)]*)\)\s*$/) || p.text.match(/^\s*(\d{1,3})\.\t\s*\(([^)]*)\)/);
        if (mode === "key") { if (m) key.set(Number(m[1]), { raw: m[2].trim(), para: p.index }); continue; }
        if (m) {
            cur = { number: Number(m[1]), section, answer_line_raw: m[2].trim(), paras: [], pyq_reference: null };
            sols.set(cur.number, cur);
            const rest = stripLeading(p.tokens, /^\s*\d{1,3}\.\t?\s*\([^)]*\)/);
            if (rest.some((k) => k.t !== "tab" && (k.t !== "text" || k.v.trim()))) cur.paras.push({ tokens: rest, index: p.index });
            continue;
        }
        if (!cur) continue;
        const ref = t.match(/^\[([^\]]*\d{4}[^\]]*)\]$/);
        if (ref) { cur.pyq_reference = ref[1]; continue; }
        if (!t && !p.tokens.some((k) => k.t === "ole" || k.t === "image")) continue;
        cur.paras.push({ tokens: p.tokens, index: p.index });
    }
    return { key, sols };
}

async function loadDoc(file) {
    const z = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await z.file("word/document.xml").async("string");
    const relXml = (await z.file("word/_rels/document.xml.rels")?.async("string")) || "";
    const rels = new Map([...relXml.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const m of relXml.matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) rels.set(m[2], m[1]);
    return { z, paras: parseDocxParagraphs(xml, rels) };
}

async function copyMedia(z, parts, docSlug) {
    const dir = path.join(OUT_DIR, "docx_media", docSlug);
    ensureDir(dir);
    let n = 0;
    for (const part of parts) {
        const f = z.file(`word/${part}`);
        if (!f) continue;
        fs.writeFileSync(path.join(dir, path.basename(part)), await f.async("nodebuffer"));
        n++;
    }
    return n;
}

const collect = (tokensList, kind) => tokensList.flat().filter((k) => k.t === kind);

export async function runDocxExtract() {
    const qSrc = SOURCES.find((s) => s.key === "aits_t03_question_docx");
    const sSrc = SOURCES.find((s) => s.key === "aits_t03_solution_docx");
    const qFile = path.join(REPO_ROOT, qSrc.candidates[0]);
    const sFile = path.join(REPO_ROOT, sSrc.candidates[0]);
    if (!fs.existsSync(qFile)) return { status: "UNAVAILABLE" };
    const docSlug = "aits_t03_12th_jee_main_2024-12-15";
    const qDoc = await loadDoc(qFile);
    const sDoc = fs.existsSync(sFile) ? await loadDoc(sFile) : null;
    const qs = segmentQuestionPaper(qDoc.paras);
    const { key, sols } = sDoc ? segmentSolutions(sDoc.paras) : { key: new Map(), sols: new Map() };
    const qHash = sha256File(qFile), sHash = sDoc ? sha256File(sFile) : null;

    const records = [];
    const mediaQ = new Set(), mediaS = new Set();
    for (const q of qs) {
        const stemTokens = q.stem.flatMap((t, i) => (i ? [{ t: "br" }, ...t] : t));
        const questionHtml = tokensToHtml(stemTokens, docSlug);
        const qtype = q.type_heading;
        const optionTexts = q.options.map((o) => tokensToHtml(o.tokens, docSlug));
        const optionNumbersOk = q.options.every((o, i) => o.n === i + 1);
        const k = key.get(q.number);
        const sol = sols.get(q.number);
        const keyAnswer = k ? normalizeAnswer(k.raw, qtype) : null;
        const solAnswer = sol ? normalizeAnswer(sol.answer_line_raw, qtype) : null;
        const answersAgree = keyAnswer && solAnswer ? JSON.stringify(keyAnswer.normalized_value) === JSON.stringify(solAnswer.normalized_value) : null;
        const answer = keyAnswer?.status === "OK" ? keyAnswer : solAnswer;
        const options = qtype === "Integer" ? normalizeOptions(null, null, "Integer") : normalizeOptions(optionTexts, Array.isArray(answer?.normalized_value) ? answer.normalized_value : null, qtype);
        const solutionTokens = sol ? sol.paras.flatMap((p, i) => (i ? [{ t: "br" }, ...p.tokens] : p.tokens)) : [];
        const solutionHtml = sol ? tokensToHtml(solutionTokens, docSlug) : null;

        const qOle = collect([stemTokens, ...q.options.map((o) => o.tokens)], "ole");
        const qImg = collect([stemTokens, ...q.options.map((o) => o.tokens)], "image");
        const sOle = collect([solutionTokens], "ole");
        const sImg = collect([solutionTokens], "image");
        const unmappedSym = collect([stemTokens, solutionTokens, ...q.options.map((o) => o.tokens)], "sym_unmapped").length;
        qOle.forEach((o) => { if (o.preview) mediaQ.add(o.preview); });
        qImg.forEach((o) => { if (o.src) mediaQ.add(o.src); });
        sOle.forEach((o) => { if (o.preview) mediaS.add(o.preview); });
        sImg.forEach((o) => { if (o.src) mediaS.add(o.src); });

        const issues = [];
        if (qOle.length) issues.push(`QUESTION_HAS_${qOle.length}_UNCONVERTED_OLE_EQUATIONS`);
        if (sOle.length) issues.push(`SOLUTION_HAS_${sOle.length}_UNCONVERTED_OLE_EQUATIONS`);
        if (unmappedSym) issues.push(`UNMAPPED_SYMBOL_CHARS:${unmappedSym}`);
        if (qtype !== "Integer" && (q.options.length !== 4 || !optionNumbersOk)) issues.push(`OPTION_STRUCTURE:${q.options.map((o) => o.n).join(",") || "none"}`);
        if (answersAgree === false) issues.push("ANSWER_KEY_VS_SOLUTION_LINE_DISAGREE");
        if (!k) issues.push("NO_ANSWER_KEY_ENTRY");
        if (!sol) issues.push("NO_SOLUTION_FOUND");

        const contentConfidence = qOle.length || unmappedSym || issues.some((i) => i.startsWith("OPTION_STRUCTURE")) ? "LOW" : "MEDIUM";
        records.push({
            doc_question_key: `docx:${docSlug}#Q${q.number}`,
            origin_type: "IMPORTED_EXTERNAL",
            qbg_id: null,
            qbg_link_status: "NO_QBG_MATCH",
            qbg_link_evidence: "Important IDs AITS sheet lists 75 positions for 15-12-2024 (Arjuna, JEE Main) but its chapters are class-11 (e.g. Q1 Center of Mass, Q26 Thermodynamics, Q51 Binomial Theorem); this document is a 12th paper (Topics Covered: Electric Charges and Fields, Electrochemistry, Determinants, ...; Q1 is about a deuteron in a magnetic field). Same date, different paper: no position mapping applied.",
            source_document: { path: rel(qFile), sha256: qHash, paragraphs: q.stem_paras.concat(q.option_paras) },
            solution_document: sDoc ? { path: rel(sFile), sha256: sHash, paragraphs: sol ? sol.paras.map((p) => p.index) : [], answer_key_paragraph: k?.para ?? null } : null,
            source_question_number: q.number,
            section: q.section,
            subject: { PHYSICS: "Physics", CHEMISTRY: "Chemistry", MATHEMATICS: "Maths" }[q.section] || null,
            question_type: qtype,
            question_type_basis: "SECTION_HEADING",
            question_text: normalizeRichText(questionHtml).normalized_value,
            options_raw: optionTexts,
            options,
            answer_key_raw: k?.raw ?? null,
            solution_answer_line_raw: sol?.answer_line_raw ?? null,
            answer,
            answer_sources_agree: answersAgree,
            solution_text: solutionHtml ? normalizeRichText(solutionHtml).normalized_value : null,
            pyq_reference_text: sol?.pyq_reference ?? null,
            equations: {
                question_ole: qOle.map((o) => ({ ole_object: o.ole ? `word/${o.ole}` : null, prog_id: o.progId, preview_image: o.preview ? `word/${o.preview}` : null })),
                solution_ole: sOle.map((o) => ({ ole_object: o.ole ? `word/${o.ole}` : null, prog_id: o.progId, preview_image: o.preview ? `word/${o.preview}` : null })),
            },
            images: { question: qImg.map((i) => i.src && `word/${i.src}`), solution: sImg.map((i) => i.src && `word/${i.src}`) },
            extraction_method: "docx-xml-token-parse (w:t/w:vertAlign/w:sym[Adobe Symbol]/w:drawing/w:object); OLE equations NOT converted",
            extraction_status: issues.length ? "NEEDS_REVIEW" : "EXTRACTED",
            content_confidence: contentConfidence,
            issues,
            dedupe_key: dedupeKey(questionHtml),
        });
    }

    const copiedQ = await copyMedia(qDoc.z, mediaQ, docSlug);
    const copiedS = sDoc ? await copyMedia(sDoc.z, mediaS, docSlug) : 0;
    writeJsonl(path.join(OUT_DIR, "docx_questions.jsonl"), records);
    const previewExt = {};
    for (const m of [...mediaQ, ...mediaS]) { const e = path.extname(m).toLowerCase(); previewExt[e] = (previewExt[e] || 0) + 1; }
    const summary = {
        documents: [rel(qFile), sDoc ? rel(sFile) : null],
        questions_found: records.length,
        by_section: Object.fromEntries(["PHYSICS", "CHEMISTRY", "MATHEMATICS"].map((s) => [s, records.filter((r) => r.section === s).length])),
        answer_key_entries: key.size,
        solutions_found: sols.size,
        answer_key_vs_solution_disagreements: records.filter((r) => r.answer_sources_agree === false).map((r) => r.source_question_number),
        needs_review: records.filter((r) => r.extraction_status === "NEEDS_REVIEW").length,
        questions_without_ole_in_question: records.filter((r) => !r.equations.question_ole.length).length,
        ole_equations_question_side: records.reduce((s, r) => s + r.equations.question_ole.length, 0),
        ole_equations_solution_side: records.reduce((s, r) => s + r.equations.solution_ole.length, 0),
        media_copied: copiedQ + copiedS,
        media_by_extension: previewExt,
        mathtype_converter_available: false,
        mathtype_note: "OLE (Equation.DSMT4) -> LaTeX needs MathType's MT6.dll (python/qbg_modification/mtef.py). Not installed on this machine; WMF previews are not browser-renderable.",
        not_extracted: [
            { path: "qbg modifier sample file.docx", reason: "App test fixture (JRTS Dropper Test-01 maths excerpt, dated 26-07-2026). No QBG ids; no matching test in Important IDs (JRTS sheet is 2024-25)." },
            { path: "Batch_Test-word (2).docx", reason: "App-generated 'Batch Test' export sample; 'Answer: —' everywhere; no QBG ids." },
        ],
    };
    writeJson(path.join(OUT_DIR, "docx_summary.json"), summary);
    return summary;
}

if (process.argv[1]?.endsWith("04_docx_extract.mjs")) {
    console.log(JSON.stringify(await runDocxExtract(), null, 1));
}
