import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/auth";

type PresenceRole = Extract<AppRole, "client" | "operator" | "admin">;

export type ConversationPresenceUser = {
  userId: string;
  role: PresenceRole;
  displayName: string;
  onlineAt: string;
};

type TypingUser = ConversationPresenceUser & {
  expiresAt: number;
};

type UseConversationPresenceArgs = {
  conversationId: string | undefined;
  userId: string | undefined;
  role: PresenceRole;
  displayName: string;
};

const TYPING_TIMEOUT_MS = 2800;
const TYPING_START_THROTTLE_MS = 1400;

export function useConversationPresence({
  conversationId,
  userId,
  role,
  displayName,
}: UseConversationPresenceArgs) {
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const isTypingRef = useRef(false);
  const lastTypingStartRef = useRef(0);
  const [activeUsers, setActiveUsers] = useState<ConversationPresenceUser[]>([]);
  const [typingUsersById, setTypingUsersById] = useState<Record<string, TypingUser>>({});

  const self = useMemo(
    () => ({
      user_id: userId,
      role,
      display_name: displayName,
      active_in_conversation: true,
    }),
    [displayName, role, userId],
  );

  const pruneExpiredTyping = useCallback(() => {
    const now = Date.now();
    setTypingUsersById((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([, user]) => user.expiresAt > now));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const stopTyping = useCallback(() => {
    const channel = channelRef.current;
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (!channel || !userId || !isTypingRef.current) return;

    isTypingRef.current = false;
    void channel.send({
      type: "broadcast",
      event: "typing:stop",
      payload: self,
    });
  }, [self, userId]);

  const startTyping = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !userId) return;

    const now = Date.now();
    if (!isTypingRef.current || now - lastTypingStartRef.current > TYPING_START_THROTTLE_MS) {
      isTypingRef.current = true;
      lastTypingStartRef.current = now;
      void channel.send({
        type: "broadcast",
        event: "typing:start",
        payload: self,
      });
    }

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => stopTyping(), TYPING_TIMEOUT_MS);
  }, [self, stopTyping, userId]);

  useEffect(() => {
    if (!conversationId || !userId) return;

    const channel = supabase
      .channel(`conversation:${conversationId}`, {
        config: {
          presence: { key: userId },
          broadcast: { self: false },
        },
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const users = Object.values(state)
          .flat()
          .map((entry: any) => ({
            userId: String(entry.user_id ?? ""),
            role: entry.role as PresenceRole,
            displayName: String(entry.display_name ?? "משתמש"),
            onlineAt: String(entry.online_at ?? new Date().toISOString()),
          }))
          .filter((entry) => entry.userId && entry.userId !== userId);
        setActiveUsers(users);
      })
      .on("presence", { event: "join" }, () => {
        void channel.send({
          type: "broadcast",
          event: "presence:join",
          payload: self,
        });
        void channel.send({
          type: "broadcast",
          event: "active_in_conversation",
          payload: self,
        });
      })
      .on("presence", { event: "leave" }, ({ leftPresences }) => {
        const leftIds = new Set((leftPresences as any[]).map((entry) => String(entry.user_id ?? "")));
        setTypingUsersById((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !leftIds.has(id))),
        );
      })
      .on("broadcast", { event: "typing:start" }, ({ payload }) => {
        const incoming = payload as typeof self;
        if (!incoming?.user_id || incoming.user_id === userId) return;
        setTypingUsersById((current) => ({
          ...current,
          [incoming.user_id!]: {
            userId: incoming.user_id!,
            role: incoming.role,
            displayName: incoming.display_name || "משתמש",
            onlineAt: new Date().toISOString(),
            expiresAt: Date.now() + TYPING_TIMEOUT_MS,
          },
        }));
      })
      .on("broadcast", { event: "typing:stop" }, ({ payload }) => {
        const incoming = payload as typeof self;
        if (!incoming?.user_id || incoming.user_id === userId) return;
        setTypingUsersById((current) => {
          const next = { ...current };
          delete next[incoming.user_id!];
          return next;
        });
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        void channel.track({
          ...self,
          online_at: new Date().toISOString(),
        });
        void channel.send({
          type: "broadcast",
          event: "presence:join",
          payload: self,
        });
        void channel.send({
          type: "broadcast",
          event: "active_in_conversation",
          payload: self,
        });
      });

    channelRef.current = channel;
    const cleanupTimer = window.setInterval(pruneExpiredTyping, 1000);

    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (isTypingRef.current) {
        void channel.send({
          type: "broadcast",
          event: "typing:stop",
          payload: self,
        });
      }
      void channel.send({
        type: "broadcast",
        event: "presence:leave",
        payload: self,
      });
      void channel.untrack();
      window.clearInterval(cleanupTimer);
      channelRef.current = null;
      isTypingRef.current = false;
      setActiveUsers([]);
      setTypingUsersById({});
      supabase.removeChannel(channel);
    };
  }, [conversationId, pruneExpiredTyping, self, userId]);

  return {
    activeUsers,
    typingUsers: Object.values(typingUsersById),
    startTyping,
    stopTyping,
  };
}
