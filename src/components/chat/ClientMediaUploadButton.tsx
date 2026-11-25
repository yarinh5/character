import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import type { ChatMessageAttachment } from "@/components/chat/MessageAttachment";

const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

type ClientMediaMessage = {
  id: string;
  conversation_id: string;
  sender_type: "client";
  sender_id: string;
  content: string;
  created_at: string;
  is_read: boolean;
  message_attachments: ChatMessageAttachment[];
};

type IntentResponse = { upload_id?: unknown; upload_url?: unknown };
type FinalizeResponse = {
  message?: unknown;
  attachment?: unknown;
  balance?: unknown;
};

type PendingFinalize = { uploadId: string; idempotencyKey: string };

type ClientMediaUploadButtonProps = {
  conversationId: string;
  identityKey: string;
  disabled?: boolean;
  onSent: (message: ClientMediaMessage, balance: number | null) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function ClientMediaUploadButton({
  conversationId,
  identityKey,
  disabled = false,
  onSent,
}: ClientMediaUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersionRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [pendingFinalize, setPendingFinalize] = useState<PendingFinalize | null>(null);

  useEffect(() => {
    requestVersionRef.current += 1;
    setBusy(false);
    setPendingFinalize(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [conversationId, identityKey]);

  const finalize = async (pending: PendingFinalize, requestVersion: number) => {
    const { data, error } = await supabase.functions.invoke("client-media-finalize", {
      body: { upload_id: pending.uploadId, idempotency_key: pending.idempotencyKey },
    });
    if (requestVersion !== requestVersionRef.current) return;
    const result = (data ?? {}) as FinalizeResponse;
    const message = isRecord(result.message) ? result.message : null;
    const attachment = isRecord(result.attachment) ? result.attachment : null;
    if (
      error ||
      !message ||
      typeof message.id !== "string" ||
      message.conversation_id !== conversationId ||
      message.sender_type !== "client" ||
      !attachment ||
      typeof attachment.id !== "string" ||
      attachment.message_id !== message.id
    ) {
      setPendingFinalize(pending);
      toast.error(
        error?.message?.includes("insufficient_credits")
          ? "אין מספיק קרדיטים לשליחת תמונה."
          : "לא ניתן לאמת אם שליחת התמונה הושלמה. אפשר לנסות להשלים בלי להעלות שוב.",
      );
      return;
    }

    setPendingFinalize(null);
    onSent(
      {
        ...(message as Omit<ClientMediaMessage, "message_attachments">),
        message_attachments: [attachment as ChatMessageAttachment],
      },
      typeof result.balance === "number" ? result.balance : null,
    );
    toast.success("התמונה נשלחה וזמינה למשך 24 שעות");
  };

  const retryFinalize = async () => {
    if (!pendingFinalize || busy) return;
    const requestVersion = ++requestVersionRef.current;
    setBusy(true);
    try {
      await finalize(pendingFinalize, requestVersion);
    } finally {
      if (requestVersion === requestVersionRef.current) setBusy(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (busy || pendingFinalize) return;
    if (!ACCEPTED_MEDIA_TYPES.has(file.type) || file.size < 1 || file.size > MAX_SOURCE_BYTES) {
      toast.error("יש לבחור JPEG, PNG או WebP עד 10MB");
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("client-media-upload-intent", {
        body: { conversation_id: conversationId, content_type: file.type },
      });
      if (requestVersion !== requestVersionRef.current) return;
      const intent = (data ?? {}) as IntentResponse;
      if (error || typeof intent.upload_id !== "string" || typeof intent.upload_url !== "string") {
        throw new Error("upload_intent_invalid");
      }

      const upload = await fetch(intent.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type, "x-upsert": "false" },
        body: file,
      });
      if (requestVersion !== requestVersionRef.current) return;
      if (!upload.ok) throw new Error("source_upload_failed");

      const pending = { uploadId: intent.upload_id, idempotencyKey: crypto.randomUUID() };
      setPendingFinalize(pending);
      await finalize(pending, requestVersion);
    } catch {
      if (requestVersion === requestVersionRef.current)
        toast.error("העלאת התמונה נכשלה. אפשר לנסות שוב.");
    } finally {
      if (requestVersion === requestVersionRef.current) setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label="בחירת תמונה לשליחה"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadFile(file);
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            disabled={disabled || busy}
            onClick={() => (pendingFinalize ? void retryFinalize() : inputRef.current?.click())}
            aria-label={pendingFinalize ? "ניסיון נוסף להשלמת שליחת התמונה" : "בחירת תמונה לשליחה"}
          >
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : pendingFinalize ? (
              <RotateCcw className="h-4 w-4" />
            ) : (
              <ImagePlus className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {pendingFinalize ? "השלמת שליחה קודמת" : "שליחת תמונה (10 קרדיטים)"}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
