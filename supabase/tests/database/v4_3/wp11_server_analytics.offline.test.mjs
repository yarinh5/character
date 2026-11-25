import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const initialMigrationUrl = new URL(
  "../../../migrations/20261117130000_wp11_server_analytics.sql",
  import.meta.url,
);
const correctionMigrationUrl = new URL(
  "../../../migrations/20261117140000_wp11_canonical_date_range.sql",
  import.meta.url,
);
const pgTapUrl = new URL("./wp11_server_analytics.test.sql", import.meta.url);
const analyticsUrl = new URL("../../../../src/lib/analytics.functions.ts", import.meta.url);
const routeUrl = new URL("../../../../src/routes/admin.analytics.tsx", import.meta.url);

test("advanced analytics is aggregated completely by the database boundary", () => {
  assert.equal(
    existsSync(initialMigrationUrl),
    true,
    "the forward-only analytics migration must exist",
  );
  const sql = readFileSync(initialMigrationUrl, "utf8");

  assert.match(
    sql,
    /FUNCTION public\.get_admin_advanced_analytics_for_server\(\s*_start_date date,\s*_end_date date\s*\)/i,
  );
  assert.match(sql, /generate_series\([\s\S]*_start_date[\s\S]*_end_date/i);
  assert.match(sql, /COUNT\(\*\)[\s\S]*public\.profiles/i);
  assert.match(sql, /COUNT\(\*\)[\s\S]*public\.conversations/i);
  assert.match(sql, /COUNT\(\*\)[\s\S]*public\.messages/i);
  assert.match(sql, /SUM\([\s\S]*public\.credit_transactions/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
});

test("the forward correction enforces at most 180 inclusive UTC calendar days", () => {
  assert.equal(existsSync(correctionMigrationUrl), true, "the forward correction must exist");
  const sql = readFileSync(correctionMigrationUrl, "utf8");

  assert.match(sql, /\(_end_date\s*-\s*_start_date\)\s*>=\s*180/i);
  assert.match(sql, /AT TIME ZONE 'UTC'/i);
  assert.match(sql, /\(_end_date\s*\+\s*1\)::timestamp\s+AT TIME ZONE 'UTC'/i);
  assert.match(sql, /generate_series\(_start_date,\s*_end_date,\s*interval '1 day'\)/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
});

test("the live acceptance fixture covers aggregation values, UTC boundaries, and more than 10000 rows", () => {
  assert.equal(existsSync(pgTapUrl), true, "the dedicated pgTAP acceptance file must exist");
  const sql = readFileSync(pgTapUrl, "utf8");

  assert.match(sql, /generate_series\(1,\s*10001\)/i);
  assert.match(sql, /creditsBurn/i);
  assert.match(sql, /topCharacters/i);
  assert.match(sql, /topOperators/i);
  assert.match(sql, /packagesViewed/i);
  assert.match(sql, /function_privs_are/i);
  assert.match(sql, /SET LOCAL TIME ZONE/i);
  assert.match(sql, /INSERT INTO auth\.users/i);
  assert.match(sql, /UPDATE public\.profiles/i);
  assert.match(sql, /INSERT INTO public\.user_roles[\s\S]*'operator'/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.profiles/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.client_profiles/i);
  assert.match(sql, /SELECT \* FROM finish\(\)/i);
  assert.doesNotMatch(sql, /DISABLE TRIGGER/i);
  assert.doesNotMatch(sql, /ON CONFLICT DO NOTHING/i);
});

test("the server function consumes the aggregate RPC without row caps", () => {
  const source = readFileSync(analyticsUrl, "utf8");
  const start = source.indexOf("export const adminAdvancedAnalytics");
  assert.notEqual(start, -1);
  const body = source.slice(start);

  assert.match(body, /\.rpc\(\s*"get_admin_advanced_analytics_for_server"/);
  assert.doesNotMatch(body, /\.limit\(10000\)/);
  assert.match(body, /AdminAdvancedAnalyticsSchema\.parse/);
});

test("the UI no longer describes a known truncation", () => {
  const route = readFileSync(routeUrl, "utf8");
  assert.doesNotMatch(route, /עד 10,000 רשומות לכל מקור/);
  assert.match(route, /אגרגציה מלאה בצד השרת/);
});
