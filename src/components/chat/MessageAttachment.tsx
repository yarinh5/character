import { useEffect, useRef, useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type {
  MessageAttachmentAccess,
  MessageAttachmentAccessStatus,
} from "@/hooks/useMessageAttachmentAccessMap";
import { useMessageAttachmentUrl } from "@/hooks/useMessageAttachmentUrl";
import { supabase } from "@/integrations/supabase/client";

export type ChatMessageAttachment = {
  id: string;
  message_id: string;
  kind: string;
  position: number;
  caption: string | null;
  metadata: unknown;
  created_at: string;
};

type MessageAttachmentProps = {
  attachment: ChatMessageAttachment;
  access: MessageAttachmentAccess | null;
  accessStatus: MessageAttachmentAccessStatus;
  refreshAccess: () => Promise<MessageAttachmentAccess | null>;
};

export function MessageAttachment({
  attachment,
  access,
  accessStatus,
  refreshAccess,
}: MessageAttachmentProps) {
  const preview = useMessageAttachmentUrl(attachment.id);
  const [unlocking, setUnlocking] = useState(false);
  const unlockIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    unlockIdempotencyKeyRef.current = null;
  }, [attachment.id]);

  if (attachment.kind !== "image") return null;

  const lockedDisabled =
    accessStatus === "ready" && access?.access_mode === "locked" && access.render_state === "disabled";
  const canUnlock =
    accessStatus === "ready" &&
    access?.access_mode === "locked" &&
    access.render_state === "teaser" &&
    typeof access.price_credits_snapshot === "number" &&
    access.is_unlocked === false;
  const unlockPrice = canUnlock ? access?.price_credits_snapshot ?? null : null;

  const unlock = async () => {
    if (!canUnlock || unlocking) return;

    const idempotencyKey = unlockIdempotencyKeyRef.current ?? crypto.randomUUID();
    unlockIdempotencyKeyRef.current = idempotencyKey;
    setUnlocking(true);
    try {
      const { error } = await supabase.rpc("unlock_locked_message_attachment", {
        _attachment_id: attachment.id,
        _idempotency_key: idempotencyKey,
      });
      if (error) {
        toast.error("פתיחת התמונה לא הושלמה. בודקים את סטטוס הפתיחה.");
        const refreshedAccess = await refreshAccess();
        if (refreshedAccess?.is_unlocked) {
          unlockIdempotencyKeyRef.current = null;
          await preview.refresh();
        }
        return;
      }

      unlockIdempotencyKeyRef.current = null;
      await refreshAccess();
      await preview.refresh();
    } finally {
      setUnlocking(false);
    }
  };

  if (lockedDisabled) {
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        המדיה הנעולה אינה זמינה כרגע
      </div>
    );
  }

  if (preview.status === "loading" || accessStatus === "loading") {
    return (
      <div
        className="mt-2 aspect-[4/3] w-full min-w-48 animate-pulse rounded-md bg-muted/60"
        role="status"
        aria-label="טוען תמונה"
      />
    );
  }

  if (preview.status === "error" || !preview.url || accessStatus === "error" || !access) {
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        המדיה אינה זמינה כרגע
      </div>
    );
  }

  return (
    <div className="mt-2">
      <img
        src={preview.url}
        alt="תמונה שנשלחה בצ'אט"
        className="aspect-[4/3] w-full min-w-48 rounded-md object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={preview.retryAfterImageError}
      />
      {canUnlock && unlockPrice !== null && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LockKeyhole className="h-3.5 w-3.5" /> פתיחת התמונה: {unlockPrice} קרדיטים
          </span>
          <Button size="sm" onClick={() => void unlock()} disabled={unlocking}>
            {unlocking && <LoaderCircle className="h-4 w-4 animate-spin" />}
            פתח
          </Button>
        </div>
      )}
    </div>
  );
}
