import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, rolePath } from "@/lib/auth";

export const Route = createFileRoute("/register")({
  head: () => ({ meta: [{ title: "הרשמה — Character Chat OS" }] }),
  component: RegisterPage,
});

const schema = z.object({
  displayName: z.string().trim().min(2, "שם תצוגה קצר מדי").max(50),
  email: z.string().trim().email("אימייל לא תקין").max(255),
  password: z.string().min(8, "סיסמה חייבת להיות לפחות 8 תווים").max(72),
});

function RegisterPage() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeAge, setAgreeAge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();

  useEffect(() => {
    if (!loading && user && role) navigate({ to: rolePath(role) });
  }, [user, role, loading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreeTerms || !agreeAge) {
      toast.error("יש לאשר את תנאי השימוש ואת תנאי הגיל");
      return;
    }
    const parsed = schema.safeParse({ displayName, email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setSubmitting(true);
    const redirectUrl = `${window.location.origin}/`;
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: redirectUrl,
        data: { display_name: parsed.data.displayName },
      },
    });
    setSubmitting(false);
    if (error) {
      if (error.message.includes("already registered")) {
        toast.error("כתובת אימייל זו כבר רשומה");
      } else {
        toast.error(error.message);
      }
      return;
    }
    toast.success("נרשמת בהצלחה! בדוק את האימייל לאישור.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-hero px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-primary">
            <MessageCircle className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold">Character Chat</span>
        </Link>
        <Card className="shadow-elegant">
          <CardHeader>
            <CardTitle className="text-2xl">צור חשבון</CardTitle>
            <CardDescription>התחילו את החוויה תוך פחות מדקה</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">שם תצוגה</Label>
                <Input id="displayName" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">אימייל</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">סיסמה</Label>
                <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className="text-xs text-muted-foreground">לפחות 8 תווים</p>
              </div>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={agreeTerms} onCheckedChange={(v) => setAgreeTerms(!!v)} className="mt-0.5" />
                  <span className="text-muted-foreground">
                    אני מאשר/ת את{" "}
                    <Link to="/terms" className="text-primary hover:underline">תנאי השימוש</Link>
                    {" "}ואת{" "}
                    <Link to="/privacy" className="text-primary hover:underline">מדיניות הפרטיות</Link>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={agreeAge} onCheckedChange={(v) => setAgreeAge(!!v)} className="mt-0.5" />
                  <span className="text-muted-foreground">
                    אני מאשר/ת שאני בן/בת 18 ומעלה ועומד/ת בתנאי השימוש של השירות
                  </span>
                </label>
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "יוצר חשבון..." : "צור חשבון"}
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              יש לך חשבון?{" "}
              <Link to="/login" className="font-medium text-primary hover:underline">
                התחברות
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
