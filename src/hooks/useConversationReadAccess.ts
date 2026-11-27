import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export type ConversationReadAccessState = "checking" | "allowed" | "denied" | "error";

export function useConversationReadAccess(conversationId: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<ConversationReadAccessState>("checking");
  const [generation, setGeneration] = useState(0);
  const requestRef = useRef(0);
  const accessVersionRef = useRef<number | null>(null);
  const versionUserRef = useRef(user?.id);
  const scopeRef = useRef({ conversationId, userId: user?.id });

  if (versionUserRef.current !== user?.id) {
    versionUserRef.current = user?.id;
    accessVersionRef.current = null;
  }

  if (scopeRef.current.conversationId !== conversationId || scopeRef.current.userId !== user?.id) {
    scopeRef.current = { conversationId, userId: user?.id };
    requestRef.current += 1;
  }

  const invalidate = useCallback(() => {
    requestRef.current += 1;
    setState("checking");
    setGeneration((current) => current + 1);
  }, []);

  const failClosed = useCallback(() => {
    requestRef.current += 1;
    setState("error");
    setGeneration((current) => current + 1);
  }, []);

  const revalidate = useCallback(async () => {
    const requestId = ++requestRef.current;
    const scope = scopeRef.current;
    if (!scope.conversationId || !scope.userId) {
      setState("denied");
      return;
    }
    setState("checking");
    const { data, error } = await supabase.rpc("get_conversation_read_access", {
      _conversation_id: scope.conversationId,
    });
    if (requestId !== requestRef.current || scopeRef.current !== scope) return;
    if (error) {
      setState("error");
      setGeneration((current) => current + 1);
      return;
    }
    const allowed = Boolean(data?.[0]?.allowed);
    const nextVersion = Number(data?.[0]?.access_version);
    const versionChanged =
      Number.isFinite(nextVersion) &&
      accessVersionRef.current !== null &&
      accessVersionRef.current !== nextVersion;
    if (Number.isFinite(nextVersion)) accessVersionRef.current = nextVersion;
    setState(allowed ? "allowed" : "denied");
    if (!allowed || versionChanged) setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    invalidate();
    void revalidate();
    return () => {
      requestRef.current += 1;
    };
  }, [conversationId, invalidate, revalidate, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let disposed = false;
    const channel = supabase
      .channel(`conversation-access-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_conversation_access_versions",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          invalidate();
          void revalidate();
        },
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          void revalidate();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
          failClosed();
        }
      });
    return () => {
      disposed = true;
      supabase.removeChannel(channel);
    };
  }, [failClosed, invalidate, revalidate, user?.id]);

  useEffect(() => {
    const refresh = () => void revalidate();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidate]);

  return { state, generation, revalidate, suspend: failClosed };
}
