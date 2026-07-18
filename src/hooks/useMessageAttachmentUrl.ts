import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type ViewState =
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null };

type ViewUrlResponse = {
  url?: unknown;
  expires_at?: unknown;
};

export function useMessageAttachmentUrl(attachmentId: string) {
  const [state, setState] = useState<ViewState>({ status: "loading", url: null });
  const requestVersionRef = useRef(0);
  const retriedRef = useRef(false);

  const load = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setState({ status: "loading", url: null });

    const { data, error } = await supabase.functions.invoke("media-view-url", {
      body: { kind: "message_attachment", attachment_id: attachmentId },
    });
    if (requestVersion !== requestVersionRef.current) return;

    const response = (data ?? {}) as ViewUrlResponse;
    if (error || typeof response.url !== "string" || typeof response.expires_at !== "string") {
      setState({ status: "error", url: null });
      return;
    }

    setState({ status: "ready", url: response.url });
  }, [attachmentId]);

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

  return { ...state, retryAfterImageError };
}
