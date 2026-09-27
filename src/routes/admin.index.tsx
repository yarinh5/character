import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AdminOperationsSnapshot } from "@/components/admin/AdminOperationsSnapshot";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAnalytics } from "@/lib/analytics.functions";
import {
  Activity,
  Coins,
  MessageCircle,
  Sparkles,
  Timer,
  TrendingDown,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

function AdminDashboard() {
  const qc = useQueryClient();
  const analyticsFn = useServerFn(adminAnalytics);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const iso = startOfDay.toISOString();

      const [
        clients,
        clientsToday,
        characters,
        recent,
      ] = await Promise.all([
        supabase.from("user_roles").select("user_id", { count: "exact", head: true }).eq("role", "client"),
        supabase.from("profiles").select("user_id", { count: "exact", head: true }).gte("created_at", iso),
        supabase.from("characters").select("id", { count: "exact", head: true }).eq("is_active", true),
        supabase
          .from("conversations")
          .select("id, status, last_message_at, last_message_preview, characters(name, avatar_url), operators(full_name)")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(8),
      ]);

      return {
        clients: clients.count ?? 0,
        clientsToday: clientsToday.count ?? 0,
        characters: characters.count ?? 0,
        recent: recent.data ?? [],
      };
    },
  });

  const { data: analytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: () => analyticsFn(),
  });

  useEffect(() => {
    const ch = supabase
      .channel("admin-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        qc.invalidateQueries({ queryKey: ["admin-stats"] });
        qc.invalidateQueries({ queryKey: ["admin-analytics"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        qc.invalidateQueries({ queryKey: ["admin-analytics"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_transactions" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-analytics"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_wallets" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-analytics"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const maxMsgs = Math.max(1, ...(analytics?.days.map((d) => d.messages) ?? [0]));

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="דשבורד" description="סקירת מערכת בזמן אמת" />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="סך לקוחות" value={data?.clients} icon={Users} loading={isLoading} />
        <Stat label="חדשים היום" value={data?.clientsToday} icon={Activity} loading={isLoading} />
        <Stat label="דמויות פעילות" value={data?.characters} icon={Sparkles} loading={isLoading} />
        <Stat label="קרדיטים שנוצלו" value={analytics?.totalCreditsSpent} icon={TrendingDown} loading={analyticsLoading} />
        <Stat label="נוספו ידנית" value={analytics?.manualCreditsAdded} icon={Coins} loading={analyticsLoading} />
        <Stat label="הודעות לקוחות" value={analytics?.clientMessages} icon={MessageCircle} loading={analyticsLoading} />
        <Stat label="הודעות עובדים" value={analytics?.operatorMessages} icon={TrendingUp} loading={analyticsLoading} />
      </div>

      <AdminOperationsSnapshot />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">שיחות אחרונות</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-32" />}
            {!isLoading && data && data.recent.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">אין שיחות עדיין</p>
            )}
            {!isLoading && data && data.recent.length > 0 && (
              <div className="space-y-1.5">
                {data.recent.map((c: any) => (
                  <Link
                    key={c.id}
                    to="/admin/conversations/$conversationId"
                    params={{ conversationId: c.id }}
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="h-9 w-9 rounded-full bg-muted overflow-hidden shrink-0">
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
                        <span className="font-medium truncate">{c.characters?.name ?? "—"}</span>
                        <StatusBadge status={c.status} />
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {c.operators?.full_name ?? "ללא עובד"} · {c.last_message_preview ?? "—"}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">קרדיטים זמינים לעובדים</CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading && <Skeleton className="h-32" />}
            {!analyticsLoading && analytics && analytics.topOperatorsByAvailablePoints.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">אין עדיין עובדים להצגה</p>
            )}
            {!analyticsLoading && analytics && analytics.topOperatorsByAvailablePoints.length > 0 && (
              <div className="space-y-2">
                {analytics.topOperatorsByAvailablePoints.map((op, index) => (
                  <div key={op.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border">
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {index + 1}. {op.name}
                      </div>
                      <div className="flex gap-2 mt-1">
                        <StatusBadge status={op.status} />
                        {!op.isActive && <StatusBadge status="inactive" />}
                      </div>
                    </div>
                    <div className="text-left">
                      <div className="text-xl font-bold">{op.availablePoints}</div>
                      <div className="text-[11px] text-muted-foreground">
                        קרדיטים החודש: {op.monthlyPayouts} · {op.messages} פעולות מזכות
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">דמויות הכי פעילות</CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading && <Skeleton className="h-24" />}
            {!analyticsLoading && analytics && analytics.topCharacters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">אין נתונים</p>
            )}
            {!analyticsLoading && analytics && analytics.topCharacters.length > 0 && (
              <div className="space-y-2">
                {analytics.topCharacters.map((c, i) => (
                  <div key={`${c.name}-${i}`} className="flex justify-between items-center p-2 rounded-lg border">
                    <span className="font-medium truncate">{c.name}</span>
                    <span className="text-sm text-muted-foreground">{c.count} שיחות</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">לקוחות עם יתרה נמוכה</CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading && <Skeleton className="h-24" />}
            {!analyticsLoading && analytics && analytics.lowBalanceUsers.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">אין לקוחות עם יתרה נמוכה</p>
            )}
            {!analyticsLoading && analytics && analytics.lowBalanceUsers.length > 0 && (
              <div className="space-y-2">
                {analytics.lowBalanceUsers.map((user) => (
                  <div key={user.userId} className="flex items-center justify-between gap-3 p-2 rounded-lg border">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{user.name}</div>
                      {user.email && <div className="text-xs text-muted-foreground truncate">{user.email}</div>}
                    </div>
                    <div className={user.balance === 0 ? "text-destructive font-bold" : "font-bold"}>
                      {user.balance}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">פעילות 14 ימים אחרונים</CardTitle>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Timer className="h-3.5 w-3.5" />
              זמן תגובה ממוצע: {analytics ? `${analytics.avgResponseSec}s` : "—"}
            </div>
          </CardHeader>
          <CardContent>
            {analyticsLoading && <Skeleton className="h-32" />}
            {!analyticsLoading && analytics && (
              <div className="flex items-end gap-1 h-32">
                {analytics.days.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: ${d.messages} הודעות`}>
                    <div
                      className="w-full bg-primary/70 hover:bg-primary rounded-t transition-colors"
                      style={{ height: `${(d.messages / maxMsgs) * 100}%`, minHeight: d.messages > 0 ? "4px" : "1px" }}
                    />
                    <span className="text-[9px] text-muted-foreground">{d.date.slice(8)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value: number | undefined;
  icon: LucideIcon;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{value ?? 0}</div>}
      </CardContent>
    </Card>
  );
}
