import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  runClientMediaCleanup,
  type ClientMediaCleanupClaim,
  type ProfileImageCleanupClaim,
} from "./orchestration.ts";

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse(404, { code: "cleanup_not_available" });
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (
    !serviceRoleKey ||
    !supabaseUrl ||
    request.headers.get("Authorization") !== `Bearer ${serviceRoleKey}`
  ) {
    return jsonResponse(401, { code: "unauthorized" });
  }

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (Deno.env.get("CLIENT_MEDIA_CLEANUP_ENABLED") !== "true") {
    return jsonResponse(503, { code: "cleanup_disabled" });
  }

  try {
    const summary = await runClientMediaCleanup(
      {
        async claimClientMedia(limit) {
          const { data, error } = await trusted.rpc(
            "claim_expired_client_media_cleanup_for_server",
            { _limit: limit },
          );
          if (error) throw new Error("client_media_cleanup_claim_failed");
          return (data ?? []) as ClientMediaCleanupClaim[];
        },
        async claimProfileImages(limit) {
          const { data, error } = await trusted.rpc(
            "claim_client_profile_image_cleanup_for_server",
            { _limit: limit },
          );
          if (error) throw new Error("profile_image_cleanup_claim_failed");
          return (data ?? []) as ProfileImageCleanupClaim[];
        },
        async authorizeProfileImageRemoval(queueId, claimToken) {
          const { data, error } = await trusted.rpc(
            "authorize_client_profile_image_cleanup_for_server",
            { _queue_id: queueId, _claim_token: claimToken },
          );
          if (error || !data) throw new Error("profile_image_cleanup_authorization_failed");
          return data as "delete" | "retained" | "blocked";
        },
        async remove(bucketId, paths) {
          const { error } = await trusted.storage.from(bucketId).remove(paths);
          if (error) throw new Error("storage_cleanup_failed");
        },
        async objectExists(bucketId, path) {
          const separator = path.lastIndexOf("/");
          const folder = separator < 0 ? "" : path.slice(0, separator);
          const name = separator < 0 ? path : path.slice(separator + 1);
          for (let offset = 0; offset < 1_000; offset += 100) {
            const { data, error } = await trusted.storage
              .from(bucketId)
              .list(folder, { limit: 100, offset, search: name });
            if (error) throw new Error("storage_verification_failed");
            const entries = data ?? [];
            if (entries.some((entry) => entry.name === name)) return true;
            if (entries.length < 100) return false;
          }
          throw new Error("storage_verification_inconclusive");
        },
        async completeClientMedia(uploadId, claimToken) {
          const { error } = await trusted.rpc("complete_client_media_cleanup_for_server", {
            _upload_id: uploadId,
            _claim_token: claimToken,
          });
          if (error) throw new Error("client_media_cleanup_persistence_failed");
        },
        async failClientMedia(uploadId, claimToken, errorCode) {
          const { error } = await trusted.rpc("fail_client_media_cleanup_for_server", {
            _upload_id: uploadId,
            _claim_token: claimToken,
            _error_code: errorCode,
          });
          if (error) throw new Error("client_media_cleanup_failure_persistence_failed");
        },
        async completeProfileImage(queueId, claimToken) {
          const { data, error } = await trusted.rpc(
            "complete_client_profile_image_cleanup_for_server",
            { _queue_id: queueId, _claim_token: claimToken },
          );
          if (error || !data) throw new Error("profile_image_cleanup_persistence_failed");
          return data as "deleted" | "retained" | "blocked";
        },
        async failProfileImage(queueId, claimToken, errorCode) {
          const { error } = await trusted.rpc("fail_client_profile_image_cleanup_for_server", {
            _queue_id: queueId,
            _claim_token: claimToken,
            _error_code: errorCode,
          });
          if (error) throw new Error("profile_image_cleanup_failure_persistence_failed");
        },
      },
      25,
    );
    const { data: backlog, error: backlogError } = await trusted.rpc(
      "get_media_cleanup_backlog_for_server",
    );
    const backlogRecord =
      backlog && typeof backlog === "object" && !Array.isArray(backlog)
        ? (backlog as Record<string, unknown>)
        : null;
    const profileBlocked = backlogRecord?.profile_blocked;
    const clientRetryExhausted = backlogRecord?.client_retry_exhausted;
    const status =
      summary.failed === 0 &&
      summary.recoveryFailed === 0 &&
      summary.blocked === 0 &&
      !backlogError &&
      profileBlocked === 0 &&
      clientRetryExhausted === 0
        ? 200
        : 500;
    return jsonResponse(status, {
      ...summary,
      backlog: backlogError ? null : backlog,
      backlog_metrics_available: !backlogError,
    });
  } catch {
    return jsonResponse(500, { code: "cleanup_claim_failed" });
  }
});
