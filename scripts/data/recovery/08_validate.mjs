#!/usr/bin/env node
/**
 * Stage 08: automated validation of the canonical outputs.
 * Writes data/reports/validation_report.json and docs/data_recovery/VALIDATION_REPORT.md.
 * Exit code 1 if any check has severity ERROR and fails.
 */
import fs from "node:fs";
import path from "node:path";
import { CANONICAL_DIR, REPORTS_DIR, DOCS_DIR, STAGING_DIR, readJsonl, writeJson, writeText, mdTable, uuidv5, sha256File, rel } from "./lib/common.mjs";
import { QBG_CUID25_RE } from "./lib/ids.mjs";
import { OPTION_TYPES, VALUE_TYPES } from "./lib/normalize.mjs";
import { RECOVERY_CLASSES } from "./lib/canonical.mjs";

export function runValidate() {
    const C = (f) => readJsonl(path.join(CANONICAL_DIR, f));
    const q = C("qbg_questions.jsonl");
    const d = C("source_document_questions.jsonl");
    const occ = C("qbg_test_occurrences.jsonl");
    const conf = C("qbg_conflicts.jsonl");
    const dups = C("qbg_duplicates.jsonl");
    const master = C("qbg_id_master.jsonl");
    const tax = C("taxonomy_nodes.jsonl");
    const rk = C("rankup_questions.jsonl");
    const all = [...q, ...d];
    const checks = [];
    const check = (group, name, severity, failures, detail = "") => checks.push({ group, name, severity, passed: failures.length === 0, failures: failures.length, samples: failures.slice(0, 5), detail });

    // ---------------- identity
    const seen = (arr, key) => { const s = new Set(), dup = []; for (const x of arr) { const k = key(x); if (s.has(k)) dup.push(k); s.add(k); } return dup; };
    check("identity", "no duplicate question_id", "ERROR", seen(all, (x) => x.question_id));
    check("identity", "no duplicate record_key", "ERROR", seen(all, (x) => x.record_key));
    check("identity", "no duplicate qbg_id among canonical records", "ERROR", seen(q.filter((x) => x.qbg_id), (x) => x.qbg_id));
    check("identity", "every qbg_id is a well-formed QBG unique_id", "ERROR", q.filter((x) => x.qbg_id && !QBG_CUID25_RE.test(x.qbg_id)).map((x) => x.record_key));
    check("identity", "record_key and qbg_id consistent", "ERROR", q.filter((x) => (x.record_key.startsWith("qbg:") ? x.record_key.slice(4) !== x.qbg_id : x.qbg_id !== null)).map((x) => x.record_key));
    check("identity", "question_id = uuidv5(record_key) (deterministic)", "ERROR", all.filter((x) => x.question_id !== uuidv5(x.record_key)).map((x) => x.record_key));
    check("identity", "no accidental id conversion (normalized == trimmed raw)", "ERROR", master.flatMap((m) => m.observations.filter((o) => o.field !== "link(embedded id)" && typeof o.raw === "string" && o.raw.trim() !== o.normalized).map((o) => `${m.qbg_id} ${o.sheet} ${o.row}`)));
    const taxIds = new Set(tax.map((t) => t.taxonomy_id));
    check("identity", "no QBG question id collides with a taxonomy id", "ERROR", q.filter((x) => x.qbg_id && taxIds.has(x.qbg_id)).map((x) => x.qbg_id));
    check("identity", "docx questions carry no qbg_id (unlinked by evidence)", "ERROR", d.filter((x) => x.qbg_id !== null).map((x) => x.record_key));

    // ---------------- content
    const hasText = (s) => typeof s === "string" && s.trim().length > 0;
    check("content", "A_FULL has question, answer and solution", "ERROR", all.filter((x) => x.recovery_class === "A_FULL" && !(hasText(x.question_text) && x.answer_key !== null && hasText(x.solution_text))).map((x) => x.record_key));
    check("content", "A_FULL/B contain no unconverted-equation placeholders in the question", "ERROR", all.filter((x) => ["A_FULL", "B_CONTENT_WITHOUT_SOLUTION"].includes(x.recovery_class) && /unconverted-equation|\[SYMBOL\]/.test(x.question_text || "")).map((x) => x.record_key));
    check("content", "option types in A/B have exactly 4 options", "ERROR", all.filter((x) => ["A_FULL", "B_CONTENT_WITHOUT_SOLUTION"].includes(x.recovery_class) && OPTION_TYPES.has(x.question_type) && (!Array.isArray(x.options) || x.options.length !== 4)).map((x) => x.record_key));
    const badIdx = all.filter((x) => Array.isArray(x.answer_key) && (x.answer_key.some((i) => !Number.isInteger(i) || i < 1 || i > (Array.isArray(x.options) && x.options.length ? x.options.length : 4))));
    check("content", "answer indexes reference valid options", "ERROR", badIdx.map((x) => x.record_key));
    check("content", "SCQ answers have exactly one index", "ERROR", all.filter((x) => x.question_type === "Single_Choice(SCQ)" && Array.isArray(x.answer_key) && x.answer_key.length !== 1).map((x) => x.record_key));
    check("content", "numerical answers are never option-index arrays", "ERROR", all.filter((x) => VALUE_TYPES.has(x.question_type) && Array.isArray(x.answer_key)).map((x) => x.record_key));
    check("content", "option answers are never scalars", "ERROR", all.filter((x) => OPTION_TYPES.has(x.question_type) && x.answer_key !== null && !Array.isArray(x.answer_key)).map((x) => x.record_key));
    check("content", "isCorrect flags agree with answer_key", "ERROR", all.filter((x) => Array.isArray(x.options) && x.options.length && Array.isArray(x.answer_key) && x.options.some((o, i) => o.isCorrect !== null && o.isCorrect !== x.answer_key.includes(i + 1))).map((x) => x.record_key));
    const exportStatusFile = path.join(STAGING_DIR, "qbg_export_status.json");
    const exportStatus = fs.existsSync(exportStatusFile) ? JSON.parse(fs.readFileSync(exportStatusFile, "utf8")).status : "NOT_PRESENT";
    checks.push({ group: "content", name: "QBG export status recorded", severity: "INFO", passed: true, failures: 0, samples: [], detail: `QBG export status = ${exportStatus}` });
    const MATCHED = new Set(["MATCHED", "MATCHED_DUPLICATE_ROWS_IDENTICAL"]);
    const carriesContent = (x) => hasText(x.question_text) || hasText(x.solution_text) || (Array.isArray(x.options) && x.options.length > 0);
    check("content", "QBG records carry question content only from a matched export row", "ERROR", q.filter((x) => x.qbg_id && carriesContent(x) && !MATCHED.has(x.content_source?.status)).map((x) => x.record_key));
    if (exportStatus !== "PRESENT") check("content", "without a QBG export, no QBG record has question content", "ERROR", q.filter((x) => x.qbg_id && carriesContent(x)).map((x) => x.record_key));
    check("content", "every record states its content_source", "ERROR", all.filter((x) => !x.content_source?.status).map((x) => x.record_key));
    const cp = (x) => x.content_provenance || {};
    check("content", "every present content field has field-level provenance", "ERROR", all.filter((x) => (hasText(x.question_text) && !cp(x).question_text) || (hasText(x.solution_text) && !cp(x).solution_text) || (x.answer_key !== null && !cp(x).answer) || (Array.isArray(x.options) && x.options.length && !cp(x).options)).map((x) => x.record_key));

    // ---------------- metadata
    const SUBJECTS = new Set(["Physics", "Chemistry", "Maths", "Biology", "Botany", "Zoology"]);
    check("metadata", "canonical subject in controlled vocabulary", "ERROR", all.filter((x) => x.subject !== null && !SUBJECTS.has(x.subject)).map((x) => `${x.record_key}=${x.subject}`));
    check("metadata", "every recovery_class is one of A..H", "ERROR", all.filter((x) => !(x.recovery_class in RECOVERY_CLASSES)).map((x) => x.record_key));
    check("metadata", "canonical chapter matches its chapter_id's taxonomy name when both present", "WARN", q.filter((x) => x.taxonomy_ids.chapter && x.chapter && tax.find((t) => t.taxonomy_id === x.taxonomy_ids.chapter)?.canonical_name && x.metadata_resolution.chapter.status === "FROM_TAXONOMY_ID" && tax.find((t) => t.taxonomy_id === x.taxonomy_ids.chapter).canonical_name !== x.chapter).map((x) => x.record_key));
    const pathIssues = fs.existsSync(path.join(DATA_DIR_REVIEW(), "taxonomy_path_issues.csv")) ? fs.readFileSync(path.join(DATA_DIR_REVIEW(), "taxonomy_path_issues.csv"), "utf8").trim().split("\n").length - 1 : 0;
    checks.push({ group: "metadata", name: "chapter>topic>subtopic paths exist in the tagging tables", severity: "WARN", passed: pathIssues === 0, failures: pathIssues, samples: [], detail: "see data/review/taxonomy_path_issues.csv" });

    // ---------------- provenance / references
    const keys = new Set(all.map((x) => x.record_key));
    check("provenance", "every record has a source row or source document", "ERROR", all.filter((x) => !(x.provenance?.source_rows?.length || x.provenance?.source_documents?.length)).map((x) => x.record_key));
    check("provenance", "conflicts reference existing records", "ERROR", conf.filter((c) => c.record_keys.some((k) => !keys.has(k))).map((c) => c.conflict_id));
    check("provenance", "duplicate groups reference existing records", "ERROR", dups.filter((g) => g.members.some((k) => !keys.has(k))).map((g) => g.duplicate_group_id));
    check("provenance", "every conflict is UNRESOLVED (no silent winner)", "ERROR", conf.filter((c) => c.resolution !== "UNRESOLVED").map((c) => c.conflict_id));
    check("provenance", "no orphan occurrences (valid id without a canonical record)", "ERROR", occ.filter((o) => o.counts_as_usage && !o.question_id).map((o) => o.occurrence_id));
    check("provenance", "occurrences with invalid id cells are listed for review", "WARN", occ.filter((o) => o.qbg_id_status === "UNRESOLVED" && o.structure !== "MIRROR_OF_AITS").map((o) => o.occurrence_id), "expected: known data-entry gaps (Paper-02 / QUE ERROR)");
    check("provenance", "conflicting canonical fields are null (never a picked winner)", "ERROR", q.filter((x) => Object.entries(x.metadata_resolution).some(([f, r]) => r.status === "CONFLICT" && r.value !== null)).map((x) => x.record_key));
    check("provenance", "F_CONFLICT records have at least one conflict id", "ERROR", all.filter((x) => x.recovery_class === "F_CONFLICT" && !x.conflict_ids.length).map((x) => x.record_key));
    check("provenance", "parent_question_id stays null (no parent-child relationship is verified)", "ERROR", all.filter((x) => x.parent_question_id !== null && x.parent_question_id !== undefined).map((x) => x.record_key));
    check("provenance", "every conflict carries an analysis and was not auto-resolved", "ERROR", conf.filter((c) => !c.analysis?.category || c.analysis.auto_resolution !== "NOT_APPLIED").map((c) => c.conflict_id));
    check("provenance", "every duplicate group is categorised", "ERROR", dups.filter((d) => !d.analysis?.category || d.analysis.category === "UNCATEGORISED").map((d) => d.duplicate_group_id));
    check("import", "only A/B records can be READY or READY_WITH_REVIEW", "ERROR", all.filter((x) => x.import_readiness !== "NOT_READY" && !["A_FULL", "B_CONTENT_WITHOUT_SOLUTION"].includes(x.recovery_class)).map((x) => x.record_key));
    check("import", "metadata-only QBG records are never import-ready", "ERROR", q.filter((x) => x.qbg_id && !hasText(x.question_text) && x.import_readiness !== "NOT_READY").map((x) => x.record_key));
    check("import", "import-ready records have question-text provenance", "ERROR", all.filter((x) => x.import_readiness !== "NOT_READY" && !cp(x).question_text).map((x) => x.record_key));
    check("import", "no record READY with LOW/UNKNOWN identity", "ERROR", all.filter((x) => x.import_readiness === "READY" && !["HIGH", "MEDIUM"].includes(x.confidence.identity)).map((x) => x.record_key));

    // ---------------- RankUp
    if (rk.length) {
        check("rankup", "every generated question has an anchor or referenced PYQ", "ERROR", rk.filter((r) => !r.fusion.anchor_pyq_ids.length && !r.fusion.secondary_pyq_ids.length).map((r) => r.rankup_question_id));
        check("rankup", "every generated question has difficulty, answer, solution", "ERROR", rk.filter((r) => !r.difficulty || !r.answer_raw || !r.solution_text).map((r) => r.rankup_question_id));
        check("rankup", "every generated question has fusion type", "WARN", rk.filter((r) => !r.fusion.type).map((r) => r.rankup_question_id));
        check("rankup", "QBGFileId never used as qbg_id", "ERROR", rk.filter((r) => r.qbg_id).map((r) => r.rankup_question_id));
    } else checks.push({ group: "rankup", name: "RankUp checks", severity: "INFO", passed: true, failures: 0, samples: [], detail: "SKIPPED: RankUp sources UNAVAILABLE (0 records)" });

    // ---------------- output fingerprints (determinism across runs)
    const hashFile = path.join(REPORTS_DIR, "output_hashes.json");
    const prev = fs.existsSync(hashFile) ? JSON.parse(fs.readFileSync(hashFile, "utf8")) : null;
    const files = fs.readdirSync(CANONICAL_DIR).filter((f) => /\.(jsonl|json)$/.test(f)).sort();
    const hashes = Object.fromEntries(files.map((f) => [f, sha256File(path.join(CANONICAL_DIR, f))]));
    const changed = prev ? files.filter((f) => prev[f] && prev[f] !== hashes[f]) : [];
    checks.push({ group: "determinism", name: "canonical outputs identical to previous run", severity: prev ? "WARN" : "INFO", passed: changed.length === 0, failures: changed.length, samples: changed.slice(0, 5), detail: prev ? `compared ${files.length} files with previous run` : "first run: fingerprints recorded" });
    writeJson(hashFile, hashes);

    const errors = checks.filter((c) => c.severity === "ERROR" && !c.passed);
    const report = { checks, errors: errors.length, warnings: checks.filter((c) => c.severity === "WARN" && !c.passed).length, passed: checks.filter((c) => c.passed).length, total: checks.length };
    writeJson(path.join(REPORTS_DIR, "validation_report.json"), report);
    writeText(path.join(DOCS_DIR, "VALIDATION_REPORT.md"), [
        "# Validation report",
        "",
        `Generated by \`node scripts/data/recovery/08_validate.mjs\`. ${report.passed}/${report.total} checks passed; **${report.errors} errors**, ${report.warnings} warnings.`,
        "",
        mdTable(["Group", "Check", "Severity", "Result", "Failures", "Samples / detail"], checks.map((c) => [c.group, c.name, c.severity, c.passed ? "PASS" : "FAIL", c.failures, [c.detail, c.samples.join(", ")].filter(Boolean).join(" | ")])),
    ].join("\n"));
    return report;
}
function DATA_DIR_REVIEW() { return path.join(path.dirname(REPORTS_DIR), "review"); }

if (process.argv[1]?.endsWith("08_validate.mjs")) {
    const r = runValidate();
    for (const c of r.checks) console.log(`${c.passed ? "PASS" : "FAIL"} [${c.severity}] ${c.group}: ${c.name}${c.passed ? "" : ` (${c.failures})`}`);
    console.log(`${r.passed}/${r.total} passed, ${r.errors} errors, ${r.warnings} warnings`);
    process.exit(r.errors ? 1 : 0);
}
