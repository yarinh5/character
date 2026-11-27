import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../../migrations/20261125150000_wp11_operator_report_moderation.sql",
    import.meta.url,
  ),
  "utf8",
);
const priorSnapshot = await readFile(
  new URL("../../../migrations/20260926232222_fix_v3_4_archived_client_scope.sql", import.meta.url),
  "utf8",
);
const notifications = await readFile(
  new URL(
    "../../../migrations/20261125151000_wp11_operator_report_notification.sql",
    import.meta.url,
  ),
  "utf8",
);

const update = migration.match(
  /CREATE FUNCTION public\.admin_update_operator_client_report\([\s\S]*?\n\$\$;/,
)?.[0];
const read = migration.match(
  /CREATE FUNCTION public\.get_admin_operator_client_reports\(\)[\s\S]*?\n\$\$;/,
)?.[0];
const snapshot = migration.match(
  /CREATE OR REPLACE FUNCTION public\.get_admin_operations_snapshot\(\)[\s\S]*?\n\$\$;/,
)?.[0];

test("operator reports gain validated moderation state without table grants or RLS changes", () => {
  assert.match(migration, /ADD COLUMN status TEXT NOT NULL DEFAULT 'open'/);
  assert.match(migration, /status IN \('open', 'in_progress', 'decided', 'closed'\)/);
  assert.match(migration, /ADD COLUMN version INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /CHECK \(version > 0\)/);
  assert.match(migration, /ADD COLUMN updated_at TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /UPDATE public\.operator_client_reports\s+SET updated_at = created_at/);
  assert.match(migration, /ADD COLUMN updated_by UUID REFERENCES auth\.users/);
  assert.match(migration, /ADD COLUMN resolved_at TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN resolved_by UUID REFERENCES auth\.users/);
  assert.match(
    migration,
    /resolution_note IS NULL OR char_length\(btrim\(resolution_note\)\) BETWEEN 1 AND 2000/,
  );
  assert.match(
    migration,
    /global_action_note IS NULL OR char_length\(btrim\(global_action_note\)\) BETWEEN 1 AND 2000/,
  );
  assert.match(migration, /status IN \('decided', 'closed'\) AND resolution_note IS NOT NULL/);
  assert.match(
    migration,
    /status IN \('decided', 'closed'\) AND resolution_note IS NOT NULL\s+AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL\)/,
  );
  assert.doesNotMatch(migration, /(?:GRANT|REVOKE)[^;]*ON TABLE public\.operator_client_reports/i);
  assert.doesNotMatch(migration, /(?:DISABLE ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY)/i);
});

test("admin write locks, rejects stale versions, records notes and audit atomically", () => {
  assert.ok(update);
  assert.match(update, /_resolution_note TEXT/);
  assert.match(update, /_note_clean TEXT := NULLIF\(btrim\(_resolution_note\), ''\)/);
  assert.match(update, /_admin_id IS NULL OR public\.is_admin\(\) IS NOT TRUE/);
  assert.match(update, /_status IN \('decided', 'closed'\) AND _note_clean IS NULL/);
  assert.match(update, /char_length\(_note_clean\) > 2000/);
  assert.match(update, /char_length\(_global_action_note_clean\) > 2000/);
  assert.match(update, /WHERE id = _report_id\s+FOR UPDATE/);
  assert.match(update, /_report\.version <> _expected_version[\s\S]*?'expected_version_mismatch'/);
  assert.match(update, /version = _report\.version \+ 1/);
  assert.match(update, /updated_by = _admin_id/);
  assert.match(update, /INSERT INTO public\.audit_logs[\s\S]*?'operator_client_report\.moderated'/);
  assert.match(update, /'resolution_note', _updated\.resolution_note/);
  assert.match(update, /'global_action_note', _updated\.global_action_note/);
  assert.match(
    update,
    /RETURN jsonb_build_object\(\s*'report_id', _updated\.id,\s*'status', _updated\.status,\s*'version', _updated\.version/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.admin_update_operator_client_report\(UUID, INTEGER, TEXT, TEXT, TEXT\) FROM PUBLIC, anon/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.admin_update_operator_client_report\(UUID, INTEGER, TEXT, TEXT, TEXT\) TO authenticated/,
  );
});

test("admin read preserves existing columns and appends moderation fields", () => {
  assert.ok(read);
  assert.match(migration, /DROP FUNCTION public\.get_admin_operator_client_reports\(\);/);
  assert.doesNotMatch(migration, /DROP FUNCTION[^;]*CASCADE/i);
  for (const column of [
    "id UUID",
    "operator_id UUID",
    "operator_name TEXT",
    "client_id UUID",
    "client_display_name TEXT",
    "conversation_id UUID",
    "reason TEXT",
    "notes TEXT",
    "source TEXT",
    "created_at TIMESTAMPTZ",
    "status TEXT",
    "resolution_note TEXT",
    "global_action_note TEXT",
    "version INTEGER",
    "updated_at TIMESTAMPTZ",
    "resolved_at TIMESTAMPTZ",
    "resolved_by UUID",
  ]) {
    assert.ok(read.includes(column), `missing read column ${column}`);
  }
  assert.match(read, /auth\.uid\(\) IS NULL OR public\.is_admin\(\) IS NOT TRUE/);
  assert.match(
    read,
    /report\.status,[\s\S]*?report\.resolution_note,[\s\S]*?report\.global_action_note,[\s\S]*?report\.version/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.get_admin_operator_client_reports\(\) FROM PUBLIC, anon/,
  );
});

test("snapshot counts unresolved operator reports and otherwise retains its contract", () => {
  assert.ok(snapshot);
  assert.match(
    snapshot,
    /FROM public\.operator_client_reports report\s+WHERE report\.status IN \('open', 'in_progress'\)/,
  );
  const oldSnapshot = priorSnapshot.match(
    /CREATE OR REPLACE FUNCTION public\.get_admin_operations_snapshot\(\)[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(oldSnapshot);
  const expected = oldSnapshot
    .replaceAll("\r\n", "\n")
    .replace(
      /\s*-- Operator reports have no moderation lifecycle column; every persisted row is open\.\n\s*\(SELECT COUNT\(\*\)::INTEGER FROM public\.operator_client_reports\) AS open_operator_report_count,/,
      "\n      (SELECT COUNT(*)::INTEGER FROM public.operator_client_reports report\n       WHERE report.status IN ('open', 'in_progress')) AS open_operator_report_count,",
    );
  assert.equal(snapshot.replaceAll("\r\n", "\n"), expected);
});

test("new operator reports notify admins through the existing report channel", () => {
  assert.match(
    notifications,
    /CREATE FUNCTION private\.notify_admin_on_operator_client_report\(\)/,
  );
  assert.match(notifications, /AFTER INSERT ON public\.operator_client_reports/);
  assert.match(notifications, /WHERE role = 'admin'/);
  assert.match(notifications, /public\.create_notification\(/);
  assert.match(notifications, /'new_report'/);
  assert.match(notifications, /'\/admin\/reports'/);
  assert.match(notifications, /'dedupe_key', 'operator-client-report:' \|\| NEW\.id::TEXT/);
  assert.doesNotMatch(notifications, /NEW\.notes|NEW\.reason|NEW\.client_id/);
});
