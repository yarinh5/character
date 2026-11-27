BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(10);

SELECT ok(NOT has_table_privilege('anon', 'public.credit_wallets', 'SELECT'),
  'Anonymous callers cannot read credit wallets directly');
SELECT ok(NOT has_table_privilege('anon', 'public.credit_transactions', 'SELECT'),
  'Anonymous callers cannot read credit transactions directly');
SELECT ok(NOT has_table_privilege('anon', 'public.credit_wallets', 'INSERT, UPDATE, DELETE'),
  'Anonymous callers cannot write credit wallets directly');
SELECT ok(NOT has_table_privilege('anon', 'public.credit_transactions', 'INSERT, UPDATE, DELETE'),
  'Anonymous callers cannot write credit transactions directly');
SELECT ok(has_table_privilege('authenticated', 'public.credit_wallets', 'SELECT'),
  'Authenticated wallet reads retain their table grant');
SELECT ok(has_table_privilege('authenticated', 'public.credit_transactions', 'SELECT'),
  'Authenticated ledger reads retain their table grant');
SELECT ok(has_table_privilege('service_role', 'public.credit_wallets', 'SELECT, INSERT, UPDATE'),
  'Service wallet operations retain their table grants');
SELECT ok(has_table_privilege('service_role', 'public.credit_transactions', 'SELECT, INSERT'),
  'Service ledger operations retain their table grants');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credit_wallets'::regclass),
  'Wallet RLS stays enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credit_transactions'::regclass),
  'Transaction RLS stays enabled');

SELECT * FROM finish();
ROLLBACK;
