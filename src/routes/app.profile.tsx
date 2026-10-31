import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/common/AvatarUpload";
import {
  AccountSecurityCard,
  AccountSummaryCard,
} from "@/components/account/AccountSettingsShared";
import { NotificationSettingsCard } from "@/components/account/NotificationSettingsCard";
import { Coins } from "lucide-react";

export const Route = createFileRoute("/app/profile")({
  component: ProfilePage,
});

// Match the existing onboarding values; unknown legacy values remain unchanged.
const RELATIONSHIP_OPTIONS = [
  { value: "single", label: "רווק/ה" },
  { value: "in_relationship", label: "בזוגיות" },
  { value: "married", label: "נשוי/אה" },
  { value: "prefer_not_to_say", label: "מעדיפ/ה לא לציין" },
] as const;

const SMOKING_OPTIONS = [
  { value: "never", label: "לא מעשנ/ת" },
  { value: "sometimes", label: "לפעמים" },
  { value: "regularly", label: "באופן קבוע" },
  { value: "prefer_not_to_say", label: "מעדיפ/ה לא לציין" },
] as const;

type EditableClientProfile = Pick<
  Database["public"]["Tables"]["client_profiles"]["Row"],
  "interests" | "conversation_preferences" | "bio" | "relationship_status" | "smoking_status"
>;

function ProfilePage() {
  const { user } = useAuth();
  // A new identity gets a new form and async lifetime, including logout/login.
  return user ? <ProfileEditor key={user.id} /> : null;
}

function ProfileEditor() {
  const { user, role } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadedProfile, setLoadedProfile] = useState<EditableClientProfile | null>(null);
  const alive = useRef(false);
  const saveInFlight = useRef(false);
  const [account, setAccount] = useState<{
    email: string | null;
    status: string | null;
    balance: number | null;
  }>({
    email: null,
    status: null,
    balance: null,
  });
  const [form, setForm] = useState({
    display_name: "",
    avatar_url: "",
    interests: "",
    conversation_preferences: "",
    bio: "",
    relationship_status: "",
    smoking_status: "",
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const userId = user?.id;
  const userEmail = user?.email;

  useEffect(() => {
    if (!userId) return;
    let current = true;
    setLoading(true);
    setLoadError(false);
    setLoadedProfile(null);

    const load = async () => {
      try {
        const [profileResult, clientResult, walletResult] = await Promise.all([
          supabase
            .from("profiles")
            .select("display_name, avatar_url, email, status")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("client_profiles")
            .select("interests, conversation_preferences, bio, relationship_status, smoking_status")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase.from("credit_wallets").select("balance").eq("user_id", userId).maybeSingle(),
        ]);
        if (!current) return;
        if (
          profileResult.error ||
          clientResult.error ||
          walletResult.error ||
          !profileResult.data ||
          !clientResult.data
        ) {
          throw new Error("profile_load_failed");
        }
        const p = profileResult.data;
        const cp = clientResult.data;
        setAccount({
          email: p.email ?? userEmail ?? null,
          status: p?.status ?? null,
          balance: walletResult.data?.balance ?? null,
        });
        setForm({
          display_name: p?.display_name ?? "",
          avatar_url: p?.avatar_url ?? "",
          interests: cp?.interests?.join(", ") ?? "",
          conversation_preferences: cp?.conversation_preferences ?? "",
          bio: cp.bio ?? "",
          relationship_status: cp.relationship_status ?? "",
          smoking_status: cp.smoking_status ?? "",
        });
        setLoadedProfile(cp);
      } catch {
        if (current) setLoadError(true);
      } finally {
        if (current) setLoading(false);
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [userId, userEmail, loadAttempt]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !loadedProfile || loading || loadError || saveInFlight.current) return;
    if (form.display_name.trim().length < 2) {
      toast.error("שם תצוגה קצר מדי");
      return;
    }
    if (form.bio !== (loadedProfile.bio ?? "") && form.bio.length > 1000) {
      toast.error("התיאור יכול להכיל עד 1000 תווים");
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    const interests = form.interests
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      // These existing writes are independent, not an atomic transaction. Wait for
      // both, including rejected requests, before unlocking a subsequent attempt.
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          supabase
            .from("profiles")
            .update({
              display_name: form.display_name.trim().slice(0, 50),
              avatar_url: form.avatar_url.trim() || null,
            })
            .eq("user_id", userId)
            .select("user_id")
            .maybeSingle(),
        ),
        Promise.resolve().then(() =>
          supabase
            .from("client_profiles")
            .update({
              interests:
                form.interests === (loadedProfile.interests?.join(", ") ?? "")
                  ? loadedProfile.interests
                  : interests,
              conversation_preferences:
                form.conversation_preferences === (loadedProfile.conversation_preferences ?? "")
                  ? loadedProfile.conversation_preferences
                  : form.conversation_preferences.trim().slice(0, 500) || null,
              bio:
                form.bio === (loadedProfile.bio ?? "")
                  ? loadedProfile.bio
                  : form.bio.trim() || null,
              relationship_status:
                form.relationship_status === (loadedProfile.relationship_status ?? "")
                  ? loadedProfile.relationship_status
                  : form.relationship_status || null,
              smoking_status:
                form.smoking_status === (loadedProfile.smoking_status ?? "")
                  ? loadedProfile.smoking_status
                  : form.smoking_status || null,
            })
            .eq("user_id", userId)
            .select("user_id")
            .maybeSingle(),
        ),
      ]);
      if (!alive.current) return;
      if (
        results.some(
          (result) =>
            result.status === "rejected" ||
            result.value.error ||
            result.value.data?.user_id !== userId,
        )
      ) {
        throw new Error("profile_save_failed");
      }
      toast.success("נשמר");
    } catch {
      if (alive.current) toast.error("לא כל השינויים נשמרו. הקלט נשמר, אפשר לנסות שוב.");
    } finally {
      saveInFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const updateAvatar = async (url: string | null) => {
    if (!userId || !loadedProfile || loadError || saveInFlight.current || !alive.current) return;
    setForm((current) => ({ ...current, avatar_url: url ?? "" }));
    saveInFlight.current = true;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .update({ avatar_url: url })
        .eq("user_id", userId)
        .select("user_id")
        .maybeSingle();
      if (!alive.current) return;
      if (error || data?.user_id !== userId) throw new Error("avatar_save_failed");
      toast.success(url ? "תמונת הפרופיל עודכנה" : "תמונת הפרופיל הוסרה");
    } catch {
      if (alive.current) toast.error("שמירת תמונת הפרופיל נכשלה");
    } finally {
      saveInFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <>
      <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-6" dir="rtl">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">פרופיל והגדרות חשבון</h1>
          <p className="text-sm text-muted-foreground mt-1">{user?.email}</p>
        </header>

        {loading ? (
          <div role="status" aria-label="טוען פרופיל">
            <Skeleton className="h-96" />
          </div>
        ) : loadError ? (
          <div role="alert" className="space-y-4 rounded-lg border p-6 text-center">
            <p className="text-destructive">לא ניתן לטעון את הפרופיל כרגע</p>
            <Button variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              נסה שוב
            </Button>
          </div>
        ) : (
          <>
            <AccountSummaryCard
              displayName={form.display_name}
              email={account.email}
              role={role}
              status={account.status}
            />

            <Card>
              <CardHeader>
                <CardTitle className="text-base">קרדיטים</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Coins className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">יתרה נוכחית</div>
                    <div className="text-2xl font-bold">{account.balance ?? 0}</div>
                  </div>
                </div>
                <Button asChild variant="outline">
                  <Link to="/app/packages">צפה בחבילות</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>פרטים אישיים</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={save}>
                  <fieldset disabled={saving || !loadedProfile} className="space-y-4">
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
                      onChange={(url) => void updateAvatar(url)}
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
                      <Label htmlFor="bio">ספר/י על עצמך</Label>
                      <Textarea
                        id="bio"
                        value={form.bio}
                        onChange={(event) => setForm({ ...form, bio: event.target.value })}
                        rows={5}
                        maxLength={1000}
                      />
                      <p className="text-xs text-muted-foreground">עד 1000 תווים</p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      {(
                        [
                          {
                            key: "relationship_status",
                            label: "סטטוס זוגי",
                            options: RELATIONSHIP_OPTIONS,
                          },
                          { key: "smoking_status", label: "עישון", options: SMOKING_OPTIONS },
                        ] as const
                      ).map(({ key, label, options }) => (
                        <div key={key} className="space-y-2">
                          <Label htmlFor={key}>{label}</Label>
                          <Select
                            value={form[key]}
                            onValueChange={(value) => setForm({ ...form, [key]: value })}
                            disabled={saving}
                          >
                            <SelectTrigger id={key}>
                              <SelectValue placeholder="בחירה" />
                            </SelectTrigger>
                            <SelectContent>
                              {form[key] &&
                                !options.some((option) => option.value === form[key]) && (
                                  <SelectItem value={form[key]}>ערך קיים: {form[key]}</SelectItem>
                                )}
                              {options.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="prefs">סגנון שיחה מועדף</Label>
                      <Textarea
                        id="prefs"
                        value={form.conversation_preferences}
                        onChange={(e) =>
                          setForm({ ...form, conversation_preferences: e.target.value })
                        }
                        rows={4}
                        maxLength={500}
                      />
                    </div>

                    <Button type="submit" disabled={saving} className="w-full">
                      {saving ? "שומר..." : "שמירה"}
                    </Button>
                  </fieldset>
                </form>
              </CardContent>
            </Card>

            <AccountSecurityCard
              userId={user?.id}
              email={account.email}
              onDeletionRequested={() =>
                setAccount((current) => ({ ...current, status: "deletion_requested" }))
              }
            />
            <NotificationSettingsCard role={role} />
          </>
        )}
      </div>
    </>
  );
}
