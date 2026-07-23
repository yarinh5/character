import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MapPin, MessageCirclePlus, Star, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";

export const Route = createFileRoute("/app/characters/$characterId")({
  component: CharacterProfilePage,
});

function messageForError(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : fallback;
}

function CharacterProfilePage() {
  const { characterId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ["character-profile", user?.id, characterId],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_character_profile", { _character_id: characterId });
      if (error) throw error;
      return data?.[0] ?? null;
    },
  });
  const character = profileQuery.data;

  const favoriteMutation = useMutation({
    mutationFn: async (isFavorite: boolean) => {
      const { error } = await supabase.rpc("set_character_favorite", {
        _character_id: characterId,
        _is_favorite: isFavorite,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["character-profile", user?.id, characterId] }),
        queryClient.invalidateQueries({ queryKey: ["favorites", user?.id] }),
        queryClient.invalidateQueries({ queryKey: ["discovery-card", user?.id] }),
      ]);
    },
  });

  const startConversationMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("start_or_get_conversation", { _character_id: characterId });
      if (error) throw error;
      return data;
    },
    onSuccess: (conversationId) => {
      void navigate({ to: "/app/chat/$conversationId", params: { conversationId } });
    },
  });

  if (profileQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 md:py-8" dir="rtl">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="aspect-[16/8] w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (profileQuery.isError || !character) {
    return (
      <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center" dir="rtl">
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

  const galleryImages = Array.from(new Set([character.avatar_url, ...(character.gallery_images ?? [])].filter(Boolean)));
  const description = character.full_description || character.short_description;
  const isConversationOpen = Boolean(character.conversation_id);

  const handleFavorite = async () => {
    try {
      await favoriteMutation.mutateAsync(!character.is_favorite);
    } catch (error) {
      toast.error(messageForError(error, "עדכון המועדפים נכשל"));
    }
  };

  const handleConversation = async () => {
    if (character.conversation_id) {
      await navigate({ to: "/app/chat/$conversationId", params: { conversationId: character.conversation_id } });
      return;
    }

    try {
      await trackAnalyticsEvent({
        eventName: "character_viewed",
        characterId: character.id,
        metadata: { source: "character_profile" },
        dedupeSeconds: 3600,
      });
      await startConversationMutation.mutateAsync();
    } catch (error) {
      toast.error(messageForError(error, "פתיחת השיחה נכשלה"));
    }
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:py-8" dir="rtl">
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
          disabled={favoriteMutation.isPending}
          onClick={() => void handleFavorite()}
        >
          <Star className={`h-4 w-4 ${character.is_favorite ? "fill-amber-400 text-amber-500" : ""}`} />
        </Button>
      </div>

      <div className="overflow-hidden border bg-card">
        <div className="grid md:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.8fr)]">
          <div className="relative min-h-72 bg-muted">
            {galleryImages[0] ? (
              <img src={galleryImages[0]} alt={character.name} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-6xl font-bold text-muted-foreground">
                {character.name[0]}
              </div>
            )}
          </div>
          <section className="flex flex-col p-6">
            <div className="space-y-3">
              <div>
                <h1 className="text-3xl font-bold">{character.name}</h1>
                <p className="mt-1 text-sm text-primary">{character.category || "דמות"}</p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {character.fictional_age && <span>{character.fictional_age} שנים</span>}
                {character.city_name && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-4 w-4" />
                    {character.city_name}
                  </span>
                )}
              </div>
              {description && <p className="text-sm leading-7 text-muted-foreground">{description}</p>}
            </div>
            <Button
              className="mt-8 h-11 w-full"
              disabled={startConversationMutation.isPending}
              onClick={() => void handleConversation()}
            >
              <MessageCirclePlus className="h-4 w-4" />
              {startConversationMutation.isPending
                ? "פותח שיחה..."
                : isConversationOpen
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

      {(character.personality || character.interests.length > 0) && (
        <section className="mt-8 border-t pt-6">
          {character.personality && <p className="max-w-2xl text-sm leading-7 text-muted-foreground">{character.personality}</p>}
          {character.interests.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {character.interests.map((interest) => (
                <span key={interest} className="border px-3 py-1.5 text-sm text-muted-foreground">
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
