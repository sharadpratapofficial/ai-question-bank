#!/usr/bin/env node
/**
 * Stage 07: identifier forensics + overlap summary.
 * Outputs data/canonical/identifier_registry.json,
 *         docs/data_recovery/IDENTIFIER_FORENSICS.md, docs/data_recovery/qbg_overlap_summary.md
 */
import path from "node:path";
import { CANONICAL_DIR, REPORTS_DIR, DOCS_DIR, STAGING_DIR, readJsonl, readJson, streamJsonl, writeJson, writeText, mdTable, pct } from "./lib/common.mjs";

const ok = (n) => (n && n.status === "OK" ? n.normalized_value : null);
const BRIEF_EXAMPLE_IDS = ["m17hp8zu9zycqk5ripht6kf9ew", "qheknip5dh112gdhm6zewqm8j", "k1vp2a6q48m6ksi50m6feff7a"];

function stats(values) {
    const m = new Map();
    for (const v of values) if (v !== null && v !== undefined) m.set(v, (m.get(v) || 0) + 1);
    return { values: [...m.values()].reduce((s, n) => s + n, 0), unique: m.size, duplicated_values: [...m.values()].filter((n) => n > 1).length, samples: [...m.keys()].slice(0, 3) };
}

export async function runIdentifiers() {
    const ac = [];
    for await (const r of streamJsonl(path.join(STAGING_DIR, "autocuration_rows.jsonl"))) ac.push({ id: ok(r.qbg_id), idStatus: r.qbg_id.status, link: ok(r.link), linkMatch: r.link_qbg_id_matches, codes: r.codes });
    const occ = readJsonl(path.join(CANONICAL_DIR, "qbg_test_occurrences.jsonl"));
    const tax = readJsonl(path.join(CANONICAL_DIR, "taxonomy_nodes.jsonl"));
    const docs = readJsonl(path.join(CANONICAL_DIR, "source_documents.jsonl"));
    const summary = readJson(path.join(REPORTS_DIR, "recovery_summary.json"));
    const stagingOcc = readJsonl(path.join(STAGING_DIR, "test_occurrences.jsonl"));

    const questionIds = new Set([...ac.map((r) => r.id).filter(Boolean), ...ac.filter((r) => r.link?.kind === "QBG_QUESTION_PAGE").map((r) => r.link.id), ...occ.map((o) => o.qbg_id).filter(Boolean)]);
    const taxIds = new Set(tax.map((t) => t.taxonomy_id));
    const collisions = [...questionIds].filter((i) => taxIds.has(i));
    const byLevel = (lvl) => tax.filter((t) => t.levels.includes(lvl)).length;
    const linkEmbedded = ac.filter((r) => r.link?.kind === "QBG_QUESTION_PAGE");
    const pyqHyper = stagingOcc.filter((o) => o.id_hyperlink_matches !== null && o.id_hyperlink_matches !== undefined);

    const systems = [
        { system: "QBG question unique_id", field: "AutoCuration data.qbg_id", source: "AutoCuration_Lovee (1).xlsx", format: "^[a-z0-9]{25}$", ...stats(ac.map((r) => r.id)), relationship: "Same value space as qbg_question_pool.unique_id / qbg_id (python/qbg_pool_import, qbg.py get_bulk_questions uses it as uniqueIds)", confidence: "HIGH" },
        { system: "QBG question unique_id (embedded)", field: "AutoCuration data.link (qbg-admin / qbg.physicswallah.live question-details?question=)", source: "AutoCuration_Lovee (1).xlsx", format: "URL with ^[a-z0-9]{25}$", ...stats(linkEmbedded.map((r) => r.link.id)), relationship: `Equals the row's qbg_id in ${linkEmbedded.filter((r) => r.linkMatch === true).length} rows; differs in ${linkEmbedded.filter((r) => r.linkMatch === false).length}; row has no qbg_id in ${linkEmbedded.filter((r) => r.linkMatch === null).length}`, confidence: "HIGH" },
        ...[...new Set(occ.map((o) => o.sheet))].map((sheet) => ({ system: "QBG question unique_id", field: `Important IDs ${sheet} id cells`, source: "Important IDs REplica (1).xlsx", format: "^[a-z0-9]{25}$", ...stats(occ.filter((o) => o.sheet === sheet && o.counts_as_usage).map((o) => o.qbg_id)), invalid_cells: occ.filter((o) => o.sheet === sheet && o.qbg_id_status === "UNRESOLVED").map((o) => `${o.source_cell}=${JSON.stringify(o.qbg_id_raw)}`).slice(0, 10), relationship: sheet === "Copy of AITS" ? "every row mirrors AITS (not counted as usage)" : "QBG id -> test position", confidence: sheet.startsWith("Full") || sheet.startsWith("Onepass") ? "MEDIUM (side-by-side blocks parsed by layout)" : "HIGH" })),
        { system: "QBG question unique_id (hyperlink)", field: "Important IDs PYQs id-cell hyperlinks", source: "Important IDs REplica (1).xlsx", format: "question-details?question=<id>", values: pyqHyper.length, unique: new Set(pyqHyper.map((o) => ok(o.qbg_id))).size, relationship: `hyperlink id equals the cell id in ${pyqHyper.filter((o) => o.id_hyperlink_matches).length}/${pyqHyper.length}`, confidence: "HIGH" },
        ...["subject", "chapter", "topic", "subtopic", "class"].map((lvl) => ({ system: `QBG taxonomy ${lvl}_id`, field: `tagging CSV ${lvl}_id; AutoCuration ${lvl}_code / tagging sheet; AITS unlabeled columns`, source: "qbg_tagging_table.csv + AutoCuration + Important IDs AITS", format: "^[a-z0-9]{25}$", unique: byLevel(lvl), relationship: `${lvl} node; resolves to a display name (tagging CSV name preferred)`, confidence: "HIGH" })),
        { system: "Comprehension parent candidate", field: "Important IDs AITS column K 'Comp'", source: "Important IDs REplica (1).xlsx", format: "^[a-z0-9]{25}$", ...stats(occ.length ? readJsonl(path.join(CANONICAL_DIR, "qbg_questions.jsonl")).flatMap((c) => c.parent_question_candidates) : []), relationship: "INFERRED parent_question_id candidate; not applied", confidence: "LOW" },
        { system: "Google Drive file id", field: "AutoCuration link/QuestionFileLink/SolutionFileLInk/Video Solution Link hyperlinks; AITS VS; Full-length Source File Link", source: "both workbooks", format: "[A-Za-z0-9_-]{25,44}", unique: docs.filter((d) => d.document_id.startsWith("gdrive:")).length, relationship: "document, not question: one document holds many questions (document -> question occurrences)", confidence: "HIGH (id syntax); role MEDIUM/LOW" },
        { system: "Google Drive folder id", field: "Onepass 'Final File' hyperlinks", source: "Important IDs", unique: docs.filter((d) => d.document_id.startsWith("gdrive-folder:")).length, relationship: "folder of final files", confidence: "HIGH" },
        { system: "Google Sheet id", field: "AutoCuration output.SheetLink; Important IDs header hyperlinks", source: "both workbooks", unique: docs.filter((d) => d.document_id.startsWith("gsheet:")).length, relationship: "curation/index sheets", confidence: "HIGH" },
        { system: "Question number (position)", field: "Question Number / Q.NO: / S.No. / Row_Number / Source_Question_Number", source: "both workbooks", format: "Q### or integer", relationship: "position inside a test instance or document; not an identity on its own", confidence: "MEDIUM (Row_Number meaning INFERRED)" },
        { system: "Test instance key (derived)", field: "family|date|batch|exam|paper (AITS); segmented by numbering reset (JRTS/RTS/Onepass)", source: "derived", unique: new Set(occ.map((o) => o.test_instance_key)).size, relationship: "groups occurrences into tests", confidence: "HIGH for AITS/PYQ/Full length; MEDIUM (INFERRED) for segmented sheets" },
        { system: "question_id (UUID v5, minted)", field: "canonical qbg_questions.question_id", source: "this pipeline", format: "uuid v5 of record_key", unique: summary.canonical_records + summary.source_document_questions, relationship: "stable across re-runs; NOT a historical id", confidence: "HIGH (determinism)" },
        { system: "Synthetic record keys", field: "qbg:<id> | acrow:<row> | docx:<doc>#Q<n>", source: "this pipeline", unique: summary.canonical_records + summary.source_document_questions, relationship: "acrow = AutoCuration row without a QBG id (never merged); docx = extracted document question", confidence: "HIGH" },
        ...["QBGFileId (rankup_chem_bank.csv)", "PYQ-ID (PYQ registers)", "TC-ID (Textbook_Concept_Register)", "PA-ID (Problem_Archetype_Register)", "RQ-ID (RankUp generated)", "source PDF id / source solution PDF id (rankup_chem_bank.csv)"].map((s) => ({ system: s, field: "-", source: "UNAVAILABLE (file not in repository)", unique: 0, relationship: "cannot be analysed; kept as a separate system when supplied (QBGFileId is never assumed to be qbg_id)", confidence: "UNKNOWN" })),
    ];
    const briefCheck = BRIEF_EXAMPLE_IDS.map((id) => ({ id, found_as_question_id: questionIds.has(id), found_as_taxonomy_id: taxIds.has(id) }));
    const registry = { question_id_values: questionIds.size, taxonomy_id_values: taxIds.size, question_vs_taxonomy_collisions: collisions.length, collision_samples: collisions.slice(0, 10), brief_example_ids: briefCheck, systems };
    writeJson(path.join(CANONICAL_DIR, "identifier_registry.json"), registry);

    const md = [
        "# Identifier forensics",
        "",
        "Generated by `scripts/data/recovery/07_identifiers.mjs`. Machine-readable: `data/canonical/identifier_registry.json`.",
        "",
        "## Key conclusions",
        "",
        `1. **QBG question ids and QBG taxonomy ids have the same shape** (25 lowercase base-36 characters), so shape alone never decides meaning; column context does. Across ${questionIds.size.toLocaleString()} question-id values and ${taxIds.size.toLocaleString()} taxonomy-id values there ${collisions.length === 1 ? "is" : "are"} **${collisions.length}** value${collisions.length === 1 ? "" : "s"} used as both.`,
        `2. The \`link\` column's QBG page URL embeds the row's own id. Where both exist they agree in ${linkEmbedded.filter((r) => r.linkMatch === true).length.toLocaleString()} rows and disagree in ${linkEmbedded.filter((r) => r.linkMatch === false).length}. PYQ id cells carry a QBG-page hyperlink that agrees in ${pyqHyper.filter((o) => o.id_hyperlink_matches).length}/${pyqHyper.length} cells.`,
        "3. The workbooks' \"QBG IDs\" are QBG **unique_id** values: the same value space that `qbg_question_pool.unique_id` and `python/qbg_modification/qbg.py get_bulk_questions(uniqueIds)` use. Replacement `qbg_questions.qbg_id` stays `text` (INFERRED; historical type UNKNOWN).",
        "4. Drive file ids identify **documents**, not questions. A single document is referenced by up to hundreds of rows.",
        "5. `question_id` values are UUID v5 hashes of the record key. They are minted by this pipeline, reproducible, and **not historical**.",
        "6. QBGFileId, PYQ-ID, TC-ID, PA-ID and RQ-ID could not be analysed because their source files are absent.",
        "",
        "## Example ids quoted in the brief",
        "",
        mdTable(["Id", "Found as question id", "Found as taxonomy id"], briefCheck.map((b) => [b.id, b.found_as_question_id, b.found_as_taxonomy_id])),
        "",
        briefCheck[0].found_as_question_id ? "" : "`m17hp8zu9zycqk5ripht6kf9ew` does **not** occur anywhere. JRTS row 2 holds `m17hp8zu9zyc74xcrxpwia4kt`, and AutoCuration row 2 holds `y2yail3zjxcqk5ripht6kf9ew`. The brief's value looks like a splice of the two; it is recorded here and not treated as real.",
        "",
        "## Identifier systems",
        "",
        mdTable(["System", "Field", "Values", "Unique", "Dup values", "Samples", "Relationship", "Confidence"], systems.map((s) => [s.system, s.field, s.values ?? "", s.unique ?? "", s.duplicated_values ?? "", (s.samples || []).join(", "), s.relationship + (s.invalid_cells?.length ? `; invalid cells: ${s.invalid_cells.join(", ")}` : ""), s.confidence])),
    ].join("\n");
    writeText(path.join(DOCS_DIR, "IDENTIFIER_FORENSICS.md"), md);

    const o = summary.overlap;
    const ov = [
        "# QBG workbook overlap: AutoCuration vs Important IDs Replica",
        "",
        "Machine-readable: `data/reports/qbg_overlap_report.csv` (per sheet) and `data/reports/recovery_summary.json` (`overlap`).",
        "",
        mdTable(["Measure", "Value"], [
            ["Unique QBG ids in AutoCuration (row id or link)", o.autocuration_unique_qbg_ids],
            ["Unique QBG ids in Important IDs (usage cells, mirrors excluded)", o.important_ids_unique_qbg_ids],
            ["Union", o.union],
            ["Intersection", o.intersection],
            ["AutoCuration only", o.autocuration_only],
            ["Important IDs only", o.important_ids_only],
            ["% of Important IDs also in AutoCuration", `${o.pct_of_important_ids_in_autocuration}%`],
            ["% of AutoCuration also in Important IDs", `${o.pct_of_autocuration_in_important_ids}%`],
            ["AutoCuration rows with no QBG id", o.autocuration_rows_without_qbg_id],
            ["AutoCuration extra rows repeating an id", o.autocuration_duplicate_id_rows],
            ["Ids used in more than one test instance", o.ids_in_multiple_test_instances],
            ["Ids used in more than one test family", o.ids_in_multiple_test_families],
        ]),
        "",
        "## By Important IDs sheet",
        "",
        mdTable(["Sheet", "Family", "Unique ids", "Also in AutoCuration", "Only in Important IDs", "%"], o.by_sheet.map((r) => [r.sheet, r.test_family, r.unique_qbg_ids, r.also_in_autocuration, r.only_in_important_ids, r.pct_in_autocuration])),
        "",
        "## Intersection by AutoCuration `source`",
        "",
        mdTable(["AutoCuration source", "Ids also in Important IDs"], Object.entries(o.intersection_by_ac_source)),
        "",
        "## AutoCuration-only by `source`",
        "",
        mdTable(["AutoCuration source", "Ids only in AutoCuration"], Object.entries(o.ac_only_by_source)),
        "",
        "## What the overlap means",
        "",
        `- **The two workbooks index mostly different questions.** Only ${o.intersection.toLocaleString()} ids (${o.pct_of_important_ids_in_autocuration}% of the test-mapping ids) have AutoCuration metadata. The two files are complementary views, not two copies of one bank.`,
        `- **Nearly all of the intersection is AITS.** ${o.intersection_by_ac_source.AITS ?? 0} of ${o.intersection.toLocaleString()} shared ids come from AutoCuration rows whose source is \`AITS\`. For these, AutoCuration re-states the AITS sheet's taxonomy, so it cross-checks the same test data rather than independently confirming it.`,
        "- **AutoCuration-only ids** (Milestone, AIR, 3QuestionBank, Prayas_Advance_New, NEET PYQs) are curation-pool questions with no recorded test usage in the replica.",
        "- **Important-IDs-only ids** (PYQs, RTS, JRTS, Onepass, Full length, most AITS 2023-24) have test usage but no row-level taxonomy apart from the AITS sheet's own columns.",
        `- **Many ids are reused across tests.** ${o.ids_in_multiple_test_instances.toLocaleString()} ids appear in more than one test instance, and ${o.ids_in_multiple_test_families} in more than one test family. Each id is one canonical question with several occurrences.`,
        "- **Neither workbook holds question bodies.** Content has to come from QBG (by unique_id, with authorised access) or from the Drive documents referenced per row.",
    ].join("\n");
    writeText(path.join(DOCS_DIR, "qbg_overlap_summary.md"), ov);
    return registry;
}

if (process.argv[1]?.endsWith("07_identifiers.mjs")) {
    const r = await runIdentifiers();
    console.log(JSON.stringify({ question_ids: r.question_id_values, taxonomy_ids: r.taxonomy_id_values, collisions: r.question_vs_taxonomy_collisions, brief: r.brief_example_ids }, null, 1));
}
