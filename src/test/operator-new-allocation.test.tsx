import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorNewQueueList } from "@/components/operator/OperatorNewQueueList";
import { operatorNewQueueClaimError, type OperatorNewQueueItem } from "@/hooks/useOperatorNewQueue";

const assignedItem: OperatorNewQueueItem = {
  work_item_id: "00000000-0000-4000-8000-000000000101",
  conversation_id: "00000000-0000-4000-8000-000000000102",
  character_id: "00000000-0000-4000-8000-000000000103",
  status: "assigned",
  queue_state: "assigned",
  client_display_name: "לקוחה",
  character_name: "דמות",
  character_avatar_url: null,
  last_client_preview: "שלום",
  last_activity_at: "2026-11-05T08:00:00.000Z",
  created_at: "2026-11-05T08:00:00.000Z",
  wait_seconds: 30,
  sla_state: "normal",
};

describe("operator NEW automatic allocation UI", () => {
  it("opens an assignment already owned by the current operator without presenting a second claim", () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);

    render(
      <OperatorNewQueueList
        items={[assignedItem]}
        claimingId={null}
        onClaim={onClaim}
        queueUpdatedAt={Date.now()}
      />,
    );

    expect(screen.getByText("הוקצתה לך")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "קח שיחה" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "פתח שיחה" }));
    expect(onClaim).toHaveBeenCalledWith(assignedItem);
  });

  it("maps capacity, presence and expired-cycle failures to actionable messages", () => {
    expect(operatorNewQueueClaimError("operator_capacity_reached")).toContain("5");
    expect(operatorNewQueueClaimError("operator_not_connected")).toContain("להתחבר");
    expect(operatorNewQueueClaimError("handling_cycle_expired")).toContain("תוקף");
  });
});
