import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMediaTestPath,
  createMediaTestEvidenceFromEnvironment,
  type MediaEvidenceRecord,
  type MediaTestActor,
} from "../../supabase/tests/http/media-test-evidence";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "wp015-media-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function binding(directory: string, lane: 1 | 2 = 1) {
  return {
    WP015_HTTP_REPORT: join(directory, `http-owner-${lane}.json`),
    WP015_HTTP_RUN_ID: `http-${lane}-${String(lane).repeat(32)}`,
  };
}

function readRecords(filePath: string | null) {
  if (!filePath) return [];
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as MediaEvidenceRecord);
}

const apiUrl = "http://127.0.0.1:65432";
const bucket = "character-media";
const objectPath = "characters/test/permanent.webp";
const attachmentId = "attachment-test-id";
const assetId = "asset-test-id";
const now = Date.parse("2026-11-02T10:00:00.000Z");

type ActorLabel = "owner" | "assigned" | "other" | "unassigned" | "admin";

function makeActors(operations: string[], failures: Partial<Record<ActorLabel, unknown>> = {}) {
  const makeActor = (label: ActorLabel): MediaTestActor => ({
    auth: {
      async getSession() {
        operations.push(`session:${label}`);
        if (failures[label]) throw failures[label];
        return {
          data: { session: { access_token: `token-${label}` } },
          error: null,
        };
      },
    },
  });
  return {
    owner: makeActor("owner"),
    assigned: makeActor("assigned"),
    other: makeActor("other"),
    unassigned: makeActor("unassigned"),
    admin: makeActor("admin"),
  };
}

function makeJsonResponse(payload: unknown, status: number, onBody: () => void) {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const readJson = response.json.bind(response);
  Object.defineProperty(response, "json", {
    value: async () => {
      onBody();
      return readJson();
    },
  });
  return response;
}

function makeObjectResponse(onBody: () => void, bodyFailure?: unknown) {
  const response = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  const readBody = response.arrayBuffer.bind(response);
  Object.defineProperty(response, "arrayBuffer", {
    value: async () => {
      onBody();
      if (bodyFailure) throw bodyFailure;
      return readBody();
    },
  });
  return response;
}

function createPath(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  const unexpectedGlobalFetch = vi.fn(async () => {
    throw new Error("unexpected global fetch access");
  });
  vi.stubGlobal("fetch", unexpectedGlobalFetch);
  return {
    path: createMediaTestPath({
      apiUrl,
      anonKey: "anon-test-key",
      serviceRoleKey: "service-role-canary-must-not-persist",
      bucket,
      objectPath,
      fetch: fetchImpl,
      now: () => now,
    }),
    unexpectedGlobalFetch,
  };
}

function scenario(
  path: ReturnType<typeof createMediaTestPath>,
  evidence: ReturnType<typeof createMediaTestEvidenceFromEnvironment>,
  actors: ReturnType<typeof makeActors>,
) {
  return path.runPermanentMediaScenario({ actors, attachmentId, assetId, evidence });
}

function createSuccessFetch(operations: string[]) {
  const actorLabels: ActorLabel[] = ["owner", "assigned", "other", "unassigned", "admin"];
  const signedActors = new Set<ActorLabel>(["owner", "assigned", "admin"]);
  let postIndex = 0;
  let objectIndex = 0;

  return async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(String(input)).toBe(`${apiUrl}/functions/v1/media-view-url`);
      const headers = new Headers(init.headers);
      expect(headers.get("apikey")).toBe("anon-test-key");
      expect(headers.get("Content-Type")).toBe("application/json");
      const authorization = headers.get("Authorization") ?? "";
      const actor = authorization.replace("Bearer token-", "") as ActorLabel;
      if (!actorLabels.includes(actor)) throw new Error("unexpected media actor");
      const currentPost = postIndex++;
      operations.push(`post:${actor}`);
      expect(headers.get("Authorization")).toBe(`Bearer token-${actor}`);
      expect(JSON.parse(String(init.body))).toEqual(
        actor === "admin"
          ? { kind: "admin_asset_preview", asset_id: assetId }
          : { kind: "message_attachment", attachment_id: attachmentId },
      );
      if (!signedActors.has(actor)) {
        return makeJsonResponse({ code: "media_not_available" }, 404, () =>
          operations.push(`response-body:${actor}`),
        );
      }
      return makeJsonResponse(
        {
          url: `https://signed.invalid/storage/v1/object/sign/${bucket}/${objectPath}?token=signed-${currentPost}`,
          expires_at: new Date(now + 60_000).toISOString(),
        },
        200,
        () => operations.push(`response-body:${actor}`),
      );
    }

    objectIndex += 1;
    operations.push(`object:${objectIndex}`);
    expect(String(input)).toMatch(
      new RegExp(`^${apiUrl}/storage/v1/object/sign/${bucket}/${objectPath}\\?token=signed-`),
    );
    return makeObjectResponse(() => operations.push(`object-body:${objectIndex}`));
  };
}

async function captureFailure(operation: Promise<unknown>) {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WP01.5 media test durable step evidence", () => {
  it("does not create a file without a complete validated runner binding", async () => {
    const directory = makeTemporaryDirectory();
    const unbound = createMediaTestEvidenceFromEnvironment({});
    const mismatched = createMediaTestEvidenceFromEnvironment({
      WP015_HTTP_REPORT: join(directory, "http-owner-1.json"),
      WP015_HTTP_RUN_ID: `http-2-${"2".repeat(32)}`,
    });
    const relative = createMediaTestEvidenceFromEnvironment({
      WP015_HTTP_REPORT: "http-owner-1.json",
      WP015_HTTP_RUN_ID: `http-1-${"1".repeat(32)}`,
    });

    await unbound.run("owner-primary:session", "session", async () => "ok");
    await mismatched.run("owner-primary:session", "session", async () => "ok");
    await relative.run("owner-primary:session", "session", async () => "ok");

    expect(unbound.filePath).toBeNull();
    expect(mismatched.filePath).toBeNull();
    expect(relative.filePath).toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("isolates HTTP1 and HTTP2 records and refuses to overwrite an existing sidecar", async () => {
    const directory = makeTemporaryDirectory();
    const first = createMediaTestEvidenceFromEnvironment(binding(directory, 1));
    const second = createMediaTestEvidenceFromEnvironment(binding(directory, 2));

    await first.run("owner-primary:session", "session", async () => "first");
    await second.run("owner-primary:session", "session", async () => "second");

    expect(first.filePath).not.toBe(second.filePath);
    expect(readRecords(first.filePath)).toHaveLength(2);
    expect(readRecords(second.filePath)).toHaveLength(2);

    const persistenceFailures: string[] = [];
    const duplicate = createMediaTestEvidenceFromEnvironment(binding(directory, 1), {
      onPersistenceFailure: (operation) => {
        persistenceFailures.push(operation);
        throw new Error("secondary-persistence-reporting-canary");
      },
    });
    await duplicate.run("owner-primary:session", "session", async () => "unchanged");

    expect(persistenceFailures).toEqual(["create"]);
    expect(readRecords(first.filePath)).toHaveLength(2);
  });

  it("runs the permanent-media path and records owner 503 before its original assertion", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const actors = makeActors(operations);
    const { path, unexpectedGlobalFetch } = createPath(async (input, init) => {
      operations.push("post:owner");
      expect(String(input)).toBe(`${apiUrl}/functions/v1/media-view-url`);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer token-owner");
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: "message_attachment",
        attachment_id: attachmentId,
      });
      return new Response(JSON.stringify({ code: "canary-body-must-not-persist" }), {
        status: 503,
      });
    });

    const failure = await captureFailure(scenario(path, evidence, actors));

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/expected 503 to be 200/);
    expect(operations).toEqual(["session:owner", "post:owner"]);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
    expect(readRecords(evidence.filePath)).toEqual([
      expect.objectContaining({ event: "start", stage: "owner-primary:session" }),
      expect.objectContaining({ event: "end", stage: "owner-primary:session" }),
      expect.objectContaining({ event: "start", stage: "owner-primary:media-post" }),
      expect.objectContaining({
        category: "http_status",
        event: "end",
        stage: "owner-primary:media-post",
        status: 503,
      }),
    ]);
    const persisted = readFileSync(evidence.filePath!, "utf8");
    expect(persisted).not.toContain("canary-body-must-not-persist");
    expect(persisted).not.toContain("token-owner");
  });

  it("runs the full permanent-media actor path with six POSTs and four signed-object reads", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const actors = makeActors(operations);
    const { path, unexpectedGlobalFetch } = createPath(createSuccessFetch(operations));

    await scenario(path, evidence, actors);

    expect(operations).toEqual([
      "session:owner",
      "post:owner",
      "response-body:owner",
      "object:1",
      "object-body:1",
      "session:owner",
      "post:owner",
      "response-body:owner",
      "object:2",
      "object-body:2",
      "session:assigned",
      "post:assigned",
      "response-body:assigned",
      "object:3",
      "object-body:3",
      "session:other",
      "post:other",
      "response-body:other",
      "session:unassigned",
      "post:unassigned",
      "response-body:unassigned",
      "session:admin",
      "post:admin",
      "response-body:admin",
      "object:4",
      "object-body:4",
    ]);
    expect(operations.filter((operation) => operation.startsWith("post:"))).toHaveLength(6);
    expect(operations.filter((operation) => operation.startsWith("object:"))).toHaveLength(4);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
    expect(readRecords(evidence.filePath)).toHaveLength(52);
    const persisted = readFileSync(evidence.filePath!, "utf8");
    for (const canary of [
      "token-owner",
      "token-assigned",
      "service-role-canary-must-not-persist",
      attachmentId,
      assetId,
      "signed.invalid",
    ]) {
      expect(persisted).not.toContain(canary);
    }
  });

  it("keeps an actual-path session rejection at owner-primary session", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const sessionFailure = new Error("canary-session-error-must-not-persist");
    const actors = makeActors(operations, { owner: sessionFailure });
    const { path, unexpectedGlobalFetch } = createPath(async () => {
      throw new Error("injected fetch must not run after session rejection");
    });

    expect(await captureFailure(scenario(path, evidence, actors))).toBe(sessionFailure);

    expect(readRecords(evidence.filePath)).toEqual([
      expect.objectContaining({ event: "start", stage: "owner-primary:session" }),
      expect.objectContaining({
        category: "session",
        event: "error",
        stage: "owner-primary:session",
      }),
    ]);
    expect(operations).toEqual(["session:owner"]);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
    expect(readFileSync(evidence.filePath!, "utf8")).not.toContain(
      "canary-session-error-must-not-persist",
    );
  });

  it("keeps an actual-path POST rejection at owner-primary media-post", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const requestFailure = new Error("canary-request-error-must-not-persist");
    const actors = makeActors(operations);
    const { path, unexpectedGlobalFetch } = createPath(async () => {
      operations.push("post:owner");
      throw requestFailure;
    });

    expect(await captureFailure(scenario(path, evidence, actors))).toBe(requestFailure);

    expect(readRecords(evidence.filePath)).toContainEqual(
      expect.objectContaining({
        category: "network",
        event: "error",
        stage: "owner-primary:media-post",
      }),
    );
    expect(operations).toEqual(["session:owner", "post:owner"]);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
  });

  it("keeps actual-path malformed JSON at owner-primary response-body", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const actors = makeActors(operations);
    const { path, unexpectedGlobalFetch } = createPath(async () => {
      operations.push("post:owner");
      const response = new Response("{malformed", { status: 200 });
      const readJson = response.json.bind(response);
      Object.defineProperty(response, "json", {
        value: async () => {
          operations.push("response-body:owner");
          return readJson();
        },
      });
      return response;
    });

    const failure = await captureFailure(scenario(path, evidence, actors));

    expect(failure).toBeInstanceOf(SyntaxError);
    expect(readRecords(evidence.filePath)).toContainEqual(
      expect.objectContaining({
        category: "body",
        event: "error",
        stage: "owner-primary:response-body",
      }),
    );
    expect(operations).toEqual(["session:owner", "post:owner", "response-body:owner"]);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
  });

  it("keeps actual-path signed-object GET and body failures at their fixed stages", async () => {
    const signedPayload = {
      url: `https://signed.invalid/storage/v1/object/sign/${bucket}/${objectPath}?token=signed-0`,
      expires_at: new Date(now + 60_000).toISOString(),
    };

    const getDirectory = makeTemporaryDirectory();
    const getEvidence = createMediaTestEvidenceFromEnvironment(binding(getDirectory));
    const getOperations: string[] = [];
    const getFailure = new Error("signed-object-get-canary");
    const getActors = makeActors(getOperations);
    let getCall = 0;
    const getPathState = createPath(async () => {
      getCall += 1;
      if (getCall === 1) {
        getOperations.push("post:owner");
        return makeJsonResponse(signedPayload, 200, () =>
          getOperations.push("response-body:owner"),
        );
      }
      getOperations.push("object:1");
      throw getFailure;
    });

    expect(await captureFailure(scenario(getPathState.path, getEvidence, getActors))).toBe(
      getFailure,
    );
    expect(readRecords(getEvidence.filePath)).toContainEqual(
      expect.objectContaining({
        category: "network",
        event: "error",
        stage: "owner-primary:signed-object-get",
      }),
    );
    expect(getPathState.unexpectedGlobalFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const bodyDirectory = makeTemporaryDirectory();
    const bodyEvidence = createMediaTestEvidenceFromEnvironment(binding(bodyDirectory));
    const bodyOperations: string[] = [];
    const bodyFailure = new Error("signed-object-body-canary");
    const bodyActors = makeActors(bodyOperations);
    let bodyCall = 0;
    const bodyPathState = createPath(async () => {
      bodyCall += 1;
      if (bodyCall === 1) {
        bodyOperations.push("post:owner");
        return makeJsonResponse(signedPayload, 200, () =>
          bodyOperations.push("response-body:owner"),
        );
      }
      bodyOperations.push("object:1");
      return makeObjectResponse(() => bodyOperations.push("object-body:1"), bodyFailure);
    });

    expect(await captureFailure(scenario(bodyPathState.path, bodyEvidence, bodyActors))).toBe(
      bodyFailure,
    );
    expect(readRecords(bodyEvidence.filePath)).toContainEqual(
      expect.objectContaining({
        category: "body",
        event: "error",
        stage: "owner-primary:signed-object-body",
      }),
    );
    expect(bodyPathState.unexpectedGlobalFetch).not.toHaveBeenCalled();
  });

  it("persists actual-path media-post start before a delayed POST completes", async () => {
    const directory = makeTemporaryDirectory();
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory));
    const operations: string[] = [];
    const actors = makeActors(operations);
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { path, unexpectedGlobalFetch } = createPath(async () => {
      operations.push("post:owner");
      markStarted();
      return pendingResponse;
    });

    const runningScenario = scenario(path, evidence, actors);
    await started;
    const recordsWhilePending = readRecords(evidence.filePath);
    expect(recordsWhilePending.at(-1)).toEqual(
      expect.objectContaining({ event: "start", stage: "owner-primary:media-post" }),
    );
    expect(
      recordsWhilePending.some(
        (record) => record.event === "end" && record.stage === "owner-primary:media-post",
      ),
    ).toBe(false);

    release(new Response(null, { status: 503 }));
    const failure = await captureFailure(runningScenario);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/expected 503 to be 200/);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
  });

  it("does not replace actual-path assertion or network failures when persistence fails", async () => {
    const assertionDirectory = makeTemporaryDirectory();
    const assertionFailures: string[] = [];
    const assertionEvidence = createMediaTestEvidenceFromEnvironment(binding(assertionDirectory), {
      appendRecord: () => {
        throw new Error("persistence-canary");
      },
      onPersistenceFailure: (operation) => assertionFailures.push(operation),
    });
    const assertionOperations: string[] = [];
    const assertionActors = makeActors(assertionOperations);
    const assertionPathState = createPath(async () => new Response(null, { status: 503 }));
    const assertionFailure = await captureFailure(
      scenario(assertionPathState.path, assertionEvidence, assertionActors),
    );

    expect(assertionFailure).toBeInstanceOf(Error);
    expect((assertionFailure as Error).message).toMatch(/expected 503 to be 200/);
    expect(assertionFailures).toEqual(["append"]);
    expect(readFileSync(assertionEvidence.filePath!, "utf8")).toBe("");

    vi.unstubAllGlobals();
    const networkDirectory = makeTemporaryDirectory();
    const networkFailures: string[] = [];
    const networkEvidence = createMediaTestEvidenceFromEnvironment(binding(networkDirectory), {
      appendRecord: () => {
        throw new Error("persistence-canary");
      },
      onPersistenceFailure: (operation) => networkFailures.push(operation),
    });
    const networkOperations: string[] = [];
    const networkActors = makeActors(networkOperations);
    const primaryNetworkFailure = new Error("primary-network-canary");
    const networkPathState = createPath(async () => {
      throw primaryNetworkFailure;
    });

    expect(
      await captureFailure(scenario(networkPathState.path, networkEvidence, networkActors)),
    ).toBe(primaryNetworkFailure);
    expect(networkFailures).toEqual(["append"]);
    expect(readFileSync(networkEvidence.filePath!, "utf8")).toBe("");
    expect(assertionPathState.unexpectedGlobalFetch).not.toHaveBeenCalled();
    expect(networkPathState.unexpectedGlobalFetch).not.toHaveBeenCalled();
  });

  it("uses monotonic elapsed values, increasing sequence numbers and a bounded record count", async () => {
    const directory = makeTemporaryDirectory();
    const moments = [100, 101, 102, 103, 104, 105, 106];
    const evidence = createMediaTestEvidenceFromEnvironment(binding(directory), {
      maxRecords: 4,
      now: () => moments.shift() ?? 107,
    });

    await evidence.run("owner-primary:session", "session", async () => "one");
    await evidence.run("owner-primary:media-post", "network", async () => "two");
    await evidence.run("owner-primary:response-body", "body", async () => "three");

    const records = readRecords(evidence.filePath);
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(records.map((record) => record.elapsedMs)).toEqual([1, 2, 3, 4]);
    expect(records.every((record) => !("complete" in record))).toBe(true);
  });

  it("does not append to a pre-existing sidecar even when it contains valid-looking JSON", async () => {
    const directory = makeTemporaryDirectory();
    const first = createMediaTestEvidenceFromEnvironment(binding(directory));
    expect(first.filePath).not.toBeNull();
    writeFileSync(first.filePath!, '{"canary":"must-remain"}\n', "utf8");

    const failures: string[] = [];
    const duplicate = createMediaTestEvidenceFromEnvironment(binding(directory), {
      onPersistenceFailure: (operation) => failures.push(operation),
    });
    await duplicate.run("owner-primary:session", "session", async () => "ok");

    expect(failures).toEqual(["create"]);
    expect(readFileSync(first.filePath!, "utf8")).toBe('{"canary":"must-remain"}\n');
  });
});
