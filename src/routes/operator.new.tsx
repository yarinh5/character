import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownUp, Clock3, Inbox, MessageCircle, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useOperator } from "@/components/operator/OperatorLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/operator/new")({
  component: OperatorNewQueuePage,
});

type QueueItem = {
  work_item_id: string;
  conversation_id: string;
  character_id: string;
  status: string;
  queue_state: "new" | "returned";
  client_display_name: string | null;
  character_name: string;
  character_avatar_url: string | null;
  last_client_preview: string;
  last_activity_at: string;
  created_at: string;
};

type QueueFilter = "all" | "new" | "returned" | "waiting";
type QueueSort = "newest" | "oldest";

const WAITING_LONG_MS = 15 * 60 * 1000;

function ageInMinutes(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

function relativeTime(iso: string) {
  const minutes = ageInMinutes(iso);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  return `לפני ${Math.floor(hours / 24)} ימים`;
}

function claimErrorMessage(message: string) {
  if (message.includes("conversation_already_claimed")) return "השיחה כבר נלקחה על ידי עובד אחר.";
  if (message.includes("conversation_locked_by_other_operator")) return "השיחה נעולה כרגע על ידי עובד אחר.";
  if (message.includes("operator_not_assigned_to_character")) return "אין לך שיוך לדמות של השיחה הזו.";
  if (message.includes("conversation_closed")) return "השיחה כבר נסגרה.";
  return "לא ניתן לקחת את השיחה כרגע. נסה שוב.";
}

function QueueStatus({ item }: { item: QueueItem }) {
  const isWaitingLong = ageInMinutes(item.last_activity_at) >= 15;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
        {item.queue_state === "returned" ? "חזרה לתור" : "חדשה"}
      </span>
      {isWaitingLong && (
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">ממתינה</span>
      )}
    </div>
  );
}

function OperatorNewQueuePage() {
  const { operator } = useOperator();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [characterFilter, setCharacterFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<QueueFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<QueueSort>("newest");

  const queue = useQuery({
    queryKey: ["operator-new-queue", operator?.id],
    enabled: Boolean(operator?.id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_operator_new_queue");
      if (error) throw error;
      return (data ?? []) as QueueItem[];
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  const characters = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of queue.data ?? []) byId.set(item.character_id, item.character_name);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [queue.data]);

  const filteredQueue = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("he");
    const items = (queue.data ?? []).filter((item) => {
      if (characterFilter !== "all" && item.character_id !== characterFilter) return false;
      if (statusFilter === "new" && item.queue_state !== "new") return false;
      if (statusFilter === "returned" && item.queue_state !== "returned") return false;
      if (statusFilter === "waiting" && ageInMinutes(item.last_activity_at) < 15) return false;
      if (!normalizedSearch) return true;

      return [item.client_display_name, item.last_client_preview, item.character_name]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("he").includes(normalizedSearch));
    });

    return items.sort((left, right) => {
      const order = new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime();
      return sort === "newest" ? order : -order;
    });
  }, [characterFilter, queue.data, search, sort, statusFilter]);

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

  const hasActiveFilters = characterFilter !== "all" || statusFilter !== "all" || Boolean(search.trim());

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8" dir="rtl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">פניות חדשות</h1>
          <p className="mt-1 text-sm text-muted-foreground">פניות לדמויות שאליהן את/ה משויך/ת.</p>
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

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_180px_160px_160px]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="חיפוש לקוח, דמות או הודעה"
            className="pr-9"
          />
        </div>
        <Select value={characterFilter} onValueChange={setCharacterFilter}>
          <SelectTrigger aria-label="סינון לפי דמות">
            <SelectValue placeholder="כל הדמויות" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל הדמויות</SelectItem>
            {characters.map((character) => (
              <SelectItem key={character.id} value={character.id}>
                {character.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as QueueFilter)}>
          <SelectTrigger aria-label="סינון לפי מצב">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל המצבים</SelectItem>
            <SelectItem value="new">חדשות</SelectItem>
            <SelectItem value="returned">חזרו לתור</SelectItem>
            <SelectItem value="waiting">ממתינות</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as QueueSort)}>
          <SelectTrigger aria-label="מיון פניות">
            <ArrowDownUp className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">אחרונה תחילה</SelectItem>
            <SelectItem value="oldest">הוותיקה תחילה</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {queue.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
      )}

      {queue.error && (
        <Card className="border-destructive/40 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-7 w-7 text-destructive" />
          <p className="font-medium">טעינת הפניות נכשלה</p>
          <Button className="mt-4" variant="outline" onClick={() => void queue.refetch()}>
            נסה שוב
          </Button>
        </Card>
      )}

      {!queue.isLoading && !queue.error && filteredQueue.length === 0 && (
        <Card className="p-10 text-center">
          <Inbox className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{hasActiveFilters ? "לא נמצאו פניות תואמות" : "אין פניות חדשות"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasActiveFilters ? "נסו לשנות את החיפוש או את הסינון." : "פניות חדשות לדמויות שלך יופיעו כאן."}
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {filteredQueue.map((item) => (
          <Card key={item.work_item_id} className="p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-muted">
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
                  <span className="text-xs text-muted-foreground">מול {item.client_display_name ?? "לקוח"}</span>
                  <QueueStatus item={item} />
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{item.last_client_preview || "הודעה חדשה"}</p>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" />
                  {relativeTime(item.last_activity_at)}
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
