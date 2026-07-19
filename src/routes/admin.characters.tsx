import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Edit, Eye, EyeOff, Images } from "lucide-react";
import { AvatarUpload } from "@/components/common/AvatarUpload";
import { CharacterMediaDialog } from "@/components/admin/CharacterMediaDialog";

export const Route = createFileRoute("/admin/characters")({
  component: CharactersPage,
});

type CharRow = {
  id: string;
  name: string;
  fictional_age: number | null;
  category: string | null;
  short_description: string | null;
  full_description: string | null;
  personality: string | null;
  interests: string[] | null;
  avatar_url: string | null;
  availability_status: "available" | "busy" | "offline";
  is_active: boolean;
  is_visible: boolean;
};

const empty: Partial<CharRow> = {
  name: "",
  fictional_age: null,
  category: "",
  short_description: "",
  full_description: "",
  personality: "",
  interests: [],
  avatar_url: "",
  availability_status: "available",
  is_active: true,
  is_visible: true,
};

function CharactersPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<CharRow> | null>(null);
  const [mediaCharacter, setMediaCharacter] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-characters"],
    queryFn: async () => {
      const { data: chars, error } = await supabase
        .from("characters")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const ids = (chars ?? []).map((c) => c.id);
      const [{ data: assigns }, { data: convs }] = await Promise.all([
        ids.length
          ? supabase.from("character_operator_assignments").select("character_id").in("character_id", ids)
          : Promise.resolve({ data: [] as { character_id: string }[] }),
        ids.length
          ? supabase.from("conversations").select("character_id").in("character_id", ids)
          : Promise.resolve({ data: [] as { character_id: string }[] }),
      ]);
      const opCount = new Map<string, number>();
      (assigns ?? []).forEach((a) => opCount.set(a.character_id, (opCount.get(a.character_id) ?? 0) + 1));
      const cvCount = new Map<string, number>();
      (convs ?? []).forEach((c) => cvCount.set(c.character_id, (cvCount.get(c.character_id) ?? 0) + 1));
      return (chars ?? []).map((c) => ({
        ...(c as CharRow),
        ops: opCount.get(c.id) ?? 0,
        convs: cvCount.get(c.id) ?? 0,
      }));
    },
  });

  const toggle = async (c: CharRow, field: "is_active" | "is_visible") => {
    const patch: { is_active?: boolean; is_visible?: boolean } = { [field]: !c[field] };
    const { error } = await supabase
      .from("characters")
      .update(patch)
      .eq("id", c.id);
    if (error) {
      toast.error("עדכון נכשל");
      return;
    }
    qc.invalidateQueries({ queryKey: ["admin-characters"] });
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <PageHeader
        title="דמויות"
        description="ניהול הדמויות במערכת"
        actions={
          <Button onClick={() => setEditing({ ...empty })}>
            <Plus className="h-4 w-4 ml-1" /> דמות חדשה
          </Button>
        }
      />

      {isLoading && <Skeleton className="h-32" />}
      {!isLoading && (data?.length ?? 0) === 0 && (
        <Card><CardContent className="py-12 text-center text-muted-foreground">אין דמויות עדיין</CardContent></Card>
      )}
      {!isLoading && data && data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-14 w-14 rounded-full bg-muted overflow-hidden shrink-0">
                    {c.avatar_url ? (
                      <img src={c.avatar_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-lg font-semibold">
                        {c.name[0]}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.fictional_age ? `גיל ${c.fictional_age}` : "—"}
                      {c.category && ` · ${c.category}`}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      <StatusBadge status={c.availability_status} />
                      <StatusBadge status={c.is_active ? "active" : "inactive"} />
                    </div>
                  </div>
                </div>
                {c.short_description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{c.short_description}</p>
                )}
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
                  <span>{c.ops} עובדים</span>
                  <span>{c.convs} שיחות</span>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => setEditing(c)}>
                    <Edit className="h-3.5 w-3.5 ml-1" /> עריכה
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(c, "is_visible")} title={c.is_visible ? "הסתר" : "הצג"}>
                    {c.is_visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMediaCharacter({ id: c.id, name: c.name })} title="ניהול מדיה">
                    <Images className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <CharacterDialog
          char={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["admin-characters"] });
          }}
        />
      )}
      {mediaCharacter && <CharacterMediaDialog character={mediaCharacter} onClose={() => setMediaCharacter(null)} />}
    </div>
  );
}

function CharacterDialog({
  char,
  onClose,
  onSaved,
}: {
  char: Partial<CharRow>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(char);
  const [interestsText, setInterestsText] = useState((char.interests ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const isNew = !char.id;

  const set = <K extends keyof CharRow>(k: K, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name?.trim()) {
      toast.error("שם דמות חובה");
      return;
    }
    if (form.fictional_age && form.fictional_age < 0) {
      toast.error("גיל חייב להיות מספר חיובי");
      return;
    }
    setBusy(true);
    const payload = {
      name: form.name.trim(),
      fictional_age: form.fictional_age || null,
      category: form.category?.trim() || null,
      short_description: form.short_description?.trim() || null,
      full_description: form.full_description?.trim() || null,
      personality: form.personality?.trim() || null,
      interests: interestsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      avatar_url: form.avatar_url?.trim() || null,
      availability_status: form.availability_status ?? "available",
      is_active: form.is_active ?? true,
      is_visible: form.is_visible ?? true,
    };
    const { error } = isNew
      ? await supabase.from("characters").insert(payload)
      : await supabase.from("characters").update(payload).eq("id", char.id!);
    setBusy(false);
    if (error) {
      toast.error("שמירה נכשלה: " + error.message);
      return;
    }
    toast.success(isNew ? "דמות נוצרה" : "עודכן");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{isNew ? "דמות חדשה" : "עריכת דמות"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>שם *</Label>
              <Input value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div>
              <Label>גיל פיקטיבי</Label>
              <Input
                type="number"
                value={form.fictional_age ?? ""}
                onChange={(e) => set("fictional_age", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>
          <div>
            <Label>קטגוריה</Label>
            <Input value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} />
          </div>
          <div>
            <Label>תיאור קצר</Label>
            <Input value={form.short_description ?? ""} onChange={(e) => set("short_description", e.target.value)} />
          </div>
          <div>
            <Label>תיאור מלא</Label>
            <Textarea
              rows={3}
              value={form.full_description ?? ""}
              onChange={(e) => set("full_description", e.target.value)}
            />
          </div>
          <div>
            <Label>אישיות</Label>
            <Textarea
              rows={2}
              value={form.personality ?? ""}
              onChange={(e) => set("personality", e.target.value)}
            />
          </div>
          <div>
            <Label>תחומי עניין (מופרדים בפסיקים)</Label>
            <Input value={interestsText} onChange={(e) => setInterestsText(e.target.value)} />
          </div>
          <AvatarUpload
            bucket="character-avatars"
            value={form.avatar_url ?? null}
            onChange={(url) => set("avatar_url", url)}
            label="תמונת דמות"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>סטטוס זמינות</Label>
              <Select value={form.availability_status ?? "available"} onValueChange={(v) => set("availability_status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">זמין</SelectItem>
                  <SelectItem value="busy">עסוק</SelectItem>
                  <SelectItem value="offline">לא מחובר</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label>פעילה</Label>
            <Switch checked={form.is_active ?? true} onCheckedChange={(v) => set("is_active", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label>מוצגת ללקוחות</Label>
            <Switch checked={form.is_visible ?? true} onCheckedChange={(v) => set("is_visible", v)} />
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
