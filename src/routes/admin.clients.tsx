import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Archive,
  Coins,
  Edit,
  Eye,
  Flag,
  KeyRound,
  MessageCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  User,
  UserRoundPlus,
} from "lucide-react";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import {
  adminAdjustClientCredits,
  adminArchiveClient,
  adminGetClientDetails,
  adminListClients,
  adminRestoreClient,
  adminSetClientStatus,
  adminUpdateClient,
} from "@/lib/admin-clients.functions";
import { adminPromoteClientToOperator } from "@/lib/admin-operators.functions";
import { adminSendPasswordReset } from "@/lib/impersonation.functions";

export const Route = createFileRoute("/admin/clients")({
  component: ClientsPage,
});

type ClientRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
  deleted_at: string | null;
  credits_balance: number;
  conversations_count: number;
  active_conversations_count: number;
  last_message_at: string | null;
};

type ClientDetails = {
  profile: ClientRow | null;
  client_profile: {
    age: number | null;
    gender: string | null;
    interests: string[] | null;
    conversation_preferences: string | null;
  } | null;
  wallet: {
    balance: number;
    lifetime_earned: number;
    lifetime_spent: number;
    updated_at: string | null;
  };
  conversations: Array<{
    id: string;
    status: string;
    last_message_at: string | null;
    last_message_preview: string | null;
    created_at: string;
    characters?: { id: string; name: string; avatar_url: string | null } | null;
  }>;
  transactions: Array<{
    id: string;
    amount: number;
    balance_after: number;
    type: string;
    reason: string | null;
    created_at: string;
  }>;
  timeline: Array<{
    id: string;
    type: "signup" | "chat" | "credit" | "admin" | "report" | "analytics";
    title: string;
    description: string | null;
    created_at: string;
    conversation_id?: string | null;
  }>;
  activity: {
    conversations_count: number;
    client_messages_count: number;
  };
};

function ClientsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const listClients = useServerFn(adminListClients);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive" | "today">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<ClientRow | null>(null);
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [creditsClient, setCreditsClient] = useState<ClientRow | null>(null);
  const [archiveClient, setArchiveClient] = useState<ClientRow | null>(null);
  const [restoreClient, setRestoreClient] = useState<ClientRow | null>(null);
  const [resetClient, setResetClient] = useState<ClientRow | null>(null);
  const [promoteClient, setPromoteClient] = useState<ClientRow | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin-clients", showArchived],
    queryFn: async () => (await listClients({ data: { include_archived: showArchived } })) as ClientRow[],
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-clients"] });
    qc.invalidateQueries({ queryKey: ["admin-client-details"] });
    qc.invalidateQueries({ queryKey: ["admin-client-credit-rows"] });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((client) => {
      if (q && !(client.email?.toLowerCase().includes(q) || client.display_name?.toLowerCase().includes(q))) {
        return false;
      }
      if (filter === "active" && client.status !== "active") return false;
      if (filter === "inactive" && client.status !== "blocked") return false;
      if (filter === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(client.created_at) < today) return false;
      }
      return true;
    });
  }, [data, filter, search]);

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader
        title="לקוחות"
        description="ניהול לקוחות, סטטוס, קרדיטים ושיחות ממקום אחד"
      />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="חיפוש לפי שם או אימייל"
              className="pr-10"
            />
          </div>
          <Select value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
            <SelectTrigger className="w-full lg:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הלקוחות</SelectItem>
              <SelectItem value="active">פעילים</SelectItem>
              <SelectItem value="inactive">לא פעילים</SelectItem>
              <SelectItem value="today">חדשים היום</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <span>הצג לקוחות שנמחקו</span>
            <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-6 space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          )}
          {isError && (
            <div className="p-6 text-center">
              <p className="text-destructive mb-3">{(error as Error)?.message ?? "טעינת לקוחות נכשלה"}</p>
              <Button variant="outline" onClick={() => refetch()}>נסה שוב</Button>
            </div>
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-12">לא נמצאו לקוחות</p>
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="divide-y">
              {filtered.map((client) => (
                <div key={client.user_id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="h-10 w-10 rounded-full bg-muted overflow-hidden flex items-center justify-center shrink-0">
                    {client.avatar_url ? (
                      <img src={client.avatar_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <User className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-[220px]">
                    <div className="font-medium truncate">{client.display_name ?? "ללא שם"}</div>
                    <div className="text-xs text-muted-foreground truncate" dir="ltr">
                      {client.email ?? "-"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {client.deleted_at && <StatusBadge status="archived" />}
                    {!client.deleted_at && <ClientActiveToggle client={client} onDone={refresh} />}
                  </div>
                  <div className="hidden xl:grid grid-cols-4 gap-4 text-xs text-muted-foreground min-w-[420px]">
                    <span>{client.credits_balance.toLocaleString("he-IL")} קרדיטים</span>
                    <span>{client.conversations_count} שיחות</span>
                    <span>{client.active_conversations_count} פעילות</span>
                    <span>{client.last_message_at ? new Date(client.last_message_at).toLocaleDateString("he-IL") : "אין פעילות"}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setSelected(client)} title="פרטי לקוח">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(client)} title="עריכת לקוח" disabled={Boolean(client.deleted_at)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCreditsClient(client)} title="ניהול קרדיטים" disabled={Boolean(client.deleted_at)}>
                      <Coins className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setResetClient(client)} title="שליחת איפוס סיסמה" disabled={Boolean(client.deleted_at)}>
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setArchiveClient(client)} title="ארכוב לקוח" disabled={Boolean(client.deleted_at)}>
                      <Archive className="h-4 w-4 text-destructive" />
                    </Button>
                    {client.deleted_at && (
                      <Button size="sm" variant="ghost" onClick={() => setRestoreClient(client)} title="שחזור לקוח">
                        <RotateCcw className="h-4 w-4 text-primary" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <ClientDetailsDialog
          client={selected}
          onClose={() => setSelected(null)}
          onEdit={(client) => setEditing(client)}
          onCredits={(client) => {
            setSelected(null);
            navigate({ to: "/admin/credits", search: { clientId: client.user_id } });
          }}
          onReset={(client) => setResetClient(client)}
          onArchive={(client) => setArchiveClient(client)}
          onPromote={(client) => setPromoteClient(client)}
          onDone={refresh}
        />
      )}
      {editing && (
        <EditClientDialog
          client={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {creditsClient && (
        <CreditsDialog
          client={creditsClient}
          onClose={() => setCreditsClient(null)}
          onDone={() => {
            setCreditsClient(null);
            refresh();
          }}
        />
      )}
      {resetClient && <ResetPasswordDialog client={resetClient} onClose={() => setResetClient(null)} />}
      {archiveClient && (
        <ArchiveClientConfirm
          client={archiveClient}
          onClose={() => setArchiveClient(null)}
          onDone={() => {
            setArchiveClient(null);
            refresh();
          }}
        />
      )}
      {restoreClient && (
        <RestoreClientConfirm
          client={restoreClient}
          onClose={() => setRestoreClient(null)}
          onDone={() => {
            setRestoreClient(null);
            refresh();
          }}
        />
      )}
      {promoteClient && (
        <PromoteClientConfirm
          client={promoteClient}
          onClose={() => setPromoteClient(null)}
          onDone={() => {
            setPromoteClient(null);
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ClientActiveToggle({ client, onDone }: { client: ClientRow; onDone: () => void }) {
  const setStatus = useServerFn(adminSetClientStatus);
  const [busy, setBusy] = useState(false);
  const active = client.status === "active";

  const toggle = async (checked: boolean) => {
    setBusy(true);
    try {
      await setStatus({ data: { user_id: client.user_id, is_active: checked } });
      toast.success(checked ? "הלקוח הופעל" : "הלקוח הושבת");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
      <span>{active ? "פעיל" : "לא פעיל"}</span>
      <Switch checked={active} onCheckedChange={toggle} disabled={busy} />
    </label>
  );
}

function ClientDetailsDialog({
  client,
  onClose,
  onEdit,
  onCredits,
  onReset,
  onArchive,
  onPromote,
  onDone,
}: {
  client: ClientRow;
  onClose: () => void;
  onEdit: (client: ClientRow) => void;
  onCredits: (client: ClientRow) => void;
  onReset: (client: ClientRow) => void;
  onArchive: (client: ClientRow) => void;
  onPromote: (client: ClientRow) => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const getDetails = useServerFn(adminGetClientDetails);
  const setStatus = useServerFn(adminSetClientStatus);
  const [statusAction, setStatusAction] = useState<"block" | "activate" | null>(null);
  const [busyStatus, setBusyStatus] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-client-details", client.user_id],
    queryFn: async () => (await getDetails({ data: { user_id: client.user_id } })) as ClientDetails,
  });
  const detailClient = data?.profile ?? client;
  const isArchived = Boolean(detailClient.deleted_at);
  const isBlocked = detailClient.status === "blocked";

  const submitStatusAction = async () => {
    if (!statusAction) return;
    setBusyStatus(true);
    try {
      await setStatus({
        data: {
          user_id: client.user_id,
          is_active: statusAction === "activate",
        },
      });
      toast.success(statusAction === "activate" ? "הלקוח הוחזר לפעילות" : "הלקוח נחסם");
      setStatusAction(null);
      qc.invalidateQueries({ queryKey: ["admin-client-details", client.user_id] });
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyStatus(false);
    }
  };

  return (
    <>
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{client.display_name ?? client.email ?? "לקוח"}</DialogTitle>
          <DialogDescription>פרטי פעילות, קרדיטים ושיחות אחרונות.</DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-80" />}
        {isError && <p className="text-center text-destructive py-8">{(error as Error)?.message ?? "טעינת פרטי לקוח נכשלה"}</p>}
        {!isLoading && data && (
          <div className="space-y-5">
            <section className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-3 text-sm font-medium">פעולות מהירות</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <Button variant="outline" onClick={() => onEdit(detailClient)} disabled={isArchived}>
                  <Edit className="h-4 w-4 ml-1" /> עריכת לקוח
                </Button>
                <Button variant="outline" onClick={() => onReset(detailClient)} disabled={isArchived}>
                  <KeyRound className="h-4 w-4 ml-1" /> שלח איפוס סיסמה
                </Button>
                <Button variant="outline" onClick={() => onCredits(detailClient)} disabled={isArchived}>
                  <Coins className="h-4 w-4 ml-1" /> ניהול קרדיטים
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setStatusAction(isBlocked ? "activate" : "block")}
                  disabled={isArchived}
                >
                  {isBlocked ? "החזר לפעילות" : "חסום לקוח"}
                </Button>
                <Button variant="outline" onClick={() => onPromote(detailClient)} disabled={isArchived}>
                  <UserRoundPlus className="h-4 w-4 ml-1" /> הפוך לעובד
                </Button>
                <Button variant="destructive" onClick={() => onArchive(detailClient)} disabled={isArchived}>
                  <Archive className="h-4 w-4 ml-1" /> מחיקת לקוח
                </Button>
              </div>
            </section>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Info label="אימייל" value={data.profile?.email ?? "-"} dir="ltr" />
              <Info label="סטטוס" value={<StatusBadge status={data.profile?.deleted_at ? "archived" : data.profile?.status === "blocked" ? "inactive" : data.profile?.status ?? "active"} />} />
              <Info label="יתרת קרדיטים" value={data.wallet.balance.toLocaleString("he-IL")} />
              <Info label="תאריך הרשמה" value={data.profile?.created_at ? new Date(data.profile.created_at).toLocaleDateString("he-IL") : "-"} />
              <Info label="גיל" value={data.client_profile?.age ?? "-"} />
              <Info label="מגדר" value={data.client_profile?.gender ?? "-"} />
              <Info label="שיחות" value={data.activity.conversations_count} />
              <Info label="הודעות לקוח" value={data.activity.client_messages_count} />
            </div>

            <ActivityTimeline events={data.timeline ?? []} />

            {data.client_profile?.interests && data.client_profile.interests.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">תחומי עניין</div>
                <div className="flex flex-wrap gap-1.5">
                  {data.client_profile.interests.map((interest) => (
                    <span key={interest} className="text-xs px-2 py-1 rounded-full bg-muted">
                      {interest}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {data.client_profile?.conversation_preferences && (
              <Info label="העדפות שיחה" value={data.client_profile.conversation_preferences} />
            )}

            <section>
              <div className="text-sm font-medium mb-2">שיחות אחרונות</div>
              {data.conversations.length === 0 && <p className="text-xs text-muted-foreground">אין שיחות</p>}
              <div className="space-y-1.5">
                {data.conversations.map((conversation) => (
                  <Link
                    key={conversation.id}
                    to="/admin/conversations/$conversationId"
                    params={{ conversationId: conversation.id }}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm hover:bg-accent"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <MessageCircle className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{conversation.characters?.name ?? "דמות"}</span>
                      <span className="truncate text-muted-foreground">{conversation.last_message_preview ?? ""}</span>
                    </div>
                    <StatusBadge status={conversation.status} />
                  </Link>
                ))}
              </div>
            </section>

            <section>
              <div className="text-sm font-medium mb-2">פעולות קרדיטים אחרונות</div>
              {data.transactions.length === 0 && <p className="text-xs text-muted-foreground">אין פעולות קרדיטים</p>}
              <div className="space-y-1.5">
                {data.transactions.map((transaction) => (
                  <div key={transaction.id} className="grid grid-cols-4 gap-2 rounded-md border p-2 text-xs">
                    <span className={transaction.amount >= 0 ? "text-success" : "text-destructive"}>
                      {transaction.amount > 0 ? "+" : ""}{transaction.amount}
                    </span>
                    <span>יתרה: {transaction.balance_after}</span>
                    <span className="truncate">{transaction.reason ?? transaction.type}</span>
                    <span className="text-muted-foreground">{new Date(transaction.created_at).toLocaleDateString("he-IL")}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>סגור</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(statusAction)} onOpenChange={(open) => !open && setStatusAction(null)}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>{statusAction === "activate" ? "החזרת לקוח לפעילות" : "חסימת לקוח"}</AlertDialogTitle>
          <AlertDialogDescription>
            {statusAction === "activate"
              ? "הלקוח יוכל להתחבר, לפתוח שיחות ולשלוח הודעות שוב."
              : "הלקוח לא יוכל להתחבר, לפתוח שיחות או לשלוח הודעות. ההיסטוריה שלו תישמר ללא שינוי."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction
            onClick={submitStatusAction}
            disabled={busyStatus}
            className={statusAction === "block" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
          >
            {busyStatus ? "שומר..." : statusAction === "activate" ? "החזר לפעילות" : "חסום לקוח"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function EditClientDialog({ client, onClose, onDone }: { client: ClientRow; onClose: () => void; onDone: () => void }) {
  const update = useServerFn(adminUpdateClient);
  const getDetails = useServerFn(adminGetClientDetails);
  const { data } = useQuery({
    queryKey: ["admin-client-details", client.user_id, "edit"],
    queryFn: async () => (await getDetails({ data: { user_id: client.user_id } })) as ClientDetails,
  });
  const [displayName, setDisplayName] = useState(client.display_name ?? "");
  const [isActive, setIsActive] = useState(client.status === "active");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [interests, setInterests] = useState("");
  const [preferences, setPreferences] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data?.client_profile) return;
    setAge(data.client_profile.age ? String(data.client_profile.age) : "");
    setGender(data.client_profile.gender ?? "");
    setInterests((data.client_profile.interests ?? []).join(", "));
    setPreferences(data.client_profile.conversation_preferences ?? "");
  }, [data]);

  const submit = async () => {
    setBusy(true);
    try {
      await update({
        data: {
          user_id: client.user_id,
          display_name: displayName.trim(),
          status: isActive ? "active" : "blocked",
          age: age ? Number(age) : null,
          gender: gender.trim() || null,
          interests: interests
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          conversation_preferences: preferences.trim() || null,
        },
      });
      toast.success("הלקוח עודכן");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>עריכת לקוח</DialogTitle>
          <DialogDescription>האימייל נשאר לקריאה בלבד; איפוס סיסמה מתבצע כקישור מאובטח.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>שם תצוגה</Label>
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <div>
            <Label>אימייל</Label>
            <Input value={client.email ?? ""} readOnly dir="ltr" className="bg-muted" />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <Label>לקוח פעיל</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>גיל</Label>
              <Input type="number" min={18} max={120} value={age} onChange={(event) => setAge(event.target.value)} />
            </div>
            <div>
              <Label>מגדר</Label>
              <Input value={gender} onChange={(event) => setGender(event.target.value)} />
            </div>
          </div>
          <div>
            <Label>תחומי עניין</Label>
            <Input value={interests} onChange={(event) => setInterests(event.target.value)} placeholder="מופרד בפסיקים" />
          </div>
          <div>
            <Label>העדפות שיחה</Label>
            <Textarea value={preferences} onChange={(event) => setPreferences(event.target.value)} rows={4} />
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

function CreditsDialog({ client, onClose, onDone }: { client: ClientRow; onClose: () => void; onDone: () => void }) {
  const adjust = useServerFn(adminAdjustClientCredits);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return toast.error("נא להזין כמות קרדיטים תקינה");
    if (reason.trim().length < 3) return toast.error("Reason חובה לפעולת קרדיטים");
    setBusy(true);
    try {
      await adjust({
        data: {
          user_id: client.user_id,
          amount: mode === "add" ? numericAmount : -numericAmount,
          reason: reason.trim(),
        },
      });
      toast.success("יתרת הקרדיטים עודכנה");
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
          <DialogTitle>ניהול קרדיטים</DialogTitle>
          <DialogDescription>
            יתרה נוכחית: {client.credits_balance.toLocaleString("he-IL")} קרדיטים
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>פעולה</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "add" | "remove")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="add">הוספת קרדיטים</SelectItem>
                <SelectItem value="remove">הורדת קרדיטים</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>כמות</Label>
            <Input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
          <div>
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "שומר..." : "בצע פעולה"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ client, onClose }: { client: ClientRow; onClose: () => void }) {
  const send = useServerFn(adminSendPasswordReset);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await send({ data: { user_id: client.user_id } });
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
          <DialogDescription>{client.email}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "שולח..." : "שלח איפוס"}</Button>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveClientConfirm({ client, onClose, onDone }: { client: ClientRow; onClose: () => void; onDone: () => void }) {
  const archive = useServerFn(adminArchiveClient);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await archive({ data: { user_id: client.user_id } });
      toast.success("הלקוח אורכב");
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
          <AlertDialogTitle>ארכוב לקוח</AlertDialogTitle>
          <AlertDialogDescription>
            הלקוח יוסר מרשימת ברירת המחדל ולא יוכל להתחבר או לפעול, אבל השיחות, ההודעות,
            הקרדיטים, הדיווחים וההיסטוריה יישמרו.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {busy ? "מאורכב..." : "ארכב לקוח"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RestoreClientConfirm({ client, onClose, onDone }: { client: ClientRow; onClose: () => void; onDone: () => void }) {
  const restore = useServerFn(adminRestoreClient);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await restore({ data: { user_id: client.user_id } });
      toast.success("הלקוח שוחזר לרשימה הרגילה כלא פעיל");
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
          <AlertDialogTitle>שחזור לקוח</AlertDialogTitle>
          <AlertDialogDescription>
            הלקוח יחזור לרשימת הלקוחות הרגילה במצב לא פעיל. ההיסטוריה, השיחות, ההודעות, הקרדיטים והדוחות יישמרו ללא שינוי.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy}>
            {busy ? "משחזר..." : "שחזר לקוח"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PromoteClientConfirm({ client, onClose, onDone }: { client: ClientRow; onClose: () => void; onDone: () => void }) {
  const promote = useServerFn(adminPromoteClientToOperator);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!client.email) {
      toast.error("לא ניתן להפוך לקוח בלי אימייל לעובד");
      return;
    }

    setBusy(true);
    try {
      await promote({
        data: {
          email: client.email,
          full_name: client.display_name?.trim() || client.email,
          is_active: true,
          character_ids: [],
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
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>הפיכת לקוח לעובד</AlertDialogTitle>
          <AlertDialogDescription>
            הפעולה תסיר את הלקוח מרשימת הלקוחות הרגילה, תיצור או תפעיל רשומת עובד, ותעדכן את התפקיד בצורה עקבית.
            ההיסטוריה, השיחות, הקרדיטים והדיווחים יישמרו ללא מחיקה.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ביטול</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy}>
            {busy ? "מעביר..." : "הפוך לעובד"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ActivityTimeline({ events }: { events: ClientDetails["timeline"] }) {
  const iconMap = {
    signup: UserRoundPlus,
    chat: MessageCircle,
    credit: Coins,
    admin: ShieldCheck,
    report: Flag,
    analytics: Activity,
  };

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Timeline / Activity Feed</div>
          <p className="text-xs text-muted-foreground">פעילות מרכזית של הלקוח לפי תאריך יורד</p>
        </div>
        <Activity className="h-4 w-4 text-muted-foreground" />
      </div>

      {events.length === 0 ? (
        <div className="rounded-md bg-muted/40 p-4 text-sm text-muted-foreground">
          אין עדיין פעילות להצגה עבור הלקוח הזה.
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const Icon = iconMap[event.type] ?? Activity;
            return (
              <div key={event.id} className="relative flex gap-3 rounded-md border bg-card p-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="font-medium text-sm">{event.title}</div>
                    <time className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(event.created_at).toLocaleString("he-IL")}
                    </time>
                  </div>
                  {event.description && (
                    <p className="mt-1 text-xs text-muted-foreground break-words">{event.description}</p>
                  )}
                  {event.conversation_id && (
                    <Button asChild variant="link" size="sm" className="mt-1 h-auto p-0 text-xs">
                      <Link to="/admin/conversations/$conversationId" params={{ conversationId: event.conversation_id }}>
                        פתח שיחה קשורה
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Info({ label, value, dir }: { label: string; value: React.ReactNode; dir?: "rtl" | "ltr" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium break-words" dir={dir}>
        {value}
      </div>
    </div>
  );
}
