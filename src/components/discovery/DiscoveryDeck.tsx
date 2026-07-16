import { useEffect, useRef } from "react";
import { DiscoveryCard } from "@/components/discovery/DiscoveryCard";
import type { Database } from "@/integrations/supabase/types";

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];

type DiscoveryDeckProps = {
  character: DiscoveryCharacter;
  visibleCount: number;
  isFavorite: boolean;
  disabled: boolean;
  startingChat: boolean;
  onPass: () => void;
  onLike: () => void;
  onFavorite: () => void;
  onStartChat: () => void;
};

export function DiscoveryDeck({ character, visibleCount, ...props }: DiscoveryDeckProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [character.id]);

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {visibleCount > 1 ? `נשארו ${visibleCount} דמויות בטעינה הנוכחית` : "דמות אחרונה בטעינה הנוכחית"}
      </p>
      <DiscoveryCard character={character} headingRef={headingRef} {...props} />
    </div>
  );
}
