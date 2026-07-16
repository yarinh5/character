import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fetchUnreadCounts } from "@/lib/readStates";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageCircle } from "lucide-react";

export const Route = createFileRoute("/app/conversations")({
  component: ConversationsPage,
});

type Row = {
  id: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  client_unread_count: number;
  characters: {
    id: string;
    name: string;
    avatar_url: string | null;
  } | null;
};

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
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["conversations", "client"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          "id, status, last_message_at, last_message_preview, client_unread_count, characters(id, name, avatar_url)",
        )
        .is("client_hidden_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (error) throw error;

      const rows = (data ?? []) as unknown as Row[];
      const unread = await fetchUnreadCounts(rows.map((row) => row.id));
      return rows.map((row) => ({
        ...row,
        client_unread_count: unread.get(row.id)?.unread_count ?? 0,
      }));
    },
    enabled: !!user,
  });

  useEffect(() => {
    const channel = supabase
      .channel("conversations-client")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => qc.invalidateQueries({ queryKey: ["conversations", "client"] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_read_states", filter: user?.id ? `user_id=eq.${user.id}` : undefined },
        () => qc.invalidateQueries({ queryKey: ["conversations", "client"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, user?.id]);

  return (
    <>
      <div className="max-w-3xl mx-auto p-4 md:p-8">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">השיחות שלי</h1>
        </header>

        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        )}

        {error && <div className="text-center py-12 text-destructive">שגיאה בטעינה</div>}

        {!isLoading && data && data.length === 0 && (
          <div className="text-center py-16">
            <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground mb-4">עדיין אין לך שיחות</p>
            <Link to="/app/characters" className="text-primary hover:underline">
              גלה דמויות
            </Link>
          </div>
        )}

        {!isLoading && data && data.length > 0 && (
          <div className="space-y-2">
            {data.map((c) => (
              <Link
                key={c.id}
                to="/app/chat/$conversationId"
                params={{ conversationId: c.id }}
              >
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
      </div>
    </>
  );
}
