import { appendFileSync, closeSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { expect } from "vitest";

const stageIds = [
  "owner-primary:session",
  "owner-primary:media-post",
  "owner-primary:response-body",
  "owner-primary:signed-object-get",
  "owner-primary:signed-object-body",
  "owner-repeat:session",
  "owner-repeat:media-post",
  "owner-repeat:response-body",
  "owner-repeat:signed-object-get",
  "owner-repeat:signed-object-body",
  "assigned:session",
  "assigned:media-post",
  "assigned:response-body",
  "assigned:signed-object-get",
  "assigned:signed-object-body",
  "other:session",
  "other:media-post",
  "other:response-body",
  "unassigned:session",
  "unassigned:media-post",
  "unassigned:response-body",
  "admin:session",
  "admin:media-post",
  "admin:response-body",
  "admin:signed-object-get",
  "admin:signed-object-body",
] as const;

export type MediaEvidenceStage = (typeof stageIds)[number];
export type MediaEvidenceFailureCategory = "session" | "network" | "body";
type PersistedFailureCategory = MediaEvidenceFailureCategory | "http_status";
type MediaEvidenceEvent = "start" | "end" | "error";
type PersistenceOperation = "create" | "append";

export type MediaEvidenceRecord = {
  schemaVersion: 1;
  runId: string;
  event: MediaEvidenceEvent;
  stage: MediaEvidenceStage;
  sequence: number;
  elapsedMs: number;
  status?: number;
  category?: PersistedFailureCategory;
};

type MediaEvidenceEnvironment = {
  WP015_HTTP_REPORT?: string;
  WP015_HTTP_RUN_ID?: string;
};

type MediaEvidenceOptions = {
  appendRecord?: (filePath: string, record: string) => void;
  maxRecords?: number;
  now?: () => number;
  onPersistenceFailure?: (operation: PersistenceOperation) => void;
};

export type MediaTestEvidence = {
  filePath: string | null;
  run<T>(
    stage: MediaEvidenceStage,
    failureCategory: MediaEvidenceFailureCategory,
    operation: () => Promise<T>,
    readStatus?: (value: T) => number | undefined,
  ): Promise<T>;
};

export type MediaTestActor = {
  auth: {
    getSession(): Promise<{
      data: { session: { access_token: string } | null };
      error: unknown;
    }>;
  };
};

type MediaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type MediaTestPathContext = {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  bucket: string;
  objectPath: string;
  fetch: MediaFetch;
  now?: () => number;
};

type MediaViewPayload = { url: string; expires_at: string };

type MediaViewRequestEvidence = {
  session: MediaEvidenceStage;
  mediaPost: MediaEvidenceStage;
};

type SignedMediaEvidence = {
  responseBody: MediaEvidenceStage;
  signedObjectGet: MediaEvidenceStage;
  signedObjectBody: MediaEvidenceStage;
};

type PermanentMediaScenario = {
  actors: {
    owner: MediaTestActor;
    assigned: MediaTestActor;
    other: MediaTestActor;
    unassigned: MediaTestActor;
    admin: MediaTestActor;
  };
  attachmentId: string;
  assetId: string;
  evidence: MediaTestEvidence;
};

const defaultMaxRecords = 64;

function resolveBinding(environment: MediaEvidenceEnvironment) {
  const reportPath = environment.WP015_HTTP_REPORT;
  const runId = environment.WP015_HTTP_RUN_ID;
  if (!reportPath || !runId || !isAbsolute(reportPath)) return null;

  const reportMatch = /^http-owner-([12])\.json$/.exec(basename(reportPath));
  const runMatch = /^http-([12])-([0-9a-f]{32})$/.exec(runId);
  if (!reportMatch || !runMatch || reportMatch[1] !== runMatch[1]) return null;

  return {
    filePath: join(dirname(reportPath), `http-media-steps-${runId}.jsonl`),
    runId,
  };
}

function defaultPersistenceFailure(operation: PersistenceOperation) {
  console.error(`WP01.5 media evidence persistence failure: ${operation}`);
}

export function createMediaTestEvidenceFromEnvironment(
  environment: MediaEvidenceEnvironment = process.env,
  options: MediaEvidenceOptions = {},
): MediaTestEvidence {
  const binding = resolveBinding(environment);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const requestedMaxRecords = options.maxRecords ?? defaultMaxRecords;
  const maxRecords = Number.isFinite(requestedMaxRecords)
    ? Math.max(0, Math.min(Math.floor(requestedMaxRecords), defaultMaxRecords))
    : defaultMaxRecords;
  const appendRecord =
    options.appendRecord ??
    ((filePath: string, record: string) => appendFileSync(filePath, `${record}\n`, "utf8"));
  const onPersistenceFailure = options.onPersistenceFailure ?? defaultPersistenceFailure;
  let sequence = 0;
  let persistenceAvailable = false;

  function reportPersistenceFailure(operation: PersistenceOperation) {
    try {
      onPersistenceFailure(operation);
    } catch {
      // Evidence reporting must never replace the test's primary result.
    }
  }

  if (binding) {
    try {
      const handle = openSync(binding.filePath, "wx");
      closeSync(handle);
      persistenceAvailable = true;
    } catch {
      reportPersistenceFailure("create");
    }
  }

  function persist(
    event: MediaEvidenceEvent,
    stage: MediaEvidenceStage,
    metadata: { status?: number; category?: PersistedFailureCategory } = {},
  ) {
    if (!binding || !persistenceAvailable || sequence >= maxRecords) return;
    const record: MediaEvidenceRecord = {
      schemaVersion: 1,
      runId: binding.runId,
      event,
      stage,
      sequence: sequence + 1,
      elapsedMs: Math.max(0, Math.round((now() - startedAt) * 1000) / 1000),
    };
    if (typeof metadata.status === "number" && Number.isFinite(metadata.status)) {
      record.status = metadata.status;
    }
    if (metadata.category) record.category = metadata.category;

    try {
      appendRecord(binding.filePath, JSON.stringify(record));
      sequence += 1;
    } catch {
      persistenceAvailable = false;
      reportPersistenceFailure("append");
    }
  }

  return {
    filePath: binding?.filePath ?? null,
    async run(stage, failureCategory, operation, readStatus) {
      persist("start", stage);
      try {
        const value = await operation();
        const status = readStatus?.(value);
        persist("end", stage, {
          status,
          category:
            typeof status === "number" && (status < 200 || status >= 300)
              ? "http_status"
              : undefined,
        });
        return value;
      } catch (error) {
        persist("error", stage, { category: failureCategory });
        throw error;
      }
    },
  };
}

export function createMediaTestPath(context: MediaTestPathContext) {
  const now = context.now ?? (() => Date.now());

  async function runWithEvidence<T>(
    evidence: MediaTestEvidence | undefined,
    stage: MediaEvidenceStage | undefined,
    failureCategory: MediaEvidenceFailureCategory,
    operation: () => Promise<T>,
    readStatus?: (value: T) => number | undefined,
  ) {
    if (!evidence || !stage) return operation();
    return evidence.run(stage, failureCategory, operation, readStatus);
  }

  async function invokeMediaView(
    actor: MediaTestActor | null,
    body: Record<string, string>,
    evidence?: MediaTestEvidence,
    stages?: MediaViewRequestEvidence,
  ) {
    const headers: Record<string, string> = {
      apikey: context.anonKey,
      "Content-Type": "application/json",
    };
    if (actor) {
      const accessToken = await runWithEvidence(evidence, stages?.session, "session", async () => {
        const { data, error } = await actor.auth.getSession();
        if (error || !data.session?.access_token)
          throw new Error("local media actor session unavailable");
        return data.session.access_token;
      });
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return runWithEvidence(
      evidence,
      stages?.mediaPost,
      "network",
      () =>
        context.fetch(`${context.apiUrl}/functions/v1/media-view-url`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      (response) => response.status,
    );
  }

  async function expectSignedMedia(
    response: Response,
    expectedMaxTtlSeconds: number,
    evidence?: MediaTestEvidence,
    stages?: SignedMediaEvidence,
  ) {
    expect(response.status).toBe(200);
    const payload = (await runWithEvidence(evidence, stages?.responseBody, "body", () =>
      response.json(),
    )) as MediaViewPayload;
    expect(Object.keys(payload).sort()).toEqual(["expires_at", "url"]);
    expect(payload.url).toEqual(expect.any(String));
    expect(payload.expires_at).toEqual(expect.any(String));
    const signedUrl = new URL(payload.url);
    expect(decodeURIComponent(signedUrl.pathname)).toContain(
      `/object/sign/${context.bucket}/${context.objectPath}`,
    );
    expect(signedUrl.searchParams.has("token")).toBe(true);
    const ttlMs = new Date(payload.expires_at).getTime() - now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(expectedMaxTtlSeconds * 1000 + 1500);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["source_path", "preview_path", "object_path"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain(context.serviceRoleKey || "never-present");
    const localObjectUrl = new URL(payload.url);
    const localApiUrl = new URL(context.apiUrl);
    localObjectUrl.protocol = localApiUrl.protocol;
    localObjectUrl.host = localApiUrl.host;
    const objectResponse = await runWithEvidence(
      evidence,
      stages?.signedObjectGet,
      "network",
      () => context.fetch(localObjectUrl),
      (value) => value.status,
    );
    expect(objectResponse.status).toBe(200);
    const objectBody = await runWithEvidence(evidence, stages?.signedObjectBody, "body", () =>
      objectResponse.arrayBuffer(),
    );
    expect(objectBody.byteLength).toBeGreaterThan(0);
    return payload;
  }

  async function expectUnavailable(
    response: Response,
    evidence?: MediaTestEvidence,
    responseBodyStage?: MediaEvidenceStage,
  ) {
    expect(response.status).toBe(404);
    expect(
      await runWithEvidence(evidence, responseBodyStage, "body", () => response.json()),
    ).toEqual({ code: "media_not_available" });
  }

  async function runPermanentMediaScenario(scenario: PermanentMediaScenario) {
    const body = { kind: "message_attachment", attachment_id: scenario.attachmentId };
    const ownerResponse = await invokeMediaView(scenario.actors.owner, body, scenario.evidence, {
      session: "owner-primary:session",
      mediaPost: "owner-primary:media-post",
    });
    await expectSignedMedia(ownerResponse, 60, scenario.evidence, {
      responseBody: "owner-primary:response-body",
      signedObjectGet: "owner-primary:signed-object-get",
      signedObjectBody: "owner-primary:signed-object-body",
    });
    const repeatedOwnerResponse = await invokeMediaView(
      scenario.actors.owner,
      body,
      scenario.evidence,
      {
        session: "owner-repeat:session",
        mediaPost: "owner-repeat:media-post",
      },
    );
    await expectSignedMedia(repeatedOwnerResponse, 60, scenario.evidence, {
      responseBody: "owner-repeat:response-body",
      signedObjectGet: "owner-repeat:signed-object-get",
      signedObjectBody: "owner-repeat:signed-object-body",
    });
    const assignedResponse = await invokeMediaView(
      scenario.actors.assigned,
      body,
      scenario.evidence,
      {
        session: "assigned:session",
        mediaPost: "assigned:media-post",
      },
    );
    await expectSignedMedia(assignedResponse, 60, scenario.evidence, {
      responseBody: "assigned:response-body",
      signedObjectGet: "assigned:signed-object-get",
      signedObjectBody: "assigned:signed-object-body",
    });
    const otherResponse = await invokeMediaView(scenario.actors.other, body, scenario.evidence, {
      session: "other:session",
      mediaPost: "other:media-post",
    });
    await expectUnavailable(otherResponse, scenario.evidence, "other:response-body");
    const unassignedResponse = await invokeMediaView(
      scenario.actors.unassigned,
      body,
      scenario.evidence,
      {
        session: "unassigned:session",
        mediaPost: "unassigned:media-post",
      },
    );
    await expectUnavailable(unassignedResponse, scenario.evidence, "unassigned:response-body");
    const adminResponse = await invokeMediaView(
      scenario.actors.admin,
      { kind: "admin_asset_preview", asset_id: scenario.assetId },
      scenario.evidence,
      {
        session: "admin:session",
        mediaPost: "admin:media-post",
      },
    );
    await expectSignedMedia(adminResponse, 60, scenario.evidence, {
      responseBody: "admin:response-body",
      signedObjectGet: "admin:signed-object-get",
      signedObjectBody: "admin:signed-object-body",
    });
  }

  return { expectSignedMedia, expectUnavailable, invokeMediaView, runPermanentMediaScenario };
}
