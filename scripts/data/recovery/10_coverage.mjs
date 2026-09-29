#!/usr/bin/env node
/**
 * Stage 10: per-QBG-id coverage and the source-recovery gap report.
 *
 * Every number is counted from the canonical outputs; nothing is estimated.
 * "Potentially recoverable from local files" means: content is still missing AND
 * a document referenced by the record is actually present locally (registry
 * availability LOCAL / LOCAL_NOT_EXTRACTED). It does NOT mean the document has
 * been checked to contain that question.
 *
 * Outputs:
 *   data/reports/qbg_id_coverage.csv          one row per known QBG id
 *   data/reports/qbg_coverage_summary.json
 *   docs/data_recovery/SOURCE_RECOVERY_GAP_REPORT.md
 */
import path from "node:path";
import { CANONICAL_DIR, REPORTS_DIR, DOCS_DIR, STAGING_DIR, RUN_DATE, streamJsonl, readJson, writeCsv, writeJson, writeText, mdTable, pct } from "./lib/common.mjs";
import { coverageFor } from "./lib/qc.mjs";

export async function runCoverage() {
    const registry = new Map();
    for await (const d of streamJsonl(path.join(CANONICAL_DIR, "source_documents.jsonl"))) registry.set(d.document_id, d);
    const localDocIds = new Set([...registry.values()].filter((d) => /^LOCAL/.test(d.availability)).map((d) => d.document_id));
    const exportStatus = readJson(path.join(STAGING_DIR, "qbg_export_status.json"));
    const rankup = readJson(path.join(CANONICAL_DIR, "rankup_status.json"));

    const rows = [];
    const byFamily = new Map();
    const docIds = new Map(); // document_id -> Set(qbg ids still missing content)
    for await (const r of streamJsonl(path.join(CANONICAL_DIR, "qbg_questions.jsonl"))) {
        if (!r.qbg_id) continue;
        const c = coverageFor(r, { localDocIds });
        rows.push({ ...c, test_families: r.test_usage.test_families.join(" "), subject: r.subject, missing: c.missing.join(" ") });
        const fams = r.test_usage.test_families.length ? r.test_usage.test_families : ["(no test mapping)"];
        for (const f of fams) {
            if (!byFamily.has(f)) byFamily.set(f, { family: f, ids: 0, with_question_text: 0, with_answer: 0, missing_content: 0 });
            const b = byFamily.get(f);
            b.ids++; if (c.has_question_text) b.with_question_text++; if (c.has_answer) b.with_answer++; if (!c.has_question_text) b.missing_content++;
        }
        if (!c.has_question_text) for (const d of [...r.documents.question_documents, ...r.documents.solution_documents]) {
            if (!docIds.has(d)) docIds.set(d, new Set());
            docIds.get(d).add(r.qbg_id);
        }
    }
    rows.sort((a, b) => (a.qbg_id < b.qbg_id ? -1 : 1));
    const n = rows.length;
    const count = (f) => rows.filter(f).length;
    const s = {
        run_date: RUN_DATE,
        known_qbg_ids: n,
        qbg_export_status: exportStatus.status,
        rankup_status: rankup.presence ?? rankup.status,
        with_question_text: count((r) => r.has_question_text),
        with_options: count((r) => r.has_options),
        with_answer: count((r) => r.has_answer),
        with_solution: count((r) => r.has_solution),
        metadata_only: count((r) => r.metadata_only),
        with_any_source_document_ref: count((r) => r.has_any_source_document_ref),
        with_question_document_ref: count((r) => r.has_question_document_ref),
        with_solution_document_ref: count((r) => r.has_solution_document_ref),
        with_document_position: count((r) => r.has_document_position),
        with_test_usage: count((r) => r.has_test_usage),
        with_conflicts: count((r) => r.has_conflicts),
        with_blocking_conflict: count((r) => r.has_blocking_conflict),
        with_duplicate_issue: count((r) => r.has_duplicate_issue),
        potentially_recoverable_locally: count((r) => r.potentially_recoverable_locally),
        requires_external_source: count((r) => r.requires_external_source),
        import_readiness: Object.fromEntries([...new Set(rows.map((r) => r.import_readiness))].sort().map((k) => [k, count((r) => r.import_readiness === k)])),
        by_test_family: [...byFamily.values()].sort((a, b) => b.ids - a.ids),
    };

    // ---- candidate sources, ranked by the number of still-missing ids they could cover
    const missingIds = rows.filter((r) => !r.has_question_text).length;
    const docRole = (id) => registry.get(id)?.question_or_solution || "UNKNOWN";
    const roleIds = (pred) => { const set = new Set(); for (const [d, ids] of docIds) if (pred(docRole(d))) for (const i of ids) set.add(i); return set; };
    const qPaperIds = roleIds((r) => r === "QUESTION_PAPER");
    const solIds = roleIds((r) => r === "SOLUTION");
    const anyDocIds = roleIds(() => true);
    const topDocs = [...docIds].map(([d, ids]) => ({ d, n: ids.size, role: docRole(d), name: registry.get(d)?.filenames?.[0] || "", avail: registry.get(d)?.availability || "" })).sort((a, b) => b.n - a.n || (a.d < b.d ? -1 : 1));
    const candidates = [
        { source: "Authorized QBG bulk export (QBG_data.csv or equivalent, joined on unique_id)", ids_it_could_cover: missingIds, basis: "every known QBG id is a well-formed unique_id (validated); python/qbg_pool_import/import_pool.py shows the export carries content, bilingual_options, answer and solutions columns", verified_contains_bodies: "NO - no export file is available to inspect", status: exportStatus.status },
        { source: "Question-paper documents referenced by the workbooks (Drive)", ids_it_could_cover: qPaperIds.size, basis: `${topDocs.filter((t) => t.role === "QUESTION_PAPER").length} documents whose file name marks them as question papers`, verified_contains_bodies: "NO - not accessible locally; a paper also needs the id->position mapping to attribute questions", status: "UNAVAILABLE_LOCALLY" },
        { source: "Solution documents referenced by the workbooks (Drive)", ids_it_could_cover: solIds.size, basis: `${topDocs.filter((t) => t.role === "SOLUTION").length} documents whose file name / column marks them as solutions`, verified_contains_bodies: "NO - not accessible locally", status: "UNAVAILABLE_LOCALLY" },
        { source: "Question documents whose role is only inferred (AutoCuration `link` / ambiguous)", ids_it_could_cover: roleIds((r) => r !== "QUESTION_PAPER" && r !== "SOLUTION").size, basis: "documents referenced as the question's source but not named as a question paper", verified_contains_bodies: "NO - role itself is INFERRED", status: "UNAVAILABLE_LOCALLY" },
        { source: "Any referenced question or solution document (union of the rows above)", ids_it_could_cover: anyDocIds.size, basis: "union; video-solution links are excluded (they carry no question text)", verified_contains_bodies: "NO", status: "UNAVAILABLE_LOCALLY" },
    ].sort((a, b) => b.ids_it_could_cover - a.ids_it_could_cover);
    s.candidate_sources = candidates;

    writeCsv(path.join(REPORTS_DIR, "qbg_id_coverage.csv"), rows, ["qbg_id", "subject", "test_families", "recovery_class", "import_readiness", "content_source_status", "has_question_text", "has_options", "has_answer", "has_solution", "has_metadata", "metadata_only", "has_question_document_ref", "has_solution_document_ref", "has_document_position", "has_test_usage", "has_conflicts", "has_blocking_conflict", "has_duplicate_issue", "potentially_recoverable_locally", "requires_external_source", "missing"]);
    writeJson(path.join(REPORTS_DIR, "qbg_coverage_summary.json"), { ...s, top_documents_by_missing_ids: topDocs.slice(0, 25).map((t) => ({ document_id: t.d, role: t.role, file_name: t.name, availability: t.avail, missing_ids: t.n })) });

    const line = (label, v) => [label, v, `${pct(v, n)}%`];
    writeText(path.join(DOCS_DIR, "SOURCE_RECOVERY_GAP_REPORT.md"), [
        "# Source-recovery gap report",
        "",
        `Generated by \`node scripts/data/recovery/10_coverage.mjs\` (run date ${RUN_DATE}). Every figure is counted from the canonical outputs; nothing is estimated.`,
        "",
        `**QBG export status: \`${exportStatus.status}\`.** ${exportStatus.status === "PRESENT" ? `Files: ${exportStatus.files.map((f) => `\`${f.path}\` (${f.rows} rows)`).join(", ")}.` : "No `QBG_data.csv` or equivalent export is available, so historical QBG question bodies remain missing. No question body, option, answer or solution has been created to fill the gap."}  `,
        `RankUp status: \`${s.rankup_status}\`.`,
        "",
        "## Coverage of the known QBG ids",
        "",
        mdTable(["Measure", `QBG ids (of ${n})`, "%"], [
            line("have question text", s.with_question_text),
            line("have options", s.with_options),
            line("have an answer", s.with_answer),
            line("have a solution", s.with_solution),
            line("metadata only (no text, answer or solution)", s.metadata_only),
            line("have a source-document reference", s.with_any_source_document_ref),
            line("  … a question-document reference", s.with_question_document_ref),
            line("  … a solution-document reference", s.with_solution_document_ref),
            line("  … a document + position (C_QUESTION_LINKED)", s.with_document_position),
            line("have test usage", s.with_test_usage),
            line("have conflicts", s.with_conflicts),
            line("  … a blocking (HIGH) conflict", s.with_blocking_conflict),
            line("have a duplicate issue", s.with_duplicate_issue),
            line("potentially recoverable from files present locally", s.potentially_recoverable_locally),
            line("require an external source", s.requires_external_source),
        ]),
        "",
        "Answers come only from workbook answer columns (AutoCuration `Answer*`). None of them has a question body, so none is import-ready.",
        "",
        `Import readiness of QBG ids: ${Object.entries(s.import_readiness).map(([k, v]) => `${k} ${v}`).join(", ")}. Metadata-only records are never import-ready question content.`,
        "",
        "## By test family",
        "",
        mdTable(["Test family", "QBG ids", "with question text", "with answer", "missing content"], s.by_test_family.map((b) => [b.family, b.ids, b.with_question_text, b.with_answer, b.missing_content])),
        "",
        "## Most promising future sources",
        "",
        "Ranked by how many still-missing ids each could cover. **\"Verified contains bodies\" is NO for every candidate:** none has been inspected, because none is available locally.",
        "",
        mdTable(["Source", "Missing ids it could cover", "Basis", "Verified contains bodies", "Status"], candidates.map((c) => [c.source, c.ids_it_could_cover, c.basis, c.verified_contains_bodies, c.status])),
        "",
        "Named question papers referenced by the most still-missing ids (no document has been opened; attributing a paper's questions to ids also needs the recorded positions):",
        "",
        mdTable(["Document", "File name", "Missing ids referencing it"], topDocs.filter((t) => t.role === "QUESTION_PAPER").slice(0, 12).map((t) => [t.d, t.name, t.n])),
        "",
        "Solution documents referenced by the most still-missing ids:",
        "",
        mdTable(["Document", "File name", "Missing ids referencing it"], topDocs.filter((t) => t.role === "SOLUTION").slice(0, 8).map((t) => [t.d, t.name, t.n])),
        "",
        `A further ${topDocs.filter((t) => t.role !== "QUESTION_PAPER" && t.role !== "SOLUTION").length} referenced documents have only an inferred role (AutoCuration \`link\` on rows without a file name); they are listed in \`data/reports/qbg_coverage_summary.json\` and \`data/canonical/source_documents.jsonl\`.`,
        "",
        "## What this report does not claim",
        "",
        "- That any listed document contains a given question: documents are only referenced from workbook rows.",
        "- That an export would contain every id: coverage above is the *join-key* coverage (every id is a well-formed `unique_id`).",
        "- \"Potentially recoverable locally\" requires a referenced document to be physically present (see `data/review/local_documents.csv`); today that count is " + s.potentially_recoverable_locally + ".",
        "",
        "Per-id detail: `data/reports/qbg_id_coverage.csv`. How to supply sources: [SOURCE_INTAKE.md](SOURCE_INTAKE.md).",
    ].join("\n"));
    return s;
}

if (process.argv[1]?.endsWith("10_coverage.mjs")) {
    const s = await runCoverage();
    console.log(JSON.stringify({ ...s, by_test_family: undefined, candidate_sources: s.candidate_sources.map((c) => `${c.ids_it_could_cover} <- ${c.source}`) }, null, 1));
}
