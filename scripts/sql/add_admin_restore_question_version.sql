-- Admin-only function: restore the editable fields of qbg_questions to a prior snapshot.
-- Status, created_by are preserved (the QC workflow shouldn't be undone by a restore);
-- last_modified_by / last_modified_at are stamped to the current user / now.
-- The snapshot trigger picks up the GUC and writes the resulting history row with
-- change_type='restore'.

CREATE OR REPLACE FUNCTION public.admin_restore_question_version(
    p_history_id uuid,
    p_note       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_caller_role public.user_role;
    v_uid         uuid := auth.uid();
    v_snapshot    jsonb;
    v_question_id uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
    END IF;

    SELECT role INTO v_caller_role FROM public.user_profiles WHERE user_id = v_uid;
    IF v_caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only admins can restore prior versions.' USING ERRCODE = '42501';
    END IF;

    SELECT snapshot, question_id INTO v_snapshot, v_question_id
    FROM public.question_edit_history
    WHERE id = p_history_id;

    IF v_snapshot IS NULL THEN
        RAISE EXCEPTION 'History entry not found.' USING ERRCODE = '02000';
    END IF;

    PERFORM set_config('app.snapshot_change_type', 'restore', true);

    UPDATE public.qbg_questions SET
        question_text      = COALESCE(v_snapshot->>'question_text', question_text),
        options            = COALESCE(v_snapshot->'options', options),
        answer_key         = COALESCE(v_snapshot->'answer_key', answer_key),
        solution_text      = COALESCE(v_snapshot->>'solution_text', solution_text),
        question_type      = COALESCE(v_snapshot->>'question_type', question_type),
        subject            = COALESCE(v_snapshot->>'subject', subject),
        chapter            = COALESCE(v_snapshot->>'chapter', chapter),
        topic              = COALESCE(v_snapshot->>'topic', topic),
        subtopic           = v_snapshot->>'subtopic',
        source             = COALESCE(v_snapshot->>'source', source),
        difficutly_level   = COALESCE(v_snapshot->>'difficutly_level', difficutly_level),
        class_level        = v_snapshot->>'class_level',
        exam               = CASE
                                WHEN v_snapshot ? 'exam' AND jsonb_typeof(v_snapshot->'exam') = 'array'
                                THEN ARRAY(SELECT jsonb_array_elements_text(v_snapshot->'exam'))
                                ELSE exam
                             END,
        parent_question_id = CASE
                                WHEN v_snapshot->>'parent_question_id' IS NULL THEN NULL
                                ELSE (v_snapshot->>'parent_question_id')::uuid
                             END,
        raw_data           = v_snapshot->'raw_data',
        last_modified_by   = v_uid,
        last_modified_at   = now()
    WHERE question_id = v_question_id;

    IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
        UPDATE public.question_edit_history
        SET changed_fields = COALESCE(changed_fields, ARRAY[]::text[]) || ARRAY['__restore_note__:' || p_note]
        WHERE question_id = v_question_id
          AND created_at = (SELECT max(created_at) FROM public.question_edit_history WHERE question_id = v_question_id);
    END IF;

    RETURN v_question_id;
END $$;

REVOKE ALL ON FUNCTION public.admin_restore_question_version(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_restore_question_version(uuid, text) TO authenticated;
