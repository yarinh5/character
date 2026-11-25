import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export function RecoveryAccessGate({ children }: { children: ReactNode }) {
  const state = useQuery({
    queryKey: ["restore-recovery-access"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_restore_recovery_access_state");
      if (error || !data?.[0]) throw error ?? new Error("recovery_state_missing");
      return data[0];
    },
    retry: false,
    staleTime: 15_000,
  });

  if (state.isLoading) return <p className="p-6 text-center" role="status">בודק את מצב המערכת…</p>;
  if (state.isError || state.data?.blocked !== false) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-lg items-center p-6" dir="rtl">
        <section className="w-full rounded-xl border bg-card p-6 text-center shadow-sm" role="alert">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-600" aria-hidden="true" />
          <h1 className="text-xl font-semibold">המערכת במצב תחזוקה</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            הפעילות הרגילה חסומה בזמן בדיקות התאוששות. מידע תפעולי פנימי אינו מוצג כאן.
          </p>
          <Button className="mt-4" variant="outline" onClick={() => void state.refetch()}>
            בדיקה מחדש
          </Button>
        </section>
      </main>
    );
  }
  return <>{children}</>;
}
