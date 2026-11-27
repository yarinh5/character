import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationUrl = new URL(
  "../../../migrations/20261111180000_p06_support_incidents.sql",
  import.meta.url,
);
const sql = readFileSync(migrationUrl, "utf8");
const clientUi = readFileSync(
  new URL("../../../../src/routes/app.support.tsx", import.meta.url),
  "utf8",
);
const adminUi = readFileSync(
  new URL("../../../../src/routes/admin.support.tsx", import.meta.url),
  "utf8",
);
const adminSettings = readFileSync(
  new URL("../../../../src/routes/admin.settings.tsx", import.meta.url),
  "utf8",
);
const pgTap = readFileSync(new URL("./p06_support_incidents.test.sql", import.meta.url), "utf8");

const required = [
  "CREATE TABLE public.support_tickets",
  "CREATE TABLE public.support_ticket_messages",
  "CREATE TABLE public.support_incidents",
  "CREATE TABLE public.support_incident_tickets",
  "CREATE FUNCTION public.create_support_ticket",
  "CREATE FUNCTION public.add_support_ticket_message",
  "CREATE FUNCTION public.admin_update_support_ticket",
  "CREATE FUNCTION public.admin_add_support_ticket_message",
  "CREATE FUNCTION public.admin_create_support_incident",
  "CREATE FUNCTION public.admin_update_support_incident",
  "CREATE FUNCTION public.admin_set_support_operations_config",
  "expected_version_mismatch",
  "pending_configuration",
  "pending_delivery",
];

for (const contract of required) {
  assert.ok(sql.includes(contract), `missing P06 support contract: ${contract}`);
}

assert.match(
  sql,
  /UNIQUE\s*\(client_id,\s*idempotency_key\)/i,
  "ticket creation must be idempotent per client",
);
assert.match(
  sql,
  /UNIQUE\s*\(ticket_id,\s*author_user_id,\s*idempotency_key\)/i,
  "ticket messages must be idempotent per author and ticket",
);
assert.match(sql, /visibility\s*=\s*'client'/i, "client reads must exclude internal notes");
assert.match(
  sql,
  /auth\.uid\(\)\s*=\s*ticket\.client_id/i,
  "client access must be constrained to ticket ownership",
);
assert.match(
  sql,
  /INSERT INTO public\.audit_logs/i,
  "admin assignment, status and incident changes must be audited",
);
assert.match(
  sql,
  /public\.create_notification/i,
  "the existing notification mechanism must be used",
);
assert.match(
  sql,
  /REVOKE ALL ON (TABLE|FUNCTION)[\s\S]*FROM anon/i,
  "anonymous access must be revoked",
);
assert.doesNotMatch(
  sql,
  /GRANT[^;]+TO\s+operator/i,
  "operators must not receive support or incident access",
);

assert.match(clientUi, /create_support_ticket/, "client UI uses the authoritative create RPC");
assert.match(clientUi, /support_ticket_messages/, "client UI reads only RLS-filtered messages");
assert.match(clientUi, /isPending/, "client UI prevents duplicate submit while a write is pending");
assert.match(
  clientUi,
  /support_ticket_not_verified/,
  "client UI refuses false success without a saved ticket id",
);
assert.match(adminUi, /admin_update_support_ticket/, "admin UI uses the versioned update RPC");
assert.match(
  adminUi,
  /_expected_version:\s*selected\.version/,
  "admin UI sends its observed version",
);
assert.match(adminUi, /visibility:\s*"internal"/, "admin UI has a separate internal-note path");
assert.match(
  adminUi,
  /admin_create_support_incident/,
  "admin UI opens incidents through the server boundary",
);
assert.match(
  adminSettings,
  /admin_set_support_operations_config/,
  "operations configuration is saved through an audited RPC",
);
assert.match(
  adminSettings,
  /הגדרה אינה הוכחת מסירה/,
  "configuration UI does not claim external delivery",
);
assert.doesNotMatch(
  sql,
  /support_(ticket|incident)[^;]*(retention|delete_after)/i,
  "P06 must not invent a support-ticket retention period",
);
assert.match(
  pgTap,
  /has_function\('public',\s*'admin_update_support_ticket',\s*ARRAY\['uuid','integer','text','uuid'\]/,
  "the written live regression must target the deployed optimistic-update signature",
);

console.log("P06 support and incident migration contract: PASS");
