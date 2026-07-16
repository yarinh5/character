export const MESSAGE_PAGE_SIZE = 50;

export type PaginatedMessageBase = {
  id: string;
  created_at: string;
};

export type MessageCursor = Pick<PaginatedMessageBase, "created_at" | "id">;

export function sortMessagesAsc<T extends PaginatedMessageBase>(messages: T[]) {
  return [...messages].sort((a, b) => {
    const createdAtComparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return createdAtComparison || a.id.localeCompare(b.id);
  });
}

export function mergeMessagesById<T extends PaginatedMessageBase>(current: T[], incoming: T[]) {
  const byId = new Map<string, T>();
  [...current, ...incoming].forEach((message) => {
    byId.set(message.id, { ...byId.get(message.id), ...message });
  });
  return sortMessagesAsc([...byId.values()]);
}

export function getOldestMessageCursor(messages: PaginatedMessageBase[]): MessageCursor | null {
  const oldestMessage = messages[0];
  return oldestMessage ? { created_at: oldestMessage.created_at, id: oldestMessage.id } : null;
}

export function isNearScrollBottom(element: HTMLElement | null, threshold = 120) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}
