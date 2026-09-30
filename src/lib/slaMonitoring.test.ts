import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlaRiskConversation } from "@/lib/slaMonitoring";

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));
const logSupabaseErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: supabaseMocks,
}));

vi.mock("@/lib/readStates", () => ({
  logSupabaseError: logSupabaseErrorMock,
}));

import { fetchSlaRiskConversations } from "@/lib/slaMonitoring";

const slaRiskConversations: SlaRiskConversation[] = [
  {
    character_avatar_url: null,
    character_id: "00000000-0000-4000-8000-000000000002",
    character_name: "דמות בדיקה",
    client_display_name: null,
    client_id: "00000000-0000-4000-8000-000000000003",
    conversation_id: "00000000-0000-4000-8000-000000000001",
    last_client_message_at: "2026-09-29T00:00:00.000Z",
    last_message_preview: null,
    minutes_waiting: 16,
    status: "new",
  },
];

describe("fetchSlaRiskConversations", () => {
  beforeEach(() => {
    supabaseMocks.from.mockReset();
    supabaseMocks.rpc.mockReset();
    logSupabaseErrorMock.mockReset();
  });

  it("returns the mapped SLA result from the canonical RPC", async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: slaRiskConversations, error: null });

    await expect(fetchSlaRiskConversations(101)).resolves.toEqual(slaRiskConversations);

    expect(supabaseMocks.rpc).toHaveBeenCalledOnce();
    expect(supabaseMocks.rpc).toHaveBeenCalledWith("get_sla_risk_conversations", {
      _limit: 100,
      _notify: false,
    });
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(logSupabaseErrorMock).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC resolves with an error", async () => {
    const error = { code: "PGRST000", message: "request failed" };
    supabaseMocks.rpc.mockResolvedValue({ data: null, error });

    await expect(fetchSlaRiskConversations()).resolves.toEqual([]);

    expect(supabaseMocks.rpc).toHaveBeenCalledOnce();
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(logSupabaseErrorMock).toHaveBeenCalledWith("get_sla_risk_conversations", error);
  });

  it("fails closed when the RPC promise rejects", async () => {
    const error = new Error("network request failed");
    supabaseMocks.rpc.mockRejectedValue(error);

    await expect(fetchSlaRiskConversations()).resolves.toEqual([]);

    expect(supabaseMocks.rpc).toHaveBeenCalledOnce();
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(logSupabaseErrorMock).toHaveBeenCalledWith("get_sla_risk_conversations", error);
  });
});
