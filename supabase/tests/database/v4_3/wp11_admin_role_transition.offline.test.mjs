import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const before = await readFile(
  new URL("../../../migrations/20261126003000_wp11_admin_role_transition.sql", import.meta.url),
  "utf8",
);
const after = await readFile(
  new URL(
    "../../../migrations/20261126010000_wp11_role_transition_archive_guard.sql",
    import.meta.url,
  ),
  "utf8",
);
const pgTap = await readFile(
  new URL("wp11_admin_role_transition.test.sql", import.meta.url),
  "utf8",
);

test("archival checks precede role mutation while the established write path is preserved", () => {
  const mutation = "  DELETE FROM public.user_roles WHERE user_id = _user_id;";
  const originalWrites = before.slice(before.indexOf(mutation), before.indexOf("  RETURN true;"));
  const guardedWrites = after.slice(after.indexOf(mutation), after.indexOf("  RETURN true;"));
  assert.ok(originalWrites.length > 0);
  assert.equal(guardedWrites, originalWrites);
  assert.ok(after.indexOf("archived_profile_role_change_forbidden") < after.indexOf(mutation));
  assert.ok(after.indexOf("archived_operator_role_change_forbidden") < after.indexOf(mutation));
  assert.match(after, /FROM public\.operators AS op\s+WHERE op\.user_id = _user_id\s+FOR UPDATE/);
  assert.match(pgTap, /Archived operator cannot be reactivated through role assignment/);
  assert.match(pgTap, /Archived profile cannot receive a new role/);
});
