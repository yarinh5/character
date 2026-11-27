import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github", "workflows", "client-media-cleanup.yml");
const validatorPath = join(process.cwd(), "scripts", "validate-client-media-cleanup-result.mjs");

function validateResult(body: string) {
  return spawnSync(process.execPath, [validatorPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: body,
    windowsHide: true,
  });
}

describe("client media cleanup schedule contract", () => {
  it("keeps scheduled cleanup disabled unless the repository gate is explicitly enabled", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain(
      "github.event_name == 'schedule' && vars.CLIENT_MEDIA_CLEANUP_SCHEDULE_ENABLED == 'true'",
    );
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.event.inputs.execute_cleanup == 'true'");
    expect(workflow).toMatch(/execute_cleanup:[\s\S]*?default:\s*false/);
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("uses repository-managed credentials and validates the bounded response without logging it", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("secrets.SUPABASE_URL");
    expect(workflow).toContain("secrets.SUPABASE_SERVICE_ROLE_KEY");
    expect(workflow).toContain("/functions/v1/cleanup-client-media");
    expect(workflow).toContain('"limit":25');
    expect(workflow).toContain("validate-client-media-cleanup-result.mjs");
    expect(workflow).toContain('--output "$response_file"');
    expect(workflow).toContain('exit "$curl_exit"');
    expect(workflow).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}/);
  });

  it.each([
    [
      '{"claimed":2,"deleted":1,"retained":1,"blocked":0,"failed":0,"recoveryFailed":0,"backlog":{"client_due":0,"client_retry_exhausted":0,"profile_due":0,"profile_blocked":0,"oldest_due_at":null},"backlog_metrics_available":true}',
      "completed mixed batch",
    ],
    [
      '{"claimed":0,"deleted":0,"retained":0,"blocked":0,"failed":0,"recoveryFailed":0,"backlog":{"client_due":0,"client_retry_exhausted":0,"profile_due":0,"profile_blocked":0,"oldest_due_at":null},"backlog_metrics_available":true}',
      "empty batch",
    ],
  ])("accepts a complete %s", (body) => {
    const result = validateResult(body);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /claimed=\d+ deleted=\d+ retained=\d+ blocked=\d+ failed=0 recoveryFailed=0/,
    );
    expect(result.stderr).toBe("");
  });

  it.each([
    [
      '{"claimed":2,"deleted":1,"retained":0,"blocked":0,"failed":1,"recoveryFailed":0}',
      "partial failure",
    ],
    [
      '{"claimed":1,"deleted":1,"retained":0,"blocked":0,"failed":0,"recoveryFailed":1}',
      "recovery failure",
    ],
    ["not-json", "malformed JSON"],
    ['{"claimed":1,"deleted":1,"failed":0}', "missing field"],
    [
      '{"claimed":2,"deleted":1,"retained":0,"blocked":0,"failed":0,"recoveryFailed":0}',
      "inconsistent counts",
    ],
    [
      '{"claimed":-1,"deleted":-1,"retained":0,"blocked":0,"failed":0,"recoveryFailed":0}',
      "negative counts",
    ],
    [
      '{"claimed":1.5,"deleted":1.5,"retained":0,"blocked":0,"failed":0,"recoveryFailed":0}',
      "fractional counts",
    ],
    [
      '{"claimed":1,"deleted":0,"retained":0,"blocked":1,"failed":0,"recoveryFailed":0,"backlog":{"client_due":0,"client_retry_exhausted":0,"profile_due":0,"profile_blocked":1},"backlog_metrics_available":true}',
      "blocked ownership evidence",
    ],
    [
      '{"claimed":0,"deleted":0,"retained":0,"blocked":0,"failed":0,"recoveryFailed":0,"backlog":null,"backlog_metrics_available":false}',
      "missing backlog evidence",
    ],
  ])("rejects %s without echoing the raw response", (body) => {
    const result = validateResult(body);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^client media cleanup result rejected: [a-z_]+\r?\n$/);
    expect(result.stderr).not.toContain(body);
  });
});
