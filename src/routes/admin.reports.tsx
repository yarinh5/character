import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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

export const Route = createFileRoute("/admin/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("open");
  const [selected, setSelected] = useState<any | null>(null);
  const setClientStatus = useServerFn(adminSetClientStatus);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reports")
        .select(
          "id, reason, details, status, created_at, conversation_id, reporter_id, conversations(characters(name))",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      const ids = Array.from(new Set((data ?? []).map((r: any) => r.reporter_id)));
      const { data: profs } = ids.length
        ? await supabase.from("profiles").select("user_id, display_name, email").in("user_id", ids)
        : { data: [] as any[] };
      const map = new Map((profs ?? []).map((p) => [p.user_id, p]));
      return (data ?? []).map((r: any) => ({ ...r, reporter: map.get(r.reporter_id) }));
    },
  });

  const { data: operatorReports = [], isLoading: isLoadingOperatorReports } = useQuery({
    queryKey: ["admin-operator-client-reports"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_operator_client_reports");
      if (error) throw error;
      return data ?? [];
    },
  });

  const filtered = (data ?? []).filter((r: any) => filter === "all" || r.status === filter);

  const setStatus = async (id: string, status: string) => {
    const { error } = await supabase.rpc("admin_update_report_status", {
      _report_id: id,
      _status: status as "open" | "reviewed" | "resolved" | "dismissed",
    });
    if (error) {
      toast.error("עדכון נכשל");
      return;
    }
    toast.success("דיווח עודכן");
    qc.invalidateQueries({ queryKey: ["admin-reports"] });
    if (selected) setSelected({ ...selected, status });
  };

  const blockClient = async (uid: string) => {
    try {
      await setClientStatus({ data: { user_id: uid, is_active: false } });
    } catch {
      toast.error("חסימה נכשלה");
      return;
    }
    toast.success("הלקוח נחסם");
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8">
      <PageHeader title="דיווחים" description="טיפול בדיווחים מלקוחות" />

      <Card className="mb-4">
        <CardContent className="p-4">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-full md:w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הדיווחים</SelectItem>
              <SelectItem value="open">פתוחים</SelectItem>
              <SelectItem value="reviewed">בטיפול</SelectItem>
              <SelectItem value="resolved">טופלו</SelectItem>
              <SelectItem value="dismissed">נדחו</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-6"><Skeleton className="h-32" /></div>}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">אין דיווחים</p>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((r: any) => (
                <div key={r.id} className="flex items-center gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{r.reason}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.reporter?.display_name ?? r.reporter?.email ?? "—"} · דמות:{" "}
                      {r.conversations?.characters?.name ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("he-IL")}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setSelected(r)}>פרטים</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="p-0">
          <div className="border-b px-4 py-3">
            <h2 className="font-semibold">דיווחי עובדים</h2>
          </div>
          {isLoadingOperatorReports && <div className="p-6"><Skeleton className="h-20" /></div>}
          {!isLoadingOperatorReports && operatorReports.length === 0 && (
            <p className="text-center text-muted-foreground py-8">אין דיווחי עובדים</p>
          )}
          {!isLoadingOperatorReports && operatorReports.length > 0 && (
            <div className="divide-y">
              {operatorReports.map((report) => (
                <div key={report.id} className="p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium truncate">{report.reason}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{new Date(report.created_at).toLocaleString("he-IL")}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    עובד: {report.operator_name} · לקוח: {report.client_display_name ?? report.client_id}
                  </p>
                  {report.notes && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{report.notes}</p>}
                  {report.conversation_id && (
                    <Button asChild variant="link" className="mt-1 h-auto px-0 text-xs">
                      <Link to="/admin/conversations/$conversationId" params={{ conversationId: report.conversation_id }}>
                        מעבר לשיחה
                      </Link>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Dialog open onOpenChange={(o) => !o && setSelected(null)}>
          <DialogContent dir="rtl" className="max-w-lg">
            <DialogHeader>
              <DialogTitle>פרטי דיווח</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">מדווח:</span> {selected.reporter?.display_name ?? selected.reporter?.email}</div>
              <div><span className="text-muted-foreground">דמות:</span> {selected.conversations?.characters?.name ?? "—"}</div>
              <div><span className="text-muted-foreground">סיבה:</span> {selected.reason}</div>
              {selected.details && (
                <div>
                  <span className="text-muted-foreground">פירוט:</span>
                  <p className="mt-1 p-2 bg-muted rounded">{selected.details}</p>
                </div>
              )}
              <div><span className="text-muted-foreground">סטטוס:</span> <StatusBadge status={selected.status} /></div>
              {selected.conversation_id && (
                <Button asChild variant="link" className="px-0">
                  <Link to="/admin/conversations/$conversationId" params={{ conversationId: selected.conversation_id }}>
                    מעבר לשיחה
                  </Link>
                </Button>
              )}
            </div>
            <DialogFooter className="gap-2 flex-wrap">
              <Select value={selected.status} onValueChange={(v) => setStatus(selected.id, v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">פתוח</SelectItem>
                  <SelectItem value="reviewed">בטיפול</SelectItem>
                  <SelectItem value="resolved">טופל</SelectItem>
                  <SelectItem value="dismissed">נדחה</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="destructive" onClick={() => blockClient(selected.reporter_id)}>
                חסום מדווח
              </Button>
              <Button variant="outline" onClick={() => setSelected(null)}>סגור</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
