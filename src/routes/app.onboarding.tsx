import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { ProfileImageManager } from "@/components/profile/ProfileImageManager";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
type ConsentRequirement = {
  id: string;
  consent_key: string;
  version: string;
  title: string;
  document_url: string;
  required: boolean;
  accepted_at: string | null;
};
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
  profileImageUrls: string[];
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
  profileImageUrls: [],
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function profileImagesWithPrimary(
  primary: string,
  previousPrimary: string,
  existingUrls: string[],
) {
  if (!primary) return existingUrls;
  return [primary, ...existingUrls.filter((url) => url !== primary && url !== previousPrimary)];
}

function parseConsentRequirements(value: unknown): ConsentRequirement[] {
  if (!Array.isArray(value)) throw new Error("consent_requirements_malformed");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("consent_key" in item) ||
      typeof item.consent_key !== "string" ||
      !("version" in item) ||
      typeof item.version !== "string" ||
      !("title" in item) ||
      typeof item.title !== "string" ||
      !("document_url" in item) ||
      typeof item.document_url !== "string" ||
      !("required" in item) ||
      typeof item.required !== "boolean" ||
      !("accepted_at" in item) ||
      (item.accepted_at !== null && typeof item.accepted_at !== "string")
    ) {
      throw new Error("consent_requirements_malformed");
    }
    return item as ConsentRequirement;
  });
}

function OnboardingPage() {
  const { user } = useAuth();
  const userId = user?.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(1);
  const [legacyAge, setLegacyAge] = useState<number | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [consentRequirements, setConsentRequirements] = useState<ConsentRequirement[]>([]);
  const [selectedConsentIds, setSelectedConsentIds] = useState<string[]>([]);
  const [consentLoadFailed, setConsentLoadFailed] = useState(false);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!userId) return;

    let alive = true;
    setLoading(true);
    setProfileLoadFailed(false);
    void (async () => {
      try {
        const [profileResult, publicProfileResult, cityResult, consentResult] = await Promise.all([
          supabase
            .from("client_profiles")
            .select(
              "age, first_name, last_name, date_of_birth, city_id, bio, relationship_status, smoking_status, preferred_min_age, preferred_max_age, preferred_distance_km, content_preferences, character_preferences, onboarding_step, profile_image_url, profile_image_urls",
            )
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("profiles")
            .select("display_name, avatar_url")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("discovery_cities")
            .select("id, display_name_he")
            .eq("is_active", true)
            .order("display_name_he"),
          supabase.rpc("get_client_consent_requirements"),
        ]);
        if (!alive) return;
        if (profileResult.error || publicProfileResult.error || cityResult.error) {
          throw profileResult.error ?? publicProfileResult.error ?? cityResult.error;
        }

        try {
          const requirements = consentResult.error
            ? (() => {
                throw consentResult.error;
              })()
            : parseConsentRequirements(consentResult.data);
          setConsentRequirements(requirements);
          setSelectedConsentIds(
            requirements
              .filter((requirement) => requirement.accepted_at !== null)
              .map((requirement) => requirement.id),
          );
          setConsentLoadFailed(false);
        } catch {
          setConsentRequirements([]);
          setSelectedConsentIds([]);
          setConsentLoadFailed(true);
        }

        const profile = profileResult.data;
        const publicProfile = publicProfileResult.data;
        const cityRows = cityResult.data;
        const displayName = publicProfile?.display_name?.trim().split(/\s+/) ?? [];
        setLegacyAge(profile?.age ?? null);
        setCities((cityRows ?? []) as City[]);
        const profileImageUrl = profile?.profile_image_url ?? publicProfile?.avatar_url ?? "";
        const profileImageUrls = profileImagesWithPrimary(
          profileImageUrl,
          profileImageUrl,
          stringArray(profile?.profile_image_urls),
        );
        const nextForm: Form = {
          firstName: profile?.first_name ?? displayName[0] ?? "",
          lastName: profile?.last_name ?? displayName.slice(1).join(" ") ?? "",
          dateOfBirth: profile?.date_of_birth ?? "",
          cityId: profile?.city_id ?? "",
          bio: profile?.bio ?? "",
          relationshipStatus: profile?.relationship_status ?? "",
          smokingStatus: profile?.smoking_status ?? "",
          preferredMinAge: profile?.preferred_min_age ? String(profile.preferred_min_age) : "",
          preferredMaxAge: profile?.preferred_max_age ? String(profile.preferred_max_age) : "",
          preferredDistanceKm: profile?.preferred_distance_km
            ? String(profile.preferred_distance_km)
            : "",
          contentPreferences: stringArray(profile?.content_preferences),
          characterPreferences: stringArray(profile?.character_preferences),
          profileImageUrl,
          profileImageUrls,
        };
        setForm(nextForm);
        const firstIncompleteStep =
          nextForm.firstName.trim().length < 2 ||
          nextForm.lastName.trim().length < 2 ||
          (!nextForm.dateOfBirth && !profile?.age) ||
          !nextForm.cityId
            ? 1
            : nextForm.bio.trim().length < 10 ||
                !nextForm.relationshipStatus ||
                !nextForm.smokingStatus
              ? 2
              : 3;
        setStep(
          Math.min(Math.max(1, Math.min(3, profile?.onboarding_step || 1)), firstIncompleteStep),
        );
      } catch {
        if (alive) setProfileLoadFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [loadAttempt, userId]);

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
      profile_image_urls: form.profileImageUrls,
    }),
    [form],
  );

  const requiredConsentsAccepted = consentRequirements.every(
    (requirement) =>
      !requirement.required ||
      requirement.accepted_at !== null ||
      selectedConsentIds.includes(requirement.id),
  );

  const update = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateProfileImages = (images: string[], primary: string | null) => {
    setForm((current) => ({
      ...current,
      profileImageUrl: primary ?? "",
      profileImageUrls: images,
    }));
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
      if (
        !Number.isInteger(minAge) ||
        !Number.isInteger(maxAge) ||
        minAge < 18 ||
        maxAge > 120 ||
        minAge > maxAge
      ) {
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
    if (complete && (consentLoadFailed || !requiredConsentsAccepted)) {
      toast.error(
        consentLoadFailed
          ? "לא ניתן לטעון את מסמכי ההסכמה. נסה/י לרענן את הדף."
          : "יש לאשר את מסמכי ההסכמה הנדרשים.",
      );
      return;
    }

    setSaving(true);
    try {
      if (complete) {
        const pendingConsents = consentRequirements.filter(
          (requirement) =>
            requirement.accepted_at === null && selectedConsentIds.includes(requirement.id),
        );
        const accepted = await Promise.all(
          pendingConsents.map(async (requirement) => {
            const { data, error } = await supabase.rpc("accept_client_consent", {
              _document_id: requirement.id,
            });
            const row = data?.[0];
            if (
              error ||
              !row ||
              row.document_id !== requirement.id ||
              typeof row.accepted_at !== "string"
            ) {
              throw error ?? new Error("consent_acceptance_malformed");
            }
            return { id: requirement.id, accepted_at: row.accepted_at };
          }),
        );
        if (accepted.length > 0) {
          const acceptedById = new Map(accepted.map((item) => [item.id, item.accepted_at]));
          setConsentRequirements((current) =>
            current.map((requirement) => ({
              ...requirement,
              accepted_at: acceptedById.get(requirement.id) ?? requirement.accepted_at,
            })),
          );
        }
      }

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
        code.includes("client_consent") || code.includes("consent_acceptance")
          ? "לא הצלחנו לשמור את ההסכמה. נסה/י שוב."
          : code.includes("onboarding_incomplete")
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

  if (profileLoadFailed) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-4" dir="rtl">
        <div role="alert" className="max-w-md space-y-4 text-center">
          <p className="font-medium">טעינת הפרופיל נכשלה</p>
          <p className="text-sm text-muted-foreground">
            הפרטים הקיימים לא הוחלפו. אפשר לנסות לטעון אותם מחדש.
          </p>
          <Button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            נסה שוב
          </Button>
        </div>
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
              <p className="mt-1 text-sm text-muted-foreground">
                כמה פרטים קצרים יעזרו לנו להתאים לך חוויה טובה יותר.
              </p>
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
                  <Input
                    id="first_name"
                    value={form.firstName}
                    onChange={(event) => update("firstName", event.target.value)}
                    maxLength={80}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last_name">שם משפחה</Label>
                  <Input
                    id="last_name"
                    value={form.lastName}
                    onChange={(event) => update("lastName", event.target.value)}
                    maxLength={80}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="date_of_birth">תאריך לידה</Label>
                <Input
                  id="date_of_birth"
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(event) => update("dateOfBirth", event.target.value)}
                />
                {legacyAge && !form.dateOfBirth && (
                  <p className="text-xs text-muted-foreground">
                    נמצא גיל קודם בפרופיל שלך, ואפשר לעדכן כאן תאריך לידה מדויק.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="onboarding-city">עיר</Label>
                <Select value={form.cityId} onValueChange={(value) => update("cityId", value)}>
                  <SelectTrigger id="onboarding-city">
                    <SelectValue placeholder="בחירת עיר" />
                  </SelectTrigger>
                  <SelectContent>
                    {cities.map((city) => (
                      <SelectItem key={city.id} value={city.id}>
                        {city.display_name_he}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="space-y-5">
              <ProfileImageManager
                userId={user?.id ?? ""}
                images={form.profileImageUrls}
                primary={form.profileImageUrl || null}
                onChange={updateProfileImages}
              />

              <div className="space-y-2">
                <Label htmlFor="bio">ספר/י על עצמך</Label>
                <Textarea
                  id="bio"
                  value={form.bio}
                  onChange={(event) => update("bio", event.target.value)}
                  rows={5}
                  maxLength={1000}
                />
                <p className="text-xs text-muted-foreground">לפחות 10 תווים.</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="onboarding-relationship-status">סטטוס זוגי</Label>
                  <Select
                    value={form.relationshipStatus}
                    onValueChange={(value) => update("relationshipStatus", value)}
                  >
                    <SelectTrigger id="onboarding-relationship-status">
                      <SelectValue placeholder="בחירה" />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATIONSHIP_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="onboarding-smoking-status">עישון</Label>
                  <Select
                    value={form.smokingStatus}
                    onValueChange={(value) => update("smokingStatus", value)}
                  >
                    <SelectTrigger id="onboarding-smoking-status">
                      <SelectValue placeholder="בחירה" />
                    </SelectTrigger>
                    <SelectContent>
                      {SMOKING_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
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
                  <Input
                    id="preferred_min_age"
                    type="number"
                    min={18}
                    max={120}
                    value={form.preferredMinAge}
                    onChange={(event) => update("preferredMinAge", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preferred_max_age">גיל מקסימלי</Label>
                  <Input
                    id="preferred_max_age"
                    type="number"
                    min={18}
                    max={120}
                    value={form.preferredMaxAge}
                    onChange={(event) => update("preferredMaxAge", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preferred_distance">מרחק בק״מ</Label>
                  <Input
                    id="preferred_distance"
                    type="number"
                    min={1}
                    value={form.preferredDistanceKm}
                    onChange={(event) => update("preferredDistanceKm", event.target.value)}
                  />
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

              {consentLoadFailed && (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                  role="alert"
                >
                  לא ניתן לטעון את מסמכי ההסכמה. יש לרענן את הדף לפני השלמת הפרופיל.
                </div>
              )}

              {consentRequirements.length > 0 && (
                <fieldset className="space-y-3 rounded-md border p-4">
                  <legend className="px-1 text-sm font-medium">מסמכי הסכמה</legend>
                  {consentRequirements.map((requirement) => {
                    const checked =
                      requirement.accepted_at !== null ||
                      selectedConsentIds.includes(requirement.id);
                    return (
                      <label key={requirement.id} className="flex items-start gap-3 text-sm">
                        <Checkbox
                          checked={checked}
                          disabled={saving || requirement.accepted_at !== null}
                          aria-label={`קראתי ואישרתי: ${requirement.title}`}
                          onCheckedChange={(value) =>
                            setSelectedConsentIds((current) =>
                              value === true
                                ? Array.from(new Set([...current, requirement.id]))
                                : current.filter((id) => id !== requirement.id),
                            )
                          }
                        />
                        <span>
                          קראתי ואישרתי את{" "}
                          <a
                            href={requirement.document_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-primary underline underline-offset-4"
                          >
                            {requirement.title}
                          </a>
                          {requirement.required ? " (נדרש)" : ""}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
            </section>
          )}

          <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep((current) => Math.max(1, current - 1))}
              disabled={saving || step === 1}
            >
              חזרה
            </Button>
            {step < 3 ? (
              <Button type="button" onClick={() => void save(step + 1)} disabled={saving}>
                {saving ? "שומר..." : "שמירה והמשך"}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void save(3, true)}
                disabled={saving || consentLoadFailed || !requiredConsentsAccepted}
              >
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
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm"
          >
            <Checkbox
              checked={selected.includes(option.value)}
              onCheckedChange={() => onToggle(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
