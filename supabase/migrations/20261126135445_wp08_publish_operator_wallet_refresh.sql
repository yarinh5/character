-- Every supported point write updates its RLS-protected wallet in the same
-- transaction. Publish that refresh signal without the underlying ledger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'operator_point_wallets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.operator_point_wallets;
  END IF;
END $$;
