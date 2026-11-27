export type SupportCategory =
  | "account"
  | "conversation"
  | "billing"
  | "privacy"
  | "technical"
  | "other";

export type SupportTicketStatus = "new" | "in_progress" | "waiting_for_client" | "closed";

export async function submitSupportAttempt<T>(
  pending: Map<string, string>,
  identity: readonly (string | null)[],
  submit: (idempotencyKey: string) => Promise<T>,
) {
  const fingerprint = JSON.stringify(identity);
  const key = pending.get(fingerprint) ?? crypto.randomUUID();
  pending.set(fingerprint, key);
  // A rejected response does not tell us whether the server committed the write.
  const confirmed = await submit(key);
  pending.delete(fingerprint);
  return confirmed;
}

export type CreateSupportTicketInput = {
  subject: string;
  category: SupportCategory;
  description: string;
  idempotencyKey: string;
};

export async function createSupportTicketWithDependencies<T>(
  input: CreateSupportTicketInput,
  dependencies: { create(input: CreateSupportTicketInput): Promise<T> },
) {
  const normalized = {
    ...input,
    subject: input.subject.trim(),
    description: input.description.trim(),
  };
  if (normalized.subject.length < 4 || normalized.subject.length > 120) {
    throw new Error("invalid_subject");
  }
  if (normalized.description.length < 10 || normalized.description.length > 4000) {
    throw new Error("invalid_description");
  }
  return dependencies.create(normalized);
}

export type SubmitSupportMessageInput = {
  ticketId: string;
  body: string;
  visibility: "client" | "internal";
  idempotencyKey: string;
};

export async function submitSupportMessageWithDependencies<T>(
  input: SubmitSupportMessageInput,
  dependencies: { submit(input: SubmitSupportMessageInput): Promise<T> },
) {
  const normalized = { ...input, body: input.body.trim() };
  if (normalized.body.length < 1 || normalized.body.length > 4000) {
    throw new Error("invalid_message");
  }
  return dependencies.submit(normalized);
}

export type UpdateSupportTicketInput = {
  ticketId: string;
  expectedVersion: number;
  status: SupportTicketStatus;
  assigneeAdminId: string | null;
};

export async function updateSupportTicketWithDependencies<T>(
  input: UpdateSupportTicketInput,
  dependencies: { update(input: UpdateSupportTicketInput): Promise<T> },
) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("expected_version_required");
  }
  return dependencies.update(input);
}
