import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(
  process.cwd(),
  "supabase/tests/database/v4_3/wp04_profile_discovery_leads.test.sql",
);

const readFixture = () => readFileSync(fixturePath, "utf8");

const extractStatement = (sql: string, start: RegExp) => {
  const match = start.exec(sql);
  expect(match, `missing statement matching ${start}`).not.toBeNull();
  const end = sql.indexOf(";", match!.index);
  expect(end, `unterminated statement matching ${start}`).toBeGreaterThan(match!.index);
  return sql.slice(match!.index, end + 1);
};

describe("WP04 discovery fixture provisioning contract", () => {
  it("reuses trigger-owned rows instead of inserting the three duplicate record types", () => {
    const sql = readFixture();

    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.profiles\b/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.client_profiles\b/i);

    const roleInsert = extractStatement(
      sql,
      /INSERT\s+INTO\s+public\.user_roles\s*\(user_id,\s*role\)\s*VALUES/i,
    );
    expect(roleInsert).not.toContain("'client'");
    expect(roleInsert.match(/'operator'/g)).toHaveLength(2);
  });

  it("updates the three trigger-created profiles and the exact client profile", () => {
    const sql = readFixture();
    const profileUpdate = extractStatement(sql, /UPDATE\s+public\.profiles\b/i);
    const clientProfileUpdate = extractStatement(sql, /UPDATE\s+public\.client_profiles\b/i);

    expect(profileUpdate).toContain("00000000-0000-4000-8000-000000040001");
    expect(profileUpdate).toContain("00000000-0000-4000-8000-000000040002");
    expect(profileUpdate).toContain("00000000-0000-4000-8000-000000040003");
    expect(profileUpdate).toContain("WP04 client");
    expect(profileUpdate).toContain("WP04 operator");
    expect(profileUpdate).toContain("WP04 other operator");

    expect(clientProfileUpdate).toContain("00000000-0000-4000-8000-000000040001");
    expect(clientProfileUpdate).toContain("00000000-0000-4000-8000-000000040101");
    expect(clientProfileUpdate).toMatch(/\bage\s*=\s*30\b/i);
    expect(clientProfileUpdate).toMatch(/\binterests\s*=\s*ARRAY\['music'\]/i);
  });

  it("contains pgTAP checks that expose zero-row updates and exact role arrays", () => {
    const sql = readFixture();

    expect(sql).toContain("The Auth trigger created and the fixture labeled all three profiles");
    expect(sql).toContain("The fixture populated the trigger-created client profile");
    expect(sql).toContain("The client has exactly the default client role");
    expect(sql).toContain("The assigned operator has exactly client and operator roles");
    expect(sql).toContain("The other operator has exactly client and operator roles");
    expect(sql).toContain("Discovery resolves a character without an ambiguous return-column reference");
  });
});
