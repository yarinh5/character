import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/admin/AdminLayout";
import { RecoveryOperationsPanel } from "@/components/admin/RecoveryOperationsPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { formatSupportTarget, getSupportFirstResponseState } from "@/lib/supportSla";

export const Route = createFileRoute("/admin/support")({ component: AdminSupportPage });

const ticketStatuses = ["new", "in_progress", "waiting_for_client", "closed"] as const;
const ticketStatusLabel: Record<string, string> = {
  new: "חדש",
  in_progress: "בטיפול",
  waiting_for_client: "ממתין ללקוח",
  closed: "סגור",
};
const incidentStatusLabel: Record<string, string> = {
  open: "פתוח",
  acknowledged: "אושר קבלה",
  resolved: "נפתר",
};
const responseStateLabels: Record<string, string> = {
  not_set: "יעד לא נקבע",
  pending: "ממתין",
  overdue: "באיחור",
  answered_on_time: "נענה עד היעד",
  answered_late: "נענה באיחור",
};

function AdminSupportPage() {
  const qc = useQueryClient();
  const [ticketFilter, setTicketFilter] = useState("open");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState("in_progress");
  const [draftAssignee, setDraftAssignee] = useState("");
  const [reply, setReply] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [incident, setIncident] = useState({
    incidentType: "outage",
    severity: "critical",
    title: "",
    details: "",
  });
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [incidentStatus, setIncidentStatus] = useState("acknowledged");
  const [incidentOwner, setIncidentOwner] = useState("");
  const [incidentAction, setIncidentAction] = useState("");

  const admins = useQuery({
    queryKey: ["support-admins"],
    queryFn: async () => {
      const { data: roles, error } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin");
      if (error) throw error;
      const ids = (roles ?? []).map((row) => row.user_id);
      if (!ids.length) return [];
      const { data, error: profileError } = await supabase
        .from("profiles")
        .select("user_id,display_name,email")
        .in("user_id", ids);
      if (profileError) throw profileError;
      return data ?? [];
    },
  });
  const tickets = useQuery({
    queryKey: ["admin-support-tickets", ticketFilter, assigneeFilter, fromDate],
    queryFn: async () => {
      let query = supabase
        .from("support_tickets")
        .select(
          "id,client_id,subject,category,description,status,assignee_admin_id,version,created_at,updated_at,first_response_target_at,first_response_timezone,first_human_response_at,first_response_within_target",
        )
        .order("updated_at", { ascending: false })
        .limit(200);
      if (ticketFilter !== "all")
        query =
          ticketFilter === "open"
            ? query.neq("status", "closed")
            : query.eq("status", ticketFilter);
      if (assigneeFilter === "unassigned") query = query.is("assignee_admin_id", null);
      else if (assigneeFilter !== "all") query = query.eq("assignee_admin_id", assigneeFilter);
      if (fromDate) query = query.gte("created_at", `${fromDate}T00:00:00.000Z`);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
  const selected = useMemo(
    () => tickets.data?.find((row) => row.id === selectedTicketId) ?? null,
    [selectedTicketId, tickets.data],
  );
  const messages = useQuery({
    queryKey: ["admin-support-messages", selectedTicketId],
    enabled: !!selectedTicketId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_ticket_messages")
        .select("id,author_user_id,author_kind,visibility,body,created_at")
        .eq("ticket_id", selectedTicketId!)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
  const incidents = useQuery({
    queryKey: ["admin-support-incidents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_incidents")
        .select(
          "id,incident_type,severity,title,status,owner_admin_id,escalation_status,escalation_failure_code,version,opened_at,acknowledged_at,resolved_at",
        )
        .order("opened_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const refreshTicket = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["admin-support-tickets"] }),
      qc.invalidateQueries({ queryKey: ["admin-support-messages", selectedTicketId] }),
    ]);
  };
  const updateTicket = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("ticket_required");
      const { data, error } = await supabase.rpc("admin_update_support_ticket", {
        _ticket_id: selected.id,
        _expected_version: selected.version,
        _status: draftStatus,
        _assignee_admin_id: draftAssignee || null,
      });
      if (error) throw error;
      if (!data?.[0]?.id) throw new Error("ticket_update_not_verified");
      return data[0];
    },
    onSuccess: async () => {
      await refreshTicket();
      toast.success("הטיפול עודכן ותועד");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message.includes("expected_version_mismatch")
          ? "הפנייה השתנתה בידי מנהל אחר. רעננו לפני שמירה."
          : "עדכון הטיפול נכשל",
      ),
  });
  const sendMessage = useMutation({
    mutationFn: async ({
      body,
      visibility,
    }: {
      body: string;
      visibility: "client" | "internal";
    }) => {
      if (!selected) throw new Error("ticket_required");
      const { data, error } = await supabase.rpc("admin_add_support_ticket_message", {
        _ticket_id: selected.id,
        _body: body.trim(),
        _visibility: visibility,
        _idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      if (!data?.[0]?.id) throw new Error("support_message_not_verified");
      return data[0];
    },
    onSuccess: async (_, variables) => {
      if (variables.visibility === "client") setReply("");
      else setInternalNote("");
      await refreshTicket();
      toast.success(
        variables.visibility === "client" ? "התשובה נשמרה ונמסרה במוצר" : "ההערה הפנימית נשמרה",
      );
    },
    onError: () => toast.error("ההודעה לא נשמרה; לא הוצגה הצלחה"),
  });
  const createIncident = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("admin_create_support_incident", {
        _incident_type: incident.incidentType,
        _severity: incident.severity,
        _title: incident.title.trim(),
        _details: incident.details.trim(),
        _owner_admin_id: draftAssignee || null,
        _ticket_ids: selected ? [selected.id] : [],
        _idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      if (!data?.[0]?.id) throw new Error("incident_not_verified");
      return data[0];
    },
    onSuccess: async (saved) => {
      setIncident((value) => ({ ...value, title: "", details: "" }));
      await qc.invalidateQueries({ queryKey: ["admin-support-incidents"] });
      toast.success(
        saved.escalation_status === "pending_configuration"
          ? "האירוע נשמר; חסרה תצורת הסלמה חיצונית"
          : "האירוע נשמר והסלמה פנימית נוצרה",
      );
    },
    onError: () => toast.error("האירוע לא נשמר"),
  });
  const updateIncident = useMutation({
    mutationFn: async () => {
      const current = incidents.data?.find((item) => item.id === selectedIncidentId);
      if (!current) throw new Error("incident_required");
      const { data, error } = await supabase.rpc("admin_update_support_incident", {
        _incident_id: current.id,
        _expected_version: current.version,
        _status: incidentStatus,
        _owner_admin_id: incidentOwner || null,
        _action: incidentAction.trim() || null,
      });
      if (error) throw error;
      if (!data?.[0]?.id) throw new Error("incident_update_not_verified");
      return data[0];
    },
    onSuccess: async () => {
      setIncidentAction("");
      await qc.invalidateQueries({ queryKey: ["admin-support-incidents"] });
      toast.success("האירוע עודכן ותועד");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message.includes("expected_version_mismatch")
          ? "האירוע השתנה. רעננו לפני שמירה."
          : "עדכון האירוע נכשל",
      ),
  });

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-8" dir="rtl">
      <PageHeader
        title="תמיכה ואירועים"
        description="טיפול בפניות לקוח והסלמה מתועדת של אירועים קריטיים"
      />
      <Tabs defaultValue="tickets">
        <TabsList>
          <TabsTrigger value="tickets">פניות</TabsTrigger>
          <TabsTrigger value="incidents">אירועים</TabsTrigger>
          <TabsTrigger value="recovery">שחזור והתאוששות</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets" className="mt-4">
          <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="ticket-status-filter">מצב</Label>
              <select
                id="ticket-status-filter"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={ticketFilter}
                onChange={(e) => setTicketFilter(e.target.value)}
              >
                <option value="open">פתוחות</option>
                <option value="all">הכול</option>
                {ticketStatuses.map((status) => (
                  <option key={status} value={status}>
                    {ticketStatusLabel[status]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ticket-assignee-filter">אחראי</Label>
              <select
                id="ticket-assignee-filter"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
              >
                <option value="all">הכול</option>
                <option value="unassigned">ללא אחראי</option>
                {admins.data?.map((admin) => (
                  <option key={admin.user_id} value={admin.user_id}>
                    {admin.display_name ?? admin.email ?? admin.user_id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ticket-from-date">נפתח מתאריך</Label>
              <Input
                id="ticket-from-date"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
            <Card>
              <CardContent className="space-y-2 p-4">
                {tickets.isLoading && <p role="status">טוען תור...</p>}
                {tickets.isError && (
                  <div role="alert">
                    <p>טעינת התור נכשלה.</p>
                    <Button size="sm" variant="outline" onClick={() => void tickets.refetch()}>
                      <RefreshCw className="ml-2 h-4 w-4" />
                      ניסיון נוסף
                    </Button>
                  </div>
                )}
                {!tickets.isLoading && !tickets.isError && !tickets.data?.length && (
                  <p className="text-muted-foreground">אין פניות במסנן שנבחר.</p>
                )}
                {tickets.data?.map((ticket) => (
                  <button
                    key={ticket.id}
                    type="button"
                    onClick={() => {
                      setSelectedTicketId(ticket.id);
                      setDraftStatus(ticket.status);
                      setDraftAssignee(ticket.assignee_admin_id ?? "");
                    }}
                    className={`w-full rounded-md border p-3 text-right ${selectedTicketId === ticket.id ? "border-primary bg-primary/5" : ""}`}
                  >
                    <span className="block font-medium">{ticket.subject}</span>
                    <span className="text-xs text-muted-foreground">
                      {ticketStatusLabel[ticket.status]} ·{" "}
                      {new Date(ticket.updated_at).toLocaleString("he-IL")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      מענה ראשון:{" "}
                      {
                        responseStateLabels[
                          getSupportFirstResponseState({
                            firstResponseTargetAt: ticket.first_response_target_at,
                            firstHumanResponseAt: ticket.first_human_response_at,
                            firstResponseWithinTarget: ticket.first_response_within_target,
                          })
                        ]
                      }
                    </span>
                  </button>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{selected?.subject ?? "בחרו פנייה"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {selected && (
                  <>
                    <div className="rounded-md border bg-muted/30 p-3 text-sm">
                      {selected.description}
                    </div>
                    <div className="rounded-md border p-3 text-sm" aria-live="polite">
                      <p>
                        מצב יעד המענה הראשון:{" "}
                        <strong>
                          {
                            responseStateLabels[
                              getSupportFirstResponseState({
                                firstResponseTargetAt: selected.first_response_target_at,
                                firstHumanResponseAt: selected.first_human_response_at,
                                firstResponseWithinTarget: selected.first_response_within_target,
                              })
                            ]
                          }
                        </strong>
                      </p>
                      {selected.first_response_target_at && selected.first_response_timezone && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          יעד:{" "}
                          {formatSupportTarget(
                            selected.first_response_target_at,
                            selected.first_response_timezone,
                          )}{" "}
                          ({selected.first_response_timezone})
                        </p>
                      )}
                      {selected.first_human_response_at && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          מענה ראשון נשמר:{" "}
                          {new Date(selected.first_human_response_at).toLocaleString(
                            "he-IL",
                            selected.first_response_timezone
                              ? { timeZone: selected.first_response_timezone }
                              : undefined,
                          )}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="support-ticket-status">מצב</Label>
                        <select
                          id="support-ticket-status"
                          className="h-10 w-full rounded-md border bg-background px-3"
                          value={draftStatus}
                          onChange={(e) => setDraftStatus(e.target.value)}
                        >
                          {ticketStatuses.map((status) => (
                            <option key={status} value={status}>
                              {ticketStatusLabel[status]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="support-ticket-assignee">אחראי</Label>
                        <select
                          id="support-ticket-assignee"
                          className="h-10 w-full rounded-md border bg-background px-3"
                          value={draftAssignee}
                          onChange={(e) => setDraftAssignee(e.target.value)}
                        >
                          <option value="">ללא אחראי</option>
                          {admins.data?.map((admin) => (
                            <option key={admin.user_id} value={admin.user_id}>
                              {admin.display_name ?? admin.email ?? admin.user_id}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <Button onClick={() => updateTicket.mutate()} disabled={updateTicket.isPending}>
                      {updateTicket.isPending ? "שומר..." : "שמירת מצב ואחראי"}
                    </Button>
                    <div className="space-y-2 border-t pt-4">
                      {messages.isLoading && <p role="status">טוען הודעות...</p>}
                      {messages.isError && <p role="alert">טעינת ההודעות נכשלה.</p>}
                      {messages.data?.map((message) => (
                        <div
                          key={message.id}
                          className={`rounded-md border p-3 text-sm ${message.visibility === "internal" ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20" : ""}`}
                        >
                          <p className="font-medium">
                            {message.visibility === "internal"
                              ? "הערה פנימית"
                              : message.author_kind === "client"
                                ? "לקוח"
                                : "תמיכה"}
                          </p>
                          <p>{message.body}</p>
                        </div>
                      ))}
                    </div>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (reply.trim() && !sendMessage.isPending)
                          sendMessage.mutate({ body: reply, visibility: "client" });
                      }}
                      className="space-y-2"
                    >
                      <Label htmlFor="admin-support-reply">תשובה ללקוח</Label>
                      <Textarea
                        id="admin-support-reply"
                        maxLength={4000}
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                      />
                      <Button disabled={sendMessage.isPending}>שליחת תשובה</Button>
                    </form>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (internalNote.trim() && !sendMessage.isPending)
                          sendMessage.mutate({ body: internalNote, visibility: "internal" });
                      }}
                      className="space-y-2"
                    >
                      <Label htmlFor="admin-support-note">הערה פנימית</Label>
                      <Textarea
                        id="admin-support-note"
                        maxLength={4000}
                        value={internalNote}
                        onChange={(e) => setInternalNote(e.target.value)}
                      />
                      <Button variant="outline" disabled={sendMessage.isPending}>
                        שמירת הערה פנימית
                      </Button>
                    </form>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="recovery" className="mt-4">
          <RecoveryOperationsPanel />
        </TabsContent>
        <TabsContent value="incidents" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-5 w-5" />
                  פתיחת אירוע
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    if (!createIncident.isPending) createIncident.mutate();
                  }}
                  className="space-y-3"
                >
                  <div>
                    <Label htmlFor="support-incident-type">סוג</Label>
                    <select
                      id="support-incident-type"
                      className="h-10 w-full rounded-md border bg-background px-3"
                      value={incident.incidentType}
                      onChange={(e) => setIncident({ ...incident, incidentType: e.target.value })}
                    >
                      <option value="outage">השבתה</option>
                      <option value="suspected_data_leak">חשד לדליפה</option>
                      <option value="incorrect_charge">חיוב שגוי</option>
                      <option value="significant_authorization_failure">כשל משמעותי בהרשאות</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="support-incident-severity">חומרה</Label>
                    <select
                      id="support-incident-severity"
                      className="h-10 w-full rounded-md border bg-background px-3"
                      value={incident.severity}
                      onChange={(e) => setIncident({ ...incident, severity: e.target.value })}
                    >
                      <option value="critical">קריטי</option>
                      <option value="high">גבוה</option>
                      <option value="medium">בינוני</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="support-incident-title">כותרת</Label>
                    <Input
                      id="support-incident-title"
                      minLength={4}
                      maxLength={160}
                      required
                      value={incident.title}
                      onChange={(e) => setIncident({ ...incident, title: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="support-incident-details">פרטים ופעולות ראשוניות</Label>
                    <Textarea
                      id="support-incident-details"
                      minLength={10}
                      maxLength={4000}
                      required
                      value={incident.details}
                      onChange={(e) => setIncident({ ...incident, details: e.target.value })}
                    />
                  </div>
                  {selected && (
                    <p className="text-xs text-muted-foreground">
                      הפנייה {selected.id} תקושר לאירוע.
                    </p>
                  )}
                  <Button disabled={createIncident.isPending}>
                    {createIncident.isPending ? "שומר..." : "פתיחת אירוע והסלמה פנימית"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    מסירה חיצונית אינה מסומנת כנמסרה בלי מחבר ותוצאה אמיתית.
                  </p>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">אירועים</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {incidents.isLoading && <p role="status">טוען אירועים...</p>}
                {incidents.isError && (
                  <div role="alert">
                    <p>טעינת האירועים נכשלה.</p>
                    <Button size="sm" variant="outline" onClick={() => void incidents.refetch()}>
                      ניסיון נוסף
                    </Button>
                  </div>
                )}
                {!incidents.isLoading && !incidents.isError && !incidents.data?.length && (
                  <p className="text-muted-foreground">אין אירועים.</p>
                )}
                {incidents.data?.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      setSelectedIncidentId(item.id);
                      setIncidentStatus(item.status === "open" ? "acknowledged" : item.status);
                      setIncidentOwner(item.owner_admin_id ?? "");
                    }}
                    className={`w-full rounded-md border p-3 text-right ${selectedIncidentId === item.id ? "border-primary bg-primary/5" : ""}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{item.title}</strong>
                      <span className="text-sm">
                        {incidentStatusLabel[item.status] ?? item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.severity} · הסלמה: {item.escalation_status} ·{" "}
                      {new Date(item.opened_at).toLocaleString("he-IL")}
                    </p>
                    {item.escalation_failure_code && (
                      <p role="alert" className="text-sm text-destructive">
                        כשל מסירה: {item.escalation_failure_code}
                      </p>
                    )}
                  </button>
                ))}
                {selectedIncidentId && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!updateIncident.isPending) updateIncident.mutate();
                    }}
                    className="space-y-3 border-t pt-4"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="support-incident-status">מצב האירוע</Label>
                        <select
                          id="support-incident-status"
                          className="h-10 w-full rounded-md border bg-background px-3"
                          value={incidentStatus}
                          onChange={(event) => setIncidentStatus(event.target.value)}
                        >
                          <option value="open">פתוח</option>
                          <option value="acknowledged">אושר קבלה</option>
                          <option value="resolved">נפתר</option>
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="support-incident-owner">אחראי</Label>
                        <select
                          id="support-incident-owner"
                          className="h-10 w-full rounded-md border bg-background px-3"
                          value={incidentOwner}
                          onChange={(event) => setIncidentOwner(event.target.value)}
                        >
                          <option value="">ללא אחראי</option>
                          {admins.data?.map((admin) => (
                            <option key={admin.user_id} value={admin.user_id}>
                              {admin.display_name ?? admin.email ?? admin.user_id}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="incident-action">פעולה מתועדת</Label>
                      <Textarea
                        id="incident-action"
                        maxLength={1000}
                        value={incidentAction}
                        onChange={(event) => setIncidentAction(event.target.value)}
                      />
                    </div>
                    <Button disabled={updateIncident.isPending}>
                      {updateIncident.isPending ? "שומר..." : "עדכון אירוע"}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
