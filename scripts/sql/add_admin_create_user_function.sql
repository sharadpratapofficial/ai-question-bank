-- Admin-only function to create a new auth user + assign a role.
-- SECURITY DEFINER so the function can write to the auth schema; the body
-- enforces the admin check itself by reading public.user_profiles for auth.uid().
--
-- Called from /api/admin/users POST via the cookie-aware Supabase client.

CREATE OR REPLACE FUNCTION public.admin_create_user_with_role(
    p_email        text,
    p_password     text,
    p_role         public.user_role,
    p_display_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_caller_role public.user_role;
    v_new_user_id uuid := gen_random_uuid();
    v_instance_id uuid := '00000000-0000-0000-0000-000000000000';
    v_now timestamptz := now();
    v_hashed_pw text;
BEGIN
    -- 1. Caller MUST be admin. auth.uid() returns the JWT user id of the caller.
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
    END IF;

    SELECT role INTO v_caller_role
    FROM public.user_profiles
    WHERE user_id = auth.uid();

    IF v_caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only admins can create users.' USING ERRCODE = '42501';
    END IF;

    -- 2. Basic validation.
    IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
        RAISE EXCEPTION 'Email is required.' USING ERRCODE = '22023';
    END IF;
    IF p_password IS NULL OR length(p_password) < 8 THEN
        RAISE EXCEPTION 'Password must be at least 8 characters.' USING ERRCODE = '22023';
    END IF;

    -- 3. Duplicate email check.
    IF EXISTS (SELECT 1 FROM auth.users WHERE email = lower(trim(p_email))) THEN
        RAISE EXCEPTION 'A user with that email already exists.' USING ERRCODE = '23505';
    END IF;

    v_hashed_pw := extensions.crypt(p_password, extensions.gen_salt('bf'));

    -- 4. Insert into auth.users.
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
        v_instance_id,
        v_new_user_id,
        'authenticated',
        'authenticated',
        lower(trim(p_email)),
        v_hashed_pw,
        v_now,
        v_now,
        v_now,
        '{"provider":"email","providers":["email"]}'::jsonb,
        CASE WHEN p_display_name IS NOT NULL
             THEN jsonb_build_object('full_name', p_display_name)
             ELSE '{}'::jsonb
        END,
        '', '', '', ''
    );

    -- 5. Insert identity row so email/password login works.
    INSERT INTO auth.identities (
        id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at, provider_id
    ) VALUES (
        v_new_user_id,
        v_new_user_id,
        'email',
        jsonb_build_object('sub', v_new_user_id::text, 'email', lower(trim(p_email))),
        v_now, v_now, v_now,
        lower(trim(p_email))
    );

    -- 6. The auth.users INSERT trigger auto-creates a 'viewer' row in
    -- public.user_profiles. Promote it to the desired role + set display_name.
    UPDATE public.user_profiles
    SET role = p_role,
        display_name = p_display_name,
        updated_at = v_now
    WHERE user_id = v_new_user_id;

    RETURN v_new_user_id;
END;
$$;

-- Lock down: only authenticated users can attempt to call it; admin check inside is the real gate.
REVOKE ALL ON FUNCTION public.admin_create_user_with_role(text, text, public.user_role, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_user_with_role(text, text, public.user_role, text) TO authenticated;
