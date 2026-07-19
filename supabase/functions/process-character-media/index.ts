import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ImageMagick, initializeImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.30";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 20_000_000;
const MAX_PREVIEW_EDGE = 1600;

type ProcessRequest = { asset_id?: unknown };

let imageMagickReady: Promise<void> | null = null;

function initializeImageProcessor() {
  imageMagickReady ??= (async () => {
    const wasmBytes = await Deno.readFile(
      new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30")),
    );
    await initializeImageMagick(wasmBytes);
  })();
  return imageMagickReady;
}

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

function response(status: number, body: Record<string, unknown>, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

function detectImageMime(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function processingErrorCode(error: unknown) {
  if (error instanceof Error) {
    if (/source_too_large/.test(error.message)) return "source_too_large";
    if (/source_dimensions_invalid/.test(error.message)) return "source_dimensions_invalid";
    if (/source_mime_invalid/.test(error.message)) return "source_mime_invalid";
  }
  return "preview_generation_failed";
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return response(404, { code: "media_processing_not_available" }, origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return response(401, { code: "unauthorized" }, origin);

  let body: ProcessRequest;
  try {
    body = await request.json();
  } catch {
    return response(400, { code: "invalid_request" }, origin);
  }
  if (typeof body.asset_id !== "string" || !UUID_PATTERN.test(body.asset_id)) {
    return response(400, { code: "invalid_request" }, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("process_character_media_configuration_missing");
    return response(404, { code: "media_processing_not_available" }, origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return response(401, { code: "unauthorized" }, origin);

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: beginRows, error: beginError } = await trusted.rpc("begin_character_media_processing_for_server", {
    _actor_user_id: userData.user.id,
    _asset_id: body.asset_id,
  });
  const begin = Array.isArray(beginRows) ? beginRows[0] : null;
  if (beginError) {
    const code = beginError.message.includes("media_processing_in_progress")
      ? "media_processing_in_progress"
      : "media_processing_not_available";
    return response(code === "media_processing_in_progress" ? 409 : 404, { code }, origin);
  }
  if (!begin || typeof begin.asset_id !== "string") return response(404, { code: "media_processing_not_available" }, origin);
  if (begin.already_ready === true) {
    return response(200, { asset_id: begin.asset_id, ingest_status: "ready", already_ready: true }, origin);
  }
  if (typeof begin.source_path !== "string" || typeof begin.preview_path !== "string" || typeof begin.content_type !== "string") {
    return response(404, { code: "media_processing_not_available" }, origin);
  }

  let previewUploaded = false;
  try {
    const { data: sourceBlob, error: downloadError } = await trusted.storage
      .from("character-media")
      .download(begin.source_path);
    if (downloadError || !sourceBlob) throw new Error("source_mime_invalid");
    if (sourceBlob.size <= 0 || sourceBlob.size > MAX_SOURCE_BYTES) throw new Error("source_too_large");

    const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
    if (detectImageMime(sourceBytes) !== begin.content_type) throw new Error("source_mime_invalid");
    await initializeImageProcessor();

    const processed = ImageMagick.read(sourceBytes, (image) => {
      const width = image.width;
      const height = image.height;
      if (width <= 0 || height <= 0 || width * height > MAX_SOURCE_PIXELS) {
        throw new Error("source_dimensions_invalid");
      }
      image.strip();
      if (width > MAX_PREVIEW_EDGE || height > MAX_PREVIEW_EDGE) image.resize(MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE);
      const previewBytes = image.write(MagickFormat.Webp, (bytes) => bytes);
      return { width, height, previewBytes };
    });

    const { error: uploadError } = await trusted.storage.from("character-media").upload(begin.preview_path, processed.previewBytes, {
      contentType: "image/webp",
      cacheControl: "0",
      upsert: true,
    });
    if (uploadError) throw new Error("preview_upload_failed");
    previewUploaded = true;

    const { data: finalized, error: finalizeError } = await trusted.rpc("finalize_character_media_ingest_for_server", {
      _actor_user_id: userData.user.id,
      _asset_id: begin.asset_id,
      _byte_size: sourceBytes.byteLength,
      _width: processed.width,
      _height: processed.height,
      _sha256: await sha256(sourceBytes),
    });
    if (finalizeError) throw new Error("finalize_failed");

    const result = (finalized ?? {}) as { asset_id?: string; ingest_status?: string; already_ready?: boolean };
    return response(
      200,
      {
        asset_id: result.asset_id ?? begin.asset_id,
        ingest_status: result.ingest_status ?? "ready",
        already_ready: result.already_ready === true,
      },
      origin,
    );
  } catch (error) {
    if (previewUploaded) await trusted.storage.from("character-media").remove([begin.preview_path]);
    const code = processingErrorCode(error);
    await trusted.rpc("fail_character_media_ingest_for_server", {
      _actor_user_id: userData.user.id,
      _asset_id: begin.asset_id,
      _error_code: code,
    });
    return response(422, { code: "media_processing_failed" }, origin);
  }
});
