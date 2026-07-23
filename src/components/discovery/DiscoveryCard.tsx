import type { RefObject } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { Database } from "@/integrations/supabase/types";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { DiscoveryActionBar } from "@/components/discovery/DiscoveryActionBar";

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];

type DiscoveryCardProps = {
  character: DiscoveryCharacter;
  headingRef: RefObject<HTMLHeadingElement | null>;
  isFavorite: boolean;
  isLiked: boolean;
  conversationId: string | null;
  disabled: boolean;
  startingChat: boolean;
  onPass: () => void;
  onLike: () => void;
  onFavorite: () => void;
  onStartChat: () => void;
  onViewProfile: () => void;
};

export function DiscoveryCard({
  character,
  headingRef,
  isFavorite,
  isLiked,
  conversationId,
  disabled,
  startingChat,
  onPass,
  onLike,
  onFavorite,
  onStartChat,
  onViewProfile,
}: DiscoveryCardProps) {
  const { dragX, isDragging, handlers } = useSwipeGesture({
    disabled,
    onSwipeLeft: onPass,
    onSwipeRight: onLike,
  });
  const dragProgress = Math.min(1, Math.abs(dragX) / 96);

  return (
    <Card
      {...handlers}
      className="touch-pan-y select-none overflow-hidden shadow-sm transition-transform duration-200 motion-reduce:transition-none"
      style={{
        transform: `translateX(${dragX}px) rotate(${dragX / 18}deg)`,
        transition: isDragging ? "none" : undefined,
      }}
    >
      <div className="relative aspect-[4/3] bg-muted">
        {character.avatar_url ? (
          <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-5xl font-bold text-muted-foreground">
            {character.name[0]}
          </div>
        )}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 flex w-1/2 items-center justify-center bg-rose-600/75 text-sm font-semibold text-white"
          style={{ opacity: dragX < 0 ? dragProgress : 0 }}
        >
          דלג
        </div>
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 flex w-1/2 items-center justify-center bg-emerald-600/75 text-sm font-semibold text-white"
          style={{ opacity: dragX > 0 ? dragProgress : 0 }}
        >
          אהבתי
        </div>
        <span
          className={`absolute left-3 top-3 rounded-full px-2 py-1 text-xs font-medium ${
            character.availability_status === "available"
              ? "bg-success text-success-foreground"
              : "bg-background/85 text-muted-foreground"
          }`}
        >
          {character.availability_status === "available" ? "זמינה" : "לא זמינה כרגע"}
        </span>
        {isLiked && (
          <span className="absolute right-3 top-3 rounded-full bg-rose-600 px-2 py-1 text-xs font-medium text-white">
            אהבת
          </span>
        )}
      </div>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
              {character.name}
            </h2>
            {character.fictional_age && <span className="text-sm text-muted-foreground">גיל {character.fictional_age}</span>}
          </div>
          {character.category && <p className="text-sm text-primary">{character.category}</p>}
        </div>
        {character.short_description && <p className="text-sm leading-6 text-muted-foreground">{character.short_description}</p>}
        {character.interests.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {character.interests.slice(0, 3).map((interest) => (
              <span key={interest} className="rounded-full bg-accent px-2 py-1 text-xs text-accent-foreground">
                {interest}
              </span>
            ))}
          </div>
        )}
        <DiscoveryActionBar
          isFavorite={isFavorite}
          isLiked={isLiked}
          conversationId={conversationId}
          disabled={disabled}
          startingChat={startingChat}
          onPass={onPass}
          onLike={onLike}
          onFavorite={onFavorite}
          onStartChat={onStartChat}
          onViewProfile={onViewProfile}
        />
      </CardContent>
    </Card>
  );
}
