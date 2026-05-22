import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Coins, MessageCircle, PackageOpen } from "lucide-react";
import { ClientLayout } from "@/components/client/ClientLayout";
import { supabase } from "@/integrations/supabase/client";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useEffect } from "react";

export const Route = createFileRoute("/app/packages")({
  component: PackagesPage,
});

type CreditPackage = {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  sort_order: number;
};

function PackagesPage() {
  useEffect(() => {
    void trackAnalyticsEvent({
      eventName: "packages_viewed",
      metadata: { source: "client_packages_page" },
      dedupeSeconds: 900,
    });
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["client-credit-packages"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credit_packages")
        .select("id, name, credits, price, currency, sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CreditPackage[];
    },
  });

  const contactForPackage = (pkg: CreditPackage) => {
    toast.info(`בקשת רכישה נרשמה עבור ${pkg.name}. בשלב זה התשלום מתבצע ידנית מול הצוות.`);
  };

  return (
    <ClientLayout>
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">חבילות קרדיטים</h1>
          <p className="text-sm text-muted-foreground mt-1">
            בחר חבילה כדי להמשיך לשלוח הודעות. סליקה אוטומטית תתווסף בהמשך.
          </p>
        </header>

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-64" />
            ))}
          </div>
        )}

        {error && (
          <div className="text-center py-12 text-destructive">טעינת החבילות נכשלה</div>
        )}

        {!isLoading && !error && data && data.length === 0 && (
          <div className="text-center py-16">
            <PackageOpen className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">אין חבילות פעילות כרגע</p>
          </div>
        )}

        {!isLoading && data && data.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.map((pkg) => (
              <Card key={pkg.id} className="overflow-hidden">
                <CardContent className="p-5 flex flex-col min-h-64">
                  <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
                    <Coins className="h-6 w-6" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold">{pkg.name}</h2>
                    <div className="mt-3 text-3xl font-bold">
                      {pkg.credits.toLocaleString("he-IL")}
                      <span className="text-sm font-normal text-muted-foreground mr-1">קרדיטים</span>
                    </div>
                    <div className="mt-2 text-lg font-medium">{formatPrice(pkg.price, pkg.currency)}</div>
                    <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        הודעות נוספות לדמויות
                      </div>
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        היתרה נשמרת בחשבון
                      </div>
                    </div>
                  </div>
                  <Button className="w-full mt-5" onClick={() => contactForPackage(pkg)}>
                    <MessageCircle className="h-4 w-4 ml-1" />
                    בקשת רכישה ידנית
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </ClientLayout>
  );
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: currency || "ILS",
  }).format(Number(price));
}
