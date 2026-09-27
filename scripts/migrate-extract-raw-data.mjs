/**
 * Migration Script: Extract exam, class_level, subtopic from raw_data
 * 
 * This script:
 * 1. Adds new columns: exam (text[]), class_level (text), subtopic (text)
 * 2. Extracts values from raw_data JSONB for all 14,943 questions
 * 3. Creates indexes for efficient filtering
 * 
 * Run with: node --env-file=.env.local scripts/migrate-extract-raw-data.mjs
 * It UPDATES rows, so it needs the server-only secret key (SUPABASE_SECRET_KEY,
 * or legacy SUPABASE_SERVICE_ROLE_KEY): with Row Level Security on, the
 * publishable key cannot write.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TABLE = 'qbg_questions';
const BATCH_SIZE = 100;

function extractFromRawData(rawData) {
    if (!rawData) return { exam: null, class_level: null, subtopic: null };

    const r = Array.isArray(rawData) ? rawData[0] : rawData;
    if (!r) return { exam: null, class_level: null, subtopic: null };

    // Extract exams (can be multiple)
    let exam = null;
    if (r.examDetails && Array.isArray(r.examDetails) && r.examDetails.length > 0) {
        exam = r.examDetails
            .map(e => e.english_name)
            .filter(Boolean);
        if (exam.length === 0) exam = null;
    }

    // Extract class level
    let class_level = null;
    const ct = r.conceptTags?.[0];
    if (ct?.class?.english_name) {
        class_level = ct.class.english_name;
    }

    // Extract subtopic
    let subtopic = null;
    if (ct?.subtopic?.english_name) {
        subtopic = ct.subtopic.english_name;
    }

    return { exam, class_level, subtopic };
}

async function migrate() {
    console.log('🚀 Starting migration: extracting exam, class_level, subtopic from raw_data...\n');

    // Step 1: Fetch all questions with raw_data
    console.log('📥 Fetching all questions...');
    let allQuestions = [];
    let page = 0;

    while (true) {
        const { data, error } = await supabase
            .from(TABLE)
            .select('question_id, raw_data')
            .range(page * 1000, (page + 1) * 1000 - 1);

        if (error) {
            console.error('❌ Fetch error:', error.message);
            return;
        }
        if (!data || data.length === 0) break;
        allQuestions.push(...data);
        page++;
        if (data.length < 1000) break;
    }

    console.log(`✅ Fetched ${allQuestions.length} questions\n`);

    // Step 2: Extract and update in batches
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const stats = {
        withExam: 0,
        withClass: 0,
        withSubtopic: 0,
        exams: new Set(),
        classes: new Set(),
        subtopics: new Set(),
    };

    for (let i = 0; i < allQuestions.length; i += BATCH_SIZE) {
        const batch = allQuestions.slice(i, i + BATCH_SIZE);
        const updates = [];

        for (const q of batch) {
            const { exam, class_level, subtopic } = extractFromRawData(q.raw_data);

            if (!exam && !class_level && !subtopic) {
                skipped++;
                continue;
            }

            const updateData = {};
            if (exam) {
                updateData.exam = exam;
                stats.withExam++;
                exam.forEach(e => stats.exams.add(e));
            }
            if (class_level) {
                updateData.class_level = class_level;
                stats.withClass++;
                stats.classes.add(class_level);
            }
            if (subtopic) {
                updateData.subtopic = subtopic;
                stats.withSubtopic++;
                stats.subtopics.add(subtopic);
            }

            updates.push({ question_id: q.question_id, ...updateData });
        }

        // Update each question individually (Supabase doesn't support bulk update with different values)
        for (const upd of updates) {
            const { question_id, ...fields } = upd;
            const { error } = await supabase
                .from(TABLE)
                .update(fields)
                .eq('question_id', question_id);

            if (error) {
                errors++;
                if (errors <= 5) {
                    console.error(`❌ Update error for ${question_id}:`, error.message);
                    if (error.message.includes('column')) {
                        console.error('\n⚠️  Columns do not exist yet! Run the SQL below in Supabase SQL Editor first:\n');
                        console.error(`
ALTER TABLE qbg_questions ADD COLUMN IF NOT EXISTS exam text[];
ALTER TABLE qbg_questions ADD COLUMN IF NOT EXISTS class_level text;
ALTER TABLE qbg_questions ADD COLUMN IF NOT EXISTS subtopic text;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS idx_qbg_questions_exam ON qbg_questions USING GIN (exam);
CREATE INDEX IF NOT EXISTS idx_qbg_questions_class_level ON qbg_questions (class_level);
CREATE INDEX IF NOT EXISTS idx_qbg_questions_subtopic ON qbg_questions (subtopic);
                        `);
                        return;
                    }
                }
            } else {
                updated++;
            }
        }

        const pct = ((i + batch.length) / allQuestions.length * 100).toFixed(1);
        process.stdout.write(`\r📝 Progress: ${i + batch.length}/${allQuestions.length} (${pct}%) | Updated: ${updated} | Skipped: ${skipped} | Errors: ${errors}`);
    }

    console.log('\n\n✅ Migration complete!\n');
    console.log('📊 Statistics:');
    console.log(`   Questions with exam:     ${stats.withExam}`);
    console.log(`   Questions with class:    ${stats.withClass}`);
    console.log(`   Questions with subtopic: ${stats.withSubtopic}`);
    console.log(`   Skipped (no data):       ${skipped}`);
    console.log(`   Errors:                  ${errors}`);
    console.log(`\n   Unique exams:    ${[...stats.exams].sort().join(', ')}`);
    console.log(`   Unique classes:  ${[...stats.classes].sort().join(', ')}`);
    console.log(`   Unique subtopics: ${stats.subtopics.size}`);
}

migrate().catch(console.error);
