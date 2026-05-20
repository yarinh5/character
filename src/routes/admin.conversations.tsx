import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";

export const Route = createFileRoute("/admin/conversations")({
  component: ConversationsPage,
});

function ConversationsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [opFilter, setOpFilter] = useState<string>("all");

  const { data: aux } = useQuery({
    queryKey: ["admin-conv-aux"],
    queryFn: async () => {
      const [{ data: ops }] = await Promise.all([
        supabase.from("operators").select("id, full_name").eq("is_active", true),
      ]);
      return { ops: ops ?? [] };
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["admin-conversations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          "id, status, last_message_at, last_message_preview, client_unread_count, operator_unread_count, created_at, characters(name, avatar_url), operators(id, full_name), client_id",
        )
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      const clientIds = Array.from(new Set((data ?? []).map((c: any) => c.client_id)));
      const { data: profs } = clientIds.length
        ? await supabase.from("profiles").select("user_id, display_name, email").in("user_id", clientIds)
        : { data: [] as any[] };
      const map = new Map((profs ?? []).map((p) => [p.user_id, p]));
      return (data ?? []).map((c: any) => ({ ...c, client: map.get(c.client_id) }));
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
    if (opFilter === "none" && c.operators) return false;
    if (opFilter !== "all" && opFilter !== "none" && c.operators?.id !== opFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${c.characters?.name ?? ""} ${c.client?.display_name ?? ""} ${c.client?.email ?? ""} ${c.last_message_preview ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="שיחות" description="כל השיחות במערכת" />

      <Card className="mb-4">
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative md:col-span-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="חיפוש" className="pr-10" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הסטטוסים</SelectItem>
              <SelectItem value="open">פתוחות</SelectItem>
              <SelectItem value="waiting">ממתינות</SelectItem>
              <SelectItem value="answered">נענו</SelectItem>
              <SelectItem value="closed">סגורות</SelectItem>
              <SelectItem value="reported">דווחו</SelectItem>
            </SelectContent>
          </Select>
          <Select value={opFilter} onValueChange={setOpFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל העובדים</SelectItem>
              <SelectItem value="none">ללא עובד משויך</SelectItem>
              {(aux?.ops ?? []).map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-6"><Skeleton className="h-32" /></div>}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">לא נמצאו שיחות</p>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((c: any) => (
                <Link
                  key={c.id}
                  to="/admin/conversations/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-center gap-3 p-4 hover:bg-accent transition-colors"
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
                      <span className="font-medium truncate">{c.characters?.name ?? "—"}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {c.client?.display_name ?? c.client?.email ?? "—"} ↔ {c.operators?.full_name ?? "ללא עובד"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">{c.last_message_preview ?? "—"}</div>
                  </div>
                  <div className="text-xs text-muted-foreground hidden md:block whitespace-nowrap">
                    {c.last_message_at ? new Date(c.last_message_at).toLocaleString("he-IL") : "—"}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
