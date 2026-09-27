import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Flag,
  Image,
  MessageCircle,
  RefreshCw,
  Timer,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type OperationsSnapshot = Database["public"]["Functions"]["get_admin_operations_snapshot"]["Returns"][number];

const snapshotQueryKey = ["admin-operations-snapshot"] as const;

export function AdminOperationsSnapshot() {
  const {
    data: snapshot,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: snapshotQueryKey,
    queryFn: async (): Promise<OperationsSnapshot> => {
      const { data, error } = await supabase.rpc("get_admin_operations_snapshot");
      if (error || !data?.[0]) {
        throw new Error("admin_operations_snapshot_unavailable");
      }

      return data[0];
    },
    refetchInterval: 30_000,
    retry: 2,
  });

  return (
    <section className="mb-6" dir="rtl" aria-labelledby="admin-operations-title">
      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="admin-operations-title" className="text-lg font-semibold">
            מצב תפעולי
          </h2>
          {snapshot && (
            <p className="text-xs text-muted-foreground">
              עודכן {formatSnapshotTime(snapshot.generated_at)}
            </p>
          )}
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="רענון מצב תפעולי"
                onClick={() => void refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={isFetching ? "animate-spin" : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>רענון מצב תפעולי</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {isLoading && !snapshot && <SnapshotSkeleton />}

      {isError && !snapshot && (
        <Card className="min-h-48">
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">טעינת המצב התפעולי נכשלה.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              נסה שוב
            </Button>
          </CardContent>
        </Card>
      )}

      {snapshot && (
        <>
          {isError && (
            <p role="status" className="mb-3 text-xs text-muted-foreground">
              העדכון האחרון נכשל. מוצגים הנתונים האחרונים שהתקבלו.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <OperationsGroup
              title="NEW ו-SLA"
              icon={Timer}
              to="/admin/operators"
              linkLabel="למסך עובדים"
            >
              <Metric label="סה״כ NEW" value={snapshot.new_total} />
              <Metric label="רגיל" value={snapshot.new_normal_count} icon={CheckCircle2} tone="normal" />
              <Metric label="אזהרה" value={snapshot.new_warning_count} icon={AlertTriangle} tone="warning" />
              <Metric label="קריטי" value={snapshot.new_critical_count} icon={AlertTriangle} tone="critical" />
              <Metric label="המתנה ותיקה" value={formatWait(snapshot.new_oldest_wait_seconds)} />
              <Metric label="חזרו ל-NEW" value={snapshot.new_returned_count} />
            </OperationsGroup>

            <OperationsGroup title="כוח עבודה" icon={UsersRound} to="/admin/operators" linkLabel="למסך עובדים">
              <Metric label="עובדים פעילים" value={snapshot.active_operator_count} />
              <Metric label="מחוברים" value={snapshot.online_operator_count} tone="normal" />
              <Metric label="לא מחוברים" value={snapshot.offline_operator_count} />
              <Metric label="מחזורי טיפול פעילים" value={snapshot.active_handling_cycle_count} />
            </OperationsGroup>

            <OperationsGroup title="ONLINE" subtitle="24 השעות האחרונות" icon={MessageCircle} to="/admin/operators" linkLabel="למסך עובדים">
              <Metric label="פניות שנשלחו" value={snapshot.outreach_sent_count} />
              <Metric label="פניות שנענו" value={snapshot.outreach_replied_count} />
            </OperationsGroup>

            <OperationsGroup title="Moderation" icon={Flag} to="/admin/reports" linkLabel="לדיווחים">
              <Metric label="דיווחי לקוחות פתוחים" value={snapshot.open_client_report_count} />
              <Metric label="דיווחי עובדים פתוחים" value={snapshot.open_operator_report_count} />
              <Metric label="חסימות פעילות" value={snapshot.active_operator_client_block_count} />
              <Metric label="לקוחות בארכיון" value={snapshot.archived_client_count} />
            </OperationsGroup>

            <OperationsGroup title="מדיה" icon={Image} to="/admin/characters" linkLabel="למדיה">
              <Metric label="סה״כ נכסים" value={snapshot.media_asset_total} />
              <Metric label="זמינים" value={snapshot.media_asset_available_count} tone="normal" />
              <Metric label="שמורים" value={snapshot.media_asset_reserved_count} />
              <Metric label="נשלחו" value={snapshot.media_asset_sent_count} />
              <Metric label="שוחזרו" value={snapshot.media_asset_restored_count} />
              <Metric label="מושבתים" value={snapshot.media_asset_disabled_count} />
              <Metric label="הזמנות פעילות" value={snapshot.active_media_reservation_count} />
              <Metric label="תגיות פעילות" value={snapshot.active_media_tag_count} />
            </OperationsGroup>
          </div>
        </>
      )}
    </section>
  );
}

function OperationsGroup({
  title,
  subtitle,
  icon: Icon,
  to,
  linkLabel,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  to: "/admin/operators" | "/admin/reports" | "/admin/characters";
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-h-56">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 p-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        <Link to={to} className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
          {linkLabel}
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{children}</div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number | string;
  icon?: LucideIcon;
  tone?: "default" | "normal" | "warning" | "critical";
}) {
  const toneClass = {
    default: "text-foreground",
    normal: "text-emerald-700 dark:text-emerald-400",
    warning: "text-warning",
    critical: "text-destructive",
  }[tone];

  return (
    <div className="min-w-0">
      <div className={`flex min-h-8 items-start gap-1 text-xs leading-4 ${toneClass}`}>
        {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0">{label}</span>
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="טוען מצב תפעולי">
      {Array.from({ length: 5 }, (_, index) => (
        <Card key={index} className="min-h-56">
          <CardHeader className="p-4 pb-3">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 p-4 pt-0 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, metricIndex) => (
              <Skeleton key={metricIndex} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatWait(waitSeconds: number) {
  if (waitSeconds < 60) return `${waitSeconds} שנ׳`;

  const minutes = Math.floor(waitSeconds / 60);
  if (minutes < 60) return `${minutes} דק׳`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} שע׳ ${remainingMinutes} דק׳` : `${hours} שע׳`;
}

function formatSnapshotTime(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
