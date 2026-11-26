import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientMediaUploadButton } from "@/components/chat/ClientMediaUploadButton";
import { TooltipProvider } from "@/components/ui/tooltip";

type InvokeReply = { data: unknown; error: { message: string } | null };

const io = vi.hoisted(() => ({
  invoke: vi.fn<(name: string, options: unknown) => Promise<InvokeReply>>(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: io.invoke } },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const intent = {
  upload_id: "00000000-0000-4000-8000-000000000001",
  upload_url:
    "http://kong:8000/storage/v1/object/upload/sign/client-media/client-a/photo.png?token=proof",
};
const message = {
  id: "message-1",
  conversation_id: "conversation-1",
  sender_type: "client",
  sender_id: "client-a",
  content: "[image]",
  created_at: "2026-11-05T00:00:00Z",
  is_read: false,
};
const attachment = {
  id: "attachment-1",
  message_id: "message-1",
  kind: "image",
  position: 0,
  caption: null,
  metadata: { source: "client_media_upload" },
  created_at: "2026-11-05T00:00:00Z",
};

function imageFile() {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "photo.png", { type: "image/png" });
}

function renderUpload(onSent = vi.fn(), identityKey = "client-a") {
  return {
    onSent,
    ...render(
      <TooltipProvider>
        <ClientMediaUploadButton
          conversationId="conversation-1"
          identityKey={identityKey}
          onSent={onSent}
        />
      </TooltipProvider>,
    ),
  };
}

async function choose(file = imageFile()) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("client media file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  io.invoke.mockReset();
  vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:62021");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
});

afterEach(() => vi.unstubAllEnvs());

describe("client media upload", () => {
  it("uploads and finalizes once before publishing the returned message", async () => {
    io.invoke.mockImplementation(async (name) =>
      name === "client-media-upload-intent"
        ? { data: intent, error: null }
        : { data: { message, attachment, balance: 40 }, error: null },
    );
    const { onSent } = renderUpload();

    await choose();

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:62021/storage/v1/object/upload/sign/client-media/client-a/photo.png?token=proof",
      expect.objectContaining({ method: "PUT", body: expect.any(File) }),
    );
    expect(io.invoke).toHaveBeenNthCalledWith(2, "client-media-finalize", {
      body: {
        upload_id: intent.upload_id,
        idempotency_key: "00000000-0000-4000-8000-000000000002",
      },
    });
    expect(onSent).toHaveBeenCalledWith(
      expect.objectContaining({ id: message.id, message_attachments: [attachment] }),
      40,
    );
  });

  it.each([
    "http://kong:8000/storage/v1/object/sign/client-media/client-a/photo.png?token=proof",
    "http://kong:8000/storage/v1/object/upload/sign/character-media/client-a/photo.png?token=proof",
    "http://kong:8000/storage/v1/object/upload/sign/client-media/client-a/photo.png?token=one&token=two",
    "http://kong:8000/storage/v1/object/upload/sign/client-media/client-a/photo.png",
  ])("does not upload or finalize an invalid signed destination: %s", async (uploadUrl) => {
    io.invoke.mockImplementation(async (name) =>
      name === "client-media-upload-intent"
        ? { data: { ...intent, upload_url: uploadUrl }, error: null }
        : { data: { message, attachment, balance: 40 }, error: null },
    );
    renderUpload();
    await choose();
    await waitFor(() => expect(io.invoke).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates only one upload intent when the file input fires twice before the first intent resolves", async () => {
    const pendingIntent = deferred<InvokeReply>();
    io.invoke.mockImplementation((name) =>
      name === "client-media-upload-intent"
        ? pendingIntent.promise
        : Promise.resolve({ data: { message, attachment, balance: 40 }, error: null }),
    );
    const { onSent } = renderUpload();

    await choose();
    await choose();

    expect(io.invoke).toHaveBeenCalledTimes(1);
    expect(io.invoke).toHaveBeenCalledWith("client-media-upload-intent", {
      body: { conversation_id: "conversation-1", content_type: "image/png" },
    });

    await act(async () => {
      pendingIntent.resolve({ data: intent, error: null });
      await pendingIntent.promise;
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it("keeps an ambiguous finalize available for retry with the same idempotency key", async () => {
    let finalizeAttempts = 0;
    io.invoke.mockImplementation(async (name) => {
      if (name === "client-media-upload-intent") return { data: intent, error: null };
      finalizeAttempts += 1;
      return finalizeAttempts === 1
        ? { data: null, error: { message: "network" } }
        : {
            data: { message, attachment, balance: 40, already_finalized: true },
            error: null,
          };
    });
    const { onSent } = renderUpload();
    await choose();

    const retry = await screen.findByRole("button", { name: "ניסיון נוסף להשלמת שליחת התמונה" });
    fireEvent.click(retry);
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));

    const finalizeBodies = io.invoke.mock.calls
      .filter(([name]) => name === "client-media-finalize")
      .map(([, options]) => options);
    expect(finalizeBodies).toEqual([
      {
        body: {
          upload_id: intent.upload_id,
          idempotency_key: "00000000-0000-4000-8000-000000000002",
        },
      },
      {
        body: {
          upload_id: intent.upload_id,
          idempotency_key: "00000000-0000-4000-8000-000000000002",
        },
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      io.invoke.mock.calls.filter(([name]) => name === "client-media-upload-intent"),
    ).toHaveLength(1);
    expect(onSent).toHaveBeenCalledWith(
      expect.objectContaining({ id: message.id, message_attachments: [attachment] }),
      40,
    );
  });

  it("rejects unsupported files before creating an upload intent", async () => {
    renderUpload();
    await choose(new File(["text"], "note.txt", { type: "text/plain" }));
    expect(io.invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not publish a late completion after the authenticated identity changes", async () => {
    const lateFinalize = deferred<InvokeReply>();
    io.invoke.mockImplementation((name) =>
      name === "client-media-upload-intent"
        ? Promise.resolve({ data: intent, error: null })
        : lateFinalize.promise,
    );
    const onSent = vi.fn();
    const view = renderUpload(onSent);
    await choose();
    await waitFor(() => expect(io.invoke).toHaveBeenCalledTimes(2));

    view.rerender(
      <TooltipProvider>
        <ClientMediaUploadButton
          conversationId="conversation-1"
          identityKey="client-b"
          onSent={onSent}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      lateFinalize.resolve({ data: { message, attachment, balance: 40 }, error: null });
      await lateFinalize.promise;
    });
    expect(onSent).not.toHaveBeenCalled();
  });
});
