-- Keep private helpers callable only through their database dependencies.
REVOKE ALL ON FUNCTION private.setting_text(text, text)
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION private.touch_character_media_asset_updated_at()
FROM PUBLIC, anon, authenticated, service_role;
