import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Edit, Link as LinkIcon } from "lucide-react";

export const Route = createFileRoute("/admin/operators")({
  component: OperatorsPage,
});

type Operator = {
  id: string;
  user_id: string;
  full_name: string;
  is_active: boolean;
  availability_status: "available" | "busy" | "offline";
  created_at: string;
};

function OperatorsPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Operator | null>(null);
  const [assignOp, setAssignOp] = useState<Operator | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-operators"],
    queryFn: async () => {
      const { data: ops } = await supabase
        .from("operators")
        .select("id, user_id, full_name, is_active, availability_status, created_at")
        .order("created_at", { ascending: false });
      const opsList = (ops ?? []) as Operator[];
      const ids = opsList.map((o) => o.id);
      const userIds = opsList.map((o) => o.user_id);

      const [{ data: assigns }, { data: convs }, { data: profs }] = await Promise.all([
        ids.length
          ? supabase.from("character_operator_assignments").select("operator_id").in("operator_id", ids)
          : Promise.resolve({ data: [] as { operator_id: string }[] }),
        ids.length
          ? supabase.from("conversations").select("assigned_operator_id, status").in("assigned_operator_id", ids)
          : Promise.resolve({ data: [] as { assigned_operator_id: string; status: string }[] }),
        userIds.length
          ? supabase.from("profiles").select("user_id, email").in("user_id", userIds as string[])
          : Promise.resolve({ data: [] as { user_id: string; email: string | null }[] }),
      ]);
      const charsCount = new Map<string, number>();
      (assigns ?? []).forEach((a) => charsCount.set(a.operator_id, (charsCount.get(a.operator_id) ?? 0) + 1));
      const activeCount = new Map<string, number>();
      (convs ?? []).forEach((c) => {
        if (c.status !== "closed" && c.assigned_operator_id)
          activeCount.set(c.assigned_operator_id, (activeCount.get(c.assigned_operator_id) ?? 0) + 1);
      });
      const emailMap = new Map<string, string | null>();
      (profs ?? []).forEach((p) => emailMap.set(p.user_id, p.email));

      return opsList.map((o) => ({
        ...o,
        email: emailMap.get(o.user_id) ?? null,
        chars: charsCount.get(o.id) ?? 0,
        active: activeCount.get(o.id) ?? 0,
      }));
    },
  });

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader
        title="עובדים"
        description="ניהול עובדים ושיוך לדמויות"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 ml-1" /> עובד חדש
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-6"><Skeleton className="h-32" /></div>}
          {!isLoading && (data?.length ?? 0) === 0 && (
            <p className="text-center text-muted-foreground py-12">אין עובדים עדיין</p>
          )}
          {!isLoading && data && data.length > 0 && (
            <div className="divide-y">
              {data.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="flex-1 min-w-[200px]">
                    <div className="font-medium">{o.full_name}</div>
                    <div className="text-xs text-muted-foreground">{o.email ?? "—"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <StatusBadge status={o.availability_status} />
                    <StatusBadge status={o.is_active ? "active" : "inactive"} />
                  </div>
                  <div className="hidden md:flex gap-4 text-xs text-muted-foreground">
                    <span>{o.chars} דמויות</span>
                    <span>{o.active} שיחות</span>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setAssignOp(o)}>
                      <LinkIcon className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateOperatorDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            qc.invalidateQueries({ queryKey: ["admin-operators"] });
          }}
        />
      )}
      {editing && (
        <EditOperatorDialog
          op={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["admin-operators"] });
          }}
        />
      )}
      {assignOp && (
        <AssignCharactersDialog
          op={assignOp}
          onClose={() => setAssignOp(null)}
          onSaved={() => {
            setAssignOp(null);
            qc.invalidateQueries({ queryKey: ["admin-operators"] });
          }}
        />
      )}
    </div>
  );
}

function CreateOperatorDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !fullName) {
      toast.error("נא למלא את כל השדות");
      return;
    }
    setBusy(true);
    try {
      const { data: prof } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("email", email.trim().toLowerCase())
        .maybeSingle();
      if (!prof) {
        toast.error("לא נמצא משתמש רשום עם האימייל הזה. בקש מהמשתמש להירשם תחילה.");
        return;
      }
      const { data: existing } = await supabase
        .from("operators")
        .select("id")
        .eq("user_id", prof.user_id)
        .maybeSingle();
      if (existing) {
        toast.error("המשתמש הזה כבר עובד במערכת");
        return;
      }
      const { error: roleErr } = await supabase
        .from("user_roles")
        .upsert({ user_id: prof.user_id, role: "operator" }, { onConflict: "user_id,role" });
      if (roleErr) throw roleErr;
      const { error: opErr } = await supabase.from("operators").insert({
        user_id: prof.user_id,
        full_name: fullName.trim(),
      });
      if (opErr) throw opErr;
      toast.success("עובד נוצר בהצלחה");
      onCreated();
    } catch (e: any) {
      toast.error(e.message ?? "שגיאה ביצירת עובד");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>יצירת עובד חדש</DialogTitle>
          <DialogDescription>
            המשתמש חייב להירשם תחילה דרך עמוד ההרשמה. הזן את האימייל שלו כדי להפוך אותו לעובד.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>אימייל של משתמש קיים</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
          </div>
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>
            {busy ? "יוצר..." : "צור עובד"}
          </Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOperatorDialog({
  op,
  onClose,
  onSaved,
}: {
  op: Operator;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(op.full_name);
  const [isActive, setIsActive] = useState(op.is_active);
  const [status, setStatus] = useState(op.availability_status);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const { error } = await supabase
      .from("operators")
      .update({ full_name: fullName, is_active: isActive, availability_status: status })
      .eq("id", op.id);
    setBusy(false);
    if (error) {
      toast.error("שמירה נכשלה");
      return;
    }
    toast.success("עודכן");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>עריכת עובד</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <Label>סטטוס זמינות</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="available">זמין</SelectItem>
                <SelectItem value="busy">עסוק</SelectItem>
                <SelectItem value="offline">לא מחובר</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label>חשבון פעיל</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>שמור</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignCharactersDialog({
  op,
  onClose,
  onSaved,
}: {
  op: Operator;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-op-chars", op.id],
    queryFn: async () => {
      const [{ data: chars }, { data: assigns }] = await Promise.all([
        supabase.from("characters").select("id, name, avatar_url, is_active").order("name"),
        supabase.from("character_operator_assignments").select("character_id").eq("operator_id", op.id),
      ]);
      return {
        chars: chars ?? [],
        assigned: new Set((assigns ?? []).map((a) => a.character_id)),
      };
    },
  });

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const current = selected ?? data?.assigned ?? new Set<string>();
  const toggle = (id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const save = async () => {
    if (!data) return;
    const original = data.assigned;
    const toAdd = [...current].filter((id) => !original.has(id));
    const toRemove = [...original].filter((id) => !current.has(id));
    try {
      if (toRemove.length) {
        const { error } = await supabase
          .from("character_operator_assignments")
          .delete()
          .eq("operator_id", op.id)
          .in("character_id", toRemove);
        if (error) throw error;
      }
      if (toAdd.length) {
        const { error } = await supabase
          .from("character_operator_assignments")
          .insert(toAdd.map((cid) => ({ operator_id: op.id, character_id: cid })));
        if (error) throw error;
      }
      toast.success("השיוכים נשמרו");
      onSaved();
    } catch (e: any) {
      toast.error(e.message ?? "שמירה נכשלה");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>שיוך דמויות — {op.full_name}</DialogTitle>
        </DialogHeader>
        {isLoading && <Skeleton className="h-40" />}
        {!isLoading && data && (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {data.chars.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">אין דמויות במערכת</p>
            )}
            {data.chars.map((c) => (
              <label key={c.id} className="flex items-center gap-3 p-2 rounded hover:bg-accent cursor-pointer">
                <Checkbox checked={current.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                <div className="h-8 w-8 rounded-full bg-muted overflow-hidden">
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-xs">
                      {c.name[0]}
                    </div>
                  )}
                </div>
                <span className="text-sm">{c.name}</span>
                {!c.is_active && <span className="text-xs text-muted-foreground mr-auto">לא פעילה</span>}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button onClick={save}>שמור</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
