import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/app/")({
  component: AppIndex,
});

function AppIndex() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading || !user) return;
    (async () => {
      const { data } = await supabase
        .from("client_profiles")
        .select("age, gender, interests")
        .eq("user_id", user.id)
        .maybeSingle();
      const complete = !!(data && data.age && data.gender && data.interests && data.interests.length > 0);
      navigate({ to: complete ? "/app/characters" : "/app/onboarding", replace: true });
    })();
  }, [loading, user, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}
