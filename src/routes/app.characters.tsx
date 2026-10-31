import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Heart, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { logSupabaseError } from "@/lib/readStates";
import {
  EMPTY_DISCOVERY_FILTERS,
  type DiscoveryFilters as DiscoveryFiltersState,
  useDiscovery,
} from "@/hooks/useDiscovery";
import { DiscoveryFilters } from "@/components/discovery/DiscoveryFilters";
import { DiscoveryDeck } from "@/components/discovery/DiscoveryDeck";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createFileRoute("/app/characters")({
  component: CharactersRoute,
});

function CharactersRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === "/app/characters" ? <CharactersPage /> : <Outlet />;
}

function CharactersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<DiscoveryFiltersState>(EMPTY_DISCOVERY_FILTERS);
  const discovery = useDiscovery(user?.id, filters);
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
      await discovery.swipe(character, action);
    } catch (error) {
      logSupabaseError("client discovery swipe", error);
      toast.error("לא הצלחנו לעדכן את הבחירה. אפשר לנסות שוב.");
    }
  };

  const handleFavorite = async () => {
    if (!character || discovery.isFavoritePending) return;
    try {
      await discovery.setFavorite(character.id, !discovery.isFavorite);
    } catch (error) {
      logSupabaseError("client discovery favorite", error);
      toast.error("לא הצלחנו לעדכן את המועדפים. אפשר לנסות שוב.");
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
      logSupabaseError("client discovery start conversation", error);
      toast.error("לא הצלחנו לפתוח את השיחה. אפשר לנסות שוב.");
    } finally {
      setStartingId(null);
    }
  };

  const deckBusy =
    discovery.isSwipePending || discovery.isFavoritePending || startingId === character?.id;
  const hasActiveFilters =
    filters.min_age !== null ||
    filters.max_age !== null ||
    filters.city_id !== null ||
    filters.interest !== null ||
    filters.favorites_only ||
    filters.recycled_only;
  const showError = !discovery.isLoading && discovery.isError;
  const showLoading = discovery.isLoading || (!showError && !character && discovery.isRefreshing);
  const showCharacter = Boolean(character) && !showLoading && !showError;

  return (
    <TooltipProvider>
      <div
        className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col px-4 py-6 md:min-h-screen md:py-8"
        dir="rtl"
      >
        <header className="mb-6 space-y-1 text-center">
          <h1 className="text-2xl font-bold">גלו דמויות</h1>
          <p className="text-sm text-muted-foreground">החליקו כדי לדלג או לסמן אהבתי</p>
        </header>

        <DiscoveryFilters filters={filters} onChange={setFilters} />

        {showCharacter && discovery.isRefreshing && (
          <p role="status" className="mb-3 text-center text-sm text-muted-foreground">
            מרענן דמויות...
          </p>
        )}

        <div
          className="flex flex-1 items-center justify-center"
          aria-busy={discovery.isLoading || discovery.isRefreshing}
        >
          {showLoading && (
            <div className="w-full max-w-md space-y-4" role="status" aria-label="טוען דמויות">
              <Skeleton className="aspect-[4/3] w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}

          {showError && (
            <div className="space-y-4 text-center" role="alert">
              <p className="text-sm text-destructive">טעינת הדמויות נכשלה</p>
              <Button
                variant="outline"
                onClick={() => void discovery.retry()}
                disabled={discovery.isRefreshing}
              >
                <RefreshCw className="h-4 w-4" />
                {discovery.isRefreshing ? "מנסה שוב..." : "נסה שוב"}
              </Button>
            </div>
          )}

          {!showLoading && !showError && discovery.isEmpty && !character && (
            <div className="space-y-4 text-center">
              <Users className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters ? "לא נמצאו דמויות למסננים הנוכחיים" : "אין דמויות להצגה כרגע"}
              </p>
              {hasActiveFilters && (
                <Button variant="outline" onClick={() => setFilters(EMPTY_DISCOVERY_FILTERS)}>
                  איפוס מסננים
                </Button>
              )}
            </div>
          )}

          {showCharacter && character && (
            <DiscoveryDeck
              character={character}
              isFavorite={discovery.isFavorite}
              isLiked={character.is_liked}
              conversationId={character.conversation_id || null}
              disabled={deckBusy || discovery.isRefreshing}
              startingChat={startingId === character.id}
              onPass={() => void handleSwipe("pass")}
              onLike={() => void handleSwipe("like")}
              onFavorite={() => void handleFavorite()}
              onStartChat={() => void startChat()}
              onViewProfile={() =>
                void navigate({
                  to: "/app/characters/$characterId",
                  params: { characterId: character.id },
                })
              }
            />
          )}
        </div>

        {showCharacter && discovery.isFavorite && (
          <p className="pt-4 text-center text-xs text-muted-foreground">
            <Heart className="ml-1 inline h-3.5 w-3.5 fill-current text-rose-600" />
            הדמות שמורה במועדפים
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
