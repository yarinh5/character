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
import { ArrowRight, FileText, Info, Send } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useActiveConversation } from "@/lib/activeConversation";
import { ChatAvatar } from "@/components/common/ChatAvatar";
import {
  getOldestMessageCursor,
  isNearScrollBottom,
  mergeMessagesById,
  MESSAGE_PAGE_SIZE,
  sortMessagesAsc,
} from "@/lib/messagePagination";

export const Route = createFileRoute("/admin/conversations/$conversationId")({
  component: ConvView,
});

function isActiveConversationLock(lock: any) {
  return !!lock && !lock.released_at && new Date(lock.expires_at).getTime() > Date.now();
}

type AdminMessage = {
  id: string;
  content: string;
  sender_type: string;
  sender_id: string | null;
  operator_id: string | null;
  created_at: string;
  is_read: boolean;
  operators?: { full_name: string | null; user_id?: string | null } | null;
};

function ConvView() {
  const { conversationId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const [noteInput, setNoteInput] = useState("");
  const [customerInfoInput, setCustomerInfoInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingCustomerInfo, setSavingCustomerInfo] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [adminOperatorUserIds, setAdminOperatorUserIds] = useState<string[]>([]);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const initialScrollDoneRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const messageRequestVersionRef = useRef(0);
  useActiveConversation(conversationId, "admin");

  const loadLatestMessages = async (requestVersion: number) => {
    const { data: msgs, error } = await supabase
      .from("messages")
      .select("id, content, sender_type, sender_id, operator_id, created_at, is_read, operators(full_name, user_id)")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    if (error) throw error;

    const latestMessages = sortMessagesAsc((msgs ?? []) as AdminMessage[]);
    const operatorUserIds = [
      ...new Set(latestMessages.map((message) => message.operators?.user_id).filter(Boolean)),
    ] as string[];
    const { data: adminRoles } = operatorUserIds.length
      ? await supabase.from("user_roles").select("user_id").in("user_id", operatorUserIds).eq("role", "admin")
      : { data: [] as { user_id: string }[] };

    if (requestVersion !== messageRequestVersionRef.current) return;
    setMessages(latestMessages);
    setHasOlderMessages(latestMessages.length === MESSAGE_PAGE_SIZE);
    setAdminOperatorUserIds((adminRoles ?? []).map((role) => role.user_id));
  };

  const loadOlderMessages = async () => {
    if (loadingOlderRef.current || !hasOlderMessages) return;
    const container = scrollRef.current;
    const before = getOldestMessageCursor(messages);
    if (!before || !container) return;

    const requestVersion = messageRequestVersionRef.current;
    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    const previousHeight = container.scrollHeight;
    const previousTop = container.scrollTop;
    const { data, error } = await supabase
      .from("messages")
      .select("id, content, sender_type, sender_id, operator_id, created_at, is_read, operators(full_name, user_id)")
      .eq("conversation_id", conversationId)
      .or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);

    if (requestVersion !== messageRequestVersionRef.current) return;
    setLoadingOlderMessages(false);

    if (error) {
      loadingOlderRef.current = false;
      toast.error("טעינת הודעות ישנות נכשלה");
      return;
    }

    const olderMessages = sortMessagesAsc((data ?? []) as AdminMessage[]);
    setHasOlderMessages(olderMessages.length === MESSAGE_PAGE_SIZE);
    setMessages((prev) => mergeMessagesById(olderMessages, prev));
    window.requestAnimationFrame(() => {
      if (requestVersion !== messageRequestVersionRef.current) return;
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight - previousHeight + previousTop;
      }
      loadingOlderRef.current = false;
    });
  };

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
        { data: notes },
        { data: customerInfo },
        { data: reports },
        { data: charOps },
        { data: currentOperator },
        { data: settings },
        { data: lock },
      ] = await Promise.all([
          supabase.from("profiles").select("display_name, email, status, avatar_url").eq("user_id", conv.client_id).maybeSingle(),
          supabase.from("client_profiles").select("age, gender, interests").eq("user_id", conv.client_id).maybeSingle(),
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
                .select("id, full_name, is_active")
                .eq("user_id", user.id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          supabase
            .from("system_settings")
            .select("key, value")
            .in("key", ["concurrency_mode", "lock_timeout_minutes"]),
          supabase
            .from("conversation_locks")
            .select("conversation_id, locked_by_operator_id, locked_by_user_id, locked_at, last_activity_at, expires_at, released_at, release_reason, operators!conversation_locks_locked_by_operator_id_fkey(full_name)")
            .eq("conversation_id", conversationId)
            .maybeSingle(),
        ]);
      const assignments = charOps ?? [];
      const settingsMap = new Map((settings ?? []).map((setting) => [setting.key, setting.value]));
      const mode = settingsMap.get("concurrency_mode");
      const timeout = settingsMap.get("lock_timeout_minutes");
      return {
        conv,
        client,
        cprof,
        notes: notes ?? [],
        customerInfo: customerInfo ?? [],
        reports: reports ?? [],
        currentOperator,
        currentOperatorAssigned: Boolean(
          currentOperator?.id &&
            assignments.some((assignment: any) => assignment.operator_id === currentOperator.id && assignment.operators?.is_active),
        ),
        concurrencyMode: mode === "warning" || mode === "lock" ? mode : "open",
        lockTimeoutMinutes: typeof timeout === "number" ? timeout : 10,
        lock: lock ?? null,
        availableOps: (charOps ?? [])
          .map((a: any) => a.operators)
          .filter((o: any) => o && o.is_active),
      };
    },
  });

  useEffect(() => {
    const requestVersion = ++messageRequestVersionRef.current;
    initialScrollDoneRef.current = false;
    shouldStickToBottomRef.current = true;
    loadingOlderRef.current = false;
    setMessages([]);
    setAdminOperatorUserIds([]);
    setHasOlderMessages(false);
    setLoadingOlderMessages(false);
    loadLatestMessages(requestVersion).catch((error) => {
      if (requestVersion === messageRequestVersionRef.current) toast.error("טעינת הודעות נכשלה: " + error.message);
    });
    return () => {
      if (messageRequestVersionRef.current === requestVersion) {
        messageRequestVersionRef.current += 1;
      }
    };
  }, [conversationId]);

  useEffect(() => {
    if (!user?.id) return;
    supabase.rpc("mark_conversation_read", {
      _conversation_id: conversationId,
      _as: "admin",
    });
  }, [conversationId, user?.id]);

  useEffect(() => {
    const ch = supabase
      .channel(`admin-conv-${conversationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const requestVersion = messageRequestVersionRef.current;
          const nextMessage = payload.new as AdminMessage;
          shouldStickToBottomRef.current = isNearScrollBottom(scrollRef.current);
          if (payload.eventType === "UPDATE") {
            if (requestVersion !== messageRequestVersionRef.current) return;
            setMessages((prev) => prev.map((message) => (message.id === nextMessage.id ? { ...message, ...nextMessage } : message)));
            return;
          }
          if (payload.eventType === "INSERT" && nextMessage.sender_type === "client") {
            supabase.rpc("mark_conversation_read", {
              _conversation_id: conversationId,
              _as: "admin",
            });
          }
          if (nextMessage.operator_id) {
            supabase
              .from("operators")
              .select("full_name, user_id")
              .eq("id", nextMessage.operator_id)
              .maybeSingle()
              .then(async ({ data: operatorData }) => {
                if (requestVersion !== messageRequestVersionRef.current) return;
                if (operatorData?.user_id) {
                  const { data: adminRole } = await supabase
                    .from("user_roles")
                    .select("user_id")
                    .eq("user_id", operatorData.user_id)
                    .eq("role", "admin")
                    .maybeSingle();
                  if (requestVersion !== messageRequestVersionRef.current) return;
                  if (adminRole) {
                    setAdminOperatorUserIds((prev) =>
                      prev.includes(adminRole.user_id) ? prev : [...prev, adminRole.user_id],
                    );
                  }
                }
                const hydrated = {
                  ...nextMessage,
                  operators: operatorData
                    ? { full_name: operatorData.full_name, user_id: operatorData.user_id }
                    : null,
                };
                if (requestVersion !== messageRequestVersionRef.current) return;
                setMessages((prev) => mergeMessagesById(prev, [hydrated]));
              });
          } else {
            if (requestVersion !== messageRequestVersionRef.current) return;
            setMessages((prev) => mergeMessagesById(prev, [nextMessage]));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ["admin-conv", conversationId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_locks", filter: `conversation_id=eq.${conversationId}` },
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

  const sendMessage = async () => {
    const content = messageInput.trim();
    if (!content || sendingMessage || !data?.currentOperator?.id) return;
    if (content.length > 2000) {
      toast.error("ההודעה ארוכה מדי");
      return;
    }

    setSendingMessage(true);
    const { data: result, error } = await supabase.rpc("send_operator_message", {
      _conversation_id: conversationId,
      _content: content,
    });
    setSendingMessage(false);

    if (error) {
      if (error.message.includes("operator_record_required")) {
        toast.error("כדי לענות צריך רשומת עובד פעילה לאדמין הזה");
        return;
      }
      if (error.message.includes("operator_not_assigned_to_character")) {
        toast.error("האדמין לא משויך לדמות של השיחה");
        return;
      }
      if (error.message.includes("conversation_locked_by_other_operator")) {
        toast.error("השיחה נעולה כרגע לעובד אחר");
        return;
      }
      if (error.message.includes("conversation_closed")) {
        toast.error("השיחה סגורה. פתח אותה מחדש כדי לענות");
        return;
      }
      toast.error("שליחת ההודעה נכשלה");
      return;
    }

    const message = (result as { message?: any } | null)?.message;
    if (message) {
      shouldStickToBottomRef.current = true;
      setMessages((prev) =>
        mergeMessagesById(prev, [
          {
            ...message,
            operators: data.currentOperator
              ? { full_name: data.currentOperator.full_name, user_id: user?.id ?? null }
              : null,
          },
        ]),
      );
    }
    setMessageInput("");
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

  const activeLock = isActiveConversationLock(data.lock) ? data.lock : null;
  const lockHeldByOther =
    data.concurrencyMode === "lock" &&
    activeLock &&
    data.currentOperator?.id &&
    activeLock.locked_by_operator_id !== data.currentOperator.id;
  const canReply = Boolean(data.currentOperator?.id && data.currentOperator.is_active && data.currentOperatorAssigned);
  const composerDisabled = sendingMessage || Boolean(lockHeldByOther) || data.conv.status === "closed";
  const replyBlockedMessage = !data.currentOperator?.id
    ? "כדי לענות בשם הדמות, צריך ליצור לאדמין רשומת עובד פעילה ולשייך אותה לדמות הזו."
    : !data.currentOperator.is_active
      ? "רשומת העובד של האדמין לא פעילה. יש להפעיל אותה במסך העובדים."
      : !data.currentOperatorAssigned
        ? "האדמין לא משויך לדמות של השיחה, ולכן לא ניתן לענות מכאן."
        : "";

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
            <div
              ref={scrollRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                shouldStickToBottomRef.current = isNearScrollBottom(target);
                if (target.scrollTop < 80) void loadOlderMessages();
              }}
              className="h-[55vh] overflow-y-auto p-4 space-y-2 bg-background/50"
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
                <p className="text-sm text-center text-muted-foreground py-8">אין הודעות</p>
              )}
              {messages.map((m: any) => {
                const isClientMessage = m.sender_type === "client";
                return (
                <div
                  key={m.id}
                  className={`flex items-end gap-2 ${isClientMessage ? "justify-start" : "justify-end"}`}
                >
                  <ChatAvatar
                    src={isClientMessage ? data.client?.avatar_url : data.conv.characters?.avatar_url}
                    name={isClientMessage ? data.client?.display_name ?? data.client?.email : data.conv.characters?.name}
                  />
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                      isClientMessage
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
                          ? `${adminOperatorUserIds.includes(m.operators?.user_id) ? "מנהל" : "עובד"}: ${m.operators?.full_name ?? "לא ידוע"}${m.operator_id ? ` · ${String(m.operator_id).slice(0, 8)}` : ""}`
                          : "אדמין"}
                    </div>
                    <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
                    <div className="text-[10px] opacity-60 mt-1">
                      {new Date(m.created_at).toLocaleTimeString("he-IL")}
                      {m.sender_type !== "client" && (
                        <span className="ms-2">{m.is_read ? "נראה" : "נשלח"}</span>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
            <div className="border-t bg-card p-3">
              {canReply ? (
                data.conv.status === "closed" ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    השיחה סגורה. פתח אותה מחדש כדי לענות בשם הדמות.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {lockHeldByOther && (
                      <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                        השיחה נעולה כרגע ל{activeLock?.operators?.full_name ?? "עובד אחר"}. Lock Mode נאכף גם על אדמין.
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <Textarea
                        value={messageInput}
                        onChange={(event) => setMessageInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void sendMessage();
                          }
                        }}
                        placeholder={`כתוב בשם ${data.conv.characters?.name ?? "הדמות"}...`}
                        rows={1}
                        maxLength={2000}
                        className="min-h-10 max-h-32 resize-none"
                        disabled={composerDisabled}
                      />
                      <Button
                        size="icon"
                        onClick={sendMessage}
                        disabled={composerDisabled || !messageInput.trim()}
                        title="שליחת הודעה"
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span>ההודעה תישלח דרך מנגנון עובד ותישמר עם operator_id.</span>
                      <span dir="ltr">{messageInput.length}/2000</span>
                    </div>
                  </div>
                )
              ) : (
                <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <p>{replyBlockedMessage}</p>
                  <Button asChild variant="link" size="sm" className="mt-1 h-auto p-0">
                    <Link to="/admin/operators">ניהול עובדים ושיוכים</Link>
                  </Button>
                </div>
              )}
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
