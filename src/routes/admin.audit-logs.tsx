import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminListAuditLogs } from "@/lib/audit.functions";

export const Route = createFileRoute("/admin/audit-logs")({
  component: AuditLogsPage,
});

const ACTION_LABEL: Record<string, string> = {
  "report.status_changed": "שינוי סטטוס דיווח",
  "client.status_changed": "שינוי סטטוס לקוח",
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
  const { session, user, role, loading } = useAuth();
  const adminId = !loading && role === "admin" && session?.user.id === user?.id ? user?.id : null;
  return adminId ? (
    <AuditWorkspace key={adminId} adminId={adminId} />
  ) : (
    <p role="status">נדרש חיבור מנהל מאומת.</p>
  );
}

function AuditWorkspace({ adminId }: { adminId: string }) {
  const [action, setAction] = useState("all");
  const [search, setSearch] = useState("");
  const listFn = useServerFn(adminListAuditLogs);
  const query = useQuery({
    queryKey: ["audit-logs", adminId, action],
    queryFn: () => listFn({ data: { limit: 200, ...(action === "all" ? {} : { action }) } }),
  });
  const { data, isLoading } = query;
  const filtered = (data ?? []).filter((log) =>
    [
      log.action,
      ACTION_LABEL[log.action],
      log.entity_type,
      log.entity_id,
      log.actor?.display_name,
      log.actor?.email,
    ].some((value) => value?.toLowerCase().includes(search.trim().toLowerCase())),
  );

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-4" dir="rtl">
      <PageHeader title="יומן פעולות" description="פעולות ניהול לפי סדר כרונולוגי" />
      <p className="text-sm text-muted-foreground">
        מוצגות עד 200 הרשומות האחרונות לפי מסנן הפעולה. החיפוש מקומי ברשומות שנטענו בלבד; היעדר
        תוצאה אינו מעיד על היעדר אירוע בהיסטוריה.
      </p>
      <Input
        aria-label="חיפוש ביומן שנטען"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="חיפוש ברשומות שנטענו"
      />
      <Select dir="rtl" value={action} onValueChange={setAction}>
        <SelectTrigger aria-label="סוג פעולה">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">כל הפעולות</SelectItem>
          {Object.entries(ACTION_LABEL).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        onClick={() => {
          setSearch("");
          setAction("all");
        }}
      >
        איפוס מסנני יומן
      </Button>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.isError ? "נסה לטעון יומן שוב" : "רענון יומן"}
      </Button>
      {query.isFetching && data !== undefined && <p role="status">מרענן יומן…</p>}
      {query.isError && (
        <p role="alert">
          {data === undefined ? "טעינת היומן נכשלה." : "רענון היומן נכשל. המידע השמור לא עודכן."}
        </p>
      )}
      {data !== undefined && (
        <p>
          {filtered.length} מתוך {data.length} רשומות שנטענו (מגבלה: 200)
        </p>
      )}
      <Card>
        <CardContent className="p-0">
          {isLoading && (
            <div role="status" aria-label="טוען יומן" className="p-4 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {data !== undefined && data.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              לא הוחזרו אירועים בקריאה זו.
            </div>
          )}
          {data !== undefined && data.length > 0 && filtered.length === 0 && (
            <p>אין תוצאות ברשומות שנטענו.</p>
          )}
          {filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((log) => (
                <div key={log.id} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="text-xs text-muted-foreground whitespace-nowrap min-w-32">
                    {new Date(log.created_at).toLocaleString("he-IL")}
                  </div>
                  <div className="font-medium">{ACTION_LABEL[log.action] ?? log.action}</div>
                  <div className="flex-1 min-w-0 text-muted-foreground text-xs">
                    {log.actor?.display_name ?? log.actor?.email ?? "—"}
                    {log.entity_type && <span className="mx-2">·</span>}
                    {log.entity_type && (
                      <span>
                        {log.entity_type} {log.entity_id?.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  {log.metadata && Object.keys(log.metadata as object).length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-primary">פרטים</summary>
                      {typeof log.metadata === "object" && !Array.isArray(log.metadata) && (
                        <dl className="space-y-1">
                          {typeof log.metadata.previous_status === "string" && (
                            <>
                              <dt>סטטוס קודם</dt>
                              <dd>{log.metadata.previous_status}</dd>
                            </>
                          )}
                          {typeof log.metadata.status === "string" && (
                            <>
                              <dt>סטטוס חדש</dt>
                              <dd>{log.metadata.status}</dd>
                            </>
                          )}
                        </dl>
                      )}
                      <pre
                        className="mt-1 p-2 bg-muted rounded text-[10px] max-w-md overflow-auto"
                        dir="ltr"
                      >
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
