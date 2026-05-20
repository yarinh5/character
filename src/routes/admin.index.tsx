import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAnalytics } from "@/lib/analytics.functions";
import {
  Users,
  UserCog,
  Sparkles,
  MessageCircle,
  Clock,
  Flag,
  AlertTriangle,
  Activity,
  Timer,
} from "lucide-react";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

function AdminDashboard() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const iso = startOfDay.toISOString();

      const [
        clients,
        clientsToday,
        operators,
        operatorsAvailable,
        characters,
        convsAll,
        msgsToday,
        reportsOpen,
        recent,
        topChars,
        operatorLoad,
        unassigned,
      ] = await Promise.all([
        supabase.from("user_roles").select("user_id", { count: "exact", head: true }).eq("role", "client"),
        supabase.from("profiles").select("user_id", { count: "exact", head: true }).gte("created_at", iso),
        supabase.from("operators").select("id", { count: "exact", head: true }),
        supabase.from("operators").select("id", { count: "exact", head: true }).eq("availability_status", "available").eq("is_active", true),
        supabase.from("characters").select("id", { count: "exact", head: true }).eq("is_active", true),
        supabase.from("conversations").select("id, status, assigned_operator_id"),
        supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", iso),
        supabase.from("reports").select("id", { count: "exact", head: true }).eq("status", "open"),
        supabase
          .from("conversations")
          .select("id, status, last_message_at, last_message_preview, characters(name, avatar_url), operators(full_name)")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(8),
        supabase.from("messages").select("conversation_id, conversations(character_id, characters(name))").limit(500).order("created_at", { ascending: false }),
        supabase.from("operators").select("id, full_name, availability_status, is_active"),
        supabase.from("conversations").select("id", { count: "exact", head: true }).is("assigned_operator_id", null),
      ]);

      const allConvs = convsAll.data ?? [];
      const activeConvs = allConvs.filter((c) => c.status !== "closed").length;
      const waitingConvs = allConvs.filter((c) => c.status === "waiting").length;

      // top characters by messages
      const charMap = new Map<string, { name: string; count: number }>();
      (topChars.data ?? []).forEach((m) => {
        const ch = (m as any).conversations?.characters;
        const id = (m as any).conversations?.character_id;
        if (!id || !ch) return;
        const cur = charMap.get(id) ?? { name: ch.name, count: 0 };
        cur.count += 1;
        charMap.set(id, cur);
      });
      const topCharacters = Array.from(charMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);

      // operator load
      const opLoad = (operatorLoad.data ?? []).map((op) => {
        const opConvs = allConvs.filter((c) => c.assigned_operator_id === op.id && c.status !== "closed");
        return {
          id: op.id,
          name: op.full_name,
          status: op.availability_status,
          is_active: op.is_active,
          active: opConvs.length,
        };
      }).sort((a, b) => b.active - a.active).slice(0, 8);

      return {
        clients: clients.count ?? 0,
        clientsToday: clientsToday.count ?? 0,
        operators: operators.count ?? 0,
        operatorsAvailable: operatorsAvailable.count ?? 0,
        characters: characters.count ?? 0,
        activeConvs,
        waitingConvs,
        msgsToday: msgsToday.count ?? 0,
        reportsOpen: reportsOpen.count ?? 0,
        unassigned: unassigned.count ?? 0,
        recent: recent.data ?? [],
        topCharacters,
        opLoad,
      };
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("admin-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-stats"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-stats"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);


  const analyticsFn = useServerFn(adminAnalytics);
  const { data: analytics } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: () => analyticsFn(),
  });

  const maxMsgs = Math.max(1, ...(analytics?.days.map((d) => d.messages) ?? [0]));

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="דשבורד" description="סקירת מערכת בזמן אמת" />


      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="סך לקוחות" value={data?.clients} icon={Users} loading={isLoading} />
        <Stat label="חדשים היום" value={data?.clientsToday} icon={Activity} loading={isLoading} />
        <Stat label="עובדים" value={data?.operators} icon={UserCog} loading={isLoading} />
        <Stat label="עובדים זמינים" value={data?.operatorsAvailable} icon={UserCog} loading={isLoading} />
        <Stat label="דמויות פעילות" value={data?.characters} icon={Sparkles} loading={isLoading} />
        <Stat label="שיחות פעילות" value={data?.activeConvs} icon={MessageCircle} loading={isLoading} />
        <Stat label="ממתינות" value={data?.waitingConvs} icon={Clock} loading={isLoading} highlight />
        <Stat label="הודעות היום" value={data?.msgsToday} icon={MessageCircle} loading={isLoading} />
        <Stat label="דיווחים פתוחים" value={data?.reportsOpen} icon={Flag} loading={isLoading} highlight />
        <Stat label="ללא עובד" value={data?.unassigned} icon={AlertTriangle} loading={isLoading} highlight />
      </div>

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
            <CardTitle className="text-base">דמויות הכי פעילות</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-32" />}
            {!isLoading && data && data.topCharacters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">אין נתונים</p>
            )}
            {!isLoading && data && data.topCharacters.length > 0 && (
              <div className="space-y-2">
                {data.topCharacters.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 p-2 rounded-lg border">
                    <span className="font-medium truncate">{c.name}</span>
                    <span className="text-sm text-muted-foreground">{c.count} הודעות אחרונות</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">עומס עובדים</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-32" />}
            {!isLoading && data && data.opLoad.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">אין עובדים במערכת</p>
            )}
            {!isLoading && data && data.opLoad.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {data.opLoad.map((op) => (
                  <div key={op.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{op.name}</div>
                      <div className="flex gap-2 mt-1">
                        <StatusBadge status={op.status} />
                        {!op.is_active && <StatusBadge status="inactive" />}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold">{op.active}</div>
                      <div className="text-[11px] text-muted-foreground">שיחות פעילות</div>
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
            {!analytics && <Skeleton className="h-32" />}
            {analytics && (
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">עובדים מובילים (14 ימים)</CardTitle>
          </CardHeader>
          <CardContent>
            {!analytics && <Skeleton className="h-24" />}
            {analytics && analytics.topOperators.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">אין נתונים</p>
            )}
            {analytics && analytics.topOperators.length > 0 && (
              <div className="space-y-2">
                {analytics.topOperators.map((op, i) => (
                  <div key={i} className="flex justify-between items-center p-2 rounded-lg border">
                    <span className="font-medium truncate">{op.name}</span>
                    <span className="text-sm text-muted-foreground">{op.count} הודעות</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">דמויות מובילות (כל הזמנים)</CardTitle>
          </CardHeader>
          <CardContent>
            {!analytics && <Skeleton className="h-24" />}
            {analytics && analytics.topCharacters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">אין נתונים</p>
            )}
            {analytics && analytics.topCharacters.length > 0 && (
              <div className="space-y-2">
                {analytics.topCharacters.map((c, i) => (
                  <div key={i} className="flex justify-between items-center p-2 rounded-lg border">
                    <span className="font-medium truncate">{c.name}</span>
                    <span className="text-sm text-muted-foreground">{c.count} שיחות</span>
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
  highlight,
}: {
  label: string;
  value: number | undefined;
  icon: typeof Users;
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
        {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{value ?? 0}</div>}
      </CardContent>
    </Card>
  );
}
