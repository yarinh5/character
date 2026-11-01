import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AdminOperationsSnapshot } from "@/components/admin/AdminOperationsSnapshot";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAnalytics } from "@/lib/analytics.functions";
import { useAuth } from "@/lib/auth";
import {
  Activity,
  AlertTriangle,
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
  const { loading, role, user, session } = useAuth();
  const adminId =
    !loading && role === "admin" && user && session?.user.id === user.id ? user.id : null;

  if (!adminId) {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        נדרש חיבור מנהל מאומת להצגת הדשבורד.
      </p>
    );
  }

  return <AdminDashboardWorkspace key={adminId} adminId={adminId} />;
}

type RecentConversation = {
  id: string;
  status: string;
  last_message_preview: string | null;
  characters: { name: string; avatar_url: string | null } | null;
  operators: { full_name: string | null } | null;
};

type DashboardAnalytics = {
  days: Array<{ date: string; conversations: number; users: number; messages: number }>;
  avgResponseSec: number;
  topOperators: Array<{ name: string; count: number }>;
  topCharacters: Array<{ name: string; count: number }>;
  totalCreditsSpent: number;
  manualCreditsAdded: number;
  clientMessages: number;
  operatorMessages: number;
  topOperatorsByAvailablePoints: Array<{
    id: string;
    name: string;
    availablePoints: number;
    monthlyPayouts: number;
    messages: number;
    status: string;
    isActive: boolean;
  }>;
  lowBalanceUsers: Array<{ userId: string; name: string; email: string | null; balance: number }>;
};

function AdminDashboardWorkspace({ adminId }: { adminId: string }) {
  const qc = useQueryClient();
  const analyticsFn = useServerFn(adminAnalytics);

  const statsQuery = useQuery({
    queryKey: ["admin-stats", adminId],
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const iso = startOfDay.toISOString();

      const [clients, clientsToday, characters, recent] = await Promise.all([
        supabase
          .from("user_roles")
          .select("user_id", { count: "exact", head: true })
          .eq("role", "client"),
        supabase
          .from("profiles")
          .select("user_id", { count: "exact", head: true })
          .gte("created_at", iso),
        supabase
          .from("characters")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true),
        supabase
          .from("conversations")
          .select(
            "id, status, last_message_at, last_message_preview, characters(name, avatar_url), operators(full_name)",
          )
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(8),
      ]);

      if (clients.error || clientsToday.error || characters.error || recent.error) {
        throw new Error("admin_dashboard_stats_unavailable");
      }
      if (
        ![clients.count, clientsToday.count, characters.count].every(
          (count) => typeof count === "number" && Number.isFinite(count),
        )
      ) {
        throw new Error("admin_dashboard_stats_malformed");
      }
      const recentRows = recent.data;
      if (!Array.isArray(recentRows) || !recentRows.every(isRecentConversation)) {
        throw new Error("admin_dashboard_recent_malformed");
      }

      return {
        clients: clients.count as number,
        clientsToday: clientsToday.count as number,
        characters: characters.count as number,
        recent: recentRows,
      };
    },
    retry: false,
  });

  const analyticsQuery = useQuery({
    queryKey: ["admin-analytics", adminId],
    queryFn: async () => {
      const value = await analyticsFn();
      if (!isDashboardAnalytics(value)) throw new Error("admin_dashboard_analytics_malformed");
      return value;
    },
    retry: false,
  });

  const {
    data,
    isLoading,
    isError: statsError,
    isFetching: statsFetching,
    refetch: refetchStats,
  } = statsQuery;
  const {
    data: analytics,
    isLoading: analyticsLoading,
    isError: analyticsError,
    isFetching: analyticsFetching,
    refetch: refetchAnalytics,
  } = analyticsQuery;

  useEffect(() => {
    const ch = supabase
      .channel(`admin-dashboard-${adminId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        qc.invalidateQueries({ queryKey: ["admin-stats", adminId] });
        qc.invalidateQueries({ queryKey: ["admin-analytics", adminId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        qc.invalidateQueries({ queryKey: ["admin-analytics", adminId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_transactions" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-analytics", adminId] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_wallets" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-analytics", adminId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [adminId, qc]);

  const maxMsgs = Math.max(1, ...(analytics?.days.map((d) => d.messages) ?? [0]));

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="דשבורד" description="סקירת מערכת בזמן אמת" />

      {statsError && (
        <ReadAlert
          name={data ? "שגיאת רענון נתוני הדשבורד" : "שגיאת טעינת נתוני הדשבורד"}
          text={
            data
              ? "רענון נתוני הדשבורד נכשל. מוצגים הנתונים השמורים האחרונים."
              : "טעינת נתוני הדשבורד נכשלה."
          }
          buttonLabel={data ? "נסה לרענן שוב" : "נסה לטעון שוב"}
          pending={statsFetching}
          onRetry={() => void refetchStats()}
        />
      )}
      {analyticsError && (
        <ReadAlert
          name={analytics ? "שגיאת רענון מדדי האנליטיקה" : "שגיאת טעינת מדדי האנליטיקה"}
          text={
            analytics
              ? "רענון מדדי האנליטיקה נכשל. מוצגים הנתונים השמורים האחרונים."
              : "טעינת מדדי האנליטיקה נכשלה."
          }
          buttonLabel={analytics ? "נסה לרענן אנליטיקה שוב" : "נסה לטעון אנליטיקה שוב"}
          pending={analyticsFetching}
          onRetry={() => void refetchAnalytics()}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="סך לקוחות" value={data?.clients} icon={Users} loading={isLoading} />
        <Stat
          label="פרופילים שנוצרו היום"
          value={data?.clientsToday}
          icon={Activity}
          loading={isLoading}
        />
        <Stat label="דמויות פעילות" value={data?.characters} icon={Sparkles} loading={isLoading} />
        <Stat
          label="קרדיטים שנצרכו"
          value={analytics?.totalCreditsSpent}
          icon={TrendingDown}
          loading={analyticsLoading}
        />
        <Stat
          label="נוספו ידנית"
          value={analytics?.manualCreditsAdded}
          icon={Coins}
          loading={analyticsLoading}
        />
        <Stat
          label="הודעות לקוחות"
          value={analytics?.clientMessages}
          icon={MessageCircle}
          loading={analyticsLoading}
        />
        <Stat
          label="הודעות עובדים"
          value={analytics?.operatorMessages}
          icon={TrendingUp}
          loading={analyticsLoading}
        />
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
                {data.recent.map((c) => (
                  <Link
                    key={c.id}
                    to="/admin/conversations/$conversationId"
                    params={{ conversationId: c.id }}
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="h-9 w-9 rounded-full bg-muted overflow-hidden shrink-0">
                      {c.characters?.avatar_url ? (
                        <img
                          src={c.characters.avatar_url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
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
            <CardTitle className="text-base">יתרות קרדיט היסטוריות לעובדים</CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading && <Skeleton className="h-32" />}
            {!analyticsLoading &&
              analytics &&
              analytics.topOperatorsByAvailablePoints.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  אין עדיין עובדים להצגה
                </p>
              )}
            {!analyticsLoading &&
              analytics &&
              analytics.topOperatorsByAvailablePoints.length > 0 && (
                <div className="space-y-2">
                  {analytics.topOperatorsByAvailablePoints.map((op, index) => (
                    <div
                      key={op.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg border"
                    >
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
                  <div
                    key={`${c.name}-${i}`}
                    className="flex justify-between items-center p-2 rounded-lg border"
                  >
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
              <p className="text-sm text-muted-foreground text-center py-4">
                אין לקוחות עם יתרה נמוכה
              </p>
            )}
            {!analyticsLoading && analytics && analytics.lowBalanceUsers.length > 0 && (
              <div className="space-y-2">
                {analytics.lowBalanceUsers.map((user) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between gap-3 p-2 rounded-lg border"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{user.name}</div>
                      {user.email && (
                        <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                      )}
                    </div>
                    <div
                      className={user.balance === 0 ? "text-destructive font-bold" : "font-bold"}
                    >
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
                  <div
                    key={d.date}
                    className="flex-1 flex flex-col items-center gap-1"
                    title={`${d.date}: ${d.messages} הודעות`}
                  >
                    <div
                      className="w-full bg-primary/70 hover:bg-primary rounded-t transition-colors"
                      style={{
                        height: `${(d.messages / maxMsgs) * 100}%`,
                        minHeight: d.messages > 0 ? "4px" : "0px",
                      }}
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
        {loading ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <div className="text-2xl font-bold">{value ?? "—"}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ReadAlert({
  name,
  text,
  buttonLabel,
  pending,
  onRetry,
}: {
  name: string;
  text: string;
  buttonLabel: string;
  pending: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-label={name}
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-3 text-sm"
    >
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
        {text}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={pending}>
        {buttonLabel}
      </Button>
    </div>
  );
}

function isDashboardAnalytics(value: unknown): value is DashboardAnalytics {
  if (!isRecord(value)) return false;
  const candidate = value;
  const scalars = [
    "avgResponseSec",
    "totalCreditsSpent",
    "manualCreditsAdded",
    "clientMessages",
    "operatorMessages",
  ];
  if (
    !scalars.every(
      (field) => typeof candidate[field] === "number" && Number.isFinite(candidate[field]),
    )
  )
    return false;
  const days = candidate.days;
  const topOperators = candidate.topOperators;
  const topCharacters = candidate.topCharacters;
  const operatorCreditSummaries = candidate.topOperatorsByAvailablePoints;
  const lowBalanceUsers = candidate.lowBalanceUsers;
  if (
    !Array.isArray(days) ||
    !Array.isArray(topOperators) ||
    !Array.isArray(topCharacters) ||
    !Array.isArray(operatorCreditSummaries) ||
    !Array.isArray(lowBalanceUsers)
  ) {
    return false;
  }
  return (
    days.every(isDashboardDay) &&
    topCharacters.every(isTopCharacter) &&
    operatorCreditSummaries.every(isOperatorCreditSummary) &&
    lowBalanceUsers.every(isLowBalanceUser)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecentConversation(value: unknown): value is RecentConversation {
  if (!isRecord(value)) return false;

  const characters = value.characters;
  const operators = value.operators;
  const validCharacter =
    characters === null ||
    (isRecord(characters) &&
      typeof characters.name === "string" &&
      isNullableString(characters.avatar_url));
  const validOperator =
    operators === null || (isRecord(operators) && isNullableString(operators.full_name));

  return (
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    isNullableString(value.last_message_preview) &&
    validCharacter &&
    validOperator
  );
}

function isDashboardDay(value: unknown): value is DashboardAnalytics["days"][number] {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    isFiniteNumber(value.conversations) &&
    isFiniteNumber(value.users) &&
    isFiniteNumber(value.messages)
  );
}

function isTopCharacter(value: unknown): value is DashboardAnalytics["topCharacters"][number] {
  return isRecord(value) && typeof value.name === "string" && isFiniteNumber(value.count);
}

function isOperatorCreditSummary(
  value: unknown,
): value is DashboardAnalytics["topOperatorsByAvailablePoints"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isFiniteNumber(value.availablePoints) &&
    isFiniteNumber(value.monthlyPayouts) &&
    isFiniteNumber(value.messages) &&
    typeof value.status === "string" &&
    typeof value.isActive === "boolean"
  );
}

function isLowBalanceUser(value: unknown): value is DashboardAnalytics["lowBalanceUsers"][number] {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.name === "string" &&
    isNullableString(value.email) &&
    isFiniteNumber(value.balance)
  );
}
