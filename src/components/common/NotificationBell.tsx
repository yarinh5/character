import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Json } from "@/integrations/supabase/types";

type Notif = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
  metadata: Json | null;
};

function operationalWaitState(notification: Notif) {
  if (notification.type !== "operational_wait_alert") return null;
  const metadata = notification.metadata;
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") return null;
  const state = metadata.state;
  const waitSeconds = metadata.wait_seconds_at_alert;
  if (
    (state !== "active" && state !== "resolved") ||
    typeof waitSeconds !== "number" ||
    !Number.isSafeInteger(waitSeconds) ||
    waitSeconds < 0
  ) {
    return null;
  }
  return { state, waitSeconds };
}

function isExactCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function NotificationBell() {
  const { loading, session, user } = useAuth();
  const identityId = !loading && user && session?.user.id === user.id ? user.id : null;
  const [items, setItems] = useState<Notif[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [stateIdentity, setStateIdentity] = useState<string | null>(null);
  const [hasVerifiedRead, setHasVerifiedRead] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [markPending, setMarkPending] = useState(false);
  const [open, setOpen] = useState(false);
  const generationRef = useRef(0);
  const requestRef = useRef(0);
  const verifiedReadRef = useRef(false);
  const markPendingRef = useRef(false);
  const markOperationRef = useRef(0);

  const fetchItems = useCallback(
    async (refreshFailureMessage = "רענון ההתראות נכשל. הנתונים המוצגים נשמרו.") => {
      if (!identityId) return false;
      const generation = generationRef.current;
      const request = ++requestRef.current;
      const hadVerifiedRead = verifiedReadRef.current;

      setReadError(null);
      if (hadVerifiedRead) setRefreshing(true);
      else setInitialLoading(true);

      try {
        const [listResult, unreadResult] = await Promise.all([
          supabase
            .from("notifications")
            .select("id, type, title, body, link, is_read, created_at, metadata", {
              count: "exact",
            })
            .eq("user_id", identityId)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("notifications")
            .select("id", { count: "exact", head: true })
            .eq("user_id", identityId)
            .eq("is_read", false),
        ]);

        if (generation !== generationRef.current || request !== requestRef.current) return false;
        if (
          listResult.error ||
          unreadResult.error ||
          !isExactCount(listResult.count) ||
          !isExactCount(unreadResult.count)
        ) {
          throw listResult.error ?? unreadResult.error ?? new Error("Invalid notification count");
        }

        setItems(listResult.data ?? []);
        setTotalCount(listResult.count);
        setUnreadCount(unreadResult.count);
        setStateIdentity(identityId);
        verifiedReadRef.current = true;
        setHasVerifiedRead(true);
        setReadError(null);
        return true;
      } catch {
        if (generation !== generationRef.current || request !== requestRef.current) return false;
        setReadError(
          hadVerifiedRead ? refreshFailureMessage : "טעינת ההתראות נכשלה. אפשר לנסות שוב.",
        );
        return false;
      } finally {
        if (generation === generationRef.current && request === requestRef.current) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    },
    [identityId],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    requestRef.current += 1;
    markOperationRef.current += 1;
    verifiedReadRef.current = false;
    markPendingRef.current = false;
    setItems([]);
    setTotalCount(0);
    setUnreadCount(0);
    setStateIdentity(identityId);
    setHasVerifiedRead(false);
    setInitialLoading(Boolean(identityId));
    setRefreshing(false);
    setReadError(null);
    setMarkError(null);
    setMarkPending(false);
    setOpen(false);

    if (!identityId) return;

    void fetchItems();
    const channel = supabase
      .channel(`notif-${identityId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${identityId}`,
        },
        () => {
          void fetchItems();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${identityId}`,
        },
        () => {
          void fetchItems();
        },
      )
      .subscribe();

    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
        requestRef.current += 1;
        markOperationRef.current += 1;
      }
      void supabase.removeChannel(channel);
    };
  }, [fetchItems, identityId]);

  const currentItems = stateIdentity === identityId ? items : [];
  const currentHasVerifiedRead = stateIdentity === identityId && hasVerifiedRead;
  const currentTotalCount = stateIdentity === identityId ? totalCount : 0;
  const unread = stateIdentity === identityId ? unreadCount : 0;

  const markAllRead = async () => {
    if (!identityId || unread === 0 || markPendingRef.current) return;
    markPendingRef.current = true;
    const operation = ++markOperationRef.current;
    const generation = generationRef.current;
    setMarkPending(true);
    setMarkError(null);

    try {
      const { data, error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", identityId)
        .eq("is_read", false)
        .select("id");

      if (generation !== generationRef.current || operation !== markOperationRef.current) return;
      if (error || !Array.isArray(data)) throw error ?? new Error("Invalid update result");

      await fetchItems("ההתראות סומנו, אך רענון הרשימה נכשל. הנתונים המוצגים נשמרו.");
    } catch {
      if (generation === generationRef.current && operation === markOperationRef.current) {
        setMarkError("סימון ההתראות נכשל. לא בוצע שינוי מקומי.");
      }
    } finally {
      if (generation === generationRef.current && operation === markOperationRef.current) {
        markPendingRef.current = false;
        setMarkPending(false);
      }
    }
  };

  if (!identityId) return null;

  return (
    <Popover open={open && stateIdentity === identityId} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="התראות">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-1 -left-1 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center font-bold">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-1rem))] p-0" dir="rtl" align="end">
        <div className="flex items-center justify-between gap-3 p-3 border-b">
          <div className="font-semibold text-sm">התראות</div>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={markPending}
              aria-label={markPending ? "מסמן התראות" : "סמן הכל כנקרא"}
              className="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              {markPending ? "מסמן…" : "סמן הכל כנקרא"}
            </button>
          )}
        </div>
        {refreshing && (
          <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
            מרענן התראות…
          </div>
        )}
        {readError && stateIdentity === identityId && (
          <div role="alert" className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p>{readError}</p>
            <button
              type="button"
              onClick={() => void fetchItems()}
              className="mt-1 font-medium text-primary hover:underline"
            >
              נסה שוב
            </button>
          </div>
        )}
        {markError && stateIdentity === identityId && (
          <div
            role="alert"
            className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {markError}
          </div>
        )}
        <div className="max-h-96 overflow-y-auto">
          {initialLoading && !currentHasVerifiedRead && (
            <div role="status" className="p-6 text-center text-sm text-muted-foreground">
              טוען התראות…
            </div>
          )}
          {!initialLoading && currentHasVerifiedRead && currentItems.length === 0 && (
            <div className="p-6 text-sm text-center text-muted-foreground">אין התראות</div>
          )}
          {currentItems.map((notification) => {
            const waitState = operationalWaitState(notification);
            const content = (
              <div
                className={cn(
                  "p-3 border-b last:border-0 hover:bg-accent transition-colors",
                  !notification.is_read && "bg-primary/5",
                )}
              >
                <div className="flex items-start gap-2">
                  {!notification.is_read && (
                    <span className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 break-words">
                    <div className="font-medium text-sm break-words">{notification.title}</div>
                    {notification.body && (
                      <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5 break-words">
                        {notification.body}
                      </div>
                    )}
                    {waitState && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 font-medium",
                            waitState.state === "active"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-emerald-100 text-emerald-900",
                          )}
                        >
                          {waitState.state === "active" ? "פעילה" : "נפתרה"}
                        </span>
                        <span className="text-muted-foreground">
                          המתנה בעת ההתראה: {Math.floor(waitState.waitSeconds / 60)} דק׳
                        </span>
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {new Date(notification.created_at).toLocaleString("he-IL")}
                    </div>
                  </div>
                </div>
              </div>
            );
            return notification.link ? (
              <Link key={notification.id} to={notification.link} onClick={() => setOpen(false)}>
                {content}
              </Link>
            ) : (
              <div key={notification.id}>{content}</div>
            );
          })}
          {currentHasVerifiedRead && currentTotalCount > currentItems.length && (
            <div className="border-t p-3 text-center text-xs text-muted-foreground">
              מוצגות {currentItems.length} ההתראות האחרונות מתוך {currentTotalCount}.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
