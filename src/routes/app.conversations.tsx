import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fetchUnreadCounts } from "@/lib/readStates";
import { fetchLikedProfiles, likedProfilesKey } from "@/lib/clientLikedProfiles";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Heart, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/app/conversations")({
  component: ConversationsPage,
});

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

const STATUS_LABEL: Record<string, string> = {
  open: "פתוחה",
  waiting: "ממתינה",
  answered: "נענתה",
  closed: "סגורה",
};

function ConversationsPage() {
  const { user, session, role, loading } = useAuth();
  if (loading || role !== "client" || !user?.id || session?.user.id !== user.id) return null;
  return <ClientList key={user.id} clientId={user.id} />;
}

const conversationsKey = (clientId: string) => ["conversations", "client", clientId] as const;

function ClientList({ clientId }: { clientId: string }) {
  const qc = useQueryClient();

  const chats = useQuery({
    queryKey: conversationsKey(clientId),
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          "id, client_id, character_id, status, last_message_at, last_message_preview, characters(id, name, avatar_url)",
        )
        .eq("client_id", clientId)
        .is("client_hidden_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .abortSignal(signal);
      if (error) throw error;
      signal.throwIfAborted();
      if (data.some((row) => row.client_id !== clientId))
        throw new Error("invalid_client_conversation");
      const unread = await fetchUnreadCounts(data.map((row) => row.id));
      return data.map((row) => ({
        ...row,
        client_unread_count: unread.get(row.id)?.unread_count ?? 0,
      }));
    },
  });
  const likes = useQuery({
    queryKey: likedProfilesKey(clientId),
    gcTime: 0,
    queryFn: ({ signal }) => fetchLikedProfiles(clientId, signal),
  });

  useEffect(() => {
    let subscribed = true;
    const target = { queryKey: conversationsKey(clientId), exact: true };
    const refreshChats = async () => {
      if (!subscribed) return;
      await qc.cancelQueries(target);
      if (subscribed) await qc.invalidateQueries(target);
    };
    const channel = supabase
      .channel(`conversations-client:${clientId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `client_id=eq.${clientId}`,
        },
        refreshChats,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_read_states",
          filter: `user_id=eq.${clientId}`,
        },
        refreshChats,
      )
      .subscribe();
    return () => {
      subscribed = false;
      supabase.removeChannel(channel);
    };
  }, [qc, clientId]);

  const rows = chats.isSuccess ? chats.data : [];
  const represented = new Set(rows.map((row) => row.character_id));
  const profiles =
    chats.isSuccess && likes.isSuccess
      ? likes.data.filter((profile) => {
          if (represented.has(profile.id)) return false;
          represented.add(profile.id);
          return true;
        })
      : [];

  return (
    <>
      <div className="max-w-3xl mx-auto p-4 md:p-8" dir="rtl">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">השיחות שלי</h1>
        </header>

        {(chats.isLoading || likes.isLoading) && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        )}

        {(chats.isError || likes.isError) && (
          <div role="alert" className="text-center py-4 text-destructive">
            {chats.isError ? "שגיאה בטעינת השיחות" : "שגיאה בטעינת הדמויות שאהבתי"}
          </div>
        )}

        {chats.isSuccess && likes.isSuccess && rows.length === 0 && profiles.length === 0 && (
          <div className="text-center py-16">
            <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground mb-4">עדיין אין לך שיחות</p>
            <Link to="/app/characters" className="text-primary hover:underline">
              גלה דמויות
            </Link>
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((c) => (
              <Link key={c.id} to="/app/chat/$conversationId" params={{ conversationId: c.id }}>
                <Card className="p-4 flex items-center gap-3 hover:bg-accent transition-colors">
                  <div className="h-12 w-12 rounded-full bg-muted overflow-hidden shrink-0">
                    {c.characters?.avatar_url ? (
                      <img
                        src={c.characters.avatar_url}
                        alt={c.characters.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center font-semibold">
                        {c.characters?.name?.[0] ?? "?"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-semibold truncate">{c.characters?.name ?? "—"}</h3>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatTime(c.last_message_at)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-sm text-muted-foreground truncate">
                        {c.last_message_preview ?? STATUS_LABEL[c.status] ?? ""}
                      </p>
                      {c.client_unread_count > 0 && (
                        <span className="bg-primary text-primary-foreground text-xs rounded-full h-5 min-w-5 px-1.5 flex items-center justify-center shrink-0">
                          {c.client_unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
        {profiles.length > 0 && (
          <section aria-labelledby="liked-profiles" className="mt-6">
            <h2 id="liked-profiles" className="mb-2 font-semibold">
              דמויות שאהבתי
            </h2>
            {profiles.map((profile) => (
              <Link
                key={profile.id}
                to="/app/characters/$characterId"
                params={{ characterId: profile.id }}
                className="flex items-center gap-3 border-b py-3 hover:bg-accent focus-visible:bg-accent"
              >
                <Heart aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                <span className="text-sm text-muted-foreground">צפייה בפרופיל</span>
              </Link>
            ))}
          </section>
        )}
      </div>
    </>
  );
}
