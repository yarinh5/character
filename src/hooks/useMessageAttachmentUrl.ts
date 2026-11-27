import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

export function useMessageAttachmentUrl(
  attachmentId: string,
  enabled = true,
  accessGeneration = 0,
) {
  return useMediaViewUrl("message_attachment", attachmentId, undefined, enabled, accessGeneration);
}
