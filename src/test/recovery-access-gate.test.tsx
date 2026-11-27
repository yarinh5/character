import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: io.rpc } }));

import { RecoveryAccessGate } from "@/components/recovery/RecoveryAccessGate";

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecoveryAccessGate>
        <p>פעילות עסקית</p>
      </RecoveryAccessGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => io.rpc.mockReset());

describe("restore recovery access gate", () => {
  it("fails closed when recovery state cannot be read", async () => {
    io.rpc.mockResolvedValue({ data: null, error: new Error("unavailable") });
    renderGate();
    expect(await screen.findByRole("alert")).toHaveTextContent("המערכת במצב תחזוקה");
    expect(screen.queryByText("פעילות עסקית")).not.toBeInTheDocument();
  });

  it("blocks a current recovery event", async () => {
    io.rpc.mockResolvedValue({
      data: [{ blocked: true, event_id: "event-1", event_version: 2, status: "reconciling" }],
      error: null,
    });
    renderGate();
    expect(await screen.findByRole("alert")).toHaveTextContent("המערכת במצב תחזוקה");
  });

  it("renders normal activity only after the authoritative gate is open", async () => {
    io.rpc.mockResolvedValue({
      data: [{ blocked: false, event_id: null, event_version: null, status: null }],
      error: null,
    });
    renderGate();
    expect(await screen.findByText("פעילות עסקית")).toBeInTheDocument();
  });
});
