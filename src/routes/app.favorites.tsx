import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Heart, RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FavoriteCard } from "@/components/favorites/FavoriteCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFavorites } from "@/hooks/useFavorites";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/app/favorites")({
  component: FavoritesPage,
});

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : fallback;
}

function FavoritesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const favorites = useFavorites(user?.id);
  const [startingId, setStartingId] = useState<string | null>(null);

  const removeFavorite = async (characterId: string) => {
    if (favorites.isFavoritePending) return;
    try {
      await favorites.setFavorite(characterId, false);
    } catch (error) {
      toast.error(errorMessage(error, "עדכון המועדפים נכשל"));
    }
  };

  const startChat = async (characterId: string) => {
    if (startingId) return;
    setStartingId(characterId);
    try {
      const { data, error } = await supabase.rpc("start_or_get_conversation", {
        _character_id: characterId,
      });
      if (error) throw error;
      navigate({ to: "/app/chat/$conversationId", params: { conversationId: data } });
    } catch (error) {
      toast.error(errorMessage(error, "פתיחת שיחה נכשלה"));
    } finally {
      setStartingId(null);
    }
  };

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8" dir="rtl">
        <header className="mb-6 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Star className="h-6 w-6 fill-amber-400 text-amber-500" />
            המועדפים שלי
          </h1>
          <p className="text-sm text-muted-foreground">דמויות שסימנת לשמירה</p>
        </header>

        {favorites.isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-32 w-full" />
            ))}
          </div>
        )}

        {!favorites.isLoading && favorites.isError && favorites.favorites.length === 0 && (
          <div className="space-y-4 py-12 text-center">
            <p className="text-sm text-destructive">טעינת המועדפים נכשלה</p>
            <Button variant="outline" onClick={() => void favorites.retry()}>
              <RefreshCw className="h-4 w-4" />
              נסה שוב
            </Button>
          </div>
        )}

        {favorites.isEmpty && (
          <div className="py-16 text-center">
            <Heart className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
            <p className="mb-4 text-muted-foreground">אין דמויות במועדפים עדיין</p>
            <Button asChild variant="outline">
              <Link to="/app/characters">גלה דמויות</Link>
            </Button>
          </div>
        )}

        {favorites.favorites.length > 0 && (
          <div className="space-y-3" aria-busy={favorites.isRefreshing}>
            {favorites.favorites.map((character) => (
              <FavoriteCard
                key={character.id}
                character={character}
                disabled={favorites.isFavoritePending || startingId !== null}
                startingChat={startingId === character.id}
                removingFavorite={favorites.pendingCharacterId === character.id}
                onRemoveFavorite={() => void removeFavorite(character.id)}
                onStartChat={() => void startChat(character.id)}
              />
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
