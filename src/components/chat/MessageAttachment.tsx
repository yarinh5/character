import { useMessageAttachmentUrl } from "@/hooks/useMessageAttachmentUrl";

export type ChatMessageAttachment = {
  id: string;
  message_id: string;
  kind: string;
  position: number;
  caption: string | null;
  metadata: unknown;
  created_at: string;
};

export function MessageAttachment({ attachment }: { attachment: ChatMessageAttachment }) {
  const { status, url, retryAfterImageError } = useMessageAttachmentUrl(attachment.id);

  if (attachment.kind !== "image") return null;

  if (status === "loading") {
    return (
      <div
        className="mt-2 aspect-[4/3] w-full min-w-48 animate-pulse rounded-md bg-muted/60"
        role="status"
        aria-label="טוען תמונה"
      />
    );
  }

  if (status === "error" || !url) {
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        המדיה אינה זמינה כרגע
      </div>
    );
  }

  return (
    <img
      src={url}
      alt="תמונה שנשלחה בצ'אט"
      className="mt-2 aspect-[4/3] w-full min-w-48 rounded-md object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={retryAfterImageError}
    />
  );
}
