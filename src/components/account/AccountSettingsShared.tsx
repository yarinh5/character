import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { KeyRound, Mail, Shield, Trash2, User } from "lucide-react";

const ROLE_LABELS: Record<AppRole, string> = {
  client: "לקוח",
  operator: "עובד",
  admin: "מנהל",
};

export function roleLabel(role: AppRole | null | undefined) {
  return role ? ROLE_LABELS[role] : "לא ידוע";
}

export function AccountSummaryCard({
  displayName,
  email,
  role,
  status,
}: {
  displayName: string | null | undefined;
  email: string | null | undefined;
  role: AppRole | null | undefined;
  status?: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">פרטי חשבון</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <InfoRow icon={User} label="שם תצוגה" value={displayName || "—"} />
        <InfoRow icon={Mail} label="אימייל" value={email || "—"} />
        <InfoRow icon={Shield} label="תפקיד" value={roleLabel(role)} />
        <InfoRow label="סטטוס" value={status === "deletion_requested" ? "בקשת מחיקה פתוחה" : status || "active"} />
      </CardContent>
    </Card>
  );
}

export function AccountSecurityCard({
  userId,
  email,
  onDeletionRequested,
}: {
  userId: string | undefined;
  email: string | null | undefined;
  onDeletionRequested?: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [requestingDelete, setRequestingDelete] = useState(false);

  const sendReset = async () => {
    if (!email || resetting) return;
    setResetting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetting(false);
    if (error) {
      toast.error("שליחת איפוס סיסמה נכשלה");
      return;
    }
    toast.success("נשלח אימייל לאיפוס סיסמה");
  };

  const requestDeletion = async () => {
    if (!userId || requestingDelete) return;
    setRequestingDelete(true);
    const { error } = await supabase
      .from("profiles")
      .update({ status: "deletion_requested" })
      .eq("user_id", userId);
    setRequestingDelete(false);
    if (error) {
      toast.error("בקשת המחיקה נכשלה");
      return;
    }
    onDeletionRequested?.();
    setDeleteOpen(false);
    toast.success("בקשת מחיקת החשבון התקבלה ותטופל ידנית");
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">אבטחה וחשבון</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            שינוי אימייל מנוהל כרגע מחוץ למסך הזה כדי למנוע בעיות אימות. אפשר לאפס סיסמה דרך האימייל הקיים.
          </div>
          <div className="grid gap-2">
            <Button type="button" variant="outline" onClick={sendReset} disabled={!email || resetting} className="gap-2">
              <KeyRound className="h-4 w-4" />
              {resetting ? "שולח..." : "שלח איפוס סיסמה"}
            </Button>
          </div>
          <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)} className="w-full gap-2">
            <Trash2 className="h-4 w-4" />
            בקשת מחיקת חשבון
          </Button>
        </CardContent>
      </Card>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>בקשת מחיקת חשבון</DialogTitle>
            <DialogDescription className="leading-6">
              לא נמחק פיזית את החשבון בשלב הזה כדי לשמור היסטוריית שיחות, קרדיטים ו־audit. הבקשה תסומן במערכת
              ותטופל ידנית על ידי מנהל.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={requestingDelete}>
              ביטול
            </Button>
            <Button variant="destructive" onClick={requestDeletion} disabled={requestingDelete}>
              {requestingDelete ? "שולח..." : "שלח בקשה"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof User;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}
