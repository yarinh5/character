import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../../migrations/20261125153000_wp11_admin_completion_exception_cases.sql",
    import.meta.url,
  ),
  "utf8",
);
const types = await readFile(
  new URL("../../../../src/integrations/supabase/types.ts", import.meta.url),
  "utf8",
);

test("all aggregate exception sources have a bounded case branch", () => {
  const branches = [
    ["allocation", "private.handling_reconciliation_issues", "unresolved"],
    ["gift_failed", "private.gift_reward_events", "failed"],
    ["gift_unallocated", "private.gift_reward_events", "distributed"],
    ["media_cleanup", "public.client_media_uploads", "cleanup_failed"],
    ["account_deletion_blocked", "public.account_deletion_requests", "blocked_retention"],
    ["account_deletion_failed", "public.account_deletion_requests", "failed"],
    ["conversation_deletion_blocked", "public.conversation_deletion_requests", "blocked_retention"],
    ["conversation_deletion_failed", "public.conversation_deletion_requests", "failed"],
  ];
  for (const [kind, source, status] of branches) {
    assert.match(
      migration,
      new RegExp(
        `SELECT '${kind}'::TEXT[\\s\\S]*?FROM ${source.replaceAll(".", "\\.")}[\\s\\S]*?WHERE [^;]*?\\.status = '${status}'`,
      ),
    );
  }
  assert.match(migration, /event\.unallocated_points > 0/);
  assert.match(
    migration,
    /JOIN public\.gift_attachment_purchases purchase ON purchase\.id = event\.purchase_id/g,
  );
});

test("the case boundary is admin-only, keyset-ordered, and typed narrowly", () => {
  assert.match(migration, /IF auth\.uid\(\) IS NULL OR public\.is_admin\(\) IS NOT TRUE THEN/);
  assert.ok(migration.indexOf("admin_required") < migration.indexOf("invalid_exception_kind"));
  assert.match(
    migration,
    /num_nonnulls\(_before_occurred_at, _before_kind, _before_id\) NOT IN \(0, 3\)/,
  );
  assert.match(migration, /_page_size < 1 OR _page_size > 101/);
  assert.match(migration, /\(cases\.occurred_at, cases\.kind, cases\.id\) </);
  assert.match(
    migration,
    /ORDER BY cases\.occurred_at DESC, cases\.kind DESC, cases\.id DESC\s+LIMIT _page_size/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.get_admin_completion_exception_cases[\s\S]*?FROM PUBLIC, anon/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.get_admin_completion_exception_cases[\s\S]*?TO authenticated/,
  );
  assert.match(
    migration,
    /RETURNS TABLE \(\s*kind TEXT,\s*id UUID,\s*occurred_at TIMESTAMPTZ,\s*code TEXT,\s*subject_id UUID\s*\)/,
  );
  assert.match(
    types,
    /get_admin_completion_exception_cases: \{[\s\S]*?_before_occurred_at\?: string \| null;[\s\S]*?subject_id: string;/,
  );
});
