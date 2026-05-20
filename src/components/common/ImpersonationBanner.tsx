import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { AlertTriangle, LogOut } from "lucide-react";
import { toast } from "sonner";

const KEY = "lovable-impersonation";

type Stored = {
  admin_refresh_token: string;
  admin_email: string;
  target_email: string;
};

export function startImpersonation(adminRefresh: string, adminEmail: string, targetEmail: string) {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({
      admin_refresh_token: adminRefresh,
      admin_email: adminEmail,
      target_email: targetEmail,
    } satisfies Stored),
  );
}

export function ImpersonationBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<Stored | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) {
      setInfo(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Stored;
      // If current user is back to admin (matches admin_email), clear
      if (user?.email === parsed.admin_email) {
        sessionStorage.removeItem(KEY);
        setInfo(null);
      } else {
        setInfo(parsed);
      }
    } catch {
      sessionStorage.removeItem(KEY);
    }
  }, [user?.email]);

  if (!info) return null;

  const endImpersonation = async () => {
    setBusy(true);
    try {
      await supabase.auth.signOut();
      const { error } = await supabase.auth.refreshSession({
        refresh_token: info.admin_refresh_token,
      });
      sessionStorage.removeItem(KEY);
      if (error) {
        toast.error("נא להתחבר מחדש כמנהל");
        navigate({ to: "/login" });
      } else {
        toast.success("חזרת לחשבון המנהל");
        navigate({ to: "/admin" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky top-0 z-50 bg-warning text-warning-foreground border-b border-warning/40" dir="rtl">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">
          אתה מחובר במצב התחזות כ-<strong>{info.target_email}</strong>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={endImpersonation}
          disabled={busy}
          className="text-warning-foreground hover:bg-warning/20"
        >
          <LogOut className="h-4 w-4 ml-1" />
          סיים התחזות
        </Button>
      </div>
    </div>
  );
}
