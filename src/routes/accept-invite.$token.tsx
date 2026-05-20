import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getInviteByToken, acceptInvite } from "@/lib/invites.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/accept-invite/$token")({
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const getInfo = useServerFn(getInviteByToken);
  const accept = useServerFn(acceptInvite);

  const [info, setInfo] = useState<{ email: string; full_name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getInfo({ data: { token } })
      .then((r) => setInfo(r))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return toast.error("הסיסמה חייבת להיות לפחות 8 תווים");
    if (password !== confirmPwd) return toast.error("הסיסמאות לא תואמות");
    if (!info) return;
    setBusy(true);
    try {
      await accept({ data: { token, password } });
      // Sign in
      const { error: signErr } = await supabase.auth.signInWithPassword({
        email: info.email,
        password,
      });
      if (signErr) {
        toast.success("החשבון נוצר — נא להתחבר");
        navigate({ to: "/login" });
      } else {
        toast.success("ברוך הבא!");
        navigate({ to: "/operator" });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4" dir="rtl">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>קבלת הזמנה</CardTitle>
          <CardDescription>הגדר סיסמה כדי להשלים את ההצטרפות כעובד.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <Skeleton className="h-32" />}
          {error && (
            <div className="text-center">
              <p className="text-destructive mb-4">{error}</p>
              <Button variant="outline" onClick={() => navigate({ to: "/" })}>חזרה לדף הבית</Button>
            </div>
          )}
          {info && (
            <form onSubmit={submit} className="space-y-4">
              <div className="p-3 bg-muted rounded-md text-sm">
                <div className="font-medium">{info.full_name}</div>
                <div className="text-xs text-muted-foreground" dir="ltr">{info.email}</div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pwd">סיסמה (לפחות 8 תווים)</Label>
                <Input id="pwd" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cpwd">אישור סיסמה</Label>
                <Input id="cpwd" type="password" dir="ltr" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} required />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "מעבד..." : "השלם הצטרפות"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
