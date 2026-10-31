import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, Edit, Plus, RefreshCw, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/admin/credits")({
  validateSearch: (search: Record<string, unknown>) => ({
    clientId: typeof search.clientId === "string" ? search.clientId : undefined,
  }),
  component: AdminCreditsPage,
});

type CreditPackage = {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
};

type PackageForm = {
  name: string;
  credits: string;
  price: string;
  currency: string;
  isActive: boolean;
  sortOrder: string;
};

type PackagePayload = {
  name: string;
  credits: number;
  price: number;
  currency: string;
  is_active: boolean;
  sort_order: number;
};

const EMPTY_CREDIT_PACKAGES: CreditPackage[] = [];
const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const NUMERIC_10_2_MAX = 99_999_999.99;
const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

type ClientCreditRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  status: string;
  balance: number;
  lifetime_earned: number;
  lifetime_spent: number;
};

type CreditTransaction = {
  id: string;
  amount: number;
  balance_after: number;
  type: string;
  reason: string | null;
  created_at: string;
};

const CREDIT_SETTINGS = [
  { key: "credits_enabled", label: "מערכת קרדיטים פעילה", type: "bool", default: true },
  { key: "free_credits_on_signup", label: "קרדיטים בהרשמה", type: "number", default: 10 },
  {
    key: "free_credits_reset_mode",
    label: "סוג איפוס קרדיטים חינם",
    type: "select",
    default: "none",
  },
  { key: "free_credits_reset_amount", label: "כמות קרדיטים בכל איפוס", type: "number", default: 0 },
  { key: "scoring_enabled", label: "ניקוד עובדים פעיל", type: "bool", default: true },
  {
    key: "consecutive_message_limit",
    label: "מגבלת הודעות רצופות לניקוד",
    type: "number",
    default: 3,
  },
] as const;

function AdminCreditsPage() {
  const { clientId } = Route.useSearch();
  const [activeTab, setActiveTab] = useState(clientId ? "clients" : "packages");

  useEffect(() => {
    if (clientId) setActiveTab("clients");
  }, [clientId]);

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader
        title="קרדיטים וחבילות"
        description="ניהול חבילות, יתרות לקוחות והגדרות הקרדיטים והניקוד"
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
        <TabsList className="mb-4">
          <TabsTrigger value="packages">חבילות</TabsTrigger>
          <TabsTrigger value="clients">יתרות לקוחות</TabsTrigger>
          <TabsTrigger value="settings">הגדרות</TabsTrigger>
        </TabsList>
        <TabsContent value="packages">
          <PackagesTab />
        </TabsContent>
        <TabsContent value="clients">
          <ClientCreditsTab focusedClientId={clientId} />
        </TabsContent>
        <TabsContent value="settings">
          <CreditSettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PackagesTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [editing, setEditing] = useState<Partial<CreditPackage> | null>(null);
  const previousUserId = useRef(user?.id ?? null);

  const packagesQuery = useQuery({
    queryKey: ["admin-credit-packages"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credit_packages")
        .select("id, name, credits, price, currency, is_active, sort_order, created_at")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CreditPackage[];
    },
  });
  const packages = packagesQuery.data ?? EMPTY_CREDIT_PACKAGES;
  const hasCachedPackages = packagesQuery.data !== undefined;
  const initialLoading = packagesQuery.isLoading && !hasCachedPackages;
  const refreshing = packagesQuery.isFetching && hasCachedPackages;

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    if (previousUserId.current !== currentUserId) setEditing(null);
    previousUserId.current = currentUserId;
  }, [user?.id]);

  const finishVerifiedSave = () => {
    setEditing(null);
    void Promise.allSettled([
      qc.invalidateQueries({ queryKey: ["admin-credit-packages"] }),
      qc.invalidateQueries({ queryKey: ["client-credit-packages"] }),
    ]);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">חבילות קרדיטים</CardTitle>
          <Button
            onClick={() => setEditing(newPackage())}
            disabled={packagesQuery.isError || !user}
          >
            <Plus className="h-4 w-4 ml-1" /> חבילה חדשה
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {initialLoading && (
            <div role="status" aria-label="טוען חבילות לאדמין" className="p-6">
              <Skeleton className="h-28" />
            </div>
          )}
          {refreshing && (
            <div
              role="status"
              aria-label="מרענן את חבילות האדמין"
              className="border-t px-4 py-3 text-sm text-muted-foreground"
            >
              מרענן חבילות...
            </div>
          )}
          {packagesQuery.isError && (
            <div
              role="alert"
              aria-label="שגיאת טעינת חבילות לאדמין"
              className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              <p>
                {hasCachedPackages
                  ? "רענון החבילות נכשל. החבילות המוצגות עשויות להיות לא מעודכנות."
                  : "לא ניתן לטעון את חבילות הקרדיטים כרגע."}
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
            <p className="text-center text-muted-foreground py-12">אין חבילות קרדיטים עדיין</p>
          )}
          {packages.length > 0 && (
            <div className="divide-y">
              {packages.map((pkg) => (
                <div key={pkg.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                    <CreditCard className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <div className="font-medium">{pkg.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {pkg.credits.toLocaleString("he-IL")} קרדיטים ·{" "}
                      {formatPrice(pkg.price, pkg.currency)}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">סדר {pkg.sort_order}</div>
                  <StatusBadge status={pkg.is_active ? "active" : "inactive"} />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`עריכת ${pkg.name}`}
                    onClick={() => setEditing(pkg)}
                    disabled={packagesQuery.isError || !user}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {editing && (
        <PackageDialog
          pkg={editing}
          activeUserId={user?.id ?? null}
          onClose={() => setEditing(null)}
          onSaved={finishVerifiedSave}
        />
      )}
    </>
  );
}

function PackageDialog({
  pkg,
  activeUserId,
  onClose,
  onSaved,
}: {
  pkg: Partial<CreditPackage>;
  activeUserId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PackageForm>(() => packageForm(pkg));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const originUserId = useRef(activeUserId);
  const currentUserId = useRef(activeUserId);
  const isNew = !pkg.id;
  currentUserId.current = activeUserId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isOriginalInstance = () =>
    mountedRef.current &&
    originUserId.current !== null &&
    currentUserId.current === originUserId.current;

  const submit = async () => {
    if (busyRef.current) return;
    setSaveError(null);
    const payload = validatePackageForm(form);
    if (!payload || !isOriginalInstance()) return;

    busyRef.current = true;
    setBusy(true);
    try {
      const { data, error } = isNew
        ? await supabase.from("credit_packages").insert(payload).select("id").single()
        : await supabase
            .from("credit_packages")
            .update(payload)
            .eq("id", pkg.id!)
            .select("id")
            .single();
      if (!isOriginalInstance()) return;

      const returnedId = data && typeof data.id === "string" ? data.id : null;
      if (error || !returnedId || (!isNew && returnedId !== pkg.id)) {
        setSaveError("שמירת החבילה נכשלה. הקלט נשמר, אפשר לנסות שוב.");
        toast.error("שמירת החבילה נכשלה. הקלט נשמר, אפשר לנסות שוב.");
        return;
      }

      toast.success(isNew ? "חבילה נוצרה" : "חבילה עודכנה");
      onSaved();
    } catch {
      if (!isOriginalInstance()) return;
      setSaveError("שמירת החבילה נכשלה. הקלט נשמר, אפשר לנסות שוב.");
      toast.error("שמירת החבילה נכשלה. הקלט נשמר, אפשר לנסות שוב.");
    } finally {
      busyRef.current = false;
      if (isOriginalInstance()) setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>{isNew ? "חבילה חדשה" : "עריכת חבילה"}</DialogTitle>
          <DialogDescription className="sr-only">
            הגדרת שם, כמות קרדיטים, מחיר, מטבע, סדר ומצב החבילה.
          </DialogDescription>
        </DialogHeader>
        {saveError && (
          <div
            role="alert"
            aria-label="שגיאת שמירת חבילה"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {saveError}
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label htmlFor="package-name">שם חבילה</Label>
            <Input
              id="package-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="package-credits">כמות קרדיטים</Label>
              <Input
                id="package-credits"
                type="text"
                inputMode="numeric"
                value={form.credits}
                onChange={(event) => setForm({ ...form, credits: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="package-price">מחיר</Label>
              <Input
                id="package-price"
                type="text"
                inputMode="decimal"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="package-currency">מטבע</Label>
              <Input
                id="package-currency"
                value={form.currency}
                onChange={(event) =>
                  setForm({ ...form, currency: event.target.value.toUpperCase() })
                }
                dir="ltr"
              />
            </div>
            <div>
              <Label htmlFor="package-sort-order">סדר הופעה</Label>
              <Input
                id="package-sort-order"
                type="text"
                inputMode="numeric"
                value={form.sortOrder}
                onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="package-active">פעילה</Label>
            <Switch
              id="package-active"
              checked={form.isActive}
              onCheckedChange={(value) => setForm({ ...form, isActive: value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            aria-label={busy ? "שומר..." : "שמור חבילה"}
            onClick={submit}
            disabled={busy}
          >
            {busy ? "שומר..." : "שמור"}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function packageForm(pkg: Partial<CreditPackage>): PackageForm {
  return {
    name: pkg.name ?? "",
    credits: pkg.credits?.toString() ?? "",
    price: pkg.price?.toString() ?? "",
    currency: pkg.currency ?? "ILS",
    isActive: pkg.is_active ?? true,
    sortOrder: pkg.sort_order?.toString() ?? "0",
  };
}

function validatePackageForm(form: PackageForm): PackagePayload | null {
  const name = form.name.trim();
  if (name.length < 1 || name.length > 120) {
    toast.error("שם החבילה חייב להכיל בין 1 ל-120 תווים");
    return null;
  }

  const creditsText = form.credits.trim();
  const credits = Number(creditsText);
  if (
    !INTEGER_TEXT.test(creditsText) ||
    !Number.isInteger(credits) ||
    credits < 1 ||
    credits > POSTGRES_INTEGER_MAX
  ) {
    toast.error("כמות הקרדיטים חייבת להיות מספר שלם חיובי בטווח הנתמך");
    return null;
  }

  const priceText = form.price.trim();
  const price = Number(priceText);
  const decimalPlaces = priceText.includes(".") ? priceText.split(".")[1].length : 0;
  if (
    !DECIMAL_TEXT.test(priceText) ||
    !Number.isFinite(price) ||
    price < 0 ||
    price > NUMERIC_10_2_MAX ||
    decimalPlaces > 2
  ) {
    toast.error("המחיר חייב להיות מספר לא שלילי עם עד שתי ספרות אחרי הנקודה");
    return null;
  }

  const sortOrderText = form.sortOrder.trim();
  const sortOrder = Number(sortOrderText);
  if (
    !INTEGER_TEXT.test(sortOrderText) ||
    !Number.isInteger(sortOrder) ||
    sortOrder < POSTGRES_INTEGER_MIN ||
    sortOrder > POSTGRES_INTEGER_MAX
  ) {
    toast.error("סדר ההופעה חייב להיות מספר שלם בטווח הנתמך");
    return null;
  }

  const currency = form.currency.trim();
  if (currency.length < 3 || currency.length > 8) {
    toast.error("קוד המטבע חייב להכיל בין 3 ל-8 תווים");
    return null;
  }

  return {
    name,
    credits,
    price,
    currency,
    is_active: form.isActive,
    sort_order: sortOrder,
  };
}

function ClientCreditsTab({ focusedClientId }: { focusedClientId?: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-client-credit-rows"],
    queryFn: async () => {
      const [
        { data: roles, error: rolesError },
        { data: clientProfiles, error: clientProfilesError },
      ] = await Promise.all([
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("client_profiles").select("user_id"),
      ]);
      if (rolesError) throw rolesError;
      if (clientProfilesError) throw clientProfilesError;

      const clientCandidates = new Set<string>();
      const elevatedUsers = new Set<string>();
      (roles ?? []).forEach((role) => {
        if (role.role === "client") clientCandidates.add(role.user_id);
        if (role.role === "operator" || role.role === "admin") elevatedUsers.add(role.user_id);
      });
      (clientProfiles ?? []).forEach((profile) => clientCandidates.add(profile.user_id));

      const ids = [...clientCandidates].filter((userId) => !elevatedUsers.has(userId));
      if (ids.length === 0) return [];

      const [{ data: profiles }, { data: wallets }] = await Promise.all([
        supabase
          .from("profiles")
          .select("user_id, email, display_name, status")
          .in("user_id", ids)
          .order("created_at", { ascending: false }),
        supabase
          .from("credit_wallets")
          .select("user_id, balance, lifetime_earned, lifetime_spent")
          .in("user_id", ids),
      ]);

      const walletByUser = new Map((wallets ?? []).map((wallet) => [wallet.user_id, wallet]));
      return (profiles ?? []).map((profile) => {
        const wallet = walletByUser.get(profile.user_id);
        return {
          ...profile,
          balance: wallet?.balance ?? 0,
          lifetime_earned: wallet?.lifetime_earned ?? 0,
          lifetime_spent: wallet?.lifetime_spent ?? 0,
        };
      }) as ClientCreditRow[];
    },
  });

  useEffect(() => {
    if (focusedClientId && data?.some((client) => client.user_id === focusedClientId)) {
      setSelectedId(focusedClientId);
    }
  }, [data, focusedClientId]);

  const selectedClient = useMemo(
    () => (data ?? []).find((client) => client.user_id === selectedId) ?? null,
    [data, selectedId],
  );

  const { data: transactions, isLoading: transactionsLoading } = useQuery({
    queryKey: ["admin-client-credit-transactions", selectedId],
    enabled: !!selectedId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credit_transactions")
        .select("id, amount, balance_after, type, reason, created_at")
        .eq("user_id", selectedId!)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as CreditTransaction[];
    },
  });

  const filtered = (data ?? []).filter((client) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      client.email?.toLowerCase().includes(q) || client.display_name?.toLowerCase().includes(q)
    );
  });

  const adjust = async () => {
    if (!selectedClient) return;
    const parsedAmount = Number(amount);
    if (!Number.isInteger(parsedAmount) || parsedAmount === 0) {
      toast.error("יש להזין כמות שלמה ושונה מ-0");
      return;
    }
    if (reason.trim().length < 3) {
      toast.error("חובה להזין סיבה לפעולה");
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("admin_adjust_client_credits", {
      _user_id: selectedClient.user_id,
      _amount: parsedAmount,
      _reason: reason.trim(),
    });
    setBusy(false);

    if (error) {
      toast.error("עדכון יתרה נכשל: " + error.message);
      return;
    }

    toast.success(parsedAmount > 0 ? "קרדיטים נוספו" : "קרדיטים הופחתו");
    setAmount("");
    setReason("");
    qc.invalidateQueries({ queryKey: ["admin-client-credit-rows"] });
    qc.invalidateQueries({
      queryKey: ["admin-client-credit-transactions", selectedClient.user_id],
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">לקוחות</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש לפי שם או אימייל"
              className="pr-10"
            />
          </div>
          {isLoading && <Skeleton className="h-40" />}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-10">לא נמצאו לקוחות</p>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="divide-y rounded-md border">
              {filtered.map((client) => (
                <button
                  key={client.user_id}
                  onClick={() => setSelectedId(client.user_id)}
                  className={`w-full text-right p-3 flex items-center gap-3 hover:bg-accent ${
                    selectedId === client.user_id ? "bg-accent" : ""
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{client.display_name ?? "ללא שם"}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {client.email ?? "אין אימייל"}
                    </div>
                  </div>
                  <div className="text-sm font-semibold">{client.balance}</div>
                  <StatusBadge status={client.status} />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ניהול יתרה</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedClient && (
              <p className="text-sm text-muted-foreground">בחר לקוח מהרשימה כדי לנהל קרדיטים.</p>
            )}
            {selectedClient && (
              <>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <Stat label="יתרה" value={selectedClient.balance} />
                  <Stat label="נצבר" value={selectedClient.lifetime_earned} />
                  <Stat label="נוצל" value={selectedClient.lifetime_spent} />
                </div>
                <div>
                  <Label>כמות לשינוי</Label>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="לדוגמה 10 או -5"
                    dir="ltr"
                  />
                </div>
                <div>
                  <Label>סיבה לפעולה</Label>
                  <Textarea
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="חובה לתיעוד היסטוריית הפעולות"
                  />
                </div>
                <Button className="w-full" onClick={adjust} disabled={busy}>
                  <Save className="h-4 w-4 ml-1" />
                  {busy ? "מעדכן..." : "עדכן יתרה"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">היסטוריית פעולות</CardTitle>
          </CardHeader>
          <CardContent>
            {!selectedClient && <p className="text-sm text-muted-foreground">אין לקוח נבחר.</p>}
            {selectedClient && transactionsLoading && <Skeleton className="h-32" />}
            {selectedClient && !transactionsLoading && (transactions?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">אין פעולות קרדיטים.</p>
            )}
            {selectedClient && !transactionsLoading && transactions && transactions.length > 0 && (
              <div className="space-y-2">
                {transactions.map((tx) => (
                  <div key={tx.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={
                          tx.amount >= 0
                            ? "text-success font-semibold"
                            : "text-destructive font-semibold"
                        }
                      >
                        {tx.amount > 0 ? "+" : ""}
                        {tx.amount}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(tx.created_at).toLocaleString("he-IL")}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {tx.type} · יתרה אחרי: {tx.balance_after}
                    </div>
                    {tx.reason && <div className="mt-1">{tx.reason}</div>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CreditSettingsTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-credit-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("key, value")
        .in(
          "key",
          CREDIT_SETTINGS.map((setting) => setting.key),
        );
      if (error) throw error;
      return new Map((data ?? []).map((row) => [row.key, row.value]));
    },
  });

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string | number | boolean> = {};
    CREDIT_SETTINGS.forEach((setting) => {
      const stored = data.get(setting.key);
      next[setting.key] =
        typeof stored === "string" || typeof stored === "number" || typeof stored === "boolean"
          ? stored
          : setting.default;
    });
    setForm(next);
  }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      for (const setting of CREDIT_SETTINGS) {
        const { error } = await supabase
          .from("system_settings")
          .upsert(
            { key: setting.key, value: normalizeSetting(setting.key, form[setting.key]) },
            { onConflict: "key" },
          );
        if (error) throw error;
      }
      toast.success("הגדרות הקרדיטים והניקוד נשמרו");
      qc.invalidateQueries({ queryKey: ["admin-credit-settings"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      toast.error("שמירת הגדרות נכשלה: " + message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">הגדרות קרדיטים וניקוד</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 max-w-2xl">
        {isLoading && <Skeleton className="h-48" />}
        {!isLoading &&
          CREDIT_SETTINGS.map((setting) => (
            <div
              key={setting.key}
              className={setting.type === "bool" ? "flex items-center justify-between" : ""}
            >
              <Label className={setting.type === "bool" ? "" : "block mb-1"}>{setting.label}</Label>
              {setting.type === "bool" ? (
                <Switch
                  checked={!!form[setting.key]}
                  onCheckedChange={(value) => setForm({ ...form, [setting.key]: value })}
                />
              ) : setting.type === "select" ? (
                <Select
                  value={String(form[setting.key] ?? setting.default)}
                  onValueChange={(value) => setForm({ ...form, [setting.key]: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">חד פעמי בלבד</SelectItem>
                    <SelectItem value="daily">יומי</SelectItem>
                    <SelectItem value="monthly">חודשי</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type="number"
                  min={0}
                  value={String(form[setting.key] ?? "")}
                  onChange={(e) => setForm({ ...form, [setting.key]: Number(e.target.value) })}
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
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value.toLocaleString("he-IL")}</div>
    </div>
  );
}

function newPackage(): Partial<CreditPackage> {
  return {
    name: "",
    credits: 10,
    price: 0,
    currency: "ILS",
    is_active: true,
    sort_order: 0,
  };
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

function normalizeSetting(key: string, value: string | number | boolean | undefined) {
  if (key === "credits_enabled" || key === "scoring_enabled") return !!value;
  if (
    key === "free_credits_on_signup" ||
    key === "free_credits_reset_amount" ||
    key === "consecutive_message_limit"
  ) {
    return Math.max(0, Number(value ?? 0));
  }
  return String(value ?? "none");
}
