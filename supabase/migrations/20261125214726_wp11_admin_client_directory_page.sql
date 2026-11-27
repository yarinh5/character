-- WP11: one bounded, fully enriched admin client directory page.
CREATE FUNCTION public.admin_list_clients_page(
  _include_archived boolean DEFAULT false,
  _search text DEFAULT NULL,
  _status text DEFAULT 'all',
  _created_from timestamptz DEFAULT NULL,
  _created_before timestamptz DEFAULT NULL,
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
  deleted_at timestamptz,
  pii_archived_at timestamptz,
  credits_balance integer,
  conversations_count bigint,
  active_conversations_count bigint,
  last_message_at timestamptz
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
  IF _include_archived IS NULL OR _status IS NULL
     OR _status NOT IN ('all', 'active', 'inactive') THEN
    RAISE EXCEPTION 'invalid_client_filter';
  END IF;
  IF _search IS NOT NULL AND char_length(btrim(_search)) > 120 THEN
    RAISE EXCEPTION 'invalid_client_search';
  END IF;
  IF (_created_from IS NOT NULL AND NOT isfinite(_created_from))
     OR (_created_before IS NOT NULL AND NOT isfinite(_created_before))
     OR (_created_from IS NOT NULL AND _created_before IS NOT NULL
         AND _created_from >= _created_before) THEN
    RAISE EXCEPTION 'invalid_client_date_range';
  END IF;
  IF (_before_created_at IS NULL) <> (_before_user_id IS NULL)
     OR (_before_created_at IS NOT NULL AND NOT isfinite(_before_created_at)) THEN
    RAISE EXCEPTION 'invalid_client_cursor';
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
  WITH page AS MATERIALIZED (
    SELECT profile.user_id, profile.email, profile.display_name,
      profile.avatar_url, profile.status, profile.created_at,
      profile.deleted_at, profile.pii_archived_at
    FROM public.profiles AS profile
    WHERE ((_include_archived AND profile.deleted_at IS NOT NULL)
           OR (NOT _include_archived AND profile.deleted_at IS NULL))
      AND (_status = 'all'
           OR (_status = 'active' AND profile.deleted_at IS NULL AND profile.status = 'active')
           OR (_status = 'inactive' AND profile.deleted_at IS NULL AND profile.status = 'blocked'))
      AND (_created_from IS NULL OR profile.created_at >= _created_from)
      AND (_created_before IS NULL OR profile.created_at < _created_before)
      AND (_before_created_at IS NULL
           OR (profile.created_at, profile.user_id) < (_before_created_at, _before_user_id))
      AND (_pattern IS NULL OR profile.display_name ILIKE _pattern ESCAPE chr(92)
           OR profile.email ILIKE _pattern ESCAPE chr(92))
      AND (EXISTS (
        SELECT 1 FROM public.user_roles AS client_role
        WHERE client_role.user_id = profile.user_id AND client_role.role = 'client'
      ) OR EXISTS (
        SELECT 1 FROM public.client_profiles AS client_profile
        WHERE client_profile.user_id = profile.user_id
      ))
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles AS elevated_role
        WHERE elevated_role.user_id = profile.user_id
          AND elevated_role.role IN ('operator', 'admin')
      )
    ORDER BY profile.created_at DESC, profile.user_id DESC
    LIMIT _page_size
  )
  SELECT page.user_id, page.email, page.display_name, page.avatar_url,
    CASE WHEN page.deleted_at IS NOT NULL THEN 'archived' ELSE page.status END,
    page.created_at, page.deleted_at, page.pii_archived_at,
    wallet.balance, activity.conversations_count,
    activity.active_conversations_count, activity.last_message_at
  FROM page
  LEFT JOIN public.credit_wallets AS wallet ON wallet.user_id = page.user_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS conversations_count,
      count(*) FILTER (WHERE conversation.status <> 'closed') AS active_conversations_count,
      max(conversation.last_message_at) AS last_message_at
    FROM public.conversations AS conversation
    WHERE conversation.client_id = page.user_id
  ) AS activity
  ORDER BY page.created_at DESC, page.user_id DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_clients_page(
  boolean, text, text, timestamptz, timestamptz, timestamptz, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_clients_page(
  boolean, text, text, timestamptz, timestamptz, timestamptz, uuid, integer
) TO authenticated;

NOTIFY pgrst, 'reload schema';
