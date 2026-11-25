import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeadWorkspace } from "@/components/leads/LeadWorkspace";

const io = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: io.rpc } }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

function renderWorkspace(identityKey = "operator:one") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LeadWorkspace identityKey={identityKey} />
    </QueryClientProvider>,
  );
}

const lead = {
  id: "00000000-0000-4000-8000-000000000101",
  client_id: "00000000-0000-4000-8000-000000000102",
  client_name: "לקוחה",
  character_id: "00000000-0000-4000-8000-000000000103",
  character_name: "דמות א׳",
  source: "discovery_like",
  status: "new",
  interest_active: true,
  created_at: "2026-11-05T09:00:00.000Z",
  last_liked_at: "2026-11-05T09:00:00.000Z",
  updated_at: "2026-11-05T09:00:00.000Z",
};

beforeEach(() => {
  io.rpc.mockReset();
  io.success.mockReset();
  io.error.mockReset();
});

describe("character Leads workspace", () => {
  it("renders only validated canonical Lead data", async () => {
    io.rpc.mockResolvedValueOnce({ data: [lead], error: null });
    renderWorkspace();

    expect(await screen.findByText("לקוחה")).toBeInTheDocument();
    expect(screen.getByText("התעניין/ה ב־דמות א׳")).toBeInTheDocument();
    expect(io.rpc).toHaveBeenCalledWith("get_character_leads", { _limit: 100 });
  });

  it("rejects malformed responses and exposes retry", async () => {
    io.rpc
      .mockResolvedValueOnce({ data: [{ ...lead, source: "invented" }], error: null })
      .mockResolvedValueOnce({ data: [lead], error: null });
    renderWorkspace();

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת ה־Leads נכשלה");
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText("לקוחה")).toBeInTheDocument();
    expect(io.rpc).toHaveBeenCalledTimes(2);
  });

  it("updates the canonical Lead once and verifies the returned status", async () => {
    io.rpc.mockResolvedValueOnce({ data: [lead], error: null }).mockResolvedValueOnce({
      data: [
        {
          id: lead.id,
          status: "in_progress",
          interest_active: true,
          updated_at: "2026-11-05T09:01:00.000Z",
        },
      ],
      error: null,
    });
    renderWorkspace();

    await screen.findByText("לקוחה");
    const start = screen.getByRole("button", { name: "סמן בטיפול" });
    start.click();
    start.click();

    expect(await screen.findByText("בטיפול")).toBeInTheDocument();
    expect(io.rpc).toHaveBeenCalledWith("update_character_lead_status", {
      _lead_id: lead.id,
      _status: "in_progress",
    });
    expect(io.rpc).toHaveBeenCalledTimes(2);
    expect(io.success).toHaveBeenCalledWith("סטטוס ה־Lead עודכן");
  });

  it("keeps an unlike-closed Lead visible and prevents reopening it from staff UI", async () => {
    io.rpc.mockResolvedValueOnce({
      data: [{ ...lead, status: "closed", interest_active: false }],
      error: null,
    });
    renderWorkspace();

    expect(await screen.findByText("העניין בוטל")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "סמן בטיפול" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "סגור" })).toBeDisabled();
  });

  it("keeps a re-liked closed Lead closed until staff explicitly resumes it", async () => {
    io.rpc
      .mockResolvedValueOnce({
        data: [{ ...lead, status: "closed", interest_active: true }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: lead.id,
            status: "in_progress",
            interest_active: true,
            updated_at: "2026-11-05T09:02:00.000Z",
          },
        ],
        error: null,
      });
    renderWorkspace();

    expect(await screen.findByText("נסגר")).toBeInTheDocument();
    const resume = screen.getByRole("button", { name: "סמן בטיפול" });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);
    expect(await screen.findByText("בטיפול")).toBeInTheDocument();
  });

  it("keeps identity caches separate", async () => {
    io.rpc
      .mockResolvedValueOnce({ data: [lead], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const first = renderWorkspace("operator:one");
    expect(await screen.findByText("לקוחה")).toBeInTheDocument();
    first.unmount();

    renderWorkspace("operator:two");
    await waitFor(() =>
      expect(screen.getByText("אין Leads מורשים להצגה כרגע.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("לקוחה")).not.toBeInTheDocument();
  });
});
