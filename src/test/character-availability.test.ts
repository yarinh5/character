import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  a: "00000000-0000-4000-8000-000000000101",
  b: "00000000-0000-4000-8000-000000000102",
};

const io = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: io.rpc },
}));

import { fetchCharacterLiveAvailability } from "@/lib/characterAvailability";

beforeEach(() => {
  io.rpc.mockReset().mockResolvedValue({
    data: [
      { character_id: ids.a, availability_status: "available" },
      { character_id: ids.b, availability_status: "offline" },
    ],
    error: null,
  });
});

describe("authoritative character availability", () => {
  it("reads the server RPC once and preserves one result per requested character", async () => {
    const result = await fetchCharacterLiveAvailability([ids.a, ids.b, ids.a]);
    expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(io.rpc).toHaveBeenCalledWith("get_character_live_availability", {
      _character_ids: [ids.a, ids.b],
    });
    expect(result.get(ids.a)).toBe("available");
    expect(result.get(ids.b)).toBe("offline");
  });

  it("fails closed on missing, duplicate or invalid server rows", async () => {
    io.rpc.mockResolvedValueOnce({
      data: [{ character_id: ids.a, availability_status: "available" }],
      error: null,
    });
    await expect(fetchCharacterLiveAvailability([ids.a, ids.b])).rejects.toThrow(
      "incomplete_character_availability_response",
    );

    io.rpc.mockResolvedValueOnce({
      data: [
        { character_id: ids.a, availability_status: "available" },
        { character_id: ids.a, availability_status: "available" },
      ],
      error: null,
    });
    await expect(fetchCharacterLiveAvailability([ids.a])).rejects.toThrow(
      "invalid_character_availability_response",
    );

    io.rpc.mockResolvedValueOnce({
      data: [{ character_id: ids.a, availability_status: "online" }],
      error: null,
    });
    await expect(fetchCharacterLiveAvailability([ids.a])).rejects.toThrow(
      "invalid_character_availability_response",
    );
  });

  it("surfaces RPC failures without falling back to configured or conversation presence", async () => {
    io.rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(fetchCharacterLiveAvailability([ids.a])).rejects.toEqual({
      message: "unavailable",
    });
  });
});
