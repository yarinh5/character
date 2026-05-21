import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/settings")({
  component: SettingsPage,
});

const KEYS = [
  { key: "minimum_age", label: "גיל מינימום", type: "number", default: 18 },
  { key: "require_age_confirmation", label: "דרוש אישור גיל בהרשמה", type: "bool", default: true },
  { key: "allow_new_registrations", label: "אפשר הרשמות חדשות", type: "bool", default: true },
  { key: "default_conversation_status", label: "סטטוס שיחה ברירת מחדל", type: "text", default: "open" },
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
  { key: "lock_timeout_minutes", label: "שחרור נעילה אוטומטי אחרי דקות", type: "number", default: 10 },
  { key: "service_disclaimer_text", label: "טקסט גילוי נאות", type: "textarea", default: "" },
] as const;

function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => {
      const { data } = await supabase.from("system_settings").select("key, value");
      const map = new Map<string, any>();
      (data ?? []).forEach((r) => map.set(r.key, r.value));
      return map;
    },
  });

  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const init: Record<string, any> = {};
    KEYS.forEach((k) => {
      const stored = data.get(k.key);
      init[k.key] = stored !== undefined && stored !== null ? stored : k.default;
    });
    setForm(init);
  }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      for (const k of KEYS) {
        const value = form[k.key];
        const { error } = await supabase
          .from("system_settings")
          .upsert({ key: k.key, value }, { onConflict: "key" });
        if (error) throw error;
      }
      toast.success("ההגדרות נשמרו");
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
    } catch (e: any) {
      toast.error("שמירה נכשלה: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8">
      <PageHeader title="הגדרות מערכת" description="הגדרות גלובליות של המוצר" />
      <Card>
        <CardHeader><CardTitle className="text-base">הגדרות בסיסיות</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {isLoading && <Skeleton className="h-40" />}
          {!isLoading &&
            KEYS.map((k) => (
              <div key={k.key} className={k.type === "bool" ? "flex items-center justify-between" : ""}>
                <Label className={k.type === "bool" ? "" : "block mb-1"}>{k.label}</Label>
                {k.type === "bool" ? (
                  <Switch
                    checked={!!form[k.key]}
                    onCheckedChange={(v) => setForm({ ...form, [k.key]: v })}
                  />
                ) : k.type === "number" ? (
                  <Input
                    type="number"
                    value={form[k.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [k.key]: Number(e.target.value) })}
                  />
                ) : k.type === "textarea" ? (
                  <Textarea
                    rows={3}
                    value={form[k.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [k.key]: e.target.value })}
                  />
                ) : k.type === "select" ? (
                  <select
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
                    value={form[k.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [k.key]: e.target.value })}
                  />
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
    </div>
  );
}
