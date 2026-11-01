import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useAuth, type AppRole } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

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

type NotificationSettingsRow = NotificationSettings & { user_id: string };
type NotificationSettingsInsert = Database["public"]["Tables"]["notification_settings"]["Insert"];
type SettingsStatus = "loading" | "error" | "unavailable" | "ready";
type SupabaseErrorLike = { code?: string };

const SETTINGS_SELECT =
  "user_id, in_app_enabled, email_enabled, new_message_enabled, new_report_enabled, credits_enabled, assignment_enabled, lock_enabled, system_enabled";

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

const isSettingsRow = (value: unknown): value is NotificationSettingsRow => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.user_id === "string" &&
    typeof row.in_app_enabled === "boolean" &&
    typeof row.email_enabled === "boolean" &&
    typeof row.new_message_enabled === "boolean" &&
    typeof row.new_report_enabled === "boolean" &&
    typeof row.credits_enabled === "boolean" &&
    typeof row.assignment_enabled === "boolean" &&
    typeof row.lock_enabled === "boolean" &&
    typeof row.system_enabled === "boolean"
  );
};

const settingsFromRow = ({ user_id: _userId, ...settings }: NotificationSettingsRow) => settings;

export function NotificationSettingsCard({ role }: { role: AppRole | null }) {
  const { loading: authLoading, role: authRole, session, user } = useAuth();
  const identityId =
    !authLoading && user && session?.user.id === user.id && role !== null && authRole === role
      ? user.id
      : null;
  const effectiveRole = identityId ? role : null;
  const identityKey = identityId && effectiveRole ? `${identityId}:${effectiveRole}` : null;
  const [stateIdentity, setStateIdentity] = useState<string | null>(null);
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<SettingsStatus>("loading");
  const [savingKey, setSavingKey] = useState<keyof NotificationSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const readRequestRef = useRef(0);
  const saveOperationRef = useRef(0);
  const savePendingRef = useRef(false);

  const loadSettings = useCallback(async () => {
    if (!identityId || !identityKey) return false;
    const generation = generationRef.current;
    const request = ++readRequestRef.current;
    setStateIdentity(identityKey);
    setStatus("loading");
    setSaveError(null);

    try {
      const { data, error } = await supabase
        .from("notification_settings")
        .select(SETTINGS_SELECT)
        .eq("user_id", identityId)
        .maybeSingle();

      if (generation !== generationRef.current || request !== readRequestRef.current) return false;

      if (error) {
        if (isMissingTableError(error)) {
          setSettings(DEFAULT_SETTINGS);
          setStatus("unavailable");
          return false;
        }
        setStatus("error");
        return false;
      }

      if (data === null) {
        setSettings(DEFAULT_SETTINGS);
        setStatus("ready");
        return true;
      }

      if (!isSettingsRow(data) || data.user_id !== identityId) {
        setStatus("error");
        return false;
      }

      setSettings(settingsFromRow(data));
      setStatus("ready");
      return true;
    } catch {
      if (generation === generationRef.current && request === readRequestRef.current) {
        setStatus("error");
      }
      return false;
    }
  }, [identityId, identityKey]);

  useEffect(() => {
    const generation = ++generationRef.current;
    readRequestRef.current += 1;
    saveOperationRef.current += 1;
    savePendingRef.current = false;
    setStateIdentity(identityKey);
    setSettings(DEFAULT_SETTINGS);
    setStatus("loading");
    setSavingKey(null);
    setSaveError(null);

    if (identityKey) void loadSettings();

    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
        readRequestRef.current += 1;
        saveOperationRef.current += 1;
        savePendingRef.current = false;
      }
    };
  }, [identityKey, loadSettings]);

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    if (
      !identityId ||
      !identityKey ||
      stateIdentity !== identityKey ||
      status !== "ready" ||
      savePendingRef.current
    ) {
      return;
    }

    savePendingRef.current = true;
    const operation = ++saveOperationRef.current;
    const generation = generationRef.current;
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setSavingKey(key);
    setSaveError(null);

    try {
      const payload: NotificationSettingsInsert = {
        user_id: identityId,
        updated_at: new Date().toISOString(),
      };
      payload[key] = value;
      const { data, error } = await supabase
        .from("notification_settings")
        .upsert(payload, { onConflict: "user_id" })
        .select(SETTINGS_SELECT)
        .single();

      if (generation !== generationRef.current || operation !== saveOperationRef.current) return;
      if (error || !isSettingsRow(data) || data.user_id !== identityId || data[key] !== value) {
        throw error ?? new Error("Invalid notification settings response");
      }

      setSettings(settingsFromRow(data));
      toast.success("הגדרות ההתראות נשמרו");
    } catch {
      if (generation === generationRef.current && operation === saveOperationRef.current) {
        setSettings(previous);
        setSaveError("שמירת הגדרות ההתראות נכשלה. אפשר לטעון מחדש ולנסות שוב.");
        toast.error("שמירת הגדרות התראות נכשלה");
      }
    } finally {
      if (generation === generationRef.current && operation === saveOperationRef.current) {
        savePendingRef.current = false;
        setSavingKey(null);
      }
    }
  };

  const isCurrentIdentity = Boolean(identityKey && stateIdentity === identityKey);
  const options = getOptionsForRole(effectiveRole);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          הגדרות התראות
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!identityKey ? (
          <p role="status" className="text-sm text-muted-foreground">
            נדרש חיבור מאומת עם תפקיד תואם כדי לטעון את הגדרות ההתראות.
          </p>
        ) : !isCurrentIdentity || status === "loading" ? (
          <Skeleton className="h-32" aria-label="טוען הגדרות התראות" />
        ) : status === "error" ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
          >
            <p>טעינת הגדרות ההתראות נכשלה.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void loadSettings()}
            >
              נסה שוב
            </Button>
          </div>
        ) : status === "unavailable" ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <p>הגדרות ההתראות אינן זמינות כרגע. אפשר לנסות שוב מאוחר יותר.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void loadSettings()}
            >
              נסה שוב
            </Button>
          </div>
        ) : (
          <>
            {saveError && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
              >
                <p>{saveError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void loadSettings()}
                >
                  טען מחדש
                </Button>
              </div>
            )}
            <SettingRow
              settingKey="in_app_enabled"
              label="התראות בתוך המערכת"
              description="הצגת התראות בפעמון ההתראות בזמן אמת."
              checked={settings.in_app_enabled}
              disabled={savingKey !== null}
              onChange={(checked) => void updateSetting("in_app_enabled", checked)}
            />
            {options.map((option) => (
              <SettingRow
                key={option.key}
                settingKey={option.key}
                label={option.label}
                description={option.description}
                checked={settings[option.key]}
                disabled={!settings.in_app_enabled || savingKey !== null}
                onChange={(checked) => void updateSetting(option.key, checked)}
              />
            ))}
            <SettingRow
              settingKey="email_enabled"
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
  settingKey,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  settingKey: keyof NotificationSettings;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = `notification-setting-${settingKey}`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
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
      { key: "system_enabled", label: "מערכת", description: "עדכונים כלליים חשובים." },
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
      { key: "lock_enabled", label: "נעילות שיחה", description: "התראות על שחרור נעילות שיחה." },
    ];
  }

  if (role === "admin") {
    return [
      {
        key: "new_report_enabled",
        label: "דיווחים חדשים",
        description: "התראה כשנפתח דיווח חדש במערכת.",
      },
      { key: "system_enabled", label: "מערכת", description: "התראות מערכת חשובות." },
    ];
  }

  return [];
}
