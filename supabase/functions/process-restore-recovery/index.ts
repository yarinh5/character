import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { runRestoreRecoveryImport, type RestoreRecoveryImport } from "./orchestration.ts";
import {
  readRecoveryConnectionConfig,
  validateRecoveryEnvelopeConfiguration,
} from "../_shared/configuration-connections.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");

async function validSignature(raw: string, signature: string, secret: string) {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.toLowerCase().charCodeAt(index);
  }
  return mismatch === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(404, { code: "not_found" });
  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const hmacKey = Deno.env.get("RESTORE_RECOVERY_AUTHORITY_HMAC_KEY");
  const recoveryConfig = readRecoveryConnectionConfig({
    RESTORE_RECOVERY_AUTHORITY_HMAC_KEY: hmacKey,
    RESTORE_RECOVERY_EXPECTED_LOCK_ID: Deno.env.get("RESTORE_RECOVERY_EXPECTED_LOCK_ID"),
    RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID: Deno.env.get(
      "RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID",
    ),
    RESTORE_RECOVERY_CONTRACT_VERSION: Deno.env.get("RESTORE_RECOVERY_CONTRACT_VERSION"),
    RESTORE_RECOVERY_IMPORT_ENABLED: Deno.env.get("RESTORE_RECOVERY_IMPORT_ENABLED"),
    RESTORE_RECOVERY_RELEASE_ENABLED: Deno.env.get("RESTORE_RECOVERY_RELEASE_ENABLED"),
    RESTORE_RECOVERY_REPLAY_ENABLED: Deno.env.get("RESTORE_RECOVERY_REPLAY_ENABLED"),
  });
  if (!url || !service || !hmacKey || !recoveryConfig) {
    return json(503, { code: "recovery_authority_not_configured" });
  }
  if (request.headers.get("Authorization") !== `Bearer ${service}`) {
    return json(401, { code: "unauthorized" });
  }
  const raw = await request.text();
  const signature = request.headers.get("x-recovery-signature") ?? "";
  if (!(await validSignature(raw, signature, hmacKey))) {
    return json(401, { code: "recovery_external_authority_unverified" });
  }

  let body: {
    action?: string;
    payload?: RestoreRecoveryImport | {
      eventId: string;
      eventVersion: number;
      contractVersion: string;
      externalLockId: string;
      externalAuthorityId: string;
      releaseEvidenceHash: string;
    };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { code: "invalid_json" });
  }
  if (!body.payload || !["import", "release"].includes(body.action ?? "")) {
    return json(400, { code: "unsupported_recovery_action" });
  }
  const configurationFailure = validateRecoveryEnvelopeConfiguration(
    body.payload,
    recoveryConfig,
  );
  if (configurationFailure) {
    return json(409, { code: configurationFailure });
  }
  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await trusted.rpc(name, args);
    if (error) throw new Error(name.replace(/_for_server$/, "") + "_failed");
    return data;
  };
  if (body.action === "release") {
    if (!recoveryConfig.releaseEnabled) {
      return json(503, { code: "recovery_release_disabled" });
    }
    const release = body.payload as {
      eventId: string; eventVersion: number; externalLockId: string; releaseEvidenceHash: string;
      externalAuthorityId: string; contractVersion: string;
    };
    try {
      const status = await rpc("complete_restore_recovery_release_for_server", {
        _event_id: release.eventId,
        _event_version: release.eventVersion,
        _external_lock_id: release.externalLockId,
        _release_evidence_hash: release.releaseEvidenceHash,
      });
      return json(200, { status });
    } catch (error) {
      return json(409, { code: error instanceof Error ? error.message : "recovery_release_failed" });
    }
  }
  if (!recoveryConfig.importEnabled) {
    return json(503, { code: "recovery_import_disabled" });
  }
  const importPayload = body.payload as RestoreRecoveryImport;
  // Deletion replay is separately authorized and remains disabled by default.
  const replayEnabled = recoveryConfig.replayEnabled;
  try {
    const result = await runRestoreRecoveryImport(
      {
        verifyExternalEnvelope: async () => true,
        beginEvent: async (input) => {
          const data = await rpc("begin_restore_recovery_for_server", {
            _event_id: input.eventId,
            _external_lock_id: input.externalLockId,
            _external_authority_id: input.externalAuthorityId,
            _source_snapshot_id: input.sourceSnapshotId,
            _source_snapshot_at: input.sourceSnapshotAt,
            _owner_admin_id: input.ownerAdminId,
            _external_lock_evidence_hash: input.externalLockEvidenceHash,
          });
          return { eventVersion: Number((data as Array<{ event_version: number }>)[0].event_version) };
        },
        importAuthorityManifest: async (input, eventVersion) => {
          await rpc("import_restore_recovery_manifest_for_server", {
            _event_id: input.eventId, _event_version: eventVersion,
            _manifest_id: input.manifestId, _authority_id: input.externalAuthorityId,
            _sequence: input.sequence, _previous_manifest_hash: input.previousManifestHash,
            _manifest_hash: input.manifestHash, _coverage_through: input.coverageThrough,
            _generated_at: input.generatedAt, _deletion_coverage_complete: input.deletionCoverageComplete,
          });
        },
        recordReconciliation: async (eventId, eventVersion, entry) => {
          await rpc("record_restore_reconciliation_for_server", {
            _event_id: eventId, _event_version: eventVersion,
            _manifest_id: body.payload!.manifestId, _category: entry.category,
            _outcome: entry.outcome,
            _matched_count: entry.matchedCount, _gap_count: entry.gapCount,
            _unknown_count: entry.unknownCount, _evidence_hash: entry.evidenceHash,
          });
        },
        stageDeletionReplay: async (eventId, eventVersion, entry) => {
          await rpc("stage_restore_deletion_replay_for_server", {
            _event_id: eventId, _event_version: eventVersion,
            _manifest_id: body.payload!.manifestId,
            _request_kind: entry.requestKind, _request_id: entry.requestId,
            _policy_version: entry.policyVersion, _completed_at: entry.completedAt,
            _evidence_hash: entry.evidenceHash, _hold: entry.hold,
          });
        },
        finalizeImport: async (eventId, eventVersion) => {
          const data = await rpc("finalize_restore_recovery_import_for_server", {
            _event_id: eventId, _event_version: eventVersion,
          });
          const row = (data as Array<{ status: "blocked"; event_version: number }>)[0];
          if (!row) throw new Error("recovery_import_result_missing");
          return { status: row.status, eventVersion: row.event_version };
        },
        failImport: async (eventId, eventVersion, failureCode) => {
          await rpc("fail_restore_recovery_import_for_server", {
            _event_id: eventId, _event_version: eventVersion, _failure_code: failureCode,
          });
        },
      },
      importPayload,
      signature,
    );
    return json(200, {
      status: result.status,
      event_version: result.eventVersion,
      deletion_replay_enabled: replayEnabled,
    });
  } catch (error) {
    return json(409, { code: error instanceof Error ? error.message : "recovery_import_failed" });
  }
});

