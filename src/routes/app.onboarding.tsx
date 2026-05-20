import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/app/onboarding")({
  component: OnboardingPage,
});

const schema = z.object({
  display_name: z.string().trim().min(2, "שם קצר מדי").max(50),
  age: z.coerce.number().int().min(18, "גיל מינימלי 18").max(120),
  gender: z.enum(["male", "female", "other"], { message: "בחר מגדר" }),
  interests: z.string().trim().min(2).max(300),
  conversation_preferences: z.string().trim().max(500).optional().or(z.literal("")),
});

const GENDER_OPTIONS = [
  { value: "male", label: "זכר" },
  { value: "female", label: "נקבה" },
  { value: "other", label: "אחר" },
];

function OnboardingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    display_name: "",
    age: "",
    gender: "" as "" | "male" | "female" | "other",
    interests: "",
    conversation_preferences: "",
  });

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [{ data: profile }, { data: cp }] = await Promise.all([
        supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("client_profiles")
          .select("age, gender, interests, conversation_preferences")
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);
      setForm({
        display_name: profile?.display_name ?? "",
        age: cp?.age ? String(cp.age) : "",
        gender: (cp?.gender as "male" | "female" | "other" | null) ?? "",
        interests: cp?.interests?.join(", ") ?? "",
        conversation_preferences: cp?.conversation_preferences ?? "",
      });
    })();
  }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setLoading(true);
    try {
      const interests = parsed.data.interests
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const [p1, p2] = await Promise.all([
        supabase.from("profiles").update({ display_name: parsed.data.display_name }).eq("user_id", user.id),
        supabase.from("client_profiles").update({
          age: parsed.data.age,
          gender: parsed.data.gender,
          interests,
          conversation_preferences: parsed.data.conversation_preferences || null,
        }).eq("user_id", user.id),
      ]);

      if (p1.error) throw p1.error;
      if (p2.error) throw p2.error;

      toast.success("הפרופיל נשמר");
      navigate({ to: "/app/characters" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שמירה נכשלה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>בואו נכיר אותך</CardTitle>
          <p className="text-sm text-muted-foreground">השלמת פרופיל תעזור לנו להתאים שיחות מדויקות יותר.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display_name">שם תצוגה</Label>
              <Input
                id="display_name"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                maxLength={50}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="age">גיל</Label>
                <Input
                  id="age"
                  type="number"
                  min={18}
                  max={120}
                  value={form.age}
                  onChange={(e) => setForm({ ...form, age: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>מגדר</Label>
                <div className="flex gap-2">
                  {GENDER_OPTIONS.map((g) => (
                    <button
                      key={g.value}
                      type="button"
                      onClick={() => setForm({ ...form, gender: g.value as "male" | "female" | "other" })}
                      className={`flex-1 px-3 py-2 rounded-md text-sm border transition-colors ${
                        form.gender === g.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-input hover:bg-accent"
                      }`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="interests">תחומי עניין (מופרדים בפסיקים)</Label>
              <Input
                id="interests"
                value={form.interests}
                onChange={(e) => setForm({ ...form, interests: e.target.value })}
                placeholder="מוזיקה, ספורט, טכנולוגיה"
                maxLength={300}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="conversation_preferences">סגנון שיחה מועדף (אופציונלי)</Label>
              <Textarea
                id="conversation_preferences"
                value={form.conversation_preferences}
                onChange={(e) => setForm({ ...form, conversation_preferences: e.target.value })}
                rows={3}
                maxLength={500}
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? "שומר..." : "שמירה והמשך"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate({ to: "/app/characters" })}>
                דלג
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
