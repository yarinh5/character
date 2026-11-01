import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({ upload: io.upload, getPublicUrl: io.getPublicUrl }),
    },
  },
}));

import { AvatarUpload } from "@/components/common/AvatarUpload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function chooseAndUpload(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["image"], "avatar.png", { type: "image/png" })] },
  });
  fireEvent.load(await screen.findByAltText("תצוגה מקדימה"));
  fireEvent.click(screen.getByRole("button", { name: "שמור תמונה" }));
}

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:preview"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    get: () => 600,
    configurable: true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    get: () => 600,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    value: vi.fn(() => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D),
    configurable: true,
  });
  HTMLCanvasElement.prototype.toBlob = vi.fn((callback) =>
    callback(new Blob(["crop"], { type: "image/webp" })),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  io.upload.mockResolvedValue({ error: null });
  io.getPublicUrl.mockReturnValue({ data: { publicUrl: "https://cdn.test/avatar.webp" } });
});

describe("AvatarUpload lifecycle contract", () => {
  it("preserves the existing user-avatar upload and crop behavior by default", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <AvatarUpload bucket="user-avatars" folder="user-a" value={null} onChange={onChange} />,
    );
    await chooseAndUpload(container);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("https://cdn.test/avatar.webp"));
    expect(io.success).toHaveBeenCalledWith("התמונה הועלתה");
  });

  it("honors the optional disabled state without changing its default", () => {
    const { container } = render(
      <AvatarUpload bucket="character-avatars" value={null} onChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole("button", { name: "העלה תמונה" })).toBeDisabled();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
  });

  it("reports upload state and suppresses late callback and toast when opted in", async () => {
    const pending = deferred<{ error: null }>();
    io.upload.mockReturnValueOnce(pending.promise);
    const onChange = vi.fn();
    const onUploadStateChange = vi.fn();
    const view = render(
      <AvatarUpload
        bucket="character-avatars"
        value={null}
        onChange={onChange}
        onUploadStateChange={onUploadStateChange}
        cancelCompletionOnUnmount
      />,
    );
    await chooseAndUpload(view.container);
    expect(onUploadStateChange).toHaveBeenCalledWith(true);
    view.unmount();
    await act(async () => pending.resolve({ error: null }));
    expect(onChange).not.toHaveBeenCalled();
    expect(io.success).not.toHaveBeenCalled();
  });
});
