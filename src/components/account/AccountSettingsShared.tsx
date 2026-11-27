import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Award, KeyRound, Mail, RefreshCw, Shield, Trash2, User } from "lucide-react";
import { resolvePublicPasswordResetRedirect } from "@/lib/authRedirects";

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
        <InfoRow
          label="סטטוס"
          value={status === "deletion_requested" ? "בקשת מחיקה פתוחה" : status || "active"}
        />
      </CardContent>
    </Card>
  );
}

type ClientLevelProgress = {
  eligible_message_count: number;
  level: number;
  updated_at: string;
};

const LEVEL_STARTS = [0, 5, 25, 69, 251] as const;

export function ClientLevelCard({ userId }: { userId: string | undefined }) {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["client-level-progress", userId],
    enabled: Boolean(userId),
    retry: false,
    queryFn: async (): Promise<ClientLevelProgress> => {
      const { data: row, error } = await supabase
        .from("client_level_progress")
        .select("eligible_message_count, level, updated_at")
        .eq("client_id", userId as string)
        .maybeSingle();
      if (error) throw new Error("client_level_progress_unavailable");
      if (row === null) {
        return { eligible_message_count: 0, level: 1, updated_at: "" };
      }
      if (
        typeof row.eligible_message_count !== "number" ||
        !Number.isInteger(row.eligible_message_count) ||
        row.eligible_message_count < 0 ||
        typeof row.level !== "number" ||
        !Number.isInteger(row.level) ||
        row.level < 1 ||
        row.level > 5 ||
        typeof row.updated_at !== "string"
      ) {
        throw new Error("client_level_progress_malformed");
      }
      return row;
    },
  });

  const nextStart = data && data.level < 5 ? LEVEL_STARTS[data.level] : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Award className="h-4 w-4" aria-hidden="true" /> הרמה שלי
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!userId && <p className="text-sm text-muted-foreground">נדרש חיבור מאומת להצגת הרמה.</p>}
        {userId && isLoading && !data && (
          <p role="status" className="text-sm text-muted-foreground">
            טוען רמה…
          </p>
        )}
        {userId && isError && !data && (
          <div role="alert" className="flex items-center justify-between gap-3 text-sm">
            <span>טעינת הרמה נכשלה.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              נסה שוב
            </Button>
          </div>
        )}
        {data && (
          <div className="space-y-2">
            {isError && (
              <div role="alert" className="flex items-center justify-between gap-3 text-xs">
                <span>הרענון נכשל. מוצגת הרמה האחרונה שהתקבלה.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                >
                  <RefreshCw className="me-1 h-3.5 w-3.5" aria-hidden="true" /> רענון
                </Button>
              </div>
            )}
            <div className="text-3xl font-bold tabular-nums">רמה {data.level}</div>
            <p className="text-sm text-muted-foreground">
              {data.eligible_message_count} הודעות מזכות
              {nextStart === null
                ? " · הגעת לרמה הגבוהה ביותר"
                : ` · עוד ${Math.max(0, nextStart - data.eligible_message_count)} לרמה הבאה`}
            </p>
          </div>
        )}
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
  const deletionRequestKey = useRef<string | null>(null);
  const deletionRequestInFlight = useRef(false);

  const sendReset = async () => {
    if (!email || resetting) return;
    setResetting(true);
    const redirectTo = resolvePublicPasswordResetRedirect(import.meta.env);
    if (!redirectTo) {
      setResetting(false);
      toast.error("שחזור הסיסמה אינו מוגדר כעת");
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    setResetting(false);
    if (error) {
      toast.error("שליחת איפוס סיסמה נכשלה");
      return;
    }
    toast.success("נשלח אימייל לאיפוס סיסמה");
  };

  const requestDeletion = async () => {
    if (!userId || requestingDelete || deletionRequestInFlight.current) return;
    deletionRequestInFlight.current = true;
    deletionRequestKey.current ??= crypto.randomUUID();
    setRequestingDelete(true);
    try {
      const { data, error } = await supabase.functions.invoke("account-deletion-request", {
        body: { idempotency_key: deletionRequestKey.current },
      });
      const request =
        data && typeof data === "object" && "request" in data
          ? (data.request as Record<string, unknown>)
          : null;
      if (
        error ||
        !request ||
        typeof request.id !== "string" ||
        request.status !== "awaiting_verification" ||
        typeof request.requested_at !== "string" ||
        data.delivery_status !== "provider_requested"
      ) {
        toast.error("בקשת המחיקה נכשלה");
        return;
      }
      deletionRequestKey.current = null;
      onDeletionRequested?.();
      setDeleteOpen(false);
      toast.success("בקשת האימות הועברה לספק הדוא״ל");
    } catch {
      toast.error("בקשת המחיקה נכשלה");
    } finally {
      deletionRequestInFlight.current = false;
      setRequestingDelete(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">אבטחה וחשבון</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            שינוי אימייל מנוהל כרגע מחוץ למסך הזה כדי למנוע בעיות אימות. אפשר לאפס סיסמה דרך האימייל
            הקיים.
          </div>
          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={sendReset}
              disabled={!email || resetting}
              className="gap-2"
            >
              <KeyRound className="h-4 w-4" />
              {resetting ? "שולח..." : "שלח איפוס סיסמה"}
            </Button>
          </div>
          <Button
            type="button"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            className="w-full gap-2"
          >
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
              הבקשה תירשם ותדרוש אימות חד־פעמי בדוא״ל. לאחר האימות החשבון ייחסם לפעילות חדשה,
              ויינתנו שבעה ימים לביטול לאחר כניסה מאומתת חדשה. הטיפול בתוכן האישי מיועד להסתיים בתוך
              30 ימים ממועד האימות; סיום במערכת הפעילה אינו מבטיח מחיקה מיידית מגיבויים.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={requestingDelete}
            >
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
