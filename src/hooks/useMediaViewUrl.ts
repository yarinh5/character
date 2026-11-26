import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type MediaViewKind =
  | "message_attachment"
  | "message_sticker"
  | "conversation_sticker"
  | "admin_sticker_preview"
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

function signedStorageUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const base =
    import.meta.env.VITE_SUPABASE_URL ||
    (typeof process !== "undefined" ? process.env.SUPABASE_URL : undefined);
  if (!base) return null;

  try {
    const gateway = new URL(base);
    const signed = new URL(value);
    const tokens = signed.searchParams.getAll("token");
    if (
      !["http:", "https:"].includes(gateway.protocol) ||
      !["http:", "https:"].includes(signed.protocol) ||
      signed.username ||
      signed.password ||
      signed.hash ||
      !/^\/storage\/v1\/object\/sign\/(character-media|client-media|sticker-media)\/.+/.test(
        signed.pathname,
      ) ||
      tokens.length !== 1 ||
      !tokens[0]
    )
      return null;

    // Edge may sign through the internal gateway. Never navigate to the returned host.
    return new URL(`${signed.pathname}${signed.search}`, gateway.origin).href;
  } catch {
    return null;
  }
}

export function useMediaViewUrl(
  kind: MediaViewKind,
  targetId?: string,
  conversationId?: string,
  enabled = true,
  accessGeneration = 0,
) {
  const [state, setState] = useState<ViewState>(() =>
    targetId && enabled ? { status: "loading", url: null } : { status: "idle", url: null },
  );
  const requestVersionRef = useRef(0);
  const accessGenerationRef = useRef(accessGeneration);
  accessGenerationRef.current = accessGeneration;
  const retriedRef = useRef(false);

  const load = useCallback(async () => {
    if (!targetId || !enabled) {
      setState({ status: "idle", url: null });
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    const requestAccessGeneration = accessGeneration;
    setState({ status: "loading", url: null });

    const body =
      kind === "message_attachment"
        ? { kind, attachment_id: targetId }
        : kind === "message_sticker"
          ? { kind, message_sticker_id: targetId }
          : kind === "conversation_sticker"
            ? conversationId
              ? { kind, conversation_id: conversationId, sticker_id: targetId }
              : null
            : kind === "admin_sticker_preview"
              ? { kind, sticker_id: targetId }
              : kind === "reserved_preview"
                ? { kind, reservation_id: targetId }
                : { kind, asset_id: targetId };

    if (!body) {
      setState({ status: "idle", url: null });
      return;
    }

    const { data, error } = await supabase.functions.invoke("media-view-url", { body });
    if (
      requestVersion !== requestVersionRef.current ||
      requestAccessGeneration !== accessGenerationRef.current
    )
      return;

    const response = (data ?? {}) as ViewUrlResponse;
    const url = signedStorageUrl(response.url);
    if (error || !url || typeof response.expires_at !== "string") {
      setState({ status: "error", url: null });
      return;
    }

    setState({ status: "ready", url });
  }, [accessGeneration, conversationId, enabled, kind, targetId]);

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
