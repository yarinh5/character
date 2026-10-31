import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Coins, PackageOpen, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { trackAnalyticsEvent } from "@/lib/analyticsEvents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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

const EMPTY_PACKAGES: CreditPackage[] = [];

function PackagesPage() {
  useEffect(() => {
    void trackAnalyticsEvent({
      eventName: "packages_viewed",
      metadata: { source: "client_packages_page" },
      dedupeSeconds: 900,
    });
  }, []);

  const packagesQuery = useQuery({
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
  const packages = packagesQuery.data ?? EMPTY_PACKAGES;
  const hasCachedPackages = packagesQuery.data !== undefined;
  const initialLoading = packagesQuery.isLoading && !hasCachedPackages;
  const refreshing = packagesQuery.isFetching && hasCachedPackages;

  return (
    <>
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">חבילות קרדיטים</h1>
          <p className="text-sm text-muted-foreground mt-1">קטלוג החבילות והמחירים הזמינים כעת.</p>
        </header>

        <div
          role="note"
          className="mb-5 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
        >
          רכישה מתוך האתר אינה זמינה כרגע. לא נשלחה בקשה ולא בוצע חיוב.
        </div>

        {initialLoading && (
          <div
            role="status"
            aria-label="טוען חבילות"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-64" />
            ))}
          </div>
        )}

        {refreshing && (
          <div
            role="status"
            aria-label="מרענן את קטלוג החבילות"
            className="mb-4 text-sm text-muted-foreground"
          >
            מרענן חבילות...
          </div>
        )}

        {packagesQuery.isError && (
          <div
            role="alert"
            aria-label="שגיאת טעינת חבילות"
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            <p>
              {hasCachedPackages
                ? "רענון החבילות נכשל. החבילות המוצגות עשויות להיות לא מעודכנות."
                : "לא ניתן לטעון את החבילות כרגע."}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void packagesQuery.refetch()}
              disabled={packagesQuery.isFetching}
            >
              <RefreshCw className="h-4 w-4" />
              {packagesQuery.isFetching ? "מנסה שוב..." : "נסה לטעון חבילות שוב"}
            </Button>
          </div>
        )}

        {packagesQuery.isSuccess && packages.length === 0 && (
          <div className="text-center py-16">
            <PackageOpen className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">אין חבילות פעילות כרגע</p>
          </div>
        )}

        {packages.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {packages.map((pkg) => (
              <Card key={pkg.id} className="overflow-hidden">
                <CardContent className="p-5 flex flex-col min-h-64">
                  <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
                    <Coins className="h-6 w-6" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold">{pkg.name}</h2>
                    <div className="mt-3 text-3xl font-bold">
                      {pkg.credits.toLocaleString("he-IL")}
                      <span className="text-sm font-normal text-muted-foreground mr-1">
                        קרדיטים
                      </span>
                    </div>
                    <div className="mt-2 text-lg font-medium">
                      {formatPrice(pkg.price, pkg.currency)}
                    </div>
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
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function formatPrice(price: number, currency: string) {
  const currencyCode = currency?.trim() || "ILS";
  const numericPrice = Number(price);
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currencyCode,
    }).format(numericPrice);
  } catch {
    return `${numericPrice.toLocaleString("he-IL", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currencyCode}`;
  }
}
