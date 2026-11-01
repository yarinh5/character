import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { PageHeader, StatusBadge } from "@/components/admin/AdminLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Edit, Eye, EyeOff, Images, Plus, RefreshCw } from "lucide-react";
import { AvatarUpload } from "@/components/common/AvatarUpload";
import { CharacterMediaDialog } from "@/components/admin/CharacterMediaDialog";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export const Route = createFileRoute("/admin/characters")({ component: CharactersPage });

type CharRow = {
  id: string;
  name: string;
  fictional_age: number | null;
  category: string | null;
  short_description: string | null;
  full_description: string | null;
  personality: string | null;
  interests: string[] | null;
  discovery_city_id: string | null;
  avatar_url: string | null;
  availability_status: string;
  is_active: boolean;
  is_visible: boolean;
};
type EditableKey = Exclude<keyof CharRow, "id">;
type EditingState = { character: Partial<CharRow>; instance: number };
type CreateCheck = "no-match" | "possible-match" | "error";
type UncertainCreateAttempt = Readonly<{ name: string }>;

const availabilityOptions = [
  { value: "available", label: "זמין" },
  { value: "busy", label: "עסוק" },
  { value: "offline", label: "לא מחובר" },
];
const empty: Partial<CharRow> = {
  name: "",
  fictional_age: null,
  category: null,
  short_description: null,
  full_description: null,
  personality: null,
  interests: [],
  discovery_city_id: null,
  avatar_url: null,
  availability_status: "available",
  is_active: true,
  is_visible: true,
};

async function readCharacters() {
  const { data, error } = await supabase
    .from("characters")
    .select(
      "id, name, fictional_age, category, short_description, full_description, personality, interests, discovery_city_id, avatar_url, availability_status, is_active, is_visible",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CharRow[];
}

async function readCountMap(
  table: "character_operator_assignments" | "conversations",
  ids: string[],
) {
  if (!ids.length) return new Map<string, number>();
  const { data, error } = await supabase.from(table).select("character_id").in("character_id", ids);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.character_id, (counts.get(row.character_id) ?? 0) + 1);
  }
  return counts;
}

function CharactersPage() {
  const { session, user, role, loading } = useAuth();
  const adminId =
    !loading && role === "admin" && user && session?.user.id === user.id ? user.id : null;
  return adminId ? (
    <CharacterWorkspace key={adminId} adminId={adminId} />
  ) : (
    <p role="status">נדרש חיבור מנהל מאומת.</p>
  );
}

function CharacterWorkspace({ adminId }: { adminId: string }) {
  const qc = useQueryClient();
  const alive = useRef(true);
  const locks = useRef(new Set<string>());
  const serial = useRef(0);
  const focusReturn = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [mediaCharacter, setMediaCharacter] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState("");
  const [activity, setActivity] = useState("all");
  const [visibility, setVisibility] = useState("all");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [, renderLocks] = useState(0);

  useEffect(() => {
    const workspaceLocks = locks.current;
    alive.current = true;
    return () => {
      alive.current = false;
      workspaceLocks.clear();
    };
  }, []);

  const listQuery = useQuery({ queryKey: ["admin-characters", adminId], queryFn: readCharacters });
  const characters = listQuery.data ?? [];
  const ids = characters.map((character) => character.id).sort();
  const assignmentsQuery = useQuery({
    queryKey: ["admin-character-assignment-counts", adminId, ids],
    queryFn: () => readCountMap("character_operator_assignments", ids),
    enabled: listQuery.data !== undefined && ids.length > 0,
  });
  const conversationsQuery = useQuery({
    queryKey: ["admin-character-conversation-counts", adminId, ids],
    queryFn: () => readCountMap("conversations", ids),
    enabled: listQuery.data !== undefined && ids.length > 0,
  });
  const listRefreshMessage =
    listQuery.data && listQuery.isError
      ? refreshWarning || "רענון רשימת הדמויות נכשל. הנתונים השמורים עדיין מוצגים."
      : refreshWarning;

  useEffect(() => {
    if (listQuery.data && !listQuery.isError) setRefreshWarning("");
  }, [listQuery.dataUpdatedAt, listQuery.isError, listQuery.data]);

  const normalizedSearch = search.trim().toLocaleLowerCase("he");
  const filtered = characters.filter((character) => {
    const matchesSearch =
      !normalizedSearch ||
      [character.name, character.category, character.short_description]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("he").includes(normalizedSearch));
    const matchesActivity =
      activity === "all" || (activity === "active" ? character.is_active : !character.is_active);
    const matchesVisibility =
      visibility === "all" ||
      (visibility === "visible" ? character.is_visible : !character.is_visible);
    return matchesSearch && matchesActivity && matchesVisibility;
  });
  const filtersActive = Boolean(normalizedSearch || activity !== "all" || visibility !== "all");

  const restoreFocus = () => {
    const target = focusReturn.current;
    focusReturn.current = null;
    if (target) requestAnimationFrame(() => target.focus());
  };
  const closeEditing = () => {
    setEditing(null);
    restoreFocus();
  };
  const openEditing = (character: Partial<CharRow>, trigger: HTMLElement) => {
    focusReturn.current = trigger;
    setEditing({ character, instance: ++serial.current });
  };
  const refreshList = async () => {
    const result = await listQuery.refetch();
    if (result.error) {
      if (alive.current) setRefreshWarning("רענון רשימת הדמויות נכשל");
      return false;
    }
    if (alive.current) setRefreshWarning("");
    return true;
  };
  const afterSaved = async () => {
    closeEditing();
    if (!(await refreshList()) && alive.current) {
      setRefreshWarning("הדמות נשמרה, אך רענון הרשימה נכשל");
    }
  };
  const checkCreateList = async (name: string): Promise<CreateCheck> => {
    const result = await listQuery.refetch();
    if (result.error) return "error";
    return result.data?.some(
      (character) => character.name.trim().toLocaleLowerCase("he") === name.toLocaleLowerCase("he"),
    )
      ? "possible-match"
      : "no-match";
  };
  const toggleVisibility = async (character: CharRow) => {
    const lockKey = `character:${character.id}`;
    if (locks.current.has(lockKey)) return;
    locks.current.add(lockKey);
    renderLocks((value) => value + 1);
    const next = !character.is_visible;
    try {
      const { data, error } = await supabase
        .from("characters")
        .update({ is_visible: next })
        .eq("id", character.id)
        .select("id, is_visible")
        .maybeSingle();
      if (error || data?.id !== character.id || data.is_visible !== next) {
        throw error ?? new Error("invalid_character_update");
      }
      if (!alive.current) return;
      qc.setQueryData<CharRow[]>(["admin-characters", adminId], (current) =>
        current?.map((item) => (item.id === character.id ? { ...item, is_visible: next } : item)),
      );
      toast.success(next ? "הדמות מוצגת ללקוחות" : "הדמות הוסתרה מלקוחות");
      if (!(await refreshList()) && alive.current) {
        setRefreshWarning("הנראות נשמרה, אך רענון הרשימה נכשל");
      }
    } catch {
      if (alive.current) toast.error("עדכון הנראות נכשל");
    } finally {
      locks.current.delete(lockKey);
      if (alive.current) renderLocks((value) => value + 1);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-8" dir="rtl">
      <PageHeader
        title="דמויות"
        description="ניהול הדמויות במערכת"
        actions={
          <Button onClick={(event) => openEditing({ ...empty }, event.currentTarget)}>
            <Plus className="ml-1 h-4 w-4" /> דמות חדשה
          </Button>
        }
      />

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-end">
          <div className="space-y-1">
            <Label htmlFor="character-search">חיפוש ברשימה הטעונה</Label>
            <Input
              id="character-search"
              type="search"
              aria-label="חיפוש בדמויות הטעונות"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="שם, קטגוריה או תיאור קצר"
            />
          </div>
          <FilterSelect
            id="character-activity"
            label="פעילות"
            value={activity}
            onChange={setActivity}
            options={[
              ["all", "הכול"],
              ["active", "פעילות"],
              ["inactive", "לא פעילות"],
            ]}
          />
          <FilterSelect
            id="character-visibility"
            label="נראות"
            value={visibility}
            onChange={setVisibility}
            options={[
              ["all", "הכול"],
              ["visible", "מוצגות"],
              ["hidden", "מוסתרות"],
            ]}
          />
          <Button
            type="button"
            variant="outline"
            aria-label="איפוס חיפוש ומסננים"
            disabled={!filtersActive}
            onClick={() => {
              setSearch("");
              setActivity("all");
              setVisibility("all");
            }}
          >
            איפוס
          </Button>
        </CardContent>
      </Card>

      {listQuery.data && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{characters.length} תוצאות טעונות</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void refreshList()}
            disabled={listQuery.isFetching}
          >
            <RefreshCw className="ml-1 h-4 w-4" />
            {listQuery.isFetching ? "מרענן…" : "רענון"}
          </Button>
        </div>
      )}
      {listRefreshMessage && (
        <RetryMessage
          label={listRefreshMessage}
          button="נסה שוב לרענן דמויות"
          onRetry={() => void refreshList()}
        />
      )}
      {assignmentsQuery.isError && characters.length > 0 && (
        <RetryMessage
          label="מוני העובדים אינם זמינים כרגע."
          button="נסה שוב לטעון מוני עובדים"
          onRetry={() => void assignmentsQuery.refetch()}
        />
      )}
      {conversationsQuery.isError && characters.length > 0 && (
        <RetryMessage
          label="מוני השיחות אינם זמינים כרגע."
          button="נסה שוב לטעון מוני שיחות"
          onRetry={() => void conversationsQuery.refetch()}
        />
      )}

      {listQuery.isLoading && !listQuery.data && (
        <div role="status" aria-label="טוען דמויות">
          <Skeleton className="h-32" />
        </div>
      )}
      {listQuery.isError && !listQuery.data && (
        <RetryMessage
          label="טעינת הדמויות נכשלה"
          button="נסה שוב לטעון דמויות"
          onRetry={() => void listQuery.refetch()}
        />
      )}
      {listQuery.data && characters.length === 0 && <EmptyState>אין דמויות עדיין</EmptyState>}
      {listQuery.data && characters.length > 0 && filtered.length === 0 && (
        <EmptyState>אין תוצאות במסננים הנוכחיים</EmptyState>
      )}
      {filtered.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            המונים משקפים את הרשומות שנקראו כעת ואינם דוח היסטורי מלא.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((character) => (
              <article key={character.id} aria-label={character.name}>
                <Card className="h-full">
                  <CardContent className="p-4">
                    <CharacterSummary character={character} />
                    <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {assignmentsQuery.isPending
                          ? "עובדים: טוען…"
                          : assignmentsQuery.isError
                            ? "עובדים: לא זמין"
                            : `${assignmentsQuery.data?.get(character.id) ?? 0} עובדים`}
                      </span>
                      <span>
                        {conversationsQuery.isPending
                          ? "שיחות: טוען…"
                          : conversationsQuery.isError
                            ? "שיחות: לא זמין"
                            : `${conversationsQuery.data?.get(character.id) ?? 0} שיחות`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-w-28 flex-1"
                        aria-label={`עריכת ${character.name}`}
                        onClick={(event) => openEditing(character, event.currentTarget)}
                        disabled={locks.current.has(`character:${character.id}`)}
                      >
                        <Edit className="ml-1 h-3.5 w-3.5" /> עריכה
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${character.is_visible ? "הסתר" : "הצג"}: ${character.name}`}
                        onClick={() => void toggleVisibility(character)}
                        disabled={locks.current.has(`character:${character.id}`)}
                      >
                        {character.is_visible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`ניהול מדיה: ${character.name}`}
                        onClick={() =>
                          setMediaCharacter({ id: character.id, name: character.name })
                        }
                      >
                        <Images className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </article>
            ))}
          </div>
        </>
      )}

      {editing && (
        <CharacterDialog
          key={`${adminId}:${editing.instance}`}
          adminId={adminId}
          instance={editing.instance}
          character={editing.character}
          locks={locks}
          onLockChange={() => renderLocks((value) => value + 1)}
          onClose={closeEditing}
          onSaved={afterSaved}
          onCheckCreate={checkCreateList}
        />
      )}
      {mediaCharacter && (
        <CharacterMediaDialog
          key={`${adminId}:${mediaCharacter.id}`}
          character={mediaCharacter}
          onClose={() => setMediaCharacter(null)}
        />
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function RetryMessage({
  label,
  button,
  onRetry,
}: {
  label: string;
  button: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
    >
      <span>{label}</span>
      <Button size="sm" variant="outline" aria-label={button} onClick={onRetry}>
        נסה שוב
      </Button>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-12 text-center text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

function CharacterSummary({ character }: { character: CharRow }) {
  return (
    <>
      <div className="mb-3 flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
          {character.avatar_url ? (
            <img src={character.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg font-semibold">
              {character.name[0]}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{character.name}</div>
          <div className="text-xs text-muted-foreground">
            {character.fictional_age === null ? "—" : `גיל ${character.fictional_age}`}
            {character.category && ` · ${character.category}`}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <StatusBadge status={character.availability_status} />
            <StatusBadge status={character.is_active ? "active" : "inactive"} />
            <StatusBadge status={character.is_visible ? "visible" : "hidden"} />
          </div>
        </div>
      </div>
      {character.short_description && (
        <p className="mb-3 line-clamp-2 text-xs text-muted-foreground">
          {character.short_description}
        </p>
      )}
    </>
  );
}

function CharacterDialog({
  adminId,
  instance,
  character,
  locks,
  onLockChange,
  onClose,
  onSaved,
  onCheckCreate,
}: {
  adminId: string;
  instance: number;
  character: Partial<CharRow>;
  locks: MutableRefObject<Set<string>>;
  onLockChange: () => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onCheckCreate: (name: string) => Promise<CreateCheck>;
}) {
  const qc = useQueryClient();
  const alive = useRef(true);
  const cityLock = useRef(false);
  const [form, setForm] = useState(character);
  const [interestsText, setInterestsText] = useState((character.interests ?? []).join(", "));
  const [dirtyFields, setDirtyFields] = useState<Set<EditableKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [cityQuery, setCityQuery] = useState("");
  const [cityToCreate, setCityToCreate] = useState<string | null>(null);
  const [creatingCity, setCreatingCity] = useState(false);
  const [actionError, setActionError] = useState("");
  const [uncertainCreateAttempt, setUncertainCreateAttempt] =
    useState<UncertainCreateAttempt | null>(null);
  const [createCheckMessage, setCreateCheckMessage] = useState("");
  const isNew = !character.id;
  const operationKey = isNew ? `character:create:${adminId}` : `character:${character.id}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const citiesQuery = useQuery({
    queryKey: ["admin-discovery-cities", adminId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("discovery_cities")
        .select("id, display_name_he")
        .eq("is_active", true)
        .order("display_name_he");
      if (error) throw error;
      return data ?? [];
    },
  });
  const set = <K extends EditableKey>(key: K, value: CharRow[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirtyFields((current) => new Set(current).add(key));
    setActionError("");
  };
  const setInterests = (value: string) => {
    setInterestsText(value);
    setDirtyFields((current) => new Set(current).add("interests"));
    setActionError("");
  };
  const selectedCity = citiesQuery.data?.find((city) => city.id === form.discovery_city_id);
  const selectedCityLabel =
    form.discovery_city_id == null
      ? "ללא עיר"
      : (selectedCity?.display_name_he ?? "עיר קיימת שאינה ברשימה");
  const normalizedCityQuery = cityQuery.trim().replace(/\s+/g, " ");
  const cityAlreadyExists = citiesQuery.data?.some(
    (city) =>
      city.display_name_he.trim().toLocaleLowerCase("he") ===
      normalizedCityQuery.toLocaleLowerCase("he"),
  );
  const legacyAvailability =
    form.availability_status &&
    !availabilityOptions.some((option) => option.value === form.availability_status)
      ? form.availability_status
      : null;

  const createCity = async () => {
    if (!cityToCreate || cityLock.current) return;
    cityLock.current = true;
    setCreatingCity(true);
    try {
      const { data, error } = await supabase.rpc("create_discovery_city", {
        _display_name_he: cityToCreate,
      });
      const created = data?.[0];
      if (
        error ||
        typeof created?.id !== "string" ||
        !created.id ||
        typeof created.display_name_he !== "string" ||
        created.display_name_he.trim().toLocaleLowerCase("he") !==
          cityToCreate.toLocaleLowerCase("he")
      ) {
        throw error ?? new Error("invalid_city_result");
      }
      if (!alive.current) return;
      qc.setQueryData<{ id: string; display_name_he: string }[]>(
        ["admin-discovery-cities", adminId],
        (current) => [...(current ?? []), created],
      );
      set("discovery_city_id", created.id);
      setCityQuery("");
      setCityToCreate(null);
      toast.success("העיר נוספה ונבחרה לדמות");
      const refreshed = await citiesQuery.refetch();
      if (refreshed.error && alive.current) toast.error("העיר נוצרה, אך רענון רשימת הערים נכשל");
    } catch {
      if (alive.current) toast.error("יצירת העיר נכשלה");
    } finally {
      cityLock.current = false;
      if (alive.current) setCreatingCity(false);
    }
  };

  const normalizeField = (key: EditableKey): unknown => {
    if (key === "name") return form.name?.trim() ?? "";
    if (key === "fictional_age") return form.fictional_age ?? null;
    if (key === "category") return form.category?.trim() || null;
    if (key === "short_description") return form.short_description?.trim() || null;
    if (key === "full_description") return form.full_description?.trim() || null;
    if (key === "personality") return form.personality?.trim() || null;
    if (key === "interests")
      return interestsText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (key === "discovery_city_id") return form.discovery_city_id ?? null;
    if (key === "avatar_url") return form.avatar_url ?? null;
    if (key === "availability_status") return form.availability_status ?? "available";
    if (key === "is_active") return form.is_active ?? true;
    return form.is_visible ?? true;
  };
  const buildPayload = (): TablesUpdate<"characters"> => {
    const keys: EditableKey[] = isNew
      ? [
          "name",
          "fictional_age",
          "category",
          "short_description",
          "full_description",
          "personality",
          "interests",
          "discovery_city_id",
          "avatar_url",
          "availability_status",
          "is_active",
          "is_visible",
        ]
      : [...dirtyFields];
    return Object.fromEntries(
      keys.map((key) => [key, normalizeField(key)]),
    ) as TablesUpdate<"characters">;
  };

  const submit = async () => {
    if (locks.current.has(operationKey) || avatarUploading || uncertainCreateAttempt) return;
    if (!form.name?.trim()) {
      toast.error("שם דמות חובה");
      return;
    }
    if (form.fictional_age != null && form.fictional_age < 0) {
      toast.error("גיל חייב להיות מספר חיובי");
      return;
    }
    locks.current.add(operationKey);
    onLockChange();
    setBusy(true);
    setActionError("");
    const payload = buildPayload();
    const createAttempt: UncertainCreateAttempt | null = isNew
      ? Object.freeze({ name: form.name.trim() })
      : null;
    const markCreateUncertain = () => {
      if (!alive.current || !createAttempt) return;
      setUncertainCreateAttempt(createAttempt);
      setActionError("");
      setCreateCheckMessage("");
    };
    try {
      let response: { data: { id?: string } | null; error: unknown; status?: number };
      try {
        const createPayload: TablesInsert<"characters"> = {
          ...payload,
          name: form.name.trim(),
        };
        response = isNew
          ? await supabase.from("characters").insert(createPayload).select("id").maybeSingle()
          : await supabase
              .from("characters")
              .update(payload)
              .eq("id", character.id!)
              .select("id")
              .maybeSingle();
      } catch (error) {
        if (isNew) {
          markCreateUncertain();
          return;
        }
        throw error;
      }
      if (isNew) {
        if (response.error) {
          if (response.status === 0) {
            markCreateUncertain();
            return;
          }
          throw response.error;
        }
        if (typeof response.data?.id !== "string" || !response.data.id) {
          markCreateUncertain();
          return;
        }
      } else if (response.error || response.data?.id !== character.id) {
        throw response.error ?? new Error("invalid_character_result");
      }
      if (!alive.current) return;
      toast.success(isNew ? "דמות נוצרה" : "הדמות עודכנה");
      await onSaved();
    } catch (error) {
      if (!alive.current) return;
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      setActionError(`שמירת הדמות נכשלה${detail}`);
      toast.error("שמירת הדמות נכשלה");
    } finally {
      locks.current.delete(operationKey);
      if (alive.current) {
        setBusy(false);
        onLockChange();
      }
    }
  };

  const verifyAmbiguousCreate = async () => {
    if (!uncertainCreateAttempt || busy) return;
    setBusy(true);
    setCreateCheckMessage("");
    const result = await onCheckCreate(uncertainCreateAttempt.name);
    if (!alive.current) return;
    setBusy(false);
    if (result === "possible-match") {
      setCreateCheckMessage(
        "נמצאה רשומה באותו שם בנתונים הטעונים; אין אפשרות לוודא שהיא נוצרה בניסיון הזה.",
      );
    } else if (result === "no-match") {
      setCreateCheckMessage("לא נמצאה התאמה בנתונים הטעונים; תוצאה זו אינה הוכחה שהיצירה נכשלה.");
    } else {
      setCreateCheckMessage("בדיקת הרשימה נכשלה. תוצאת היצירה עדיין אינה ידועה.");
    }
  };

  const fieldId = (name: string) => `character-${instance}-${name}`;
  const formDisabled = busy || creatingCity;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !avatarUploading && onClose()}>
      <DialogContent
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
        dir="rtl"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{isNew ? "דמות חדשה" : `עריכת ${character.name}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {dirtyFields.size > 0 && (
            <p role="status" className="text-sm text-amber-700">
              יש שינויים שלא נשמרו
            </p>
          )}
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          {uncertainCreateAttempt && (
            <p role="alert" className="text-sm text-destructive">
              תוצאת יצירת &quot;{uncertainCreateAttempt.name}&quot; אינה ידועה. אין לנסות ליצור שוב
              מתוך הטופס הזה עד לבירור מתאים.
            </p>
          )}
          {createCheckMessage && <p role="status">{createCheckMessage}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="שם *" id={fieldId("name")}>
              <Input
                id={fieldId("name")}
                value={form.name ?? ""}
                onChange={(event) => set("name", event.target.value)}
                disabled={formDisabled}
              />
            </Field>
            <Field label="גיל פיקטיבי" id={fieldId("age")}>
              <Input
                id={fieldId("age")}
                type="number"
                value={form.fictional_age ?? ""}
                onChange={(event) =>
                  set("fictional_age", event.target.value ? Number(event.target.value) : null)
                }
                disabled={formDisabled}
              />
            </Field>
          </div>
          <Field label="קטגוריה" id={fieldId("category")}>
            <Input
              id={fieldId("category")}
              value={form.category ?? ""}
              onChange={(event) => set("category", event.target.value)}
              disabled={formDisabled}
            />
          </Field>
          <div className="space-y-1">
            <Label>עיר גילוי</Label>
            {citiesQuery.isError && (
              <RetryMessage
                label="טעינת הערים נכשלה"
                button="נסה שוב לטעון ערים"
                onRetry={() => void citiesQuery.refetch()}
              />
            )}
            <Popover open={cityOpen} onOpenChange={setCityOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-label={selectedCityLabel}
                  aria-expanded={cityOpen}
                  className="w-full justify-between font-normal"
                  disabled={formDisabled}
                >
                  {selectedCityLabel}
                  <ChevronsUpDown className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command shouldFilter>
                  <CommandInput
                    placeholder="חיפוש עיר..."
                    value={cityQuery}
                    onValueChange={setCityQuery}
                  />
                  <CommandList>
                    <CommandEmpty>לא נמצאה עיר קיימת.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="no-city"
                        onSelect={() => {
                          set("discovery_city_id", null);
                          setCityOpen(false);
                          setCityQuery("");
                        }}
                      >
                        ללא עיר{!form.discovery_city_id && <Check className="mr-auto h-4 w-4" />}
                      </CommandItem>
                      {(citiesQuery.data ?? []).map((city) => (
                        <CommandItem
                          key={city.id}
                          value={city.display_name_he}
                          onSelect={() => {
                            set("discovery_city_id", city.id);
                            setCityOpen(false);
                            setCityQuery("");
                          }}
                        >
                          {city.display_name_he}
                          {form.discovery_city_id === city.id && (
                            <Check className="mr-auto h-4 w-4" />
                          )}
                        </CommandItem>
                      ))}
                      {normalizedCityQuery && !cityAlreadyExists && !citiesQuery.isError && (
                        <CommandItem
                          value={`create-${normalizedCityQuery}`}
                          onSelect={() => {
                            setCityOpen(false);
                            setCityToCreate(normalizedCityQuery);
                          }}
                        >
                          <Plus className="h-4 w-4" />
                          {`הוסף "${normalizedCityQuery}"`}
                        </CommandItem>
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <Field label="תיאור קצר" id={fieldId("short-description")}>
            <Input
              id={fieldId("short-description")}
              value={form.short_description ?? ""}
              onChange={(event) => set("short_description", event.target.value)}
              disabled={formDisabled}
            />
          </Field>
          <Field label="תיאור מלא" id={fieldId("full-description")}>
            <Textarea
              id={fieldId("full-description")}
              rows={3}
              value={form.full_description ?? ""}
              onChange={(event) => set("full_description", event.target.value)}
              disabled={formDisabled}
            />
          </Field>
          <Field label="אישיות" id={fieldId("personality")}>
            <Textarea
              id={fieldId("personality")}
              rows={2}
              value={form.personality ?? ""}
              onChange={(event) => set("personality", event.target.value)}
              disabled={formDisabled}
            />
          </Field>
          <Field label="תחומי עניין (מופרדים בפסיקים)" id={fieldId("interests")}>
            <Input
              id={fieldId("interests")}
              value={interestsText}
              onChange={(event) => setInterests(event.target.value)}
              disabled={formDisabled}
            />
          </Field>
          <AvatarUpload
            bucket="character-avatars"
            value={form.avatar_url ?? null}
            onChange={(url) => set("avatar_url", url)}
            label="תמונת דמות"
            disabled={formDisabled}
            onUploadStateChange={setAvatarUploading}
            cancelCompletionOnUnmount
          />
          <Field label="סטטוס זמינות" id={fieldId("availability")}>
            <select
              id={fieldId("availability")}
              value={form.availability_status ?? "available"}
              onChange={(event) => set("availability_status", event.target.value)}
              disabled={formDisabled}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {legacyAvailability && (
                <option value={legacyAvailability}>ערך קיים: {legacyAvailability}</option>
              )}
              {availabilityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={fieldId("active")}>פעילה</Label>
            <Switch
              id={fieldId("active")}
              checked={form.is_active ?? true}
              onCheckedChange={(value) => set("is_active", value)}
              disabled={formDisabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={fieldId("visible")}>מוצגת ללקוחות</Label>
            <Switch
              id={fieldId("visible")}
              checked={form.is_visible ?? true}
              onCheckedChange={(value) => set("is_visible", value)}
              disabled={formDisabled}
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            onClick={() => void submit()}
            disabled={busy || avatarUploading || uncertainCreateAttempt !== null}
          >
            {busy ? "שומר..." : "שמור"}
          </Button>
          {uncertainCreateAttempt && (
            <Button type="button" variant="outline" onClick={() => void verifyAmbiguousCreate()}>
              בדוק את הרשימה לקבלת מידע נוסף
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy || avatarUploading}
          >
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={cityToCreate !== null}
        onOpenChange={(open) => !open && !creatingCity && setCityToCreate(null)}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להוסיף עיר חדשה?</AlertDialogTitle>
            <AlertDialogDescription>
              {cityToCreate ? `העיר "${cityToCreate}" תתווסף כעיר פעילה ותיבחר לדמות.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={creatingCity}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              disabled={creatingCity}
              onClick={(event) => {
                event.preventDefault();
                void createCity();
              }}
            >
              {creatingCity ? "מוסיף..." : "הוסף עיר"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
