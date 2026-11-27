import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/auth";

type PresenceRole = Extract<AppRole, "client" | "operator" | "admin">;
export type ConversationPresenceUser = {
  userId: string;
  role: PresenceRole;
  displayName: string;
  onlineAt: string;
};
type Args = {
  conversationId: string | undefined;
  userId: string | undefined;
  role: PresenceRole;
  displayName: string;
  enabled?: boolean;
  accessGeneration?: number;
};
const HEARTBEAT_MS = 25_000;
const TYPING_STOP_MS = 2_800;

export function useConversationPresence({
  conversationId,
  userId,
  role,
  displayName,
  enabled = true,
  accessGeneration = 0,
}: Args) {
  const [activeUsers, setActiveUsers] = useState<ConversationPresenceUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<ConversationPresenceUser[]>([]);
  const typingTimerRef = useRef<number | null>(null);
  const scopeRef = useRef({ conversationId, userId, accessGeneration });
  if (
    scopeRef.current.conversationId !== conversationId ||
    scopeRef.current.userId !== userId ||
    scopeRef.current.accessGeneration !== accessGeneration
  ) {
    scopeRef.current = { conversationId, userId, accessGeneration };
  }

  const writePresence = useCallback(
    async (active: boolean, typing: boolean) => {
      if (!conversationId || !userId) return;
      await supabase.rpc("set_conversation_presence", {
        _conversation_id: conversationId,
        _role: role,
        _display_name: displayName,
        _active: active,
        _typing: typing,
      });
    },
    [conversationId, displayName, role, userId],
  );

  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (!enabled || !conversationId || !userId) {
      setActiveUsers([]);
      setTypingUsers([]);
      return;
    }
    const { data, error } = await supabase.rpc("get_conversation_presence", {
      _conversation_id: conversationId,
    });
    if (scopeRef.current !== scope) return;
    if (error) {
      setActiveUsers([]);
      setTypingUsers([]);
      return;
    }
    const rows = data ?? [];
    const users = rows
      .filter((entry) => entry.user_id !== userId)
      .map((entry) => ({
        userId: entry.user_id,
        role: entry.role as PresenceRole,
        displayName: entry.display_name,
        onlineAt: entry.online_at,
      }));
    const typingIds = new Set(
      rows.filter((entry) => entry.is_typing).map((entry) => entry.user_id),
    );
    setActiveUsers(users);
    setTypingUsers(users.filter((entry) => typingIds.has(entry.userId)));
  }, [conversationId, enabled, userId]);

  const stopTyping = useCallback(() => {
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    if (enabled) void writePresence(true, false);
  }, [enabled, writePresence]);
  const startTyping = useCallback(() => {
    if (!enabled) return;
    void writePresence(true, true);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(stopTyping, TYPING_STOP_MS);
  }, [enabled, stopTyping, writePresence]);

  useEffect(() => {
    setActiveUsers([]);
    setTypingUsers([]);
    if (!enabled || !conversationId || !userId) return;
    void writePresence(true, false).then(refresh);
    let disposed = false;
    const channel = supabase
      .channel(`conversation-presence-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_presence_states",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void refresh(),
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          void refresh();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
          setActiveUsers([]);
          setTypingUsers([]);
        }
      });
    const heartbeat = window.setInterval(() => void writePresence(true, false), HEARTBEAT_MS);
    return () => {
      disposed = true;
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
      window.clearInterval(heartbeat);
      void writePresence(false, false);
      supabase.removeChannel(channel);
      setActiveUsers([]);
      setTypingUsers([]);
    };
  }, [accessGeneration, conversationId, enabled, refresh, userId, writePresence]);

  return { activeUsers, typingUsers, startTyping, stopTyping };
}
