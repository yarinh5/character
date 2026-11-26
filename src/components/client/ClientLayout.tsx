import { ReactNode, useEffect, useState } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  Users,
  MessageCircle,
  User,
  LogOut,
  Coins,
  Star,
  LifeBuoy,
  MoreHorizontal,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { SkipLink } from "@/components/common/SkipLink";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { to: "/app/characters", label: "דמויות", icon: Users },
  { to: "/app/favorites", label: "מועדפים", icon: Star },
  { to: "/app/conversations", label: "שיחות", icon: MessageCircle },
  { to: "/app/profile", label: "פרופיל", icon: User },
  { to: "/app/packages", label: "חבילות", icon: Coins },
  { to: "/app/support", label: "תמיכה", icon: LifeBuoy },
] as const;

function hasRequiredOnboardingFields(
  profile: {
    onboarding_completed_at: string | null;
    computed_age: number | null;
    age: number | null;
    first_name: string | null;
    last_name: string | null;
    city_id: string | null;
    bio: string | null;
    relationship_status: string | null;
    smoking_status: string | null;
    preferred_min_age: number | null;
    preferred_max_age: number | null;
    preferred_distance_km: number | null;
    content_preferences: unknown;
    character_preferences: unknown;
  } | null,
) {
  if (!profile?.onboarding_completed_at) return false;
  const age = profile.computed_age ?? profile.age;
  return (
    age !== null &&
    age >= 18 &&
    age <= 120 &&
    !!profile.first_name?.trim() &&
    !!profile.last_name?.trim() &&
    profile.city_id != null &&
    !!profile.bio?.trim() &&
    profile.relationship_status != null &&
    profile.smoking_status != null &&
    profile.preferred_min_age != null &&
    profile.preferred_max_age != null &&
    profile.preferred_distance_km != null &&
    Array.isArray(profile.content_preferences) &&
    profile.content_preferences.length > 0 &&
    Array.isArray(profile.character_preferences) &&
    profile.character_preferences.length > 0
  );
}

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
      <SkipLink />
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
      <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 pb-20 md:pb-0">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav
        aria-label="ניווט לקוח במובייל"
        className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-border z-40"
      >
        <div className="grid grid-cols-5">
          {NAV.slice(0, 4).map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-xs",
                isActive(to) ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          ))}
          <DropdownMenu dir="rtl">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-xs",
                  NAV.slice(4).some(({ to }) => isActive(to))
                    ? "text-primary"
                    : "text-muted-foreground",
                )}
              >
                <MoreHorizontal className="h-5 w-5" />
                עוד
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-44">
              {NAV.slice(4).map(({ to, label, icon: Icon }) => (
                <DropdownMenuItem key={to} asChild>
                  <Link to={to} className="min-h-11">
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem className="min-h-11" onSelect={() => void handleLogout()}>
                <LogOut className="h-4 w-4" />
                יציאה
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </div>
  );
}

export function RequireClient({ children }: { children: ReactNode }) {
  const { loading, session, role, signOut } = useAuth();
  const sessionUserId = session?.user.id;
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusFailed, setStatusFailed] = useState(false);
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [clientStatus, setClientStatus] = useState<string | null>(null);
  const [checkedStatusUserId, setCheckedStatusUserId] = useState<string | null>(null);
  const [onboardingGate, setOnboardingGate] = useState<
    "loading" | "allowed" | "redirecting" | "error"
  >("loading");
  const [checkedOnboardingKey, setCheckedOnboardingKey] = useState<string | null>(null);
  const [onboardingRefresh, setOnboardingRefresh] = useState(0);
  const onboardingKey = `${sessionUserId ?? ""}:${pathname}`;

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

  useEffect(() => {
    if (loading) return;
    if (!sessionUserId || role !== "client") {
      setStatusLoading(false);
      return;
    }

    let alive = true;
    setStatusLoading(true);
    setStatusFailed(false);
    Promise.resolve(
      supabase
        .from("profiles")
        .select("status, deleted_at, pii_archived_at")
        .eq("user_id", sessionUserId)
        .maybeSingle(),
    )
      .then(async ({ data, error }) => {
        if (!alive) return;
        if (error || !data) {
          setStatusFailed(true);
          setCheckedStatusUserId(sessionUserId);
          setStatusLoading(false);
          return;
        }
        const status = data.deleted_at || data.pii_archived_at ? "archived" : data.status;
        setClientStatus(status);
        setCheckedStatusUserId(sessionUserId);
        setStatusLoading(false);
        if (status !== "active") {
          await signOut();
          navigate({ to: "/login" });
        }
      })
      .catch(() => {
        if (alive) {
          setStatusFailed(true);
          setCheckedStatusUserId(sessionUserId);
          setStatusLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, [loading, navigate, role, sessionUserId, signOut, statusRefresh]);

  useEffect(() => {
    const refresh = () => setOnboardingRefresh((version) => version + 1);
    window.addEventListener("client-profile-updated", refresh);
    return () => window.removeEventListener("client-profile-updated", refresh);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!sessionUserId || role !== "client") {
      setOnboardingGate("allowed");
      return;
    }

    let alive = true;
    setOnboardingGate("loading");

    Promise.all([
      supabase
        .from("system_settings")
        .select("value")
        .eq("key", "mandatory_onboarding_enabled")
        .maybeSingle(),
      supabase
        .from("client_profiles")
        .select(
          "onboarding_completed_at, computed_age, age, first_name, last_name, city_id, bio, relationship_status, smoking_status, preferred_min_age, preferred_max_age, preferred_distance_km, content_preferences, character_preferences",
        )
        .eq("user_id", sessionUserId)
        .maybeSingle(),
    ])
      .then(([{ data: setting, error: settingError }, { data: profile, error: profileError }]) => {
        if (!alive) return;
        if (settingError || profileError || typeof setting?.value !== "boolean") {
          setOnboardingGate("error");
          setCheckedOnboardingKey(onboardingKey);
          return;
        }

        const mandatory = setting.value;
        const completed = hasRequiredOnboardingFields(profile);
        const isOnboardingRoute = pathname.startsWith("/app/onboarding");

        if (mandatory && !completed && !isOnboardingRoute) {
          setOnboardingGate("redirecting");
          setCheckedOnboardingKey(onboardingKey);
          navigate({ to: "/app/onboarding", replace: true });
          return;
        }

        if (pathname === "/app" || pathname === "/app/") {
          setOnboardingGate("redirecting");
          setCheckedOnboardingKey(onboardingKey);
          navigate({ to: "/app/characters", replace: true });
          return;
        }

        setOnboardingGate("allowed");
        setCheckedOnboardingKey(onboardingKey);
      })
      .catch(() => {
        if (alive) {
          setOnboardingGate("error");
          setCheckedOnboardingKey(onboardingKey);
        }
      });

    return () => {
      alive = false;
    };
  }, [loading, navigate, onboardingKey, onboardingRefresh, pathname, role, sessionUserId]);

  if (
    loading ||
    statusLoading ||
    (session && role === "client" && checkedStatusUserId !== sessionUserId) ||
    (session && role === "client" && checkedOnboardingKey !== onboardingKey) ||
    onboardingGate === "loading" ||
    onboardingGate === "redirecting"
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (session && role === "client" && (statusFailed || onboardingGate === "error")) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4" dir="rtl">
        <div role="alert" className="space-y-3 text-center">
          <p>לא ניתן לאמת את מצב החשבון כרגע.</p>
          <Button
            type="button"
            onClick={() => {
              setStatusRefresh((version) => version + 1);
              setOnboardingRefresh((version) => version + 1);
            }}
          >
            נסה שוב
          </Button>
        </div>
      </div>
    );
  }

  if (!session || (role && role !== "client") || clientStatus !== "active") return null;

  return <>{children}</>;
}
