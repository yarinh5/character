import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { ClientLayout } from "@/components/client/ClientLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/common/AvatarUpload";

export const Route = createFileRoute("/app/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    display_name: "",
    avatar_url: "",
    interests: "",
    conversation_preferences: "",
  });

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [{ data: p }, { data: cp }] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url, email").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("client_profiles")
          .select("interests, conversation_preferences")
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);
      setForm({
        display_name: p?.display_name ?? "",
        avatar_url: p?.avatar_url ?? "",
        interests: cp?.interests?.join(", ") ?? "",
        conversation_preferences: cp?.conversation_preferences ?? "",
      });
      setLoading(false);
    })();
  }, [user]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (form.display_name.trim().length < 2) {
      toast.error("שם תצוגה קצר מדי");
      return;
    }
    setSaving(true);
    const interests = form.interests.split(",").map((s) => s.trim()).filter(Boolean);
    const [r1, r2] = await Promise.all([
      supabase
        .from("profiles")
        .update({
          display_name: form.display_name.trim().slice(0, 50),
          avatar_url: form.avatar_url.trim() || null,
        })
        .eq("user_id", user.id),
      supabase
        .from("client_profiles")
        .update({
          interests,
          conversation_preferences: form.conversation_preferences.trim().slice(0, 500) || null,
        })
        .eq("user_id", user.id),
    ]);
    setSaving(false);
    if (r1.error || r2.error) {
      toast.error("שמירה נכשלה");
      return;
    }
    toast.success("נשמר");
  };

  return (
    <ClientLayout>
      <div className="max-w-2xl mx-auto p-4 md:p-8">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">הפרופיל שלי</h1>
          <p className="text-sm text-muted-foreground mt-1">{user?.email}</p>
        </header>

        {loading ? (
          <Skeleton className="h-96" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>פרטים אישיים</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={save} className="space-y-4">
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

                <AvatarUpload
                  bucket="user-avatars"
                  folder={user?.id}
                  value={form.avatar_url || null}
                  onChange={(url) => setForm({ ...form, avatar_url: url ?? "" })}
                  label="תמונת פרופיל"
                />

                <div className="space-y-2">
                  <Label htmlFor="interests">תחומי עניין (מופרדים בפסיקים)</Label>
                  <Input
                    id="interests"
                    value={form.interests}
                    onChange={(e) => setForm({ ...form, interests: e.target.value })}
                    maxLength={300}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="prefs">סגנון שיחה מועדף</Label>
                  <Textarea
                    id="prefs"
                    value={form.conversation_preferences}
                    onChange={(e) => setForm({ ...form, conversation_preferences: e.target.value })}
                    rows={4}
                    maxLength={500}
                  />
                </div>

                <Button type="submit" disabled={saving} className="w-full">
                  {saving ? "שומר..." : "שמירה"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </ClientLayout>
  );
}
