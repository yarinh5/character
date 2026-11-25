import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "client_level_progress") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => io.read() }),
        }),
      };
    },
    auth: { resetPasswordForEmail: vi.fn() },
  },
}));

import { ClientLevelCard } from "@/components/account/AccountSettingsShared";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClientLevelCard userId="client-a" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  io.read.mockReset();
});

describe("client level server projection", () => {
  it("shows the server count and exact next approved boundary", async () => {
    io.read.mockResolvedValue({
      data: { eligible_message_count: 24, level: 2, updated_at: "2026-11-05T12:00:00Z" },
      error: null,
    });
    mount();
    expect(await screen.findByText("רמה 2")).toBeInTheDocument();
    expect(screen.getByText("24 הודעות מזכות · עוד 1 לרמה הבאה")).toBeInTheDocument();
  });

  it("represents an absent projection as canonical level one without writing a default", async () => {
    io.read.mockResolvedValue({ data: null, error: null });
    mount();
    expect(await screen.findByText("רמה 1")).toBeInTheDocument();
    expect(screen.getByText("0 הודעות מזכות · עוד 5 לרמה הבאה")).toBeInTheDocument();
    expect(io.read).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed progress and recovers through the existing read-only retry", async () => {
    io.read
      .mockResolvedValueOnce({
        data: { eligible_message_count: "24", level: 2, updated_at: "bad" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { eligible_message_count: 25, level: 3, updated_at: "2026-11-05T12:01:00Z" },
        error: null,
      });
    mount();
    const alert = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText("רמה 3")).toBeInTheDocument();
    await waitFor(() => expect(alert).not.toBeInTheDocument());
  });
});
