ALTER TABLE public.stickers
  DROP CONSTRAINT IF EXISTS stickers_source_path_check;

ALTER TABLE public.stickers
  ADD CONSTRAINT stickers_source_path_check
  CHECK (
    source_path IS NULL
    OR source_path ~ '^collections/[0-9a-f-]+/stickers/[0-9a-f-]+/source\.webp$'
  );

NOTIFY pgrst, 'reload schema';
