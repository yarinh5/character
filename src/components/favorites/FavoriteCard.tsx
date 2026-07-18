import { Check, Heart, MessageCirclePlus, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FavoriteCharacter } from "@/hooks/useFavorites";

type FavoriteCardProps = {
  character: FavoriteCharacter;
  disabled: boolean;
  startingChat: boolean;
  removingFavorite: boolean;
  onRemoveFavorite: () => void;
  onStartChat: () => void;
};

export function FavoriteCard({
  character,
  disabled,
  startingChat,
  removingFavorite,
  onRemoveFavorite,
  onStartChat,
}: FavoriteCardProps) {
  const hasConversation = character.conversation_id !== null;

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex gap-4 p-4" dir="rtl">
        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-muted">
          {character.avatar_url ? (
            <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-muted-foreground">
              {character.name[0]}
            </div>
          )}
          {character.is_liked && (
            <span className="absolute right-1 top-1 rounded-full bg-rose-600 p-1 text-white" title="אהבת">
              <Heart className="h-3 w-3 fill-current" aria-hidden="true" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate font-semibold">{character.name}</h2>
              <p className="text-sm text-muted-foreground">
                {[character.fictional_age ? `גיל ${character.fictional_age}` : null, character.category].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="הסר ממועדפים"
                  disabled={disabled || removingFavorite}
                  onClick={onRemoveFavorite}
                >
                  <Star className="h-5 w-5 fill-amber-400 text-amber-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>הסר ממועדפים</TooltipContent>
            </Tooltip>
          </div>

          {character.short_description && <p className="line-clamp-2 text-sm text-muted-foreground">{character.short_description}</p>}

          <Button className="w-full sm:w-auto" variant="secondary" disabled={disabled || startingChat} onClick={onStartChat}>
            {hasConversation ? <Check className="h-4 w-4" /> : <MessageCirclePlus className="h-4 w-4" />}
            {startingChat ? "פותח שיחה..." : hasConversation ? "המשך שיחה" : "התחל שיחה"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
