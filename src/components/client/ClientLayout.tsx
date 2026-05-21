import { ReactNode, useEffect } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Users, MessageCircle, User, LogOut, Coins } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const NAV = [
  { to: "/app/characters", label: "דמויות", icon: Users },
  { to: "/app/conversations", label: "שיחות", icon: MessageCircle },
  { to: "/app/profile", label: "פרופיל", icon: User },
  { to: "/app/packages", label: "חבילות", icon: Coins },
] as const;

export function ClientLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  const isActive = (to: string) => pathname.startsWith(to);

  return (
    <div className="min-h-screen bg-background flex" dir="rtl">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-l border-border bg-card">
        <div className="h-16 px-6 flex items-center border-b border-border">
          <Link to="/app/characters" className="font-bold text-lg text-foreground">
            Character Chat
          </Link>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive(to)
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

      {/* Main */}
      <main className="flex-1 min-w-0 pb-20 md:pb-0">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-border z-40">
        <div className="grid grid-cols-5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-3 text-xs",
                isActive(to) ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          ))}
          <button
            onClick={handleLogout}
            className="flex flex-col items-center justify-center gap-1 py-3 text-xs text-muted-foreground"
          >
            <LogOut className="h-5 w-5" />
            יציאה
          </button>
        </div>
      </nav>
    </div>
  );
}

export function RequireClient({ children }: { children: ReactNode }) {
  const { loading, session, role } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    if (role && role !== "client") {
      navigate({ to: role === "admin" ? "/admin" : "/operator" });
    }
  }, [loading, session, role, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!session || (role && role !== "client")) return null;

  return <>{children}</>;
}
