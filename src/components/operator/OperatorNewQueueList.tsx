import { AlertTriangle, Clock3, Inbox, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { OperatorNewQueueItem } from "@/hooks/useOperatorNewQueue";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type QueueListProps = {
  items: OperatorNewQueueItem[];
  claimingId: string | null;
  onClaim: (item: OperatorNewQueueItem) => Promise<void>;
  compact?: boolean;
  isLoading?: boolean;
  error?: unknown;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  queueUpdatedAt?: number;
};

function relativeWait(seconds: number) {
  if (seconds < 60) return `לפני ${seconds} שניות`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `לפני ${minutes} דקות`;

  return `לפני ${Math.floor(minutes / 60)} שעות`;
}

function currentWaitSeconds(item: OperatorNewQueueItem, now: number, queueUpdatedAt: number) {
  return Math.max(0, item.wait_seconds + Math.floor((now - queueUpdatedAt) / 1_000));
}

function QueueBadges({ item }: { item: OperatorNewQueueItem }) {
  const label = item.sla_state === "critical" ? "חריגה קריטית" : item.sla_state === "warning" ? "ממתינה" : null;
  const className =
    item.sla_state === "critical"
      ? "bg-destructive/10 text-destructive"
      : "bg-warning/15 text-warning";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
        {item.queue_state === "returned" ? "חזרה לתור" : "חדשה"}
      </span>
      {label && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
          <AlertTriangle className="h-3 w-3" />
          {label}
        </span>
      )}
    </div>
  );
}

export function OperatorNewQueueList({
  items,
  claimingId,
  onClaim,
  compact = false,
  isLoading = false,
  error,
  emptyTitle = "אין פניות חדשות",
  emptyDescription,
  onRetry,
  queueUpdatedAt = Date.now(),
}: QueueListProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className={compact ? "space-y-2 p-3" : "space-y-2"}>
        {Array.from({ length: compact ? 3 : 4 }).map((_, index) => (
          <Skeleton key={index} className={compact ? "h-24" : "h-32"} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className={compact ? "m-3 p-4 text-center" : "p-6 text-center"}>
        <p className="text-sm font-medium">טעינת הפניות נכשלה</p>
        {onRetry && (
          <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
            נסה שוב
          </Button>
        )}
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className={compact ? "m-3 p-5 text-center" : "p-10 text-center"}>
        <Inbox className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{emptyTitle}</p>
        {emptyDescription && <p className="mt-1 text-xs text-muted-foreground">{emptyDescription}</p>}
      </Card>
    );
  }

  return (
    <div className={compact ? "space-y-2 p-3" : "space-y-3"}>
      {items.map((item) => (
        <Card key={item.work_item_id} className={compact ? "p-3" : "p-4"}>
          <div className={compact ? "flex items-start gap-3" : "flex flex-col gap-4 sm:flex-row sm:items-center"}>
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted">
              {item.character_avatar_url ? (
                <img src={item.character_avatar_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center font-semibold">
                  {item.character_name[0] ?? "?"}
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{item.character_name}</span>
                {!compact && <span className="text-xs text-muted-foreground">מול {item.client_display_name ?? "לקוח"}</span>}
                <QueueBadges item={item} />
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">{item.last_client_preview || "הודעה חדשה"}</p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                {relativeWait(currentWaitSeconds(item, now, queueUpdatedAt))}
              </div>
            </div>

            <Button
              className="shrink-0 whitespace-nowrap"
              size={compact ? "sm" : "default"}
              onClick={() => void onClaim(item)}
              disabled={Boolean(claimingId)}
            >
              <MessageCircle className="h-4 w-4" />
              {claimingId === item.work_item_id ? "לוקח..." : "קח שיחה"}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function OperatorNewQueuePanel(props: QueueListProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-card" dir="rtl">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Inbox className="h-4 w-4" />
          NEW
        </div>
        <span className="text-xs text-muted-foreground">{props.items.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <OperatorNewQueueList {...props} compact />
      </div>
    </section>
  );
}
