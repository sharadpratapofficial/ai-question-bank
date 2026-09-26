-- Cascading distinct-value lookups for the QBG Pipeline pool-selection filter
-- menu (/api/qbg/pipeline/filters). Computed server-side as one SQL function
-- instead of paginating all ~27k public.qbg_question_pool rows into Node —
-- the table is indexed on every column referenced here (see
-- create_qbg_question_pool.sql), so this stays fast as the dataset grows.
--
-- Class level / category / source / question type are independent filter
-- facets (confirmed decision: "two separate dimensions") — only
-- subject -> chapter -> topic -> subtopic is a true cascade.

CREATE OR REPLACE FUNCTION public.qbg_pool_filter_options()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'subjects', (
        SELECT jsonb_agg(DISTINCT subject ORDER BY subject)
        FROM public.qbg_question_pool WHERE subject IS NOT NULL
    ),
    'classLevels', (
        SELECT jsonb_agg(DISTINCT class_level ORDER BY class_level)
        FROM public.qbg_question_pool WHERE class_level IS NOT NULL
    ),
    'categories', (
        SELECT jsonb_agg(DISTINCT category_name ORDER BY category_name)
        FROM public.qbg_question_pool WHERE category_name IS NOT NULL
    ),
    'sources', (
        SELECT jsonb_agg(DISTINCT source ORDER BY source)
        FROM public.qbg_question_pool WHERE source IS NOT NULL
    ),
    'questionTypes', (
        SELECT jsonb_agg(DISTINCT question_type ORDER BY question_type)
        FROM public.qbg_question_pool WHERE question_type IS NOT NULL
    ),
    'chaptersBySubject', (
        SELECT jsonb_object_agg(subject, chapters) FROM (
            SELECT subject, jsonb_agg(DISTINCT chapter ORDER BY chapter) AS chapters
            FROM public.qbg_question_pool
            WHERE subject IS NOT NULL AND chapter IS NOT NULL
            GROUP BY subject
        ) t
    ),
    'chaptersBySubjectClass', (
        SELECT jsonb_object_agg(class_level, by_subject) FROM (
            SELECT class_level, jsonb_object_agg(subject, chapters) AS by_subject FROM (
                SELECT class_level, subject, jsonb_agg(DISTINCT chapter ORDER BY chapter) AS chapters
                FROM public.qbg_question_pool
                WHERE class_level IS NOT NULL AND subject IS NOT NULL AND chapter IS NOT NULL
                GROUP BY class_level, subject
            ) t
            GROUP BY class_level
        ) t2
    ),
    'topicsByChapter', (
        SELECT jsonb_object_agg(chapter, topics) FROM (
            SELECT chapter, jsonb_agg(DISTINCT topic ORDER BY topic) AS topics
            FROM public.qbg_question_pool
            WHERE chapter IS NOT NULL AND topic IS NOT NULL
            GROUP BY chapter
        ) t
    ),
    'subtopicsByTopic', (
        SELECT jsonb_object_agg(topic, subtopics) FROM (
            SELECT topic, jsonb_agg(DISTINCT subtopic ORDER BY subtopic) AS subtopics
            FROM public.qbg_question_pool
            WHERE topic IS NOT NULL AND subtopic IS NOT NULL
            GROUP BY topic
        ) t
    ),
    'batchNames', (
        SELECT jsonb_agg(DISTINCT b ORDER BY b)
        FROM public.qbg_question_pool, unnest(used_in_exam) AS b
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.qbg_pool_filter_options() TO anon, authenticated, service_role;
