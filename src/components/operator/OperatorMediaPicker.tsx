import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Eye, Image, LoaderCircle, LockKeyhole, RefreshCw, Send, X } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type OperatorCatalogAsset = Database["public"]["Functions"]["get_operator_media_catalog"]["Returns"][number];
type AdminCatalogAsset = Database["public"]["Functions"]["get_admin_media_catalog"]["Returns"][number];
type CatalogAsset = OperatorCatalogAsset | AdminCatalogAsset;
type DeliveryMode = "standard" | "locked";
type ViewMode = "permanent" | "view_once" | "paid_open";
type MediaPickerActor = "operator" | "admin";

type SelectedReservation = {
  assetId: string;
  displayName: string;
  expiresAt: string;
  reservationId: string;
  accessMode: DeliveryMode;
  paidOpenPriceCredits: number | null;
};

type ReservationResponse = {
  reservation_id?: unknown;
  expires_at?: unknown;
  intended_access_mode?: unknown;
};

type SendResponse = {
  already_sent?: unknown;
};

type CatalogTag = {
  id: string;
  name: string;
};

function getCatalogTag(asset: CatalogAsset): CatalogTag | null {
  if (!("media_tag_id" in asset) || !("media_tag_name" in asset)) return null;
  if (typeof asset.media_tag_id !== "string" || typeof asset.media_tag_name !== "string") return null;
  return { id: asset.media_tag_id, name: asset.media_tag_name };
}

function toDeliveryMode(value: unknown): DeliveryMode {
  return value === "locked" ? "locked" : "standard";
}

function getPaidOpenPrice(asset: CatalogAsset) {
  return typeof asset.paid_open_price_credits === "number" && asset.paid_open_price_credits > 0
    ? asset.paid_open_price_credits
    : null;
}

function getErrorMessage(error: { message?: string } | null) {
  return error?.message ?? "";
}

function showCatalogError(message: string) {
  if (message.includes("conversation_locked_by_other_operator")) {
    toast.error("השיחה נעולה כרגע לעובד אחר");
    return;
  }
  if (message.includes("conversation_closed")) {
    toast.error("לא ניתן לבחור מדיה בשיחה סגורה");
    return;
  }
  toast.error("טעינת מאגר המדיה נכשלה");
}

function showReservationError(message: string) {
  if (message.includes("locked_images_disabled")) {
    toast.error("מדיה נעולה אינה פעילה כרגע");
    return;
  }
  if (message.includes("conversation_locked_by_other_operator")) {
    toast.error("השיחה נעולה כרגע לעובד אחר");
    return;
  }
  if (message.includes("media_asset_not_reservable") || message.includes("media_asset_not_ready")) {
    toast.error("המדיה כבר אינה זמינה לבחירה");
    return;
  }
  toast.error("שמירת המדיה נכשלה");
}

function showSendError(message: string) {
  if (message.includes("locked_images_disabled")) {
    toast.error("מדיה נעולה אינה פעילה כרגע");
    return;
  }
  if (message.includes("conversation_locked_by_other_operator")) {
    toast.error("השיחה נעולה כרגע לעובד אחר");
    return;
  }
  if (message.includes("media_reservation_expired")) {
    toast.error("זמן הבחירה הסתיים. יש לבחור מדיה מחדש");
    return;
  }
  if (
    message.includes("media_reservation_released") ||
    message.includes("media_reservation_not_owned")
  ) {
    toast.error("הבחירה אינה זמינה יותר");
    return;
  }
  if (message.includes("media_not_available")) {
    toast.error("תצוגת המדיה אינה זמינה כרגע");
    return;
  }
  toast.error("שליחת המדיה נכשלה");
}

function formatBytes(byteSize: number) {
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.round(byteSize / 1024))} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function OperatorMediaPicker({
  actor = "operator",
  conversationId,
  open,
  onOpenChange,
}: {
  actor?: MediaPickerActor;
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [catalog, setCatalog] = useState<CatalogAsset[]>([]);
  const [catalogState, setCatalogState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [selectedTagId, setSelectedTagId] = useState("all");
  const [reservation, setReservation] = useState<SelectedReservation | null>(null);
  const [caption, setCaption] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("permanent");
  const [reservingAssetId, setReservingAssetId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const reservationRef = useRef<SelectedReservation | null>(null);
  const releaseInFlightRef = useRef<string | null>(null);
  const catalogRequestRef = useRef(0);
  const preview = useMediaViewUrl("reserved_preview", reservation?.reservationId);

  const clearReservation = useCallback(() => {
    reservationRef.current = null;
    setReservation(null);
    setCaption("");
    setViewMode("permanent");
  }, []);

  const loadCatalog = useCallback(async () => {
    const requestVersion = ++catalogRequestRef.current;
    setCatalogState("loading");
    const { data, error } = actor === "admin"
      ? await supabase.rpc("get_admin_media_catalog", { _conversation_id: conversationId })
      : await supabase.rpc("get_operator_media_catalog", { _conversation_id: conversationId });
    if (requestVersion !== catalogRequestRef.current) return;

    if (error) {
      setCatalogState("error");
      showCatalogError(getErrorMessage(error));
      return;
    }

    const nextCatalog = data ?? [];
    setCatalog(nextCatalog);
    setCatalogState("ready");

    const ownReservation = nextCatalog.find(
      (asset) =>
        asset.is_reserved_by_me && asset.my_reservation_id && asset.my_reservation_expires_at,
    );
    if (ownReservation && !reservationRef.current) {
      const nextReservation = {
        assetId: ownReservation.id,
        displayName: ownReservation.display_name,
        expiresAt: ownReservation.my_reservation_expires_at,
        reservationId: ownReservation.my_reservation_id,
        accessMode: toDeliveryMode(ownReservation.my_reservation_access_mode),
        paidOpenPriceCredits: getPaidOpenPrice(ownReservation),
      };
      reservationRef.current = nextReservation;
      setReservation(nextReservation);
    }
    if (!ownReservation && reservationRef.current) clearReservation();
  }, [actor, clearReservation, conversationId]);

  const releaseReservation = useCallback(
    async (reservationId: string, notify: boolean) => {
      if (releaseInFlightRef.current === reservationId) return;
      releaseInFlightRef.current = reservationId;
      if (reservationRef.current?.reservationId === reservationId) clearReservation();

      const { error } = actor === "admin"
        ? await supabase.rpc("release_admin_character_media_reservation", { _reservation_id: reservationId })
        : await supabase.rpc("release_character_media_reservation", { _reservation_id: reservationId });
      releaseInFlightRef.current = null;

      if (error) {
        if (notify) toast.error("שחרור בחירת המדיה נכשל");
        return;
      }
      void loadCatalog();
      if (notify) toast.success("בחירת המדיה שוחררה");
    },
    [actor, clearReservation, loadCatalog],
  );

  const closePicker = useCallback(() => {
    if (sending) return;
    const activeReservation = reservationRef.current;
    if (activeReservation) void releaseReservation(activeReservation.reservationId, false);
    onOpenChange(false);
  }, [onOpenChange, releaseReservation, sending]);

  useEffect(() => {
    if (!open) return;
    void loadCatalog();
  }, [loadCatalog, open]);

  useEffect(() => {
    return () => {
      const activeReservation = reservationRef.current;
      if (activeReservation) void releaseReservation(activeReservation.reservationId, false);
    };
  }, [releaseReservation]);

  useEffect(() => {
    if (!reservation) return;
    const interval = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [reservation]);

  const remainingMilliseconds = useMemo(
    () => (reservation ? new Date(reservation.expiresAt).getTime() - clock : 0),
    [clock, reservation],
  );

  const availableTags = useMemo(() => {
    if (actor !== "operator") return [];
    const tags = new Map<string, CatalogTag>();
    for (const asset of catalog) {
      if (!asset.is_reservable && !asset.is_locked_reservable && !asset.is_reserved_by_me) continue;
      const tag = getCatalogTag(asset);
      if (tag) tags.set(tag.id, tag);
    }
    return [...tags.values()].sort((left, right) => left.name.localeCompare(right.name, "he"));
  }, [actor, catalog]);

  const visibleCatalog = useMemo(
    () => selectedTagId === "all"
      ? catalog
      : catalog.filter((asset) => getCatalogTag(asset)?.id === selectedTagId),
    [catalog, selectedTagId],
  );

  useEffect(() => {
    if (selectedTagId !== "all" && !availableTags.some((tag) => tag.id === selectedTagId)) {
      setSelectedTagId("all");
    }
  }, [availableTags, selectedTagId]);

  useEffect(() => {
    if (!reservation || remainingMilliseconds > 0) return;
    clearReservation();
    void loadCatalog();
    toast.error("זמן הבחירה הסתיים. יש לבחור מדיה מחדש");
  }, [clearReservation, loadCatalog, remainingMilliseconds, reservation]);

  const selectAsset = async (asset: CatalogAsset, accessMode: DeliveryMode) => {
    if (reservation || reservingAssetId) return;

    if (asset.is_reserved_by_me && asset.my_reservation_id && asset.my_reservation_expires_at) {
      const nextReservation = {
        assetId: asset.id,
        displayName: asset.display_name,
        expiresAt: asset.my_reservation_expires_at,
        reservationId: asset.my_reservation_id,
        accessMode: toDeliveryMode(asset.my_reservation_access_mode),
        paidOpenPriceCredits: getPaidOpenPrice(asset),
      };
      reservationRef.current = nextReservation;
      setReservation(nextReservation);
      return;
    }

    if (accessMode === "locked" ? !asset.is_locked_reservable : !asset.is_reservable) return;
    setReservingAssetId(asset.id);
    const { data, error } = actor === "admin"
      ? await supabase.rpc("reserve_admin_character_media_asset", {
          _asset_id: asset.id,
          _conversation_id: conversationId,
        })
      : await supabase.rpc("reserve_character_media_for_delivery", {
          _asset_id: asset.id,
          _conversation_id: conversationId,
          _intended_access_mode: accessMode,
        });
    setReservingAssetId(null);

    if (error) {
      showReservationError(getErrorMessage(error));
      void loadCatalog();
      return;
    }

    const payload = (data ?? {}) as ReservationResponse;
    if (
      typeof payload.reservation_id !== "string" ||
      typeof payload.expires_at !== "string" ||
      (actor !== "admin" && payload.intended_access_mode !== "standard" && payload.intended_access_mode !== "locked")
    ) {
      toast.error("לא התקבל אישור תקין לבחירת המדיה");
      void loadCatalog();
      return;
    }
    const reservationId = payload.reservation_id;
    const expiresAt = payload.expires_at;
    const reservationAccessMode = actor === "admin" ? "standard" : toDeliveryMode(payload.intended_access_mode);

    const nextReservation = {
      assetId: asset.id,
      displayName: asset.display_name,
      expiresAt,
      reservationId,
      accessMode: reservationAccessMode,
      paidOpenPriceCredits: getPaidOpenPrice(asset),
    };
    reservationRef.current = nextReservation;
    setReservation(nextReservation);
    if (reservationAccessMode === "locked") setViewMode("permanent");
    setCatalog((current) =>
      current.map((currentAsset) =>
        currentAsset.id === asset.id
          ? {
              ...currentAsset,
              is_reservable: false,
              is_locked_reservable: false,
              is_reserved_by_me: true,
              my_reservation_id: reservationId,
              my_reservation_expires_at: expiresAt,
              my_reservation_access_mode: reservationAccessMode,
              status: "reserved",
            }
          : currentAsset,
      ),
    );
  };

  const sendMedia = async () => {
    if (!reservation || sending) return;
    if (remainingMilliseconds <= 0) {
      clearReservation();
      void loadCatalog();
      toast.error("זמן הבחירה הסתיים. יש לבחור מדיה מחדש");
      return;
    }
    if (preview.status !== "ready" || !preview.url) {
      toast.error("אי אפשר לשלוח לפני שהתצוגה המקדימה נטענת בהצלחה");
      return;
    }

    setSending(true);
    const { data, error } = actor === "admin"
      ? await supabase.rpc("send_admin_media_message", {
          _reservation_id: reservation.reservationId,
          _caption: caption.trim() || undefined,
        })
      : await supabase.rpc(
          reservation.accessMode === "locked" ? "send_operator_locked_media_message" : "send_operator_media_message",
          {
            _reservation_id: reservation.reservationId,
            _caption: caption.trim() || undefined,
            _view_mode: viewMode,
          },
        );
    setSending(false);

    if (error) {
      const message = getErrorMessage(error);
      showSendError(message);
      if (
        message.includes("media_reservation_expired") ||
        message.includes("media_reservation_released") ||
        message.includes("media_reservation_not_owned")
      ) {
        clearReservation();
        void loadCatalog();
      }
      return;
    }

    const result = (data ?? {}) as SendResponse;
    clearReservation();
    onOpenChange(false);
    toast.success(result.already_sent === true ? "המדיה כבר נשלחה" : "המדיה נשלחה");
  };

  const pickerContent = (
    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
      {reservation ? (
        <section
          className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
          aria-live="polite"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{reservation.displayName}</p>
              {reservation.accessMode === "locked" && (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <LockKeyhole className="h-3.5 w-3.5" /> תצוגת teaser נעולה
                </p>
              )}
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                שמור לשליחה לעוד {formatRemaining(remainingMilliseconds)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void releaseReservation(reservation.reservationId, true)}
              disabled={sending}
              aria-label="ביטול בחירת המדיה"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {preview.status === "loading" && (
            <div
              className="aspect-[4/3] w-full animate-pulse rounded-md bg-muted"
              role="status"
              aria-label="טוען תצוגה מקדימה"
            />
          )}
          {preview.status === "error" && (
            <div className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-border bg-muted/40 px-4 text-center text-sm text-muted-foreground">
              התצוגה המקדימה אינה זמינה. אי אפשר לשלוח עד לטעינה תקינה או לבחירה חדשה.
            </div>
          )}
          {actor === "operator" && reservation.accessMode === "standard" && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">אופן צפייה</p>
              <div
                className={reservation.paidOpenPriceCredits === null ? "grid grid-cols-2 gap-2" : "grid grid-cols-3 gap-2"}
                role="group"
                aria-label="אופן צפייה במדיה"
              >
                <Button
                  type="button"
                  variant={viewMode === "permanent" ? "default" : "outline"}
                  className="shrink-0"
                  onClick={() => setViewMode("permanent")}
                  disabled={sending}
                >
                  קבוע
                </Button>
                <Button
                  type="button"
                  variant={viewMode === "view_once" ? "default" : "outline"}
                  className="shrink-0"
                  onClick={() => setViewMode("view_once")}
                  disabled={sending}
                >
                  <Eye className="h-4 w-4" />
                  צפייה חד-פעמית
                </Button>
                {reservation.paidOpenPriceCredits !== null && (
                  <Button
                    type="button"
                    variant={viewMode === "paid_open" ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() => setViewMode("paid_open")}
                    disabled={sending}
                  >
                    <LockKeyhole className="h-4 w-4" />
                    בתשלום
                  </Button>
                )}
              </div>
              {viewMode === "view_once" && (
                <p className="text-xs text-muted-foreground">התמונה זמינה ללקוח לפתיחה אחת בלבד.</p>
              )}
              {viewMode === "paid_open" && reservation.paidOpenPriceCredits !== null && (
                <p className="text-xs text-muted-foreground">
                  הלקוח ישלם {reservation.paidOpenPriceCredits} קרדיטים עבור כל פתיחה קצרה.
                </p>
              )}
            </div>
          )}
          {preview.status === "ready" && preview.url && (
            <img
              src={preview.url}
              alt="תצוגה מקדימה של המדיה שנבחרה"
              className="aspect-[4/3] w-full rounded-md object-cover"
              referrerPolicy="no-referrer"
              onError={preview.retryAfterImageError}
            />
          )}

          <Textarea
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="כיתוב אופציונלי"
            maxLength={1000}
            rows={2}
            disabled={sending}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{caption.length}/1000</span>
            <Button
              type="button"
              onClick={() => void sendMedia()}
              disabled={
                sending ||
                remainingMilliseconds <= 0 ||
                preview.status !== "ready" ||
                !preview.url
              }
            >
              {sending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              שלח מדיה
            </Button>
          </div>
        </section>
      ) : (
        <section className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
          {catalogState === "loading" && (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="me-2 h-4 w-4 animate-spin" /> טוען מאגר מדיה
            </div>
          )}
          {catalogState === "error" && (
            <div className="flex h-32 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
              <span>לא ניתן לטעון את מאגר המדיה כרגע.</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadCatalog()}>
                <RefreshCw className="h-4 w-4" /> נסה שוב
              </Button>
            </div>
          )}
          {catalogState === "ready" && catalog.length === 0 && (
            <div className="flex h-32 items-center justify-center text-center text-sm text-muted-foreground">
              אין מדיה זמינה עבור הדמות בשלב זה.
            </div>
          )}
          {catalogState === "ready" && catalog.length > 0 && (
            <div className="space-y-3">
              {availableTags.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1" aria-label="סינון מדיה לפי תגית">
                  <Button
                    type="button"
                    size="sm"
                    variant={selectedTagId === "all" ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() => setSelectedTagId("all")}
                  >
                    הכל
                  </Button>
                  {availableTags.map((tag) => (
                    <Button
                      key={tag.id}
                      type="button"
                      size="sm"
                      variant={selectedTagId === tag.id ? "default" : "outline"}
                      className="shrink-0"
                      onClick={() => setSelectedTagId(tag.id)}
                    >
                      {tag.name}
                    </Button>
                  ))}
                </div>
              )}
              {visibleCatalog.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-center text-sm text-muted-foreground">
                  אין מדיה זמינה בתגית שנבחרה.
                </div>
              ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleCatalog.map((asset) => {
                const reserving = reservingAssetId === asset.id;
                const accessMode: DeliveryMode =
                  actor === "admin" ? "standard" : asset.is_locked_reservable ? "locked" : "standard";
                const available =
                  asset.is_reserved_by_me ||
                  (accessMode === "locked" ? asset.is_locked_reservable : asset.is_reservable);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => void selectAsset(asset, accessMode)}
                    disabled={!available || Boolean(reservingAssetId)}
                    aria-pressed={asset.is_reserved_by_me}
                    className="flex min-h-24 items-center gap-3 rounded-md border border-border bg-card p-3 text-right transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55 focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {reserving ? (
                        <LoaderCircle className="h-5 w-5 animate-spin" />
                      ) : (
                        <Image className="h-5 w-5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 truncate text-sm font-medium">
                        {asset.locked_price_credits !== null && <LockKeyhole className="h-3.5 w-3.5 shrink-0" />}
                        {asset.display_name}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {asset.content_type.replace("image/", "").toUpperCase()} ·{" "}
                        {formatBytes(asset.byte_size)}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {asset.is_reserved_by_me
                          ? "נבחרה עבורך"
                          : asset.is_locked_reservable
                            ? `מדיה נעולה · ${asset.locked_price_credits} קרדיטים`
                            : asset.is_reservable
                            ? "זמינה"
                            : asset.locked_price_credits !== null && !asset.locked_images_enabled
                              ? "מדיה נעולה אינה פעילה"
                            : "לא זמינה"}
                      </span>
                    </span>
                  </button>
                );
              })}
              </div>
              )}
            </div>
          )}
        </section>
      )}
      <div className="flex justify-end border-t border-border pt-3">
        <Button type="button" variant="outline" onClick={closePicker} disabled={sending}>
          ביטול
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : closePicker())}
      >
        <SheetContent side="bottom" className="flex max-h-[92dvh] flex-col" dir="rtl">
          <SheetHeader>
            <SheetTitle>בחירת מדיה</SheetTitle>
            <SheetDescription>בחירת תמונה מהמאגר של הדמות לשליחה בשיחה.</SheetDescription>
          </SheetHeader>
          {pickerContent}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : closePicker())}
    >
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle>בחירת מדיה</DialogTitle>
          <DialogDescription>בחירת תמונה מהמאגר של הדמות לשליחה בשיחה.</DialogDescription>
        </DialogHeader>
        {pickerContent}
      </DialogContent>
    </Dialog>
  );
}
