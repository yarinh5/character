import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  BarChart3,
  Coins,
  Eye,
  MessageCircle,
  PackageOpen,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAdvancedAnalytics } from "@/lib/analytics.functions";
import type { LucideIcon } from "lucide-react";

export const Route = createFileRoute("/admin/analytics")({
  component: AdminAnalyticsPage,
});

const FUNNEL_LABELS: Record<string, string> = {
  signup_completed: "הרשמה הושלמה",
  onboarding_completed: "אונבורדינג הושלם",
  character_viewed: "צפייה בדמות",
  conversation_started: "שיחה נפתחה",
  first_message_sent: "הודעה ראשונה",
  packages_viewed: "מסך חבילות",
};

function defaultStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 29);
  return date.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function AdminAnalyticsPage() {
  const analyticsFn = useServerFn(adminAdvancedAnalytics);
  const [draftStart, setDraftStart] = useState(defaultStartDate);
  const [draftEnd, setDraftEnd] = useState(todayDate);
  const [range, setRange] = useState({ startDate: defaultStartDate(), endDate: todayDate() });

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["admin-advanced-analytics", range],
    queryFn: () => analyticsFn({ data: range }),
  });

  const maxDaily = useMemo(() => {
    if (!data?.days.length) return 1;
    return Math.max(
      1,
      ...data.days.map((day) => day.clientMessages + day.operatorMessages + day.conversations + day.signups),
    );
  }, [data]);

  const maxFunnel = Math.max(1, ...(data?.funnel.map((step) => step.count) ?? [0]));

  const applyRange = () => setRange({ startDate: draftStart, endDate: draftEnd });

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader
        title="אנליטיקות"
        description="מדדים מתקדמים ל־V1 על בסיס האירועים והנתונים שכבר נאספים במערכת"
        actions={
          <div className="grid grid-cols-2 sm:flex items-end gap-2 w-full sm:w-auto">
            <label className="text-xs text-muted-foreground">
              התחלה
              <Input
                type="date"
                value={draftStart}
                onChange={(event) => setDraftStart(event.target.value)}
                className="mt-1"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              סיום
              <Input
                type="date"
                value={draftEnd}
                onChange={(event) => setDraftEnd(event.target.value)}
                className="mt-1"
              />
            </label>
            <Button onClick={applyRange} disabled={isFetching} className="col-span-2 sm:col-span-1">
              עדכן
            </Button>
          </div>
        }
      />

      {error && (
        <Card className="border-destructive mb-4">
          <CardContent className="p-4 text-sm text-destructive">
            טעינת האנליטיקות נכשלה. בדוק את טווח התאריכים ונסה שוב.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <KpiCard label="משתמשים חדשים" value={data?.kpis.newUsers} icon={UserPlus} loading={isLoading} />
        <KpiCard label="שיחות שנפתחו" value={data?.kpis.conversationsStarted} icon={MessageCircle} loading={isLoading} />
        <KpiCard label="הודעות לקוח" value={data?.kpis.clientMessages} icon={Users} loading={isLoading} />
        <KpiCard label="הודעות עובד" value={data?.kpis.operatorMessages} icon={TrendingUp} loading={isLoading} />
        <KpiCard label="צפיות בדמויות" value={data?.kpis.characterViews} icon={Eye} loading={isLoading} />
        <KpiCard label="כניסות לחבילות" value={data?.kpis.packagesViewed} icon={PackageOpen} loading={isLoading} />
        <KpiCard label="אין קרדיטים" value={data?.kpis.insufficientCredits} icon={TrendingDown} loading={isLoading} />
        <KpiCard label="Credits burn" value={data?.kpis.creditsBurn} icon={Coins} loading={isLoading} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              פעילות לפי ימים
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-56" />}
            {!isLoading && data && data.days.length === 0 && <EmptyState text="אין נתונים בטווח התאריכים שנבחר" />}
            {!isLoading && data && data.days.length > 0 && (
              <div className="h-56 flex items-end gap-1 overflow-x-auto pb-2">
                {data.days.map((day) => {
                  const total = day.clientMessages + day.operatorMessages + day.conversations + day.signups;
                  return (
                    <div key={day.date} className="min-w-8 flex-1 flex flex-col justify-end items-center gap-1">
                      <div className="w-full max-w-10 h-44 flex items-end">
                        <div
                          className="w-full rounded-t bg-primary/75 hover:bg-primary transition-colors"
                          style={{ height: `${Math.max(3, (total / maxDaily) * 100)}%` }}
                          title={`${day.date}: ${total} פעולות`}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground">{day.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Funnel בסיסי</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-56" />}
            {!isLoading && data && (
              <div className="space-y-3">
                {data.funnel.map((step) => (
                  <div key={step.eventName}>
                    <div className="flex items-center justify-between gap-3 text-sm mb-1">
                      <span className="font-medium">{FUNNEL_LABELS[step.eventName] ?? step.eventName}</span>
                      <span className="font-bold">{step.count}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(step.count === 0 ? 0 : 8, (step.count / maxFunnel) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              דמויות מובילות
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-48" />}
            {!isLoading && data && data.topCharacters.length === 0 && <EmptyState text="אין פעילות דמויות בטווח הזה" />}
            {!isLoading && data && data.topCharacters.length > 0 && (
              <div className="space-y-2">
                {data.topCharacters.map((character) => (
                  <div key={character.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{character.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {character.conversations} שיחות · {character.views} צפיות
                      </div>
                    </div>
                    <span className="text-lg font-bold">{character.conversations + character.views}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">עובדים מובילים</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-48" />}
            {!isLoading && data && data.topOperators.length === 0 && <EmptyState text="אין פעילות עובדים בטווח הזה" />}
            {!isLoading && data && data.topOperators.length > 0 && (
              <div className="space-y-2">
                {data.topOperators.map((operator) => (
                  <div key={operator.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{operator.name}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <StatusBadge status={operator.status} />
                        <span className="text-xs text-muted-foreground">{operator.messages} הודעות</span>
                      </div>
                    </div>
                    <div className="text-left">
                      <div className="text-lg font-bold">{operator.points}</div>
                      <div className="text-[11px] text-muted-foreground">נקודות</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">סיכום טווח</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-48" />}
            {!isLoading && data && (
              <div className="space-y-3 text-sm">
                <SummaryRow label="טווח בפועל" value={`${data.range.startDate} - ${data.range.endDate}`} />
                <SummaryRow label="סה״כ הודעות" value={data.kpis.clientMessages + data.kpis.operatorMessages} />
                <SummaryRow label="סה״כ אירועי funnel" value={data.funnel.reduce((sum, step) => sum + step.count, 0)} />
                <SummaryRow label="יחס עובד/לקוח" value={ratio(data.kpis.operatorMessages, data.kpis.clientMessages)} />
                <SummaryRow label="Credits burn" value={data.kpis.creditsBurn} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value: number | undefined;
  icon: LucideIcon;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-xs text-muted-foreground leading-tight">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
        {loading ? <Skeleton className="h-7 w-14" /> : <div className="text-2xl font-bold">{value ?? 0}</div>}
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground text-center py-10">{text}</p>;
}

function SummaryRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-bold text-left">{value}</span>
    </div>
  );
}

function ratio(part: number, total: number) {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
