/**
 * Reseed public.qbg_questions (metadata only) from Chem_Question_Bank.xlsx.
 *
 * IMPORTANT — read this before running: Chem_Question_Bank.xlsx (built from
 * AutoCuration_Lovee.xlsx + Important_IDs_REplica.xlsx) only ever carried
 * curation metadata: chapter/topic/subtopic tagging, difficulty, source,
 * question type, answer-key INDICES ("2,4"), option LABELS ("A~B~C~D" — just
 * how many options and their letters, not real option text), and links to
 * the original question/solution PDF files. The real question_text,
 * options[].text, and solution_text were never in these spreadsheets — they
 * only exist inside the linked PDFs (question_file_link / solution_file_link)
 * or the original QBG system.
 *
 * So this script inserts METADATA-ONLY rows:
 *   - question_text / solution_text / options[].text -> null
 *   - answer_key -> real (parsed from the "2,4" style index string)
 *   - content_imported -> false
 *   - question_file_link / solution_file_link -> kept as real, queryable
 *     columns (see docs/SCHEMA_RECOVERY_PLAN.md §2) so a later pass -- e.g.
 *     the app's own "AI Bulk Import from PDFs" feature, pointed at these
 *     links -- can backfill real content and flip content_imported to true.
 *
 * Prereqs: run docs/SCHEMA_RECOVERY_PLAN.md's migrations against a Supabase
 * project first (the qbg_questions table must exist).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/reseed_chem_question_bank.mjs [path/to/Chem_Question_Bank.xlsx] [--dry-run]
 *
 * Use the SERVICE ROLE key here (not the anon key) — this writes created_by/
 * status-adjacent columns and should bypass RLS as a trusted server-side seed,
 * not go through the same policies a signed-in browser client would.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const filePath = args.find((a) => !a.startsWith('--')) || './Chem_Question_Bank.xlsx';
const BATCH_SIZE = 200;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY env vars.');
    console.error('(Pass --dry-run to preview the transform without needing either.)');
    process.exit(1);
}

// The two curation source spreadsheets had a mojibake bug (UTF-8 text
// re-decoded as Latin-1 somewhere upstream) -- e.g. "Planck's" came through
// as "PlanckÃ¢â‚¬â„¢s". This is the standard round-trip fix. Safe no-op on
// already-clean strings (round-tripping ASCII through latin1<->utf8 is a
// no-op); only touches strings that actually contain the tell-tale "Ã" byte
// sequence, so we don't risk mangling genuinely clean non-ASCII text.
function fixMojibake(s) {
    if (typeof s !== 'string' || !s.includes('Ã')) return s;
    try {
        return Buffer.from(s, 'latin1').toString('utf8');
    } catch {
        return s;
    }
}

function parseAnswerKey(answerStr, questionType) {
    if (answerStr === null || answerStr === undefined || answerStr === '') return null;
    const raw = String(answerStr).trim();
    if (/numerical/i.test(questionType || '')) {
        // Numerical answers are values, not option indices -- keep as-is
        // (as a string; could be "24.5", a range, etc. -- don't force a number).
        return raw;
    }
    const parts = raw.split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n));
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : parts;
}

function parseOptionLabels(optionText) {
    if (!optionText) return [];
    // "A~B~C~D" -> 4 placeholder options, real text unknown.
    return String(optionText)
        .split('~')
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => ({ label, text: null, isCorrect: null }));
}

function toRow(r) {
    return {
        qbg_id: r.qbg_id || null,
        subject: 'Chemistry',
        chapter: fixMojibake(r.chapter) || null,
        topic: r.topic === '#N/A' ? null : fixMojibake(r.topic) || null,
        subtopic: fixMojibake(r.subtopic) || null,
        class_level: r.class ? String(r.class) : (r.class_lookup || null),
        difficutly_level: r.difficulty_level || null, // typo preserved to match the real column name
        question_type: r.question_type || null,
        source: r.source || null,
        exam: r.exam_type ? [String(r.exam_type)] : null,
        answer_key: parseAnswerKey(r.answer, r.question_type),
        options: parseOptionLabels(r.option_text),
        question_text: null,
        solution_text: null,
        question_file_link: r.question_file_link || null,
        solution_file_link: r.solution_file_link || null,
        content_imported: false,
        raw_data: null,
    };
}

function main() {
    console.log(`Reading ${filePath} ...`);
    const buf = readFileSync(filePath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets['ChemBank'];
    if (!sheet) {
        console.error(`Sheet "ChemBank" not found. Sheets present: ${wb.SheetNames.join(', ')}`);
        process.exit(1);
    }
    const records = XLSX.utils.sheet_to_json(sheet, { defval: null });
    console.log(`Loaded ${records.length} rows.`);

    const rows = records.map(toRow).filter((r) => r.qbg_id); // qbg_id is our conflict key; skip any without one
    console.log(`${rows.length} rows have a qbg_id and will be upserted.`);

    if (DRY_RUN) {
        console.log('\n--dry-run: no writes performed. First 3 transformed rows:');
        console.log(JSON.stringify(rows.slice(0, 3), null, 2));
        return;
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    (async () => {
        let inserted = 0;
        let failed = 0;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            const { error, count } = await supabase
                .from('qbg_questions')
                .upsert(batch, { onConflict: 'qbg_id', count: 'exact' });
            if (error) {
                failed += batch.length;
                console.error(`Batch ${i}-${i + batch.length} failed:`, error.message);
            } else {
                inserted += count ?? batch.length;
                console.log(`Upserted rows ${i}-${i + batch.length} (${inserted} total so far)`);
            }
        }
        console.log(`\nDone. Upserted: ${inserted}, failed: ${failed}.`);
        if (failed > 0) process.exitCode = 1;
    })();
}

main();
