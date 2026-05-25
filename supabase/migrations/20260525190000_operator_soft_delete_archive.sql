ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_operators_deleted_at
  ON public.operators(deleted_at)
  WHERE deleted_at IS NOT NULL;
