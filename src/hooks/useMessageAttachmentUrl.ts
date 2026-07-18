import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

export function useMessageAttachmentUrl(attachmentId: string) {
  return useMediaViewUrl("message_attachment", attachmentId);
}
