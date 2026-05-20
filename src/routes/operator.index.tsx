import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOperator, ConversationStatusBadge } from "@/components/operator/OperatorLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { MessageCircle, Clock, Bell, Users } from "lucide-react";

export const Route = createFileRoute("/operator/")({
  component: OperatorDashboard,
});

const STATUS_OPTIONS = [
  { value: "available", label: "זמין", cls: "bg-success text-success-foreground" },
  { value: "busy", label: "עסוק", cls: "bg-warning text-warning-foreground" },
  { value: "offline", label: "לא מחובר", cls: "bg-muted text-muted-foreground" },
] as const;

function OperatorDashboard() {
  const { operator, isAdmin, refresh } = useOperator();
  const qc = useQueryClient();

  const { data: stats, isLoading } = useQuery({
    queryKey: ["operator-stats", operator?.id ?? "admin"],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let convQuery = supabase
        .from("conversations")
        .select("id, status, operator_unread_count, last_message_at, last_message_preview, characters(id, name, avatar_url), client_id, updated_at")
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (operator) convQuery = convQuery.eq("assigned_operator_id", operator.id);

      const [{ data: convs, error }, { data: assigned }] = await Promise.all([
        convQuery,
        operator
          ? supabase
              .from("character_operator_assignments")
              .select("character_id, characters(id, name, avatar_url, availability_status)")
              .eq("operator_id", operator.id)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);
      if (error) throw error;

      const list = convs ?? [];
      const active = list.filter((c) => c.status !== "closed").length;
      const waiting = list.filter((c) => c.status === "waiting").length;
      const unread = list.reduce((s, c) => s + (c.operator_unread_count ?? 0), 0);
      const closedToday = list.filter(
        (c) => c.status === "closed" && c.updated_at && new Date(c.updated_at) >= today,
      ).length;

      return {
        active,
        waiting,
        unread,
        closedToday,
        recent: list.slice(0, 5),
        assignedCharacters: (assigned ?? []) as Array<{
          character_id: string;
          characters: { id: string; name: string; avatar_url: string | null; availability_status: string } | null;
        }>,
      };
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("operator-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-stats"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="שיחות פעילות" value={stats?.active} icon={MessageCircle} loading={isLoading} />
        <StatCard label="ממתינות למענה" value={stats?.waiting} icon={Clock} loading={isLoading} highlight />
        <StatCard label="הודעות שלא נקראו" value={stats?.unread} icon={Bell} loading={isLoading} />
        <StatCard label="נסגרו היום" value={stats?.closedToday} icon={Users} loading={isLoading} />
      </div>

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
                      <span className="font-medium truncate">{c.characters?.name ?? "—"}</span>
                      <ConversationStatusBadge status={c.status} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{c.last_message_preview ?? "—"}</p>
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
                    <div className="text-sm truncate">{a.characters?.name ?? "—"}</div>
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
  icon: Icon,
  loading,
  highlight,
}: {
  label: string;
  value: number | undefined;
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
          <div className="text-2xl font-bold">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
