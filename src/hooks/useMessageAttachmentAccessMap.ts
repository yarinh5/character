import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type MessageAttachmentAccess = {
  access_mode: string;
  render_state: string;
  price_credits_snapshot: number | null;
  is_unlocked: boolean | null;
  view_mode: string;
};

export type MessageAttachmentAccessStatus = "loading" | "ready" | "error";

const ATTACHMENT_ACCESS_BATCH_SIZE = 100;

function normalizeAttachmentIds(attachmentIds: readonly string[]) {
  return [...new Set(attachmentIds)].sort();
}

function chunkAttachmentIds(attachmentIds: readonly string[]) {
  return Array.from(
    { length: Math.ceil(attachmentIds.length / ATTACHMENT_ACCESS_BATCH_SIZE) },
    (_, index) => attachmentIds.slice(index * ATTACHMENT_ACCESS_BATCH_SIZE, (index + 1) * ATTACHMENT_ACCESS_BATCH_SIZE),
  );
}

export function useMessageAttachmentAccessMap(attachmentIds: readonly string[]) {
  const attachmentIdsKey = attachmentIds.join(",");
  const normalizedAttachmentIds = useMemo(
    () => normalizeAttachmentIds(attachmentIds),
    [attachmentIdsKey],
  );
  const [accessByAttachmentId, setAccessByAttachmentId] = useState<Record<string, MessageAttachmentAccess>>({});
  const [isLoading, setIsLoading] = useState(false);
  const requestSequenceRef = useRef(0);
  const batchRequestVersionRef = useRef(0);
  const latestRequestByAttachmentIdRef = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    const requestVersion = ++requestSequenceRef.current;
    batchRequestVersionRef.current = requestVersion;
    if (normalizedAttachmentIds.length === 0) {
      setAccessByAttachmentId({});
      setIsLoading(false);
      return;
    }

    normalizedAttachmentIds.forEach((attachmentId) => {
      latestRequestByAttachmentIdRef.current.set(attachmentId, requestVersion);
    });
    setIsLoading(true);
    const results = await Promise.all(
      chunkAttachmentIds(normalizedAttachmentIds).map((attachmentIdBatch) =>
        supabase.rpc("get_message_attachment_access", { _attachment_ids: attachmentIdBatch }),
      ),
    );
    if (requestVersion !== batchRequestVersionRef.current) return;

    const currentAttachmentIds = normalizedAttachmentIds.filter(
      (attachmentId) => latestRequestByAttachmentIdRef.current.get(attachmentId) === requestVersion,
    );
    const currentAttachmentIdSet = new Set(currentAttachmentIds);

    if (results.some(({ error }) => error)) {
      setIsLoading(false);
      return;
    }

    const nextAccessByAttachmentId = Object.fromEntries(
      results
        .flatMap(({ data }) => data ?? [])
        .filter((access) => currentAttachmentIdSet.has(access.attachment_id))
        .map((access) => [
          access.attachment_id,
          {
            access_mode: access.access_mode,
            render_state: access.render_state,
            price_credits_snapshot: access.price_credits_snapshot,
            is_unlocked: access.is_unlocked,
            view_mode: access.view_mode,
          } satisfies MessageAttachmentAccess,
        ]),
    );
    setAccessByAttachmentId((previous) => {
      const next = { ...previous };
      currentAttachmentIds.forEach((attachmentId) => delete next[attachmentId]);
      return { ...next, ...nextAccessByAttachmentId };
    });
    setIsLoading(false);
  }, [normalizedAttachmentIds]);

  const refreshAttachment = useCallback(async (attachmentId: string) => {
    const requestVersion = ++requestSequenceRef.current;
    latestRequestByAttachmentIdRef.current.set(attachmentId, requestVersion);
    const { data, error } = await supabase.rpc("get_message_attachment_access", {
      _attachment_ids: [attachmentId],
    });
    if (latestRequestByAttachmentIdRef.current.get(attachmentId) !== requestVersion || error) {
      return null;
    }

    const access = data?.[0];
    if (!access) return null;
    const resolvedAccess: MessageAttachmentAccess = {
      access_mode: access.access_mode,
      render_state: access.render_state,
      price_credits_snapshot: access.price_credits_snapshot,
      is_unlocked: access.is_unlocked,
      view_mode: access.view_mode,
    };
    setAccessByAttachmentId((previous) => ({ ...previous, [attachmentId]: resolvedAccess }));
    return resolvedAccess;
  }, []);

  const getAccessStatus = useCallback(
    (attachmentId: string): MessageAttachmentAccessStatus => {
      if (accessByAttachmentId[attachmentId]) return "ready";
      if (isLoading) return "loading";
      return "error";
    },
    [accessByAttachmentId, isLoading],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    accessByAttachmentId,
    getAccessStatus,
    refreshAttachment,
  };
}
