import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActiveConversation } from "@/lib/activeConversation";
import { useConversationPresence } from "@/lib/conversationPresence";
import {
  getOldestMessageCursor,
  isNearScrollBottom,
  mergeMessagesById,
  MESSAGE_PAGE_SIZE,
  sortMessagesAsc,
} from "@/lib/messagePagination";
import { useOperator, ConversationStatusBadge } from "@/components/operator/OperatorLayout";
import { OperatorMediaPicker } from "@/components/operator/OperatorMediaPicker";
import { OperatorNewQueuePanel } from "@/components/operator/OperatorNewQueueList";
import { ChatAvatar } from "@/components/common/ChatAvatar";
import { MessageAttachment, type ChatMessageAttachment } from "@/components/chat/MessageAttachment";
import { MessageSticker, StickerHydrationPlaceholder, type ChatMessageSticker } from "@/components/chat/MessageSticker";
import { StickerPicker } from "@/components/chat/StickerPicker";
import type { StickerSendResult } from "@/hooks/useStickerSend";
import { useMessageAttachmentAccessMap } from "@/hooks/useMessageAttachmentAccessMap";
import { operatorNewQueueClaimError, useOperatorNewQueue, type OperatorNewQueueItem } from "@/hooks/useOperatorNewQueue";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowRight, Send, User, FileText, Lock, Unlock, Info, ImagePlus, Smile, RotateCcw, Inbox } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/operator/chat/$conversationId")({
  component: OperatorChatPage,
});

type Msg = {
  id: string;
  conversation_id: string;
  sender_type: "client" | "operator" | "admin" | "system";
  sender_id: string | null;
  operator_id: string | null;
  content: string;
  created_at: string;
  is_read: boolean;
  operators?: { full_name: string; user_id?: string | null } | null;
  message_attachments?: MessageAttachmentData[];
  message_stickers?: MessageStickerData | null;
};

type MessageAttachmentData = ChatMessageAttachment;
type MessageStickerData = ChatMessageSticker;

type Conv = {
  id: string;
  client_id: string;
  character_id: string;
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

type CustomerInfoEntry = {
  id: string;
  content: string;
  created_at: string;
  operator_id: string;
  created_by_user_id: string;
  operators?: { full_name: string } | null;
};

type ConcurrencyMode = "open" | "warning" | "lock";

type ConversationLock = {
  conversation_id: string;
  locked_by_operator_id: string;
  locked_by_user_id: string;
  locked_at: string;
  last_activity_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
  operators?: { full_name: string } | null;
};

function isActiveLock(lock: ConversationLock | null) {
  return !!lock && !lock.released_at && new Date(lock.expires_at).getTime() > Date.now();
}

function OperatorChatPage() {
  const { conversationId } = Route.useParams();
  const { user } = useAuth();
  const { operator, isAdmin } = useOperator();
  const navigate = useNavigate();

  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [adminOperatorUserIds, setAdminOperatorUserIds] = useState<string[]>([]);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [customerInfoEntries, setCustomerInfoEntries] = useState<CustomerInfoEntry[]>([]);
  const [input, setInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [customerInfoInput, setCustomerInfoInput] = useState("");
  const [sending, setSending] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [newQueueSheetOpen, setNewQueueSheetOpen] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingCustomerInfo, setSavingCustomerInfo] = useState(false);
  const [concurrencyMode, setConcurrencyMode] = useState<ConcurrencyMode>("open");
  const [lockTimeoutMinutes, setLockTimeoutMinutes] = useState(10);
  const [conversationLock, setConversationLock] = useState<ConversationLock | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [releasingConversation, setReleasingConversation] = useState(false);
  const [, setLockClock] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const newQueue = useOperatorNewQueue(operator?.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const attachmentIds = useMemo(
    () =>
      [...new Set(messages.flatMap((message) => message.message_attachments ?? []).filter((attachment) => attachment.kind === "image").map((attachment) => attachment.id))].sort(),
    [messages],
  );
  const attachmentAccess = useMessageAttachmentAccessMap(attachmentIds);
  useActiveConversation(conversationId, isAdmin ? "admin" : "operator");
  const { activeUsers, typingUsers, startTyping, stopTyping } = useConversationPresence({
    conversationId,
    userId: user?.id,
    role: isAdmin ? "admin" : "operator",
    displayName: operator?.full_name ?? (isAdmin ? "מנהל" : "עובד"),
  });

  const hydrateMessageDecorations = async (message: Msg) => {
    const [{ data: attachments }, { data: stickers }] = await Promise.all([
      supabase
        .from("message_attachments")
        .select("id, message_id, kind, position, caption, metadata, created_at")
        .eq("message_id", message.id)
        .order("position", { ascending: true }),
      supabase
        .from("message_stickers")
        .select("id, message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, created_at")
        .eq("message_id", message.id),
    ]);

    return {
      ...message,
      message_attachments: (attachments ?? []) as MessageAttachmentData[],
      message_stickers: (stickers?.[0] ?? null) as MessageStickerData | null,
    };
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
      .select("*, operators(full_name, user_id), message_attachments(id, message_id, kind, position, caption, metadata, created_at), message_stickers(id, message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, created_at)")
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

  // Load conversation, latest messages, notes, client info
  useEffect(() => {
    let cancelled = false;
    initialScrollDoneRef.current = false;
    shouldStickToBottomRef.current = true;
    (async () => {
      setLoading(true);
      const { data: c, error: ce } = await supabase
        .from("conversations")
        .select("id, client_id, character_id, status, assigned_operator_id, characters(id, name, avatar_url, availability_status)")
        .eq("id", conversationId)
        .maybeSingle();
      if (cancelled) return;
      if (ce || !c) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      if (!isAdmin) {
        if (!operator) {
          setForbidden(true);
          setLoading(false);
          return;
        }
        const { data: assignment } = await supabase
          .from("character_operator_assignments")
          .select("id")
          .eq("operator_id", operator.id)
          .eq("character_id", c.character_id)
          .maybeSingle();
        if (!assignment) {
          setForbidden(true);
          setLoading(false);
          return;
        }
      }
      setConv(c as unknown as Conv);

      await (supabase as any).rpc("cleanup_expired_conversation_locks");

      const [
        { data: m },
        { data: n },
        { data: info },
        { data: prof },
        { data: cp },
        { count },
        { data: settings },
        { data: lock },
      ] = await Promise.all([
        supabase
          .from("messages")
          .select("*, operators(full_name, user_id), message_attachments(id, message_id, kind, position, caption, metadata, created_at), message_stickers(id, message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, created_at)")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MESSAGE_PAGE_SIZE),
        supabase
          .from("internal_notes")
          .select("id, note, created_at, operator_id, operators(full_name)")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false }),
        supabase
          .from("customer_info_entries")
          .select("id, content, created_at, operator_id, created_by_user_id, operators(full_name)")
          .eq("client_id", c.client_id)
          .order("created_at", { ascending: false }),
        supabase
          .from("profiles")
          .select("display_name, email, avatar_url, created_at")
          .eq("user_id", c.client_id)
          .maybeSingle(),
        supabase
          .rpc("get_operator_conversation_client_profile", { _conversation_id: c.id })
          .maybeSingle(),
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("client_id", c.client_id),
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
      if (cancelled) return;
      const loadedMessages = sortMessagesAsc((m ?? []) as Msg[]);
      const operatorUserIds = [
        ...new Set(loadedMessages.map((message) => message.operators?.user_id).filter(Boolean)),
      ] as string[];
      const { data: adminRoles } = operatorUserIds.length
        ? await supabase.from("user_roles").select("user_id").in("user_id", operatorUserIds).eq("role", "admin")
        : { data: [] as { user_id: string }[] };
      if (cancelled) return;
      setAdminOperatorUserIds((adminRoles ?? []).map((role) => role.user_id));
      setMessages(loadedMessages);
      setHasOlderMessages(loadedMessages.length === MESSAGE_PAGE_SIZE);
      setNotes((n ?? []) as unknown as Note[]);
      setCustomerInfoEntries((info ?? []) as unknown as CustomerInfoEntry[]);
      const settingsMap = new Map((settings ?? []).map((setting) => [setting.key, setting.value]));
      const mode = settingsMap.get("concurrency_mode");
      const timeout = settingsMap.get("lock_timeout_minutes");
      setConcurrencyMode(mode === "warning" || mode === "lock" ? mode : "open");
      setLockTimeoutMinutes(typeof timeout === "number" ? timeout : 10);
      setConversationLock((lock ?? null) as unknown as ConversationLock | null);
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
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMsg = payload.new as Msg;
          shouldStickToBottomRef.current = isNearScrollBottom(scrollRef.current);
          if (payload.eventType === "UPDATE") {
            setMessages((prev) => prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m)));
            return;
          }
          if (newMsg.operator_id) {
            supabase
              .from("operators")
              .select("full_name, user_id")
              .eq("id", newMsg.operator_id)
              .maybeSingle()
              .then(async ({ data }) => {
                if (data?.user_id) {
                  const { data: adminRole } = await supabase
                    .from("user_roles")
                    .select("user_id")
                    .eq("user_id", data.user_id)
                    .eq("role", "admin")
                    .maybeSingle();
                  if (adminRole) {
                    setAdminOperatorUserIds((prev) => (prev.includes(adminRole.user_id) ? prev : [...prev, adminRole.user_id]));
                  }
                }
                const hydrated = { ...newMsg, operators: data ? { full_name: data.full_name, user_id: data.user_id } : null };
                setMessages((prev) => mergeMessagesById(prev, [hydrated]));
                void hydrateMessageDecorations(hydrated).then((attachmentHydrated) => {
                  setMessages((prev) => mergeMessagesById(prev, [attachmentHydrated]));
                });
              });
          } else {
            setMessages((prev) => mergeMessagesById(prev, [newMsg]));
            void hydrateMessageDecorations(newMsg).then((hydrated) => {
              setMessages((prev) => mergeMessagesById(prev, [hydrated]));
            });
          }
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
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "customer_info_entries",
          filter: conv?.client_id ? `client_id=eq.${conv.client_id}` : undefined,
        },
        async () => {
          if (!conv?.client_id) return;
          const { data } = await supabase
            .from("customer_info_entries")
            .select("id, content, created_at, operator_id, created_by_user_id, operators(full_name)")
            .eq("client_id", conv.client_id)
            .order("created_at", { ascending: false });
          setCustomerInfoEntries((data ?? []) as unknown as CustomerInfoEntry[]);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_locks",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async () => {
          const { data } = await supabase
            .from("conversation_locks")
            .select("conversation_id, locked_by_operator_id, locked_by_user_id, locked_at, last_activity_at, expires_at, released_at, release_reason, operators!conversation_locks_locked_by_operator_id_fkey(full_name)")
            .eq("conversation_id", conversationId)
            .maybeSingle();
          setConversationLock((data ?? null) as unknown as ConversationLock | null);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [conversationId, conv?.client_id]);

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

  useEffect(() => {
    if (concurrencyMode === "open") return;
    const timer = window.setInterval(() => {
      setLockClock((tick) => tick + 1);
      void (supabase as any).rpc("cleanup_expired_conversation_locks");
    }, 30000);
    return () => window.clearInterval(timer);
  }, [concurrencyMode]);

  const acquireLock = async () => {
    if (concurrencyMode === "open" || !operator || lockBusy) return false;
    const active = isActiveLock(conversationLock);
    if (active && conversationLock?.locked_by_operator_id === operator.id) return true;
    if (active && conversationLock?.locked_by_operator_id !== operator.id && concurrencyMode === "lock") return false;

    setLockBusy(true);
    const { data, error } = await (supabase as any).rpc("acquire_conversation_lock", {
      _conversation_id: conversationId,
    });
    setLockBusy(false);

    if (error) {
      toast.error("תפיסת השיחה נכשלה");
      return false;
    }

    const payload = data as { acquired?: boolean; lock?: ConversationLock; holder_name?: string } | null;
    if (payload?.lock) {
      setConversationLock({
        ...payload.lock,
        operators: payload.holder_name ? { full_name: payload.holder_name } : payload.lock.operators,
      });
    }
    return payload?.acquired === true;
  };

  const releaseLock = async () => {
    if (lockBusy) return;
    setLockBusy(true);
    const { data, error } = await (supabase as any).rpc("release_conversation_lock", {
      _conversation_id: conversationId,
    });
    setLockBusy(false);

    if (error) {
      toast.error("שחרור השיחה נכשל");
      return;
    }

    const payload = data as { released?: boolean; lock?: ConversationLock } | null;
    if (payload?.lock) setConversationLock(payload.lock);
    toast.success(payload?.released ? "השיחה שוחררה" : "אין נעילה פעילה");
  };

  const releaseConversation = async () => {
    if (releasingConversation) return;

    setReleasingConversation(true);
    try {
      const { error } = await supabase.rpc("release_operator_conversation", {
        _conversation_id: conversationId,
        _reason: "released",
      });

      if (error) {
        if (error.message.includes("conversation_not_responsible_operator")) {
          toast.error("השיחה אינה באחריותך ולכן לא ניתן לשחרר אותה.");
        } else if (error.message.includes("conversation_locked_by_other_operator")) {
          toast.error("השיחה נעולה לעובד אחר.");
        } else {
          toast.error("שחרור השיחה נכשל.");
        }
        return;
      }

      toast.success("השיחה הוחזרה לפניות החדשות.");
      navigate({ to: "/operator/new" });
    } finally {
      setReleasingConversation(false);
    }
  };

  const handleComposerActivity = () => {
    if (concurrencyMode !== "open") {
      void acquireLock();
    }
  };

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
    if (concurrencyMode === "lock") {
      const active = isActiveLock(conversationLock);
      if (active && operator && conversationLock?.locked_by_operator_id !== operator.id) {
        toast.error("השיחה נעולה כרגע לעובד אחר");
        return;
      }
      if (!active) {
        const acquired = await acquireLock();
        if (!acquired) {
          toast.error("לא ניתן לשלוח כי השיחה נעולה לעובד אחר");
          return;
        }
      }
    } else if (concurrencyMode === "warning") {
      void acquireLock();
    }
    stopTyping();
    setSending(true);
    const { data, error } = await supabase.rpc("send_operator_message", {
      _conversation_id: conversationId,
      _content: content,
    });
    setSending(false);
    if (error) {
      if (error.message.includes("operator_record_required")) {
        toast.error("כדי לענות מהפאנל צריך רשומת עובד פעילה לאדמין/משתמש הזה.");
        return;
      }
      if (error.message.includes("conversation_locked_by_other_operator")) {
        toast.error("השיחה נעולה לעובד אחר");
        return;
      }
      toast.error("שליחה נכשלה");
      return;
    }
    const result = data as { message?: Msg } | null;
    if (result?.message) {
      const message = {
        ...result.message,
        operators: operator ? { full_name: operator.full_name } : null,
      };
      shouldStickToBottomRef.current = true;
      setMessages((prev) => mergeMessagesById(prev, [message]));
    }
    setInput("");
  };

  const handleStickerSent = (result: StickerSendResult) => {
    if (!result.message) return;
    shouldStickToBottomRef.current = true;
    const message: Msg = {
      ...result.message,
      operator_id: operator?.id ?? null,
      operators: operator ? { full_name: operator.full_name, user_id: user?.id ?? null } : null,
      message_stickers: result.message_sticker ?? null,
    };
    setMessages((prev) => mergeMessagesById(prev, [message]));
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

  const saveCustomerInfo = async () => {
    const text = customerInfoInput.trim();
    if (!text || !operator || !user || !conv || savingCustomerInfo) return;
    setSavingCustomerInfo(true);
    const { error } = await supabase.from("customer_info_entries").insert({
      client_id: conv.client_id,
      conversation_id: conversationId,
      operator_id: operator.id,
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

  const claimNewQueueConversation = async (item: OperatorNewQueueItem) => {
    const result = await newQueue.claimConversation(item.work_item_id);
    if (!result.ok) {
      toast.error(operatorNewQueueClaimError(result.errorMessage));
      return;
    }

    setNewQueueSheetOpen(false);
    navigate({
      to: "/operator/chat/$conversationId",
      params: { conversationId: result.conversationId },
    });
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
  const activeLock = isActiveLock(conversationLock) ? conversationLock : null;
  const lockHeldByMe = !!activeLock && !!operator && activeLock.locked_by_operator_id === operator.id;
  const lockHeldByOther = !!activeLock && (!operator || activeLock.locked_by_operator_id !== operator.id);
  const sendBlockedByLock = concurrencyMode === "lock" && lockHeldByOther;
  const clientTyping = typingUsers.some((presence) => presence.role === "client");
  const coworkerTyping = typingUsers.filter((presence) => presence.role === "operator" || presence.role === "admin");
  const otherActiveOperators = activeUsers.filter((presence) => presence.role === "operator" || presence.role === "admin");

  return (
    <div className="flex flex-col h-[100dvh] bg-background" dir="rtl">
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
            {otherActiveOperators.length > 0 ? " · עובד נוסף פעיל בשיחה" : ""}
          </p>
        </div>
        <div className="hidden md:flex gap-1">
          {!closed && operator && !isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void releaseConversation()}
              disabled={releasingConversation}
              className="shrink-0"
            >
              <RotateCcw className="h-4 w-4" />
              {releasingConversation ? "משחרר..." : "שחרר שיחה"}
            </Button>
          )}
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
        <div className="xl:hidden">
          <Sheet open={newQueueSheetOpen} onOpenChange={setNewQueueSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="פניות NEW">
                <Inbox className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-full p-0 sm:max-w-sm" dir="rtl">
              <SheetHeader className="sr-only">
                <SheetTitle>פניות NEW</SheetTitle>
              </SheetHeader>
              <OperatorNewQueuePanel
                items={newQueue.items}
                claimingId={newQueue.claimingId}
                onClaim={claimNewQueueConversation}
                isLoading={newQueue.isLoading}
                error={newQueue.error}
                onRetry={() => void newQueue.refetch()}
                emptyDescription="פניות שממתינות לטיפול יופיעו כאן."
              />
            </SheetContent>
          </Sheet>
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
                <CustomerInfoPanel
                  entries={customerInfoEntries}
                  input={customerInfoInput}
                  setInput={setCustomerInfoInput}
                  save={saveCustomerInfo}
                  saving={savingCustomerInfo}
                  canEdit={!!operator}
                />
                <StatusActions status={conv?.status ?? "open"} updateStatus={updateStatus} />
                {!closed && operator && !isAdmin && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void releaseConversation()}
                    disabled={releasingConversation}
                  >
                    <RotateCcw className="h-4 w-4" />
                    {releasingConversation ? "משחרר..." : "שחרר שיחה לפניות החדשות"}
                  </Button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <LockModeBanner
        mode={concurrencyMode}
        lock={activeLock}
        lockTimeoutMinutes={lockTimeoutMinutes}
        isMine={lockHeldByMe}
        isAdmin={isAdmin}
        busy={lockBusy}
        onAcquire={acquireLock}
        onRelease={releaseLock}
      />

      <div className="flex-1 flex min-h-0">
        {/* Messages */}
        <div className="flex-1 flex flex-col min-w-0">
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
              const avatarUrl = isOps ? conv?.characters?.avatar_url : client?.avatar_url;
              const avatarName = isOps ? conv?.characters?.name : client?.display_name ?? client?.email;
              const hasAttachments = (m.message_attachments?.length ?? 0) > 0;
              const hasStickers = !!m.message_stickers;
              const stickerHydrationPending = m.content === "[sticker]" && m.message_stickers === undefined;
              const showContent =
                (m.content !== "[image]" || !hasAttachments) &&
                (m.content !== "[sticker]" || (!hasStickers && !stickerHydrationPending));
              return (
                <div key={m.id} className={`flex items-end gap-2 ${isOps ? "justify-start" : "justify-end"}`}>
                  <ChatAvatar src={avatarUrl} name={avatarName} />
                  <div
                    className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2 ${
                      isOps
                        ? "bg-primary text-primary-foreground rounded-bl-sm"
                        : "bg-card border border-border rounded-br-sm"
                    }`}
                  >
                    {isOps && (
                      <p className="text-[10px] mb-0.5 opacity-70">
                        {m.operators?.full_name
                          ? `${adminOperatorUserIds.includes(m.operators.user_id ?? "") ? "מנהל" : "עובד"}: ${m.operators.full_name}`
                          : m.sender_type === "admin"
                            ? "מנהל"
                            : "עובד"}
                      </p>
                    )}
                    {showContent && <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>}
                    {m.message_attachments?.map((attachment) => (
                      <MessageAttachment
                        key={attachment.id}
                        attachment={attachment}
                        access={attachmentAccess.accessByAttachmentId[attachment.id] ?? null}
                        accessStatus={attachmentAccess.getAccessStatus(attachment.id)}
                        refreshAccess={() => attachmentAccess.refreshAttachment(attachment.id)}
                      />
                    ))}
                    {stickerHydrationPending && <StickerHydrationPlaceholder />}
                    {m.message_stickers && <MessageSticker sticker={m.message_stickers} />}
                    <p className={`text-[10px] mt-1 ${isOps ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {new Date(m.created_at).toLocaleTimeString("he-IL", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {isOps && (
                        <span className="ms-2">
                          {m.is_read ? "נראה" : "נשלח"}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
            {(clientTyping || coworkerTyping.length > 0) && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {clientTyping && (
                  <div className="flex justify-end">
                    <span className="rounded-full border border-border bg-card px-3 py-1">הלקוח מקליד...</span>
                  </div>
                )}
                {coworkerTyping.length > 0 && (
                  <div className="flex justify-start">
                    <span className="rounded-full border border-border bg-card px-3 py-1">
                      {coworkerTyping.length === 1
                        ? `${coworkerTyping[0].displayName} מקליד/ה...`
                        : "עובד נוסף מקליד..."}
                    </span>
                  </div>
                )}
              </div>
            )}
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
                    onFocus={handleComposerActivity}
                    onChange={(e) => {
                      setInput(e.target.value);
                      if (e.target.value.trim()) {
                        handleComposerActivity();
                        startTyping();
                      } else {
                        stopTyping();
                      }
                    }}
                    onBlur={stopTyping}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={sendBlockedByLock ? "השיחה נעולה כרגע לעובד אחר" : `כתוב כ${character?.name ?? "דמות"}...`}
                    rows={1}
                    maxLength={2000}
                    className="min-w-0 flex-1 resize-none min-h-[40px] max-h-32"
                    disabled={sendBlockedByLock}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={() => setMediaPickerOpen(true)}
                          disabled={sendBlockedByLock}
                          aria-label="בחירת מדיה לשליחה"
                        >
                          <ImagePlus className="h-4 w-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {sendBlockedByLock ? "השיחה נעולה לעובד אחר" : "בחירת מדיה"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={() => setStickerPickerOpen(true)}
                          disabled={sendBlockedByLock}
                          aria-label="Choose sticker"
                        >
                          <Smile className="h-4 w-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {sendBlockedByLock ? "The conversation is locked by another operator." : "Choose sticker"}
                    </TooltipContent>
                  </Tooltip>
                  <Button className="h-10 w-10 shrink-0" onClick={send} disabled={sending || !input.trim() || sendBlockedByLock} size="icon">
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1 text-end">{input.length}/2000</p>
              </>
            )}
          </div>
        </div>

        <aside className="hidden xl:flex w-72 shrink-0 border-r border-border">
          <OperatorNewQueuePanel
            items={newQueue.items}
            claimingId={newQueue.claimingId}
            onClaim={claimNewQueueConversation}
            isLoading={newQueue.isLoading}
            error={newQueue.error}
            onRetry={() => void newQueue.refetch()}
            emptyDescription="פניות שממתינות לטיפול יופיעו כאן."
          />
        </aside>

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
            <CustomerInfoPanel
              entries={customerInfoEntries}
              input={customerInfoInput}
              setInput={setCustomerInfoInput}
              save={saveCustomerInfo}
              saving={savingCustomerInfo}
              canEdit={!!operator}
            />
            <StatusActions status={conv?.status ?? "open"} updateStatus={updateStatus} />
          </div>
        </aside>
      </div>
      <OperatorMediaPicker
        conversationId={conversationId}
        open={mediaPickerOpen}
        onOpenChange={setMediaPickerOpen}
      />
      <StickerPicker
        conversationId={conversationId}
        open={stickerPickerOpen}
        onOpenChange={setStickerPickerOpen}
        role="operator"
        onSent={handleStickerSent}
      />
    </div>
  );
}

function LockModeBanner({
  mode,
  lock,
  lockTimeoutMinutes,
  isMine,
  isAdmin,
  busy,
  onAcquire,
  onRelease,
}: {
  mode: ConcurrencyMode;
  lock: ConversationLock | null;
  lockTimeoutMinutes: number;
  isMine: boolean;
  isAdmin: boolean;
  busy: boolean;
  onAcquire: () => Promise<boolean>;
  onRelease: () => Promise<void>;
}) {
  if (mode === "open") return null;

  const holderName = lock?.operators?.full_name ?? "עובד אחר";
  const expiresAt = lock
    ? new Date(lock.expires_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })
    : null;

  if (mode === "warning") {
    if (!lock || isMine) return null;
    return (
      <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {holderName} פעיל בשיחה הזו. אפשר לשלוח הודעה, אבל כדאי לתאם לפני מענה.
          </span>
          {expiresAt && <span className="text-xs text-muted-foreground">פעילות עד {expiresAt}</span>}
        </div>
      </div>
    );
  }

  if (!lock) {
    return (
      <div className="border-b border-border bg-muted/50 px-4 py-2 text-sm" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>מצב נעילה פעיל. כדי לענות צריך לקחת את השיחה.</span>
          <Button size="sm" variant="outline" onClick={() => void onAcquire()} disabled={busy}>
            קח שיחה
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`border-b px-4 py-2 text-sm ${isMine ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10"}`} dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">
            {isMine ? "השיחה נעולה אליך" : `השיחה נעולה אצל ${holderName}`}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · שחרור אוטומטי אחרי {lockTimeoutMinutes} דקות ללא פעילות{expiresAt ? ` · צפוי ב-${expiresAt}` : ""}
          </span>
        </div>
        {(isMine || isAdmin) && (
          <Button size="sm" variant="outline" onClick={() => void onRelease()} disabled={busy}>
            {isAdmin && !isMine ? "שחרור מנהל" : "שחרר שיחה"}
          </Button>
        )}
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

function CustomerInfoPanel({
  entries,
  input,
  setInput,
  save,
  saving,
  canEdit,
}: {
  entries: CustomerInfoEntry[];
  input: string;
  setInput: (s: string) => void;
  save: () => Promise<void>;
  saving: boolean;
  canEdit: boolean;
}) {
  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-3 flex items-center gap-2">
        <Info className="h-4 w-4" /> מידע פנימי על הלקוח
      </h3>
      {canEdit && (
        <div className="space-y-2 mb-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="לדוגמה: רווק, עובד בהייטק, אוהב ספורט..."
            rows={2}
            maxLength={2000}
            className="resize-none text-sm"
          />
          <Button onClick={save} disabled={saving || !input.trim()} size="sm" className="w-full">
            {saving ? "שומר..." : "שמור מידע"}
          </Button>
        </div>
      )}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {entries.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">אין מידע פנימי עדיין</p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="text-xs p-2 rounded bg-muted">
            <p className="whitespace-pre-wrap break-words">{entry.content}</p>
            <p className="text-muted-foreground mt-1 text-[10px]">
              {entry.operators?.full_name ?? "עובד"} ·{" "}
              {new Date(entry.created_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
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
