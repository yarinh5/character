import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Coins,
  Copy,
  Edit,
  Link as LinkIcon,
  Mail,
  Plus,
  RotateCcw,
  Undo2,
  UserPlus,
  UserRoundPlus,
  UserX,
} from "lucide-react";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AnalyticsContent } from "@/routes/operator.analytics";
import { fetchOperatorPerformance } from "@/lib/operatorPerformance";
import { adminCreateInvite } from "@/lib/invites.functions";
import { adminSendPasswordReset } from "@/lib/impersonation.functions";
import {
  adminConvertOperatorToClient,
  adminCreateOperatorUser,
  adminArchiveOperator,
  adminListOperators,
  adminPromoteClientToOperator,
  adminRestoreOperator,
  adminUpdateOperator,
} from "@/lib/admin-operators.functions";

export const Route = createFileRoute("/admin/operators")({
  component: OperatorsPage,
});

type Operator = {
  id: string;
  user_id: string;
  full_name: string;
  email: string | null;
  role: "admin" | "operator";
  is_active: boolean;
  availability_status: "available" | "busy" | "offline";
  created_at: string;
  deleted_at?: string | null;
  chars: number;
  active: number;
  credit_balance: number;
};

type CharacterRow = {
  id: string;
  name: string;
  avatar_url?: string | null;
  is_active?: boolean | null;
};

function OperatorsPage() {
  const qc = useQueryClient();
  const listOperators = useServerFn(adminListOperators);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [editing, setEditing] = useState<Operator | null>(null);
  const [assignOp, setAssignOp] = useState<Operator | null>(null);
  const [performanceOp, setPerformanceOp] = useState<Operator | null>(null);
  const [creditsOp, setCreditsOp] = useState<Operator | null>(null);
  const [resetOp, setResetOp] = useState<Operator | null>(null);
  const [archiveOp, setArchiveOp] = useState<Operator | null>(null);
  const [restoreOp, setRestoreOp] = useState<Operator | null>(null);
  const [convertOp, setConvertOp] = useState<Operator | null>(null);
  const [createdInvite, setCreatedInvite] = useState<{ token: string; email: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-operators", showArchived],
    queryFn: async () => (await listOperators({ data: { show_archived_only: showArchived } })) as Operator[],
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-operators"] });
    qc.invalidateQueries({ queryKey: ["admin-users"] });
  };

  const refreshCreditData = () => {
    refresh();
    qc.invalidateQueries({ queryKey: ["admin-operator-performance"] });
    qc.invalidateQueries({ queryKey: ["admin-operator-credits"] });
  };

  useEffect(() => {
    const channel = supabase
      .channel("admin-operators-wallets")
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_wallets" }, refreshCreditData)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_transactions" }, refreshCreditData)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader
        title="עובדים"
        description="ניהול עובדים, הזמנות, סטטוס ושיוך לדמויות ממקום אחד"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPromoteOpen(true)}>
              <UserRoundPlus className="h-4 w-4 ml-1" /> הפוך לקוח לעובד
            </Button>
            <Button variant="outline" onClick={() => setInviteOpen(true)}>
              <Mail className="h-4 w-4 ml-1" /> הזמן עובד
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 ml-1" /> צור עובד חדש
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <div className="text-sm font-medium">טבלת עובדים</div>
              <div className="text-xs text-muted-foreground">
                במצב רגיל מוצגים עובדים פעילים/לא פעילים בלבד. במצב ארכיון מוצגים רק עובדים שנמחקו.
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span>הצג עובדים שנמחקו בלבד</span>
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
            </label>
          </div>
          {isLoading && (
            <div className="p-6">
              <Skeleton className="h-32" />
            </div>
          )}
          {!isLoading && error && (
            <p className="text-center text-destructive py-12">טעינת רשימת העובדים נכשלה.</p>
          )}
          {!isLoading && !error && (data?.length ?? 0) === 0 && (
            <p className="text-center text-muted-foreground py-12">
              {showArchived ? "אין עובדים שנמחקו" : "אין עובדים עדיין"}
            </p>
          )}
          {!isLoading && !error && data && data.length > 0 && (
            <div className="divide-y">
              {data.map((operator) => (
                <div
                  key={operator.id}
                  className="grid grid-cols-[40px_92px_210px_120px_170px_170px_210px] items-center gap-x-4 gap-y-3 p-4 max-xl:grid-cols-[auto_minmax(0,1fr)_auto] max-md:grid-cols-[auto_minmax(0,1fr)]"
                >
                  <div className="h-10 w-10 rounded-full bg-muted overflow-hidden justify-self-start">
                    <div className="h-full w-full flex items-center justify-center text-sm font-medium">
                      {(operator.full_name ?? operator.email ?? "?")[0]?.toUpperCase()}
                    </div>
                  </div>

                  <div className="min-w-0 justify-self-stretch">
                    <div className="font-medium truncate">{operator.full_name}</div>
                  </div>

                  <div className="min-w-0 justify-self-stretch truncate text-left text-xs text-muted-foreground" dir="ltr">
                    {operator.email ?? "-"}
                  </div>

                  <div className="min-w-0 justify-self-stretch">
                    {operator.role === "admin" && (
                      <span className="inline-flex w-fit text-xs px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                        מנהל שפועל גם כעובד
                      </span>
                    )}
                  </div>

                  <div className="inline-flex items-center gap-2 whitespace-nowrap max-xl:col-start-2 max-xl:row-start-2 max-md:col-span-2 max-md:col-start-1">
                    {operator.deleted_at ? <StatusBadge status="archived" /> : <OperatorActiveToggle operator={operator} onDone={refresh} />}
                  </div>

                  <div className="inline-flex items-center gap-4 whitespace-nowrap text-xs text-muted-foreground max-xl:col-start-2 max-xl:row-start-3 max-md:col-span-2 max-md:col-start-1">
                    <span className="whitespace-nowrap">{operator.chars} דמויות</span>
                    <span className="whitespace-nowrap">{operator.active} שיחות פעילות</span>
                    <span className="whitespace-nowrap">{operator.credit_balance.toLocaleString("he-IL")} קרדיטים</span>
                  </div>

                  <div className="inline-flex items-center justify-end gap-1 whitespace-nowrap max-xl:row-span-3 max-md:col-span-2 max-md:justify-start">
                    <Button size="sm" variant="ghost" onClick={() => setPerformanceOp(operator)} title="ביצועי עובד">
                      <BarChart3 className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCreditsOp(operator)}>
                      <Coins className="h-4 w-4 ml-1" /> ניהול קרדיטים
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAssignOp(operator)} title="שיוך דמויות">
                      <LinkIcon className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(operator)} title="עריכת עובד">
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setResetOp(operator)} title="שליחת איפוס סיסמה">
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    {operator.deleted_at && (
                      <Button size="sm" variant="ghost" onClick={() => setRestoreOp(operator)} title="שחזר עובד">
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setArchiveOp(operator)}
                      disabled={Boolean(operator.deleted_at) || operator.role === "admin"}
                      title={operator.role === "admin" ? "לא ניתן לארכב מנהל" : "השבתת עובד"}
                    >
                      <UserX className="h-4 w-4" />
                    </Button>
                    {operator.role !== "admin" && !operator.deleted_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConvertOp(operator)}
                        title="הפוך ללקוח"
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateOperatorDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      )}
      {inviteOpen && (
        <CreateInviteDialog
          onClose={() => setInviteOpen(false)}
          onCreated={(token, email) => {
            setInviteOpen(false);
            setCreatedInvite({ token, email });
          }}
        />
      )}
      {createdInvite && (
        <InviteLinkDialog
          token={createdInvite.token}
          email={createdInvite.email}
          onClose={() => setCreatedInvite(null)}
        />
      )}
      {promoteOpen && (
        <PromoteClientDialog
          onClose={() => setPromoteOpen(false)}
          onDone={() => {
            setPromoteOpen(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditOperatorDialog
          operator={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {assignOp && (
        <AssignCharactersDialog
          operator={assignOp}
          onClose={() => setAssignOp(null)}
          onDone={() => {
            setAssignOp(null);
            refresh();
          }}
        />
      )}
      {performanceOp && <OperatorPerformanceDialog operator={performanceOp} onClose={() => setPerformanceOp(null)} />}
      {creditsOp && (
        <OperatorCreditsDialog
          operator={creditsOp}
          onClose={() => setCreditsOp(null)}
          onChanged={refreshCreditData}
        />
      )}
      {resetOp && <ResetPasswordDialog operator={resetOp} onClose={() => setResetOp(null)} />}
      {archiveOp && (
        <ArchiveOperatorConfirm
          operator={archiveOp}
          onClose={() => setArchiveOp(null)}
          onDone={() => {
            setArchiveOp(null);
            refresh();
          }}
        />
      )}
      {restoreOp && (
        <RestoreOperatorConfirm
          operator={restoreOp}
          onClose={() => setRestoreOp(null)}
          onDone={() => {
            setRestoreOp(null);
            refresh();
          }}
        />
      )}
      {convertOp && (
        <ConvertOperatorConfirm
          operator={convertOp}
          onClose={() => setConvertOp(null)}
          onDone={() => {
            setConvertOp(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

type OperatorCreditTransaction = {
  id: string;
  amount: number;
  balance_after: number;
  type: string;
  reason: string | null;
  created_at: string;
  message_id: string | null;
  metadata: unknown | null;
};

function OperatorCreditsDialog({
  operator,
  onClose,
  onChanged,
}: {
  operator: Operator;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-operator-credits", operator.id],
    queryFn: async () => {
      const [walletResult, transactionsResult] = await Promise.all([
        supabase
          .from("credit_wallets")
          .select("balance, lifetime_earned, lifetime_spent")
          .eq("user_id", operator.user_id)
          .maybeSingle(),
        supabase
          .from("credit_transactions")
          .select("id, amount, balance_after, type, reason, created_at, message_id, metadata")
          .eq("user_id", operator.user_id)
          .in("type", ["operator_message_payout", "message_payout", "sticker_payout", "admin_adjustment"])
          .order("created_at", { ascending: false })
          .limit(30),
      ]);

      if (walletResult.error) throw walletResult.error;
      if (transactionsResult.error) throw transactionsResult.error;

      return {
        wallet: walletResult.data ?? { balance: 0, lifetime_earned: 0, lifetime_spent: 0 },
        transactions: (transactionsResult.data ?? []) as OperatorCreditTransaction[],
      };
    },
  });

  const adjust = async () => {
    const parsedAmount = Number(amount);
    if (!Number.isInteger(parsedAmount) || parsedAmount === 0) {
      toast.error("יש להזין כמות שלמה ושונה מאפס");
      return;
    }
    if (reason.trim().length < 3) {
      toast.error("חובה להזין סיבה לפעולה");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.rpc("adjust_operator_credits", {
        _operator_id: operator.id,
        _amount: parsedAmount,
        _reason: reason.trim(),
      });
      if (error) {
        if (error.message.includes("insufficient_credits_for_adjustment")) {
          toast.error("לא ניתן להפחית קרדיטים מתחת לאפס");
        } else {
          toast.error("עדכון קרדיטי העובד נכשל: " + error.message);
        }
        return;
      }

      toast.success(parsedAmount > 0 ? "קרדיטים נוספו לעובד" : "קרדיטים הופחתו מהעובד");
      setAmount("");
      setReason("");
      onChanged();
      qc.invalidateQueries({ queryKey: ["admin-operator-credits", operator.id] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>ניהול קרדיטים - {operator.full_name}</DialogTitle>
          <DialogDescription>
            התאמות נרשמות בארנק העובד, ב־ledger וביומן הביקורת.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-72" />}
        {!isLoading && error && (
          <p className="text-sm text-destructive text-center py-8">טעינת קרדיטי העובד נכשלה.</p>
        )}
        {!isLoading && data && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <CreditStat label="קרדיטים זמינים" value={data.wallet.balance} />
              <CreditStat label="סך הכל נצברו" value={data.wallet.lifetime_earned} />
              <CreditStat label="סך הכל הופחתו" value={data.wallet.lifetime_spent} />
            </div>

            <div className="grid gap-3 rounded-md border p-4">
              <div>
                <Label htmlFor="operator-credit-amount">כמות לשינוי</Label>
                <Input
                  id="operator-credit-amount"
                  type="number"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="לדוגמה 10 או -5"
                  dir="ltr"
                />
              </div>
              <div>
                <Label htmlFor="operator-credit-reason">סיבה לפעולה</Label>
                <Input
                  id="operator-credit-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="חובה לתיעוד ביומן הביקורת"
                />
              </div>
              <Button onClick={adjust} disabled={busy}>
                <Coins className="h-4 w-4 ml-1" />
                {busy ? "מעדכן..." : "עדכן קרדיטים"}
              </Button>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">פעולות קרדיטים אחרונות</h3>
              {data.transactions.length === 0 && (
                <p className="text-sm text-muted-foreground py-4">אין פעולות קרדיטים להצגה.</p>
              )}
              {data.transactions.length > 0 && (
                <div className="space-y-2">
                  {data.transactions.map((transaction) => (
                    <div key={transaction.id} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className={transaction.amount >= 0 ? "font-semibold text-success" : "font-semibold text-destructive"}>
                          {transaction.amount > 0 ? "+" : ""}{transaction.amount}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(transaction.created_at).toLocaleString("he-IL")}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {transaction.type} · יתרה אחרי: {transaction.balance_after}
                        {transaction.message_id && <> · הודעה: {transaction.message_id.slice(0, 8)}</>}
                      </div>
                      {transaction.reason && <p className="mt-1">{transaction.reason}</p>}
                      {getTransactionSource(transaction.metadata) && (
                        <p className="mt-1 text-xs text-muted-foreground">מקור: {getTransactionSource(transaction.metadata)}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreditStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value.toLocaleString("he-IL")}</div>
    </div>
  );
}

function getTransactionSource(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const source = (metadata as { source?: unknown }).source;
  return typeof source === "string" ? source : null;
}

function OperatorPerformanceDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-operator-performance", operator.id],
    queryFn: () => fetchOperatorPerformance(operator.id),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>ביצועי עובד - {operator.full_name}</DialogTitle>
          <DialogDescription>
            אותם נתוני ביצועים שהעובד רואה בדף האנליטיקה האישי שלו.
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-96" />}
        {!isLoading && error && (
          <p className="text-sm text-destructive text-center py-8">טעינת ביצועי העובד נכשלה.</p>
        )}
        {!isLoading && data && <AnalyticsContent data={data} />}
      </DialogContent>
    </Dialog>
  );
}

function OperatorActiveToggle({ operator, onDone }: { operator: Operator; onDone: () => void }) {
  const update = useServerFn(adminUpdateOperator);
  const [busy, setBusy] = useState(false);
  const isProtectedAdmin = operator.role === "admin";

  const toggle = async (checked: boolean) => {
    if (isProtectedAdmin && !checked) {
      toast.error("לא ניתן להשבית חשבון מנהל");
      return;
    }

    setBusy(true);
    try {
      await update({
        data: {
          operator_id: operator.id,
          full_name: operator.full_name,
          is_active: checked,
          availability_status: checked ? "available" : "offline",
        },
      });
      toast.success(checked ? "העובד הופעל" : "העובד הושבת");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      className="inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
      title={isProtectedAdmin ? "לא ניתן להשבית מנהל" : undefined}
    >
      <span className="min-w-12 whitespace-nowrap text-center">{operator.is_active ? "פעיל" : "לא פעיל"}</span>
      <Switch checked={operator.is_active} onCheckedChange={toggle} disabled={busy || isProtectedAdmin} />
    </label>
  );
}

function useCharactersQuery(queryKey: string) {
  return useQuery({
    queryKey: [queryKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("id, name, avatar_url, is_active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as CharacterRow[];
    },
  });
}

function CharacterChecklist({
  chars,
  selected,
  onToggle,
  activeOnly = false,
}: {
  chars: CharacterRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  activeOnly?: boolean;
}) {
  const visible = activeOnly ? chars.filter((char) => char.is_active !== false) : chars;

  return (
    <div className="border rounded-md max-h-56 overflow-y-auto p-2 space-y-1">
      {visible.map((char) => (
        <label key={char.id} className="flex items-center gap-3 p-2 rounded hover:bg-accent cursor-pointer">
          <Checkbox checked={selected.has(char.id)} onCheckedChange={() => onToggle(char.id)} />
          <div className="h-8 w-8 rounded-full bg-muted overflow-hidden">
            {char.avatar_url ? (
              <img src={char.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-xs">{char.name[0]}</div>
            )}
          </div>
          <span className="text-sm">{char.name}</span>
          {char.is_active === false && <span className="text-xs text-muted-foreground mr-auto">לא פעילה</span>}
        </label>
      ))}
      {visible.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-3">אין דמויות זמינות</div>
      )}
    </div>
  );
}

function CreateOperatorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const create = useServerFn(adminCreateOperatorUser);
  const { data: chars, isLoading } = useCharactersQuery("admin-create-operator-chars");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(selectedChars);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedChars(next);
  };

  const submit = async () => {
    if (!email.trim() || !password || !fullName.trim()) return toast.error("נא למלא שם, אימייל וסיסמה זמנית");
    if (password.length < 8) return toast.error("הסיסמה חייבת להיות לפחות 8 תווים");
    setBusy(true);
    try {
      await create({
        data: {
          email: email.trim(),
          password,
          full_name: fullName.trim(),
          is_active: isActive,
          character_ids: Array.from(selectedChars),
        },
      });
      toast.success("עובד חדש נוצר בצורה מאובטחת");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl" className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>יצירת עובד חדש</DialogTitle>
          <DialogDescription>
            יצירת משתמש Auth ועובד מתבצעת דרך server function עם בדיקת מנהל. הסיסמה זמנית וניתן לשלוח איפוס לאחר מכן.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input type="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div>
            <Label>סיסמה זמנית</Label>
            <Input type="password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <Label>חשבון פעיל</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <div>
            <Label>שיוך לדמויות</Label>
            {isLoading ? (
              <Skeleton className="h-32 mt-2" />
            ) : (
              <CharacterChecklist chars={chars ?? []} selected={selectedChars} onToggle={toggle} activeOnly />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "יוצר..." : "צור עובד"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromoteClientDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const promote = useServerFn(adminPromoteClientToOperator);
  const { data: chars, isLoading } = useCharactersQuery("admin-promote-client-chars");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(selectedChars);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedChars(next);
  };

  const submit = async () => {
    if (!email.trim() || !fullName.trim()) return toast.error("נא למלא שם ואימייל");
    setBusy(true);
    try {
      await promote({
        data: {
          email: email.trim(),
          full_name: fullName.trim(),
          is_active: isActive,
          character_ids: Array.from(selectedChars),
        },
      });
      toast.success("הלקוח הועבר לתפקיד עובד");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl" className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>הפיכת לקוח לעובד</DialogTitle>
          <DialogDescription>
            הפעולה תעדכן תפקיד בצורה עקבית ותיצור או תפעיל רשומת עובד, בלי למחוק היסטוריה קיימת.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>אימייל של לקוח קיים</Label>
            <Input type="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div>
            <Label>שם עובד</Label>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <Label>חשבון עובד פעיל</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <div>
            <Label>שיוך לדמויות</Label>
            {isLoading ? (
              <Skeleton className="h-32 mt-2" />
            ) : (
              <CharacterChecklist chars={chars ?? []} selected={selectedChars} onToggle={toggle} activeOnly />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "שומר..." : "הפוך לעובד"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateInviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string, email: string) => void;
}) {
  const create = useServerFn(adminCreateInvite);
  const { data: chars, isLoading } = useCharactersQuery("admin-operator-invite-chars");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(selectedChars);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedChars(next);
  };

  const submit = async () => {
    if (!email.trim() || !fullName.trim()) return toast.error("נא למלא שם ואימייל");
    setBusy(true);
    try {
      const result = await create({
        data: { email: email.trim(), full_name: fullName.trim(), character_ids: Array.from(selectedChars) },
      });
      toast.success("הזמנה נוצרה");
      onCreated(result.token, email.trim());
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl" className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>הזמנת עובד במייל</DialogTitle>
          <DialogDescription>תיווצר הזמנה לעובד עם קישור אישי לקביעת סיסמה.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div>
            <Label>שיוך לדמויות</Label>
            {isLoading ? (
              <Skeleton className="h-32 mt-2" />
            ) : (
              <CharacterChecklist chars={chars ?? []} selected={selectedChars} onToggle={toggle} activeOnly />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "יוצר..." : "צור הזמנה"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteLinkDialog({ token, email, onClose }: { token: string; email: string; onClose: () => void }) {
  const url = `${window.location.origin}/accept-invite/${token}`;
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    toast.success("קישור ההזמנה הועתק");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>הזמנה נוצרה</DialogTitle>
          <DialogDescription>
            שלח את הקישור הבא אל <strong dir="ltr">{email}</strong>. שליחת מייל אוטומטית תלויה בהגדרות SMTP.
          </DialogDescription>
        </DialogHeader>
        <div className="p-3 bg-muted rounded-md break-all text-xs font-mono" dir="ltr">{url}</div>
        <DialogFooter>
          <Button onClick={copy}><Copy className="h-4 w-4 ml-1" /> העתק קישור</Button>
          <Button variant="outline" onClick={onClose}>סגור</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOperatorDialog({
  operator,
  onClose,
  onDone,
}: {
  operator: Operator;
  onClose: () => void;
  onDone: () => void;
}) {
  const update = useServerFn(adminUpdateOperator);
  const [fullName, setFullName] = useState(operator.full_name);
  const [isActive, setIsActive] = useState(operator.is_active);
  const [status, setStatus] = useState(operator.availability_status);
  const [busy, setBusy] = useState(false);
  const isProtectedAdmin = operator.role === "admin";

  const submit = async () => {
    setBusy(true);
    try {
      const nextIsActive = isProtectedAdmin ? true : isActive;
      await update({
        data: {
          operator_id: operator.id,
          full_name: fullName.trim(),
          is_active: nextIsActive,
          availability_status: nextIsActive ? status : "offline",
        },
      });
      toast.success("העובד עודכן");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>עריכת עובד</DialogTitle>
          <DialogDescription>אימייל מנוהל דרך Supabase Auth ולכן מוצג לקריאה בלבד בשלב הזה.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם מלא</Label>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input value={operator.email ?? ""} readOnly dir="ltr" className="bg-muted" />
          </div>
          <div>
            <Label>סטטוס זמינות</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as Operator["availability_status"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="available">זמין</SelectItem>
                <SelectItem value="busy">עסוק</SelectItem>
                <SelectItem value="offline">לא מחובר</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label>חשבון עובד פעיל</Label>
            <Switch checked={isProtectedAdmin ? true : isActive} onCheckedChange={setIsActive} disabled={isProtectedAdmin} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "שומר..." : "שמור"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignCharactersDialog({
  operator,
  onClose,
  onDone,
}: {
  operator: Operator;
  onClose: () => void;
  onDone: () => void;
}) {
  const update = useServerFn(adminUpdateOperator);
  const { data, isLoading } = useQuery({
    queryKey: ["admin-op-chars", operator.id],
    queryFn: async () => {
      const [{ data: chars, error: charsError }, { data: assigns, error: assignsError }] = await Promise.all([
        supabase.from("characters").select("id, name, avatar_url, is_active").order("name"),
        supabase.from("character_operator_assignments").select("character_id").eq("operator_id", operator.id),
      ]);
      if (charsError) throw charsError;
      if (assignsError) throw assignsError;
      return {
        chars: (chars ?? []) as CharacterRow[],
        assigned: new Set((assigns ?? []).map((assignment) => assignment.character_id)),
      };
    },
  });

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const current = selected ?? data?.assigned ?? new Set<string>();
  const toggle = (id: string) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const save = async () => {
    if (!data) return;
    try {
      await update({
        data: {
          operator_id: operator.id,
          full_name: operator.full_name,
          is_active: operator.is_active,
          availability_status: operator.availability_status,
          character_ids: Array.from(current),
        },
      });
      toast.success("שיוכי הדמויות נשמרו");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>שיוך דמויות - {operator.full_name}</DialogTitle>
          <DialogDescription>השיוך הזה הוא מקור האמת ל-Shared Inbox.</DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-40" />}
        {!isLoading && data && <CharacterChecklist chars={data.chars} selected={current} onToggle={toggle} />}
        <DialogFooter>
          <Button onClick={save}>שמור</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const send = useServerFn(adminSendPasswordReset);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await send({ data: { user_id: operator.user_id } });
      if (result.action_link) {
        await navigator.clipboard.writeText(result.action_link).catch(() => {});
        toast.success("קישור איפוס הועתק ללוח");
      } else {
        toast.success("נשלח אימייל איפוס סיסמה");
      }
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>איפוס סיסמה</DialogTitle>
          <DialogDescription>
            ייווצר קישור איפוס עבור {operator.email ?? operator.full_name}. אם Supabase מחזיר קישור פעולה, הוא יועתק ללוח.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "שולח..." : "שלח איפוס"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveOperatorConfirm({
  operator,
  onClose,
  onDone,
}: {
  operator: Operator;
  onClose: () => void;
  onDone: () => void;
}) {
  const archive = useServerFn(adminArchiveOperator);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await archive({
        data: { operator_id: operator.id },
      });
      toast.success("העובד הושבת");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>השבתת עובד</AlertDialogTitle>
          <AlertDialogDescription>
            העובד {operator.full_name} יישאר בהיסטוריה, בהודעות, בניקוד ובהערות, אבל לא יוכל לפעול כעובד פעיל.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {busy ? "משבית..." : "השבת עובד"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RestoreOperatorConfirm({
  operator,
  onClose,
  onDone,
}: {
  operator: Operator;
  onClose: () => void;
  onDone: () => void;
}) {
  const restore = useServerFn(adminRestoreOperator);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await restore({
        data: { operator_id: operator.id },
      });
      toast.success("העובד שוחזר כלא פעיל");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>שחזור עובד</AlertDialogTitle>
          <AlertDialogDescription>
            העובד {operator.full_name} יחזור לרשימת העובדים הרגילה, אך יישאר לא פעיל עד שתפעיל אותו ידנית.
            כל ההיסטוריה, ההודעות, הניקוד וההערות נשמרים ללא שינוי.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy}>
            {busy ? "משחזר..." : "שחזר עובד"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConvertOperatorConfirm({
  operator,
  onClose,
  onDone,
}: {
  operator: Operator;
  onClose: () => void;
  onDone: () => void;
}) {
  const convert = useServerFn(adminConvertOperatorToClient);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await convert({ data: { operator_id: operator.id } });
      toast.success("העובד הועבר לתפקיד לקוח");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>הפיכת עובד ללקוח</AlertDialogTitle>
          <AlertDialogDescription>
            הפעולה תסיר את תפקיד העובד, תוודא שיש פרופיל לקוח, ותשאיר את כל ההיסטוריה ללא מחיקה פיזית.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy}>
            {busy ? "שומר..." : "הפוך ללקוח"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
