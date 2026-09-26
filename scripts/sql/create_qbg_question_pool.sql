-- Reference dataset for the "QBG Pipeline" feature (/qbg -> QBG Pipeline tab).
--
-- The user maintains a large external export of QBG questions (QBG_data.csv,
-- 28k+ rows, updated/appended over time) at the repo root. This table is that
-- CSV imported into Postgres so the pipeline's pool-selection step can filter
-- it the same way the Tests feature filters `qbg_questions` — via fast indexed
-- queries instead of re-parsing a 191MB CSV on every request.
--
-- Populated/refreshed by python/qbg_pool_import/import_pool.py, which upserts
-- by unique_id. IMPORTANT: `used_in_exam` is intentionally NOT part of that
-- script's upsert column list — it is owned by this app (written the moment a
-- question is picked into a pipeline pool, so the same question isn't picked
-- again for a batch it's already been used in) and must survive re-imports of
-- a CSV that itself always has this column empty.

CREATE TABLE IF NOT EXISTS public.qbg_question_pool (
    unique_id                  text PRIMARY KEY,   -- QBG's own id; qbg_id column mirrors this 1:1 in the source export
    qbg_id                     text,
    question_type              text,               -- Single_Choice(SCQ) / Multi_Choice(MCQ) / Numerical / ...
    difficulty_level            text,               -- Easy / Medium / Difficult / '0' (unset)
    difficulty                 smallint,           -- 0/1/2/3, matches the QBG Tagging feature's scale
    source                     text,
    subject                    text,
    chapter                    text,
    topic                      text,
    subtopic                   text,               -- SubtopicName
    class_level                 text,               -- Class: 10/11/12
    category_name               text,
    used_in_exam                text[] NOT NULL DEFAULT '{}',  -- batch names this question has been used in; app-owned
    has_video_solution          boolean NOT NULL DEFAULT false, -- English videoSolution.url present (solutions[0] or bilingual_solutions)
    has_text_solution           boolean NOT NULL DEFAULT false, -- English solution text present (solutions[0] or bilingual_solutions)
    verification_status         smallint,
    is_int_answer               boolean,
    is_range_numerical          boolean,
    exam_year                  text,
    qc_status                  text,
    -- opaque JSONB payload — same shapes the raw QBG API returns (see
    -- python/qbg_modification/qbg.py get_bulk_questions / csvbuild.py)
    content                    jsonb,
    bilingual_options            jsonb,
    solutions                  jsonb,
    bilingual_solutions          jsonb,
    answer                     jsonb,
    concept_tags                 jsonb,   -- conceptTags
    readiness_tags               jsonb,   -- readinessTags
    x_category_tags              jsonb,   -- xCategoryTags
    languages                   jsonb,
    exam_details                 jsonb,   -- examDetails
    sources                     jsonb,
    child_questions              jsonb,
    -- scalar passthroughs, kept for reference / potential future use
    link                       text,
    slug                       text,
    parent_question_id           text,
    organization_id              text,
    category_configuration_id     text,
    row_hash                    text,     -- sha256 of the raw CSV row; lets the importer skip unchanged rows cheaply
    source_created_at            timestamptz,
    source_updated_at            timestamptz,
    imported_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pool_subject_chapter_topic ON public.qbg_question_pool (subject, chapter, topic);
CREATE INDEX IF NOT EXISTS idx_pool_class       ON public.qbg_question_pool (class_level);
CREATE INDEX IF NOT EXISTS idx_pool_source      ON public.qbg_question_pool (source);
CREATE INDEX IF NOT EXISTS idx_pool_category    ON public.qbg_question_pool (category_name);
CREATE INDEX IF NOT EXISTS idx_pool_qtype       ON public.qbg_question_pool (question_type);
CREATE INDEX IF NOT EXISTS idx_pool_difficulty  ON public.qbg_question_pool (difficulty);
CREATE INDEX IF NOT EXISTS idx_pool_qbg_id      ON public.qbg_question_pool (qbg_id);
CREATE INDEX IF NOT EXISTS idx_pool_used_in_exam ON public.qbg_question_pool USING GIN (used_in_exam);
CREATE INDEX IF NOT EXISTS idx_pool_has_video_solution ON public.qbg_question_pool (has_video_solution);
CREATE INDEX IF NOT EXISTS idx_pool_has_text_solution ON public.qbg_question_pool (has_text_solution);

ALTER TABLE public.qbg_question_pool ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qqp_select ON public.qbg_question_pool;
DROP POLICY IF EXISTS qqp_insert ON public.qbg_question_pool;
DROP POLICY IF EXISTS qqp_update ON public.qbg_question_pool;
DROP POLICY IF EXISTS qqp_delete ON public.qbg_question_pool;
CREATE POLICY qqp_select ON public.qbg_question_pool FOR SELECT USING (true);
CREATE POLICY qqp_insert ON public.qbg_question_pool FOR INSERT WITH CHECK (true);
CREATE POLICY qqp_update ON public.qbg_question_pool FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY qqp_delete ON public.qbg_question_pool FOR DELETE USING (true);
GRANT ALL ON public.qbg_question_pool TO anon, authenticated, service_role;
