import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { useAuth, rolePath } from "@/lib/auth";
import { registerClient, RegistrationFailure } from "@/lib/registration.functions";

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
  const [validateConsent, setValidateConsent] = useState(false);
  const termsInvalid = validateConsent && !agreeTerms;
  const ageInvalid = validateConsent && !agreeAge;
  const termsRef = useRef<HTMLButtonElement>(null);
  const ageRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const submitRegistration = useServerFn(registerClient);
  const { user, role, loading } = useAuth();

  useEffect(() => {
    if (!loading && user && role) navigate({ to: rolePath(role) });
  }, [user, role, loading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreeTerms || !agreeAge) {
      // Commit the error descriptions before focus exposes the checkbox to assistive technology.
      flushSync(() => setValidateConsent(true));
      (!agreeTerms ? termsRef : ageRef).current?.focus();
      return;
    }
    const parsed = schema.safeParse({ displayName, email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setSubmitting(true);
    try {
      await submitRegistration({
        data: {
          displayName: parsed.data.displayName,
          email: parsed.data.email,
          password: parsed.data.password,
          ageConfirmed: true,
          termsAccepted: true,
        },
      });
      toast.success(
        "הבקשה התקבלה. בדוק את האימייל כדי לאמת את החשבון; הבונוס יינתן רק לאחר השלמת הזכאות.",
      );
    } catch (error) {
      const code =
        error instanceof RegistrationFailure ? error.code : String((error as Error)?.message ?? "");
      if (code.includes("registration_paused"))
        toast.error("ההרשמה מושהית כעת. אפשר לנסות שוב מאוחר יותר.");
      else if (code.includes("registration_rate_limited"))
        toast.error("בוצעו יותר מדי ניסיונות. יש להמתין ולנסות שוב.");
      else if (code.includes("already_registered")) toast.error("כתובת אימייל זו כבר רשומה");
      else toast.error("לא ניתן להשלים את ההרשמה כעת. לא נוצר חשבון פעיל ולא הוענק בונוס.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-hero px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex min-h-11 items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-primary">
            <MessageCircle className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold">Character Chat</span>
        </Link>
        <Card className="shadow-elegant">
          <CardHeader>
            <h1 className="text-2xl font-semibold tracking-normal">צור חשבון</h1>
            <CardDescription>התחילו את החוויה תוך פחות מדקה</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">שם תצוגה</Label>
                <Input
                  id="displayName"
                  name="displayName"
                  autoComplete="nickname"
                  className="min-h-11"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">אימייל</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  className="min-h-11"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  dir="ltr"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">סיסמה</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  className="min-h-11"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">לפחות 8 תווים</p>
              </div>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                <label className="flex min-h-11 items-start gap-2 text-sm">
                  <Checkbox
                    ref={termsRef}
                    checked={agreeTerms}
                    onCheckedChange={(v) => setAgreeTerms(!!v)}
                    aria-required="true"
                    aria-invalid={termsInvalid || undefined}
                    aria-describedby={termsInvalid ? "terms-error" : undefined}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    אני מאשר/ת את{" "}
                    <Link
                      to="/terms"
                      className="inline-flex min-h-11 items-center text-primary hover:underline"
                    >
                      תנאי השימוש
                    </Link>{" "}
                    ואת{" "}
                    <Link
                      to="/privacy"
                      className="inline-flex min-h-11 items-center text-primary hover:underline"
                    >
                      מדיניות הפרטיות
                    </Link>
                  </span>
                </label>
                {termsInvalid && (
                  <p id="terms-error" className="text-sm text-destructive">
                    יש לאשר את תנאי השימוש ואת מדיניות הפרטיות.
                  </p>
                )}
                <label className="flex min-h-11 items-start gap-2 text-sm">
                  <Checkbox
                    ref={ageRef}
                    checked={agreeAge}
                    onCheckedChange={(v) => setAgreeAge(!!v)}
                    aria-required="true"
                    aria-invalid={ageInvalid || undefined}
                    aria-describedby={ageInvalid ? "age-error" : undefined}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    אני מאשר/ת שאני בן/בת 18 ומעלה ועומד/ת בתנאי השימוש של השירות
                  </span>
                </label>
                {ageInvalid && (
                  <p id="age-error" className="text-sm text-destructive">
                    יש לאשר את הצהרת הגיל (18 ומעלה).
                  </p>
                )}
              </div>
              <Button type="submit" className="min-h-11 w-full" disabled={submitting}>
                {submitting ? "יוצר חשבון..." : "צור חשבון"}
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              יש לך חשבון?{" "}
              <Link
                to="/login"
                className="inline-flex min-h-11 items-center font-medium text-primary hover:underline"
              >
                התחברות
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
