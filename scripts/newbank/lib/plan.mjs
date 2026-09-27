/**
 * Planning + apply logic for the NEW question-bank importer.
 * No direct I/O: the database is reached only through a `target`
 * (lib/target.mjs, or an in-memory fake in tests).
 */
import { mapRecord, contentHash } from "./format.mjs";
import { sha256 } from "./media.mjs";

/** Parse .jsonl (one object per line) or .json (array of objects). Parse errors become per-record entries. */
export function parseInput(text, filename) {
    const body = text.replace(/^﻿/, "");
    if (/\.json$/i.test(filename)) {
        let arr;
        try { arr = JSON.parse(body); } catch (e) { throw new Error(`${filename}: not valid JSON (${e.message})`); }
        if (!Array.isArray(arr)) throw new Error(`${filename}: a .json input must be an array of records`);
        return arr.map((value, i) => ({ recordNumber: i + 1, value }));
    }
    const out = [];
    body.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        try { out.push({ recordNumber: i + 1, value: JSON.parse(line) }); }
        catch (e) { out.push({ recordNumber: i + 1, parseError: e.message }); }
    });
    return out;
}

/**
 * Validate every record, then apply file-level rules:
 *   - a source_key or legacy_qbg_id used by more than one record rejects ALL of them
 *     (we cannot tell which one is right, so none is imported);
 *   - a passage group (parent + children) imports whole or not at all;
 *   - likely content duplicates (same normalised text + options) are reported, not rejected.
 * Returns { units, rejected, warnings, possibleDuplicates, stats }.
 * A unit is [row] for a standalone question or [parent, ...children by child_order].
 */
export function buildPlan(entries, ctx = {}) {
    const rejected = [];
    const valid = []; // { recordNumber, row, meta, warnings }
    const allByKey = new Map(); // source_key -> record numbers (valid or not)
    const childKeysByParent = new Map(); // parent_source_key -> [source_key] (valid or not)
    const reject = (recordNumber, sourceKey, errors) => rejected.push({ record_number: recordNumber, source_key: sourceKey ?? null, errors });

    for (const e of entries) {
        if (e.parseError) { reject(e.recordNumber, null, [`invalid JSON: ${e.parseError}`]); continue; }
        const r = mapRecord(e.value, { sourceFile: ctx.sourceFile, sourceSha256: ctx.sourceSha256, recordNumber: e.recordNumber, resolveMedia: ctx.resolveMedia });
        const key = r.meta.source_key ?? (typeof e.value?.source_key === "string" ? e.value.source_key.trim() : null);
        if (key) allByKey.set(key, [...(allByKey.get(key) || []), e.recordNumber]);
        const pk = typeof e.value?.parent_source_key === "string" ? e.value.parent_source_key.trim() : null;
        if (pk && key) childKeysByParent.set(pk, [...(childKeysByParent.get(pk) || []), key]);
        if (!r.ok) { reject(e.recordNumber, key, r.errors); continue; }
        valid.push({ recordNumber: e.recordNumber, row: r.row, meta: r.meta, warnings: r.warnings });
    }

    // Duplicate source_key / legacy_qbg_id -> reject every occurrence.
    const dupKeys = new Set([...allByKey].filter(([, n]) => n.length > 1).map(([k]) => k));
    const legacyCount = new Map();
    for (const v of valid) if (v.meta.legacy_qbg_id) legacyCount.set(v.meta.legacy_qbg_id, (legacyCount.get(v.meta.legacy_qbg_id) || 0) + 1);
    let alive = [];
    for (const v of valid) {
        const errs = [];
        if (dupKeys.has(v.meta.source_key)) errs.push(`duplicate source_key (records ${allByKey.get(v.meta.source_key).join(", ")})`);
        if (v.meta.legacy_qbg_id && legacyCount.get(v.meta.legacy_qbg_id) > 1) errs.push(`legacy_qbg_id ${v.meta.legacy_qbg_id} used by more than one record`);
        if (errs.length) reject(v.recordNumber, v.meta.source_key, errs); else alive.push(v);
    }
    for (const k of dupKeys) {
        // duplicates that already failed validation are in `rejected`; make sure the reason is visible
        for (const rj of rejected) if (rj.source_key === k && !rj.errors.some((x) => x.startsWith("duplicate source_key"))) rj.errors.push("duplicate source_key");
    }

    // Passage groups: whole group or nothing. Repeat until stable (a rejection can cascade).
    for (let changed = true; changed;) {
        changed = false;
        const aliveKeys = new Map(alive.map((v) => [v.meta.source_key, v]));
        const next = [];
        for (const v of alive) {
            let why = null;
            if (v.meta.parent_source_key) {
                const p = aliveKeys.get(v.meta.parent_source_key);
                if (!p) why = `parent ${v.meta.parent_source_key} is missing from the input or was rejected`;
                else if (p.meta.kind !== "parent") why = `parent ${v.meta.parent_source_key} is not a passage type (Composite / Passage_Numerical)`;
            } else if (v.meta.kind === "parent") {
                const kids = childKeysByParent.get(v.meta.source_key) || [];
                if (!kids.length) why = "passage parent has no child questions in the input";
                else if (kids.some((k) => !aliveKeys.has(k))) why = "passage group incomplete: a child question was rejected";
                else {
                    const orders = kids.map((k) => aliveKeys.get(k).meta.child_order);
                    if (new Set(orders).size !== orders.length) why = "passage group has duplicate child_order values";
                }
            }
            if (why) { reject(v.recordNumber, v.meta.source_key, [why]); changed = true; } else next.push(v);
        }
        alive = next;
    }

    // Units in input order (a group is placed where its parent appears).
    const byParent = new Map();
    for (const v of alive) if (v.meta.parent_source_key) byParent.set(v.meta.parent_source_key, [...(byParent.get(v.meta.parent_source_key) || []), v]);
    const units = [];
    for (const v of alive) {
        if (v.meta.parent_source_key) continue;
        const kids = (byParent.get(v.meta.source_key) || []).sort((a, b) => a.meta.child_order - b.meta.child_order);
        units.push([v, ...kids]);
    }

    // Possible content duplicates (reported only).
    const byPrint = new Map();
    for (const v of alive) byPrint.set(v.meta.fingerprint, [...(byPrint.get(v.meta.fingerprint) || []), v.meta.source_key]);
    const possibleDuplicates = [...byPrint.values()].filter((ks) => ks.length > 1);

    rejected.sort((a, b) => a.record_number - b.record_number);
    const warnings = alive.filter((v) => v.warnings.length).map((v) => ({ source_key: v.meta.source_key, warnings: v.warnings }));
    return {
        units, rejected, warnings, possibleDuplicates,
        stats: { records_read: entries.length, valid: alive.length, rejected: rejected.length, units: units.length },
    };
}

/** --only=k1,k2 (whole groups are pulled in) then --limit=N (counts units, not rows). */
export function selectUnits(units, { only = null, limit = null } = {}) {
    let sel = units;
    if (only?.length) {
        const want = new Set(only);
        sel = units.filter((u) => u.some((v) => want.has(v.meta.source_key)));
        const found = new Set(sel.flat().map((v) => v.meta.source_key));
        const missing = only.filter((k) => !found.has(k));
        if (missing.length) throw new Error(`--only keys not found among valid records: ${missing.join(", ")}`);
    }
    if (limit) sel = sel.slice(0, limit);
    return sel;
}

/**
 * Decide insert / update / skip / reject for every selected row against the database.
 * Existing rows are never overwritten unless --update-existing AND the row is still exactly
 * what this importer wrote AND it is still verification_pending.
 */
export async function classify(units, target, { updateExisting = false } = {}) {
    const rows = units.flat().map((v) => v.row);
    // per row: its unit (a passage group moves together) and its image upload jobs
    const unitOf = new Map(), mediaOf = new Map();
    for (const u of units) for (const v of u) { unitOf.set(v.row.question_id, u[0].row.question_id); mediaOf.set(v.row.question_id, v.meta.media ?? []); }
    const existing = await target.fetchByIds(rows.map((r) => r.question_id));
    const legacyIds = rows.map((r) => r.raw_data[0]._newbank.legacy_qbg_id).filter(Boolean);
    const legacyHolders = legacyIds.length ? await target.fetchByQbgIds(legacyIds) : [];

    const decisions = new Map(); // question_id -> { action, reason?, row, existing? }
    for (const row of rows) {
        const meta = row.raw_data[0]._newbank;
        const holder = meta.legacy_qbg_id && legacyHolders.find((h) => h.qbg_id === meta.legacy_qbg_id && h.question_id !== row.question_id);
        const ex = existing.get(row.question_id);
        let d;
        if (holder) d = { action: "reject", reason: `legacy_qbg_id ${meta.legacy_qbg_id} already belongs to question ${holder.question_id}` };
        else if (!ex) d = { action: "insert" };
        else {
            const exMeta = Array.isArray(ex.raw_data) ? ex.raw_data[0]?._newbank : null;
            if (!exMeta) d = { action: "skip", reason: "exists_not_created_by_newbank_importer" };
            else if (exMeta.content_hash === meta.content_hash) d = { action: "skip", reason: "unchanged" };
            else if (!updateExisting) d = { action: "skip", reason: "exists_source_changed (re-run with --update-existing to update)" };
            else if (contentHash(ex) !== exMeta.content_hash) d = { action: "skip", reason: "edited_in_app_since_import (not overwritten)" };
            else if (ex.status !== "verification_pending") d = { action: "skip", reason: `already reviewed (status ${ex.status}); not overwritten` };
            else d = { action: "update" };
        }
        decisions.set(row.question_id, { ...d, row, existing: ex ?? null, unit: unitOf.get(row.question_id), media: mediaOf.get(row.question_id) });
    }
    // A passage group moves together: if any member is rejected, reject the rest of the group.
    for (const u of units) {
        const bad = u.find((v) => decisions.get(v.row.question_id).action === "reject");
        if (!bad) continue;
        for (const v of u) {
            const d = decisions.get(v.row.question_id);
            if (d.action !== "reject") decisions.set(v.row.question_id, { ...d, action: "reject", reason: `group member ${bad.meta.source_key} rejected` });
        }
    }
    return decisions;
}

const CONTENT_COLUMNS = ["qbg_id", "question_text", "options", "answer_key", "solution_text", "question_type", "subject", "chapter", "topic", "subtopic", "source", "difficutly_level", "class_level", "exam", "parent_question_id", "child_order"];

/**
 * Upload each written question's images, then write the rows, then read everything back.
 *   - Images go first: a row is only written once all of its images are stored, so the
 *     database never references a missing object. A failed image holds back its whole unit.
 *   - Uploads never overwrite. An object already at the path is accepted only when its bytes
 *     hash to the same SHA-256 (a retry); anything else is a conflict and the unit is not written.
 *   - Read-back compares every written row's content hash and every image's SHA-256.
 * opts: { asUser: uuid|null, now: ISO string, batchSize }
 */
export async function applyDecisions(decisions, target, { asUser = null, now = new Date().toISOString(), batchSize = 100, log = () => {} } = {}) {
    const stamp = (row) => ({ ...row, raw_data: [{ ...row.raw_data[0], _newbank: { ...row.raw_data[0]._newbank, imported_at: now } }] });
    const result = { inserted: 0, updated: 0, failed: [], media: { uploaded: 0, already_present: 0, failed: 0 } };
    const toWrite = [...decisions.values()].filter((d) => d.action === "insert" || d.action === "update");

    // 1. images
    const failedUnits = new Map(); // unit -> reason
    const uploaded = new Map(); // storage_path -> sha256 (one upload per path per run)
    for (const d of toWrite) {
        if (failedUnits.has(d.unit)) continue;
        for (const m of d.media ?? []) {
            if (uploaded.get(m.storage_path) === m.sha256) continue;
            try {
                const r = await target.uploadMedia(m.storage_path, m.load(), m.mime);
                if (r === "uploaded") { result.media.uploaded++; log({ event: "media_uploaded", path: m.storage_path }); }
                else {
                    const got = await target.downloadMedia(m.storage_path);
                    if (!got || sha256(got) !== m.sha256) throw new Error(`a different object already exists at ${m.storage_path}; it is never overwritten`);
                    result.media.already_present++;
                    log({ event: "media_already_present", path: m.storage_path });
                }
                uploaded.set(m.storage_path, m.sha256);
            } catch (e) {
                result.media.failed++;
                failedUnits.set(d.unit, e.message);
                log({ event: "media_failed", path: m.storage_path, error: e.message });
                break;
            }
        }
    }
    for (const d of toWrite) {
        if (failedUnits.has(d.unit)) result.failed.push({ stage: "media", question_ids: [d.row.question_id], error: failedUnits.get(d.unit) });
    }
    const ready = toWrite.filter((d) => !failedUnits.has(d.unit));

    // 2. rows
    const inserts = ready.filter((d) => d.action === "insert").map((d) => ({ ...stamp(d.row), created_by: asUser, last_modified_by: asUser, last_modified_at: now }));
    for (let i = 0; i < inserts.length; i += batchSize) {
        const batch = inserts.slice(i, i + batchSize);
        try { await target.insert(batch); result.inserted += batch.length; log({ event: "insert_batch", rows: batch.length }); }
        catch (e) { result.failed.push({ stage: "insert", question_ids: batch.map((r) => r.question_id), error: e.message }); log({ event: "insert_failed", error: e.message }); }
    }
    for (const d of ready.filter((x) => x.action === "update")) {
        const s = stamp(d.row);
        const patch = Object.fromEntries(CONTENT_COLUMNS.map((c) => [c, s[c]]));
        // keep whatever the app added to raw_data (e.g. ai_metadata); only replace our own block
        const exRaw = Array.isArray(d.existing.raw_data) ? d.existing.raw_data : [{}];
        patch.raw_data = [{ ...exRaw[0], _newbank: s.raw_data[0]._newbank }, ...exRaw.slice(1)];
        patch.last_modified_by = asUser;
        patch.last_modified_at = now;
        try { await target.update(d.row.question_id, patch); result.updated++; log({ event: "update", question_id: d.row.question_id }); }
        catch (e) { result.failed.push({ stage: "update", question_ids: [d.row.question_id], error: e.message }); }
    }

    // 3. read-back: rows written in this run (including failed attempts, which must be absent or unchanged)
    const failedIds = new Set(result.failed.flatMap((f) => f.question_ids));
    const written = ready.filter((d) => !failedIds.has(d.row.question_id));
    const back = await target.fetchByIds(written.map((d) => d.row.question_id));
    const mismatches = [];
    for (const d of written) {
        const got = back.get(d.row.question_id);
        if (!got) mismatches.push({ question_id: d.row.question_id, problem: "not found on read-back" });
        else if (contentHash(got) !== d.row.raw_data[0]._newbank.content_hash) mismatches.push({ question_id: d.row.question_id, problem: "content differs on read-back" });
        for (const m of d.media ?? []) {
            const bytes = await target.downloadMedia(m.storage_path);
            if (!bytes) mismatches.push({ question_id: d.row.question_id, problem: `image missing: ${m.storage_path}` });
            else if (sha256(bytes) !== m.sha256) mismatches.push({ question_id: d.row.question_id, problem: `image differs: ${m.storage_path}` });
        }
    }
    result.read_back = { checked: written.length, ok: written.length - new Set(mismatches.map((x) => x.question_id)).size, mismatches };
    return result;
}
