import type { ComponentProps } from "react";
import { Heart, MessageCirclePlus, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type DiscoveryActionBarProps = {
  isFavorite: boolean;
  disabled: boolean;
  startingChat: boolean;
  onPass: () => void;
  onLike: () => void;
  onFavorite: () => void;
  onStartChat: () => void;
};

function IconAction({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} size="icon" aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DiscoveryActionBar({
  isFavorite,
  disabled,
  startingChat,
  onPass,
  onLike,
  onFavorite,
  onStartChat,
}: DiscoveryActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3" onPointerDown={(event) => event.stopPropagation()}>
      <IconAction
        label="דלג"
        variant="outline"
        disabled={disabled}
        onClick={onPass}
        className="h-12 w-12 rounded-full border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
      >
        <X className="h-5 w-5" />
      </IconAction>
      <IconAction
        label={isFavorite ? "הסר ממועדפים" : "הוסף למועדפים"}
        variant="outline"
        disabled={disabled}
        onClick={onFavorite}
        className="h-12 w-12 rounded-full"
      >
        <Star className={`h-5 w-5 ${isFavorite ? "fill-amber-400 text-amber-500" : ""}`} />
      </IconAction>
      <IconAction
        label="אהבתי"
        disabled={disabled}
        onClick={onLike}
        className="h-12 w-12 rounded-full bg-rose-600 text-white hover:bg-rose-700"
      >
        <Heart className="h-5 w-5 fill-current" />
      </IconAction>
      <Button variant="secondary" disabled={disabled || startingChat} onClick={onStartChat} className="h-12 px-4">
        <MessageCirclePlus className="h-4 w-4" />
        {startingChat ? "פותח שיחה..." : "התחל שיחה"}
      </Button>
    </div>
  );
}
