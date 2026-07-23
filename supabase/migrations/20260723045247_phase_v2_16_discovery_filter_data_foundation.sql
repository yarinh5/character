INSERT INTO public.discovery_cities (slug, display_name_he, is_active)
VALUES
  ('tel-aviv', 'תל אביב-יפו', TRUE),
  ('jerusalem', 'ירושלים', TRUE),
  ('haifa', 'חיפה', TRUE),
  ('beer-sheva', 'באר שבע', TRUE)
ON CONFLICT (slug) DO UPDATE
SET display_name_he = EXCLUDED.display_name_he,
    is_active = TRUE;

NOTIFY pgrst, 'reload schema';
