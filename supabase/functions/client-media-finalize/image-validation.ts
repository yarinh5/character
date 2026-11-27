import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
} from "npm:@imagemagick/magick-wasm@0.0.30";

export const MAX_CLIENT_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_CLIENT_MEDIA_PIXELS = 20_000_000;

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
let imageMagickReady: Promise<void> | null = null;

export class ClientMediaValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ClientMediaValidationError";
  }
}

function initializeImageProcessor() {
  imageMagickReady ??= (async () => {
    const wasmBytes = await Deno.readFile(
      new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30")),
    );
    await initializeImageMagick(wasmBytes);
  })();
  return imageMagickReady;
}

export function detectClientImageMime(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
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
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

export async function validateAndSanitizeClientImage(
  sourceBytes: Uint8Array,
  declaredContentType: string,
) {
  if (
    !ALLOWED_CONTENT_TYPES.has(declaredContentType) ||
    sourceBytes.length < 1 ||
    sourceBytes.length > MAX_CLIENT_MEDIA_BYTES ||
    detectClientImageMime(sourceBytes) !== declaredContentType
  ) {
    throw new ClientMediaValidationError("client_media_validation_failed");
  }

  await initializeImageProcessor();
  try {
    const sanitized = ImageMagick.read(sourceBytes, (image) => {
      const width = image.width;
      const height = image.height;
      if (width < 1 || height < 1 || width * height > MAX_CLIENT_MEDIA_PIXELS) {
        throw new ClientMediaValidationError("client_media_dimensions_invalid");
      }
      image.strip();
      // Bound encoder effort on the request worker; keep the codec quality and dimensions.
      image.settings.setDefine(MagickFormat.WebP, "method", 2);
      return {
        width,
        height,
        bytes: image.write(MagickFormat.WebP, (result) => result.slice()),
      };
    });
    if (sanitized.bytes.length < 1 || sanitized.bytes.length > MAX_CLIENT_MEDIA_BYTES) {
      throw new ClientMediaValidationError("client_media_sanitized_size_invalid");
    }
    return { ...sanitized, contentType: "image/webp" as const };
  } catch (error) {
    if (error instanceof ClientMediaValidationError) throw error;
    throw new ClientMediaValidationError("client_media_decode_failed");
  }
}
