import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

export function useStickerViewUrl(messageStickerId?: string) {
  return useMediaViewUrl("message_sticker", messageStickerId);
}

export function useConversationStickerViewUrl(conversationId: string, stickerId?: string) {
  return useMediaViewUrl("conversation_sticker", stickerId, conversationId);
}
