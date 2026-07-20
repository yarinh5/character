import { ImageOff, LoaderCircle } from "lucide-react";
import { useStickerViewUrl } from "@/hooks/useStickerViewUrl";
import type { StickerMessageHydration } from "@/hooks/useStickerSend";

export type ChatMessageSticker = StickerMessageHydration;

export function StickerHydrationPlaceholder() {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      Loading sticker
    </div>
  );
}

export function MessageSticker({ sticker }: { sticker: ChatMessageSticker }) {
  const preview = useStickerViewUrl(sticker.id);
  const label = `${sticker.collection_name_snapshot}: ${sticker.sticker_name_snapshot}`;

  if (preview.status === "loading" || preview.status === "idle") {
    return <StickerHydrationPlaceholder />;
  }

  if (preview.status === "error" || !preview.url) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <ImageOff className="h-3.5 w-3.5" />
        Sticker unavailable
      </div>
    );
  }

  return (
    <img
      src={preview.url}
      alt={label}
      className="mt-2 h-28 w-28 rounded-md object-contain"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={preview.retryAfterImageError}
    />
  );
}
