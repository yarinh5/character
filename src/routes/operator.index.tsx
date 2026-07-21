import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchUnreadCounts, logSupabaseError } from "@/lib/readStates";
import { fetchSlaRiskConversations } from "@/lib/slaMonitoring";
import { useOperator, ConversationStatusBadge } from "@/components/operator/OperatorLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Award, BarChart3, Bell, Clock, MessageCircle, Send, Sparkles, Timer, Users } from "lucide-react";

export const Route = createFileRoute("/operator/")({
  component: OperatorDashboard,
});

const STATUS_OPTIONS = [
  { value: "available", label: "זמין", cls: "bg-success text-success-foreground" },
  { value: "busy", label: "עסוק", cls: "bg-warning text-warning-foreground" },
  { value: "offline", label: "לא מחובר", cls: "bg-muted text-muted-foreground" },
] as const;

type DashboardMessage = {
  conversation_id: string;
  sender_type: string;
  operator_id: string | null;
  created_at: string;
};

function OperatorDashboard() {
  const { operator, isAdmin, walletBalance, refresh } = useOperator();
  const qc = useQueryClient();

  const { data: stats, isLoading, error } = useQuery({
    queryKey: ["operator-stats", operator?.id ?? "admin", isAdmin],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthStartIso = monthStart.toISOString();
      const previousMonthStart = new Date(monthStart);
      previousMonthStart.setMonth(previousMonthStart.getMonth() - 1);
      const previousMonthStartIso = previousMonthStart.toISOString();

      let characterIds: string[] | null = null;
      if (operator && !isAdmin) {
        const { data: assignments, error: assignmentsError } = await supabase
          .from("character_operator_assignments")
          .select("character_id")
          .eq("operator_id", operator.id);
        if (assignmentsError) {
          logSupabaseError("operator.dashboard assignments", assignmentsError);
          throw assignmentsError;
        }
        characterIds = (assignments ?? []).map((assignment) => assignment.character_id);
      }

      let convQuery = supabase
        .from("conversations")
        .select("id, status, operator_unread_count, last_message_at, last_message_preview, characters(id, name, avatar_url), client_id, updated_at")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (characterIds) {
        convQuery =
          characterIds.length === 0
            ? convQuery.in("character_id", ["00000000-0000-0000-0000-000000000000"])
            : convQuery.in("character_id", characterIds);
      }

      const [{ data: convs, error }, { data: assigned }, monthlyPointTransactions, previousPointTransactions, sentMessagesResult] =
        await Promise.all([
          convQuery,
          operator
            ? supabase
                .from("character_operator_assignments")
                .select("character_id, characters(id, name, avatar_url, availability_status)")
                .eq("operator_id", operator.id)
            : Promise.resolve({ data: [] as unknown[] }),
          operator
            ? (supabase
                .from("credit_transactions")
                .select("amount")
                .eq("user_id", operator.user_id)
                .in("type", ["message_payout", "sticker_payout"])
                .gte("created_at", monthStartIso) as any)
            : Promise.resolve({ data: [] }),
          operator
            ? (supabase
                .from("credit_transactions")
                .select("amount")
                .eq("user_id", operator.user_id)
                .in("type", ["message_payout", "sticker_payout"])
                .gte("created_at", previousMonthStartIso)
                .lt("created_at", monthStartIso) as any)
            : Promise.resolve({ data: [] }),
          operator
            ? supabase
                .from("messages")
                .select("id", { count: "exact", head: true })
                .eq("operator_id", operator.id)
                .eq("sender_type", "operator")
                .gte("created_at", monthStartIso)
            : Promise.resolve({ count: 0 }),
        ]);
      if (error) {
        logSupabaseError("operator.dashboard conversations", error);
        throw error;
      }
      if ((monthlyPointTransactions as { error?: unknown }).error) {
        logSupabaseError("operator.dashboard monthly points", (monthlyPointTransactions as { error: unknown }).error);
      }
      if ((previousPointTransactions as { error?: unknown }).error) {
        logSupabaseError("operator.dashboard previous points", (previousPointTransactions as { error: unknown }).error);
      }
      if ((sentMessagesResult as { error?: unknown }).error) {
        logSupabaseError("operator.dashboard sent messages", (sentMessagesResult as { error: unknown }).error);
      }

      const [unreadCounts, slaRisks] = await Promise.all([
        fetchUnreadCounts((convs ?? []).map((c) => c.id)),
        fetchSlaRiskConversations(5, true),
      ]);
      const list = (convs ?? []).map((conversation) => ({
        ...conversation,
        operator_unread_count: unreadCounts.get(conversation.id)?.unread_count ?? 0,
      }));
      const conversationIds = list.map((c) => c.id);
      const { data: monthMessages } =
        conversationIds.length > 0
          ? await supabase
              .from("messages")
              .select("conversation_id, sender_type, operator_id, created_at")
              .in("conversation_id", conversationIds)
              .gte("created_at", monthStartIso)
              .order("created_at", { ascending: true })
              .limit(1000)
          : { data: [] as DashboardMessage[] };

      const active = list.filter((c) => c.status !== "closed").length;
      const waitingConversations = list.filter((c) => c.status === "waiting" || (c.operator_unread_count ?? 0) > 0);
      const waiting = waitingConversations.length;
      const unread = list.reduce((s, c) => s + (c.operator_unread_count ?? 0), 0);
      const closedToday = list.filter(
        (c) => c.status === "closed" && c.updated_at && new Date(c.updated_at) >= today,
      ).length;
      const monthlyPoints = sumPointTransactions(monthlyPointTransactions.data);
      const previousPoints = sumPointTransactions(previousPointTransactions.data);

      return {
        active,
        waiting,
        unread,
        closedToday,
        walletBalance: walletBalance ?? 0,
        monthlyPoints,
        monthlyPointChange: monthlyPoints - previousPoints,
        scoredMessages: (monthlyPointTransactions.data ?? []).length,
        sentThisMonth: sentMessagesResult.count ?? 0,
        avgResponseSec: calculateAverageResponseSeconds((monthMessages ?? []) as DashboardMessage[], operator?.id),
        waitingConversations: waitingConversations.slice(0, 5),
        slaRisks,
        recent: list.slice(0, 5),
        assignedCharacters: (assigned ?? []) as Array<{
          character_id: string;
          characters: { id: string; name: string; avatar_url: string | null; availability_status: string } | null;
        }>,
      };
    },
    refetchInterval: 30000,
  });

  useEffect(() => {
    const ch = supabase
      .channel("operator-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_read_states",
          filter: operator?.user_id ? `user_id=eq.${operator.user_id}` : undefined,
        },
        () => qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_transactions" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_wallets" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc, operator?.user_id]);

  const updateStatus = async (status: "available" | "busy" | "offline") => {
    if (!operator) return;
    const { error } = await supabase
      .from("operators")
      .update({ availability_status: status })
      .eq("id", operator.id);
    if (error) {
      toast.error("עדכון סטטוס נכשל");
      return;
    }
    toast.success("סטטוס עודכן");
    await refresh();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-bold">דשבורד</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ברוך הבא{operator ? `, ${operator.full_name}` : ""}
        </p>
      </header>

      {operator && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">סטטוס זמינות</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => updateStatus(s.value)}
                  className={`px-4 py-2 rounded-md text-sm font-medium border transition-all ${
                    operator.availability_status === s.value
                      ? s.cls + " border-transparent"
                      : "border-input hover:bg-accent"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {operator && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <div className="text-sm font-medium">נקודות עובד</div>
                <p className="text-xs text-muted-foreground mt-1">יתרה נוכחית ומה שנכנס החודש בפועל.</p>
              </div>
              <div className="grid grid-cols-3 gap-3 md:min-w-[360px]">
                <QuickStat label="נקודות זמינות" value={stats?.walletBalance} loading={isLoading} />
                <QuickStat label="נכנסו החודש" value={stats?.monthlyPoints} loading={isLoading} />
                <QuickStat label="מול חודש קודם" value={stats?.monthlyPointChange} signed loading={isLoading} />
              </div>
              <Button variant="outline" asChild>
                <Link to="/operator/analytics">
                  <BarChart3 className="h-4 w-4 ml-2" />
                  צפה באנליטיקה מלאה
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="נקודות זמינות" value={stats?.walletBalance} icon={Award} loading={isLoading} />
        <StatCard label="נכנסו החודש" value={stats?.monthlyPoints} icon={Sparkles} loading={isLoading} />
        <StatCard label="שיחות פעילות" value={stats?.active} icon={MessageCircle} loading={isLoading} />
        <StatCard label="ממתינות למענה" value={stats?.waiting} icon={Clock} loading={isLoading} highlight />
        <StatCard label="הודעות החודש" value={stats?.sentThisMonth} icon={Send} loading={isLoading} />
        <StatCard label="זמן תגובה ממוצע" value={stats?.avgResponseSec} suffix="ש׳" icon={Timer} loading={isLoading} />
        <StatCard label="פעולות מזכות" value={stats?.scoredMessages} icon={Sparkles} loading={isLoading} />
        <StatCard label="הודעות שלא נקראו" value={stats?.unread} icon={Bell} loading={isLoading} />
        <StatCard label="נסגרו היום" value={stats?.closedToday} icon={Users} loading={isLoading} />
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            שגיאה בטעינת דשבורד
            <div className="mt-2 text-xs text-muted-foreground">
              {(error as { message?: string }).message}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">השיחות האחרונות שלי</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-32" />}
          {!isLoading && stats && stats.recent.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">
              {isAdmin && !operator ? "אין שיחות במערכת" : "אין לך שיחות כרגע"}
            </p>
          )}
          {!isLoading && stats && stats.recent.length > 0 && (
            <div className="space-y-2">
              {stats.recent.map((c) => (
                <Link
                  key={c.id}
                  to="/operator/chat/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors"
                >
                  <div className="h-10 w-10 rounded-full bg-muted overflow-hidden shrink-0">
                    {c.characters?.avatar_url ? (
                      <img src={c.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-sm font-semibold">
                        {c.characters?.name?.[0] ?? "?"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{c.characters?.name ?? "-"}</span>
                      <ConversationStatusBadge status={c.status} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{c.last_message_preview ?? "-"}</p>
                  </div>
                  {c.operator_unread_count > 0 && (
                    <span className="bg-primary text-primary-foreground text-xs rounded-full h-5 min-w-5 px-1.5 flex items-center justify-center">
                      {c.operator_unread_count}
                    </span>
                  )}
                </Link>
              ))}
              <div className="pt-2">
                <Button variant="ghost" className="w-full" asChild>
                  <Link to="/operator/conversations">לכל השיחות</Link>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">שיחות בסיכון SLA</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24" />}
          {!isLoading && stats && stats.slaRisks.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">אין כרגע שיחות שחורגות מה־SLA</p>
          )}
          {!isLoading && stats && stats.slaRisks.length > 0 && (
            <div className="space-y-2">
              {stats.slaRisks.map((conversation) => (
                <Link
                  key={conversation.conversation_id}
                  to="/operator/chat/$conversationId"
                  params={{ conversationId: conversation.conversation_id }}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg border border-warning/40 hover:bg-accent transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{conversation.character_name ?? "-"}</div>
                    <p className="text-xs text-muted-foreground truncate">{conversation.last_message_preview ?? "-"}</p>
                  </div>
                  <span className="text-xs font-medium text-warning whitespace-nowrap">
                    {conversation.minutes_waiting} דק׳
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">שיחות שממתינות למענה</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24" />}
          {!isLoading && stats && stats.waitingConversations.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">אין כרגע שיחות שממתינות למענה</p>
          )}
          {!isLoading && stats && stats.waitingConversations.length > 0 && (
            <div className="space-y-2">
              {stats.waitingConversations.map((c) => (
                <Link
                  key={c.id}
                  to="/operator/chat/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.characters?.name ?? "-"}</div>
                    <p className="text-xs text-muted-foreground truncate">{c.last_message_preview ?? "-"}</p>
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {c.last_message_at ? formatShortDate(c.last_message_at) : "-"}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {operator && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">דמויות פעילות שלי</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-20" />}
            {!isLoading && stats && stats.assignedCharacters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                אין דמויות משויכות אליך כעת
              </p>
            )}
            {!isLoading && stats && stats.assignedCharacters.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {stats.assignedCharacters.map((a) => (
                  <div key={a.character_id} className="flex items-center gap-2 p-2 rounded-lg border border-border">
                    <div className="h-9 w-9 rounded-full bg-muted overflow-hidden shrink-0">
                      {a.characters?.avatar_url ? (
                        <img src={a.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-sm">
                          {a.characters?.name?.[0] ?? "?"}
                        </div>
                      )}
                    </div>
                    <div className="text-sm truncate">{a.characters?.name ?? "-"}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
  icon: Icon,
  loading,
  highlight,
}: {
  label: string;
  value: number | undefined;
  suffix?: string;
  icon: typeof MessageCircle;
  loading?: boolean;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight && value && value > 0 ? "border-warning" : undefined}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {loading ? (
          <Skeleton className="h-8 w-12" />
        ) : (
          <div className="text-2xl font-bold">
            {value ?? 0}
            {suffix && <span className="text-sm font-medium text-muted-foreground mr-1">{suffix}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuickStat({
  label,
  value,
  signed,
  loading,
}: {
  label: string;
  value: number | undefined;
  signed?: boolean;
  loading?: boolean;
}) {
  const displayValue = signed && (value ?? 0) > 0 ? `+${value}` : `${value ?? 0}`;

  return (
    <div className="rounded-lg border border-border p-3 min-w-0">
      <div className="text-xs text-muted-foreground truncate">{label}</div>
      {loading ? <Skeleton className="h-7 w-12 mt-1" /> : <div className="text-xl font-bold mt-1">{displayValue}</div>}
    </div>
  );
}

function sumPointTransactions(rows: unknown) {
  return ((rows ?? []) as Array<{ amount: number | null }>).reduce((sum, row) => sum + Math.max(Number(row.amount ?? 0), 0), 0);
}

function calculateAverageResponseSeconds(messages: DashboardMessage[], operatorId?: string) {
  if (!operatorId) return 0;
  const byConversation = new Map<string, DashboardMessage[]>();
  messages.forEach((message) => {
    const list = byConversation.get(message.conversation_id) ?? [];
    list.push(message);
    byConversation.set(message.conversation_id, list);
  });

  let totalMs = 0;
  let pairs = 0;
  byConversation.forEach((list) => {
    let pendingClientAt: number | null = null;
    list.forEach((message) => {
      if (message.sender_type === "client") {
        pendingClientAt = +new Date(message.created_at);
      } else if (
        message.sender_type === "operator" &&
        message.operator_id === operatorId &&
        pendingClientAt !== null
      ) {
        totalMs += +new Date(message.created_at) - pendingClientAt;
        pairs += 1;
        pendingClientAt = null;
      }
    });
  });

  return pairs > 0 ? Math.round(totalMs / pairs / 1000) : 0;
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
