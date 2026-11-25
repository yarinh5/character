import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/verify-account-deletion")({
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search.request === "string" ? search.request : null,
    token: typeof search.token === "string" ? search.token : null,
  }),
  component: VerifyAccountDeletionPage,
});

export function VerifyAccountDeletionPage() {
  const { loading, session, signOut } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState(false);
  const { request: requestId, token } = Route.useSearch();

  const confirm = async () => {
    if (!requestId || !token || !session?.user.id || submitting) return;
    setSubmitting(true);
    setFailure(false);
    try {
      const { data, error } = await supabase.functions.invoke("account-deletion-verify", {
        body: { request_id: requestId, token },
      });
      if (
        error ||
        !data ||
        typeof data !== "object" ||
        data.status !== "cancellation_window" ||
        data.sessions_revoked !== true
      ) {
        setFailure(true);
        return;
      }
      await signOut();
      await navigate({ to: "/login", replace: true });
    } catch {
      setFailure(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <VerificationMessage loading text="מאמת זהות…" />;
  if (!requestId || !token) {
    return <VerificationMessage error text="קישור האימות חסר או אינו תקין." />;
  }
  if (!session?.user.id) {
    return <VerificationMessage error text="יש לפתוח את קישור האימות מהדוא״ל המאומת." />;
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center p-4" dir="rtl">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>אימות בקשת מחיקת חשבון</CardTitle>
          <CardDescription>
            האישור יחסום פעילות עסקית חדשה, יבטל את הסשנים הקיימים ויפתח חלון ביטול של שבעה ימים.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {failure && <p role="alert">האימות נכשל. הבקשה לא סומנה כמאושרת.</p>}
          <Button className="w-full" onClick={() => void confirm()} disabled={submitting}>
            {submitting ? "מאמת…" : "אשר את בקשת המחיקה"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function VerificationMessage({
  text,
  loading,
  error,
}: {
  text: string;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center p-4" dir="rtl">
      <Card className="w-full">
        <CardContent className="flex items-center justify-center gap-3 p-8 text-center">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : error ? (
            <AlertTriangle className="h-5 w-5" />
          ) : null}
          <p>{text}</p>
        </CardContent>
      </Card>
    </main>
  );
}
