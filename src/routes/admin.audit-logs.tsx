import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminListAuditLogs } from "@/lib/audit.functions";

export const Route = createFileRoute("/admin/audit-logs")({
  component: AuditLogsPage,
});

const ACTION_LABEL: Record<string, string> = {
  "user.created": "יצירת משתמש",
  "user.updated": "עדכון משתמש",
  "user.deleted": "מחיקת משתמש",
  "user.status_changed": "שינוי סטטוס משתמש",
  "user.password_reset": "איפוס סיסמה",
  "user.password_reset_sent": "שליחת איפוס סיסמה",
  "user.impersonated": "התחזות למשתמש",
  "invite.created": "יצירת הזמנה",
  "invite.revoked": "ביטול הזמנה",
  "invite.accepted": "הזמנה אושרה",
  "character.created": "יצירת דמות",
  "character.updated": "עדכון דמות",
  "conversation.reassigned": "העברת שיחה",
  "report.resolved": "טיפול בדיווח",
};

function AuditLogsPage() {
  const listFn = useServerFn(adminListAuditLogs);
  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => listFn({ data: { limit: 200 } }),
  });

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8">
      <PageHeader title="יומן פעולות" description="פעולות ניהול לפי סדר כרונולוגי" />
      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-4 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
          {!isLoading && (data?.length ?? 0) === 0 && (
            <div className="p-12 text-center text-muted-foreground">אין פעולות מתועדות</div>
          )}
          {!isLoading && data && data.length > 0 && (
            <div className="divide-y">
              {data.map((log) => (
                <div key={log.id} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="text-xs text-muted-foreground whitespace-nowrap min-w-32">
                    {new Date(log.created_at).toLocaleString("he-IL")}
                  </div>
                  <div className="font-medium">
                    {ACTION_LABEL[log.action] ?? log.action}
                  </div>
                  <div className="flex-1 min-w-0 text-muted-foreground text-xs">
                    {log.actor?.display_name ?? log.actor?.email ?? "—"}
                    {log.entity_type && (
                      <span className="mx-2">·</span>
                    )}
                    {log.entity_type && (
                      <span>
                        {log.entity_type} {log.entity_id?.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  {log.metadata && Object.keys(log.metadata as object).length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-primary">פרטים</summary>
                      <pre className="mt-1 p-2 bg-muted rounded text-[10px] max-w-md overflow-auto" dir="ltr">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
