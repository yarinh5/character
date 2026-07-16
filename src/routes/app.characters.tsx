import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Heart, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { useDiscovery } from "@/hooks/useDiscovery";
import { DiscoveryDeck } from "@/components/discovery/DiscoveryDeck";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createFileRoute("/app/characters")({
  component: CharactersPage,
});

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : fallback;
}

function CharactersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const discovery = useDiscovery(user?.id);
  const [startingId, setStartingId] = useState<string | null>(null);
  const character = discovery.activeCharacter;

  useEffect(() => {
    if (!character) return;
    void trackAnalyticsEvent({
      eventName: "character_viewed",
      characterId: character.id,
      metadata: { source: "client_discovery" },
      dedupeSeconds: 3600,
    });
  }, [character]);

  const handleSwipe = async (action: "like" | "pass") => {
    if (!character || discovery.isSwipePending) return;
    try {
      await discovery.swipe(character.id, action);
    } catch (error) {
      toast.error(errorMessage(error, "עדכון הבחירה נכשל"));
    }
  };

  const handleFavorite = async () => {
    if (!character || discovery.isFavoritePending) return;
    const nextFavorite = !discovery.isFavorite(character.id);
    try {
      await discovery.setFavorite(character.id, nextFavorite);
    } catch (error) {
      toast.error(errorMessage(error, "עדכון המועדפים נכשל"));
    }
  };

  const startChat = async () => {
    if (!character || startingId) return;
    setStartingId(character.id);
    try {
      const { data, error } = await supabase.rpc("start_or_get_conversation", {
        _character_id: character.id,
      });
      if (error) throw error;
      navigate({ to: "/app/chat/$conversationId", params: { conversationId: data } });
    } catch (error) {
      toast.error(errorMessage(error, "פתיחת שיחה נכשלה"));
    } finally {
      setStartingId(null);
    }
  };

  const retry = () => {
    void discovery.retry();
  };

  const deckBusy = discovery.isSwipePending || discovery.isFavoritePending || startingId === character?.id;

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col px-4 py-6 md:min-h-screen md:py-8" dir="rtl">
        <header className="mb-6 space-y-1 text-center">
          <h1 className="text-2xl font-bold">גלו דמויות</h1>
          <p className="text-sm text-muted-foreground">החליקו כדי לדלג או לסמן אהבתי</p>
        </header>

        <div className="flex flex-1 items-center justify-center">
          {discovery.isLoading && (
            <div className="w-full max-w-md space-y-4">
              <Skeleton className="aspect-[4/3] w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}

          {!discovery.isLoading && discovery.isError && !character && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-destructive">טעינת הדמויות נכשלה</p>
              <Button variant="outline" onClick={retry}>
                <RefreshCw className="h-4 w-4" />
                נסה שוב
              </Button>
            </div>
          )}

          {!discovery.isLoading && !discovery.isError && !character && discovery.isLoadingMore && (
            <div className="w-full max-w-md space-y-4">
              <Skeleton className="aspect-[4/3] w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}

          {!discovery.isLoading && !discovery.isError && !character && !discovery.isLoadingMore && (
            <div className="space-y-4 text-center">
              <Users className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">אין עוד דמויות לגלות כרגע</p>
              {discovery.hasMore && (
                <Button variant="outline" onClick={() => void discovery.loadMore()}>
                  <RefreshCw className="h-4 w-4" />
                  טען עוד
                </Button>
              )}
            </div>
          )}

          {character && (
            <DiscoveryDeck
              character={character}
              visibleCount={discovery.visibleCount}
              isFavorite={discovery.isFavorite(character.id)}
              disabled={deckBusy}
              startingChat={startingId === character.id}
              onPass={() => void handleSwipe("pass")}
              onLike={() => void handleSwipe("like")}
              onFavorite={() => void handleFavorite()}
              onStartChat={() => void startChat()}
            />
          )}
        </div>

        {character && discovery.isLoadingMore && <p className="pt-4 text-center text-xs text-muted-foreground">טוען דמויות נוספות...</p>}
        {character && discovery.isError && <p className="pt-4 text-center text-xs text-destructive">טעינת דמויות נוספות נכשלה</p>}
        {character && discovery.isFavorite(character.id) && (
          <p className="pt-4 text-center text-xs text-muted-foreground">
            <Heart className="ml-1 inline h-3.5 w-3.5 fill-current text-rose-600" />
            הדמות שמורה במועדפים
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
