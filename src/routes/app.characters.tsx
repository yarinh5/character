import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageCirclePlus, Users } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/characters")({
  component: CharactersPage,
});

function CharactersPage() {
  const navigate = useNavigate();
  const [startingId, setStartingId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["characters", "public"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("id, name, avatar_url, fictional_age, short_description, category, interests, availability_status")
        .eq("is_active", true)
        .eq("is_visible", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!data || data.length === 0) return;
    data.forEach((character) => {
      void trackAnalyticsEvent({
        eventName: "character_viewed",
        characterId: character.id,
        metadata: { source: "client_characters_grid" },
        dedupeSeconds: 3600,
      });
    });
  }, [data]);

  const startChat = async (characterId: string) => {
    setStartingId(characterId);
    try {
      const { data, error } = await supabase.rpc("start_or_get_conversation", {
        _character_id: characterId,
      });
      if (error) throw error;
      navigate({ to: "/app/chat/$conversationId", params: { conversationId: data as string } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "פתיחת שיחה נכשלה");
    } finally {
      setStartingId(null);
    }
  };

  return (
    <>
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">דמויות</h1>
          <p className="text-sm text-muted-foreground mt-1">בחר דמות והתחל שיחה</p>
        </header>

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-72" />
            ))}
          </div>
        )}

        {error && (
          <div className="text-center py-12 text-destructive">שגיאה בטעינת דמויות</div>
        )}

        {!isLoading && !error && data && data.length === 0 && (
          <div className="text-center py-16">
            <Users className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">אין דמויות זמינות כרגע</p>
          </div>
        )}

        {!isLoading && data && data.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.map((c) => (
              <Card key={c.id} className="overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-muted relative">
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt={c.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-4xl font-bold text-muted-foreground">
                      {c.name[0]}
                    </div>
                  )}
                  <span
                    className={`absolute top-3 left-3 px-2 py-1 rounded-full text-xs font-medium ${
                      c.availability_status === "available"
                        ? "bg-success text-success-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {c.availability_status === "available" ? "זמין" : "עסוק"}
                  </span>
                </div>
                <CardContent className="p-4 flex-1 flex flex-col">
                  <div className="flex items-baseline justify-between mb-1">
                    <h3 className="font-semibold text-lg">{c.name}</h3>
                    {c.fictional_age && (
                      <span className="text-xs text-muted-foreground">גיל {c.fictional_age}</span>
                    )}
                  </div>
                  {c.category && (
                    <span className="text-xs text-primary mb-2">{c.category}</span>
                  )}
                  {c.short_description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                      {c.short_description}
                    </p>
                  )}
                  {c.interests && c.interests.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-4">
                      {c.interests.slice(0, 3).map((i) => (
                        <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-accent text-accent-foreground">
                          {i}
                        </span>
                      ))}
                    </div>
                  )}
                  <Button
                    className="mt-auto w-full"
                    onClick={() => startChat(c.id)}
                    disabled={startingId === c.id}
                  >
                    <MessageCirclePlus className="h-4 w-4" />
                    {startingId === c.id ? "פותח..." : "התחל שיחה"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
