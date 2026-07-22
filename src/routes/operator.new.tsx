import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock3, Inbox, MessageCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useOperator } from "@/components/operator/OperatorLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/operator/new")({
  component: OperatorNewQueuePage,
});

type QueueItem = {
  work_item_id: string;
  conversation_id: string;
  status: string;
  client_display_name: string | null;
  character_name: string;
  character_avatar_url: string | null;
  last_client_preview: string;
  last_activity_at: string;
  created_at: string;
};

function formatTime(iso: string) {
  const date = new Date(iso);
  const today = new Date();

  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function claimErrorMessage(message: string) {
  if (message.includes("conversation_already_claimed")) return "השיחה כבר נלקחה על ידי עובד אחר.";
  if (message.includes("conversation_locked_by_other_operator"))
    return "השיחה נעולה כרגע על ידי עובד אחר.";
  if (message.includes("operator_not_assigned_to_character"))
    return "אין לך שיוך לדמות של השיחה הזו.";
  if (message.includes("conversation_closed")) return "השיחה כבר נסגרה.";
  return "לא ניתן לקחת את השיחה כרגע. נסה שוב.";
}

function OperatorNewQueuePage() {
  const { operator } = useOperator();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ["operator-new-queue", operator?.id],
    enabled: Boolean(operator?.id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_operator_new_queue");
      if (error) throw error;
      return (data ?? []) as QueueItem[];
    },
    refetchInterval: 30_000,
  });

  const claimConversation = async (item: QueueItem) => {
    if (claimingId) return;

    setClaimingId(item.work_item_id);
    try {
      const { data, error } = await supabase.rpc("claim_new_conversation", {
        _work_item_id: item.work_item_id,
      });
      if (error) {
        toast.error(claimErrorMessage(error.message));
        await queue.refetch();
        return;
      }

      const result = data as { conversation_id?: string } | null;
      if (!result?.conversation_id) {
        toast.error("לא התקבלה שיחה לפתיחה. נסה שוב.");
        await queue.refetch();
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operator-new-queue"] }),
        queryClient.invalidateQueries({ queryKey: ["operator-conversations"] }),
      ]);
      navigate({
        to: "/operator/chat/$conversationId",
        params: { conversationId: result.conversation_id },
      });
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8" dir="rtl">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">פניות חדשות</h1>
          <p className="mt-1 text-sm text-muted-foreground">פניות שממתינות לעובד המשויך לדמות.</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => void queue.refetch()}
          disabled={queue.isFetching}
          aria-label="רענון פניות חדשות"
          title="רענון"
        >
          <RefreshCw className={queue.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      </header>

      {queue.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      )}

      {queue.error && (
        <Card className="border-destructive/40 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-7 w-7 text-destructive" />
          <p className="font-medium">טעינת הפניות נכשלה</p>
          <p className="mt-1 text-sm text-muted-foreground">נסה לרענן את הרשימה.</p>
        </Card>
      )}

      {!queue.isLoading && !queue.error && queue.data?.length === 0 && (
        <Card className="p-10 text-center">
          <Inbox className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">אין פניות חדשות</p>
          <p className="mt-1 text-sm text-muted-foreground">פניות חדשות לדמויות שלך יופיעו כאן.</p>
        </Card>
      )}

      <div className="space-y-3">
        {queue.data?.map((item) => (
          <Card key={item.work_item_id} className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-muted">
                {item.character_avatar_url ? (
                  <img
                    src={item.character_avatar_url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-semibold">
                    {item.character_name[0] ?? "?"}
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{item.character_name}</span>
                  <span className="text-xs text-muted-foreground">
                    מול {item.client_display_name ?? "לקוח"}
                  </span>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    חדשה
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {item.last_client_preview || "הודעה חדשה"}
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" />
                  {formatTime(item.last_activity_at)}
                </div>
              </div>

              <Button
                className="shrink-0 whitespace-nowrap"
                onClick={() => void claimConversation(item)}
                disabled={Boolean(claimingId)}
              >
                <MessageCircle className="h-4 w-4" />
                {claimingId === item.work_item_id ? "לוקח..." : "קח שיחה"}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
