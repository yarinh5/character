import { useRef, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MapPin, MessageCirclePlus, RefreshCw, Star, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { logSupabaseError } from "@/lib/readStates";

export const Route = createFileRoute("/app/characters/$characterId")({
  component: CharacterProfilePage,
});

type CharacterProfile = {
  id: string;
  name: string;
  avatar_url: string | null;
  fictional_age: number | null;
  short_description: string | null;
  full_description: string | null;
  personality: string | null;
  category: string | null;
  interests: string[] | null;
  city_name: string | null;
  gallery_images: string[] | null;
  is_favorite: boolean;
  conversation_id: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNullableStringArray = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isCharacterProfile(value: unknown): value is CharacterProfile {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.id) &&
    typeof row.name === "string" &&
    row.name.length > 0 &&
    isNullableString(row.avatar_url) &&
    (row.fictional_age === null ||
      (typeof row.fictional_age === "number" && Number.isFinite(row.fictional_age))) &&
    isNullableString(row.short_description) &&
    isNullableString(row.full_description) &&
    isNullableString(row.personality) &&
    isNullableString(row.category) &&
    isNullableStringArray(row.interests) &&
    isNullableString(row.city_name) &&
    isNullableStringArray(row.gallery_images) &&
    typeof row.is_favorite === "boolean" &&
    (row.conversation_id === null || isUuid(row.conversation_id))
  );
}

function parseCharacterProfile(data: unknown): CharacterProfile | null {
  if (!Array.isArray(data) || data.length > 1)
    throw new Error("invalid_character_profile_response");
  if (data.length === 0) return null;
  if (!isCharacterProfile(data[0])) throw new Error("invalid_character_profile_response");
  return data[0];
}

function isFavoriteResult(value: unknown, characterId: string, isFavorite: boolean) {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    result.character_id === characterId &&
    result.is_favorite === isFavorite &&
    typeof result.idempotent === "boolean"
  );
}

function CharacterProfilePage() {
  const { characterId } = Route.useParams();
  const { loading, role, session, user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clientId =
    !loading && role === "client" && user?.id && session?.user.id === user.id ? user.id : null;
  const authKey = `${loading}:${role ?? "none"}:${user?.id ?? "none"}:${session?.user.id ?? "none"}`;
  const authGenerationRef = useRef({ key: authKey, value: 0 });
  if (authGenerationRef.current.key !== authKey) {
    authGenerationRef.current = { key: authKey, value: authGenerationRef.current.value + 1 };
  }
  const scopeKey = `${clientId ?? "invalid"}:${authGenerationRef.current.value}:${characterId}`;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const favoriteLockRef = useRef<{ scope: string; token: symbol } | null>(null);
  const conversationLockRef = useRef<{ scope: string; token: symbol } | null>(null);
  const [favoritePendingScope, setFavoritePendingScope] = useState<string | null>(null);
  const [conversationPendingScope, setConversationPendingScope] = useState<string | null>(null);
  const queryKey = [
    "character-profile",
    clientId,
    characterId,
    authGenerationRef.current.value,
  ] as const;

  const profileQuery = useQuery({
    queryKey,
    enabled: Boolean(clientId && isUuid(characterId)),
    queryFn: async () => {
      const requestScope = scopeKey;
      const { data, error } = await supabase.rpc("get_character_profile", {
        _character_id: characterId,
      });
      if (activeScopeRef.current !== requestScope)
        throw new Error("stale_character_profile_request");
      if (error) {
        logSupabaseError("client character profile", error);
        throw error;
      }
      return parseCharacterProfile(data);
    },
  });
  const character = clientId ? profileQuery.data : undefined;
  const isFavoritePending = favoritePendingScope === scopeKey;
  const isConversationPending = conversationPendingScope === scopeKey;

  const handleFavorite = async () => {
    if (!clientId || !character || favoriteLockRef.current?.scope === scopeKey) return;
    const token = Symbol("favorite");
    const requestScope = scopeKey;
    const requestedValue = !character.is_favorite;
    favoriteLockRef.current = { scope: requestScope, token };
    setFavoritePendingScope(requestScope);
    try {
      const result = await supabase.rpc("set_character_favorite", {
        _character_id: characterId,
        _is_favorite: requestedValue,
      });
      if (activeScopeRef.current !== requestScope) return;
      if (result.error || !isFavoriteResult(result.data, characterId, requestedValue)) {
        await profileQuery.refetch();
        throw result.error ?? new Error("invalid_favorite_response");
      }
      queryClient.setQueryData<CharacterProfile | null>(queryKey, (current) =>
        current ? { ...current, is_favorite: requestedValue } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ["favorites", clientId] }),
        queryClient.invalidateQueries({ queryKey: ["discovery-card", clientId] }),
      ]);
    } catch (error) {
      if (activeScopeRef.current !== requestScope) return;
      logSupabaseError("client character profile favorite", error);
      toast.error("לא הצלחנו לאמת את עדכון המועדפים. אפשר לנסות שוב.");
    } finally {
      if (favoriteLockRef.current?.token === token) favoriteLockRef.current = null;
      if (activeScopeRef.current === requestScope) setFavoritePendingScope(null);
    }
  };

  const handleConversation = async () => {
    if (!clientId || !character || conversationLockRef.current?.scope === scopeKey) return;
    const token = Symbol("conversation");
    const requestScope = scopeKey;
    conversationLockRef.current = { scope: requestScope, token };
    setConversationPendingScope(requestScope);
    try {
      if (character.conversation_id) {
        await navigate({
          to: "/app/chat/$conversationId",
          params: { conversationId: character.conversation_id },
        });
        return;
      }
      await trackAnalyticsEvent({
        eventName: "character_viewed",
        characterId: character.id,
        metadata: { source: "character_profile" },
        dedupeSeconds: 3600,
      });
      if (activeScopeRef.current !== requestScope) return;
      const { data, error } = await supabase.rpc("start_or_get_conversation", {
        _character_id: characterId,
      });
      if (activeScopeRef.current !== requestScope) return;
      if (error) throw error;
      if (!isUuid(data)) throw new Error("invalid_conversation_response");
      await navigate({ to: "/app/chat/$conversationId", params: { conversationId: data } });
    } catch (error) {
      if (activeScopeRef.current !== requestScope) return;
      logSupabaseError("client character profile start conversation", error);
      toast.error("לא הצלחנו לפתוח את השיחה. אפשר לנסות שוב.");
    } finally {
      if (conversationLockRef.current?.token === token) conversationLockRef.current = null;
      if (activeScopeRef.current === requestScope) setConversationPendingScope(null);
    }
  };

  if (loading || (clientId && profileQuery.isLoading)) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 md:py-8" dir="rtl" role="status">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="aspect-[16/8] w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!clientId || !isUuid(characterId)) {
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

  if (profileQuery.isError && !character) {
    return (
      <div
        className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center"
        dir="rtl"
        role="alert"
      >
        <UserRound className="h-10 w-10 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">טעינת הפרופיל נכשלה</h1>
          <p className="text-sm text-muted-foreground">
            לא הצלחנו לטעון את פרטי הדמות. אפשר לנסות שוב.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button
            variant="outline"
            disabled={profileQuery.isFetching}
            onClick={() => void profileQuery.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${profileQuery.isFetching ? "animate-spin" : ""}`} />
            {profileQuery.isFetching ? "מנסה שוב..." : "נסה שוב"}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/app/characters">חזרה לגילוי</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!character) {
    return (
      <div
        className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center"
        dir="rtl"
      >
        <UserRound className="h-10 w-10 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">הדמות אינה זמינה</h1>
          <p className="text-sm text-muted-foreground">ייתכן שהפרופיל הוסר או שאינו זמין לצפייה.</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/app/characters">חזרה לגילוי</Link>
        </Button>
      </div>
    );
  }

  const galleryImages = Array.from(
    new Set(
      [character.avatar_url, ...(character.gallery_images ?? [])].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  );
  const description = character.full_description || character.short_description;
  const interests = character.interests ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:py-8" dir="rtl">
      {profileQuery.isRefetchError && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3"
          role="alert"
        >
          <p className="text-sm text-destructive">רענון הפרופיל נכשל. המידע השמור נשאר מוצג.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={profileQuery.isFetching}
            onClick={() => void profileQuery.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${profileQuery.isFetching ? "animate-spin" : ""}`} />
            {profileQuery.isFetching ? "מנסה שוב..." : "נסה שוב"}
          </Button>
        </div>
      )}
      <div className="mb-6 flex items-center justify-between gap-3">
        <Button asChild variant="ghost" className="shrink-0">
          <Link to="/app/characters">
            <ArrowRight className="h-4 w-4" />
            חזרה לגילוי
          </Link>
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={character.is_favorite ? "הסרה ממועדפים" : "הוספה למועדפים"}
          disabled={isFavoritePending}
          onClick={() => void handleFavorite()}
        >
          <Star
            className={`h-4 w-4 ${character.is_favorite ? "fill-amber-400 text-amber-500" : ""}`}
          />
        </Button>
      </div>
      <div className="overflow-hidden border bg-card">
        <div className="grid md:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.8fr)]">
          <div className="relative min-h-72 bg-muted">
            {galleryImages[0] ? (
              <img
                src={galleryImages[0]}
                alt={character.name}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-6xl font-bold text-muted-foreground">
                {character.name[0]}
              </div>
            )}
          </div>
          <section className="flex min-w-0 flex-col p-6">
            <div className="min-w-0 space-y-3">
              <div>
                <h1 className="break-words text-3xl font-bold">{character.name}</h1>
                <p className="mt-1 text-sm text-primary">{character.category || "דמות"}</p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {character.fictional_age !== null && <span>{character.fictional_age} שנים</span>}
                {character.city_name && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-4 w-4" />
                    {character.city_name}
                  </span>
                )}
              </div>
              {description && (
                <p className="break-words text-sm leading-7 text-muted-foreground">{description}</p>
              )}
            </div>
            <Button
              className="mt-8 h-11 w-full"
              disabled={isConversationPending}
              onClick={() => void handleConversation()}
            >
              <MessageCirclePlus className="h-4 w-4" />
              {isConversationPending
                ? "פותח שיחה..."
                : character.conversation_id
                  ? "המשך שיחה"
                  : "התחל שיחה"}
            </Button>
          </section>
        </div>
      </div>
      {galleryImages.length > 1 && (
        <section className="mt-8" aria-label="תמונות הפרופיל">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {galleryImages.slice(1).map((imageUrl) => (
              <img
                key={imageUrl}
                src={imageUrl}
                alt={`${character.name} - תמונה נוספת`}
                className="aspect-square w-full object-cover"
              />
            ))}
          </div>
        </section>
      )}
      {(character.personality || interests.length > 0) && (
        <section className="mt-8 border-t pt-6">
          {character.personality && (
            <p className="max-w-2xl break-words text-sm leading-7 text-muted-foreground">
              {character.personality}
            </p>
          )}
          {interests.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {interests.map((interest) => (
                <span
                  key={interest}
                  className="max-w-full break-words border px-3 py-1.5 text-sm text-muted-foreground"
                >
                  {interest}
                </span>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="sr-only" aria-live="polite">
        {profileQuery.isFetching ? "מעדכן פרופיל" : ""}
      </div>
    </main>
  );
}
