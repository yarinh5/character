import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ArrowRight, Send, Flag } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/chat/$conversationId")({
  component: ChatPage,
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
  characters: {
    id: string;
    name: string;
    avatar_url: string | null;
    availability_status: string;
  } | null;
};

function ChatPage() {
  const { conversationId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load conversation + messages
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: c, error: ce }, { data: m, error: me }] = await Promise.all([
        supabase
          .from("conversations")
          .select("id, client_id, status, characters(id, name, avatar_url, availability_status)")
          .eq("id", conversationId)
          .maybeSingle(),
        supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true }),
      ]);
      if (cancelled) return;
      if (ce || !c) {
        toast.error("שיחה לא נמצאה");
        navigate({ to: "/app/conversations" });
        return;
      }
      if (me) toast.error("שגיאה בטעינת הודעות");
      setConv(c as unknown as Conv);
      setMessages((m ?? []) as Msg[]);
      setLoading(false);
      // mark read
      await supabase.rpc("mark_conversation_read", {
        _conversation_id: conversationId,
        _as: "client",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`chat-${conversationId}`)
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
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
          if (newMsg.sender_type !== "client") {
            supabase.rpc("mark_conversation_read", {
              _conversation_id: conversationId,
              _as: "client",
            });
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const content = input.trim();
    if (!content || !user || sending) return;
    if (content.length > 2000) {
      toast.error("הודעה ארוכה מדי (מקסימום 2000 תווים)");
      return;
    }
    setSending(true);
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      sender_type: "client",
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  const character = conv?.characters;

  return (
    <div className="flex flex-col h-screen bg-background" dir="rtl">
      {/* Header */}
      <header className="h-16 px-4 flex items-center gap-3 border-b border-border bg-card shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/app/conversations" })}>
          <ArrowRight className="h-5 w-5" />
        </Button>
        <div className="h-10 w-10 rounded-full bg-muted overflow-hidden shrink-0">
          {character?.avatar_url ? (
            <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center font-semibold">
              {character?.name?.[0] ?? "?"}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold truncate">{character?.name ?? "—"}</h2>
          <p className="text-xs text-muted-foreground">
            {character?.availability_status === "available" ? "זמין/ה" : "לא זמין/ה כעת"}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setReportOpen(true)}>
          <Flag className="h-5 w-5" />
        </Button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground py-8 text-sm">
            פתח את השיחה — שלח הודעה ראשונה
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_type === "client";
          const system = m.sender_type === "system";
          if (system) {
            return (
              <div key={m.id} className="text-center">
                <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                  {m.content}
                </span>
              </div>
            );
          }
          return (
            <div key={m.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                  mine
                    ? "bg-primary text-primary-foreground rounded-bl-sm"
                    : "bg-card border border-border rounded-br-sm"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                <p className={`text-[10px] mt-1 ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
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

      {/* Composer */}
      <div className="border-t border-border bg-card p-3 shrink-0">
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
            placeholder="הקלד הודעה..."
            rows={1}
            maxLength={2000}
            className="resize-none min-h-[40px] max-h-32"
          />
          <Button onClick={send} disabled={sending || !input.trim()} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 text-end">
          {input.length}/2000
        </p>
      </div>

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        conversationId={conversationId}
        userId={user?.id}
      />
    </div>
  );
}

function ReportDialog({
  open,
  onOpenChange,
  conversationId,
  userId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversationId: string;
  userId: string | undefined;
}) {
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!userId || !reason.trim()) {
      toast.error("יש לציין סיבה");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("reports").insert({
      reporter_id: userId,
      conversation_id: conversationId,
      reason: reason.trim().slice(0, 200),
      details: details.trim().slice(0, 1000) || null,
    });
    setSubmitting(false);
    if (error) {
      toast.error("שליחת הדיווח נכשלה");
      return;
    }
    toast.success("הדיווח נשלח, נבדוק בהקדם");
    setReason("");
    setDetails("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>דיווח על שיחה</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">סיבה</label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="למשל: תוכן פוגעני"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">פירוט (אופציונלי)</label>
            <Textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={1000}
              rows={4}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            ביטול
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "שולח..." : "שלח דיווח"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
