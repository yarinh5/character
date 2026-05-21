import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowRight, FileText, Info } from "lucide-react";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/conversations/$conversationId")({
  component: ConvView,
});

function ConvView() {
  const { conversationId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const [noteInput, setNoteInput] = useState("");
  const [customerInfoInput, setCustomerInfoInput] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingCustomerInfo, setSavingCustomerInfo] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-conv", conversationId, user?.id],
    queryFn: async () => {
      const { data: conv, error } = await supabase
        .from("conversations")
        .select(
          "id, status, client_id, character_id, assigned_operator_id, characters(id, name, avatar_url), operators(id, full_name)",
        )
        .eq("id", conversationId)
        .single();
      if (error) throw error;

      const [
        { data: client },
        { data: cprof },
        { data: msgs },
        { data: notes },
        { data: customerInfo },
        { data: reports },
        { data: charOps },
        { data: currentOperator },
      ] = await Promise.all([
          supabase.from("profiles").select("display_name, email, status").eq("user_id", conv.client_id).maybeSingle(),
          supabase.from("client_profiles").select("age, gender, interests").eq("user_id", conv.client_id).maybeSingle(),
          supabase
            .from("messages")
            .select("id, content, sender_type, sender_id, operator_id, created_at, operators(full_name)")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: true }),
          supabase
            .from("internal_notes")
            .select("id, note, created_at, operator_id, operators(full_name)")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false }),
          supabase
            .from("customer_info_entries")
            .select("id, content, created_at, operator_id, created_by_user_id, operators(full_name)")
            .eq("client_id", conv.client_id)
            .order("created_at", { ascending: false }),
          supabase
            .from("reports")
            .select("id, reason, status, created_at")
            .eq("conversation_id", conversationId),
          supabase
            .from("character_operator_assignments")
            .select("operator_id, operators(id, full_name, is_active, availability_status)")
            .eq("character_id", conv.character_id),
          user?.id
            ? supabase
                .from("operators")
                .select("id, full_name")
                .eq("user_id", user.id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
      return {
        conv,
        client,
        cprof,
        msgs: msgs ?? [],
        notes: notes ?? [],
        customerInfo: customerInfo ?? [],
        reports: reports ?? [],
        currentOperator,
        availableOps: (charOps ?? [])
          .map((a: any) => a.operators)
          .filter((o: any) => o && o.is_active),
      };
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel(`admin-conv-${conversationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "internal_notes", filter: `conversation_id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] }),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "customer_info_entries",
          filter: data?.conv.client_id ? `client_id=eq.${data.conv.client_id}` : undefined,
        },
        () => qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [conversationId, data?.conv.client_id, qc]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.msgs.length]);

  const reassign = async (opId: string) => {
    const { error } = await supabase
      .from("conversations")
      .update({ assigned_operator_id: opId, status: "open" })
      .eq("id", conversationId);
    if (error) {
      toast.error("עדכון שיוך legacy נכשל: " + error.message);
      return;
    }
    toast.success("שיוך legacy עודכן");
    qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] });
  };

  const setStatus = async (status: string) => {
    const { error } = await supabase
      .from("conversations")
      .update({ status: status as "open" | "waiting" | "answered" | "closed" | "reported" })
      .eq("id", conversationId);
    if (error) {
      toast.error("עדכון נכשל");
      return;
    }
    toast.success("סטטוס עודכן");
    qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] });
  };

  const saveNote = async () => {
    const text = noteInput.trim();
    if (!text || savingNote) return;
    setSavingNote(true);
    const { error } = await supabase.from("internal_notes").insert({
      conversation_id: conversationId,
      operator_id: data?.currentOperator?.id ?? null,
      note: text.slice(0, 2000),
    });
    setSavingNote(false);
    if (error) {
      toast.error("שמירת הערה נכשלה");
      return;
    }
    setNoteInput("");
    toast.success("הערה נשמרה");
    qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] });
  };

  const saveCustomerInfo = async () => {
    const text = customerInfoInput.trim();
    if (!text || savingCustomerInfo || !user || !data) return;
    if (!data.currentOperator?.id) {
      toast.error("כדי לשמור מידע לקוח צריך רשומת עובד פעילה לאדמין הזה.");
      return;
    }
    setSavingCustomerInfo(true);
    const { error } = await supabase.from("customer_info_entries").insert({
      client_id: data.conv.client_id,
      conversation_id: conversationId,
      operator_id: data.currentOperator.id,
      created_by_user_id: user.id,
      content: text.slice(0, 2000),
    });
    setSavingCustomerInfo(false);
    if (error) {
      toast.error("שמירת מידע לקוח נכשלה");
      return;
    }
    setCustomerInfoInput("");
    toast.success("מידע הלקוח נשמר");
    qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] });
  };

  if (isLoading || !data) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6" dir="rtl">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/admin/conversations" })}>
          <ArrowRight className="h-4 w-4 ml-1" /> חזרה
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-muted overflow-hidden">
                  {data.conv.characters?.avatar_url ? (
                    <img src={data.conv.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center font-semibold">
                      {data.conv.characters?.name?.[0]}
                    </div>
                  )}
                </div>
                <div>
                  <CardTitle className="text-base">{data.conv.characters?.name}</CardTitle>
                  <div className="text-xs text-muted-foreground">
                    Shared Inbox לפי שיוך לדמות
                    {data.conv.operators?.full_name ? ` · legacy: ${data.conv.operators.full_name}` : ""}
                  </div>
                </div>
              </div>
              <StatusBadge status={data.conv.status} />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div ref={scrollRef} className="h-[55vh] overflow-y-auto p-4 space-y-2 bg-background/50">
              {data.msgs.length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-8">אין הודעות</p>
              )}
              {data.msgs.map((m: any) => (
                <div
                  key={m.id}
                  className={`flex ${m.sender_type === "client" ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                      m.sender_type === "client"
                        ? "bg-muted"
                        : m.sender_type === "operator"
                        ? "bg-primary text-primary-foreground"
                        : "bg-warning/20"
                    }`}
                  >
                    <div className="text-[10px] opacity-70 mb-0.5">
                      {m.sender_type === "client"
                        ? "לקוח"
                        : m.sender_type === "operator"
                          ? `עובד: ${m.operators?.full_name ?? "לא ידוע"}${m.operator_id ? ` · ${String(m.operator_id).slice(0, 8)}` : ""}`
                          : "אדמין"}
                    </div>
                    <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
                    <div className="text-[10px] opacity-60 mt-1">
                      {new Date(m.created_at).toLocaleTimeString("he-IL")}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">פעולות</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                מקור האמת לשיחות עובדים הוא Shared Inbox לפי שיוך העובדים לדמות. השדה כאן נשמר כ־legacy metadata בלבד.
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Legacy assignment / metadata</label>
                <Select onValueChange={reassign}>
                  <SelectTrigger><SelectValue placeholder="בחר עובד לשיוך legacy" /></SelectTrigger>
                  <SelectContent>
                    {data.availableOps.length === 0 && (
                      <div className="px-2 py-3 text-xs text-muted-foreground">אין עובדים משויכים לדמות</div>
                    )}
                    {data.availableOps.map((o: any) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.full_name} ({o.availability_status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">שינוי סטטוס</label>
                <Select value={data.conv.status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">פתוחה</SelectItem>
                    <SelectItem value="waiting">ממתינה</SelectItem>
                    <SelectItem value="answered">נענתה</SelectItem>
                    <SelectItem value="closed">סגורה</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">לקוח</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              <div><span className="text-muted-foreground">שם:</span> {data.client?.display_name ?? "—"}</div>
              <div className="truncate"><span className="text-muted-foreground">אימייל:</span> {data.client?.email ?? "—"}</div>
              {data.cprof?.age && <div><span className="text-muted-foreground">גיל:</span> {data.cprof.age}</div>}
              {data.cprof?.gender && <div><span className="text-muted-foreground">מגדר:</span> {data.cprof.gender}</div>}
              {data.cprof?.interests && data.cprof.interests.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {data.cprof.interests.map((i: string, idx: number) => (
                    <span key={idx} className="text-xs px-2 py-0.5 rounded-full bg-muted">{i}</span>
                  ))}
                </div>
              )}
              <Button asChild size="sm" variant="link" className="px-0">
                <Link to="/admin/clients">לכל הלקוחות</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4" /> הערות פנימיות
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="הערה פנימית..."
                  rows={2}
                  maxLength={2000}
                  className="resize-none text-sm"
                />
                <Button onClick={saveNote} disabled={savingNote || !noteInput.trim()} size="sm" className="w-full">
                  {savingNote ? "שומר..." : "שמור הערה"}
                </Button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {data.notes.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">אין הערות</p>
                )}
                {data.notes.map((n: any) => (
                  <div key={n.id} className="text-xs p-2 rounded bg-muted">
                    <div className="text-muted-foreground mb-1">
                      {n.operators?.full_name ?? "מנהל"} · {new Date(n.created_at).toLocaleString("he-IL")}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{n.note}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Info className="h-4 w-4" /> מידע פנימי על הלקוח
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Textarea
                  value={customerInfoInput}
                  onChange={(e) => setCustomerInfoInput(e.target.value)}
                  placeholder="לדוגמה: רווק, עובד בהייטק, אוהב ספורט..."
                  rows={2}
                  maxLength={2000}
                  className="resize-none text-sm"
                />
                <Button
                  onClick={saveCustomerInfo}
                  disabled={savingCustomerInfo || !customerInfoInput.trim()}
                  size="sm"
                  className="w-full"
                >
                  {savingCustomerInfo ? "שומר..." : "שמור מידע"}
                </Button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {data.customerInfo.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">אין מידע פנימי עדיין</p>
                )}
                {data.customerInfo.map((entry: any) => (
                  <div key={entry.id} className="text-xs p-2 rounded bg-muted">
                    <div className="text-muted-foreground mb-1">
                      {entry.operators?.full_name ?? "מנהל"} · {new Date(entry.created_at).toLocaleString("he-IL")}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{entry.content}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {data.reports.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">דיווחים</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {data.reports.map((r: any) => (
                  <div key={r.id} className="text-xs p-2 rounded border">
                    <div className="flex justify-between mb-1">
                      <span className="font-medium">{r.reason}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString("he-IL")}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
