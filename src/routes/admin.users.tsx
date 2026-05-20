import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Edit, KeyRound, Ban, CheckCircle2, Trash2, Search, UserCog, Mail } from "lucide-react";

import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminResetPassword,
  adminSetStatus,
  adminSoftDeleteUser,
} from "@/lib/admin-users.functions";
import { adminImpersonate, adminSendPasswordReset } from "@/lib/impersonation.functions";
import { supabase } from "@/integrations/supabase/client";
import { startImpersonation } from "@/components/common/ImpersonationBanner";

export const Route = createFileRoute("/admin/users")({
  component: UsersPage,
});

type Row = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
  role: "admin" | "operator" | "client";
};

const ROLE_LABEL: Record<Row["role"], string> = {
  admin: "מנהל",
  operator: "עובד",
  client: "לקוח",
};

function UsersPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(adminListUsers);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Row["role"]>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "blocked">("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [resetting, setResetting] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => listFn(),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.display_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, search, roleFilter, statusFilter]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader
        title="ניהול משתמשים"
        description="כל המשתמשים במערכת — לקוחות, עובדים ומנהלים"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 ml-1" /> משתמש חדש
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="חיפוש לפי שם או אימייל"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pr-9"
            />
          </div>
          <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as typeof roleFilter)}>
            <SelectTrigger className="md:w-40"><SelectValue placeholder="תפקיד" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל התפקידים</SelectItem>
              <SelectItem value="admin">מנהל</SelectItem>
              <SelectItem value="operator">עובד</SelectItem>
              <SelectItem value="client">לקוח</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="md:w-40"><SelectValue placeholder="סטטוס" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הסטטוסים</SelectItem>
              <SelectItem value="active">פעיל</SelectItem>
              <SelectItem value="blocked">חסום</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-6 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
          {isError && (
            <div className="p-6 text-center">
              <p className="text-destructive mb-3">{(error as Error)?.message ?? "שגיאה בטעינה"}</p>
              <Button variant="outline" onClick={() => refetch()}>נסה שוב</Button>
            </div>
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">לא נמצאו משתמשים</p>
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((u) => (
                <div key={u.user_id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="h-10 w-10 rounded-full bg-muted overflow-hidden flex-shrink-0">
                    {u.avatar_url ? (
                      <img src={u.avatar_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-sm font-medium">
                        {(u.display_name ?? u.email ?? "?")[0]?.toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <div className="font-medium">{u.display_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{u.email ?? "—"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                      {ROLE_LABEL[u.role]}
                    </span>
                    <StatusBadge status={u.status} />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    <Button size="sm" variant="ghost" title="עריכה" onClick={() => setEditing(u)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" title="איפוס סיסמה" onClick={() => setResetting(u)}>
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <SendResetButton user={u} />
                    <ImpersonateButton user={u} />
                    <ToggleStatusButton user={u} onDone={invalidate} />
                    <Button size="sm" variant="ghost" title="מחיקה" onClick={() => setDeleting(u)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); invalidate(); }}
        />
      )}
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => setResetting(null)}
        />
      )}
      {deleting && (
        <DeleteConfirm
          user={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => { setDeleting(null); invalidate(); }}
        />
      )}
    </div>
  );
}

function ToggleStatusButton({ user, onDone }: { user: Row; onDone: () => void }) {
  const setStatus = useServerFn(adminSetStatus);
  const [busy, setBusy] = useState(false);
  const blocked = user.status === "blocked";
  const click = async () => {
    setBusy(true);
    try {
      await setStatus({ data: { user_id: user.user_id, status: blocked ? "active" : "blocked" } });
      toast.success(blocked ? "המשתמש שוחרר" : "המשתמש נחסם");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={click} disabled={busy} title={blocked ? "שחרור חסימה" : "חסימה"}>
      {blocked ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Ban className="h-4 w-4 text-warning" />}
    </Button>
  );
}

function SendResetButton({ user }: { user: Row }) {
  const send = useServerFn(adminSendPasswordReset);
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      const res = await send({ data: { user_id: user.user_id } });
      if (res.action_link) {
        await navigator.clipboard.writeText(res.action_link).catch(() => {});
        toast.success("קישור איפוס הועתק ללוח");
      } else {
        toast.success("נשלח אימייל איפוס סיסמה");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={click} disabled={busy} title="שלח קישור איפוס סיסמה">
      <Mail className="h-4 w-4" />
    </Button>
  );
}

function ImpersonateButton({ user }: { user: Row }) {
  const impersonate = useServerFn(adminImpersonate);
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (!confirm(`להתחזות ל-${user.email}? התנתקות מחשבונך תידרש לסיום ההתחזות.`)) return;
    setBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const adminRefresh = sessionData.session?.refresh_token;
      const adminEmail = sessionData.session?.user?.email;
      if (!adminRefresh || !adminEmail) {
        toast.error("אין session פעיל");
        return;
      }
      const res = await impersonate({ data: { user_id: user.user_id } });
      if (!res.action_link) {
        toast.error("יצירת קישור נכשלה");
        return;
      }
      startImpersonation(adminRefresh, adminEmail, res.email);
      window.location.href = res.action_link;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={click} disabled={busy} title="התחזה למשתמש">
      <UserCog className="h-4 w-4" />
    </Button>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useServerFn(adminCreateUser);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Row["role"]>("client");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !password || !fullName) return toast.error("נא למלא את כל השדות");
    if (password.length < 8) return toast.error("הסיסמה חייבת להיות לפחות 8 תווים");
    setBusy(true);
    try {
      await create({ data: { email: email.trim(), password, full_name: fullName.trim(), role } });
      toast.success("משתמש נוצר");
      onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>יצירת משתמש חדש</DialogTitle>
          <DialogDescription>המשתמש ייווצר ויאומת אוטומטית.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>סיסמה (לפחות 8 תווים)</Label>
            <Input type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <Label>תפקיד</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Row["role"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="client">לקוח</SelectItem>
                <SelectItem value="operator">עובד</SelectItem>
                <SelectItem value="admin">מנהל</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "יוצר..." : "צור"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const update = useServerFn(adminUpdateUser);
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [status, setStatus] = useState<"active" | "blocked">(
    user.status === "blocked" ? "blocked" : "active",
  );
  const [role, setRole] = useState<Row["role"]>(user.role);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const payload: {
        user_id: string;
        display_name?: string;
        email?: string;
        status?: "active" | "blocked";
        role?: Row["role"];
      } = { user_id: user.user_id };
      if (displayName.trim() && displayName !== user.display_name)
        payload.display_name = displayName.trim();
      if (email.trim() && email !== user.email) payload.email = email.trim();
      if (status !== user.status) payload.status = status;
      if (role !== user.role) payload.role = role;
      await update({ data: payload });
      toast.success("עודכן");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>עריכת משתמש</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם תצוגה</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>תפקיד</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Row["role"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="client">לקוח</SelectItem>
                <SelectItem value="operator">עובד</SelectItem>
                <SelectItem value="admin">מנהל</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>סטטוס</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as "active" | "blocked")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">פעיל</SelectItem>
                <SelectItem value="blocked">חסום</SelectItem>
              </SelectContent>
            </Select>
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

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const reset = useServerFn(adminResetPassword);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 8) return toast.error("לפחות 8 תווים");
    setBusy(true);
    try {
      await reset({ data: { user_id: user.user_id, password } });
      toast.success("הסיסמה אופסה");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>איפוס סיסמה</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <div>
          <Label>סיסמה חדשה</Label>
          <Input type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>אפס</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirm({
  user,
  onClose,
  onDone,
}: {
  user: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const del = useServerFn(adminSoftDeleteUser);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await del({ data: { user_id: user.user_id } });
      toast.success("המשתמש נמחק");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>מחיקת משתמש</AlertDialogTitle>
          <AlertDialogDescription>
            פעולה זו תחסום את המשתמש ותסמן אותו כמחוק. הנתונים ההיסטוריים יישמרו.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            מחק
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
