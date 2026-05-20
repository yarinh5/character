import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { toast } from "sonner";
import { Plus, Copy, Trash2, Mail } from "lucide-react";
import {
  adminListInvites,
  adminCreateInvite,
  adminRevokeInvite,
} from "@/lib/invites.functions";

export const Route = createFileRoute("/admin/invites")({
  component: InvitesPage,
});

function InvitesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(adminListInvites);
  const revoke = useServerFn(adminRevokeInvite);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<{ token: string; email: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => listFn(),
  });

  const onRevoke = async (id: string) => {
    if (!confirm("לבטל הזמנה זו?")) return;
    try {
      await revoke({ data: { id } });
      toast.success("בוטל");
      qc.invalidateQueries({ queryKey: ["admin-invites"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8">
      <PageHeader
        title="הזמנות עובדים"
        description="הזמן עובדים חדשים עם קישור אישי"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 ml-1" /> הזמנה חדשה
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-4 space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
          {!isLoading && (data?.length ?? 0) === 0 && (
            <div className="p-12 text-center text-muted-foreground">אין הזמנות עדיין</div>
          )}
          {!isLoading && data && data.length > 0 && (
            <div className="divide-y">
              {data.map((inv) => (
                <div key={inv.id} className="p-4 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[200px]">
                    <div className="font-medium">{inv.full_name}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{inv.email}</div>
                  </div>
                  <StatusChip status={inv.status} />
                  <div className="text-xs text-muted-foreground">
                    {inv.character_ids?.length ?? 0} דמויות
                  </div>
                  <div className="text-xs text-muted-foreground">
                    תוקף: {new Date(inv.expires_at).toLocaleDateString("he-IL")}
                  </div>
                  {inv.status === "pending" && (
                    <Button size="sm" variant="ghost" onClick={() => onRevoke(inv.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateInviteDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(token, email) => {
            setCreateOpen(false);
            setCreated({ token, email });
            qc.invalidateQueries({ queryKey: ["admin-invites"] });
          }}
        />
      )}

      {created && <InviteLinkDialog token={created.token} email={created.email} onClose={() => setCreated(null)} />}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "ממתינה", cls: "bg-warning/15 text-warning" },
    accepted: { label: "אושרה", cls: "bg-success/15 text-success" },
    revoked: { label: "בוטלה", cls: "bg-muted text-muted-foreground" },
    expired: { label: "פגה", cls: "bg-destructive/15 text-destructive" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.cls}`}>{s.label}</span>;
}

function CreateInviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string, email: string) => void;
}) {
  const create = useServerFn(adminCreateInvite);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data: chars } = useQuery({
    queryKey: ["chars-for-invite"],
    queryFn: async () => {
      const { data } = await supabase
        .from("characters")
        .select("id, name")
        .eq("is_active", true)
        .order("name");
      return data ?? [];
    },
  });

  const toggle = (id: string) => {
    const s = new Set(selectedChars);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedChars(s);
  };

  const submit = async () => {
    if (!email || !fullName) return toast.error("נא למלא שם ואימייל");
    setBusy(true);
    try {
      const r = await create({
        data: { email: email.trim(), full_name: fullName.trim(), character_ids: Array.from(selectedChars) },
      });
      onCreated(r.token, email.trim());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>הזמנת עובד חדש</DialogTitle>
          <DialogDescription>תיווצר הזמנה לעובד עם קישור אישי לקביעת סיסמה.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>שיוך דמויות (אופציונלי)</Label>
            <div className="border rounded-md max-h-48 overflow-y-auto p-2 space-y-1">
              {(chars ?? []).map((c) => (
                <label key={c.id} className="flex items-center gap-2 p-1.5 rounded hover:bg-accent cursor-pointer">
                  <Checkbox checked={selectedChars.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                  <span className="text-sm">{c.name}</span>
                </label>
              ))}
              {(!chars || chars.length === 0) && (
                <div className="text-xs text-muted-foreground text-center py-3">אין דמויות פעילות</div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "יוצר..." : "צור הזמנה"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteLinkDialog({ token, email, onClose }: { token: string; email: string; onClose: () => void }) {
  const url = `${window.location.origin}/accept-invite/${token}`;
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    toast.success("הקישור הועתק");
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>הזמנה נוצרה</DialogTitle>
          <DialogDescription>
            <Mail className="inline h-4 w-4 ml-1" />
            שלח את הקישור הבא אל <strong dir="ltr">{email}</strong>:
          </DialogDescription>
        </DialogHeader>
        <div className="p-3 bg-muted rounded-md break-all text-xs font-mono" dir="ltr">{url}</div>
        <DialogFooter>
          <Button onClick={copy}><Copy className="h-4 w-4 ml-1" /> העתק קישור</Button>
          <Button variant="outline" onClick={onClose}>סגירה</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
