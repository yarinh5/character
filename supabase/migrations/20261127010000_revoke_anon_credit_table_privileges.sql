-- Financial tables are never read or written by anonymous product flows.
-- RLS remains enabled for authenticated callers; remove the broad anon table
-- grants so anonymous requests cannot enter their financial policy paths.
REVOKE ALL PRIVILEGES ON TABLE
  public.credit_wallets,
  public.credit_transactions
FROM anon;
