import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { runDeletionWorkflowStep, type DeletionKind } from "./orchestration.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(404, { code: "not_found" });
  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !service || request.headers.get("Authorization") !== `Bearer ${service}`) {
    return json(401, { code: "unauthorized" });
  }
  if (Deno.env.get("DELETION_WORKFLOW_ENABLED") !== "true") {
    return json(503, { code: "deletion_workflow_disabled" });
  }
  const trusted = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const body = (await request.json()) as { kind?: DeletionKind; request_id?: string };
    if (!body.request_id || !["account", "conversation"].includes(body.kind ?? "")) {
      return json(400, { code: "invalid_deletion_request" });
    }
    const kind = body.kind as DeletionKind;
    const result = await runDeletionWorkflowStep(
      {
        async claim(requestKind, requestId) {
          const rpc =
            requestKind === "account"
              ? "claim_account_deletion_step_for_server"
              : "claim_conversation_deletion_step_for_server";
          const { data, error } = await trusted.rpc(rpc, { _request_id: requestId });
          if (error) throw new Error("deletion_claim_failed");
          return Array.isArray(data) ? (data[0] ?? null) : null;
        },
        async executeDatabase(requestKind, requestId, claimToken) {
          const rpc =
            requestKind === "account"
              ? "execute_account_deletion_database_step_for_server"
              : "execute_conversation_deletion_database_step_for_server";
          const { data, error } = await trusted.rpc(rpc, {
            _request_id: requestId,
            _claim_token: claimToken,
          });
          if (error || !data || typeof data !== "object")
            throw new Error("database_deletion_failed");
          return data as Record<string, unknown>;
        },
        async listStorage(requestKind, requestId, claimToken) {
          const { data, error } = await trusted.rpc("list_deletion_storage_objects_for_server", {
            _request_kind: requestKind,
            _request_id: requestId,
            _claim_token: claimToken,
          });
          if (error) throw new Error("storage_manifest_failed");
          return data ?? [];
        },
        async removeStorage(bucketId, objectPath) {
          const { error } = await trusted.storage.from(bucketId).remove([objectPath]);
          if (error) throw new Error("storage_delete_failed");
        },
        async storageObjectExists(bucketId, objectPath) {
          const separator = objectPath.lastIndexOf("/");
          const folder = separator < 0 ? "" : objectPath.slice(0, separator);
          const name = separator < 0 ? objectPath : objectPath.slice(separator + 1);
          const { data, error } = await trusted.storage
            .from(bucketId)
            .list(folder, { limit: 2, search: name });
          if (error) throw new Error("storage_verification_failed");
          return (data ?? []).some((entry) => entry.name === name);
        },
        async completeStorageObject(requestKind, requestId, claimToken, object) {
          const { error } = await trusted.rpc("complete_deletion_storage_object_for_server", {
            _request_kind: requestKind,
            _request_id: requestId,
            _claim_token: claimToken,
            _bucket_id: object.bucket_id,
            _object_path: object.object_path,
          });
          if (error) throw new Error("storage_evidence_persistence_failed");
        },
        async summarizeStorage(requestKind, requestId, claimToken) {
          const { data, error } = await trusted.rpc("summarize_deletion_storage_step_for_server", {
            _request_kind: requestKind,
            _request_id: requestId,
            _claim_token: claimToken,
          });
          if (error || !data || typeof data !== "object") throw new Error("storage_summary_failed");
          return data as Record<string, unknown>;
        },
        async executeRetentionMinimization(requestId, claimToken) {
          const { data, error } = await trusted.rpc(
            "execute_account_retention_minimization_for_server",
            {
              _request_id: requestId,
              _claim_token: claimToken,
            },
          );
          if (error || !data || typeof data !== "object")
            throw new Error("retention_minimization_failed");
          return data as Record<string, unknown>;
        },
        async blockRetention(requestId, claimToken, evidence) {
          const { error } = await trusted.rpc(
            "block_account_retention_minimization_for_server",
            {
              _request_id: requestId,
              _claim_token: claimToken,
              _evidence: evidence,
            },
          );
          if (error) throw new Error("retention_block_persistence_failed");
        },
        async getAccountSubject(requestId, stepName, claimToken) {
          const { data, error } = await trusted.rpc("get_account_deletion_subject_for_server", {
            _request_id: requestId,
            _step_name: stepName,
            _claim_token: claimToken,
          });
          if (error || typeof data !== "string") throw new Error("auth_deletion_subject_failed");
          return data;
        },
        async softDeleteAuthUser(userId) {
          const { error } = await trusted.auth.admin.deleteUser(userId, true);
          if (error) throw new Error("auth_soft_delete_failed");
        },
        async recordFinalization(requestKind, requestId, claimToken) {
          const { data, error } = await trusted.rpc("record_deletion_completion_for_server", {
            _request_kind: requestKind,
            _request_id: requestId,
            _claim_token: claimToken,
          });
          if (error || !data || typeof data !== "object")
            throw new Error("deletion_finalization_failed");
          return data as Record<string, unknown>;
        },
        async complete(requestKind, requestId, stepName, claimToken, evidence) {
          const rpc =
            requestKind === "account"
              ? "complete_account_deletion_step_for_server"
              : "complete_conversation_deletion_step_for_server";
          const { error } = await trusted.rpc(rpc, {
            _request_id: requestId,
            _step_name: stepName,
            _claim_token: claimToken,
            _evidence: evidence,
          });
          if (error) throw new Error("deletion_completion_failed");
        },
        async fail(requestKind, requestId, stepName, claimToken, failureCode) {
          const rpc =
            requestKind === "account"
              ? "fail_account_deletion_step_for_server"
              : "fail_conversation_deletion_step_for_server";
          const { error } = await trusted.rpc(rpc, {
            _request_id: requestId,
            _step_name: stepName,
            _claim_token: claimToken,
            _failure_code: failureCode,
          });
          if (error) throw new Error("deletion_failure_persistence_failed");
        },
      },
      kind,
      body.request_id,
    );
    return json(200, result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "deletion_workflow_failed";
    return json(500, { code });
  }
});
