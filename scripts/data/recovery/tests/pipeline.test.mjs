import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareValues, conflictSeverity, classifyRecovery, importReadiness, findTextDuplicates, buildRawData } from "../lib/canonical.mjs";
import { uuidv5, stableStringify, writeJsonl, readJsonl, parseCsv, csvCell, writeCsv } from "../lib/common.mjs";
import { segmentByNumberingReset } from "../05_build.mjs";
import { parseDocxParagraphs, segmentQuestionPaper, segmentSolutions } from "../04_docx_extract.mjs";
import { parseMarkdownTables, registerRecords, generatedBank, bookCards } from "../06_rankup.mjs";
import { excelSerialToIso, normalizeDateCell } from "../03_stage.mjs";
import { dedupeKey } from "../lib/normalize.mjs";

const base = { identity_confidence: "HIGH", question_text: null, question_complete: false, options_ok: false, question_type: "Single_Choice(SCQ)", answer_key: null, solution_text: null, solution_complete: false, subject: "Physics", has_document_position: false, has_taxonomy: true, has_test_usage: true, high_conflicts: 0, duplicate_of: null };

test("uuidv5 matches the RFC 4122 test vector and is deterministic", () => {
    assert.equal(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
    assert.equal(uuidv5("qbg:abc"), uuidv5("qbg:abc"));
    assert.notEqual(uuidv5("qbg:abc"), uuidv5("qbg:abd"));
});

test("compareValues: agree, single, conflict never picks a winner", () => {
    assert.equal(compareValues("subject", [{ source: "a", value: "Physics" }, { source: "b", value: "Physics" }]).status, "AGREE");
    assert.equal(compareValues("subject", [{ source: "a", value: "Physics" }, { source: "b", value: null }]).status, "SINGLE");
    const c = compareValues("subject", [{ source: "a", value: "Physics" }, { source: "b", value: "Maths" }]);
    assert.equal(c.status, "CONFLICT");
    assert.equal(c.value, null);
    assert.equal(c.candidates.length, 2);
    // taxonomy names compare case/punctuation-insensitively
    assert.equal(compareValues("chapter", [{ source: "a", value: "Moving Charges & Magnetism" }, { source: "b", value: "moving charges and magnetism" }]).status, "AGREE");
    assert.equal(compareValues("answer", []).status, "NONE");
});

test("conflict severity", () => {
    assert.equal(conflictSeverity("answer", [[1], [2]]), "HIGH");
    assert.equal(conflictSeverity("question_type", ["Single_Choice(SCQ)", "Numerical"]), "HIGH");
    assert.equal(conflictSeverity("question_type", ["Single_Choice(SCQ)", "Multi_Choice(MCQ)"]), "HIGH");
    assert.equal(conflictSeverity("question_type", ["Integer", "Numerical"]), "LOW");
    assert.equal(conflictSeverity("question_type", ["Comprehension(COMP)", "Single_Choice(SCQ)"]), "MEDIUM");
    assert.equal(conflictSeverity("chapter", ["a", "b"]), "MEDIUM");
    assert.equal(conflictSeverity("class_level", ["11", "12"]), "LOW");
});

test("recovery classification covers every class", () => {
    const full = { ...base, question_text: "<p>q</p>", question_complete: true, options_ok: true, answer_key: [2], solution_text: "s", solution_complete: true };
    assert.equal(classifyRecovery(full).recovery_class, "A_FULL");
    assert.equal(classifyRecovery({ ...full, solution_complete: false }).recovery_class, "B_CONTENT_WITHOUT_SOLUTION");
    assert.equal(classifyRecovery({ ...full, question_complete: false }).recovery_class, "C_QUESTION_LINKED");
    assert.equal(classifyRecovery({ ...base, has_document_position: true }).recovery_class, "C_QUESTION_LINKED");
    assert.equal(classifyRecovery({ ...base, answer_key: [1] }).recovery_class, "D_METADATA_PLUS_ANSWER");
    assert.equal(classifyRecovery(base).recovery_class, "E_METADATA_ONLY");
    assert.equal(classifyRecovery({ ...full, high_conflicts: 1 }).recovery_class, "F_CONFLICT");
    assert.equal(classifyRecovery({ ...full, duplicate_of: "x" }).recovery_class, "G_DUPLICATE");
    assert.equal(classifyRecovery({ ...base, identity_confidence: "LOW", has_taxonomy: false, has_test_usage: false }).recovery_class, "H_UNRESOLVED");
    // an option-type question without complete options is never A_FULL
    assert.notEqual(classifyRecovery({ ...full, options_ok: false }).recovery_class, "A_FULL");
});

test("import readiness never auto-imports low confidence or non-content records", () => {
    assert.equal(importReadiness({ identity_confidence: "HIGH", content_confidence: "MEDIUM", open_conflicts: 0, origin_type: "ORIGINAL_QBG", chapter: "x" }, "A_FULL").import_readiness, "READY");
    assert.equal(importReadiness({ identity_confidence: "LOW", content_confidence: "MEDIUM", open_conflicts: 0, origin_type: "ORIGINAL_QBG", chapter: "x" }, "A_FULL").import_readiness, "READY_WITH_REVIEW");
    assert.equal(importReadiness({ identity_confidence: "HIGH", content_confidence: "LOW", open_conflicts: 0, origin_type: "ORIGINAL_QBG", chapter: "x" }, "A_FULL").import_readiness, "READY_WITH_REVIEW");
    assert.equal(importReadiness({ identity_confidence: "HIGH", content_confidence: "HIGH", open_conflicts: 0, origin_type: "IMPORTED_EXTERNAL", chapter: "x" }, "A_FULL").import_readiness, "READY_WITH_REVIEW");
    assert.equal(importReadiness({ identity_confidence: "HIGH", content_confidence: "HIGH", open_conflicts: 0, origin_type: "ORIGINAL_QBG", chapter: "x" }, "E_METADATA_ONLY").import_readiness, "NOT_READY");
});

test("duplicate detection: exact, near, blocked by subject", () => {
    const k = (s) => dedupeKey(s);
    const items = [
        { id: "a", key: k("A block of mass 2 kg slides on a rough incline of angle 30 degrees find the acceleration"), block: "Physics" },
        { id: "b", key: k("<p>A block of mass 2 kg slides on a rough incline of angle 30 degrees; find the acceleration.</p>"), block: "Physics" },
        { id: "c", key: k("A block of mass 2 kg slides on a rough incline of angle 30 degrees find the acceleration of block"), block: "Physics" },
        { id: "d", key: k("A block of mass 2 kg slides on a rough incline of angle 30 degrees find the acceleration of block"), block: "Chemistry" },
        { id: "e", key: k("Completely different question about equilibrium constants"), block: "Physics" },
    ];
    const pairs = findTextDuplicates(items);
    assert.ok(pairs.some((p) => p.type === "EXACT_TEXT" && p.a === "a" && p.b === "b"));
    assert.ok(pairs.some((p) => p.type.startsWith("NEAR_TEXT") && [p.a, p.b].includes("c")));
    assert.ok(!pairs.some((p) => p.type.startsWith("NEAR") && [p.a, p.b].includes("d") && [p.a, p.b].includes("a"))); // different block
    assert.ok(!pairs.some((p) => [p.a, p.b].includes("e")));
});

test("raw_data keeps the app's array shape", () => {
    const r = buildRawData("abc", { x: 1 });
    assert.ok(Array.isArray(r));
    assert.equal(r[0].unique_id, "abc");
    assert.deepEqual(r[0]._recovery, { x: 1 });
});

test("test segmentation by numbering reset", () => {
    const mk = (row, n, fam = "JRTS") => ({ sheet: fam, test_family: fam, structure: "TABULAR", source_row: row, question_number: n, year: "2024-25", exam: { status: "OK", normalized_value: { exam: "JEE Main" } }, paper: null });
    const occ = [mk(1, 1), mk(2, 2), mk(3, 3), mk(4, 1), mk(5, 2)];
    segmentByNumberingReset(occ);
    assert.deepEqual(occ.map((o) => o._segment), [1, 1, 1, 2, 2]);
});

test("excel dates", () => {
    assert.equal(excelSerialToIso(45598), "2024-11-02");
    assert.equal(normalizeDateCell("29-10-2023").iso, "2023-10-29");
    assert.equal(normalizeDateCell("11-05-2025_Test-16").iso, null);
});

test("docx parsing: tabs, superscripts, Symbol font, OLE placeholders, segmentation", () => {
    const rels = new Map([["rId1", "embeddings/oleObject1.bin"], ["rId2", "media/image1.wmf"]]);
    const p = (inner) => `<w:p>${inner}</w:p>`;
    const r = (t, va) => `<w:r>${va ? `<w:rPr><w:vertAlign w:val="${va}"/></w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
    const tab = "<w:r><w:tab/></w:r>";
    const xml = `<w:document><w:body>${[
        p(r("SECTION-I (PHYSICS)")), p(r("Single Correct Type Questions")),
        p(r("1.") + tab + r("Speed is 3 × 10") + r("8", "superscript") + r(" m/s and ") + `<w:r><w:sym w:font="Symbol" w:char="F070"/></w:r>`),
        p(tab + r("(1)") + tab + r("a") + tab + r("(2)") + tab + r("b")),
        p(tab + r("(3)") + tab + `<w:r><w:object><v:imagedata r:id="rId2"/><o:OLEObject ProgID="Equation.DSMT4" r:id="rId1"/></w:object></w:r>` + tab + r("(4)") + tab + r("d")),
    ].join("")}</w:body></w:document>`;
    const paras = parseDocxParagraphs(xml, rels);
    const qs = segmentQuestionPaper(paras);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].number, 1);
    assert.equal(qs[0].options.length, 4);
    assert.deepEqual(qs[0].options.map((o) => o.n), [1, 2, 3, 4]);
    const text = paras[2].tokens;
    assert.ok(text.some((t) => t.va === "superscript" && t.v === "8"));
    assert.ok(text.some((t) => t.v === "π")); // Adobe Symbol 0x70
    assert.ok(qs[0].options[2].tokens.some((t) => t.t === "ole" && t.ole === "embeddings/oleObject1.bin" && t.preview === "media/image1.wmf"));

    const solXml = `<w:document><w:body>${[p(r("PHYSICS")), p(r("1.") + tab + r("(2)")), p(r("SECTION-I (PHYSICS)")), p(r("1.") + tab + r("(2)")), p(tab + r("Because.")), p(r("[25 Feb, 2021 (Shift-I)]"))].join("")}</w:body></w:document>`;
    const { key, sols } = segmentSolutions(parseDocxParagraphs(solXml, new Map()));
    assert.equal(key.get(1).raw, "2");
    assert.equal(sols.get(1).answer_line_raw, "2");
    assert.equal(sols.get(1).pyq_reference, "25 Feb, 2021 (Shift-I)");
});

test("RankUp registers, book cards and generated bank parse without inventing roles", () => {
    const md = "# PYQ Register\n\n| PYQ-ID | Ref | Chapter | Summary | Answer |\n|---|---|---|---|---|\n| PYQ-SBC-001 | JEE Main 2021 | Mole | x | 2 |\n\n| ID | Concept |\n|---|---|\n| TC-PHY-001 | Work-energy |\n| PA-PHY-002 | chain |\n";
    const r = registerRecords("x.md", md);
    assert.equal(r.pyq.length, 1);
    assert.equal(r.pyq[0].pyq_id, "PYQ-SBC-001");
    assert.equal(r.concept[0].concept_id, "TC-PHY-001");
    assert.equal(r.archetype[0].archetype_id, "PA-PHY-002");
    assert.equal(parseMarkdownTables(md).length, 2);
    const books = bookCards("b.md", "## Atkins Physical Chemistry\n- **Use:** thermodynamics bridges\n");
    assert.equal(books[0].title, "Atkins Physical Chemistry");
    assert.equal(books[0].fields.Use, "thermodynamics bridges");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-"));
    const csv = path.join(dir, "bank.csv");
    fs.writeFileSync(csv, "id,question,answer,solution,difficulty,QBGFileId,notes,V1 blind re-solve\nRQ-1,q?,2,s,Hard,abc123,uses PYQ-SBC-001 and PYQ-EC-010 with TC-PHY-001,PASS\n");
    const g = generatedBank(csv);
    assert.equal(g.questions.length, 1);
    const q = g.questions[0];
    assert.equal(q.qbg_file_id, "abc123");
    assert.equal(q.qbg_id, undefined); // QBGFileId is never promoted to qbg_id
    assert.deepEqual(q.fusion.anchor_pyq_ids, []); // role not stated -> not invented
    assert.deepEqual(q.fusion.secondary_pyq_ids.sort(), ["PYQ-EC-010", "PYQ-SBC-001"]);
    assert.deepEqual(q.fusion.concept_ids, ["TC-PHY-001"]);
    assert.equal(g.qc[0].result_raw, "PASS");
});

test("JSON/CSV serialization round-trips deterministically", () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ser-"));
    const f = path.join(dir, "x.jsonl");
    const recs = [{ z: 1, a: "é ✓ <sup>2</sup>", n: null, arr: [2, 1] }];
    writeJsonl(f, recs);
    const h1 = fs.readFileSync(f, "utf8");
    writeJsonl(f, recs);
    assert.equal(fs.readFileSync(f, "utf8"), h1);
    assert.deepEqual(readJsonl(f), recs);
    assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
    const cf = path.join(dir, "x.csv");
    writeCsv(cf, [{ a: "1,2", b: 'q"x' }]);
    assert.deepEqual(parseCsv(fs.readFileSync(cf, "utf8")).slice(0, 2), [["a", "b"], ["1,2", 'q"x']]);
});
