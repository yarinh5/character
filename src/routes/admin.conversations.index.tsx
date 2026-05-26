import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageCircle, Search } from "lucide-react";

export const Route = createFileRoute("/admin/conversations/")({
  component: ConversationsPage,
});

function ConversationsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-conversations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          "id, status, last_message_at, last_message_preview, client_unread_count, operator_unread_count, created_at, character_id, characters(name, avatar_url), operators(id, full_name), client_id",
        )
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;

      const clientIds = Array.from(new Set((data ?? []).map((c: any) => c.client_id)));
      const characterIds = Array.from(new Set((data ?? []).map((c: any) => c.character_id).filter(Boolean)));
      const { data: profs } = clientIds.length
        ? await supabase.from("profiles").select("user_id, display_name, email").in("user_id", clientIds)
        : { data: [] as any[] };
      const { data: assignments } = characterIds.length
        ? await supabase
            .from("character_operator_assignments")
            .select("character_id, operators(full_name, is_active)")
            .in("character_id", characterIds)
        : { data: [] as any[] };

      const map = new Map((profs ?? []).map((p) => [p.user_id, p]));
      const sharedInboxMap = new Map<string, string[]>();
      (assignments ?? []).forEach((a: any) => {
        if (!a.operators?.is_active) return;
        const names = sharedInboxMap.get(a.character_id) ?? [];
        names.push(a.operators.full_name);
        sharedInboxMap.set(a.character_id, names);
      });

      return (data ?? []).map((c: any) => ({
        ...c,
        client: map.get(c.client_id),
        sharedInboxOperators: sharedInboxMap.get(c.character_id) ?? [],
      }));
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("admin-convs")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        qc.invalidateQueries({ queryKey: ["admin-conversations"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const filtered = (data ?? []).filter((c: any) => {
    if (status !== "all" && c.status !== status) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${c.characters?.name ?? ""} ${c.client?.display_name ?? ""} ${c.client?.email ?? ""} ${c.sharedInboxOperators?.join(" ") ?? ""} ${c.last_message_preview ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="שיחות" description="כל השיחות במערכת" />

      <Card className="mb-4">
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="relative md:col-span-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="חיפוש" className="pr-10" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הסטטוסים</SelectItem>
              <SelectItem value="open">פתוחות</SelectItem>
              <SelectItem value="waiting">ממתינות</SelectItem>
              <SelectItem value="answered">נענו</SelectItem>
              <SelectItem value="closed">סגורות</SelectItem>
              <SelectItem value="reported">דווחו</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-6">
              <Skeleton className="h-32" />
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">לא נמצאו שיחות</p>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((c: any) => (
                <div key={c.id} className="flex items-center gap-3 p-4 hover:bg-accent transition-colors">
                  <Link
                    to="/admin/conversations/$conversationId"
                    params={{ conversationId: c.id }}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <div className="h-10 w-10 rounded-full bg-muted overflow-hidden shrink-0">
                      {c.characters?.avatar_url ? (
                        <img src={c.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-sm font-semibold">
                          {c.characters?.name?.[0] ?? "?"}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{c.characters?.name ?? "-"}</span>
                        <StatusBadge status={c.status} />
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {c.client?.display_name ?? c.client?.email ?? "-"} ↔ Shared Inbox:{" "}
                        {c.sharedInboxOperators?.length ? c.sharedInboxOperators.join(", ") : "אין עובדים משויכים לדמות"}
                      </div>
                      {c.operators?.full_name && (
                        <div className="text-[11px] text-muted-foreground/80 truncate">
                          legacy assignment metadata: {c.operators.full_name}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground truncate mt-0.5">{c.last_message_preview ?? "-"}</div>
                    </div>
                    <div className="text-xs text-muted-foreground hidden md:block whitespace-nowrap">
                      {c.last_message_at ? new Date(c.last_message_at).toLocaleString("he-IL") : "-"}
                    </div>
                  </Link>
                  <Button asChild size="sm" variant="outline" className="shrink-0 gap-2">
                    <Link to="/admin/conversations/$conversationId" params={{ conversationId: c.id }}>
                      <MessageCircle className="h-4 w-4" />
                      פתח שיחה
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
