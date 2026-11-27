import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../migrations/20261111110000_p05_sla_presence_alerts.sql",
  import.meta.url,
);

async function sql() {
  return readFile(migrationUrl, "utf8");
}

function body(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return source.slice(start, end);
}

test("P05 uses the canonical 420-second wait event continuously, without business-hour exclusions", async () => {
  const source = await sql();
  const emitter = body(source, "CREATE OR REPLACE FUNCTION private.emit_operational_wait_alerts");
  assert.match(source, /'operational_wait_alert_seconds', '420'::jsonb/);
  assert.match(
    emitter,
    /clock_timestamp\(\) - cycle\.pending_since >= make_interval\(secs => _threshold\)/,
  );
  assert.match(emitter, /cycle\.responded_at IS NULL/);
  assert.match(emitter, /cycle\.alerted_at IS NULL/);
  assert.doesNotMatch(emitter, /business|weekend|holiday|extract\s*\(\s*(dow|hour)/i);
});

test("one semantic key protects each recipient and canonical wait event", async () => {
  const source = await sql();
  const emitter = body(source, "CREATE OR REPLACE FUNCTION private.emit_operational_wait_alerts");
  assert.match(
    emitter,
    /private\.operational_wait_event_key\(marked\.conversation_id, marked\.pending_since\)/g,
  );
  assert.match(emitter, /'dedupe_key'/);
  assert.match(emitter, /'wait_event_key'/);
  assert.match(emitter, /ON CONFLICT DO NOTHING/);
  assert.match(emitter, /WHERE role\.role = 'admin'/);
});

test("a successful response resolves active notifications without deleting history or forcing read state", async () => {
  const source = await sql();
  const sync = body(source, "CREATE OR REPLACE FUNCTION private.sync_operational_wait_cycle");
  assert.match(sync, /responded_at = COALESCE\(cycle\.responded_at, _responded_at\)/);
  assert.match(sync, /'\"resolved\"'::JSONB/);
  assert.match(sync, /'\{resolved_at\}'/);
  assert.match(sync, /notification\.metadata ->> 'state' = 'active'/);
  assert.doesNotMatch(sync, /DELETE FROM public\.notifications/i);
  assert.doesNotMatch(sync, /is_read\s*=/i);
});

test("the existing scheduler entry point emits the seven-minute event and not the legacy 15-minute batch", async () => {
  const source = await sql();
  const scheduler = body(
    source,
    "CREATE OR REPLACE FUNCTION private.run_new_sla_critical_scheduler",
  );
  assert.match(scheduler, /private\.emit_operational_wait_alerts\(100\)/);
  assert.doesNotMatch(scheduler, /process_new_sla_critical_notifications/);
  assert.match(scheduler, /pg_try_advisory_xact_lock/);
});

test("character availability requires assignment, active connected operator and the existing heartbeat TTL", async () => {
  const source = await sql();
  const batch = body(source, "CREATE OR REPLACE FUNCTION public.get_character_live_availability");
  const profile = body(source, "CREATE OR REPLACE FUNCTION public.get_character_profile");
  const overview = body(
    source,
    "CREATE OR REPLACE FUNCTION public.get_admin_operator_presence_overview",
  );
  assert.match(batch, /private\.character_live_availability/);
  assert.match(profile, /private\.character_live_availability/);
  assert.match(overview, /operator\.is_active IS NOT TRUE/);
  assert.match(overview, /operator\.presence_status <> 'online'/);
  assert.match(overview, /operator_heartbeat_stale_minutes/);
  assert.match(overview, /operator\.last_seen_at < clock_timestamp\(\) - make_interval/);
});

test("public boundaries preserve authentication and admin/service-role authorization", async () => {
  const source = await sql();
  const publicEmitter = body(
    source,
    "CREATE OR REPLACE FUNCTION public.emit_operational_wait_alerts",
  );
  const batch = body(source, "CREATE OR REPLACE FUNCTION public.get_character_live_availability");
  assert.match(publicEmitter, /auth\.role\(\) <> 'service_role' AND NOT public\.is_admin\(\)/);
  assert.match(batch, /auth\.uid\(\)/);
  assert.match(source, /REVOKE ALL ON FUNCTION private\.emit_operational_wait_alerts/);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION public\.get_character_live_availability\(UUID\[\]\) TO authenticated/,
  );
});
