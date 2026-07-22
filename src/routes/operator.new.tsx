import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowDownUp, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useOperator } from "@/components/operator/OperatorLayout";
import { OperatorNewQueueList } from "@/components/operator/OperatorNewQueueList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { operatorNewQueueClaimError, type OperatorNewQueueItem, useOperatorNewQueue } from "@/hooks/useOperatorNewQueue";

export const Route = createFileRoute("/operator/new")({
  component: OperatorNewQueuePage,
});

type QueueFilter = "all" | "new" | "returned" | "waiting";
type QueueSort = "newest" | "oldest";

const WAITING_LONG_MS = 15 * 60 * 1000;

function ageInMinutes(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

function OperatorNewQueuePage() {
  const { operator } = useOperator();
  const navigate = useNavigate();
  const [characterFilter, setCharacterFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<QueueFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<QueueSort>("newest");

  const queue = useOperatorNewQueue(operator?.id);

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

  const claimConversation = async (item: OperatorNewQueueItem) => {
    const result = await queue.claimConversation(item.work_item_id);
    if (!result.ok) {
      toast.error(operatorNewQueueClaimError(result.errorMessage));
      return;
    }

    navigate({
      to: "/operator/chat/$conversationId",
      params: { conversationId: result.conversationId },
    });
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

      <OperatorNewQueueList
        items={filteredQueue}
        claimingId={queue.claimingId}
        onClaim={claimConversation}
        isLoading={queue.isLoading}
        error={queue.error}
        onRetry={() => void queue.refetch()}
        emptyTitle={hasActiveFilters ? "לא נמצאו פניות תואמות" : "אין פניות חדשות"}
        emptyDescription={hasActiveFilters ? "נסו לשנות את החיפוש או את הסינון." : "פניות חדשות לדמויות שלך יופיעו כאן."}
      />
    </div>
  );
}
