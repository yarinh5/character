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
import { ProfileImageManager } from "@/components/profile/ProfileImageManager";
import {
  AccountSecurityCard,
  AccountSummaryCard,
  ClientLevelCard,
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

function isCityList(value: unknown): value is City[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).display_name_he === "string",
    )
  );
}

type EditableClientProfile = Pick<
  Database["public"]["Tables"]["client_profiles"]["Row"],
  | "interests"
  | "conversation_preferences"
  | "bio"
  | "relationship_status"
  | "smoking_status"
  | "first_name"
  | "last_name"
  | "date_of_birth"
  | "computed_age"
  | "age"
  | "city_id"
  | "preferred_min_age"
  | "preferred_max_age"
  | "preferred_distance_km"
  | "content_preferences"
  | "character_preferences"
  | "profile_image_url"
  | "profile_image_urls"
>;

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function profileImagesIncludingPrimary(primary: string | null, existingUrls: string[]) {
  const unique = [...new Set(existingUrls)];
  return primary === null || unique.includes(primary) ? unique : [primary, ...unique];
}

function ageOnDate(dateOfBirth: string, today = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  let age = today.getUTCFullYear() - year;
  if (
    today.getUTCMonth() + 1 < month ||
    (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)
  ) {
    age -= 1;
  }
  return age;
}

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
  const [cities, setCities] = useState<City[]>([]);
  const [avatarSaveFailed, setAvatarSaveFailed] = useState(false);
  const alive = useRef(false);
  const saveInFlight = useRef(false);
  const pendingAvatar = useRef<{
    userId: string;
    images: string[];
    primary: string | null;
  } | null>(null);
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
    profile_image_urls: [] as string[],
    interests: "",
    conversation_preferences: "",
    bio: "",
    relationship_status: "",
    smoking_status: "",
    first_name: "",
    last_name: "",
    date_of_birth: "",
    city_id: "",
    preferred_min_age: "",
    preferred_max_age: "",
    preferred_distance_km: "",
    content_preferences: [] as string[],
    character_preferences: [] as string[],
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingAvatar.current = null;
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
        const [profileResult, clientResult, walletResult, citiesResult] = await Promise.all([
          supabase
            .from("profiles")
            .select("display_name, avatar_url, email, status")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("client_profiles")
            .select(
              "interests, conversation_preferences, bio, relationship_status, smoking_status, first_name, last_name, date_of_birth, computed_age, age, city_id, preferred_min_age, preferred_max_age, preferred_distance_km, content_preferences, character_preferences, profile_image_url, profile_image_urls",
            )
            .eq("user_id", userId)
            .maybeSingle(),
          supabase.from("credit_wallets").select("balance").eq("user_id", userId).maybeSingle(),
          supabase
            .from("discovery_cities")
            .select("id, display_name_he")
            .eq("is_active", true)
            .order("display_name_he"),
        ]);
        if (!current) return;
        if (
          profileResult.error ||
          clientResult.error ||
          walletResult.error ||
          citiesResult.error ||
          !profileResult.data ||
          !clientResult.data
        ) {
          throw new Error("profile_load_failed");
        }
        const cityRows = citiesResult.data ?? [];
        if (!isCityList(cityRows)) throw new Error("profile_cities_invalid");
        const p = profileResult.data;
        const cp = clientResult.data;
        const primaryProfileImage = cp.profile_image_url ?? p.avatar_url ?? null;
        const profileImageUrls = profileImagesIncludingPrimary(
          primaryProfileImage,
          stringArray(cp.profile_image_urls),
        );
        setCities(cityRows);
        setAccount({
          email: p.email ?? userEmail ?? null,
          status: p?.status ?? null,
          balance: walletResult.data?.balance ?? null,
        });
        setForm({
          display_name: p?.display_name ?? "",
          avatar_url: primaryProfileImage ?? "",
          profile_image_urls: profileImageUrls,
          interests: cp?.interests?.join(", ") ?? "",
          conversation_preferences: cp?.conversation_preferences ?? "",
          bio: cp.bio ?? "",
          relationship_status: cp.relationship_status ?? "",
          smoking_status: cp.smoking_status ?? "",
          first_name: cp.first_name ?? "",
          last_name: cp.last_name ?? "",
          date_of_birth: cp.date_of_birth ?? "",
          city_id: cp.city_id ?? "",
          preferred_min_age: cp.preferred_min_age === null ? "" : String(cp.preferred_min_age),
          preferred_max_age: cp.preferred_max_age === null ? "" : String(cp.preferred_max_age),
          preferred_distance_km:
            cp.preferred_distance_km === null ? "" : String(cp.preferred_distance_km),
          content_preferences: stringArray(cp.content_preferences),
          character_preferences: stringArray(cp.character_preferences),
        });
        setLoadedProfile({
          ...cp,
          profile_image_url: primaryProfileImage,
          profile_image_urls: profileImageUrls,
        });
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

  const persistPendingAvatar = async (expectedUserId: string) => {
    let wroteAvatar = false;
    let lastSavedPrimary: string | null | undefined;

    while (alive.current) {
      const request = pendingAvatar.current;
      if (!request || request.userId !== expectedUserId) break;
      pendingAvatar.current = null;
      try {
        const result = await supabase.rpc("update_client_profile_images", {
          _profile_image_urls: request.images,
          _profile_image_url: request.primary,
        });
        if (!alive.current) return false;
        const saved = Array.isArray(result.data) ? result.data[0] : null;
        if (
          result.error ||
          !saved ||
          saved.profile_image_url !== request.primary ||
          !sameStringArray(stringArray(saved.profile_image_urls), request.images)
        )
          throw new Error("avatar_save_failed");
        setLoadedProfile((current) =>
          current
            ? {
                ...current,
                profile_image_url: request.primary,
                profile_image_urls: request.images,
              }
            : current,
        );
        wroteAvatar = true;
        lastSavedPrimary = request.primary;
      } catch {
        if (!alive.current) return false;
        // Preserve the failed choice for an explicit retry. A newer callback wins.
        if (!pendingAvatar.current) pendingAvatar.current = request;
        setAvatarSaveFailed(true);
        toast.error("שמירת תמונת הפרופיל נכשלה");
        return false;
      }
    }

    if (!alive.current) return false;
    if (wroteAvatar) {
      setAvatarSaveFailed(false);
      toast.success(lastSavedPrimary === null ? "תמונות הפרופיל הוסרו" : "תמונות הפרופיל עודכנו");
    }
    return true;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const clientBaseline = loadedProfile;
    if (!userId || !clientBaseline || loading || loadError || saveInFlight.current) return;
    if (form.display_name.trim().length < 2) {
      toast.error("שם תצוגה קצר מדי");
      return;
    }
    if (form.bio !== (clientBaseline.bio ?? "") && form.bio.length > 1000) {
      toast.error("התיאור יכול להכיל עד 1000 תווים");
      return;
    }
    if (
      (form.first_name !== (clientBaseline.first_name ?? "") &&
        (form.first_name.trim().length < 2 || form.first_name.trim().length > 80)) ||
      (form.last_name !== (clientBaseline.last_name ?? "") &&
        (form.last_name.trim().length < 2 || form.last_name.trim().length > 80))
    ) {
      toast.error("יש למלא שם פרטי ושם משפחה תקינים");
      return;
    }
    const dateOfBirthChanged = form.date_of_birth !== (clientBaseline.date_of_birth ?? "");
    const computedAge = dateOfBirthChanged
      ? ageOnDate(form.date_of_birth)
      : clientBaseline.computed_age;
    if (dateOfBirthChanged && (computedAge === null || computedAge < 18 || computedAge > 120)) {
      toast.error("הגיל צריך להיות בין 18 ל־120");
      return;
    }
    const preferredMinAge = form.preferred_min_age === "" ? null : Number(form.preferred_min_age);
    const preferredMaxAge = form.preferred_max_age === "" ? null : Number(form.preferred_max_age);
    const preferredDistance =
      form.preferred_distance_km === "" ? null : Number(form.preferred_distance_km);
    if (
      (preferredMinAge !== null &&
        (!Number.isInteger(preferredMinAge) || preferredMinAge < 18 || preferredMinAge > 120)) ||
      (preferredMaxAge !== null &&
        (!Number.isInteger(preferredMaxAge) || preferredMaxAge < 18 || preferredMaxAge > 120)) ||
      (preferredMinAge !== null && preferredMaxAge !== null && preferredMinAge > preferredMaxAge)
    ) {
      toast.error("יש להזין טווח גילאים תקין");
      return;
    }
    if (
      preferredDistance !== null &&
      (!Number.isInteger(preferredDistance) || preferredDistance <= 0)
    ) {
      toast.error("יש להזין מרחק חיפוש תקין");
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    let formSaved = false;
    let confirmedClientBaseline = clientBaseline;
    const interests = form.interests
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const accountPayload = {
      display_name: form.display_name.trim().slice(0, 50),
    };
    const clientPayload = {
      interests:
        form.interests === (clientBaseline.interests?.join(", ") ?? "")
          ? clientBaseline.interests
          : interests,
      conversation_preferences:
        form.conversation_preferences === (clientBaseline.conversation_preferences ?? "")
          ? clientBaseline.conversation_preferences
          : form.conversation_preferences.trim().slice(0, 500) || null,
      bio: form.bio === (clientBaseline.bio ?? "") ? clientBaseline.bio : form.bio.trim() || null,
      relationship_status:
        form.relationship_status === (clientBaseline.relationship_status ?? "")
          ? clientBaseline.relationship_status
          : form.relationship_status || null,
      smoking_status:
        form.smoking_status === (clientBaseline.smoking_status ?? "")
          ? clientBaseline.smoking_status
          : form.smoking_status || null,
      ...(form.first_name === (clientBaseline.first_name ?? "")
        ? {}
        : { first_name: form.first_name.trim() }),
      ...(form.last_name === (clientBaseline.last_name ?? "")
        ? {}
        : { last_name: form.last_name.trim() }),
      ...(form.city_id === (clientBaseline.city_id ?? "") ? {} : { city_id: form.city_id || null }),
      ...(form.preferred_min_age ===
      (clientBaseline.preferred_min_age === null ? "" : String(clientBaseline.preferred_min_age))
        ? {}
        : { preferred_min_age: preferredMinAge }),
      ...(form.preferred_max_age ===
      (clientBaseline.preferred_max_age === null ? "" : String(clientBaseline.preferred_max_age))
        ? {}
        : { preferred_max_age: preferredMaxAge }),
      ...(form.preferred_distance_km ===
      (clientBaseline.preferred_distance_km === null
        ? ""
        : String(clientBaseline.preferred_distance_km))
        ? {}
        : { preferred_distance_km: preferredDistance }),
      ...(sameStringArray(form.content_preferences, stringArray(clientBaseline.content_preferences))
        ? {}
        : { content_preferences: form.content_preferences }),
      ...(sameStringArray(
        form.character_preferences,
        stringArray(clientBaseline.character_preferences),
      )
        ? {}
        : { character_preferences: form.character_preferences }),
    };
    try {
      if (dateOfBirthChanged) {
        const { data, error } = await supabase.rpc("update_client_birth_date", {
          _date_of_birth: form.date_of_birth,
        });
        if (
          error ||
          data?.date_of_birth !== form.date_of_birth ||
          !Number.isInteger(data.computed_age) ||
          data.computed_age < 18 ||
          data.computed_age > 120
        ) {
          throw error ?? new Error("birth_date_update_unconfirmed");
        }
        if (!alive.current) return;
        confirmedClientBaseline = {
          ...clientBaseline,
          date_of_birth: data.date_of_birth,
          computed_age: data.computed_age,
          age: data.computed_age,
        };
        setLoadedProfile(confirmedClientBaseline);
      }
      // These existing writes are independent, not an atomic transaction. Wait for
      // both, including rejected requests, before unlocking a subsequent attempt.
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          supabase
            .from("profiles")
            .update(accountPayload)
            .eq("user_id", userId)
            .select("user_id")
            .maybeSingle(),
        ),
        Promise.resolve().then(() =>
          supabase
            .from("client_profiles")
            .update(clientPayload)
            .eq("user_id", userId)
            .select("user_id")
            .maybeSingle(),
        ),
      ]);
      if (!alive.current) return;
      const accountResult = results[0];
      const clientResult = results[1];
      const accountSaved =
        accountResult.status === "fulfilled" &&
        !accountResult.value.error &&
        accountResult.value.data?.user_id === userId;
      const clientSaved =
        clientResult.status === "fulfilled" &&
        !clientResult.value.error &&
        clientResult.value.data?.user_id === userId;
      if (clientSaved) {
        const nextClientProfile = { ...confirmedClientBaseline, ...clientPayload };
        setLoadedProfile(nextClientProfile);
      }
      if (!accountSaved || !clientSaved) {
        throw new Error("profile_save_failed");
      }
      formSaved = true;
    } catch {
      if (alive.current) toast.error("לא כל השינויים נשמרו. הקלט נשמר, אפשר לנסות שוב.");
    } finally {
      let avatarSaved = true;
      if (alive.current && pendingAvatar.current?.userId === userId) {
        avatarSaved = await persistPendingAvatar(userId);
      }
      if (alive.current && formSaved && avatarSaved) toast.success("נשמר");
      saveInFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const flushPendingAvatar = async (expectedUserId: string) => {
    if (saveInFlight.current || !alive.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await persistPendingAvatar(expectedUserId);
    } finally {
      saveInFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const updateProfileImages = (images: string[], primary: string | null) => {
    if (!userId || !loadedProfile || loadError || !alive.current) return;
    setForm((current) => ({
      ...current,
      avatar_url: primary ?? "",
      profile_image_urls: images,
    }));
    pendingAvatar.current = { userId, images, primary };
    setAvatarSaveFailed(false);
    if (!saveInFlight.current) void flushPendingAvatar(userId);
  };

  const retryAvatarSave = () => {
    if (!userId || pendingAvatar.current?.userId !== userId || saveInFlight.current) return;
    void flushPendingAvatar(userId);
  };

  const togglePreference = (
    key: "content_preferences" | "character_preferences",
    value: string,
  ) => {
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
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

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="first_name">שם פרטי</Label>
                        <Input
                          id="first_name"
                          value={form.first_name}
                          onChange={(event) => setForm({ ...form, first_name: event.target.value })}
                          maxLength={80}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="last_name">שם משפחה</Label>
                        <Input
                          id="last_name"
                          value={form.last_name}
                          onChange={(event) => setForm({ ...form, last_name: event.target.value })}
                          maxLength={80}
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="date_of_birth">תאריך לידה</Label>
                        <Input
                          id="date_of_birth"
                          type="date"
                          value={form.date_of_birth}
                          onChange={(event) =>
                            setForm({ ...form, date_of_birth: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="city_id">עיר</Label>
                        <Select
                          value={form.city_id}
                          onValueChange={(value) => setForm({ ...form, city_id: value })}
                        >
                          <SelectTrigger id="city_id">
                            <SelectValue placeholder="בחירת עיר" />
                          </SelectTrigger>
                          <SelectContent>
                            {form.city_id && !cities.some((city) => city.id === form.city_id) && (
                              <SelectItem value={form.city_id}>עיר קיימת</SelectItem>
                            )}
                            {cities.map((city) => (
                              <SelectItem key={city.id} value={city.id}>
                                {city.display_name_he}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <ProfileImageManager
                      userId={userId ?? ""}
                      images={form.profile_image_urls}
                      primary={form.avatar_url || null}
                      onChange={updateProfileImages}
                      disabled={saving}
                    />
                    {avatarSaveFailed && (
                      <div role="alert" className="flex items-center justify-between gap-3">
                        <span className="text-sm text-destructive">שמירת תמונת הפרופיל נכשלה</span>
                        <Button type="button" variant="outline" size="sm" onClick={retryAvatarSave}>
                          נסה לשמור שוב
                        </Button>
                      </div>
                    )}

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

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label htmlFor="preferred_min_age">גיל מינימלי מועדף</Label>
                        <Input
                          id="preferred_min_age"
                          type="number"
                          min={18}
                          max={120}
                          value={form.preferred_min_age}
                          onChange={(event) =>
                            setForm({ ...form, preferred_min_age: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="preferred_max_age">גיל מקסימלי מועדף</Label>
                        <Input
                          id="preferred_max_age"
                          type="number"
                          min={18}
                          max={120}
                          value={form.preferred_max_age}
                          onChange={(event) =>
                            setForm({ ...form, preferred_max_age: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="preferred_distance_km">מרחק מרבי בקילומטרים</Label>
                        <Input
                          id="preferred_distance_km"
                          type="number"
                          min={1}
                          value={form.preferred_distance_km}
                          onChange={(event) =>
                            setForm({ ...form, preferred_distance_km: event.target.value })
                          }
                        />
                      </div>
                    </div>

                    <div className="grid gap-6 sm:grid-cols-2">
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium">העדפות תוכן</legend>
                        {CONTENT_OPTIONS.map((option) => (
                          <label key={option.value} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={form.content_preferences.includes(option.value)}
                              onChange={() => togglePreference("content_preferences", option.value)}
                            />
                            {option.label}
                          </label>
                        ))}
                      </fieldset>
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium">העדפות דמות</legend>
                        {CHARACTER_OPTIONS.map((option) => (
                          <label key={option.value} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={form.character_preferences.includes(option.value)}
                              onChange={() =>
                                togglePreference("character_preferences", option.value)
                              }
                            />
                            {option.label}
                          </label>
                        ))}
                      </fieldset>
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
            <ClientLevelCard userId={user?.id} />
            <NotificationSettingsCard role={role} />
          </>
        )}
      </div>
    </>
  );
}
