// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  createServiceClient,
  createSyntheticUser,
  deleteFixtureEventsForOwnership,
  deleteAuthUser,
  deleteByEq,
  insertRow,
  localHttpReady,
  runCleanupSteps,
  seedCharacter,
  seedClientMessage,
  seedConversation,
  seedOperator,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

const ids = {
  character: "00000000-0000-4000-8000-000000012501",
  conversation: "00000000-0000-4000-8000-000000012502",
  firstMessage: "00000000-0000-4000-8000-000000012503",
  revokedMessage: "00000000-0000-4000-8000-000000012504",
  reconnectMessage: "00000000-0000-4000-8000-000000012512",
  ownerOperator: "00000000-0000-4000-8000-000000012505",
  readerOperator: "00000000-0000-4000-8000-000000012506",
  adminOperator: "00000000-0000-4000-8000-000000012507",
  mediaAsset: "00000000-0000-4000-8000-000000012508",
  mediaReservation: "00000000-0000-4000-8000-000000012509",
  mediaMessage: "00000000-0000-4000-8000-000000012510",
  mediaAttachment: "00000000-0000-4000-8000-000000012511",
  readerCanary: "00000000-0000-4000-8000-000000012513",
};
const prefix = "wp01-5-http";
const suite = describe.skipIf(!localHttpReady);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(50);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OwnerEventBoundary = {
  baselineMessageIds: ReadonlySet<string>;
  expectedProbeMessageIds: ReadonlySet<string>;
  receivedProbeMessageIds: Set<string>;
  failures: string[];
  eventSequence: string[];
};

type ChannelCleanup = {
  label: string;
  close: () => Promise<void>;
};

type ReaderObservationPhase =
  | "authorized"
  | "revoke_in_flight"
  | "revoke_acknowledged"
  | "access_version_observed"
  | "reconnect";

type ReaderMessageChannel = "original" | "reconnect";
type ReaderMessageClassification = "authorized" | "ambiguous" | "forbidden" | "invalid";

type ReaderObservationJournal = {
  phase: ReaderObservationPhase;
  nextSequence: number;
  knownMessages: ReadonlyMap<string, string>;
  phaseHistory: Array<{
    sequence: number;
    monotonicMs: number;
    phase: ReaderObservationPhase;
  }>;
  events: Array<{
    actor: "reader";
    channel: ReaderMessageChannel;
    messageCategory: string;
    messageId: string | null;
    sequence: number;
    monotonicMs: number;
    phase: ReaderObservationPhase;
    classification: ReaderMessageClassification;
  }>;
  failures: string[];
};

type RealtimeChannel = ReturnType<HttpClient["channel"]>;

type ChannelObservation = {
  label: string;
  subscribed: boolean;
  replicationReady: boolean;
  intentionalClose: boolean;
  failures: string[];
  history: Array<{ status: string; monotonicMs: number }>;
};

const observedChannels = new WeakMap<RealtimeChannel, ChannelObservation>();

function subscribeObservedChannel(channel: RealtimeChannel, label: string) {
  const observation: ChannelObservation = {
    label,
    subscribed: false,
    replicationReady: false,
    intentionalClose: false,
    failures: [],
    history: [],
  };
  observedChannels.set(channel, observation);
  const record = (status: string) => {
    observation.history.push({ status, monotonicMs: performance.now() });
  };
  // v2.106 client / v2.86.3 server: join acknowledgement is not the CDC acknowledgement.
  channel.on("system", {}, (payload: unknown) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      !("extension" in payload) ||
      payload.extension !== "postgres_changes"
    )
      return;
    const ok = "status" in payload && payload.status === "ok";
    record(ok ? "postgres_changes_ok" : "postgres_changes_error");
    if (observation.intentionalClose) return;
    observation.replicationReady = ok;
    if (!ok) observation.failures.push("postgres_changes_error");
  });
  channel.subscribe((status) => {
    record(status);
    if (status === "SUBSCRIBED") {
      if (observation.subscribed) observation.replicationReady = false;
      observation.subscribed = true;
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      observation.subscribed = false;
      observation.replicationReady = false;
      if (!observation.intentionalClose) observation.failures.push(status);
    }
  });
  return observation;
}

function assertChannelsHealthy(observations: ChannelObservation[]) {
  for (const observation of observations) {
    if (observation.failures.length)
      throw new Error(`realtime_channel_failed:${observation.label}`);
  }
}

function assertChannelsReady(observations: ChannelObservation[]) {
  assertChannelsHealthy(observations);
  if (
    observations.some(
      (observation) =>
        !observation.subscribed || !observation.replicationReady || observation.intentionalClose,
    )
  ) {
    throw new Error("realtime_channels_not_ready");
  }
}

async function waitForChannelsReady(observations: ChannelObservation[], deadline: number) {
  await waitUntil(
    () => {
      assertChannelsHealthy(observations);
      return observations.every(
        (observation) => observation.subscribed && observation.replicationReady,
      );
    },
    Math.max(0, deadline - Date.now()),
  );
  assertChannelsReady(observations);
}

function channelSnapshot(observations: ChannelObservation[]) {
  return observations.map((observation) => ({
    ...observation,
    failures: [...observation.failures],
    history: observation.history.map((entry) => ({ ...entry })),
  }));
}

type ReadAccessEvidenceState = {
  stage: string;
  canaryWrite: { monotonicMs: number; channels: ReturnType<typeof channelSnapshot> } | null;
};

async function writeCanaryWhenReady(
  observations: ChannelObservation[],
  evidence: ReadAccessEvidenceState,
  write: () => Promise<void>,
) {
  assertChannelsReady(observations);
  evidence.canaryWrite = {
    monotonicMs: performance.now(),
    channels: channelSnapshot(observations),
  };
  await write();
}

type ReadAccessEvidenceEnvironment = {
  WP015_HTTP_REPORT?: string;
  WP015_HTTP_RUN_ID?: string;
};

async function withReadAccessEvidence(
  observations: ChannelObservation[],
  journal: ReaderObservationJournal,
  ownerBoundary: OwnerEventBoundary,
  canaryId: string,
  evidence: ReadAccessEvidenceState,
  operation: () => Promise<void>,
  environment: ReadAccessEvidenceEnvironment = process.env,
) {
  try {
    await operation();
  } catch (primaryError) {
    // The existing HTTP evidence directory/run binding is used; raw payloads never enter this sidecar.
    try {
      const report = environment.WP015_HTTP_REPORT;
      const runId = environment.WP015_HTTP_RUN_ID;
      const reportMatch = report && /^http-owner-([12])\.json$/.exec(basename(report));
      const runMatch = runId && /^http-([12])-([0-9a-f]{32})$/.exec(runId);
      if (
        !report ||
        !isAbsolute(report) ||
        !reportMatch ||
        !runMatch ||
        reportMatch[1] !== runMatch[1]
      ) {
        throw new Error("read_access_evidence_binding_unavailable");
      }
      const category = (value: string) => value.split(":", 1)[0];
      const snapshot = {
        schemaVersion: 1,
        runId,
        stage: evidence.stage,
        capturedAt: new Date().toISOString(),
        monotonicMs: performance.now(),
        canaryWrite: evidence.canaryWrite,
        channels: channelSnapshot(observations),
        readerReceivedCanary: hasReaderObservedMessage(journal, canaryId, "original"),
        ownerReceivedCanary: ownerBoundary.receivedProbeMessageIds.has(canaryId),
        readerFailures: journal.failures.map(category),
        ownerFailures: ownerBoundary.failures.map(category),
        readerEvents: journal.events.map(({ messageId: _messageId, ...event }) => event),
        phases: journal.phaseHistory,
        rowVisibility: "not_observed_by_failure_snapshot",
      };
      writeFileSync(
        join(dirname(report), `http-read-access-${runId}.json`),
        JSON.stringify(snapshot, null, 2),
        { flag: "wx" },
      );
    } catch {
      // Reporting cannot replace the original assertion, including if the destination is unavailable.
      console.error("WP01.5 read-access snapshot persistence unavailable");
    }
    throw primaryError;
  }
}

function readMessageEventId(payload: unknown, expectedConversationId: string) {
  if (typeof payload !== "object" || payload === null || !("new" in payload)) {
    throw new Error("malformed_message_payload");
  }
  const record = (payload as { new?: unknown }).new;
  if (typeof record !== "object" || record === null) {
    throw new Error("malformed_message_payload");
  }
  const { conversation_id: conversationId, id: messageId } = record as Record<string, unknown>;
  if (typeof messageId !== "string" || !uuidPattern.test(messageId)) {
    throw new Error("invalid_message_id");
  }
  if (conversationId !== expectedConversationId) {
    throw new Error("message_conversation_mismatch");
  }
  return messageId;
}

function readRpcMessageId(payload: unknown) {
  if (typeof payload !== "object" || payload === null || !("message" in payload)) {
    throw new Error("claim_message_missing");
  }
  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "object" || message === null || !("id" in message)) {
    throw new Error("claim_message_missing");
  }
  const messageId = (message as { id?: unknown }).id;
  if (typeof messageId !== "string" || !uuidPattern.test(messageId)) {
    throw new Error("claim_message_id_invalid");
  }
  return messageId;
}

function createOwnerEventBoundary(
  baselineMessageIds: Iterable<string>,
  expectedProbeMessageIds: Iterable<string>,
  eventSequence: string[] = [],
): OwnerEventBoundary {
  return {
    baselineMessageIds: new Set(baselineMessageIds),
    expectedProbeMessageIds: new Set(expectedProbeMessageIds),
    receivedProbeMessageIds: new Set(),
    failures: [],
    eventSequence,
  };
}

function recordOwnerMessageEvent(
  boundary: OwnerEventBoundary,
  payload: unknown,
  expectedConversationId: string,
) {
  let messageId: string;
  try {
    messageId = readMessageEventId(payload, expectedConversationId);
  } catch (error) {
    boundary.failures.push(error instanceof Error ? error.message : "invalid_owner_event");
    return;
  }
  if (boundary.baselineMessageIds.has(messageId)) return;
  if (!boundary.expectedProbeMessageIds.has(messageId)) {
    boundary.failures.push(`unexpected_owner_message:${messageId}`);
    return;
  }
  if (!boundary.receivedProbeMessageIds.has(messageId)) {
    boundary.receivedProbeMessageIds.add(messageId);
    boundary.eventSequence.push(`owner-message-${messageId}`);
  }
}

function assertOwnerProbeStage(boundary: OwnerEventBoundary, expectedIds: Iterable<string>) {
  if (boundary.failures.length > 0) {
    throw new Error(`owner_event_boundary_failure:${boundary.failures.join(",")}`);
  }
  const expected = new Set(expectedIds);
  const missing = [...expected].filter((id) => !boundary.receivedProbeMessageIds.has(id));
  const unexpected = [...boundary.receivedProbeMessageIds].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `owner_probe_set_mismatch:missing=${missing.length}:unexpected=${unexpected.length}`,
    );
  }
}

function createReaderObservationJournal(
  knownMessages: Iterable<readonly [string, string]>,
): ReaderObservationJournal {
  return {
    phase: "authorized",
    nextSequence: 1,
    knownMessages: new Map(knownMessages),
    phaseHistory: [{ sequence: 0, monotonicMs: performance.now(), phase: "authorized" }],
    events: [],
    failures: [],
  };
}

function setReaderObservationPhase(
  journal: ReaderObservationJournal,
  phase: ReaderObservationPhase,
) {
  journal.phase = phase;
  journal.phaseHistory.push({
    sequence: journal.nextSequence++,
    monotonicMs: performance.now(),
    phase,
  });
}

function recordReaderMessageEvent(
  journal: ReaderObservationJournal,
  channel: ReaderMessageChannel,
  payload: unknown,
  expectedConversationId: string,
) {
  const sequence = journal.nextSequence++;
  const monotonicMs = performance.now();
  let messageId: string;
  try {
    messageId = readMessageEventId(payload, expectedConversationId);
  } catch (error) {
    const category = error instanceof Error ? error.message : "invalid_reader_event";
    journal.events.push({
      actor: "reader",
      channel,
      messageCategory: category,
      messageId: null,
      sequence,
      monotonicMs,
      phase: journal.phase,
      classification: "invalid",
    });
    journal.failures.push(category);
    return;
  }

  const messageCategory = journal.knownMessages.get(messageId);
  if (!messageCategory) {
    journal.events.push({
      actor: "reader",
      channel,
      messageCategory: "unknown",
      messageId,
      sequence,
      monotonicMs,
      phase: journal.phase,
      classification: "invalid",
    });
    journal.failures.push(`unknown_reader_message:${messageId}`);
    return;
  }

  const classification =
    journal.phase === "authorized"
      ? "authorized"
      : journal.phase === "revoke_in_flight"
        ? "ambiguous"
        : "forbidden";
  journal.events.push({
    actor: "reader",
    channel,
    messageCategory,
    messageId,
    sequence,
    monotonicMs,
    phase: journal.phase,
    classification,
  });
}

function hasReaderObservedMessage(
  journal: ReaderObservationJournal,
  messageId: string,
  channel?: ReaderMessageChannel,
) {
  return journal.events.some(
    (event) =>
      event.messageId === messageId &&
      event.classification !== "invalid" &&
      (channel === undefined || event.channel === channel),
  );
}

function formatReaderObservationTimeline(journal: ReaderObservationJournal) {
  return JSON.stringify({ phases: journal.phaseHistory, events: journal.events });
}

function assertReaderObservationJournal(journal: ReaderObservationJournal) {
  if (journal.failures.length > 0) {
    throw new Error(`reader_event_contract_failure:${journal.failures.join(",")}`);
  }
  const ambiguous = journal.events.filter((event) => event.classification === "ambiguous");
  if (ambiguous.length > 0) {
    throw new Error(`reader_content_during_revoke_in_flight:count=${ambiguous.length}`);
  }
  const forbidden = journal.events.filter((event) => event.classification === "forbidden");
  if (forbidden.length > 0) {
    throw new Error(`reader_content_after_revoke_acknowledgement:count=${forbidden.length}`);
  }
}

function registerChannelCleanup(
  registry: ChannelCleanup[],
  label: string,
  client: HttpClient,
  channel: RealtimeChannel,
) {
  registry.push({
    label,
    close: async () => {
      const observation = observedChannels.get(channel);
      if (observation) observation.intentionalClose = true;
      const status = await client.removeChannel(channel);
      if (status !== "ok") throw new Error(`channel_close_${status}`);
    },
  });
  return channel;
}

async function closeRegisteredChannels(registry: ChannelCleanup[]) {
  const failures: string[] = [];
  for (const cleanup of registry.splice(0)) {
    try {
      await cleanup.close();
    } catch {
      failures.push(cleanup.label);
    }
  }
  if (failures.length > 0) {
    throw new Error(`realtime_channel_cleanup_incomplete:${failures.join(",")}`);
  }
}

async function runSuiteCleanup(registry: ChannelCleanup[], cleanupFixtures?: () => Promise<void>) {
  const failures: Error[] = [];
  try {
    await closeRegisteredChannels(registry);
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error("channel_cleanup_failed"));
  }
  if (cleanupFixtures) {
    try {
      await cleanupFixtures();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error("fixture_cleanup_failed"));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "WP01.5 cleanup incomplete");
  }
}

describe("WP01.5 deterministic Realtime event boundaries", () => {
  const conversationId = "00000000-0000-4000-8000-000000012502";
  const baselineId = "00000000-0000-4000-8000-000000012503";
  const firstProbeId = "00000000-0000-4000-8000-000000012504";
  const secondProbeId = "00000000-0000-4000-8000-000000012512";
  const event = (id: string, conversation_id = conversationId) => ({
    new: { id, conversation_id },
  });

  function syntheticChannel() {
    let system: (payload: unknown) => void = () => undefined;
    let status: (value: string) => void = () => undefined;
    const calls: string[] = [];
    const channel = {
      on: (kind: string, _filter: unknown, callback: (payload: unknown) => void) => {
        calls.push(kind);
        system = callback;
        return channel;
      },
      subscribe: (callback: (value: string) => void) => {
        calls.push("subscribe");
        status = callback;
        return channel;
      },
    } as unknown as RealtimeChannel;
    return {
      channel,
      calls,
      system: (payload: unknown) => system(payload),
      status: (value: string) => status(value),
    };
  }

  it("requires independent postgres readiness for both message channels before a canary", async () => {
    const access = syntheticChannel();
    const reader = syntheticChannel();
    const owner = syntheticChannel();
    const observations = [access, reader, owner].map((entry, i) =>
      subscribeObservedChannel(
        entry.channel,
        ["reader-access", "reader-messages", "owner-messages"][i],
      ),
    );
    for (const entry of [access, reader, owner]) entry.status("SUBSCRIBED");
    access.system({ extension: "postgres_changes", status: "ok" });
    owner.system({ extension: "postgres_changes", status: "ok" });
    let writes = 0;
    const evidence: ReadAccessEvidenceState = { stage: "authorized_canary", canaryWrite: null };
    const write = async () => {
      writes += 1;
    };
    await expect(writeCanaryWhenReady(observations, evidence, write)).rejects.toThrow(
      "realtime_channels_not_ready",
    );
    expect(writes).toBe(0);
    expect(evidence.canaryWrite).toBeNull();
    reader.system({ extension: "presence", status: "ok" });
    expect(() => assertChannelsReady(observations)).toThrow("realtime_channels_not_ready");
    reader.system({ extension: "postgres_changes", status: "ok" });
    await writeCanaryWhenReady(observations, evidence, write);
    expect(writes).toBe(1);
    expect(evidence.canaryWrite?.channels.every((channel) => channel.replicationReady)).toBe(true);
    expect(reader.calls).toEqual(["system", "subscribe"]);
  });

  it.each(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"])("retains %s after SUBSCRIBED", (status) => {
    const entry = syntheticChannel();
    const observation = subscribeObservedChannel(entry.channel, "reader-messages");
    entry.status("SUBSCRIBED");
    entry.system({ extension: "postgres_changes", status: "ok" });
    expect(() => entry.status(status)).not.toThrow();
    expect(() => assertChannelsHealthy([observation])).toThrow("realtime_channel_failed");
    expect(observation.replicationReady).toBe(false);
    entry.status("SUBSCRIBED");
    entry.system({ extension: "postgres_changes", status: "ok" });
    expect(() => assertChannelsHealthy([observation])).toThrow("realtime_channel_failed");
  });

  it("handles postgres system failures without throwing from the callback", () => {
    const entry = syntheticChannel();
    const observation = subscribeObservedChannel(entry.channel, "reader-messages");
    entry.status("SUBSCRIBED");
    expect(() =>
      entry.system({ extension: "postgres_changes", status: "error", message: "private" }),
    ).not.toThrow();
    expect(() => assertChannelsHealthy([observation])).toThrow("realtime_channel_failed");
    expect(JSON.stringify(observation)).not.toContain("private");
  });

  it("uses the same readiness and persistent failure contract for reconnect", () => {
    const entry = syntheticChannel();
    const observation = subscribeObservedChannel(entry.channel, "reader-reconnect");
    entry.system({ extension: "postgres_changes", status: "ok" });
    expect(() => assertChannelsReady([observation])).toThrow("realtime_channels_not_ready");
    entry.status("SUBSCRIBED");
    expect(() => assertChannelsReady([observation])).not.toThrow();
    entry.status("TIMED_OUT");
    expect(() => assertChannelsReady([observation])).toThrow("realtime_channel_failed");
  });

  it("marks intentional cleanup before CLOSED is delivered", async () => {
    const entry = syntheticChannel();
    const observation = subscribeObservedChannel(entry.channel, "reader-messages");
    const registry: ChannelCleanup[] = [];
    const client = {
      removeChannel: async () => {
        entry.status("CLOSED");
        return "ok";
      },
    } as unknown as HttpClient;
    registerChannelCleanup(registry, "reader-messages", client, entry.channel);
    entry.status("SUBSCRIBED");
    entry.system({ extension: "postgres_changes", status: "ok" });
    await closeRegisteredChannels(registry);
    expect(observation.intentionalClose).toBe(true);
    expect(observation.failures).toEqual([]);
    expect(observation.history.at(-1)?.status).toBe("CLOSED");
    expect(() => assertChannelsHealthy([observation])).not.toThrow();
    expect(() => assertChannelsReady([observation])).toThrow("realtime_channels_not_ready");
  });

  it("persists owner receipt and rejected reader callbacks on the original canary assertion path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wp015-read-access-evidence-"));
    try {
      const runId = `http-1-${"a".repeat(32)}`;
      const environment = {
        WP015_HTTP_REPORT: join(directory, "http-owner-1.json"),
        WP015_HTTP_RUN_ID: runId,
      };
      const entry = syntheticChannel();
      const observation = subscribeObservedChannel(entry.channel, "reader-messages");
      const journal = createReaderObservationJournal([[firstProbeId, "authorized_canary"]]);
      const owner = createOwnerEventBoundary([], [firstProbeId]);
      const evidence: ReadAccessEvidenceState = { stage: "authorized_canary", canaryWrite: null };
      entry.status("SUBSCRIBED");
      entry.system({ extension: "postgres_changes", status: "ok" });
      let originalError: unknown;
      let caught: unknown;
      try {
        await withReadAccessEvidence(
          [observation],
          journal,
          owner,
          firstProbeId,
          evidence,
          async () => {
            await writeCanaryWhenReady([observation], evidence, async () => {
              recordReaderMessageEvent(
                journal,
                "original",
                { new: { content: "private-message", token: "private-token" } },
                conversationId,
              );
              recordOwnerMessageEvent(owner, event(firstProbeId), conversationId);
            });
            entry.status("CHANNEL_ERROR");
            try {
              expect(hasReaderObservedMessage(journal, firstProbeId, "original")).toBe(true);
            } catch (error) {
              originalError = error;
              throw error;
            }
          },
          environment,
        );
      } catch (error) {
        caught = error;
      }
      expect(originalError).toBeDefined();
      expect(caught).toBe(originalError);
      const persisted = readFileSync(join(directory, `http-read-access-${runId}.json`), "utf8");
      const snapshot = JSON.parse(persisted);
      expect(snapshot).toMatchObject({
        runId,
        stage: "authorized_canary",
        readerReceivedCanary: false,
        ownerReceivedCanary: true,
        readerFailures: ["invalid_message_id"],
        channels: [{ failures: ["CHANNEL_ERROR"] }],
        canaryWrite: { channels: [{ subscribed: true, replicationReady: true, failures: [] }] },
        readerEvents: [{ classification: "invalid", messageCategory: "invalid_message_id" }],
      });
      for (const secret of [firstProbeId, conversationId, "private-message", "private-token"])
        expect(persisted).not.toContain(secret);
      const nextFailure = new Error("next assertion");
      await expect(
        withReadAccessEvidence(
          [observation],
          journal,
          owner,
          firstProbeId,
          evidence,
          async () => {
            throw nextFailure;
          },
          environment,
        ),
      ).rejects.toBe(nextFailure);
      expect(readFileSync(join(directory, `http-read-access-${runId}.json`), "utf8")).toBe(
        persisted,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the primary error when snapshot construction or persistence fails", async () => {
    const primary = new Error("original failure");
    const journal = createReaderObservationJournal([]);
    const owner = createOwnerEventBoundary([], []);
    const evidence: ReadAccessEvidenceState = { stage: "authorized_canary", canaryWrite: null };
    await expect(
      withReadAccessEvidence(
        [],
        journal,
        owner,
        firstProbeId,
        evidence,
        async () => {
          throw primary;
        },
        {},
      ),
    ).rejects.toBe(primary);
    const directory = mkdtempSync(join(tmpdir(), "wp015-read-access-evidence-"));
    try {
      const environment = {
        WP015_HTTP_REPORT: join(directory, "missing", "http-owner-2.json"),
        WP015_HTTP_RUN_ID: `http-2-${"b".repeat(32)}`,
      };
      await expect(
        withReadAccessEvidence(
          [],
          journal,
          owner,
          firstProbeId,
          evidence,
          async () => {
            throw primary;
          },
          environment,
        ),
      ).rejects.toBe(primary);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores a known baseline event that arrives after a probe", () => {
    const boundary = createOwnerEventBoundary([baselineId], [firstProbeId, secondProbeId]);
    recordOwnerMessageEvent(boundary, event(firstProbeId), conversationId);
    recordOwnerMessageEvent(boundary, event(baselineId), conversationId);
    expect(() => assertOwnerProbeStage(boundary, [firstProbeId])).not.toThrow();
  });

  it("deduplicates repeated delivery of the same probe ID", () => {
    const boundary = createOwnerEventBoundary([], [firstProbeId]);
    recordOwnerMessageEvent(boundary, event(firstProbeId), conversationId);
    recordOwnerMessageEvent(boundary, event(firstProbeId), conversationId);
    expect(boundary.receivedProbeMessageIds).toEqual(new Set([firstProbeId]));
    expect(boundary.eventSequence).toEqual([`owner-message-${firstProbeId}`]);
  });

  it("rejects an unknown owner message ID", () => {
    const boundary = createOwnerEventBoundary([], [firstProbeId]);
    recordOwnerMessageEvent(
      boundary,
      event("00000000-0000-4000-8000-000000012599"),
      conversationId,
    );
    expect(() => assertOwnerProbeStage(boundary, [])).toThrow("unexpected_owner_message");
  });

  it("rejects malformed payloads and conversation mismatches", () => {
    const boundary = createOwnerEventBoundary([], [firstProbeId]);
    recordOwnerMessageEvent(boundary, { new: { conversation_id: conversationId } }, conversationId);
    recordOwnerMessageEvent(
      boundary,
      event(firstProbeId, "00000000-0000-4000-8000-000000012598"),
      conversationId,
    );
    expect(() => assertOwnerProbeStage(boundary, [])).toThrow("invalid_message_id");
    expect(boundary.failures).toContain("message_conversation_mismatch");
  });

  it("rejects a missing expected probe", () => {
    const boundary = createOwnerEventBoundary([], [firstProbeId]);
    expect(() => assertOwnerProbeStage(boundary, [firstProbeId])).toThrow(
      "owner_probe_set_mismatch",
    );
  });

  it("classifies a known baseline by the authorization phase in which it is observed", () => {
    const journal = createReaderObservationJournal([[baselineId, "baseline"]]);
    recordReaderMessageEvent(journal, "original", event(baselineId), conversationId);
    expect(journal.events[0]?.classification).toBe("authorized");

    setReaderObservationPhase(journal, "revoke_acknowledged");
    recordReaderMessageEvent(journal, "original", event(baselineId), conversationId);
    expect(journal.events[1]?.classification).toBe("forbidden");
    expect(() => assertReaderObservationJournal(journal)).toThrow(
      "reader_content_after_revoke_acknowledgement",
    );
  });

  it("retains in-flight content as ambiguous evidence", () => {
    const journal = createReaderObservationJournal([[firstProbeId, "post_revoke_probe"]]);
    setReaderObservationPhase(journal, "revoke_in_flight");
    recordReaderMessageEvent(journal, "original", event(firstProbeId), conversationId);
    expect(journal.events[0]?.classification).toBe("ambiguous");
    expect(() => assertReaderObservationJournal(journal)).toThrow(
      "reader_content_during_revoke_in_flight",
    );
  });

  it("rejects unknown, malformed, and mismatched reader events in every phase", () => {
    const journal = createReaderObservationJournal([[firstProbeId, "post_revoke_probe"]]);
    recordReaderMessageEvent(
      journal,
      "original",
      event("00000000-0000-4000-8000-000000012599"),
      conversationId,
    );
    setReaderObservationPhase(journal, "revoke_acknowledged");
    recordReaderMessageEvent(journal, "original", { new: {} }, conversationId);
    setReaderObservationPhase(journal, "reconnect");
    recordReaderMessageEvent(
      journal,
      "reconnect",
      event(firstProbeId, "00000000-0000-4000-8000-000000012598"),
      conversationId,
    );
    expect(() => assertReaderObservationJournal(journal)).toThrow("reader_event_contract_failure");
  });

  it("rejects a forbidden probe on the original channel while reconnect is observed", () => {
    const journal = createReaderObservationJournal([[secondProbeId, "reconnect_probe"]]);
    setReaderObservationPhase(journal, "reconnect");
    recordReaderMessageEvent(journal, "original", event(secondProbeId), conversationId);
    expect(journal.events[0]).toMatchObject({
      channel: "original",
      phase: "reconnect",
      classification: "forbidden",
    });
    expect(() => assertReaderObservationJournal(journal)).toThrow(
      "reader_content_after_revoke_acknowledgement",
    );
  });

  it("includes an event that arrives after an intermediate observation", () => {
    const journal = createReaderObservationJournal([[secondProbeId, "reconnect_probe"]]);
    setReaderObservationPhase(journal, "reconnect");
    expect(journal.events).toEqual([]);
    recordReaderMessageEvent(journal, "reconnect", event(secondProbeId), conversationId);
    expect(() => assertReaderObservationJournal(journal)).toThrow(
      "reader_content_after_revoke_acknowledgement",
    );
  });

  it("attempts every channel and fixture cleanup after an early failure", async () => {
    const attempts: string[] = [];
    const registry: ChannelCleanup[] = [
      { label: "first", close: async () => void attempts.push("first") },
      {
        label: "failing",
        close: async () => {
          attempts.push("failing");
          throw new Error("synthetic_cleanup_failure");
        },
      },
      { label: "last", close: async () => void attempts.push("last") },
    ];
    await expect(
      runSuiteCleanup(registry, async () => void attempts.push("fixtures")),
    ).rejects.toThrow("WP01.5 cleanup incomplete");
    expect(attempts).toEqual(["first", "failing", "last", "fixtures"]);
    expect(registry).toEqual([]);
  });
});

suite("WP01.5 HTTP and Realtime revocation", () => {
  let service: HttpClient;
  let owner: HttpClient;
  let reader: HttpClient;
  let adminClient: HttpClient;
  const channelCleanups: ChannelCleanup[] = [];
  const users: Array<{ id: string; email: string }> = [];
  let readerUserId = "";
  let ownerBaselineMessageIds: ReadonlySet<string> = new Set();

  beforeAll(async () => {
    service = createServiceClient();
    const clientUser = await createSyntheticUser(
      service,
      `${prefix}-client@example.invalid`,
      (user) => users.push({ id: user.id, email: user.email! }),
    );
    const ownerUser = await createSyntheticUser(
      service,
      `${prefix}-owner@example.invalid`,
      (user) => users.push({ id: user.id, email: user.email! }),
    );
    const readerUser = await createSyntheticUser(
      service,
      `${prefix}-reader@example.invalid`,
      (user) => users.push({ id: user.id, email: user.email! }),
    );
    const adminUser = await createSyntheticUser(
      service,
      `${prefix}-admin@example.invalid`,
      (user) => users.push({ id: user.id, email: user.email! }),
    );
    readerUserId = readerUser.user.id;
    await Promise.all([
      setRole(service, ownerUser.user.id, "operator"),
      setRole(service, readerUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "admin"),
    ]);
    await Promise.all([
      seedOperator(service, ids.ownerOperator, ownerUser.user.id, "WP01.5 owner"),
      seedOperator(service, ids.readerOperator, readerUser.user.id, "WP01.5 reader"),
      seedOperator(service, ids.adminOperator, adminUser.user.id, "WP01.5 admin"),
    ]);
    await seedCharacter(service, ids.character, "WP01.5 HTTP character");
    await Promise.all([
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.ownerOperator,
      }),
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.readerOperator,
      }),
    ]);
    await seedConversation(service, ids.conversation, clientUser.user.id, ids.character);
    await seedClientMessage(
      service,
      ids.firstMessage,
      ids.conversation,
      clientUser.user.id,
      "WP01.5 initial history",
    );
    owner = await signInSyntheticUser(`${prefix}-owner@example.invalid`, ownerUser.password);
    reader = await signInSyntheticUser(`${prefix}-reader@example.invalid`, readerUser.password);
    adminClient = await signInSyntheticUser(`${prefix}-admin@example.invalid`, adminUser.password);
    const claim = await owner.rpc("send_operator_message", {
      _conversation_id: ids.conversation,
      _content: "WP01.5 owner claim",
      _expected_cycle_id: null,
    });
    if (claim.error) throw claim.error;
    const claimMessageId = readRpcMessageId(claim.data);
    await insertRow(service, "character_media_assets", {
      id: ids.mediaAsset,
      character_id: ids.character,
      source_path: `${prefix}/source.webp`,
      preview_path: `${prefix}/preview.webp`,
      status: "sent",
      ingest_status: "ready",
      content_type: "image/webp",
      byte_size: 12,
      width: 1,
      height: 1,
      preview_generated_at: new Date().toISOString(),
    });
    await insertRow(service, "character_media_reservations", {
      id: ids.mediaReservation,
      media_asset_id: ids.mediaAsset,
      conversation_id: ids.conversation,
      client_id: clientUser.user.id,
      operator_id: ids.ownerOperator,
      reserved_by_user_id: ownerUser.user.id,
      previous_asset_status: "available",
      state: "consumed",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ended_at: new Date().toISOString(),
      ended_by_user_id: ownerUser.user.id,
      ended_reason: "sent",
    });
    await seedClientMessage(
      service,
      ids.mediaMessage,
      ids.conversation,
      clientUser.user.id,
      "[image]",
    );
    await insertRow(service, "message_attachments", {
      id: ids.mediaAttachment,
      message_id: ids.mediaMessage,
      media_asset_id: ids.mediaAsset,
      reservation_id: ids.mediaReservation,
      kind: "image",
    });
    const baseline = await service
      .from("messages")
      .select("id, conversation_id, content")
      .eq("conversation_id", ids.conversation);
    expect(baseline.error).toBeNull();
    const baselineRows = baseline.data ?? [];
    const expectedBaselineIds = new Set([ids.firstMessage, claimMessageId, ids.mediaMessage]);
    expect(new Set(baselineRows.map((row) => row.id))).toEqual(expectedBaselineIds);
    expect(
      baselineRows.find((row) => row.id === claimMessageId && row.content === "WP01.5 owner claim"),
    ).toBeDefined();
    expect(baselineRows.every((row) => row.conversation_id === ids.conversation)).toBe(true);
    ownerBaselineMessageIds = expectedBaselineIds;
  });

  afterAll(async () => {
    await runSuiteCleanup(
      channelCleanups,
      service
        ? () =>
            runCleanupSteps([
              {
                label: "fixture events",
                run: () =>
                  deleteFixtureEventsForOwnership(service, [
                    ...Object.values(ids),
                    ...users.map((user) => user.id),
                  ]),
              },
              {
                label: "presence",
                run: () =>
                  deleteByEq(
                    service,
                    "conversation_presence_states",
                    "conversation_id",
                    ids.conversation,
                  ),
              },
              {
                label: "notes",
                run: () =>
                  deleteByEq(service, "internal_notes", "conversation_id", ids.conversation),
              },
              {
                label: "customer info",
                run: () =>
                  deleteByEq(service, "customer_info_entries", "conversation_id", ids.conversation),
              },
              {
                label: "attachment",
                run: () => deleteByEq(service, "message_attachments", "id", ids.mediaAttachment),
              },
              {
                label: "client level transitions",
                run: () =>
                  deleteByEq(service, "client_level_transitions", "client_id", users[0].id),
              },
              ...[ids.ownerOperator, ids.readerOperator, ids.adminOperator].flatMap((id) => [
                {
                  label: `operator point transactions ${id}`,
                  run: () => deleteByEq(service, "operator_point_transactions", "operator_id", id),
                },
                {
                  label: `operator score events ${id}`,
                  run: () => deleteByEq(service, "operator_score_events", "operator_id", id),
                },
                {
                  label: `operator point wallet ${id}`,
                  run: () => deleteByEq(service, "operator_point_wallets", "operator_id", id),
                },
              ]),
              {
                label: "messages",
                run: () => deleteByEq(service, "messages", "conversation_id", ids.conversation),
              },
              {
                label: "reservation",
                run: () =>
                  deleteByEq(service, "character_media_reservations", "id", ids.mediaReservation),
              },
              {
                label: "asset",
                run: () => deleteByEq(service, "character_media_assets", "id", ids.mediaAsset),
              },
              {
                label: "cycles",
                run: () =>
                  deleteByEq(
                    service,
                    "conversation_handling_cycles",
                    "conversation_id",
                    ids.conversation,
                  ),
              },
              {
                label: "work items",
                run: () =>
                  deleteByEq(
                    service,
                    "conversation_work_items",
                    "conversation_id",
                    ids.conversation,
                  ),
              },
              {
                label: "assignments",
                run: () =>
                  deleteByEq(
                    service,
                    "character_operator_assignments",
                    "character_id",
                    ids.character,
                  ),
              },
              {
                label: "conversation",
                run: () => deleteByEq(service, "conversations", "id", ids.conversation),
              },
              {
                label: "character",
                run: () => deleteByEq(service, "characters", "id", ids.character),
              },
              ...[ids.ownerOperator, ids.readerOperator, ids.adminOperator].map((id) => ({
                label: `operator ${id}`,
                run: () => deleteByEq(service, "operators", "id", id),
              })),
              ...users.map((user) => ({
                label: `auth user ${user.id}`,
                run: () => deleteAuthUser(service, user.id),
              })),
            ])
        : undefined,
    );
  });

  it("keeps co-assigned non-owner read-only while preserving owner and Admin writes", async () => {
    const access = await reader.rpc("get_conversation_read_access", {
      _conversation_id: ids.conversation,
    });
    expect(access.error).toBeNull();
    expect(access.data?.[0]?.allowed).toBe(true);
    const history = await reader
      .from("messages")
      .select("id")
      .eq("conversation_id", ids.conversation);
    expect(history.error).toBeNull();
    expect(history.data?.length).toBeGreaterThanOrEqual(2);
    const mediaPath = await service.rpc("resolve_character_media_preview_path_for_server", {
      _actor_user_id: readerUserId,
      _target_kind: "message_attachment",
      _target_id: ids.mediaAttachment,
    });
    expect(mediaPath.error).toBeNull();
    expect(mediaPath.data).toBe(`${prefix}/preview.webp`);
    const attachmentAccess = await reader.rpc("get_message_attachment_access", {
      _attachment_ids: [ids.mediaAttachment],
    });
    expect(attachmentAccess.error).toBeNull();
    expect(attachmentAccess.data).toEqual([
      expect.objectContaining({
        attachment_id: ids.mediaAttachment,
        view_mode: "permanent",
        required_gift_id: null,
        available_purchase_id: null,
      }),
    ]);
    const attachmentMedia = await service.rpc("resolve_message_attachment_media_for_server", {
      _actor_user_id: readerUserId,
      _attachment_id: ids.mediaAttachment,
    });
    expect(attachmentMedia.error).toBeNull();
    expect(attachmentMedia.data).toMatchObject({ path: `${prefix}/preview.webp` });
    const clientProfile = await reader.rpc("get_operator_conversation_client_profile", {
      _conversation_id: ids.conversation,
    });
    expect(clientProfile.error).toBeNull();
    const forgedPresence = await reader.rpc("set_conversation_presence", {
      _conversation_id: ids.conversation,
      _role: "admin",
      _display_name: "forged admin",
      _active: true,
      _typing: false,
    });
    expect(forgedPresence.error?.message).toContain("presence_identity_mismatch");
    const readerWrite = await reader.rpc("add_operator_internal_note", {
      _conversation_id: ids.conversation,
      _note: "must fail",
    });
    expect(readerWrite.error?.message).toContain("conversation_locked_by_other_operator");
    const adminWrite = await adminClient.rpc("add_operator_internal_note", {
      _conversation_id: ids.conversation,
      _note: "admin contract",
    });
    expect(adminWrite.error).toBeNull();
  });

  it("revokes an already-connected reader and RLS withholds post-commit content", async () => {
    const sentAccessVersions = new Set<number>();
    const receivedAccessVersions = new Set<number>();
    const eventSequence: string[] = [];
    const readerJournal = createReaderObservationJournal([
      ...[...ownerBaselineMessageIds].map((messageId) => [messageId, "baseline"] as const),
      [ids.readerCanary, "authorized_canary"],
      [ids.revokedMessage, "post_revoke_probe"],
      [ids.reconnectMessage, "reconnect_probe"],
    ]);
    const ownerBoundary = createOwnerEventBoundary(
      ownerBaselineMessageIds,
      [ids.readerCanary, ids.revokedMessage, ids.reconnectMessage],
      eventSequence,
    );
    const observations: ChannelObservation[] = [];
    const evidence: ReadAccessEvidenceState = { stage: "subscriptions", canaryWrite: null };
    await withReadAccessEvidence(
      observations,
      readerJournal,
      ownerBoundary,
      ids.readerCanary,
      evidence,
      async () => {
        await insertRow(service, "customer_info_entries", {
          client_id: users[0].id,
          conversation_id: ids.conversation,
          operator_id: ids.readerOperator,
          created_by_user_id: readerUserId,
          content: `${prefix}-reader-authored-crm`,
        });
        const accessChannel = registerChannelCleanup(
          channelCleanups,
          "reader-access",
          reader,
          reader.channel(`wp01-5-access-${readerUserId}`).on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "user_conversation_access_versions",
              filter: `user_id=eq.${readerUserId}`,
            },
            (payload) => {
              const version = Number(payload.new.version);
              if (Number.isSafeInteger(version)) {
                receivedAccessVersions.add(version);
                eventSequence.push(`access-version-${version}`);
              }
            },
          ),
        );
        const messageChannel = registerChannelCleanup(
          channelCleanups,
          "reader-messages",
          reader,
          reader.channel(`wp01-5-messages-${ids.conversation}`).on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `conversation_id=eq.${ids.conversation}`,
            },
            (payload) =>
              recordReaderMessageEvent(readerJournal, "original", payload, ids.conversation),
          ),
        );
        const ownerChannel = registerChannelCleanup(
          channelCleanups,
          "owner-messages",
          owner,
          owner.channel(`wp01-5-owner-${ids.conversation}`).on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `conversation_id=eq.${ids.conversation}`,
            },
            (payload) => recordOwnerMessageEvent(ownerBoundary, payload, ids.conversation),
          ),
        );
        const readinessStartedAt = Date.now();
        const readinessDeadline = readinessStartedAt + 20_000;
        observations.push(
          subscribeObservedChannel(accessChannel, "reader-access"),
          subscribeObservedChannel(messageChannel, "reader-messages"),
          subscribeObservedChannel(ownerChannel, "owner-messages"),
        );
        await waitForChannelsReady(observations, readinessDeadline);
        evidence.stage = "replication_readiness";

        const accessVersionBeforeReadiness = await service
          .from("user_conversation_access_versions")
          .select("version")
          .eq("user_id", readerUserId)
          .single();
        expect(accessVersionBeforeReadiness.error).toBeNull();
        let nextCanaryVersion = Number(accessVersionBeforeReadiness.data?.version);
        expect(Number.isSafeInteger(nextCanaryVersion)).toBe(true);
        let readinessAttempts = 0;
        let receivedCanaryVersion: number | undefined;
        while (
          receivedCanaryVersion === undefined &&
          readinessAttempts < 20 &&
          Date.now() < readinessDeadline
        ) {
          assertChannelsHealthy(observations);
          const attemptStartedAt = Date.now();
          nextCanaryVersion += 1;
          readinessAttempts += 1;
          sentAccessVersions.add(nextCanaryVersion);
          const canary = await service
            .from("user_conversation_access_versions")
            .update({ version: nextCanaryVersion, updated_at: new Date().toISOString() })
            .eq("user_id", readerUserId);
          expect(canary.error).toBeNull();
          const attemptDeadline = Math.min(attemptStartedAt + 1_000, readinessDeadline);
          while (receivedCanaryVersion === undefined && Date.now() < attemptDeadline) {
            assertChannelsHealthy(observations);
            receivedCanaryVersion = [...receivedAccessVersions].find((version) =>
              sentAccessVersions.has(version),
            );
            if (receivedCanaryVersion === undefined) await delay(50);
          }
        }
        const readinessElapsedMs = Date.now() - readinessStartedAt;
        if (receivedCanaryVersion === undefined) {
          throw new Error(
            `realtime_replication_readiness_not_established attempts=${readinessAttempts} elapsed_ms=${readinessElapsedMs}`,
          );
        }
        console.info(
          `WP01.5 realtime readiness established attempts=${readinessAttempts} elapsed_ms=${readinessElapsedMs}`,
        );

        evidence.stage = "authorized_canary";
        await writeCanaryWhenReady(observations, evidence, () =>
          insertRow(service, "messages", {
            id: ids.readerCanary,
            conversation_id: ids.conversation,
            sender_type: "client",
            sender_id: users[0].id,
            content: "authorized reader canary",
          }),
        );
        await waitUntil(() => {
          assertChannelsHealthy(observations);
          return (
            hasReaderObservedMessage(readerJournal, ids.readerCanary, "original") &&
            ownerBoundary.receivedProbeMessageIds.has(ids.readerCanary)
          );
        }, 10_000);
        expect(hasReaderObservedMessage(readerJournal, ids.readerCanary, "original")).toBe(true);
        expect(() => assertOwnerProbeStage(ownerBoundary, [ids.readerCanary])).not.toThrow();
        const canaryRows = await service.from("messages").select("id").eq("id", ids.readerCanary);
        expect(canaryRows.error).toBeNull();
        expect(canaryRows.data).toEqual([{ id: ids.readerCanary }]);

        const accessVersionBeforeRevoke = await service
          .from("user_conversation_access_versions")
          .select("version")
          .eq("user_id", readerUserId)
          .single();
        expect(accessVersionBeforeRevoke.error).toBeNull();
        const canonicalVersionBeforeRevoke = Number(accessVersionBeforeRevoke.data?.version);
        expect(canonicalVersionBeforeRevoke).toBe(nextCanaryVersion);

        evidence.stage = "revoke";
        assertChannelsHealthy(observations);
        setReaderObservationPhase(readerJournal, "revoke_in_flight");
        const revoke = await service
          .from("character_operator_assignments")
          .delete()
          .eq("character_id", ids.character)
          .eq("operator_id", ids.readerOperator);
        expect(revoke.error).toBeNull();
        setReaderObservationPhase(readerJournal, "revoke_acknowledged");
        const accessVersionAfterRevoke = await service
          .from("user_conversation_access_versions")
          .select("version")
          .eq("user_id", readerUserId)
          .single();
        expect(accessVersionAfterRevoke.error).toBeNull();
        const revokeVersion = Number(accessVersionAfterRevoke.data?.version);
        expect(revokeVersion).toBeGreaterThan(canonicalVersionBeforeRevoke);
        evidence.stage = "access_version_notification";
        await waitUntil(() => {
          assertChannelsHealthy(observations);
          return receivedAccessVersions.has(revokeVersion);
        }, 10_000);
        expect(receivedAccessVersions.has(revokeVersion)).toBe(true);
        setReaderObservationPhase(readerJournal, "access_version_observed");
        evidence.stage = "rpc_rls_denial";
        const denied = await reader.rpc("get_conversation_read_access", {
          _conversation_id: ids.conversation,
        });
        expect(denied.data?.[0]?.allowed).toBe(false);
        const deniedProfile = await reader.rpc("get_operator_conversation_client_profile", {
          _conversation_id: ids.conversation,
        });
        expect(deniedProfile.error?.message).toContain("conversation_read_forbidden");
        const hiddenCrm = await reader
          .from("customer_info_entries")
          .select("id")
          .eq("content", `${prefix}-reader-authored-crm`);
        expect(hiddenCrm.error).toBeNull();
        expect(hiddenCrm.data).toEqual([]);
        evidence.stage = "post_revoke_delivery";
        assertChannelsReady(observations);
        await insertRow(service, "messages", {
          id: ids.revokedMessage,
          conversation_id: ids.conversation,
          sender_type: "client",
          sender_id: users[0].id,
          content: "post-revoke secret",
        });
        await waitUntil(() => {
          assertChannelsHealthy(observations);
          return ownerBoundary.receivedProbeMessageIds.has(ids.revokedMessage);
        }, 10_000);
        expect(() =>
          assertOwnerProbeStage(ownerBoundary, [ids.readerCanary, ids.revokedMessage]),
        ).not.toThrow();
        const revokedMessageRows = await service
          .from("messages")
          .select("id")
          .eq("id", ids.revokedMessage);
        expect(revokedMessageRows.error).toBeNull();
        expect(revokedMessageRows.data).toEqual([{ id: ids.revokedMessage }]);
        const hidden = await reader.from("messages").select("id").eq("id", ids.revokedMessage);
        expect(hidden.error).toBeNull();
        expect(hidden.data).toEqual([]);
        evidence.stage = "rpc_rls_denial";
        const renewedMediaPath = await service.rpc(
          "resolve_character_media_preview_path_for_server",
          {
            _actor_user_id: readerUserId,
            _target_kind: "message_attachment",
            _target_id: ids.mediaAttachment,
          },
        );
        expect(renewedMediaPath.error).toBeNull();
        expect(renewedMediaPath.data).toBeNull();
        const deniedAttachmentAccess = await reader.rpc("get_message_attachment_access", {
          _attachment_ids: [ids.mediaAttachment],
        });
        expect(deniedAttachmentAccess.error).toBeNull();
        expect(deniedAttachmentAccess.data).toEqual([]);
        const deniedAttachmentMedia = await service.rpc(
          "resolve_message_attachment_media_for_server",
          {
            _actor_user_id: readerUserId,
            _attachment_id: ids.mediaAttachment,
          },
        );
        expect(deniedAttachmentMedia.error).toBeNull();
        expect(deniedAttachmentMedia.data).toBeNull();
        const presence = await reader.rpc("set_conversation_presence", {
          _conversation_id: ids.conversation,
          _role: "operator",
          _display_name: "revoked",
          _active: true,
          _typing: true,
        });
        expect(presence.error?.message).toContain("conversation_read_forbidden");
        evidence.stage = "reconnect";
        setReaderObservationPhase(readerJournal, "reconnect");
        const reconnectChannel = registerChannelCleanup(
          channelCleanups,
          "reader-reconnect",
          reader,
          reader.channel(`wp01-5-reconnect-${readerUserId}`).on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `conversation_id=eq.${ids.conversation}`,
            },
            (payload) =>
              recordReaderMessageEvent(readerJournal, "reconnect", payload, ids.conversation),
          ),
        );
        const reconnectDeadline = Date.now() + 10_000;
        observations.push(subscribeObservedChannel(reconnectChannel, "reader-reconnect"));
        await waitForChannelsReady(observations, reconnectDeadline);
        await insertRow(service, "messages", {
          id: ids.reconnectMessage,
          conversation_id: ids.conversation,
          sender_type: "client",
          sender_id: users[0].id,
          content: "post-reconnect secret",
        });
        await waitUntil(
          () => {
            assertChannelsHealthy(observations);
            return ownerBoundary.receivedProbeMessageIds.has(ids.reconnectMessage);
          },
          Math.max(0, reconnectDeadline - Date.now()),
        );
        expect(() =>
          assertOwnerProbeStage(ownerBoundary, [
            ids.readerCanary,
            ids.revokedMessage,
            ids.reconnectMessage,
          ]),
        ).not.toThrow();
        const expectedOwnerMessageIds = [ids.revokedMessage, ids.reconnectMessage];
        const ownerMessageRows = await service
          .from("messages")
          .select("id")
          .in("id", expectedOwnerMessageIds);
        expect(ownerMessageRows.error).toBeNull();
        expect(ownerMessageRows.data).toHaveLength(2);
        for (const messageId of expectedOwnerMessageIds) {
          expect(ownerMessageRows.data?.filter((row) => row.id === messageId)).toHaveLength(1);
        }
        await delay(1_500);
        assertChannelsHealthy(observations);
        evidence.stage = "cleanup";
        await closeRegisteredChannels(channelCleanups);
        evidence.stage = "stale_event_checks";
        expect(receivedAccessVersions.has(revokeVersion)).toBe(true);
        expect(eventSequence.indexOf(`access-version-${revokeVersion}`)).toBeGreaterThanOrEqual(0);
        expect(eventSequence.indexOf(`owner-message-${ids.revokedMessage}`)).toBeGreaterThan(
          eventSequence.indexOf(`access-version-${revokeVersion}`),
        );
        console.info(
          `WP01.5 reader observation timeline ${formatReaderObservationTimeline(readerJournal)}`,
        );
        expect(() => assertReaderObservationJournal(readerJournal)).not.toThrow();
        assertChannelsHealthy(observations);
      },
    );
  }, 60_000);
});
