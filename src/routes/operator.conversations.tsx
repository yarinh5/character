import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fetchUnreadCounts, logSupabaseError } from "@/lib/readStates";
import { useOperator, ConversationStatusBadge } from "@/components/operator/OperatorLayout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/operator/conversations")({
  component: OperatorConversationsPage,
});

type Row = {
  id: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  operator_unread_count: number;
  client_id: string;
  characters: { id: string; name: string; avatar_url: string | null } | null;
  profiles: { display_name: string | null; avatar_url: string | null } | null;
};

const FILTERS = [
  { value: "all", label: "הכל" },
  { value: "waiting", label: "ממתינות" },
  { value: "open", label: "פתוחות" },
  { value: "answered", label: "נענו" },
  { value: "closed", label: "סגורות" },
] as const;

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function OperatorConversationsPage() {
  const { operator, isAdmin } = useOperator();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const [characterFilter, setCharacterFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["operator-conversations", operator?.id ?? "admin"],
    queryFn: async () => {
      let characterIds: string[] | null = null;
      if (operator && !isAdmin) {
        const { data: assignments, error: assignmentsError } = await supabase
          .from("character_operator_assignments")
          .select("character_id")
          .eq("operator_id", operator.id);
        if (assignmentsError) {
          logSupabaseError("operator.conversations assignments", assignmentsError);
          throw assignmentsError;
        }
        characterIds = (assignments ?? []).map((assignment) => assignment.character_id);
        if (characterIds.length === 0) return [];
      }

      let q = supabase
        .from("conversations")
        .select(
          "id, status, last_message_at, last_message_preview, operator_unread_count, client_id, characters(id, name, avatar_url)",
        )
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(300);
      if (characterIds) q = q.in("character_id", characterIds);
      const { data, error } = await q;
      if (error) {
        logSupabaseError("operator.conversations conversations", error);
        throw error;
      }

      const clientIds = Array.from(new Set((data ?? []).map((c) => c.client_id)));
      let profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();
      if (clientIds.length > 0) {
        const { data: profs, error: profilesError } = await supabase
          .from("profiles")
          .select("user_id, display_name, avatar_url")
          .in("user_id", clientIds);
        if (profilesError) logSupabaseError("operator.conversations profiles", profilesError);
        profileMap = new Map((profs ?? []).map((p) => [p.user_id, { display_name: p.display_name, avatar_url: p.avatar_url }]));
      }

      const unread = await fetchUnreadCounts((data ?? []).map((c) => c.id));
      return (data ?? []).map((c) => ({
        ...c,
        operator_unread_count: unread.get(c.id)?.unread_count ?? 0,
        profiles: profileMap.get(c.client_id) ?? null,
      })) as Row[];
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("operator-conversations-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        qc.invalidateQueries({ queryKey: ["operator-conversations"] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_read_states", filter: user?.id ? `user_id=eq.${user.id}` : undefined },
        () => qc.invalidateQueries({ queryKey: ["operator-conversations"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc, user?.id]);

  const characters = useMemo(() => {
    const map = new Map<string, string>();
    (data ?? []).forEach((c) => {
      if (c.characters) map.set(c.characters.id, c.characters.name);
    });
    return Array.from(map.entries());
  }, [data]);

  const filtered = useMemo(() => {
    let list = data ?? [];
    if (filter !== "all") list = list.filter((c) => c.status === filter);
    if (characterFilter !== "all") list = list.filter((c) => c.characters?.id === characterFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) => (c.profiles?.display_name ?? "").toLowerCase().includes(q));
    }
    // unread first, then last_message_at
    return [...list].sort((a, b) => {
      const ua = a.operator_unread_count > 0 ? 1 : 0;
      const ub = b.operator_unread_count > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
  }, [data, filter, characterFilter, search]);

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">שיחות</h1>
      </header>

      <div className="space-y-3 mb-4">
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם לקוח..."
            className="pr-9"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                filter === f.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-input hover:bg-accent"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {characters.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setCharacterFilter("all")}
              className={`px-3 py-1 rounded-full text-xs border ${
                characterFilter === "all" ? "bg-secondary border-secondary" : "border-input"
              }`}
            >
              כל הדמויות
            </button>
            {characters.map(([id, name]) => (
              <button
                key={id}
                onClick={() => setCharacterFilter(id)}
                className={`px-3 py-1 rounded-full text-xs border ${
                  characterFilter === id ? "bg-secondary border-secondary" : "border-input"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-destructive">
          שגיאה בטעינה
          <div className="mt-2 text-xs text-muted-foreground">
            {(error as { message?: string }).message}
          </div>
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-16">
          <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">אין שיחות תואמות</p>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((c) => (
          <Link key={c.id} to="/operator/chat/$conversationId" params={{ conversationId: c.id }}>
            <Card className="p-4 flex items-center gap-3 hover:bg-accent transition-colors">
              <div className="flex -space-x-2 -space-x-reverse shrink-0">
                <div className="h-11 w-11 rounded-full bg-muted overflow-hidden border-2 border-card">
                  {c.characters?.avatar_url ? (
                    <img src={c.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center font-semibold">
                      {c.characters?.name?.[0] ?? "?"}
                    </div>
                  )}
                </div>
                <div className="h-11 w-11 rounded-full bg-muted overflow-hidden border-2 border-card">
                  {c.profiles?.avatar_url ? (
                    <img src={c.profiles.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-sm font-medium">
                      {c.profiles?.display_name?.[0] ?? "?"}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold truncate">{c.characters?.name ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {c.profiles?.display_name ?? "לקוח"}
                  </span>
                  <ConversationStatusBadge status={c.status} />
                </div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <p className="text-sm text-muted-foreground truncate">{c.last_message_preview ?? "—"}</p>
                  <span className="text-xs text-muted-foreground shrink-0">{formatTime(c.last_message_at)}</span>
                </div>
              </div>
              {c.operator_unread_count > 0 && (
                <span className="bg-primary text-primary-foreground text-xs rounded-full h-6 min-w-6 px-2 flex items-center justify-center shrink-0">
                  {c.operator_unread_count}
                </span>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
