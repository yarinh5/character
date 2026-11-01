import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Heart, RefreshCw, Star } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FavoriteCard } from "@/components/favorites/FavoriteCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AmbiguousFavoriteResultError, useFavorites } from "@/hooks/useFavorites";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logSupabaseError } from "@/lib/readStates";

export const Route = createFileRoute("/app/favorites")({
  component: FavoritesPage,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

function FavoritesPage() {
  const { loading, role, session, user } = useAuth();
  const navigate = useNavigate();
  const clientId =
    !loading && role === "client" && user?.id && session?.user.id === user.id ? user.id : null;
  const authKey = `${loading}:${role ?? "none"}:${user?.id ?? "none"}:${session?.user.id ?? "none"}`;
  const authGenerationRef = useRef({ key: authKey, value: 0 });
  if (authGenerationRef.current.key !== authKey) {
    authGenerationRef.current = { key: authKey, value: authGenerationRef.current.value + 1 };
  }
  const clientScope = clientId ? `${clientId}:${authGenerationRef.current.value}` : null;
  const identityRef = useRef(clientScope);
  identityRef.current = clientScope;
  const favorites = useFavorites(clientId ?? undefined, authGenerationRef.current.value);
  const startLockRef = useRef<{ scope: string; token: symbol } | null>(null);
  const [startingScope, setStartingScope] = useState<string | null>(null);

  const removeFavorite = async (characterId: string) => {
    if (!clientId) return;
    const requestScope = clientScope;
    if (!requestScope) return;
    try {
      await favorites.setFavorite(characterId, false);
    } catch (error) {
      if (identityRef.current !== requestScope) return;
      logSupabaseError("client favorites remove favorite", error);
      toast.error(
        error instanceof AmbiguousFavoriteResultError
          ? "לא ניתן היה לאשר את תוצאת העדכון. הרשימה נבדקה מחדש."
          : "לא הצלחנו לעדכן את המועדפים. אפשר לנסות שוב.",
      );
    }
  };

  const startChat = async (characterId: string) => {
    if (!clientId || !clientScope || startLockRef.current?.scope === clientScope) return;
    const token = Symbol("conversation");
    const requestIdentityScope = clientScope;
    const requestScope = `${requestIdentityScope}:${characterId}`;
    startLockRef.current = { scope: requestIdentityScope, token };
    setStartingScope(requestScope);
    try {
      const { data, error } = await supabase.rpc("start_or_get_conversation", {
        _character_id: characterId,
      });
      if (identityRef.current !== requestIdentityScope) return;
      if (error) throw error;
      if (!isUuid(data)) throw new Error("invalid_conversation_response");
      await navigate({ to: "/app/chat/$conversationId", params: { conversationId: data } });
    } catch (error) {
      if (identityRef.current !== requestIdentityScope) return;
      logSupabaseError("client favorites start conversation", error);
      toast.error("לא הצלחנו לפתוח את השיחה. אפשר לנסות שוב.");
    } finally {
      if (startLockRef.current?.token === token) startLockRef.current = null;
      if (identityRef.current === requestIdentityScope) setStartingScope(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6" dir="rtl" role="status">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (!clientId || !clientScope) {
    return (
      <div
        className="mx-auto flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 text-center"
        dir="rtl"
        role="status"
      >
        <p className="text-sm text-muted-foreground">נדרש חיבור לקוח מאומת</p>
      </div>
    );
  }

  const startingId = startingScope?.startsWith(`${clientScope}:`)
    ? startingScope.slice(clientScope.length + 1)
    : null;
  const showInitialError = favorites.isError && favorites.favorites.length === 0;
  const showCachedRefreshError = favorites.isError && favorites.favorites.length > 0;

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
          <div className="space-y-3" role="status" aria-label="טוען מועדפים">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-32 w-full" />
            ))}
          </div>
        )}

        {(showInitialError || showCachedRefreshError || favorites.mutationRefreshFailed) && (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3"
            role="alert"
          >
            <p className="text-sm text-destructive">
              {favorites.mutationRefreshFailed
                ? "המועדף עודכן, אך רענון הרשימה נכשל."
                : showCachedRefreshError
                  ? "רענון המועדפים נכשל. הרשימה השמורה נשארה מוצגת."
                  : "טעינת המועדפים נכשלה"}
            </p>
            <Button
              variant="outline"
              onClick={() => void favorites.retry()}
              disabled={favorites.isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 ${favorites.isRefreshing ? "animate-spin" : ""}`} />
              {favorites.isRefreshing ? "מנסה שוב..." : "נסה שוב"}
            </Button>
          </div>
        )}

        {favorites.isEmpty && !favorites.mutationRefreshFailed && (
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
            {favorites.isRefreshing && (
              <p className="text-sm text-muted-foreground" role="status">
                מרענן מועדפים...
              </p>
            )}
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
