import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ClientMediaValidationError, validateAndSanitizeClientImage } from "./image-validation.ts";
import {
  ClientMediaFinalizeError,
  ClientMediaOperationError,
  runClientMediaFinalize,
  type ClientMediaFinalizeClaim,
} from "./orchestration.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Authorization, Origin",
    "Content-Type": "application/json",
  };
}

function errorResponse(status: number, code: string, origin: string | null) {
  return new Response(JSON.stringify({ code }), { status, headers: headers(origin) });
}

function rpcFailure(
  operation: "claim" | "renew" | "finalize" | "fail" | "cleanup",
  status: number,
  message: string,
) {
  return new ClientMediaOperationError(
    operation,
    status === 0 ? "ambiguous" : "authoritative",
    message,
  );
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST")
    return errorResponse(404, "client_media_finalize_not_available", origin);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return errorResponse(401, "unauthorized", origin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", origin);
  }
  if (
    typeof body.upload_id !== "string" ||
    !UUID_PATTERN.test(body.upload_id) ||
    typeof body.idempotency_key !== "string" ||
    body.idempotency_key.length < 1 ||
    body.idempotency_key.length > 200
  ) {
    return errorResponse(400, "invalid_request", origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("client_media_finalize_configuration_missing");
    return errorResponse(404, "client_media_finalize_not_available", origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return errorResponse(401, "unauthorized", origin);

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const data = await runClientMediaFinalize(
      {
        actorUserId: userData.user.id,
        uploadId: body.upload_id,
        idempotencyKey: body.idempotency_key,
      },
      {
        async claim(actorUserId, uploadId) {
          const {
            data: claims,
            error,
            status,
          } = await trusted.rpc("claim_client_media_finalize_for_server", {
            _actor_user_id: actorUserId,
            _upload_id: uploadId,
          });
          const claim = (
            Array.isArray(claims) ? claims[0] : claims
          ) as ClientMediaFinalizeClaim | null;
          if (error)
            throw rpcFailure("claim", status, error.message || "client_media_upload_not_available");
          if (!claim)
            throw new ClientMediaOperationError(
              "claim",
              "authoritative",
              "client_media_upload_not_available",
            );
          return claim;
        },
        async renew(uploadId, claimToken) {
          const {
            data: renewed,
            error,
            status,
          } = await trusted.rpc("renew_client_media_finalize_claim_for_server", {
            _upload_id: uploadId,
            _claim_token: claimToken,
          });
          if (error) throw rpcFailure("renew", status, error.message);
          return renewed === true;
        },
        async download(bucketId, path) {
          const { data: source, error } = await trusted.storage.from(bucketId).download(path);
          if (error || !source)
            throw new ClientMediaOperationError(
              "download",
              "ambiguous",
              "client_media_download_failed",
            );
          return new Uint8Array(await source.arrayBuffer());
        },
        async validate(bytes, contentType) {
          try {
            return await validateAndSanitizeClientImage(bytes, contentType);
          } catch (error) {
            if (!(error instanceof ClientMediaValidationError))
              console.error("client_media_validation_unexpected_failure");
            throw new ClientMediaFinalizeError(422, "client_media_validation_failed");
          }
        },
        async upload(bucketId, path, media) {
          const { error } = await trusted.storage
            .from(bucketId)
            .upload(path, media.bytes, { contentType: media.contentType, upsert: true });
          if (error)
            throw new ClientMediaOperationError(
              "upload",
              "ambiguous",
              "client_media_processing_failed",
            );
        },
        async remove(bucketId, paths) {
          const { error } = await trusted.storage.from(bucketId).remove(paths);
          if (error) throw new Error("client_media_storage_remove_failed");
        },
        async finalize(input) {
          const {
            data: finalized,
            error,
            status,
          } = await trusted.rpc("finalize_client_media_upload_for_server", {
            _actor_user_id: input.actorUserId,
            _upload_id: input.uploadId,
            _idempotency_key: input.idempotencyKey,
            _content_type: input.contentType,
            _byte_size: input.byteSize,
            _finalize_claim_token: input.claimToken,
          });
          if (error) throw rpcFailure("finalize", status, error.message);
          return finalized;
        },
        async fail(uploadId, claimToken, errorCode) {
          const { error, status } = await trusted.rpc("fail_client_media_finalize_for_server", {
            _upload_id: uploadId,
            _claim_token: claimToken,
            _error_code: errorCode,
          });
          if (error) throw rpcFailure("fail", status, error.message);
        },
        async markArtifactForCleanup(uploadId, claimToken, errorCode) {
          const { error, status } = await trusted.rpc(
            "mark_client_media_finalize_artifact_for_cleanup_for_server",
            {
              _upload_id: uploadId,
              _claim_token: claimToken,
              _error_code: errorCode,
            },
          );
          if (error) throw rpcFailure("cleanup", status, error.message);
        },
      },
    );
    return new Response(JSON.stringify(data), { status: 200, headers: headers(origin) });
  } catch (error) {
    if (error instanceof ClientMediaFinalizeError) {
      if (error.recoveryFailure) console.error(error.recoveryFailure);
      return errorResponse(error.status, error.code, origin);
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("client_media_upload_not_available")) {
      return errorResponse(404, "client_media_finalize_not_available", origin);
    }
    return errorResponse(409, "client_media_finalize_failed", origin);
  }
});
