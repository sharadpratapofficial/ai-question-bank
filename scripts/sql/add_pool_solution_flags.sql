-- Adds "has an English video solution" / "has an English text solution"
-- flags to public.qbg_question_pool, for the QBG Pipeline pool-selection
-- filter menu. Computed from the existing solutions/bilingual_solutions
-- JSONB columns (solutions is a JSON array, bilingual_solutions a JSON
-- object — confirmed via jsonb_typeof against the live table).
--
-- Idempotent: safe to re-run. import_pool.py computes/writes these same two
-- columns going forward for new/changed rows; this script is only needed
-- once, to backfill rows that were already imported before these columns
-- existed (a plain re-import wouldn't touch them, since row_hash covers the
-- raw source row and wouldn't have changed).

ALTER TABLE public.qbg_question_pool
    ADD COLUMN IF NOT EXISTS has_video_solution boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS has_text_solution boolean NOT NULL DEFAULT false;

UPDATE public.qbg_question_pool
SET has_video_solution = (
        NULLIF(solutions->0->'english'->'videoSolution'->>'url', '') IS NOT NULL
        OR NULLIF(bilingual_solutions->'english'->'videoSolution'->>'url', '') IS NOT NULL
    ),
    has_text_solution = (
        length(trim(both from regexp_replace(COALESCE(solutions->0->'english'->>'text', ''), '<[^>]*>', '', 'g'))) > 0
        OR length(trim(both from regexp_replace(COALESCE(bilingual_solutions->'english'->>'text', ''), '<[^>]*>', '', 'g'))) > 0
    );

CREATE INDEX IF NOT EXISTS idx_pool_has_video_solution ON public.qbg_question_pool (has_video_solution);
CREATE INDEX IF NOT EXISTS idx_pool_has_text_solution ON public.qbg_question_pool (has_text_solution);
