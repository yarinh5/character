import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type MediaViewKind =
  | "message_attachment"
  | "reserved_preview"
  | "admin_asset_preview"
  | "admin_locked_teaser_preview"
  | "admin_locked_delivery_preview";

type ViewState =
  | { status: "idle" | "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null };

type ViewUrlResponse = {
  url?: unknown;
  expires_at?: unknown;
};

export function useMediaViewUrl(kind: MediaViewKind, targetId?: string) {
  const [state, setState] = useState<ViewState>(() =>
    targetId ? { status: "loading", url: null } : { status: "idle", url: null },
  );
  const requestVersionRef = useRef(0);
  const retriedRef = useRef(false);

  const load = useCallback(async () => {
    if (!targetId) {
      setState({ status: "idle", url: null });
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setState({ status: "loading", url: null });

    const { data, error } = await supabase.functions.invoke("media-view-url", {
      body:
        kind === "message_attachment"
          ? { kind, attachment_id: targetId }
          : kind === "reserved_preview"
            ? { kind, reservation_id: targetId }
            : { kind, asset_id: targetId },
    });
    if (requestVersion !== requestVersionRef.current) return;

    const response = (data ?? {}) as ViewUrlResponse;
    if (error || typeof response.url !== "string" || typeof response.expires_at !== "string") {
      setState({ status: "error", url: null });
      return;
    }

    setState({ status: "ready", url: response.url });
  }, [kind, targetId]);

  useEffect(() => {
    retriedRef.current = false;
    void load();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [load]);

  const retryAfterImageError = useCallback(() => {
    if (retriedRef.current) {
      setState({ status: "error", url: null });
      return;
    }

    retriedRef.current = true;
    void load();
  }, [load]);

  return { ...state, retryAfterImageError, refresh: load };
}
