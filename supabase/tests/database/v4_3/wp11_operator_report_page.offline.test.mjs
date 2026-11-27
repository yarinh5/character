import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prior = await readFile(
  new URL(
    "../../../migrations/20261125150000_wp11_operator_report_moderation.sql",
    import.meta.url,
  ),
  "utf8",
);
const migration = await readFile(
  new URL(
    "../../../migrations/20261125152000_wp11_operator_report_history_page.sql",
    import.meta.url,
  ),
  "utf8",
);
const types = await readFile(
  new URL("../../../../src/integrations/supabase/types.ts", import.meta.url),
  "utf8",
);

const oldColumns = prior.match(
  /CREATE FUNCTION public\.get_admin_operator_client_reports\(\)\s+RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/,
)?.[1];
const page = migration.match(
  /CREATE FUNCTION public\.get_admin_operator_client_reports_page\([\s\S]*?\n\$\$;/,
)?.[0];

test("paged report RPC retains the old row contract and fail-closed access", () => {
  assert.ok(oldColumns);
  assert.ok(page);
  assert.equal(
    page
      .match(/RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/)?.[1]
      .replace(/\s+/g, " ")
      .trim(),
    oldColumns.replace(/\s+/g, " ").trim(),
  );
  assert.match(page, /SECURITY DEFINER\s+SET search_path = public, private, pg_temp/);
  assert.match(page, /auth\.uid\(\) IS NULL OR public\.is_admin\(\) IS NOT TRUE/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.get_admin_operator_client_reports_page\(TIMESTAMPTZ, UUID, INTEGER\) FROM PUBLIC, anon/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.get_admin_operator_client_reports_page\(TIMESTAMPTZ, UUID, INTEGER\) TO authenticated/,
  );
  assert.doesNotMatch(migration, /DROP FUNCTION public\.get_admin_operator_client_reports\(\)/);
});

test("paged report RPC validates cursor and size before bounded keyset read", () => {
  assert.ok(page);
  assert.match(page, /_before_created_at TIMESTAMPTZ DEFAULT NULL/);
  assert.match(page, /_before_id UUID DEFAULT NULL/);
  assert.match(page, /_page_size INTEGER DEFAULT 101/);
  assert.match(page, /\(_before_created_at IS NULL\) <> \(_before_id IS NULL\)/);
  assert.match(page, /_page_size IS NULL OR _page_size < 1 OR _page_size > 101/);
  assert.match(page, /\(report\.created_at, report\.id\) < \(_before_created_at, _before_id\)/);
  assert.match(page, /ORDER BY report\.created_at DESC, report\.id DESC\s+LIMIT _page_size/);
});

test("generated RPC typing exposes optional cursor and size with the same rows", () => {
  const oldType = types.match(
    /get_admin_operator_client_reports: \{\s+Args: never;\s+Returns: (\{[\s\S]*?\}\[\]);\s+\};/,
  )?.[1];
  const pageType = types.match(
    /get_admin_operator_client_reports_page: \{\s+Args: (\{[\s\S]*?\});\s+Returns: (\{[\s\S]*?\}\[\]);\s+\};/,
  );
  assert.ok(oldType);
  assert.ok(pageType);
  assert.match(pageType[1], /_before_created_at\?: string \| null/);
  assert.match(pageType[1], /_before_id\?: string \| null/);
  assert.match(pageType[1], /_page_size\?: number/);
  assert.equal(pageType[2], oldType);
});
