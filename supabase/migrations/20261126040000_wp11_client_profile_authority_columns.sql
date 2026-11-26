-- Completion, age and image state are written by validated server functions.
REVOKE INSERT, UPDATE ON TABLE public.client_profiles FROM PUBLIC, anon, authenticated;
GRANT UPDATE (
  interests, conversation_preferences, bio, relationship_status, smoking_status,
  first_name, last_name, city_id, preferred_min_age, preferred_max_age,
  preferred_distance_km, content_preferences, character_preferences
) ON TABLE public.client_profiles TO authenticated;
