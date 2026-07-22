import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { AvatarUpload } from "@/components/common/AvatarUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/app/onboarding")({
  component: OnboardingPage,
});

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

const CONTENT_OPTIONS = [
  { value: "casual_chat", label: "שיחות קלילות" },
  { value: "romance", label: "רומנטיקה" },
  { value: "roleplay", label: "משחקי תפקידים" },
] as const;

const CHARACTER_OPTIONS = [
  { value: "female", label: "דמויות נשיות" },
  { value: "male", label: "דמויות גבריות" },
  { value: "any", label: "ללא העדפה" },
] as const;

type City = { id: string; display_name_he: string };
type Form = {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  cityId: string;
  bio: string;
  relationshipStatus: string;
  smokingStatus: string;
  preferredMinAge: string;
  preferredMaxAge: string;
  preferredDistanceKm: string;
  contentPreferences: string[];
  characterPreferences: string[];
  profileImageUrl: string;
};

const EMPTY_FORM: Form = {
  firstName: "",
  lastName: "",
  dateOfBirth: "",
  cityId: "",
  bio: "",
  relationshipStatus: "",
  smokingStatus: "",
  preferredMinAge: "",
  preferredMaxAge: "",
  preferredDistanceKm: "",
  contentPreferences: [],
  characterPreferences: [],
  profileImageUrl: "",
};

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function OnboardingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(1);
  const [legacyAge, setLegacyAge] = useState<number | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [form, setForm] = useState<Form>(EMPTY_FORM);

  useEffect(() => {
    if (!user) return;

    let alive = true;
    Promise.all([
      supabase
        .from("client_profiles")
        .select(
          "age, first_name, last_name, date_of_birth, city_id, bio, relationship_status, smoking_status, preferred_min_age, preferred_max_age, preferred_distance_km, content_preferences, character_preferences, onboarding_step, profile_image_url",
        )
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase.from("profiles").select("display_name, avatar_url").eq("user_id", user.id).maybeSingle(),
      supabase.from("discovery_cities").select("id, display_name_he").eq("is_active", true).order("display_name_he"),
    ]).then(([{ data: profile }, { data: publicProfile }, { data: cityRows }]) => {
      if (!alive) return;

      const displayName = publicProfile?.display_name?.trim().split(/\s+/) ?? [];
      setLegacyAge(profile?.age ?? null);
      setCities((cityRows ?? []) as City[]);
      setForm({
        firstName: profile?.first_name ?? displayName[0] ?? "",
        lastName: profile?.last_name ?? displayName.slice(1).join(" ") ?? "",
        dateOfBirth: profile?.date_of_birth ?? "",
        cityId: profile?.city_id ?? "",
        bio: profile?.bio ?? "",
        relationshipStatus: profile?.relationship_status ?? "",
        smokingStatus: profile?.smoking_status ?? "",
        preferredMinAge: profile?.preferred_min_age ? String(profile.preferred_min_age) : "",
        preferredMaxAge: profile?.preferred_max_age ? String(profile.preferred_max_age) : "",
        preferredDistanceKm: profile?.preferred_distance_km ? String(profile.preferred_distance_km) : "",
        contentPreferences: stringArray(profile?.content_preferences),
        characterPreferences: stringArray(profile?.character_preferences),
        profileImageUrl: profile?.profile_image_url ?? publicProfile?.avatar_url ?? "",
      });
      setStep(Math.max(1, Math.min(3, profile?.onboarding_step || 1)));
      setLoading(false);
    });

    return () => {
      alive = false;
    };
  }, [user]);

  const payload = useMemo(
    () => ({
      first_name: form.firstName,
      last_name: form.lastName,
      date_of_birth: form.dateOfBirth,
      city_id: form.cityId,
      bio: form.bio,
      relationship_status: form.relationshipStatus,
      smoking_status: form.smokingStatus,
      preferred_min_age: form.preferredMinAge,
      preferred_max_age: form.preferredMaxAge,
      preferred_distance_km: form.preferredDistanceKm,
      content_preferences: form.contentPreferences,
      character_preferences: form.characterPreferences,
      profile_image_url: form.profileImageUrl,
      profile_image_urls: form.profileImageUrl ? [form.profileImageUrl] : [],
    }),
    [form],
  );

  const update = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const toggle = (key: "contentPreferences" | "characterPreferences", value: string) => {
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

  const validate = (targetStep: number) => {
    if (targetStep === 1) {
      if (form.firstName.trim().length < 2 || form.lastName.trim().length < 2) {
        return "יש למלא שם פרטי ושם משפחה.";
      }
      if (!form.dateOfBirth && !legacyAge) {
        return "יש להזין תאריך לידה.";
      }
      if (!form.cityId) return "יש לבחור עיר.";
    }

    if (targetStep === 2) {
      if (form.bio.trim().length < 10) return "ספר/י על עצמך בכמה מילים.";
      if (!form.relationshipStatus || !form.smokingStatus) return "יש להשלים את פרטי ההעדפות.";
    }

    if (targetStep === 3) {
      const minAge = Number(form.preferredMinAge);
      const maxAge = Number(form.preferredMaxAge);
      const distance = Number(form.preferredDistanceKm);
      if (!Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge < 18 || maxAge > 120 || minAge > maxAge) {
        return "יש להזין טווח גילאים תקין.";
      }
      if (!Number.isInteger(distance) || distance <= 0) return "יש להזין מרחק חיפוש תקין.";
      if (!form.contentPreferences.length || !form.characterPreferences.length) {
        return "יש לבחור לפחות העדפה אחת בכל קבוצה.";
      }
    }

    return null;
  };

  const save = async (nextStep: number, complete = false) => {
    const validationError = validate(complete ? 3 : step);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.rpc(
        complete ? "complete_client_onboarding" : "save_client_onboarding_step",
        { _payload: { ...payload, onboarding_step: nextStep } },
      );
      if (error) throw error;

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-profile"] }),
        queryClient.invalidateQueries({ queryKey: ["auth/profile"] }),
      ]);
      window.dispatchEvent(new Event("client-profile-updated"));
      if (complete) {
        toast.success("הפרופיל הושלם בהצלחה");
        navigate({ to: "/app/characters", replace: true });
        return;
      }

      setStep(nextStep);
      toast.success("ההתקדמות נשמרה");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const message =
        code.includes("onboarding_incomplete")
          ? "חסרים פרטים להשלמת הפרופיל."
          : code.includes("invalid_onboarding_age")
            ? "הגיל צריך להיות בין 18 ל־120."
            : code.includes("invalid_onboarding_preferences")
              ? "יש לבדוק את ההעדפות שבחרת."
              : "לא הצלחנו לשמור את ההתקדמות. נסה/י שוב.";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center" dir="rtl">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-8" dir="rtl">
      <Card>
        <CardHeader className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>בואו נכיר</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">כמה פרטים קצרים יעזרו לנו להתאים לך חוויה טובה יותר.</p>
            </div>
            <span className="shrink-0 text-sm text-muted-foreground">{step} מתוך 3</span>
          </div>
          <Progress value={(step / 3) * 100} />
        </CardHeader>

        <CardContent className="space-y-6">
          {step === 1 && (
            <section className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="first_name">שם פרטי</Label>
                  <Input id="first_name" value={form.firstName} onChange={(event) => update("firstName", event.target.value)} maxLength={80} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last_name">שם משפחה</Label>
                  <Input id="last_name" value={form.lastName} onChange={(event) => update("lastName", event.target.value)} maxLength={80} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="date_of_birth">תאריך לידה</Label>
                <Input id="date_of_birth" type="date" value={form.dateOfBirth} onChange={(event) => update("dateOfBirth", event.target.value)} />
                {legacyAge && !form.dateOfBirth && (
                  <p className="text-xs text-muted-foreground">נמצא גיל קודם בפרופיל שלך, ואפשר לעדכן כאן תאריך לידה מדויק.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>עיר</Label>
                <Select value={form.cityId} onValueChange={(value) => update("cityId", value)}>
                  <SelectTrigger><SelectValue placeholder="בחירת עיר" /></SelectTrigger>
                  <SelectContent>
                    {cities.map((city) => <SelectItem key={city.id} value={city.id}>{city.display_name_he}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="space-y-5">
              <AvatarUpload
                bucket="user-avatars"
                folder={user?.id}
                value={form.profileImageUrl || null}
                onChange={(url) => update("profileImageUrl", url ?? "")}
                label="תמונת פרופיל"
              />

              <div className="space-y-2">
                <Label htmlFor="bio">ספר/י על עצמך</Label>
                <Textarea id="bio" value={form.bio} onChange={(event) => update("bio", event.target.value)} rows={5} maxLength={1000} />
                <p className="text-xs text-muted-foreground">לפחות 10 תווים.</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>סטטוס זוגי</Label>
                  <Select value={form.relationshipStatus} onValueChange={(value) => update("relationshipStatus", value)}>
                    <SelectTrigger><SelectValue placeholder="בחירה" /></SelectTrigger>
                    <SelectContent>
                      {RELATIONSHIP_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>עישון</Label>
                  <Select value={form.smokingStatus} onValueChange={(value) => update("smokingStatus", value)}>
                    <SelectTrigger><SelectValue placeholder="בחירה" /></SelectTrigger>
                    <SelectContent>
                      {SMOKING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="preferred_min_age">גיל מינימלי</Label>
                  <Input id="preferred_min_age" type="number" min={18} max={120} value={form.preferredMinAge} onChange={(event) => update("preferredMinAge", event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preferred_max_age">גיל מקסימלי</Label>
                  <Input id="preferred_max_age" type="number" min={18} max={120} value={form.preferredMaxAge} onChange={(event) => update("preferredMaxAge", event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preferred_distance">מרחק בק״מ</Label>
                  <Input id="preferred_distance" type="number" min={1} value={form.preferredDistanceKm} onChange={(event) => update("preferredDistanceKm", event.target.value)} />
                </div>
              </div>

              <PreferenceGroup
                title="איזה סוג שיחה מעניין אותך?"
                options={CONTENT_OPTIONS}
                selected={form.contentPreferences}
                onToggle={(value) => toggle("contentPreferences", value)}
              />
              <PreferenceGroup
                title="העדפות לדמויות"
                options={CHARACTER_OPTIONS}
                selected={form.characterPreferences}
                onToggle={(value) => toggle("characterPreferences", value)}
              />
            </section>
          )}

          <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep((current) => Math.max(1, current - 1))} disabled={saving || step === 1}>
              חזרה
            </Button>
            {step < 3 ? (
              <Button type="button" onClick={() => void save(step + 1)} disabled={saving}>
                {saving ? "שומר..." : "שמירה והמשך"}
              </Button>
            ) : (
              <Button type="button" onClick={() => void save(3, true)} disabled={saving}>
                {saving ? "משלים..." : "השלמת פרופיל"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PreferenceGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{title}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm">
            <Checkbox checked={selected.includes(option.value)} onCheckedChange={() => onToggle(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
