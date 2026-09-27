-- =============================================================================
-- 001_post_import_backfills.sql
-- Data backfills carried over from the original migrations. Run AFTER
-- 000_rebuild_schema.sql AND after question data has been imported into
-- public.qbg_questions. On an empty database every statement is a no-op.
--
-- Both statements are idempotent: re-running them does not duplicate rows or
-- overwrite status changes made through the app.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Initial QC status from raw QBG metadata
-- -----------------------------------------------------------------------------
-- From add_question_status_and_history.sql step 3. The original
--   UPDATE ... SET status = CASE ... END WHERE created_by IS NULL
-- would reset any status a reviewer had since changed, and its ::int cast
-- aborted on a non-numeric verification_status. This version only promotes
-- rows that are still at the default and whose raw value is exactly 1.
update public.qbg_questions
set status = 'verified'::public.question_status
where status = 'verification_pending'
  and created_by is null
  and jsonb_typeof(raw_data) = 'array'
  and raw_data->0->>'verification_status' = '1';


-- -----------------------------------------------------------------------------
-- 2. Translations embedded in raw_data -> question_translations
-- -----------------------------------------------------------------------------
-- From backfill_question_translations.sql. Copies
--   qbg_questions.raw_data[*].ai_metadata.translations[]
-- into question_translations, oldest first, so the BEFORE INSERT trigger
-- leaves the newest translation per (question, language) as the default.
--
-- Changes from the original:
--   * NOT EXISTS guard, so a re-run inserts nothing twice
--   * translatedAt is only cast when it looks like an ISO timestamp; anything
--     else falls back to now() instead of aborting the whole statement
with src as (
    select
        q.question_id,
        lower(coalesce(t->>'targetLanguage', 'unknown'))              as language,
        coalesce(t->>'translatedQuestionText', '')                    as question_text,
        coalesce(t->'translatedOptions', '[]'::jsonb)                 as options,
        nullif(t->>'translatedSolutionText', '')                      as solution_text,
        nullif(t->>'translationNotes', '')                            as translation_notes,
        nullif(t->>'provider', '')                                    as provider,
        nullif(t->>'modelId', '')                                     as model_id,
        nullif(t->>'modelLabel', '')                                  as model_label,
        case
            when t->>'translatedAt' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$'
                then (t->>'translatedAt')::timestamptz
            else now()
        end                                                           as created_at
    from public.qbg_questions q
    cross join lateral jsonb_array_elements(
        case when jsonb_typeof(q.raw_data) = 'array' then q.raw_data else '[]'::jsonb end
    ) as rd
    cross join lateral jsonb_array_elements(
        case
            when jsonb_typeof(rd->'ai_metadata'->'translations') = 'array'
                then rd->'ai_metadata'->'translations'
            else '[]'::jsonb
        end
    ) as t
    where coalesce(t->>'translatedQuestionText', '') <> ''
)
insert into public.question_translations
    (question_id, language, question_text, options, solution_text,
     translation_notes, provider, model_id, model_label, translated_by, created_at)
select
    s.question_id, s.language, s.question_text, s.options, s.solution_text,
    s.translation_notes, s.provider, s.model_id, s.model_label, null::uuid, s.created_at
from src s
where not exists (
    select 1
    from public.question_translations qt
    where qt.question_id   = s.question_id
      and qt.language      = s.language
      and qt.question_text = s.question_text
)
order by s.question_id, s.language, s.created_at asc;

-- Sanity check: migrated rows per language.
select language,
       count(*)                            as total,
       count(*) filter (where is_default)  as defaults
from public.question_translations
group by language
order by total desc;
