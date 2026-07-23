import { useEffect, useRef } from "react";
import { DiscoveryCard } from "@/components/discovery/DiscoveryCard";
import type { Database } from "@/integrations/supabase/types";

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];

type DiscoveryDeckProps = {
  character: DiscoveryCharacter;
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

export function DiscoveryDeck({ character, ...props }: DiscoveryDeckProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [character.id]);

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {character.is_recycled ? "דמות ממחזור קודם" : `מחזור גילוי ${character.cycle_number}`}
      </p>
      <DiscoveryCard character={character} headingRef={headingRef} {...props} />
    </div>
  );
}
