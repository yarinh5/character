import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type CharacterMediaTarget =
  | { targetKind: "message_attachment"; targetId: string; ttlSeconds: 60 }
  | { targetKind: "reserved_preview"; targetId: string; ttlSeconds: 30 }
  | { targetKind: "admin_asset_preview"; targetId: string; ttlSeconds: 60 }
  | { targetKind: "admin_locked_teaser_preview"; targetId: string; ttlSeconds: 60 }
  | { targetKind: "admin_locked_delivery_preview"; targetId: string; ttlSeconds: 60 };

type StickerMessageTarget = {
  targetKind: "message_sticker";
  messageStickerId: string;
  ttlSeconds: 60;
};

type StickerConversationTarget = {
  targetKind: "conversation_sticker";
  conversationId: string;
  stickerId: string;
  ttlSeconds: 60;
};

type AdminStickerTarget = { targetKind: "admin_sticker_preview"; stickerId: string; ttlSeconds: 60 };
type AdminGiftTarget = { targetKind: "admin_gift_preview"; giftId: string; ttlSeconds: 60 };

type Target = CharacterMediaTarget | StickerMessageTarget | StickerConversationTarget | AdminStickerTarget | AdminGiftTarget;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function responseHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Authorization, Origin",
    "Content-Type": "application/json",
  };
}

function errorResponse(
  status: number,
  code: "unauthorized" | "invalid_request" | "media_not_available",
  origin: string | null,
) {
  return new Response(JSON.stringify({ code }), { status, headers: responseHeaders(origin) });
}

function parseTarget(body: unknown): Target | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;

  if (
    value.kind === "message_attachment" &&
    typeof value.attachment_id === "string" &&
    UUID_PATTERN.test(value.attachment_id)
  ) {
    return { targetKind: "message_attachment", targetId: value.attachment_id, ttlSeconds: 60 };
  }

  if (
    value.kind === "message_sticker" &&
    typeof value.message_sticker_id === "string" &&
    UUID_PATTERN.test(value.message_sticker_id)
  ) {
    return { targetKind: "message_sticker", messageStickerId: value.message_sticker_id, ttlSeconds: 60 };
  }

  if (
    value.kind === "conversation_sticker" &&
    typeof value.conversation_id === "string" &&
    typeof value.sticker_id === "string" &&
    UUID_PATTERN.test(value.conversation_id) &&
    UUID_PATTERN.test(value.sticker_id)
  ) {
    return {
      targetKind: "conversation_sticker",
      conversationId: value.conversation_id,
      stickerId: value.sticker_id,
      ttlSeconds: 60,
    };
  }

  if (value.kind === "admin_sticker_preview" && typeof value.sticker_id === "string" && UUID_PATTERN.test(value.sticker_id)) {
    return { targetKind: "admin_sticker_preview", stickerId: value.sticker_id, ttlSeconds: 60 };
  }

  if (value.kind === "admin_gift_preview" && typeof value.gift_id === "string" && UUID_PATTERN.test(value.gift_id)) {
    return { targetKind: "admin_gift_preview", giftId: value.gift_id, ttlSeconds: 60 };
  }

  if (
    value.kind === "reserved_preview" &&
    typeof value.reservation_id === "string" &&
    UUID_PATTERN.test(value.reservation_id)
  ) {
    return { targetKind: "reserved_preview", targetId: value.reservation_id, ttlSeconds: 30 };
  }

  if (
    value.kind === "admin_asset_preview" &&
    typeof value.asset_id === "string" &&
    UUID_PATTERN.test(value.asset_id)
  ) {
    return { targetKind: "admin_asset_preview", targetId: value.asset_id, ttlSeconds: 60 };
  }

  if (
    value.kind === "admin_locked_teaser_preview" &&
    typeof value.asset_id === "string" &&
    UUID_PATTERN.test(value.asset_id)
  ) {
    return { targetKind: "admin_locked_teaser_preview", targetId: value.asset_id, ttlSeconds: 60 };
  }

  if (
    value.kind === "admin_locked_delivery_preview" &&
    typeof value.asset_id === "string" &&
    UUID_PATTERN.test(value.asset_id)
  ) {
    return { targetKind: "admin_locked_delivery_preview", targetId: value.asset_id, ttlSeconds: 60 };
  }

  return null;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }

  if (request.method !== "POST") {
    return errorResponse(404, "media_not_available", origin);
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return errorResponse(401, "unauthorized", origin);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", origin);
  }

  const target = parseTarget(body);
  if (!target) {
    return errorResponse(400, "invalid_request", origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("media_view_url_configuration_missing");
    return errorResponse(404, "media_not_available", origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) {
    return errorResponse(401, "unauthorized", origin);
  }

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: previewPath, error: resolveError } =
    target.targetKind === "message_sticker"
      ? await trusted.rpc("resolve_sticker_object_path_for_server", {
          _actor_user_id: userData.user.id,
          _message_sticker_id: target.messageStickerId,
        })
      : target.targetKind === "conversation_sticker"
        ? await trusted.rpc("resolve_conversation_sticker_object_path_for_server", {
            _actor_user_id: userData.user.id,
            _conversation_id: target.conversationId,
          _sticker_id: target.stickerId,
        })
        : target.targetKind === "admin_sticker_preview"
          ? await trusted.rpc("resolve_admin_sticker_object_path_for_server", {
              _actor_user_id: userData.user.id,
              _sticker_id: target.stickerId,
            })
          : target.targetKind === "admin_gift_preview"
            ? await trusted.rpc("resolve_admin_gift_object_path_for_server", {
                _actor_user_id: userData.user.id,
                _gift_id: target.giftId,
              })
        : await trusted.rpc("resolve_character_media_preview_path_for_server", {
            _actor_user_id: userData.user.id,
            _target_kind: target.targetKind,
            _target_id: target.targetId,
          });

  if (resolveError || typeof previewPath !== "string" || !previewPath) {
    return errorResponse(404, "media_not_available", origin);
  }

  const bucket =
    target.targetKind === "message_sticker" || target.targetKind === "conversation_sticker" || target.targetKind === "admin_sticker_preview"
      ? "sticker-media"
      : target.targetKind === "admin_gift_preview"
        ? "gift-media"
      : "character-media";
  const { data: signedUrl, error: signError } = await trusted.storage
    .from(bucket)
    .createSignedUrl(previewPath, target.ttlSeconds);
  if (signError || !signedUrl?.signedUrl) {
    console.error("media_view_url_sign_failed");
    return errorResponse(404, "media_not_available", origin);
  }

  return new Response(
    JSON.stringify({
      url: signedUrl.signedUrl,
      expires_at: new Date(Date.now() + target.ttlSeconds * 1000).toISOString(),
    }),
    { status: 200, headers: responseHeaders(origin) },
  );
});
