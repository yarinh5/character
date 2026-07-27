import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

export function useMessageAttachmentUrl(attachmentId: string, enabled = true) {
  return useMediaViewUrl("message_attachment", attachmentId, undefined, enabled);
}
