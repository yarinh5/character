import { ReactNode, useEffect, useState, createContext, useContext } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { BarChart3, Coins, Inbox, LayoutDashboard, MessageCircle, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/common/NotificationBell";
import { ImpersonationBanner } from "@/components/common/ImpersonationBanner";

export type OperatorRecord = {
  id: string;
  user_id: string;
  full_name: string;
  is_active: boolean;
  availability_status: "available" | "busy" | "offline";
};

type Ctx = { operator: OperatorRecord | null; isAdmin: boolean; walletBalance: number | null; refresh: () => Promise<void> };
const OperatorCtx = createContext<Ctx | null>(null);
export const useOperator = () => {
  const ctx = useContext(OperatorCtx);
  if (!ctx) throw new Error("useOperator must be used within RequireOperator");
  return ctx;
};

type NavItem = {
  to: "/operator" | "/operator/new" | "/operator/conversations" | "/operator/analytics" | "/operator/settings";
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
};
const NAV: NavItem[] = [
  { to: "/operator", label: "דשבורד", icon: LayoutDashboard, exact: true },
  { to: "/operator/new", label: "חדש", icon: Inbox },
  { to: "/operator/conversations", label: "שיחות", icon: MessageCircle },
  { to: "/operator/analytics", label: "ביצועים", icon: BarChart3 },
  { to: "/operator/settings", label: "הגדרות", icon: Settings },
];

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function Forbidden({ title, message }: { title: string; message: string }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" dir="rtl">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">{title}</h1>
        <p className="text-muted-foreground mb-6">{message}</p>
        <Button onClick={() => navigate({ to: "/" })}>חזרה לדף הבית</Button>
      </div>
    </div>
  );
}

export function RequireOperator({ children }: { children: ReactNode }) {
  const { loading, session, role, signOut } = useAuth();
  const navigate = useNavigate();
  const [operator, setOperator] = useState<OperatorRecord | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [opLoading, setOpLoading] = useState(true);

  const isAdmin = role === "admin";

  const refresh = async () => {
    if (!session?.user) return;
    const [{ data: operatorData }, { data: walletData }] = await Promise.all([
      supabase
        .from("operators")
        .select("id, user_id, full_name, is_active, availability_status")
        .eq("user_id", session.user.id)
        .maybeSingle(),
      supabase.from("credit_wallets").select("balance").eq("user_id", session.user.id).maybeSingle(),
    ]);
    setOperator((operatorData as OperatorRecord | null) ?? null);
    setWalletBalance(walletData?.balance ?? 0);
  };

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    if (role === "client") {
      navigate({ to: "/app/characters" });
      return;
    }
    (async () => {
      await refresh();
      setOpLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session, role]);

  useEffect(() => {
    if (!session?.user || role === "client") return;
    const channel = supabase
      .channel(`operator-wallet-${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "credit_wallets", filter: `user_id=eq.${session.user.id}` },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "credit_transactions", filter: `user_id=eq.${session.user.id}` },
        () => {
          void refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, role]);

  useEffect(() => {
    if (role !== "operator" || !operator?.id) return;

    const heartbeat = () => {
      void supabase.rpc("operator_heartbeat");
    };

    heartbeat();
    const interval = window.setInterval(heartbeat, 45_000);
    return () => window.clearInterval(interval);
  }, [operator?.id, role]);

  if (loading || opLoading) return <Spinner />;
  if (!session) return null;
  if (role !== "operator" && role !== "admin") {
    return <Forbidden title="אין הרשאה" message="גישה לפאנל העובד מותרת לעובדים בלבד." />;
  }
  if (role === "operator" && !operator) {
    return (
      <Forbidden
        title="חשבון עובד לא מוגדר"
        message="חשבון העובד שלך עדיין לא הוגדר במערכת. פנה למנהל המערכת."
      />
    );
  }
  if (role === "operator" && operator && !operator.is_active) {
    return <Forbidden title="חשבון לא פעיל" message="חשבון העובד שלך אינו פעיל." />;
  }

  return (
    <OperatorCtx.Provider value={{ operator, isAdmin, walletBalance, refresh }}>
      <OperatorShell signOut={signOut}>{children}</OperatorShell>
    </OperatorCtx.Provider>
  );
}

function OperatorShell({ children, signOut }: { children: ReactNode; signOut: () => Promise<void> }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { operator, isAdmin, walletBalance } = useOperator();

  const isActive = (to: string, exact?: boolean) => (exact ? pathname === to : pathname.startsWith(to));

  const handleLogout = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  const statusColor =
    operator?.availability_status === "available"
      ? "bg-success"
      : operator?.availability_status === "busy"
      ? "bg-warning"
      : "bg-muted-foreground";

  return (
    <div className="min-h-screen bg-background flex flex-col" dir="rtl">
      <ImpersonationBanner />
      <div className="flex flex-1 min-h-0">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-l border-border bg-card">
        <div className="h-16 px-6 flex items-center border-b border-border">
          <Link to="/operator" className="font-bold text-lg">
            פאנל עובד
          </Link>
        </div>
        <div className="px-4 py-4 border-b border-border">
          <div className="text-sm font-medium truncate">
            {operator?.full_name ?? (isAdmin ? "מנהל מערכת" : "-")}
          </div>
          {operator && (
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", statusColor)} />
                <span className="text-xs text-muted-foreground">
                  {operator.availability_status === "available"
                    ? "זמין"
                    : operator.availability_status === "busy"
                    ? "עסוק"
                    : "לא מחובר"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Coins className="h-3.5 w-3.5" />
                <span>{(walletBalance ?? 0).toLocaleString("he-IL")} קרדיטים</span>
              </div>
            </div>
          )}
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {NAV.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive(to, exact)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-border">
          <Button variant="ghost" className="w-full justify-start gap-3" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            התנתקות
          </Button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 pb-20 md:pb-0 flex flex-col">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between md:justify-end px-4 gap-2 shrink-0">
          <Button variant="ghost" size="sm" className="md:hidden gap-2" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            יציאה
          </Button>
          {operator && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground">
              <Coins className="h-3.5 w-3.5" />
              <span>{(walletBalance ?? 0).toLocaleString("he-IL")} קרדיטים</span>
            </div>
          )}
          <NotificationBell />
        </header>
        <div className="flex-1 min-h-0">{children}</div>
      </main>

      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-border z-40">
        <div className="grid grid-cols-5">
          {NAV.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-3 text-xs",
                isActive(to, exact) ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          ))}
        </div>
      </nav>
      </div>
    </div>
  );
}

export function ConversationStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: "פתוחה", cls: "bg-primary/10 text-primary" },
    waiting: { label: "ממתינה", cls: "bg-warning/15 text-warning" },
    answered: { label: "נענתה", cls: "bg-success/15 text-success" },
    closed: { label: "סגורה", cls: "bg-muted text-muted-foreground" },
    reported: { label: "דווחה", cls: "bg-destructive/15 text-destructive" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", s.cls)}>{s.label}</span>;
}
