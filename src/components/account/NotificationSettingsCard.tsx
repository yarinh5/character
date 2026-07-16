import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useAuth, type AppRole } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

type NotificationSettings = {
  in_app_enabled: boolean;
  email_enabled: boolean;
  new_message_enabled: boolean;
  new_report_enabled: boolean;
  credits_enabled: boolean;
  assignment_enabled: boolean;
  lock_enabled: boolean;
  system_enabled: boolean;
};

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

const DEFAULT_SETTINGS: NotificationSettings = {
  in_app_enabled: true,
  email_enabled: false,
  new_message_enabled: true,
  new_report_enabled: true,
  credits_enabled: true,
  assignment_enabled: true,
  lock_enabled: true,
  system_enabled: true,
};

const isMissingTableError = (error: SupabaseErrorLike) =>
  error.code === "42P01" || error.code === "PGRST205";

export function NotificationSettingsCard({ role }: { role: AppRole | null }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<keyof NotificationSettings | null>(null);
  const [settingsAvailable, setSettingsAvailable] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadSettings = async () => {
      setLoading(true);
      setSettingsAvailable(true);

      const { data, error } = await supabase
        .from("notification_settings")
        .select(
          "in_app_enabled, email_enabled, new_message_enabled, new_report_enabled, credits_enabled, assignment_enabled, lock_enabled, system_enabled",
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error("Failed to load notification settings", error);

        if (isMissingTableError(error)) {
          setSettings(DEFAULT_SETTINGS);
          setSettingsAvailable(false);
          setLoading(false);
          return;
        }

        toast.error("טעינת הגדרות התראות נכשלה");
        setLoading(false);
        return;
      }

      if (!data) {
        const { error: insertError } = await supabase.from("notification_settings").upsert(
          {
            user_id: user.id,
            ...DEFAULT_SETTINGS,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );

        if (cancelled) return;

        if (insertError) {
          console.error("Failed to create default notification settings", insertError);

          if (!isMissingTableError(insertError)) {
            toast.error("יצירת הגדרות ברירת מחדל נכשלה");
          } else {
            setSettingsAvailable(false);
          }
        }
      }

      setSettings({ ...DEFAULT_SETTINGS, ...(data ?? {}) });
      setLoading(false);
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    if (!user || !settingsAvailable) return;
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSavingKey(key);
    const { error } = await supabase.from("notification_settings").upsert(
      {
        user_id: user.id,
        ...next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    setSavingKey(null);
    if (error) {
      console.error("Failed to save notification settings", error);
      setSettings(previous);
      toast.error("שמירת הגדרות התראות נכשלה");
      return;
    }
    toast.success("הגדרות ההתראות נשמרו");
  };

  const options = getOptionsForRole(role);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          הגדרות התראות
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            {!settingsAvailable && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                הגדרות ההתראות יוצגו כברירת מחדל עד שה־migration של ההתראות ירוץ בסביבת Supabase.
              </p>
            )}
            <SettingRow
              label="התראות בתוך המערכת"
              description="הצגת התראות בפעמון ההתראות בזמן אמת."
              checked={settings.in_app_enabled}
              disabled={!settingsAvailable || savingKey !== null}
              onChange={(checked) => updateSetting("in_app_enabled", checked)}
            />
            {options.map((option) => (
              <SettingRow
                key={option.key}
                label={option.label}
                description={option.description}
                checked={settings[option.key]}
                disabled={!settingsAvailable || !settings.in_app_enabled || savingKey !== null}
                onChange={(checked) => updateSetting(option.key, checked)}
              />
            ))}
            <SettingRow
              label="התראות אימייל"
              description="מוכן לשלב עתידי. כרגע לא נשלחים אימיילים בפועל."
              checked={settings.email_enabled}
              disabled
              onChange={() => undefined}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function getOptionsForRole(role: AppRole | null): Array<{
  key: keyof NotificationSettings;
  label: string;
  description: string;
}> {
  if (role === "client") {
    return [
      {
        key: "new_message_enabled",
        label: "הודעות חדשות",
        description: "התראה כשמתקבלת תשובה חדשה בשיחה.",
      },
      {
        key: "credits_enabled",
        label: "קרדיטים",
        description: "התראות על יתרה נמוכה או קרדיטים שנגמרו.",
      },
      {
        key: "system_enabled",
        label: "מערכת",
        description: "עדכונים כלליים חשובים.",
      },
    ];
  }

  if (role === "operator") {
    return [
      {
        key: "new_message_enabled",
        label: "הודעות חדשות",
        description: "התראה כשלקוח שולח הודעה לדמות שמשויכת אליך.",
      },
      {
        key: "assignment_enabled",
        label: "שיוכים לדמויות",
        description: "התראה כשמשייכים אותך לדמות חדשה.",
      },
      {
        key: "lock_enabled",
        label: "נעילות שיחה",
        description: "התראות על שחרור נעילות שיחה.",
      },
    ];
  }

  return [
    {
      key: "new_report_enabled",
      label: "דיווחים חדשים",
      description: "התראה כשנפתח דיווח חדש במערכת.",
    },
    {
      key: "system_enabled",
      label: "מערכת",
      description: "התראות מערכת חשובות.",
    },
  ];
}
