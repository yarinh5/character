import { ReactNode, useEffect } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  UserCog,
  Sparkles,
  MessageCircle,
  Flag,
  Settings,
  LogOut,
  Coins,
  BarChart3,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import { Mail, ScrollText } from "lucide-react";
import { NotificationBell } from "@/components/common/NotificationBell";
import { ImpersonationBanner } from "@/components/common/ImpersonationBanner";

type NavTo =
  | "/admin"
  | "/admin/users"
  | "/admin/invites"
  | "/admin/clients"
  | "/admin/operators"
  | "/admin/characters"
  | "/admin/conversations"
  | "/admin/credits"
  | "/admin/analytics"
  | "/admin/reports"
  | "/admin/audit-logs"
  | "/admin/settings";

const NAV: { to: NavTo; label: string; icon: typeof Users; exact?: boolean }[] = [
  { to: "/admin", label: "דשבורד", icon: LayoutDashboard, exact: true },
  { to: "/admin/users", label: "משתמשים", icon: Users },
  { to: "/admin/invites", label: "הזמנות", icon: Mail },
  { to: "/admin/clients", label: "לקוחות", icon: Users },
  { to: "/admin/operators", label: "עובדים", icon: UserCog },
  { to: "/admin/characters", label: "דמויות", icon: Sparkles },
  { to: "/admin/conversations", label: "שיחות", icon: MessageCircle },
  { to: "/admin/credits", label: "קרדיטים", icon: Coins },
  { to: "/admin/reports", label: "דיווחים", icon: Flag },
  { to: "/admin/audit-logs", label: "יומן פעולות", icon: ScrollText },
  { to: "/admin/settings", label: "הגדרות", icon: Settings },
  { to: "/admin/analytics", label: "אנליטיקות", icon: BarChart3 },
];

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function Forbidden({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" dir="rtl">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">אין הרשאה</h1>
        <p className="text-muted-foreground mb-6">{message}</p>
        <Button onClick={() => navigate({ to: "/" })}>חזרה לדף הבית</Button>
      </div>
    </div>
  );
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { loading, session, role } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    if (role === "client") navigate({ to: "/app/characters" });
    else if (role === "operator") navigate({ to: "/operator" });
  }, [loading, session, role, navigate]);

  if (loading) return <Spinner />;
  if (!session) return null;
  if (role !== "admin") {
    return <Forbidden message="אזור הניהול מותר למנהלי מערכת בלבד." />;
  }
  return <AdminShell>{children}</AdminShell>;
}

function AdminShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { signOut, user } = useAuth();

  const isActive = (to: string, exact?: boolean) =>
    exact ? pathname === to : pathname.startsWith(to);

  const handleLogout = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col" dir="rtl">
      <ImpersonationBanner />
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex w-64 shrink-0 flex-col border-l border-border bg-card">
          <div className="h-16 px-6 flex items-center border-b border-border">
            <Link to="/admin" className="font-bold text-lg">
              פאנל ניהול
            </Link>
          </div>
          <div className="px-4 py-4 border-b border-border">
            <div className="text-sm font-medium truncate">{user?.email ?? "—"}</div>
            <div className="text-xs text-muted-foreground mt-1">מנהל מערכת</div>
          </div>
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
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
        </aside>

        <main className="flex-1 min-w-0 pb-24 md:pb-0 flex flex-col">
          <header className="h-14 border-b border-border bg-card flex items-center justify-end px-4 gap-2 shrink-0">
            <NotificationBell />
          </header>
          <div className="flex-1 min-h-0">{children}</div>
        </main>

        <Button
          variant="secondary"
          size="sm"
          className="fixed bottom-20 right-4 z-50 gap-2 shadow-lg md:bottom-4"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          יציאה
        </Button>

        <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-border z-40 overflow-x-auto">
          <div className="flex min-w-max">
            {NAV.map(({ to, label, icon: Icon, exact }) => (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2.5 px-4 text-[11px] min-w-[68px]",
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

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: "פתוחה", cls: "bg-primary/10 text-primary" },
    waiting: { label: "ממתינה", cls: "bg-warning/15 text-warning" },
    answered: { label: "נענתה", cls: "bg-success/15 text-success" },
    closed: { label: "סגורה", cls: "bg-muted text-muted-foreground" },
    reported: { label: "דווחה", cls: "bg-destructive/15 text-destructive" },
    available: { label: "זמין", cls: "bg-success/15 text-success" },
    busy: { label: "עסוק", cls: "bg-warning/15 text-warning" },
    offline: { label: "לא מחובר", cls: "bg-muted text-muted-foreground" },
    active: { label: "פעיל", cls: "bg-success/15 text-success" },
    inactive: { label: "לא פעיל", cls: "bg-muted text-muted-foreground" },
    blocked: { label: "חסום", cls: "bg-destructive/15 text-destructive" },
    suspended: { label: "מושעה", cls: "bg-warning/15 text-warning" },
    reviewed: { label: "בטיפול", cls: "bg-primary/10 text-primary" },
    resolved: { label: "טופל", cls: "bg-success/15 text-success" },
    dismissed: { label: "נדחה", cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap", s.cls)}>
      {s.label}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}
