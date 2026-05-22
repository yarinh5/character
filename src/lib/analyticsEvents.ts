import { supabase } from "@/integrations/supabase/client";

type TrackAnalyticsEventInput = {
  eventName: string;
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
  characterId?: string | null;
  operatorId?: string | null;
  dedupeSeconds?: number;
};

export async function trackAnalyticsEvent({
  eventName,
  metadata = {},
  conversationId = null,
  characterId = null,
  operatorId = null,
  dedupeSeconds = 0,
}: TrackAnalyticsEventInput) {
  const { error } = await (supabase as any).rpc("track_analytics_event", {
    _event_name: eventName,
    _metadata: metadata,
    _conversation_id: conversationId,
    _character_id: characterId,
    _operator_id: operatorId,
    _dedupe_seconds: dedupeSeconds,
  });

  if (error) {
    console.error("Failed to track analytics event", { eventName, error });
  }
}
