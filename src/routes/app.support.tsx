import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useMemo, useState } from "react";
import { LifeBuoy, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { formatSupportTarget, getSupportFirstResponseState } from "@/lib/supportSla";
import { createSupportTicketWithDependencies, type SupportCategory } from "@/lib/supportWorkflow";

export const Route = createFileRoute("/app/support")({ component: ClientSupportPage });

const statusLabels: Record<string, string> = {
  new: "חדש",
  in_progress: "בטיפול",
  waiting_for_client: "ממתין למידע ממך",
  closed: "סגור",
};
const responseStateLabels: Record<string, string> = {
  not_set: "יעד מענה לא נקבע",
  pending: "ממתין למענה",
  overdue: "המענה באיחור",
  answered_on_time: "נענה עד היעד",
  answered_late: "נענה לאחר היעד",
};

function ClientSupportPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ subject: "", category: "technical", description: "" });
  const [message, setMessage] = useState("");

  const tickets = useQuery({
    queryKey: ["client-support-tickets"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_tickets")
        .select(
          "id,subject,category,description,status,created_at,updated_at,version,first_response_target_at,first_response_timezone,first_human_response_at,first_response_within_target",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const activeId = selectedId ?? tickets.data?.[0]?.id ?? null;
  const messages = useQuery({
    queryKey: ["client-support-messages", activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_ticket_messages")
        .select("id,author_kind,body,created_at")
        .eq("ticket_id", activeId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  const selected = useMemo(
    () => tickets.data?.find((ticket) => ticket.id === activeId) ?? null,
    [activeId, tickets.data],
  );

  const createTicket = useMutation({
    mutationFn: async () =>
      createSupportTicketWithDependencies(
        {
          ...form,
          category: form.category as SupportCategory,
          idempotencyKey: crypto.randomUUID(),
        },
        {
          async create(input) {
            const { data, error } = await supabase.rpc("create_support_ticket", {
              _subject: input.subject,
              _category: input.category,
              _description: input.description,
              _idempotency_key: input.idempotencyKey,
            });
            if (error) throw error;
            const saved = data?.[0];
            if (!saved?.id) throw new Error("support_ticket_not_verified");
            return saved;
          },
        },
      ),
    onSuccess: async (saved) => {
      setForm({ subject: "", category: "technical", description: "" });
      setSelectedId(saved.id);
      await qc.invalidateQueries({ queryKey: ["client-support-tickets"] });
      toast.success(`הפנייה נשמרה: ${saved.id}`);
    },
    onError: () => toast.error("הפנייה לא נשמרה. ניתן לנסות שוב במפורש."),
  });

  const addMessage = useMutation({
    mutationFn: async () => {
      if (!activeId) throw new Error("ticket_required");
      const { data, error } = await supabase.rpc("add_support_ticket_message", {
        _ticket_id: activeId,
        _body: message.trim(),
        _idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      const saved = data?.[0];
      if (!saved?.id) throw new Error("support_message_not_verified");
      return saved;
    },
    onSuccess: async () => {
      setMessage("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["client-support-messages", activeId] }),
        qc.invalidateQueries({ queryKey: ["client-support-tickets"] }),
      ]);
      toast.success("המידע נוסף לפנייה");
    },
    onError: () => toast.error("המידע לא נשמר. הפנייה הקיימת לא שונתה."),
  });

  const submitTicket = (event: FormEvent) => {
    event.preventDefault();
    if (!createTicket.isPending) createTicket.mutate();
  };

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8" dir="rtl">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <LifeBuoy className="h-6 w-6" />
          תמיכה
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          יעד המענה הראשון מוצג לפי לוח התמיכה שהיה בתוקף בעת פתיחת הפנייה.
        </p>
      </header>
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">פנייה חדשה</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitTicket}>
                <div>
                  <Label htmlFor="support-subject">נושא</Label>
                  <Input
                    id="support-subject"
                    minLength={4}
                    maxLength={120}
                    required
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="support-category">קטגוריה</Label>
                  <select
                    id="support-category"
                    className="h-10 w-full rounded-md border bg-background px-3"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    <option value="account">חשבון</option>
                    <option value="conversation">שיחה</option>
                    <option value="billing">חיוב</option>
                    <option value="privacy">פרטיות</option>
                    <option value="technical">תקלה טכנית</option>
                    <option value="other">אחר</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="support-description">תיאור</Label>
                  <Textarea
                    id="support-description"
                    minLength={10}
                    maxLength={4000}
                    rows={5}
                    required
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    אין לצרף סיסמאות, tokens או פרטי תשלום מלאים.
                  </p>
                </div>
                <Button className="w-full" disabled={createTicket.isPending}>
                  {createTicket.isPending ? "שומר..." : "פתיחת פנייה"}
                </Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">הפניות שלי</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {tickets.isLoading && <p role="status">טוען פניות...</p>}
              {tickets.isError && (
                <div role="alert">
                  <p>טעינת הפניות נכשלה.</p>
                  <Button size="sm" variant="outline" onClick={() => void tickets.refetch()}>
                    <RefreshCw className="ml-2 h-4 w-4" />
                    ניסיון נוסף
                  </Button>
                </div>
              )}
              {!tickets.isLoading && !tickets.isError && !tickets.data?.length && (
                <p className="text-sm text-muted-foreground">אין פניות עדיין.</p>
              )}
              {tickets.data?.map((ticket) => (
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => setSelectedId(ticket.id)}
                  className={`w-full rounded-md border p-3 text-right ${activeId === ticket.id ? "border-primary bg-primary/5" : ""}`}
                >
                  <span className="block font-medium">{ticket.subject}</span>
                  <span className="text-xs text-muted-foreground">
                    {statusLabels[ticket.status] ?? ticket.status} · {ticket.id}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{selected?.subject ?? "פרטי פנייה"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected && (
              <p className="text-muted-foreground">בחרו פנייה כדי לראות את ההתכתבות.</p>
            )}
            {selected && (
              <>
                <p className="text-sm">
                  מצב: <strong>{statusLabels[selected.status] ?? selected.status}</strong>
                </p>
                <div className="rounded-md border p-3 text-sm" aria-live="polite">
                  <p>
                    מענה ראשון:{" "}
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
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  {selected.description}
                </div>
                {messages.isLoading && <p role="status">טוען התכתבות...</p>}
                {messages.isError && (
                  <div role="alert">
                    <p>טעינת ההתכתבות נכשלה.</p>
                    <Button size="sm" variant="outline" onClick={() => void messages.refetch()}>
                      ניסיון נוסף
                    </Button>
                  </div>
                )}
                <div className="space-y-2">
                  {messages.data?.map((item) => (
                    <div
                      key={item.id}
                      className={`rounded-md border p-3 text-sm ${item.author_kind === "client" ? "bg-muted/40" : "bg-primary/5"}`}
                    >
                      <p>{item.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.author_kind === "client" ? "את/ה" : "תמיכה"} ·{" "}
                        {new Date(item.created_at).toLocaleString("he-IL")}
                      </p>
                    </div>
                  ))}
                </div>
                {selected.status !== "closed" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (message.trim() && !addMessage.isPending) addMessage.mutate();
                    }}
                    className="space-y-2"
                  >
                    <Label htmlFor="support-message">הוספת מידע</Label>
                    <Textarea
                      id="support-message"
                      maxLength={4000}
                      required
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                    <Button disabled={addMessage.isPending}>
                      {addMessage.isPending ? "שומר..." : "שליחה"}
                    </Button>
                  </form>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
