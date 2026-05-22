import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";

export function useActiveConversation(conversationId: string | undefined, roleOverride?: AppRole | null) {
  const { user, role } = useAuth();
  const activeRole = roleOverride ?? role;

  useEffect(() => {
    if (!user || !conversationId || !activeRole) return;
    if (activeRole !== "client" && activeRole !== "operator" && activeRole !== "admin") return;

    const touch = () => {
      void (supabase as any).rpc("touch_active_conversation", {
        _conversation_id: conversationId,
        _role: activeRole,
      });
    };

    touch();
    const timer = window.setInterval(touch, 25000);

    return () => {
      window.clearInterval(timer);
      void (supabase as any).rpc("leave_active_conversation", {
        _conversation_id: conversationId,
      });
    };
  }, [activeRole, conversationId, user]);
}
