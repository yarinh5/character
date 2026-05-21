import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Award, BarChart3, Clock, Sparkles, Users } from "lucide-react";
import { useOperator } from "@/components/operator/OperatorLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchOperatorPerformance,
  formatChange,
  formatResponseTime,
  type OperatorPerformanceSummary,
} from "@/lib/operatorPerformance";

export const Route = createFileRoute("/operator/analytics")({
  component: OperatorAnalyticsPage,
});

function OperatorAnalyticsPage() {
  const { operator } = useOperator();

  const { data, isLoading } = useQuery({
    queryKey: ["operator-performance", operator?.id],
    enabled: Boolean(operator?.id),
    queryFn: () => fetchOperatorPerformance(operator!.id),
  });

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-bold">ביצועים</h1>
        <p className="text-sm text-muted-foreground mt-1">סיכום פעילות ונקודות עובד על בסיס החודש והיסטוריה חודשית.</p>
      </header>

      {isLoading && <AnalyticsSkeleton />}
      {!isLoading && data && <AnalyticsContent data={data} />}
      {!isLoading && !data && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            לא נמצאו נתוני ביצועים עבור החשבון הזה.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function AnalyticsContent({ data }: { data: OperatorPerformanceSummary }) {
  const hasHistory = data.monthlyHistory.length > 0;

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="נקודות החודש" value={data.currentPoints} icon={Award} />
        <MetricCard label="הודעות שנשלחו" value={data.currentScoredMessages} icon={Sparkles} />
        <MetricCard label="דמויות משויכות" value={data.assignedCharacters.length} icon={Users} />
        <MetricCard label="זמן תגובה ממוצע" value={formatResponseTime(data.avgResponseSec)} icon={Clock} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">שינוי מול חודש קודם</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground">נקודות</div>
              <div className="mt-1 text-2xl font-bold">{formatChange(data.monthlyPointChange)}</div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground">הודעות שנשלחו</div>
              <div className="mt-1 text-2xl font-bold">{formatChange(data.monthlyMessageChange)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">נקודות לפי חודשים</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasHistory && <EmptyPerformanceState />}
          {hasHistory && (
            <ChartContainer
              config={{
                points: { label: "נקודות", color: "var(--primary)" },
              }}
              className="h-64 w-full"
            >
              <BarChart data={data.chartData} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="points" fill="var(--color-points)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-[1.3fr_0.7fr] gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">היסטוריה חודשית</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasHistory && <EmptyPerformanceState compact />}
            {hasHistory && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">חודש</TableHead>
                      <TableHead className="text-right">סה״כ נקודות</TableHead>
                      <TableHead className="text-right">הודעות שנשלחו</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.monthlyHistory.map((row) => (
                      <TableRow key={row.month}>
                        <TableCell className="font-medium">{row.monthLabel}</TableCell>
                        <TableCell>{row.points}</TableCell>
                        <TableCell>{row.scoredMessages}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">דמויות משויכות</CardTitle>
          </CardHeader>
          <CardContent>
            {data.assignedCharacters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">אין דמויות משויכות כרגע.</p>
            )}
            {data.assignedCharacters.length > 0 && (
              <div className="space-y-2">
                {data.assignedCharacters.map((assignment) => (
                  <div key={assignment.character_id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <div className="h-9 w-9 rounded-full bg-muted overflow-hidden shrink-0">
                      {assignment.characters?.avatar_url ? (
                        <img src={assignment.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-sm font-semibold">
                          {assignment.characters?.name?.[0] ?? "?"}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{assignment.characters?.name ?? "דמות"}</div>
                      <div className="text-xs text-muted-foreground">פעילות</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  icon: typeof Award;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
        <div className="text-2xl font-bold leading-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

function EmptyPerformanceState({ compact }: { compact?: boolean }) {
  return (
    <div className={`text-center ${compact ? "py-6" : "py-10"}`}>
      <BarChart3 className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
      <div className="font-medium">אין עדיין נתוני ביצועים</div>
      <p className="text-sm text-muted-foreground mt-1">
        אחרי שהודעות עובד יצברו ניקוד, הנתונים החודשיים יוצגו כאן.
      </p>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
      <Skeleton className="h-48" />
    </div>
  );
}
