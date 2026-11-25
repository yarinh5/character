import {
  ClientMediaValidationError,
  detectClientImageMime,
  validateAndSanitizeClientImage,
} from "./image-validation.ts";

// Run with Deno so the production npm: WASM import is exercised by the Edge runtime.

function assertEquals<T>(actual: T, expected: T) {
  if (!Object.is(actual, expected))
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}

type ErrorClass<T extends Error> = abstract new (message: string) => T;

async function assertRejects<T extends Error>(
  action: () => Promise<unknown>,
  expectedClass: ErrorClass<T>,
  expectedMessage?: string,
) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof expectedClass)) throw error;
    if (expectedMessage && error.message !== expectedMessage)
      throw new Error(`expected ${expectedMessage}, received ${error.message}`);
    return;
  }
  throw new Error("expected promise to reject");
}

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (value) => value.charCodeAt(0),
);

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.slice(4, 8 + data.length)));
  return output;
}

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function withSensitiveTextChunk(png: Uint8Array) {
  const iendOffset = png.length - 12;
  return concat(
    png.slice(0, iendOffset),
    pngChunk("tEXt", new TextEncoder().encode("GPSLatitude\0private-location")),
    png.slice(iendOffset),
  );
}

async function oversizedPng() {
  const width = 4500;
  const height = 4500;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = new Uint8Array((width + 1) * height);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  );
}

Deno.test("real decoder rejects a valid signature with corrupt image content", async () => {
  const corrupt = concat(ONE_PIXEL_PNG.slice(0, 8), new TextEncoder().encode("not-a-png"));
  await assertRejects(
    () => validateAndSanitizeClientImage(corrupt, "image/png"),
    ClientMediaValidationError,
  );
});

Deno.test("real decoder enforces the approved twenty-million-pixel ceiling", async () => {
  await assertRejects(
    async () => validateAndSanitizeClientImage(await oversizedPng(), "image/png"),
    ClientMediaValidationError,
    "client_media_dimensions_invalid",
  );
});

Deno.test("sanitization removes embedded location metadata from a valid image", async () => {
  const source = withSensitiveTextChunk(ONE_PIXEL_PNG);
  const result = await validateAndSanitizeClientImage(source, "image/png");
  assertEquals(result.width, 1);
  assertEquals(result.height, 1);
  assertEquals(detectClientImageMime(result.bytes), "image/webp");
  assertEquals(new TextDecoder().decode(result.bytes).includes("private-location"), false);
});

Deno.test("a valid declared image produces a metadata-free WebP derivative", async () => {
  const result = await validateAndSanitizeClientImage(ONE_PIXEL_PNG, "image/png");
  assertEquals(result.contentType, "image/webp");
  assertEquals(detectClientImageMime(result.bytes), "image/webp");
});
