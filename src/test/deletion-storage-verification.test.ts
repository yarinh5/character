import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { storageObjectExistsByInfo } from "../../supabase/functions/process-deletion-workflows/storage-verification";

describe("deletion Storage verification", () => {
  const path = "private/customer/image.webp";

  it("checks the exact object path even when similarly named objects exist", async () => {
    const info = vi.fn().mockResolvedValue({ data: { name: "image.webp" }, error: null });
    await expect(storageObjectExistsByInfo(path, info)).resolves.toBe(true);
    expect(info).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("accepts only a confirmed 404 as object absence", async () => {
    const info = vi.fn().mockResolvedValue({ data: null, error: { status: 404 } });
    await expect(storageObjectExistsByInfo(path, info)).resolves.toBe(false);
    expect(info).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("accepts the Storage service's HTTP 400 response only when its statusCode is 404", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const client = createClient("http://127.0.0.1:9999", "synthetic-key", {
      global: { fetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await expect(
      storageObjectExistsByInfo(path, (value) => client.storage.from("private-bucket").info(value)),
    ).resolves.toBe(false);
  });

  it.each([400, 403, 500, undefined])("blocks an uncertain Storage error (%s)", async (status) => {
    const info = vi.fn().mockResolvedValue({ data: null, error: { status } });
    await expect(storageObjectExistsByInfo(path, info)).rejects.toThrow(
      "storage_verification_failed",
    );
  });

  it("blocks HTTP 400 with a different Storage statusCode", async () => {
    const info = vi.fn().mockResolvedValue({
      data: null,
      error: { status: 400, statusCode: "403" },
    });
    await expect(storageObjectExistsByInfo(path, info)).rejects.toThrow(
      "storage_verification_failed",
    );
  });

  it("blocks a malformed success response and a transport failure", async () => {
    await expect(
      storageObjectExistsByInfo(path, async () => ({ data: null, error: null })),
    ).rejects.toThrow("storage_verification_failed");
    await expect(
      storageObjectExistsByInfo(path, async () => {
        throw new Error("transport_failed");
      }),
    ).rejects.toThrow("transport_failed");
  });

  it("uses the installed Storage SDK's exact info endpoint and 404 response", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ statusCode: "404", message: "Object not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClient("http://127.0.0.1:9999", "synthetic-key", {
      global: { fetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await expect(
      storageObjectExistsByInfo(path, (value) => client.storage.from("private-bucket").info(value)),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(
      "/storage/v1/object/info/private-bucket/private/customer/image.webp",
    );
  });
});
