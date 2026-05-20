import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useOperator, ConversationStatusBadge } from "@/components/operator/OperatorLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ArrowRight, Send, User, FileText, Lock, Unlock } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/operator/chat/$conversationId")({
  component: OperatorChatPage,
});

type Msg = {
  id: string;
  conversation_id: string;
  sender_type: "client" | "operator" | "admin" | "system";
  sender_id: string | null;
  content: string;
  created_at: string;
};

type Conv = {
  id: string;
  client_id: string;
  status: string;
  assigned_operator_id: string | null;
  characters: { id: string; name: string; avatar_url: string | null; availability_status: string } | null;
};

type ClientInfo = {
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
  age: number | null;
  interests: string[] | null;
  conversation_preferences: string | null;
  totalConversations: number;
};

type Note = {
  id: string;
  note: string;
  created_at: string;
  operator_id: string | null;
  operators?: { full_name: string } | null;
};

function OperatorChatPage() {
  const { conversationId } = Route.useParams();
  const { user } = useAuth();
  const { operator, isAdmin } = useOperator();
  const navigate = useNavigate();

  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [input, setInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [sending, setSending] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load conversation, messages, notes, client info
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: c, error: ce } = await supabase
        .from("conversations")
        .select("id, client_id, status, assigned_operator_id, characters(id, name, avatar_url, availability_status)")
        .eq("id", conversationId)
        .maybeSingle();
      if (cancelled) return;
      if (ce || !c) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      // additional safety: operator can only access own
      if (!isAdmin && operator && c.assigned_operator_id !== operator.id) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      setConv(c as unknown as Conv);

      const [{ data: m }, { data: n }, { data: prof }, { data: cp }, { count }] = await Promise.all([
        supabase.from("messages").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
        supabase
          .from("internal_notes")
          .select("id, note, created_at, operator_id, operators(full_name)")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false }),
        supabase
          .from("profiles")
          .select("display_name, email, avatar_url, created_at")
          .eq("user_id", c.client_id)
          .maybeSingle(),
        supabase
          .from("client_profiles")
          .select("age, interests, conversation_preferences")
          .eq("user_id", c.client_id)
          .maybeSingle(),
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("client_id", c.client_id),
      ]);
      if (cancelled) return;
      setMessages((m ?? []) as Msg[]);
      setNotes((n ?? []) as unknown as Note[]);
      setClient({
        display_name: prof?.display_name ?? null,
        email: prof?.email ?? null,
        avatar_url: prof?.avatar_url ?? null,
        created_at: prof?.created_at ?? "",
        age: cp?.age ?? null,
        interests: cp?.interests ?? null,
        conversation_preferences: cp?.conversation_preferences ?? null,
        totalConversations: count ?? 0,
      });
      setLoading(false);

      await supabase.rpc("mark_conversation_read", {
        _conversation_id: conversationId,
        _as: "operator",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, operator, isAdmin]);

  // Realtime
  useEffect(() => {
    const ch = supabase
      .channel(`op-chat-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMsg = payload.new as Msg;
          setMessages((prev) => (prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg]));
          if (newMsg.sender_type === "client") {
            supabase.rpc("mark_conversation_read", {
              _conversation_id: conversationId,
              _as: "operator",
            });
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "internal_notes",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async () => {
          const { data } = await supabase
            .from("internal_notes")
            .select("id, note, created_at, operator_id, operators(full_name)")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false });
          setNotes((data ?? []) as unknown as Note[]);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const content = input.trim();
    if (!content || !user || sending) return;
    if (conv?.status === "closed") {
      toast.error("השיחה סגורה. פתח אותה מחדש כדי לשלוח הודעה.");
      return;
    }
    if (content.length > 2000) {
      toast.error("הודעה ארוכה מדי");
      return;
    }
    setSending(true);
    const sender_type = isAdmin && !operator ? "admin" : "operator";
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      sender_type,
      sender_id: user.id,
      content,
    });
    setSending(false);
    if (error) {
      toast.error("שליחה נכשלה");
      return;
    }
    setInput("");
  };

  const saveNote = async () => {
    const text = noteInput.trim();
    if (!text || !operator || savingNote) return;
    setSavingNote(true);
    const { error } = await supabase.from("internal_notes").insert({
      conversation_id: conversationId,
      operator_id: operator.id,
      note: text.slice(0, 2000),
    });
    setSavingNote(false);
    if (error) {
      toast.error("שמירת הערה נכשלה");
      return;
    }
    setNoteInput("");
    toast.success("הערה נשמרה");
  };

  const updateStatus = async (status: "open" | "waiting" | "answered" | "closed") => {
    if (!conv) return;
    const { error } = await supabase.from("conversations").update({ status }).eq("id", conversationId);
    if (error) {
      toast.error("עדכון סטטוס נכשל");
      return;
    }
    setConv({ ...conv, status });
    toast.success("הסטטוס עודכן");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4" dir="rtl">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-bold mb-2">אין הרשאה</h2>
          <p className="text-muted-foreground mb-4">השיחה לא קיימת או שאין לך גישה אליה.</p>
          <Button onClick={() => navigate({ to: "/operator/conversations" })}>חזרה לרשימה</Button>
        </div>
      </div>
    );
  }

  const character = conv?.characters;
  const closed = conv?.status === "closed";

  return (
    <div className="flex flex-col h-screen bg-background" dir="rtl">
      {/* Header */}
      <header className="h-16 px-4 flex items-center gap-3 border-b border-border bg-card shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/operator/conversations" })}>
          <ArrowRight className="h-5 w-5" />
        </Button>
        <div className="h-10 w-10 rounded-full bg-muted overflow-hidden shrink-0">
          {character?.avatar_url ? (
            <img src={character.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center font-semibold">
              {character?.name?.[0] ?? "?"}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold truncate">{character?.name ?? "—"}</h2>
            <ConversationStatusBadge status={conv?.status ?? "open"} />
          </div>
          <p className="text-xs text-muted-foreground truncate">
            עם {client?.display_name ?? "לקוח"}
          </p>
        </div>
        <div className="hidden md:flex gap-1">
          {closed ? (
            <Button variant="outline" size="sm" onClick={() => updateStatus("open")}>
              <Unlock className="h-4 w-4" />
              פתח מחדש
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => updateStatus("closed")}>
              <Lock className="h-4 w-4" />
              סגור
            </Button>
          )}
        </div>
        <div className="md:hidden flex gap-1">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <User className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
              <SheetHeader>
                <SheetTitle>פרטי לקוח והערות</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4">
                <ClientInfoPanel client={client} />
                <InternalNotesPanel
                  notes={notes}
                  noteInput={noteInput}
                  setNoteInput={setNoteInput}
                  saveNote={saveNote}
                  savingNote={savingNote}
                  canEdit={!!operator}
                />
                <StatusActions status={conv?.status ?? "open"} updateStatus={updateStatus} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Messages */}
        <div className="flex-1 flex flex-col min-w-0">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground py-8 text-sm">אין הודעות עדיין</div>
            )}
            {messages.map((m) => {
              if (m.sender_type === "system") {
                return (
                  <div key={m.id} className="text-center">
                    <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                      {m.content}
                    </span>
                  </div>
                );
              }
              const isOps = m.sender_type === "operator" || m.sender_type === "admin";
              return (
                <div key={m.id} className={`flex ${isOps ? "justify-start" : "justify-end"}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                      isOps
                        ? "bg-primary text-primary-foreground rounded-bl-sm"
                        : "bg-card border border-border rounded-br-sm"
                    }`}
                  >
                    {m.sender_type === "admin" && (
                      <p className="text-[10px] mb-0.5 opacity-70">הודעת מנהל</p>
                    )}
                    <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                    <p className={`text-[10px] mt-1 ${isOps ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {new Date(m.created_at).toLocaleTimeString("he-IL", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-border bg-card p-3 shrink-0">
            {closed ? (
              <div className="flex items-center justify-between gap-2 px-2 py-3 bg-muted rounded-md">
                <span className="text-sm text-muted-foreground">השיחה סגורה</span>
                <Button size="sm" onClick={() => updateStatus("open")}>
                  פתח מחדש
                </Button>
              </div>
            ) : (
              <>
                <div className="flex gap-2 items-end">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={`כתוב כ${character?.name ?? "דמות"}...`}
                    rows={1}
                    maxLength={2000}
                    className="resize-none min-h-[40px] max-h-32"
                  />
                  <Button onClick={send} disabled={sending || !input.trim()} size="icon">
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1 text-end">{input.length}/2000</p>
              </>
            )}
          </div>
        </div>

        {/* Side panel desktop */}
        <aside className="hidden md:flex w-80 shrink-0 flex-col border-r border-border bg-card overflow-y-auto">
          <div className="p-4 space-y-4">
            <ClientInfoPanel client={client} />
            <InternalNotesPanel
              notes={notes}
              noteInput={noteInput}
              setNoteInput={setNoteInput}
              saveNote={saveNote}
              savingNote={savingNote}
              canEdit={!!operator}
            />
            <StatusActions status={conv?.status ?? "open"} updateStatus={updateStatus} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function ClientInfoPanel({ client }: { client: ClientInfo | null }) {
  if (!client) return null;
  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-3 flex items-center gap-2">
        <User className="h-4 w-4" /> פרטי לקוח
      </h3>
      <div className="space-y-2 text-sm">
        <Row label="שם" value={client.display_name ?? "—"} />
        <Row label="אימייל" value={client.email ?? "—"} />
        <Row label="גיל" value={client.age ? String(client.age) : "—"} />
        <Row
          label="הצטרף"
          value={client.created_at ? new Date(client.created_at).toLocaleDateString("he-IL") : "—"}
        />
        <Row label="סך שיחות" value={String(client.totalConversations)} />
        {client.interests && client.interests.length > 0 && (
          <div>
            <div className="text-muted-foreground text-xs mb-1">תחומי עניין</div>
            <div className="flex flex-wrap gap-1">
              {client.interests.map((i) => (
                <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-accent">
                  {i}
                </span>
              ))}
            </div>
          </div>
        )}
        {client.conversation_preferences && (
          <div>
            <div className="text-muted-foreground text-xs mb-1">העדפות שיחה</div>
            <p className="text-xs">{client.conversation_preferences}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-xs font-medium truncate max-w-[60%] text-end">{value}</span>
    </div>
  );
}

function InternalNotesPanel({
  notes,
  noteInput,
  setNoteInput,
  saveNote,
  savingNote,
  canEdit,
}: {
  notes: Note[];
  noteInput: string;
  setNoteInput: (s: string) => void;
  saveNote: () => Promise<void>;
  savingNote: boolean;
  canEdit: boolean;
}) {
  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-3 flex items-center gap-2">
        <FileText className="h-4 w-4" /> הערות פנימיות
      </h3>
      {canEdit && (
        <div className="space-y-2 mb-3">
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
      )}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {notes.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">אין הערות</p>}
        {notes.map((n) => (
          <div key={n.id} className="text-xs p-2 rounded bg-muted">
            <p className="whitespace-pre-wrap break-words">{n.note}</p>
            <p className="text-muted-foreground mt-1 text-[10px]">
              {n.operators?.full_name ?? "עובד"} ·{" "}
              {new Date(n.created_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StatusActions({
  status,
  updateStatus,
}: {
  status: string;
  updateStatus: (s: "open" | "waiting" | "answered" | "closed") => Promise<void>;
}) {
  const opts: Array<{ value: "open" | "waiting" | "answered" | "closed"; label: string }> = [
    { value: "open", label: "פתוחה" },
    { value: "waiting", label: "ממתינה" },
    { value: "answered", label: "נענתה" },
    { value: "closed", label: "סגורה" },
  ];
  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-3 text-sm">שינוי סטטוס</h3>
      <div className="grid grid-cols-2 gap-2">
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => updateStatus(o.value)}
            className={`px-2 py-1.5 rounded text-xs border ${
              status === o.value ? "bg-primary text-primary-foreground border-primary" : "border-input hover:bg-accent"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Card>
  );
}
