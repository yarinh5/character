CREATE FUNCTION public.admin_list_users_page(
  _search text DEFAULT NULL,
  _role text DEFAULT 'all',
  _status text DEFAULT 'all',
  _before_created_at timestamptz DEFAULT NULL,
  _before_user_id uuid DEFAULT NULL,
  _page_size integer DEFAULT 101
)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  avatar_url text,
  status text,
  created_at timestamptz,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _pattern text;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _role IS NULL OR _role NOT IN ('all', 'admin', 'operator', 'client')
     OR _status IS NULL OR _status NOT IN ('all', 'active', 'blocked') THEN
    RAISE EXCEPTION 'invalid_user_filter';
  END IF;
  IF _search IS NOT NULL AND char_length(btrim(_search)) > 120 THEN
    RAISE EXCEPTION 'invalid_user_search';
  END IF;
  IF (_before_created_at IS NULL) <> (_before_user_id IS NULL)
     OR (_before_created_at IS NOT NULL AND NOT isfinite(_before_created_at)) THEN
    RAISE EXCEPTION 'invalid_user_cursor';
  END IF;
  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 101 THEN
    RAISE EXCEPTION 'invalid_page_size';
  END IF;

  IF _search IS NOT NULL AND btrim(_search) <> '' THEN
    _pattern := '%' || replace(replace(replace(btrim(_search),
      chr(92), chr(92) || chr(92)), '%', chr(92) || '%'),
      '_', chr(92) || '_') || '%';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT profile.user_id, profile.email, profile.display_name,
      profile.avatar_url, profile.status, profile.created_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM public.user_roles AS assigned
        WHERE assigned.user_id = profile.user_id AND assigned.role = 'admin'
      ) THEN 'admin'
      WHEN EXISTS (
        SELECT 1 FROM public.user_roles AS assigned
        WHERE assigned.user_id = profile.user_id AND assigned.role = 'operator'
      ) THEN 'operator'
      WHEN EXISTS (
        SELECT 1 FROM public.user_roles AS assigned
        WHERE assigned.user_id = profile.user_id AND assigned.role = 'client'
      ) THEN 'client'
      ELSE NULL END AS effective_role
    FROM public.profiles AS profile
    WHERE (_status = 'all' OR profile.status = _status)
      AND (_before_created_at IS NULL
           OR (profile.created_at, profile.user_id) < (_before_created_at, _before_user_id))
      AND (_pattern IS NULL OR profile.display_name ILIKE _pattern ESCAPE chr(92)
           OR profile.email ILIKE _pattern ESCAPE chr(92))
  ), page AS MATERIALIZED (
    SELECT * FROM candidates AS candidate
    WHERE _role = 'all' OR candidate.effective_role = _role
    ORDER BY candidate.created_at DESC, candidate.user_id DESC
    LIMIT _page_size
  )
  SELECT page.user_id, page.email, page.display_name, page.avatar_url,
    page.status, page.created_at, page.effective_role
  FROM page
  ORDER BY page.created_at DESC, page.user_id DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_users_page(text,text,text,timestamptz,uuid,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users_page(text,text,text,timestamptz,uuid,integer)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
