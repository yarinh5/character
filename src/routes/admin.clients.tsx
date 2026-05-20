import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Search, Eye } from "lucide-react";

export const Route = createFileRoute("/admin/clients")({
  component: ClientsPage,
});

type Row = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

function ClientsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "blocked" | "today">("all");
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-clients"],
    queryFn: async () => {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "client");
      const ids = (roles ?? []).map((r) => r.user_id);
      if (ids.length === 0) return [];
      const { data: profs } = await supabase
        .from("profiles")
        .select("user_id, email, display_name, status, created_at")
        .in("user_id", ids)
        .order("created_at", { ascending: false });
      return (profs ?? []) as Row[];
    },
  });

  const filtered = (data ?? []).filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (!(r.email?.toLowerCase().includes(q) || r.display_name?.toLowerCase().includes(q)))
        return false;
    }
    if (filter === "active" && r.status !== "active") return false;
    if (filter === "blocked" && r.status !== "blocked") return false;
    if (filter === "today") {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      if (new Date(r.created_at) < t) return false;
    }
    return true;
  });

  const setStatus = async (uid: string, status: string) => {
    const { error } = await supabase.from("profiles").update({ status }).eq("user_id", uid);
    if (error) {
      toast.error("עדכון נכשל");
      return;
    }
    toast.success("סטטוס עודכן");
    qc.invalidateQueries({ queryKey: ["admin-clients"] });
    if (selected) setSelected({ ...selected, status });
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader title="לקוחות" description="ניהול כל הלקוחות במערכת" />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש לפי שם או אימייל"
              className="pr-10"
            />
          </div>
          <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
            <SelectTrigger className="w-full md:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הלקוחות</SelectItem>
              <SelectItem value="active">פעילים</SelectItem>
              <SelectItem value="blocked">חסומים</SelectItem>
              <SelectItem value="today">חדשים היום</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-6"><Skeleton className="h-32" /></div>}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">לא נמצאו לקוחות</p>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((r) => (
                <div key={r.user_id} className="flex items-center gap-3 p-4">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center font-semibold">
                    {(r.display_name ?? r.email ?? "?")[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{r.display_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground truncate">{r.email}</div>
                  </div>
                  <div className="hidden md:block text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString("he-IL")}
                  </div>
                  <StatusBadge status={r.status} />
                  <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ClientDetailsDialog client={selected} onClose={() => setSelected(null)} onSetStatus={setStatus} />
    </div>
  );
}

function ClientDetailsDialog({
  client,
  onClose,
  onSetStatus,
}: {
  client: Row | null;
  onClose: () => void;
  onSetStatus: (uid: string, status: string) => Promise<void>;
}) {
  const { data } = useQuery({
    queryKey: ["admin-client-details", client?.user_id],
    enabled: !!client,
    queryFn: async () => {
      const [profile, convs] = await Promise.all([
        supabase
          .from("client_profiles")
          .select("age, gender, interests, conversation_preferences")
          .eq("user_id", client!.user_id)
          .maybeSingle(),
        supabase
          .from("conversations")
          .select("id, status, last_message_at, last_message_preview, characters(name)")
          .eq("client_id", client!.user_id)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(10),
      ]);
      return { profile: profile.data, convs: convs.data ?? [] };
    },
  });

  if (!client) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{client.display_name ?? client.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Info label="אימייל" value={client.email ?? "—"} />
            <Info label="סטטוס" value={<StatusBadge status={client.status} />} />
            <Info label="גיל" value={data?.profile?.age ?? "—"} />
            <Info label="מגדר" value={data?.profile?.gender ?? "—"} />
            <Info label="הצטרף" value={new Date(client.created_at).toLocaleDateString("he-IL")} />
          </div>
          {data?.profile?.interests && data.profile.interests.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">תחומי עניין</div>
              <div className="flex flex-wrap gap-1.5">
                {data.profile.interests.map((i, idx) => (
                  <span key={idx} className="text-xs px-2 py-1 rounded-full bg-muted">{i}</span>
                ))}
              </div>
            </div>
          )}
          {data?.profile?.conversation_preferences && (
            <Info label="העדפות שיחה" value={data.profile.conversation_preferences} />
          )}

          <div>
            <div className="text-sm font-medium mb-2">שיחות אחרונות</div>
            {(!data || data.convs.length === 0) && (
              <p className="text-xs text-muted-foreground">אין שיחות</p>
            )}
            <div className="space-y-1.5">
              {data?.convs.map((c: any) => (
                <Link
                  key={c.id}
                  to="/admin/conversations/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-center justify-between gap-2 p-2 rounded border hover:bg-accent text-sm"
                >
                  <span className="truncate">{c.characters?.name ?? "—"}</span>
                  <StatusBadge status={c.status} />
                </Link>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {client.status === "blocked" ? (
            <Button onClick={() => onSetStatus(client.user_id, "active")}>שחרור חסימה</Button>
          ) : (
            <Button variant="destructive" onClick={() => onSetStatus(client.user_id, "blocked")}>
              חסימת לקוח
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>סגירה</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
