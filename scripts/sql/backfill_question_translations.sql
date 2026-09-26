-- Run once in Supabase SQL Editor AFTER create_question_translations_table.sql.
-- Salvages existing translations buried inside qbg_questions.raw_data[*].ai_metadata.translations[]
-- and copies them into the new question_translations table.
--
-- Ordering oldest -> newest so that the BEFORE INSERT trigger keeps marking
-- the latest insert as default, which matches the previous "latest wins" UX.

insert into public.question_translations
    (question_id, language, question_text, options, solution_text,
     translation_notes, provider, model_id, model_label, translated_by, created_at)
select
    q.question_id,
    lower(coalesce(t->>'targetLanguage', 'unknown'))                    as language,
    coalesce(t->>'translatedQuestionText', '')                          as question_text,
    coalesce(t->'translatedOptions', '[]'::jsonb)                       as options,
    nullif(t->>'translatedSolutionText', '')                            as solution_text,
    nullif(t->>'translationNotes', '')                                  as translation_notes,
    nullif(t->>'provider', '')                                          as provider,
    nullif(t->>'modelId', '')                                           as model_id,
    nullif(t->>'modelLabel', '')                                        as model_label,
    null::uuid                                                          as translated_by,
    coalesce(nullif(t->>'translatedAt', '')::timestamptz, now())        as created_at
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
order by q.question_id,
         lower(coalesce(t->>'targetLanguage', 'unknown')),
         coalesce(nullif(t->>'translatedAt', '')::timestamptz, now()) asc;

-- Sanity check: how many rows were migrated, per language.
select language, count(*) as total,
       count(*) filter (where is_default) as defaults
from public.question_translations
group by language
order by total desc;
