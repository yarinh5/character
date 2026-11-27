type MediaBucket = "character-media" | "client-media" | "sticker-media";
const mediaBuckets: readonly MediaBucket[] = ["character-media", "client-media", "sticker-media"];

function rebaseSignedStorageUrl(
  value: unknown,
  operation: "object/sign" | "object/upload/sign",
  buckets: readonly MediaBucket[],
) {
  if (typeof value !== "string") return null;
  const base =
    import.meta.env.VITE_SUPABASE_URL ||
    (typeof process !== "undefined" ? process.env.SUPABASE_URL : undefined);
  if (!base) return null;

  try {
    const gateway = new URL(base);
    const signed = new URL(value);
    const tokens = signed.searchParams.getAll("token");
    const allowedPath = buckets.some((bucket) => {
      const prefix = `/storage/v1/${operation}/${bucket}/`;
      return signed.pathname.startsWith(prefix) && signed.pathname.length > prefix.length;
    });
    if (
      !["http:", "https:"].includes(gateway.protocol) ||
      !["http:", "https:"].includes(signed.protocol) ||
      signed.username ||
      signed.password ||
      signed.hash ||
      !allowedPath ||
      tokens.length !== 1 ||
      !tokens[0]
    ) {
      return null;
    }

    // Edge may sign through an internal gateway; the browser uses its configured gateway.
    return new URL(`${signed.pathname}${signed.search}`, gateway.origin).href;
  } catch {
    return null;
  }
}

export function signedMediaViewUrl(value: unknown) {
  return rebaseSignedStorageUrl(value, "object/sign", mediaBuckets);
}

export function signedMediaUploadUrl(value: unknown, bucket: MediaBucket) {
  return rebaseSignedStorageUrl(value, "object/upload/sign", [bucket]);
}
