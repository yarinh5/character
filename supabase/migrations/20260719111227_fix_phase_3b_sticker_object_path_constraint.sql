-- Keep the canonical sticker object path strict while accepting render.webp.
ALTER TABLE public.stickers
  DROP CONSTRAINT stickers_object_path_check;

ALTER TABLE public.stickers
  ADD CONSTRAINT stickers_object_path_check CHECK (
    object_path ~ '^collections/[0-9a-f-]+/stickers/[0-9a-f-]+/render\.webp$'
  );
