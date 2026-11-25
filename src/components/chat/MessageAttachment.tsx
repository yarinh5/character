import { useEffect, useRef, useState } from "react";
import { Eye, LoaderCircle, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  enabled?: boolean;
  accessGeneration?: number;
};

export function MessageAttachment({
  attachment,
  access,
  accessStatus,
  refreshAccess,
  enabled = true,
  accessGeneration = 0,
}: MessageAttachmentProps) {
  const [unlocking, setUnlocking] = useState(false);
  const [viewOnceOpening, setViewOnceOpening] = useState(false);
  const [viewOnceViewing, setViewOnceViewing] = useState(false);
  const [paidOpenPurchasing, setPaidOpenPurchasing] = useState(false);
  const [paidOpenConfirmOpen, setPaidOpenConfirmOpen] = useState(false);
  const unlockIdempotencyKeyRef = useRef<string | null>(null);
  const viewOnceIdempotencyKeyRef = useRef<string | null>(null);
  const paidOpenIdempotencyKeyRef = useRef<string | null>(null);
  const paidOpenSessionIdRef = useRef<string | null>(null);
  const isViewOnce = access?.view_mode === "view_once";
  const isPaidOpen = access?.view_mode === "paid_open";
  const isExpiredClientMedia =
    access?.view_mode === "client_24h" && access.render_state === "client_24h_expired";
  const canOpenViewOnce =
    accessStatus === "ready" && isViewOnce && access?.render_state === "view_once_available";
  const canRenderViewOnce =
    isViewOnce &&
    (access?.render_state === "view_once_staff" ||
      access?.render_state === "view_once_active" ||
      viewOnceViewing);
  const canOpenLegacyPaid =
    accessStatus === "ready" && isPaidOpen && access?.render_state === "paid_open_available";
  const canPurchaseGift =
    accessStatus === "ready" && isPaidOpen && access?.render_state === "gift_purchase_required";
  const canOpenPurchasedGift =
    accessStatus === "ready" && isPaidOpen && access?.render_state === "gift_purchased";
  const canRenderPaid =
    isPaidOpen &&
    (access?.render_state === "paid_open_staff" || access?.render_state === "paid_open_active");
  const preview = useMessageAttachmentUrl(
    attachment.id,
    enabled &&
      accessStatus === "ready" &&
      (!isViewOnce || canRenderViewOnce) &&
      (!isPaidOpen || canRenderPaid),
    accessGeneration,
  );

  useEffect(() => {
    unlockIdempotencyKeyRef.current = null;
    viewOnceIdempotencyKeyRef.current = null;
    paidOpenIdempotencyKeyRef.current = null;
    paidOpenSessionIdRef.current = null;
    setViewOnceOpening(false);
    setViewOnceViewing(false);
    setPaidOpenPurchasing(false);
    setPaidOpenConfirmOpen(false);
  }, [attachment.id]);

  useEffect(() => {
    if (!viewOnceViewing && access?.render_state !== "view_once_active") return;
    const remainingMilliseconds = access?.session_expires_at
      ? Math.max(0, new Date(access.session_expires_at).getTime() - Date.now())
      : 7_000;
    const timeout = window.setTimeout(() => {
      setViewOnceViewing(false);
      void supabase.rpc("complete_free_view_once_attachment", { _attachment_id: attachment.id });
      void refreshAccess();
    }, remainingMilliseconds);
    return () => window.clearTimeout(timeout);
  }, [
    access?.render_state,
    access?.session_expires_at,
    attachment.id,
    refreshAccess,
    viewOnceViewing,
  ]);

  useEffect(() => {
    if (!isPaidOpen || access?.render_state !== "paid_open_active" || !access.session_expires_at)
      return;

    const remainingMilliseconds = Math.max(
      0,
      new Date(access.session_expires_at).getTime() - Date.now(),
    );
    const timeout = window.setTimeout(() => {
      const sessionId = paidOpenSessionIdRef.current;
      if (sessionId) {
        void supabase.rpc("complete_paid_message_attachment_session", { _session_id: sessionId });
      }
      void refreshAccess();
    }, remainingMilliseconds);

    return () => window.clearTimeout(timeout);
  }, [access?.render_state, access?.session_expires_at, isPaidOpen, refreshAccess]);

  if (attachment.kind !== "image") return null;

  if (isExpiredClientMedia) {
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        התמונה אינה זמינה עוד
      </div>
    );
  }

  const lockedDisabled =
    accessStatus === "ready" &&
    access?.access_mode === "locked" &&
    access.render_state === "disabled";
  const canUnlock =
    accessStatus === "ready" &&
    access?.access_mode === "locked" &&
    access.render_state === "teaser" &&
    typeof access.price_credits_snapshot === "number" &&
    access.is_unlocked === false;
  const unlockPrice = canUnlock ? (access?.price_credits_snapshot ?? null) : null;

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

  const openViewOnce = async () => {
    if (!canOpenViewOnce || viewOnceOpening) return;
    const idempotencyKey = viewOnceIdempotencyKeyRef.current ?? crypto.randomUUID();
    viewOnceIdempotencyKeyRef.current = idempotencyKey;
    setViewOnceOpening(true);
    let error: { message: string } | null;
    try {
      ({ error } = await supabase.rpc("open_free_view_once_attachment", {
        _attachment_id: attachment.id,
        _idempotency_key: idempotencyKey,
      }));
    } catch {
      toast.error("לא ניתן לפתוח את התמונה כרגע.");
      return;
    } finally {
      setViewOnceOpening(false);
    }
    if (error) {
      if (error.message.includes("view_once_already_opened")) {
        await refreshAccess();
      } else {
        toast.error("לא ניתן לפתוח את התמונה כרגע.");
      }
      return;
    }
    viewOnceIdempotencyKeyRef.current = null;
    setViewOnceViewing(true);
    await refreshAccess();
  };

  const openPaidAttachment = async () => {
    if ((!canOpenLegacyPaid && !canPurchaseGift && !canOpenPurchasedGift) || paidOpenPurchasing)
      return;

    const idempotencyKey = paidOpenIdempotencyKeyRef.current ?? crypto.randomUUID();
    paidOpenIdempotencyKeyRef.current = idempotencyKey;
    setPaidOpenPurchasing(true);
    let rpcResponse: Awaited<ReturnType<typeof supabase.rpc>>;
    try {
      rpcResponse = canPurchaseGift
        ? await supabase.rpc("purchase_attachment_gift", {
            _attachment_id: attachment.id,
            _gift_id: access?.required_gift_id ?? "",
            _idempotency_key: idempotencyKey,
          })
        : canOpenPurchasedGift
          ? await supabase.rpc("open_attachment_gift_purchase", {
              _attachment_id: attachment.id,
              _purchase_id: access?.available_purchase_id ?? "",
              _idempotency_key: idempotencyKey,
            })
          : await supabase.rpc("open_paid_message_attachment", {
              _attachment_id: attachment.id,
              _idempotency_key: idempotencyKey,
            });
    } catch {
      toast.error(canPurchaseGift ? "רכישת המתנה לא הושלמה." : "לא ניתן לפתוח את התמונה כרגע.");
      return;
    } finally {
      setPaidOpenPurchasing(false);
    }
    const { data, error } = rpcResponse;
    if (error) {
      const message = error.message ?? "";
      if (message.includes("insufficient_credits")) {
        toast.error("אין מספיק קרדיטים לפתיחת התמונה.");
      } else if (message.includes("gift_does_not_unlock_attachment")) {
        toast.error("המתנה הזו אינה פותחת את התמונה.");
      } else if (message.includes("paid_image_requires_operator_context")) {
        toast.error("תמונה בתשלום זמינה רק לאחר שעובד הצטרף לשיחה.");
      } else if (message.includes("paid_image_open_rate_limited")) {
        toast.error("נפתחו יותר מדי ניסיונות. נסה שוב בעוד רגע.");
      } else {
        toast.error(canPurchaseGift ? "רכישת המתנה לא הושלמה." : "לא ניתן לפתוח את התמונה כרגע.");
      }
      return;
    }

    const response = (data ?? {}) as { session_id?: unknown; purchase_id?: unknown };
    paidOpenSessionIdRef.current =
      canOpenLegacyPaid && typeof response.session_id === "string" ? response.session_id : null;
    paidOpenIdempotencyKeyRef.current = null;
    setPaidOpenConfirmOpen(false);
    await refreshAccess();
  };

  if (lockedDisabled) {
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        המדיה הנעולה אינה זמינה כרגע
      </div>
    );
  }

  if (isViewOnce && !canRenderViewOnce) {
    if (canOpenViewOnce) {
      return (
        <div className="mt-2 flex aspect-[4/3] w-full min-w-48 flex-col items-center justify-center gap-3 rounded-md border border-border bg-muted/30 px-4 text-center">
          <Eye className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">תמונה לצפייה חד-פעמית</p>
          <Button size="sm" onClick={() => void openViewOnce()} disabled={viewOnceOpening}>
            {viewOnceOpening && <LoaderCircle className="h-4 w-4 animate-spin" />}
            פתח תמונה
          </Button>
        </div>
      );
    }
    return (
      <div className="mt-2 flex aspect-[4/3] w-full min-w-48 flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-center text-xs text-muted-foreground">
        <Eye className="h-5 w-5" />
        התמונה כבר נצפתה
      </div>
    );
  }

  if (isPaidOpen && !canRenderPaid) {
    const giftFlow = access?.required_gift_id !== null;
    const price = giftFlow ? access?.required_gift_price_credits : access?.price_credits_snapshot;
    const giftName = access?.required_gift_name;
    return (
      <>
        <div className="mt-2 flex aspect-[4/3] w-full min-w-48 flex-col items-center justify-center gap-3 rounded-md border border-border bg-muted/30 px-4 text-center">
          <LockKeyhole className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">
            {giftFlow ? "תמונה נעולה במתנה" : "תמונה לפתיחה בתשלום"}
          </p>
          {typeof price === "number" && (
            <p className="text-xs text-muted-foreground">
              {giftFlow
                ? `${giftName ?? "המתנה שנבחרה"}: ${price} קרדיטים`
                : `פתיחה אחת: ${price} קרדיטים`}
            </p>
          )}
          <Button
            size="sm"
            onClick={() => setPaidOpenConfirmOpen(true)}
            disabled={
              (!canOpenLegacyPaid && !canPurchaseGift && !canOpenPurchasedGift) ||
              paidOpenPurchasing
            }
          >
            {paidOpenPurchasing && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {canOpenPurchasedGift ? "פתח ל-60 שניות" : canPurchaseGift ? "רכוש מתנה" : "פתח תמונה"}
          </Button>
        </div>
        <AlertDialog open={paidOpenConfirmOpen} onOpenChange={setPaidOpenConfirmOpen}>
          <AlertDialogContent dir="rtl">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {canPurchaseGift ? "לרכוש את המתנה?" : "לפתוח את התמונה?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {canOpenPurchasedGift
                  ? "הפתיחה תתחיל חלון צפייה של 60 שניות."
                  : typeof price === "number"
                    ? giftFlow
                      ? `רכישת ${giftName ?? "המתנה"} תחייב ${price} קרדיטים. הפתיחה מתבצעת בנפרד.`
                      : `פתיחה זו תחייב ${price} קרדיטים ותאפשר צפייה קצרה אחת.`
                    : "הפעולה תחייב קרדיטים לפי ההצעה שנשמרה."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={paidOpenPurchasing}>ביטול</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void openPaidAttachment()}
                disabled={paidOpenPurchasing}
              >
                {paidOpenPurchasing && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {canPurchaseGift ? "רכוש מתנה" : "פתח תמונה"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
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
      {isViewOnce && (
        <p className="mt-2 text-xs text-muted-foreground">
          {viewOnceViewing || access?.render_state === "view_once_active"
            ? "התמונה זמינה למשך חלון הצפייה"
            : "תמונה לצפייה חד-פעמית"}
        </p>
      )}
      {isPaidOpen && (
        <p className="mt-2 text-xs text-muted-foreground">
          {access?.render_state === "paid_open_active"
            ? "התמונה זמינה למשך כמה שניות"
            : "תמונה לפתיחה בתשלום"}
        </p>
      )}
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
