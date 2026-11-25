import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AccountSecurityCard,
  AccountSummaryCard,
} from "@/components/account/AccountSettingsShared";
import { NotificationSettingsCard } from "@/components/account/NotificationSettingsCard";
import { parseSupportClosureDates, parseSupportScheduleWindows } from "@/lib/supportSla";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/settings")({
  component: SettingsPage,
});

const KEYS = [
  { key: "minimum_age", label: "גיל מינימום", type: "number", default: 18 },
  { key: "require_age_confirmation", label: "דרוש אישור גיל בהרשמה", type: "bool", default: true },
  {
    key: "mandatory_onboarding_enabled",
    label: "Onboarding mandatory",
    type: "bool",
    default: false,
  },
  { key: "allow_new_registrations", label: "אפשר הרשמות חדשות", type: "bool", default: true },
  {
    key: "default_conversation_status",
    label: "סטטוס שיחה ברירת מחדל",
    type: "text",
    default: "open",
  },
  {
    key: "concurrency_mode",
    label: "מצב עבודה במקביל",
    type: "select",
    default: "open",
    options: [
      { value: "open", label: "Open - כולם יכולים לענות" },
      { value: "warning", label: "Warning - אזהרה בלבד" },
      { value: "lock", label: "Lock - נעילת שיחה" },
    ],
  },
  {
    key: "lock_timeout_minutes",
    label: "שחרור נעילה אוטומטי אחרי דקות",
    type: "number",
    default: 10,
  },
  {
    key: "conversation_waiting_sla_minutes",
    label: "SLA waiting minutes",
    type: "number",
    default: 15,
  },
  { key: "service_disclaimer_text", label: "טקסט גילוי נאות", type: "textarea", default: "" },
] as const;

function SettingsPage() {
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => {
      const { data } = await supabase.from("system_settings").select("key, value");
      const map = new Map<string, any>();
      (data ?? []).forEach((r) => map.set(r.key, r.value));
      return map;
    },
  });
  const supportConfig = useQuery({
    queryKey: ["support-operations-config"],
    queryFn: async () => {
      const { data: rows, error } = await supabase.rpc("get_support_operations_config_v3");
      if (error) throw error;
      return rows?.[0] ?? null;
    },
  });
  const connectionStatus = useQuery({
    queryKey: ["product-configuration-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("product-configuration-status", {
        method: "GET",
      });
      if (error || !data || !Array.isArray(data.status))
        throw error ?? new Error("status_unavailable");
      return data.status as Array<{
        key: string;
        state: "not_configured" | "configured_not_verified" | "verified";
        actionsEnabled: boolean;
        requiredBy: string;
      }>;
    },
  });

  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [registrationChangeReason, setRegistrationChangeReason] = useState("");
  const [supportForm, setSupportForm] = useState({
    public_support_contact: "",
    business_owner_admin_id: "",
    deputy_admin_id: "",
    technical_contact: "",
    escalation_channel: "",
    support_timezone: "",
    support_windows: "",
    support_closure_dates: "",
  });
  const [profileForm, setProfileForm] = useState({
    display_name: "",
    email: "",
    status: "",
  });
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const init: Record<string, any> = {};
    KEYS.forEach((k) => {
      const stored = data.get(k.key);
      init[k.key] = stored !== undefined && stored !== null ? stored : k.default;
    });
    setForm(init);
  }, [data]);

  useEffect(() => {
    if (!supportConfig.data) return;
    setSupportForm({
      public_support_contact: supportConfig.data.public_support_contact ?? "",
      business_owner_admin_id: supportConfig.data.business_owner_admin_id ?? "",
      deputy_admin_id: supportConfig.data.deputy_admin_id ?? "",
      technical_contact: supportConfig.data.technical_contact ?? "",
      escalation_channel: supportConfig.data.escalation_channel ?? "",
      support_timezone: supportConfig.data.support_timezone ?? "",
      support_windows: Array.isArray(supportConfig.data.support_windows)
        ? supportConfig.data.support_windows
            .map((window) => {
              if (!window || typeof window !== "object" || Array.isArray(window)) return "";
              const value = window as Record<string, unknown>;
              return `${value.weekday ?? ""} ${value.start ?? ""}-${value.end ?? ""}`;
            })
            .filter(Boolean)
            .join("\n")
        : "",
      support_closure_dates: (supportConfig.data.support_closure_dates ?? []).join("\n"),
    });
  }, [supportConfig.data]);

  useEffect(() => {
    if (!user) return;
    setProfileLoading(true);
    supabase
      .from("profiles")
      .select("display_name, email, status")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        setProfileForm({
          display_name: data?.display_name ?? "",
          email: data?.email ?? user.email ?? "",
          status: data?.status ?? "active",
        });
        setProfileLoading(false);
      });
  }, [user]);

  const save = async () => {
    setBusy(true);
    try {
      if (supportConfig.isError || !supportConfig.data) {
        throw new Error("הגדרות התמיכה לא נטענו; השמירה נעצרה לפני שינוי");
      }
      const previousRegistrationState = !!data?.get("allow_new_registrations");
      const nextRegistrationState = !!form.allow_new_registrations;
      if (previousRegistrationState !== nextRegistrationState) {
        const reason = registrationChangeReason.trim();
        if (!reason) throw new Error("נדרשת סיבה לעצירה או לחידוש הרשמות");
        const { error } = await supabase.rpc("admin_set_registration_state", {
          _allow: nextRegistrationState,
          _reason: reason,
        });
        if (error) throw error;
      }
      for (const k of KEYS) {
        if (k.key === "allow_new_registrations") continue;
        const value = form[k.key];
        const { error } = await supabase
          .from("system_settings")
          .upsert({ key: k.key, value }, { onConflict: "key" });
        if (error) throw error;
      }
      {
        const scheduleValues = [
          supportForm.support_timezone.trim(),
          supportForm.support_windows.trim(),
          supportForm.support_closure_dates.trim(),
        ];
        const scheduleConfigured = scheduleValues.some(Boolean);
        const windows = scheduleConfigured
          ? parseSupportScheduleWindows(supportForm.support_windows)
          : null;
        const closureDates = scheduleConfigured
          ? parseSupportClosureDates(supportForm.support_closure_dates)
          : null;
        if (scheduleConfigured && (!supportForm.support_timezone.trim() || !windows?.length)) {
          throw new Error("לוח תמיכה דורש אזור זמן ולפחות חלון פעילות אחד");
        }
        const { data: savedVersion, error } = await supabase.rpc(
          "admin_set_support_operations_config_v3",
          {
            _expected_version: supportConfig.data.version,
            _public_support_contact: supportForm.public_support_contact,
            _business_owner_admin_id: supportForm.business_owner_admin_id || null,
            _deputy_admin_id: supportForm.deputy_admin_id || null,
            _technical_contact: supportForm.technical_contact,
            _escalation_channel: supportForm.escalation_channel,
            _support_timezone: scheduleConfigured ? supportForm.support_timezone.trim() : null,
            _support_windows: windows,
            _support_closure_dates: closureDates,
          },
        );
        if (error || typeof savedVersion !== "number") {
          throw error ?? new Error("שמירת הגדרות התמיכה לא אומתה");
        }
      }
      toast.success("ההגדרות נשמרו");
      setRegistrationChangeReason("");
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      qc.invalidateQueries({ queryKey: ["support-operations-config"] });
    } catch (e: any) {
      toast.error("שמירה נכשלה: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (profileForm.display_name.trim().length < 2) {
      toast.error("שם תצוגה קצר מדי");
      return;
    }
    setProfileSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: profileForm.display_name.trim().slice(0, 50) })
      .eq("user_id", user.id);
    setProfileSaving(false);
    if (error) {
      toast.error("שמירה נכשלה");
      return;
    }
    toast.success("פרטי החשבון נשמרו");
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader title="הגדרות" description="הגדרות החשבון האישי והמערכת" />
      <Tabs defaultValue="account">
        <TabsList className="mb-4 w-full justify-start sm:w-auto">
          <TabsTrigger value="account">החשבון שלי</TabsTrigger>
          <TabsTrigger value="system">הגדרות מערכת</TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="space-y-4">
          {profileLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <AccountSummaryCard
                displayName={profileForm.display_name}
                email={profileForm.email}
                role={role}
                status={profileForm.status}
              />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">פרטים אישיים</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={saveProfile} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="admin_display_name">שם תצוגה</Label>
                      <Input
                        id="admin_display_name"
                        value={profileForm.display_name}
                        onChange={(e) =>
                          setProfileForm({ ...profileForm, display_name: e.target.value })
                        }
                        maxLength={50}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="admin-account-email">אימייל</Label>
                      <Input id="admin-account-email" value={profileForm.email} readOnly className="bg-muted/50" />
                    </div>
                    <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                      שינוי role והרשאות לא מתבצע מהגדרות החשבון האישיות.
                    </div>
                    <Button type="submit" disabled={profileSaving}>
                      {profileSaving ? "שומר..." : "שמור פרטים"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <AccountSecurityCard
                userId={user?.id}
                email={profileForm.email}
                onDeletionRequested={() =>
                  setProfileForm((current) => ({ ...current, status: "deletion_requested" }))
                }
              />
              <NotificationSettingsCard role={role} />
            </>
          )}
        </TabsContent>

        <TabsContent value="system">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">הגדרות בסיסיות</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoading && <Skeleton className="h-40" />}
                {!isLoading &&
                  KEYS.map((k) => (
                    <div key={k.key} className={k.type === "bool" ? "space-y-2" : ""}>
                      <div className={k.type === "bool" ? "flex items-center justify-between" : ""}>
                        <Label
                          htmlFor={`system-setting-${k.key}`}
                          className={k.type === "bool" ? "" : "block mb-1"}
                        >
                          {k.label}
                        </Label>
                        {k.type === "bool" ? (
                          <Switch
                            id={`system-setting-${k.key}`}
                            checked={!!form[k.key]}
                            onCheckedChange={(v) => setForm({ ...form, [k.key]: v })}
                          />
                        ) : k.type === "number" ? (
                          <Input
                            id={`system-setting-${k.key}`}
                            type="number"
                            value={form[k.key] ?? ""}
                            onChange={(e) => setForm({ ...form, [k.key]: Number(e.target.value) })}
                          />
                        ) : k.type === "textarea" ? (
                          <Textarea
                            id={`system-setting-${k.key}`}
                            rows={3}
                            value={form[k.key] ?? ""}
                            onChange={(e) => setForm({ ...form, [k.key]: e.target.value })}
                          />
                        ) : k.type === "select" ? (
                          <select
                            id={`system-setting-${k.key}`}
                            value={form[k.key] ?? k.default}
                            onChange={(e) => setForm({ ...form, [k.key]: e.target.value })}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          >
                            {k.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={`system-setting-${k.key}`}
                            value={form[k.key] ?? ""}
                            onChange={(e) => setForm({ ...form, [k.key]: e.target.value })}
                          />
                        )}
                      </div>
                      {k.key === "allow_new_registrations" &&
                        !!data &&
                        !!data.get("allow_new_registrations") !==
                          !!form.allow_new_registrations && (
                          <div className="space-y-1">
                            <Label htmlFor="registration-change-reason">סיבה מתועדת לשינוי</Label>
                            <Textarea
                              id="registration-change-reason"
                              value={registrationChangeReason}
                              onChange={(event) => setRegistrationChangeReason(event.target.value)}
                              maxLength={500}
                              placeholder="אירוע, תחזוקה או סיבת חידוש"
                            />
                          </div>
                        )}
                    </div>
                  ))}
                {!isLoading && (
                  <Button onClick={save} disabled={busy}>
                    {busy ? "שומר..." : "שמור הגדרות"}
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">תמיכה והסלמת אירועים</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {supportConfig.isLoading && <Skeleton className="h-40" />}
                {supportConfig.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    טעינת הגדרות התמיכה נכשלה. לא ניתן לשמור אותן עד רענון מוצלח.
                  </p>
                )}
                {supportConfig.data && (
                  <>
                    <div>
                      <Label htmlFor="public-support-contact">ערוץ תמיכה ציבורי מוגדר</Label>
                      <Input
                        id="public-support-contact"
                        maxLength={300}
                        placeholder="כתובת דוא״ל או קישור שאושרו"
                        value={supportForm.public_support_contact}
                        onChange={(event) =>
                          setSupportForm({
                            ...supportForm,
                            public_support_contact: event.target.value,
                          })
                        }
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        יוצג למשתמשים שאינם יכולים להתחבר רק כאשר הערך הוגדר בפועל.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="business-owner-admin">מזהה משתמש אדמין — אחראי עסקי</Label>
                      <Input
                        id="business-owner-admin"
                        dir="ltr"
                        value={supportForm.business_owner_admin_id}
                        onChange={(event) =>
                          setSupportForm({
                            ...supportForm,
                            business_owner_admin_id: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="deputy-admin">מזהה משתמש אדמין — ממלא מקום</Label>
                      <Input
                        id="deputy-admin"
                        dir="ltr"
                        value={supportForm.deputy_admin_id}
                        onChange={(event) =>
                          setSupportForm({ ...supportForm, deputy_admin_id: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="technical-contact">איש קשר טכני</Label>
                      <Input
                        id="technical-contact"
                        maxLength={300}
                        value={supportForm.technical_contact}
                        onChange={(event) =>
                          setSupportForm({ ...supportForm, technical_contact: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="escalation-channel">ערוץ הסלמה פנימי מאושר</Label>
                      <Input
                        id="escalation-channel"
                        maxLength={300}
                        value={supportForm.escalation_channel}
                        onChange={(event) =>
                          setSupportForm({ ...supportForm, escalation_channel: event.target.value })
                        }
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        הגדרה אינה הוכחת מסירה; מחבר חיצוני עדיין נדרש.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="support-timezone">אזור זמן ללוח התמיכה</Label>
                      <Input
                        id="support-timezone"
                        maxLength={100}
                        placeholder="לדוגמה: Asia/Jerusalem — רק לאחר אישור"
                        value={supportForm.support_timezone}
                        onChange={(event) =>
                          setSupportForm({ ...supportForm, support_timezone: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="support-windows">חלונות תמיכה</Label>
                      <Textarea
                        id="support-windows"
                        dir="ltr"
                        rows={6}
                        placeholder={"1 09:00-12:00\n1 13:00-17:00\n2 22:00-02:00"}
                        value={supportForm.support_windows}
                        onChange={(event) =>
                          setSupportForm({ ...supportForm, support_windows: event.target.value })
                        }
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        יום 0 הוא יום א׳. חלון שחוצה חצות שייך ליום פתיחתו; רגע הסיום אינו בתוך
                        החלון.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="support-closure-dates">תאריכי סגירה מיוחדים</Label>
                      <Textarea
                        id="support-closure-dates"
                        dir="ltr"
                        rows={4}
                        placeholder={"2026-12-01\n2026-12-15"}
                        value={supportForm.support_closure_dates}
                        onChange={(event) =>
                          setSupportForm({
                            ...supportForm,
                            support_closure_dates: event.target.value,
                          })
                        }
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        אין לוח חגים אוטומטי. יש להזין רק סגירות שאושרו במפורש.
                      </p>
                    </div>
                    <div className="rounded-md border p-3 text-sm">
                      <p>
                        מצב לוח התמיכה: <strong>{supportConfig.data.schedule_state}</strong>
                      </p>
                      <p>
                        גרסת לוח: <strong>{supportConfig.data.support_schedule_version}</strong>
                      </p>
                      <p>
                        מצב מחבר ההסלמה:{" "}
                        <strong>{supportConfig.data.escalation_adapter_state}</strong>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        נמען או ערוץ אינם מחבר מסירה. ללא לוח מלא אין חישוב יעד יום עסקים; ללא מחבר
                        מאומת אירוע נשאר pending_configuration.
                      </p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">מוכנות חיבורי שרת</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {connectionStatus.isLoading && <Skeleton className="h-32" />}
                {connectionStatus.isError && (
                  <p role="alert" className="text-destructive">
                    מצב חיבורי השרת אינו זמין. אין להסיק מכך שהגדרה קיימת או שספק נבדק.
                  </p>
                )}
                {connectionStatus.data?.map((item) => (
                  <div key={item.key} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong dir="ltr">{item.key}</strong>
                      <span>{item.state.toUpperCase()}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      פעולה תלויה: {item.requiredBy}. הגדרה אינה הוכחת מסירה או תאימות ספק.
                    </p>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  ערכי סוד אינם מוחזרים למסך. אין במסך זה כפתור בדיקת חיבור או הפעלת Import, Release
                  או Replay.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
