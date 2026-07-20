-- Keep source uploads private while allowing normal phone and desktop images.
UPDATE storage.buckets
SET file_size_limit = 10485760
WHERE id = 'sticker-media';
