import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useOperator } from "@/components/operator/OperatorLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { LogOut } from "lucide-react";

export const Route = createFileRoute("/operator/settings")({
  component: OperatorSettingsPage,
});

const STATUS_OPTIONS = [
  { value: "available", label: "זמין" },
  { value: "busy", label: "עסוק" },
  { value: "offline", label: "לא מחובר" },
] as const;

type AssignedRow = {
  character_id: string;
  characters: { id: string; name: string; avatar_url: string | null; availability_status: string } | null;
  openCount: number;
};

function OperatorSettingsPage() {
  const { user, signOut } = useAuth();
  const { operator, refresh } = useOperator();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState(operator?.full_name ?? "");
  const [status, setStatus] = useState(operator?.availability_status ?? "available");
  const [saving, setSaving] = useState(false);
  const [assigned, setAssigned] = useState<AssignedRow[] | null>(null);

  useEffect(() => {
    if (!operator) return;
    setFullName(operator.full_name);
    setStatus(operator.availability_status);
    (async () => {
      const { data } = await supabase
        .from("character_operator_assignments")
        .select("character_id, characters(id, name, avatar_url, availability_status)")
        .eq("operator_id", operator.id);
      const list = (data ?? []) as Array<{
        character_id: string;
        characters: AssignedRow["characters"];
      }>;
      const withCounts = await Promise.all(
        list.map(async (a) => {
          const { count } = await supabase
            .from("conversations")
            .select("id", { count: "exact", head: true })
            .eq("assigned_operator_id", operator.id)
            .eq("character_id", a.character_id)
            .neq("status", "closed");
          return { ...a, openCount: count ?? 0 };
        }),
      );
      setAssigned(withCounts);
    })();
  }, [operator]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!operator) return;
    if (fullName.trim().length < 2) {
      toast.error("שם קצר מדי");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("operators")
      .update({
        full_name: fullName.trim().slice(0, 100),
        availability_status: status,
      })
      .eq("id", operator.id);
    setSaving(false);
    if (error) {
      toast.error("שמירה נכשלה");
      return;
    }
    toast.success("נשמר");
    await refresh();
  };

  const handleLogout = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-bold">הגדרות</h1>
        <p className="text-sm text-muted-foreground mt-1">{user?.email}</p>
      </header>

      {operator ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">פרטים אישיים</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">שם מלא</Label>
                <Input
                  id="full_name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label>סטטוס זמינות</Label>
                <div className="flex gap-2">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setStatus(s.value)}
                      className={`flex-1 px-3 py-2 rounded-md text-sm border transition-colors ${
                        status === s.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-input hover:bg-accent"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" disabled={saving} className="w-full">
                {saving ? "שומר..." : "שמירה"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            אינך מוגדר כעובד במערכת. נכנסת כמנהל.
          </CardContent>
        </Card>
      )}

      {operator && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">דמויות משויכות</CardTitle>
          </CardHeader>
          <CardContent>
            {!assigned ? (
              <Skeleton className="h-20" />
            ) : assigned.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">אין דמויות משויכות</p>
            ) : (
              <div className="space-y-2">
                {assigned.map((a) => (
                  <div key={a.character_id} className="flex items-center gap-3 p-2 rounded-lg border border-border">
                    <div className="h-10 w-10 rounded-full bg-muted overflow-hidden shrink-0">
                      {a.characters?.avatar_url ? (
                        <img src={a.characters.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-sm font-semibold">
                          {a.characters?.name?.[0] ?? "?"}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{a.characters?.name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.characters?.availability_status === "available" ? "זמינה" : "לא זמינה"} ·{" "}
                        {a.openCount} שיחות פתוחות
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <Button variant="outline" className="w-full gap-2" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            התנתקות
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
