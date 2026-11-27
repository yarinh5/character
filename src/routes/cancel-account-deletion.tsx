import { useState, type ReactNode } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type DeletionStatus = {
  id: string;
  status: string;
  requested_at: string;
  confirmed_at: string | null;
  cancellation_deadline: string | null;
  content_deletion_due_at: string | null;
  active_system_completed_at: string | null;
  failure_code: string | null;
};

export const Route = createFileRoute("/cancel-account-deletion")({
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search.request === "string" ? search.request : null,
    token: typeof search.token === "string" ? search.token : null,
  }),
  component: CancelAccountDeletionPage,
});

function readDeletionStatus(value: unknown): DeletionStatus | null {
  const row = Array.isArray(value) ? value[0] : null;
  if (!row || typeof row !== "object") return null;
  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.requested_at !== "string"
  ) {
    throw new Error("account_deletion_status_malformed");
  }
  return candidate as DeletionStatus;
}

export function CancelAccountDeletionPage() {
  const { loading, session, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const search = Route.useSearch();
  const verification = { requestId: search.request, token: search.token };
  const identityId = !loading && session?.user.id ? session.user.id : null;

  const statusQuery = useQuery({
    queryKey: ["my-account-deletion", identityId],
    enabled: Boolean(identityId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_account_deletion_status");
      if (error) throw error;
      return readDeletionStatus(data);
    },
  });

  const cancel = async () => {
    const request = statusQuery.data;
    if (!request || request.status !== "cancellation_window" || cancelling) return;
    setCancelling(true);
    try {
      const functionName =
        verification.requestId && verification.token
          ? "account-deletion-cancel"
          : "account-deletion-cancel-request";
      const body =
        verification.requestId && verification.token
          ? { request_id: verification.requestId, token: verification.token }
          : {};
      const { data, error } = await supabase.functions.invoke(functionName, { body });
      const confirmed =
        functionName === "account-deletion-cancel" &&
        data &&
        typeof data === "object" &&
        data.status === "cancelled" &&
        data.requires_new_login === true;
      const emailPrepared =
        functionName === "account-deletion-cancel-request" &&
        data &&
        typeof data === "object" &&
        data.request_id === request.id &&
        data.delivery_status === "provider_requested";
      if (error || (!confirmed && !emailPrepared)) {
        toast.error("ביטול בקשת המחיקה נכשל");
        return;
      }
      if (confirmed) {
        await queryClient.invalidateQueries({ queryKey: ["my-account-deletion", identityId] });
        toast.success("בקשת המחיקה בוטלה. יש להתחבר מחדש כדי להמשיך.");
      } else {
        toast.success("בקשת קישור הביטול הועברה לספק הדוא״ל");
      }
      await signOut();
      await navigate({ to: "/login", replace: true });
    } catch {
      toast.error("ביטול בקשת המחיקה נכשל");
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return <PageMessage icon={<Loader2 className="h-5 w-5 animate-spin" />} text="מאמת זהות…" />;
  }
  if (!identityId) {
    return (
      <PageMessage
        icon={<AlertTriangle className="h-5 w-5" />}
        text="כדי לצפות בבקשה או לבטל אותה יש להתחבר מחדש לחשבון המאומת."
        action={<Button onClick={() => void navigate({ to: "/login" })}>כניסה לחשבון</Button>}
      />
    );
  }
  if (statusQuery.isLoading) {
    return (
      <PageMessage icon={<Loader2 className="h-5 w-5 animate-spin" />} text="טוען את מצב הבקשה…" />
    );
  }
  if (statusQuery.isError) {
    return (
      <PageMessage
        icon={<AlertTriangle className="h-5 w-5" />}
        text="טעינת מצב בקשת המחיקה נכשלה."
        action={<Button onClick={() => void statusQuery.refetch()}>נסה שוב</Button>}
      />
    );
  }

  const request = statusQuery.data;
  if (!request) return <PageMessage text="לא נמצאה בקשת מחיקה לחשבון זה." />;
  const canCancel = request.status === "cancellation_window";
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center p-4" dir="rtl">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>מצב מחיקת החשבון</CardTitle>
          <CardDescription>
            המצב מוצג לפי נתוני השרת. סיום במערכת הפעילה אינו מבטיח פקיעה מיידית מגיבויים.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt>מצב</dt>
              <dd>{statusLabel(request.status)}</dd>
            </div>
            {request.cancellation_deadline && (
              <div className="flex justify-between gap-3">
                <dt>ניתן לבטל עד</dt>
                <dd>{new Date(request.cancellation_deadline).toLocaleString("he-IL")}</dd>
              </div>
            )}
            {request.content_deletion_due_at && (
              <div className="flex justify-between gap-3">
                <dt>יעד טיפול בתוכן אישי</dt>
                <dd>{new Date(request.content_deletion_due_at).toLocaleString("he-IL")}</dd>
              </div>
            )}
          </dl>
          {request.failure_code && (
            <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
              הטיפול נעצר ונדרש בירור מורשה. לא דווחה השלמת מחיקה.
            </p>
          )}
          {canCancel ? (
            <Button className="w-full" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling
                ? "מאמת…"
                : verification.requestId && verification.token
                  ? "אשר ביטול לאחר אימות"
                  : "שלח קישור לביטול הבקשה"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              הבקשה אינה נמצאת בחלון שבו ניתן לבטל אותה דרך המסלול הרגיל.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    awaiting_verification: "ממתינה לאימות בדוא״ל",
    cancellation_window: "מאושרת — בתוך חלון הביטול",
    cancelled: "בוטלה",
    blocked_retention: "חסומה עד להכרעת שימור",
    ready_for_deletion: "מוכנה לטיפול בלתי־הפיך",
    processing: "בטיפול",
    active_system_completed: "הושלמה במערכת הפעילה",
    failed: "נעצרה ונדרשת בדיקה",
  };
  return labels[status] ?? status;
}

function PageMessage({
  icon,
  text,
  action,
}: {
  icon?: ReactNode;
  text: string;
  action?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center p-4" dir="rtl">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          {icon}
          <p>{text}</p>
          {action}
        </CardContent>
      </Card>
    </main>
  );
}
