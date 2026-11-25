import { describe, expect, it, vi } from "vitest";

import {
  createSupportTicketWithDependencies,
  submitSupportMessageWithDependencies,
  updateSupportTicketWithDependencies,
} from "@/lib/supportWorkflow";

describe("support workflow contracts", () => {
  it("returns authoritative ticket identity and preserves the idempotency key", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "ticket-1",
      status: "new",
      created_at: "2026-11-11T18:00:00.000Z",
    });
    await expect(
      createSupportTicketWithDependencies(
        {
          subject: "בעיה בכניסה",
          category: "account",
          description: "לא ניתן להשלים כניסה לחשבון.",
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        },
        { create },
      ),
    ).resolves.toMatchObject({ id: "ticket-1", status: "new" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("does not report success when the authoritative write fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("db unavailable"));
    await expect(
      createSupportTicketWithDependencies(
        {
          subject: "בעיה בכניסה",
          category: "account",
          description: "לא ניתן להשלים כניסה לחשבון.",
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        },
        { create },
      ),
    ).rejects.toThrow("db unavailable");
  });

  it("separates internal notes from client-visible replies", async () => {
    const submit = vi.fn().mockResolvedValue({ id: "message-1" });
    await submitSupportMessageWithDependencies(
      {
        ticketId: "ticket-1",
        body: "בדיקה פנימית בלבד",
        visibility: "internal",
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
      },
      { submit },
    );
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ visibility: "internal" }));
  });

  it("requires the observed version for concurrent admin updates", async () => {
    const update = vi.fn().mockResolvedValue({ id: "ticket-1", version: 5 });
    await updateSupportTicketWithDependencies(
      {
        ticketId: "ticket-1",
        expectedVersion: 4,
        status: "in_progress",
        assigneeAdminId: null,
      },
      { update },
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4 }));
  });
});
