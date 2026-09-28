import { useState } from "react";
import { LoaderCircle, Smile } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useConversationStickers, type ConversationSticker } from "@/hooks/useConversationStickers";
import { useConversationStickerViewUrl } from "@/hooks/useStickerViewUrl";
import { useStickerSend, type StickerSendResult } from "@/hooks/useStickerSend";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "sonner";

type StickerPickerRole = "client" | "operator" | "admin";

function describeSendError(errorCode: string) {
  if (errorCode.includes("stickers_disabled")) return "סטיקרים אינם זמינים כרגע.";
  if (errorCode.includes("sticker_rate_limited")) return "יש להמתין מעט לפני שליחת סטיקר נוסף.";
  if (errorCode.includes("conversation_closed")) return "לא ניתן לשלוח סטיקר בשיחה סגורה.";
  if (errorCode.includes("conversation_locked_by_other_operator")) return "השיחה נעולה כרגע לעובד אחר.";
  if (errorCode.includes("sticker_not_available")) return "הסטיקר אינו זמין יותר.";
  if (errorCode.includes("insufficient_credits")) return "אין לך מספיק קרדיטים לסטיקר הזה.";
  if (errorCode.includes("paid_sticker_requires_operator_context")) {
    return "סטיקר בתשלום זמין רק לאחר שעובד הצטרף לשיחה";
  }
  return "שליחת הסטיקר נכשלה. אפשר לנסות שוב.";
}

function StickerTile({
  conversationId,
  sticker,
  disabled,
  showPrice,
  onSelect,
}: {
  conversationId: string;
  sticker: ConversationSticker;
  disabled: boolean;
  showPrice: boolean;
  onSelect: (sticker: ConversationSticker) => void;
}) {
  const preview = useConversationStickerViewUrl(conversationId, sticker.sticker_id);
  const label = `${sticker.collection_name}: ${sticker.name}`;

  return (
    <button
      type="button"
      className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-border bg-card p-2 text-center text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => onSelect(sticker)}
      disabled={disabled || preview.status !== "ready" || !preview.url}
      aria-label={`שליחת סטיקר ${label}`}
      title={label}
    >
      {preview.status === "ready" && preview.url ? (
        <img
          src={preview.url}
          alt=""
          className="h-14 w-14 object-contain"
          referrerPolicy="no-referrer"
          onError={preview.retryAfterImageError}
        />
      ) : preview.status === "error" ? (
        <span className="text-muted-foreground">לא זמין</span>
      ) : (
        <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      <span className="line-clamp-2 w-full">{sticker.name}</span>
      {showPrice && (
        <span className="text-[11px] text-muted-foreground">
          {sticker.price_credits > 0 ? `${sticker.price_credits} קרדיטים` : "חינם"}
        </span>
      )}
    </button>
  );
}

function PaidStickerConfirmation({
  sticker,
  busy,
  onCancel,
  onConfirm,
}: {
  sticker: ConversationSticker | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(sticker)} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>שליחת סטיקר בתשלום</AlertDialogTitle>
          <AlertDialogDescription>
            {sticker ? `לשלוח את "${sticker.name}" תמורת ${sticker.price_credits} קרדיטים?` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={onConfirm}>
            שלח
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function StickerPicker({
  conversationId,
  open,
  onOpenChange,
  role,
  onSent,
  creditBalance,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: StickerPickerRole;
  onSent: (result: StickerSendResult) => void;
  creditBalance?: number | null;
}) {
  const isMobile = useIsMobile();
  const catalog = useConversationStickers(conversationId, open);
  const sender = useStickerSend(conversationId, role);
  const [pendingSticker, setPendingSticker] = useState<ConversationSticker | null>(null);

  const sendSticker = async (sticker: ConversationSticker) => {
    const { result, errorCode } = await sender.send(sticker.sticker_id);
    if (errorCode) {
      toast.error(describeSendError(errorCode));
      if (errorCode.includes("sticker_not_available")) void catalog.refresh();
      return;
    }
    if (result) onSent(result);
    onOpenChange(false);
  };

  const selectSticker = (sticker: ConversationSticker) => {
    if (role === "client" && sticker.price_credits > 0) {
      setPendingSticker(sticker);
      return;
    }
    void sendSticker(sticker);
  };

  const content = (
    <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
      {catalog.status === "loading" && (
        <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          טוען סטיקרים...
        </div>
      )}
      {catalog.status === "disabled" && (
        <div className="flex h-28 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Smile className="h-5 w-5" />
          סטיקרים אינם זמינים כרגע.
        </div>
      )}
      {catalog.status === "error" && (
        <div className="flex h-28 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <span>טעינת הסטיקרים נכשלה.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void catalog.refresh()}>
            נסה שוב
          </Button>
        </div>
      )}
      {catalog.status === "ready" && catalog.stickers.length === 0 && (
        <div className="flex h-28 items-center justify-center text-center text-sm text-muted-foreground">
          אין סטיקרים זמינים כרגע.
        </div>
      )}
      {catalog.status === "ready" && catalog.stickers.length > 0 && (
        <>
          {role === "client" && creditBalance !== undefined && creditBalance !== null && (
            <p className="mb-3 text-sm text-muted-foreground">יתרת קרדיטים: {creditBalance} קרדיטים</p>
          )}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {catalog.stickers.map((sticker) => (
              <StickerTile
                key={sticker.sticker_id}
                conversationId={conversationId}
                sticker={sticker}
                disabled={sender.sendingStickerId !== null || sender.isCoolingDown}
                showPrice={role === "client"}
                onSelect={selectSticker}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  const confirmation = (
    <PaidStickerConfirmation
      sticker={pendingSticker}
      busy={sender.sendingStickerId !== null}
      onCancel={() => setPendingSticker(null)}
      onConfirm={() => {
        const sticker = pendingSticker;
        setPendingSticker(null);
        if (sticker) void sendSticker(sticker);
      }}
    />
  );

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="flex max-h-[80dvh] flex-col" dir="rtl">
            <SheetHeader>
              <SheetTitle>סטיקרים</SheetTitle>
              <SheetDescription>בחר סטיקר לשליחה.</SheetDescription>
            </SheetHeader>
            {content}
          </SheetContent>
        </Sheet>
        {confirmation}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[70vh] max-w-md flex-col" dir="rtl">
          <DialogHeader>
            <DialogTitle>סטיקרים</DialogTitle>
            <DialogDescription>בחר סטיקר לשליחה.</DialogDescription>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
      {confirmation}
    </>
  );
}
