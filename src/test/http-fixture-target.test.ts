import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedLocalFixtureDbContainer } from "../../supabase/tests/http/v4_3_http_fixtures";

const id = "a".repeat(64);
const project = "isolated-http-fixture";
const engine = "11111111-2222-4333-8444-555555555555";
const inspect = (label = project, name = project) =>
  JSON.stringify([
    {
      Id: id,
      Name: `/supabase_db_${name}`,
      Config: { Labels: { "com.supabase.cli.project": label } },
      State: { Running: true },
    },
  ]);

describe("local HTTP fixture DB target", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_LOCAL_DB_CONTAINER", id);
    vi.stubEnv("PRODUCT_TEST_PROJECT_ID", project);
    vi.stubEnv("PRODUCT_TEST_ENGINE_ID", engine);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses only the admitted container ID after the Engine and label match", () => {
    const command = vi.fn().mockReturnValueOnce(`${engine}\n`).mockReturnValueOnce(inspect());

    expect(verifiedLocalFixtureDbContainer(command)).toBe(id);
    expect(command.mock.calls.map(([args]) => args)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["inspect", id],
    ]);
  });

  it("blocks partial and QA pins without querying Docker", () => {
    const command = vi.fn();
    vi.stubEnv("PRODUCT_TEST_ENGINE_ID", undefined);
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/paired non-QA/);
    vi.stubEnv("PRODUCT_TEST_ENGINE_ID", engine);
    vi.stubEnv("PRODUCT_TEST_PROJECT_ID", "qmgkmsarzfjnqltljkjl");
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/paired non-QA/);
    expect(command).not.toHaveBeenCalled();
  });

  it("blocks a changed Engine or a container belonging to QA", () => {
    const command = vi.fn();
    command.mockReturnValueOnce("22222222-2222-4333-8444-555555555555\n");
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/Engine identity changed/);
    expect(command).toHaveBeenCalledTimes(1);

    command.mockReset();
    command
      .mockReturnValueOnce(`${engine}\n`)
      .mockReturnValueOnce(inspect("qmgkmsarzfjnqltljkjl", "qmgkmsarzfjnqltljkjl"));
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/does not match/);
    expect(command.mock.calls.map(([args]) => args)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["inspect", id],
    ]);
  });

  it("blocks missing or malformed runner-selected DB identity", () => {
    const command = vi.fn();
    vi.stubEnv("SUPABASE_LOCAL_DB_CONTAINER", undefined);
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/identity is missing/);
    vi.stubEnv("SUPABASE_LOCAL_DB_CONTAINER", "supabase_db_qmgkmsarzfjnqltljkjl");
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/identity is missing/);
    expect(command).not.toHaveBeenCalled();
  });

  it("does not infer QA when no runner supplied a project", () => {
    const command = vi.fn();
    vi.stubEnv("PRODUCT_TEST_PROJECT_ID", undefined);
    vi.stubEnv("PRODUCT_TEST_ENGINE_ID", undefined);
    vi.stubEnv("PRODUCT_PROJECT_ID", undefined);
    vi.stubEnv("SUPABASE_LOCAL_PROJECT_ID", undefined);
    expect(() => verifiedLocalFixtureDbContainer(command)).toThrow(/identity is missing/);
    expect(command).not.toHaveBeenCalled();
  });
});
