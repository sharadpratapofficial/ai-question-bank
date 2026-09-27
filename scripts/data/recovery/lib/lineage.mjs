/**
 * Lineage lookup over the canonical outputs. Answers, for a QBG id / record key /
 * question_id: where it came from, what content exists, where it was used, its
 * answer/solution, confidence, conflicts, and whether it can be imported.
 * Files are streamed once per lookup batch; nothing is fetched remotely.
 */
import path from "node:path";
import { CANONICAL_DIR, streamJsonl } from "./common.mjs";
import { coverageFor } from "./qc.mjs";

const F = (f) => path.join(CANONICAL_DIR, f);

/** keys: iterable of qbg ids, record keys ("qbg:…", "acrow:…", "docx:…") or question_id UUIDs. */
export async function collectLineage(keys) {
    const wanted = new Set(keys);
    const out = new Map();
    const match = (rec) => [rec.record_key, rec.qbg_id, rec.question_id].find((k) => k && wanted.has(k));
    for (const file of ["qbg_questions.jsonl", "source_document_questions.jsonl"]) {
        for await (const r of streamJsonl(F(file))) {
            const k = match(r);
            if (k) out.set(r.record_key, { asked_as: k, record: r, metadata: null, occurrences: [], conflicts: [], duplicates: [], documents: [], master: null });
        }
    }
    const byKey = out;
    const byQbg = new Map([...out.values()].filter((l) => l.record.qbg_id).map((l) => [l.record.qbg_id, l]));
    for await (const m of streamJsonl(F("qbg_question_metadata.jsonl"))) if (byKey.has(m.record_key)) byKey.get(m.record_key).metadata = m;
    for await (const m of streamJsonl(F("qbg_id_master.jsonl"))) if (byQbg.has(m.qbg_id)) byQbg.get(m.qbg_id).master = m;
    for await (const o of streamJsonl(F("qbg_test_occurrences.jsonl"))) if (o.qbg_id && byQbg.has(o.qbg_id)) byQbg.get(o.qbg_id).occurrences.push(o);
    for await (const c of streamJsonl(F("qbg_conflicts.jsonl"))) for (const k of c.record_keys) if (byKey.has(k)) byKey.get(k).conflicts.push(c);
    for await (const d of streamJsonl(F("qbg_duplicates.jsonl"))) for (const k of d.members) if (byKey.has(k)) byKey.get(k).duplicates.push(d);
    const docIds = new Map();
    for (const l of out.values()) for (const d of [...(l.record.documents?.question_documents || []), ...(l.record.documents?.solution_documents || [])]) {
        if (!docIds.has(d)) docIds.set(d, []);
        docIds.get(d).push(l);
    }
    for await (const d of streamJsonl(F("source_documents.jsonl"))) if (docIds.has(d.document_id)) for (const l of docIds.get(d.document_id)) l.documents.push(d);
    return out;
}

/** Human-readable lineage block in the brief's format. */
export function renderLineage(l) {
    const r = l.record;
    const lines = [];
    const ind = (s) => `    ${s}`;
    lines.push(r.qbg_id ? `QBG ID:\n${ind(r.qbg_id)}` : `Record:\n${ind(r.record_key)} (no QBG id)`);
    lines.push(`question_id (minted, uuidv5):\n${ind(r.question_id)}`);
    lines.push(`Origin:\n${ind(r.origin_type)}`);
    const acRows = (r.provenance.source_rows || []).filter((s) => s.workbook.startsWith("Auto"));
    lines.push(`Metadata:\n${acRows.length ? acRows.map((s) => ind(`${s.workbook} ${s.sheet} row ${s.row}`)).join("\n") : ind("(no AutoCuration row)")}`);
    const occ = l.occurrences.filter((o) => o.counts_as_usage);
    lines.push(`Test usage (${occ.length}):\n${occ.length ? occ.slice(0, 8).map((o) => ind(`${o.test_family} | ${o.test_name ?? ""} | ${o.date ?? o.year ?? ""} ${o.batch ?? ""} ${o.exam ?? ""}${o.paper ? " P" + o.paper : ""} | Q${o.question_number ?? o.question_number_raw} | ${o.sheet}!${o.source_cell}`)).join("\n") + (occ.length > 8 ? `\n${ind(`… ${occ.length - 8} more`)}` : "") : ind("(none recorded)")}`);
    if (r.pyq_listings?.length) lines.push(`PYQ listing:\n${r.pyq_listings.map((p) => ind(`${p.exam} ${p.date ?? p.year} shift ${p.shift ?? "-"} paper ${p.paper ?? "-"} Q${p.question_number}`)).join("\n")}`);
    const qd = l.documents.filter((d) => (r.documents?.question_documents || []).includes(d.document_id));
    const sd = l.documents.filter((d) => (r.documents?.solution_documents || []).includes(d.document_id));
    if (r.origin_type === "IMPORTED_EXTERNAL" && r.record_key.startsWith("docx:")) {
        lines.push(`Question source:\n${ind(`${r.provenance.source_documents[0]?.path} paragraphs ${r.provenance.source_documents[0]?.paragraphs?.slice(0, 6).join(",")}`)}`);
        lines.push(`Solution source:\n${ind(`${r.provenance.source_documents[1]?.path ?? "-"}`)}`);
        lines.push(`PYQ citation:\n${ind(`${r.pyq_reference_text ?? "-"} -> ${r.pyq_reference?.candidate_qbg_ids_count ?? 0} candidate QBG ids (LOW; not linked)`)}`);
    } else {
        lines.push(`Question source:\n${qd.length ? qd.map((d) => ind(`${d.document_id} (${d.question_or_solution}, ${d.filenames[0] ?? "no file name"}) -> ${d.availability}`)).join("\n") : ind("(no question document recorded)")}${r.documents?.qbg_question_page ? "\n" + ind(`QBG page: ${r.documents.qbg_question_page} (content retrievable only with authorized QBG access)`) : ""}`);
        lines.push(`Solution source:\n${sd.length ? sd.map((d) => ind(`${d.document_id} (${d.filenames[0] ?? "no file name"}) -> ${d.availability}`)).join("\n") : ind("(none)")}`);
    }
    const ans = l.metadata?.fields?.answer;
    lines.push(`Answer:\n${ind(`answer_key = ${JSON.stringify(r.answer_key)}`)}${ans ? "\n" + ans.candidates.map((c) => ind(`${JSON.stringify(c.value)} <- ${c.sources.map((s) => `${s.source} (${s.location}, raw ${JSON.stringify(s.raw)})`).join("; ")}`)).join("\n") + "\n" + ind(`status = ${ans.status === "SINGLE" ? "SINGLE SOURCE" : ans.status === "AGREE" ? "CONSISTENT" : ans.status}`) : r.answer_sources_agree !== undefined ? "\n" + ind(`answer key vs solution line: ${r.answer_sources_agree ? "CONSISTENT" : "CONFLICT"}`) : ""}`);
    lines.push(`Content:\n${ind(`question_text: ${r.question_text ? "present" + (r.extraction_status === "NEEDS_REVIEW" ? " (NEEDS_REVIEW: " + r.extraction_issues.join("; ") + ")" : "") : "NOT RECOVERED"}; solution_text: ${r.solution_text ? "present" : "NOT RECOVERED"}; options: ${Array.isArray(r.options) ? r.options.length : r.options_status ?? "none"}`)}`);
    // ---- status matrix: every field, present or not, with where it came from
    const localDocIds = new Set(l.documents.filter((d) => /^LOCAL/.test(d.availability || "")).map((d) => d.document_id));
    const cov = coverageFor(r, { localDocIds });
    const cp = r.content_provenance || {};
    const at = (p) => {
        if (!p) return "";
        const where = [p.file, p.row_number ? `row ${p.row_number}` : null, p.paragraph !== undefined && p.paragraph !== null ? `para ${p.paragraph}` : null, p.locations ? p.locations.join("; ") : null].filter(Boolean).join(" ");
        return ` <- ${p.source}${where ? ` (${where})` : ""}`;
    };
    const yn = (b) => (b ? "YES" : "no ");
    const partial = (n) => (n ? ` [PARTIAL: ${n} unconverted equation placeholder(s)]` : "");
    const docCount = [...(r.documents?.question_documents || []), ...(r.documents?.solution_documents || [])].length;
    lines.push(`Status matrix:\n${[
        ind(`question text     ${yn(cov.has_question_text)}${at(cp.question_text)}${partial(r.equation_placeholders?.question)}`),
        ind(`options           ${yn(cov.has_options)}${at(cp.options)}${!cov.has_options && r.options_status ? ` [${r.options_status}]` : ""}`),
        ind(`answer            ${yn(cov.has_answer)}${at(cp.answer)}`),
        ind(`solution          ${yn(cov.has_solution)}${at(cp.solution_text)}${partial(r.equation_placeholders?.solution)}`),
        ind(`metadata          ${yn(cov.has_metadata)}`),
        ind(`source documents  ${yn(cov.has_any_source_document_ref)}${docCount ? ` (${docCount} referenced; ${localDocIds.size ? `${localDocIds.size} present locally` : "none present locally"})` : ""}`),
        ind(`test usage        ${yn(cov.has_test_usage)}${r.test_usage ? ` (${r.test_usage.occurrence_count} occurrences)` : ""}`),
        ind(`conflicts         ${cov.has_conflicts ? (cov.has_blocking_conflict ? "BLOCKING" : "open") : "none"}${l.conflicts.length ? ` [${[...new Set(l.conflicts.map((c) => c.analysis?.category || c.conflict_type))].join(", ")}]` : ""}`),
        ind(`duplicate status  ${l.duplicates.length ? [...new Set(l.duplicates.map((d) => d.analysis?.category || d.duplicate_type))].join(", ") : "none"}`),
        ind(`content source    ${r.content_source?.status ?? "n/a"}`),
    ].join("\n")}`);
    lines.push(`Still missing:\n${ind(cov.missing.length ? cov.missing.join(", ") : "nothing")}${cov.requires_external_source ? "\n" + ind("needs an external source (authorized QBG export or the referenced document); see docs/data_recovery/SOURCE_INTAKE.md") : cov.potentially_recoverable_locally ? "\n" + ind("a referenced document is present locally (not yet extracted)") : ""}`);
    lines.push(`Taxonomy:\n${ind(`${r.subject ?? "?"} > ${r.chapter ?? "?"} > ${r.topic ?? "?"} > ${r.subtopic ?? "?"} | type ${r.question_type ?? "?"} | difficulty ${r.difficulty_level ?? "?"} | class ${r.class_level ?? "?"}`)}`);
    if (l.conflicts.length) lines.push(`Conflicts (${l.conflicts.length}, all UNRESOLVED):\n${l.conflicts.slice(0, 6).map((c) => ind(`${c.conflict_id} ${c.severity} ${c.conflict_type} [${c.analysis?.category ?? "-"}]: ${c.values.map((v) => JSON.stringify(v.value ?? v.raw)).join(" vs ")}${c.analysis?.evidence_suggestion ? ` (evidence suggests ${c.analysis.evidence_suggestion.value}: ${c.analysis.evidence_suggestion.basis}; NOT applied)` : ""}`)).join("\n")}`);
    if (l.duplicates.length) lines.push(`Duplicate groups:\n${l.duplicates.map((d) => ind(`${d.duplicate_group_id} ${d.analysis?.category ?? d.duplicate_type} [${d.analysis?.relationship_status ?? d.confidence}] ${d.detail ?? ""}`)).join("\n")}`);
    lines.push(`Confidence:\n${ind(Object.entries(r.confidence).map(([k, v]) => `${k}=${v}`).join(", "))}`);
    lines.push(`Final status:\n${ind(`${r.recovery_class} (${r.recovery_reasons.join("; ") || "all criteria met"})`)}\n${ind(`import: ${r.import_readiness}${r.import_reasons.length ? " - " + r.import_reasons.join("; ") : ""}`)}`);
    return lines.join("\n\n");
}
