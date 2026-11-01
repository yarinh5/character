import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useLayoutEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { Database } from "@/integrations/supabase/types";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { adminSetClientStatus } from "@/lib/admin-clients.functions";

export const Route = createFileRoute("/admin/reports")({ component: ReportsPage });
type Status = Database["public"]["Enums"]["report_status"];
const statuses: Record<Status, string> = {
  open: "פתוח",
  reviewed: "בטיפול",
  resolved: "טופל",
  dismissed: "נדחה",
};
async function readReports() {
  const { data, error } = await supabase
    .from("reports")
    .select(
      "id, reason, details, status, created_at, conversation_id, reporter_id, conversations(characters(name))",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
type Report = Awaited<ReturnType<typeof readReports>>[number];

function ReportsPage() {
  const { session, user, role, loading } = useAuth();
  const adminId = !loading && role === "admin" && session?.user.id === user?.id ? user?.id : null;
  return adminId ? (
    <ReportsWorkspace key={adminId} adminId={adminId} />
  ) : (
    <p role="status">נדרש חיבור מנהל מאומת.</p>
  );
}

function ReportsWorkspace({ adminId }: { adminId: string }) {
  const qc = useQueryClient();
  const setClientStatus = useServerFn(adminSetClientStatus);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [workerSearch, setWorkerSearch] = useState("");
  const [source, setSource] = useState("all");
  const [selected, setSelected] = useState<{ report: Report; instance: number } | null>(null);
  const selection = useRef<typeof selected>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const serial = useRef(0);
  const [draftStatus, setDraftStatus] = useState<Status>("open");
  const [confirmBlock, setConfirmBlock] = useState(false);
  const locks = useRef(new Set<string>());
  const [, redraw] = useState(0);
  const [actionError, setActionError] = useState("");
  const choose = (report: Report | null) => {
    const next = report ? { report, instance: ++serial.current } : null;
    selection.current = next;
    setSelected(next);
    setDraftStatus(report?.status ?? "open");
    setConfirmBlock(false);
    setActionError("");
  };
  const reports = useQuery({ queryKey: ["admin-reports", adminId], queryFn: readReports });
  const ids = Array.from(new Set((reports.data ?? []).map((r) => r.reporter_id))).sort();
  const profiles = useQuery({
    queryKey: ["admin-report-profiles", adminId, ids],
    enabled: reports.data !== undefined,
    queryFn: async () => {
      if (!ids.length) return [];
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, display_name, email")
        .in("user_id", ids);
      if (error) throw error;
      return data ?? [];
    },
  });
  const workers = useQuery({
    queryKey: ["admin-operator-client-reports", adminId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_operator_client_reports");
      if (error) throw error;
      return data ?? [];
    },
  });
  const reporter = (id: string) => {
    const profile = profiles.data?.find((p) => p.user_id === id);
    if (profile) return profile.display_name ?? profile.email ?? id;
    if (profiles.isError) return "לא ניתן לאמת פרטי מדווח";
    if (profiles.isPending) return "טוען פרטי מדווח";
    return "פרופיל המדווח אינו קיים";
  };
  const filtered = (reports.data ?? []).filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      [r.id, r.reason, r.details, reporter(r.reporter_id), r.conversations?.characters?.name].some(
        (v) => v?.toLowerCase().includes(search.trim().toLowerCase()),
      ),
  );
  const filteredWorkers = (workers.data ?? []).filter(
    (r) =>
      (source === "all" || r.source === source) &&
      [r.reason, r.notes, r.operator_name, r.client_display_name, r.client_id].some((v) =>
        v?.toLowerCase().includes(workerSearch.trim().toLowerCase()),
      ),
  );
  const refreshReports = () => {
    void reports.refetch();
    void profiles.refetch();
  };
  const invalidate = (reporterId?: string) => {
    const keys = [
      ["admin-reports", adminId],
      ["admin-report-profiles", adminId],
      ["audit-logs", adminId],
    ];
    if (reporterId) keys.push(["admin-clients"], ["admin-client-details", reporterId]);
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
  };
  const mutate = async (kind: "status" | "block") => {
    const current = selection.current;
    if (!alive.current || !current || (kind === "block" && !confirmBlock)) return;
    const { report, instance } = current;
    const reportKey = report.id;
    const clientKey = "client:" + report.reporter_id;
    if (locks.current.has(reportKey) || locks.current.has(clientKey)) return;
    const requestedStatus = draftStatus;
    locks.current.add(reportKey);
    locks.current.add(clientKey);
    redraw((n) => n + 1);
    setActionError("");
    const sameDialog = () => alive.current && selection.current?.instance === instance;
    try {
      if (kind === "status") {
        const { data, error } = await supabase.rpc("admin_update_report_status", {
          _report_id: report.id,
          _status: requestedStatus,
        });
        if (
          error ||
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          data.report_id !== report.id ||
          data.status !== requestedStatus
        )
          throw new Error("unverified");
      } else {
        const result = await setClientStatus({
          data: { user_id: report.reporter_id, is_active: false },
        });
        if (result?.ok !== true) throw new Error("unverified");
      }
      if (!alive.current) return;
      if (sameDialog()) {
        if (kind === "status") {
          const next = { report: { ...report, status: requestedStatus }, instance };
          selection.current = next;
          setSelected(next);
        }
        setConfirmBlock(false);
        toast.success(kind === "status" ? "דיווח עודכן" : "המדווח נחסם");
      }
      invalidate(kind === "block" ? report.reporter_id : undefined);
    } catch {
      if (sameDialog()) {
        const message =
          kind === "block"
            ? "לא ניתן לאמת שהחסימה הושלמה. ייתכן שבוצע שינוי חלקי. יש לבדוק את מצב הלקוח לפני ניסיון נוסף; לא מתבצע ניסיון אוטומטי."
            : "לא ניתן לאמת את עדכון הדיווח. רעננו ובדקו את מצבו לפני ניסיון נוסף.";
        setActionError(message);
        toast.error(message);
        setConfirmBlock(false);
      }
    } finally {
      locks.current.delete(reportKey);
      locks.current.delete(clientKey);
      if (alive.current) redraw((n) => n + 1);
    }
  };
  const busy = Boolean(
    selected &&
    (locks.current.has(selected.report.id) ||
      locks.current.has("client:" + selected.report.reporter_id)),
  );
  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-4" dir="rtl">
      <PageHeader title="דיווחים" description="טיפול בדיווחים מלקוחות" />
      <Button asChild variant="outline">
        <Link to="/admin/audit-logs">עיון ביומן הפעולות</Link>
      </Button>
      <section aria-label="דיווחי לקוחות">
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="font-semibold">דיווחי לקוחות</h2>
            <Input
              aria-label="חיפוש בדיווחי לקוחות"
              placeholder="חיפוש בדיווחים שנטענו"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select dir="rtl" value={filter} onValueChange={setFilter}>
              <SelectTrigger aria-label="מסנן סטטוס">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הדיווחים</SelectItem>
                {Object.entries(statuses).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              איפוס מסנני לקוחות
            </Button>
            <ReadState label="דיווחי לקוחות" query={reports} retry={refreshReports} />
            {reports.data !== undefined && (
              <>
                <ReadState
                  label="פרטי מדווחים"
                  query={profiles}
                  retry={() => void profiles.refetch()}
                />
                <p className="text-sm text-muted-foreground">
                  {filtered.length} מתוך {reports.data.length} דיווחי לקוחות שנטענו
                </p>
                {!reports.data.length ? (
                  <p>אין דיווחי לקוחות</p>
                ) : !filtered.length ? (
                  <p>אין תוצאות במסנני הלקוחות</p>
                ) : (
                  <div className="divide-y">
                    {filtered.map((r) => (
                      <div key={r.id} className="flex items-center gap-3 py-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap gap-2">
                            <span className="font-medium break-words">{r.reason}</span>
                            <StatusBadge status={r.status} />
                          </div>
                          <p className="text-xs text-muted-foreground break-words">
                            {reporter(r.reporter_id)} · דמות:{" "}
                            {r.conversations?.characters?.name ?? "—"}
                          </p>
                          <p className="text-xs">
                            {new Date(r.created_at).toLocaleString("he-IL")}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={"פרטי דיווח " + r.reason}
                          onClick={(event) => {
                            detailTrigger.current = event.currentTarget;
                            choose(r);
                          }}
                        >
                          פרטים
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </section>
      <section aria-label="דיווחי עובדים">
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="font-semibold">דיווחי עובדים</h2>
            <Input
              aria-label="חיפוש בדיווחי עובדים"
              placeholder="חיפוש בדיווחים שנטענו"
              value={workerSearch}
              onChange={(e) => setWorkerSearch(e.target.value)}
            />
            <Select dir="rtl" value={source} onValueChange={setSource}>
              <SelectTrigger aria-label="מקור דיווח עובד">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל המקורות</SelectItem>
                {Array.from(new Set((workers.data ?? []).map((r) => r.source)))
                  .filter(Boolean)
                  .map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => {
                setSource("all");
                setWorkerSearch("");
              }}
            >
              איפוס מסנני עובדים
            </Button>
            <ReadState label="דיווחי עובדים" query={workers} retry={() => void workers.refetch()} />
            {workers.data !== undefined && (
              <>
                <p className="text-sm">
                  {filteredWorkers.length} מתוך {workers.data.length} דיווחי עובדים שנטענו
                </p>
                {!workers.data.length ? (
                  <p>אין דיווחי עובדים</p>
                ) : !filteredWorkers.length ? (
                  <p>אין תוצאות במסנני העובדים</p>
                ) : (
                  <div className="divide-y">
                    {filteredWorkers.map((r) => (
                      <article key={r.id} className="py-4 text-sm space-y-2 break-words">
                        <h3 className="font-medium">{r.reason}</h3>
                        <p>
                          עובד: {r.operator_name} · לקוח: {r.client_display_name ?? r.client_id}
                        </p>
                        <p className="text-xs">{new Date(r.created_at).toLocaleString("he-IL")}</p>
                        {r.notes && <p className="whitespace-pre-wrap">{r.notes}</p>}
                        <ConversationLink id={r.conversation_id} />
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </section>
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) choose(null);
          }}
        >
          <DialogContent
            dir="rtl"
            className="max-w-lg max-h-[85vh] overflow-y-auto"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (alive.current) detailTrigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>פרטי דיווח</DialogTitle>
              <DialogDescription>עיון וטיפול בדיווח לקוח</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm break-words">
              <p>מדווח: {reporter(selected.report.reporter_id)}</p>
              <p>דמות: {selected.report.conversations?.characters?.name ?? "—"}</p>
              <p>סיבה: {selected.report.reason}</p>
              <p className="whitespace-pre-wrap bg-muted rounded p-2">
                {selected.report.details ?? "ללא פירוט נוסף"}
              </p>
              <StatusBadge status={selected.report.status} />
              <ConversationLink
                id={selected.report.conversations ? selected.report.conversation_id : null}
              />
              {actionError && <p role="alert">{actionError}</p>}
              {busy && <p role="status">הפעולה מתבצעת…</p>}
            </div>
            <DialogFooter className="gap-2 flex-wrap">
              <Select
                dir="rtl"
                disabled={busy}
                value={draftStatus}
                onValueChange={(value) => {
                  if (value in statuses) setDraftStatus(value as Status);
                }}
              >
                <SelectTrigger aria-label="סטטוס הדיווח" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(statuses).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button disabled={busy} onClick={() => void mutate("status")}>
                עדכון סטטוס
              </Button>
              <Button
                disabled={
                  busy ||
                  profiles.isError ||
                  profiles.isPending ||
                  !profiles.data?.some((p) => p.user_id === selected.report.reporter_id)
                }
                variant="destructive"
                onClick={() => setConfirmBlock(true)}
              >
                חסום מדווח
              </Button>
              <Button variant="outline" aria-label="סגירת פרטי הדיווח" onClick={() => choose(null)}>
                סגור
              </Button>
            </DialogFooter>
            {confirmBlock && (
              <div
                role="group"
                aria-label="אישור חסימת מדווח"
                className="border border-destructive rounded p-4 space-y-3"
              >
                <p>לחסום את המדווח {reporter(selected.report.reporter_id)}?</p>
                <p className="text-sm">
                  הפעולה חוסמת את חשבון המדווח ואת אפשרות ההתחברות שלו. היא אינה חוסמת את האדם שעליו
                  התלוננו.
                </p>
                <Button variant="destructive" disabled={busy} onClick={() => void mutate("block")}>
                  אישור חסימת המדווח
                </Button>
                <Button
                  autoFocus
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmBlock(false)}
                >
                  ביטול חסימה
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
function ConversationLink({ id }: { id: string | null }) {
  return id ? (
    <Button asChild variant="link" className="px-0">
      <Link to="/admin/conversations/$conversationId" params={{ conversationId: id }}>
        מעבר לשיחה
      </Link>
    </Button>
  ) : (
    <p className="text-muted-foreground">שיחה אינה זמינה</p>
  );
}
function ReadState({
  label,
  query,
  retry,
}: {
  label: string;
  query: { isPending: boolean; isFetching: boolean; isError: boolean; data: unknown };
  retry: () => void;
}) {
  return (
    <>
      {query.isPending && (
        <div role="status" aria-label={"טוען " + label}>
          <Skeleton className="h-20" />
        </div>
      )}
      {query.isFetching && !query.isPending && <p role="status">מרענן {label}…</p>}
      {query.isError && (
        <p role="alert">
          {query.data === undefined
            ? "טעינת " + label + " נכשלה."
            : "רענון " + label + " נכשל. המידע השמור לא עודכן."}
        </p>
      )}
      <Button variant="outline" disabled={query.isFetching} onClick={retry}>
        {query.isError ? "נסה שוב: " : "רענון: "}
        {label}
      </Button>
    </>
  );
}
