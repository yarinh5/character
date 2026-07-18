import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActiveConversation } from "@/lib/activeConversation";
import { useConversationPresence } from "@/lib/conversationPresence";
import { fetchReadSummary, type ReadSummary } from "@/lib/readStates";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import {
  getOldestMessageCursor,
  isNearScrollBottom,
  mergeMessagesById,
  MESSAGE_PAGE_SIZE,
  sortMessagesAsc,
} from "@/lib/messagePagination";
import { ChatAvatar } from "@/components/common/ChatAvatar";
import { MessageAttachment, type ChatMessageAttachment } from "@/components/chat/MessageAttachment";
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
import { ArrowRight, Send, Flag, Trash2 } from "lucide-react";
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
  is_read: boolean;
  message_attachments?: MessageAttachmentData[];
};

type MessageAttachmentData = ChatMessageAttachment;

type Conv = {
  id: string;
  client_id: string;
  status: string;
  client_hidden_at: string | null;
  characters: {
    id: string;
    name: string;
    avatar_url: string | null;
    availability_status: string;
  } | null;
};

type SendClientMessageResponse = {
  message?: Msg;
  balance?: number;
  credits_enabled?: boolean;
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
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [clientAvatarUrl, setClientAvatarUrl] = useState<string | null>(null);
  const [clientDisplayName, setClientDisplayName] = useState<string | null>(null);
  const [readSummary, setReadSummary] = useState<ReadSummary | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  useActiveConversation(conversationId, "client");
  const { activeUsers, typingUsers, startTyping, stopTyping } = useConversationPresence({
    conversationId,
    userId: user?.id,
    role: "client",
    displayName: user?.email?.split("@")[0] ?? "לקוח",
  });

  const hydrateMessageAttachments = async (message: Msg) => {
    const { data } = await supabase
      .from("message_attachments")
      .select("id, message_id, kind, position, caption, metadata, created_at")
      .eq("message_id", message.id)
      .order("position", { ascending: true });

    return { ...message, message_attachments: (data ?? []) as MessageAttachmentData[] };
  };

  const loadOlderMessages = async () => {
    if (loadingOlderRef.current || !hasOlderMessages) return;
    const container = scrollRef.current;
    const before = getOldestMessageCursor(messages);
    if (!before || !container) return;

    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    const previousHeight = container.scrollHeight;
    const previousTop = container.scrollTop;
    const { data, error } = await supabase
      .from("messages")
      .select("*, message_attachments(id, message_id, kind, position, caption, metadata, created_at)")
      .eq("conversation_id", conversationId)
      .or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    setLoadingOlderMessages(false);

    if (error) {
      loadingOlderRef.current = false;
      toast.error("טעינת הודעות ישנות נכשלה");
      return;
    }

    const olderMessages = sortMessagesAsc((data ?? []) as Msg[]);
    setHasOlderMessages(olderMessages.length === MESSAGE_PAGE_SIZE);
    setMessages((prev) => mergeMessagesById(olderMessages, prev));
    window.requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight - previousHeight + previousTop;
      }
      loadingOlderRef.current = false;
    });
  };

  // Load conversation + latest messages
  useEffect(() => {
    let cancelled = false;
    initialScrollDoneRef.current = false;
    shouldStickToBottomRef.current = true;
    (async () => {
      setLoading(true);
      const [{ data: c, error: ce }, { data: m, error: me }, { data: wallet }, { data: profile }] = await Promise.all([
        supabase
          .from("conversations")
          .select("id, client_id, status, client_hidden_at, characters(id, name, avatar_url, availability_status)")
          .eq("id", conversationId)
          .maybeSingle(),
        supabase
          .from("messages")
          .select("*, message_attachments(id, message_id, kind, position, caption, metadata, created_at)")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MESSAGE_PAGE_SIZE),
        supabase.from("credit_wallets").select("balance").maybeSingle(),
        supabase.from("profiles").select("display_name, avatar_url").eq("user_id", user?.id ?? "").maybeSingle(),
      ]);
      if (cancelled) return;
      if (ce || !c || c.client_hidden_at) {
        toast.error("שיחה לא נמצאה");
        navigate({ to: "/app/conversations" });
        return;
      }
      if (me) toast.error("שגיאה בטעינת הודעות");
      setConv(c as unknown as Conv);
      const latestMessages = sortMessagesAsc((m ?? []) as Msg[]);
      setMessages(latestMessages);
      setHasOlderMessages(latestMessages.length === MESSAGE_PAGE_SIZE);
      setCreditBalance(wallet?.balance ?? null);
      setClientAvatarUrl(profile?.avatar_url ?? null);
      setClientDisplayName(profile?.display_name ?? user?.email ?? null);
      setLoading(false);
      // mark read
      await supabase.rpc("mark_conversation_read", {
        _conversation_id: conversationId,
        _as: "client",
      });
      fetchReadSummary(conversationId).then(setReadSummary).catch(() => undefined);
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
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMsg = payload.new as Msg;
          shouldStickToBottomRef.current = isNearScrollBottom(scrollRef.current);
          setMessages((prev) => {
            if (payload.eventType === "UPDATE") {
              return prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m));
            }
            return mergeMessagesById(prev, [newMsg]);
          });
          if (payload.eventType !== "UPDATE") {
            void hydrateMessageAttachments(newMsg).then((hydrated) => {
              setMessages((prev) => mergeMessagesById(prev, [hydrated]));
            });
          }
          if (newMsg.sender_type !== "client") {
            supabase.rpc("mark_conversation_read", {
              _conversation_id: conversationId,
              _as: "client",
            });
          }
          fetchReadSummary(conversationId).then(setReadSummary).catch(() => undefined);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Auto-scroll only on initial load or when the user is already at the bottom.
  useEffect(() => {
    if (!scrollRef.current || loadingOlderRef.current) return;
    if (!initialScrollDoneRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
      initialScrollDoneRef.current = true;
      return;
    }
    if (shouldStickToBottomRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);

  const send = async () => {
    const content = input.trim();
    if (!content || !user || sending) return;
    if (content.length > 2000) {
      toast.error("הודעה ארוכה מדי (מקסימום 2000 תווים)");
      return;
    }
    stopTyping();
    setSending(true);
    const { data, error } = await supabase.rpc("send_client_message", {
      _conversation_id: conversationId,
      _content: content,
    });
    setSending(false);
    if (error) {
      if (error.message.includes("insufficient_credits")) {
        void trackAnalyticsEvent({
          eventName: "insufficient_credits_shown",
          conversationId,
          characterId: conv?.characters?.id ?? null,
          metadata: { source: "client_chat_send" },
          dedupeSeconds: 300,
        });
        toast.error("נגמרו לך הקרדיטים. אפשר להמשיך לקרוא את השיחה, אבל כדי לשלוח הודעה צריך להטעין קרדיטים.", {
          action: {
            label: "לחבילות",
            onClick: () => navigate({ to: "/app/packages" }),
          },
        });
        return;
      }
      toast.error("שליחה נכשלה");
      return;
    }
    const result = data as SendClientMessageResponse | null;
    if (typeof result?.balance === "number") setCreditBalance(result.balance);
    if (result?.message) {
      shouldStickToBottomRef.current = true;
      setMessages((prev) => mergeMessagesById(prev, [result.message!]));
    }
    setInput("");
  };

  const deleteConversation = async () => {
    if (!user || deleting) return;

    setDeleting(true);
    const { error } = await supabase.rpc("hide_conversation_for_client", {
      _conversation_id: conversationId,
    });
    setDeleting(false);

    if (error) {
      toast.error("מחיקת השיחה נכשלה");
      return;
    }

    setDeleteOpen(false);
    toast.success("השיחה נמחקה מהרשימה שלך");
    navigate({ to: "/app/conversations" });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  const character = conv?.characters;
  const characterActive = activeUsers.some((presence) => presence.role === "operator" || presence.role === "admin");
  const characterTyping = typingUsers.some((presence) => presence.role === "operator" || presence.role === "admin");
  const operatorLastReadAt = readSummary?.operator_last_read_at
    ? new Date(readSummary.operator_last_read_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex flex-col h-[calc(100dvh-5rem)] md:h-screen bg-background" dir="rtl">
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
            {characterActive
              ? "פעיל/ה עכשיו"
              : character?.availability_status === "available"
                ? "זמין/ה"
                : "לא זמין/ה כעת"}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setReportOpen(true)}>
          <Flag className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="h-5 w-5" />
        </Button>
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          shouldStickToBottomRef.current = isNearScrollBottom(target);
          if (target.scrollTop < 80) void loadOlderMessages();
        }}
        className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-3"
      >
        {hasOlderMessages && (
          <div className="flex justify-center py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadOlderMessages()}
              disabled={loadingOlderMessages}
              className="text-xs"
            >
              {loadingOlderMessages ? "טוען הודעות ישנות..." : "טען הודעות ישנות"}
            </Button>
          </div>
        )}
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
          const avatarUrl = mine ? clientAvatarUrl : character?.avatar_url;
          const avatarName = mine ? clientDisplayName : character?.name;
          const hasAttachments = (m.message_attachments?.length ?? 0) > 0;
          const showContent = m.content !== "[image]" || !hasAttachments;
          return (
            <div key={m.id} className={`flex items-end gap-2 ${mine ? "justify-start" : "justify-end"}`}>
              <ChatAvatar src={avatarUrl} name={avatarName} />
              <div
                className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2 ${
                  mine
                    ? "bg-primary text-primary-foreground rounded-bl-sm"
                    : "bg-card border border-border rounded-br-sm"
                }`}
              >
                {showContent && <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>}
                {m.message_attachments?.map((attachment) => (
                  <MessageAttachment key={attachment.id} attachment={attachment} />
                ))}
                <p className={`text-[10px] mt-1 ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                  {new Date(m.created_at).toLocaleTimeString("he-IL", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {mine && (
                    <span className="ms-2">
                      {m.is_read ? "נראה" : "נשלח"}
                    </span>
                  )}
                </p>
              </div>
            </div>
          );
        })}
        {operatorLastReadAt && (
          <div className="text-center text-[11px] text-muted-foreground">
            נראה לאחרונה {operatorLastReadAt}
          </div>
        )}
        {characterTyping && (
          <div className="flex justify-end">
            <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
              הדמות מקלידה...
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-card p-3 shrink-0">
        {creditBalance !== null && (
          <p className="text-xs text-muted-foreground mb-2 text-end">יתרת קרדיטים: {creditBalance}</p>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.value.trim()) startTyping();
              else stopTyping();
            }}
            onBlur={stopTyping}
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
      <DeleteConversationDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={deleteConversation}
        deleting={deleting}
      />
    </div>
  );
}

function DeleteConversationDialog({
  open,
  onOpenChange,
  onConfirm,
  deleting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>מחיקת שיחה מהרשימה</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground leading-6">
          השיחה תוסתר רק אצלך. העובדים והאדמין עדיין יראו את ההיסטוריה, ואם תפתח שוב את אותה דמות תיווצר שיחה חדשה.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            ביטול
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting ? "מוחק..." : "מחק שיחה"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
