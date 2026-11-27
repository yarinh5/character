import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

export function useStickerViewUrl(messageStickerId?: string, enabled = true, accessGeneration = 0) {
  return useMediaViewUrl("message_sticker", messageStickerId, undefined, enabled, accessGeneration);
}

export function useConversationStickerViewUrl(
  conversationId: string,
  stickerId?: string,
  enabled = true,
  accessGeneration = 0,
) {
  return useMediaViewUrl(
    "conversation_sticker",
    stickerId,
    conversationId,
    enabled,
    accessGeneration,
  );
}
