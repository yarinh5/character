import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Gift, ImagePlus, LoaderCircle, Power, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";
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

export const Route = createFileRoute("/admin/gifts")({
  component: AdminGiftsPage,
});

type GiftRow = Database["public"]["Functions"]["get_admin_gift_catalog"]["Returns"][number];
type UploadIntent = { gift_id?: unknown; upload_url?: unknown };

const SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;
const MAX_RENDER_BYTES = 512 * 1024;
const MAX_RENDER_SIDE = 768;

function isSupportedImage(file: File) {
  return ["image/webp", "image/png", "image/jpeg"].includes(file.type)
    || /\.(webp|png|jpe?g)$/i.test(file.name);
}

function toWebp(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("render_conversion_failed"))), "image/webp", quality);
  });
}

async function createRenderReadyGift(file: File) {
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_RENDER_SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("render_conversion_failed");
    context.drawImage(image, 0, 0, width, height);

    for (const quality of [0.9, 0.82, 0.74, 0.66]) {
      const render = await toWebp(canvas, quality);
      if (render.size <= MAX_RENDER_BYTES) {
        return new File([render], "gift-render.webp", { type: "image/webp" });
      }
    }
    throw new Error("render_too_large");
  } finally {
    image.close();
  }
}

async function functionErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("context" in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) return null;
  const body = await context.clone().json().catch(() => null);
  return body && typeof body.code === "string" ? body.code : null;
}

function GiftPreview({ gift }: { gift: GiftRow }) {
  const preview = useMediaViewUrl("admin_gift_preview", gift.ingest_status === "ready" ? gift.id : undefined);
  if (preview.status === "ready" && preview.url) {
    return (
      <img
        src={preview.url}
        alt=""
        className="aspect-square w-full object-contain bg-muted"
        referrerPolicy="no-referrer"
        onError={preview.retryAfterImageError}
      />
    );
  }
  return <div className="aspect-square bg-muted" />;
}

function GiftCard({ gift, busy, onRefresh, onDelete }: {
  gift: GiftRow;
  busy: boolean;
  onRefresh: () => Promise<unknown>;
  onDelete: (gift: GiftRow) => void;
}) {
  const [name, setName] = useState(gift.name);
  const [price, setPrice] = useState(String(gift.price_credits));
  const [sortOrder, setSortOrder] = useState(String(gift.sort_order));

  const save = async () => {
    const parsedPrice = Number(price);
    const parsedSort = Number(sortOrder);
    if (!Number.isInteger(parsedPrice) || parsedPrice < 1 || !Number.isInteger(parsedSort)) {
      toast.error("Enter a positive whole-number price and a whole-number sort order.");
      return;
    }
    const { error } = await supabase.rpc("admin_update_gift", {
      _gift_id: gift.id,
      _name: name,
      _price_credits: parsedPrice,
      _sort_order: parsedSort,
    });
    if (error) {
      toast.error("Gift details could not be updated.");
      return;
    }
    await onRefresh();
    toast.success("Gift details updated.");
  };

  const toggle = async () => {
    const { error } = await supabase.rpc("set_admin_gift_active", {
      _gift_id: gift.id,
      _is_active: !gift.is_active,
    });
    if (error) {
      toast.error(gift.ingest_status === "ready" ? "Gift state could not be updated." : "Only ready gifts can be activated.");
      return;
    }
    await onRefresh();
    toast.success("Gift state updated.");
  };

  return (
    <Card>
      <GiftPreview gift={gift} />
      <CardContent className="space-y-2 p-3">
        <div className="text-xs text-muted-foreground truncate">
          {gift.collection_name} - {gift.character_id ? "Character" : "Global"}
        </div>
        <Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} aria-label="Gift name" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={price} disabled={busy} inputMode="numeric" onChange={(event) => setPrice(event.target.value)} aria-label="Credit price" />
          <Input value={sortOrder} disabled={busy} inputMode="numeric" onChange={(event) => setSortOrder(event.target.value)} aria-label="Sort order" />
        </div>
        <div className="text-xs">
          {gift.ingest_status} - {gift.is_active ? "active" : "inactive"}
        </div>
        {gift.failure_code && <div className="text-xs text-destructive">{gift.failure_code}</div>}
        <Button size="sm" variant="outline" className="w-full" disabled={busy || Boolean(gift.deletion_started_at)} onClick={() => void save()}>
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={busy || gift.ingest_status !== "ready" || Boolean(gift.deletion_started_at)}
          onClick={() => void toggle()}
        >
          <Power className="h-3.5 w-3.5" />
          {gift.is_active ? "Deactivate" : "Activate"}
        </Button>
        <Button size="sm" variant="destructive" className="w-full" disabled={busy} onClick={() => onDelete(gift)}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </CardContent>
    </Card>
  );
}

function AdminGiftsPage() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GiftRow | null>(null);
  const [collectionName, setCollectionName] = useState("");
  const [collectionCharacterId, setCollectionCharacterId] = useState("global");
  const [createdCollections, setCreatedCollections] = useState<Array<{ id: string; name: string; characterId: string | null }>>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [giftName, setGiftName] = useState("");
  const [giftPrice, setGiftPrice] = useState("");
  const [giftSortOrder, setGiftSortOrder] = useState("0");

  const catalog = useQuery({
    queryKey: ["admin-gifts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_gift_catalog");
      if (error) throw error;
      return data as GiftRow[];
    },
  });
  const characters = useQuery({
    queryKey: ["admin-gift-characters"],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("id, name").order("name");
      if (error) throw error;
      return data;
    },
  });
  const collectionOptions = useMemo(() => {
    const known = new Map<string, { id: string; name: string; characterId: string | null }>();
    for (const gift of catalog.data ?? []) known.set(gift.collection_id, { id: gift.collection_id, name: gift.collection_name, characterId: gift.character_id });
    for (const collection of createdCollections) known.set(collection.id, collection);
    return [...known.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [catalog.data, createdCollections]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-gifts"] });

  const createCollection = async () => {
    if (!collectionName.trim()) {
      toast.error("Enter a collection name.");
      return;
    }
    setBusy(true);
    try {
      // PostgREST typegen does not represent nullable UUID RPC arguments.
      const nullableCharacterId = (collectionCharacterId === "global" ? null : collectionCharacterId) as unknown as string;
      const { data, error } = await supabase.rpc("admin_create_gift_collection", {
        _name: collectionName.trim(),
        _character_id: nullableCharacterId,
        _sort_order: 0,
      });
      if (error || typeof data !== "string") throw error ?? new Error("gift_collection_create_failed");
      const { error: activateError } = await supabase.rpc("admin_update_gift_collection", {
        _collection_id: data,
        _name: collectionName.trim(),
        _character_id: nullableCharacterId,
        _is_active: true,
        _sort_order: 0,
      });
      if (activateError) throw activateError;
      const collection = { id: data, name: collectionName.trim(), characterId: collectionCharacterId === "global" ? null : collectionCharacterId };
      setCreatedCollections((current) => [...current, collection]);
      setSelectedCollectionId(collection.id);
      setCollectionName("");
      toast.success("Collection created.");
    } catch {
      toast.error("Gift collection could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    const parsedPrice = Number(giftPrice);
    const parsedSort = Number(giftSortOrder);
    if (
      !selectedCollectionId ||
      !giftName.trim() ||
      !isSupportedImage(file) ||
      file.size < 1 ||
      file.size > SOURCE_LIMIT_BYTES ||
      !Number.isInteger(parsedPrice) ||
      parsedPrice < 1 ||
      !Number.isInteger(parsedSort)
    ) {
      toast.error("Choose a collection, enter a positive price, and select WebP, PNG, or JPEG up to 10 MB.");
      return;
    }
    setBusy(true);
    try {
      const render = await createRenderReadyGift(file);
      const { data, error } = await supabase.functions.invoke("admin-gift-upload-intent", {
        body: {
          collection_id: selectedCollectionId,
          name: giftName.trim(),
          price_credits: parsedPrice,
          sort_order: parsedSort,
          content_type: "image/webp",
        },
      });
      const intent = (data ?? {}) as UploadIntent;
      if (error || typeof intent.gift_id !== "string" || typeof intent.upload_url !== "string") {
        throw error ?? new Error("invalid_upload_intent");
      }
      const put = await fetch(intent.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", "x-upsert": "false" },
        body: render,
      });
      if (!put.ok) throw new Error("gift_upload_failed");
      const { error: finalizeError } = await supabase.functions.invoke("finalize-gift-media", {
        body: { gift_id: intent.gift_id },
      });
      if (finalizeError) throw finalizeError;
      setGiftName("");
      setGiftPrice("");
      toast.success("Gift is ready for activation.");
    } catch {
      toast.error("Gift upload or finalization failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      await refresh();
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("delete-gift-media", { body: { gift_id: deleteTarget.id } });
      if (error) throw new Error((await functionErrorCode(error)) ?? "gift_delete_not_available");
      setDeleteTarget(null);
      toast.success("Gift deleted.");
    } catch (error) {
      toast.error(error instanceof Error && error.message === "gift_in_use" ? "Gift is already in use and cannot be deleted." : "Gift delete failed.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader title="Gift catalog" description="Admin-only ingest. Gift sending remains disabled." />

      <Card className="mb-6">
        <CardContent className="grid gap-3 p-4 md:grid-cols-4">
          <div>
            <Label>New collection</Label>
            <Input value={collectionName} disabled={busy} onChange={(event) => setCollectionName(event.target.value)} />
          </div>
          <div>
            <Label>Collection scope</Label>
            <Select value={collectionCharacterId} onValueChange={setCollectionCharacterId} disabled={busy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                {(characters.data ?? []).map((character) => <SelectItem key={character.id} value={character.id}>{character.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button className="w-full" disabled={busy} onClick={() => void createCollection()}>
              <Gift className="h-4 w-4" />
              Create collection
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardContent className="grid gap-3 p-4 md:grid-cols-5">
          <div>
            <Label>Collection</Label>
            <Select value={selectedCollectionId} onValueChange={setSelectedCollectionId} disabled={busy}>
              <SelectTrigger><SelectValue placeholder="Choose collection" /></SelectTrigger>
              <SelectContent>
                {collectionOptions.map((collection) => (
                  <SelectItem key={collection.id} value={collection.id}>{collection.name} - {collection.characterId ? "Character" : "Global"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Gift name</Label><Input value={giftName} disabled={busy} onChange={(event) => setGiftName(event.target.value)} /></div>
          <div><Label>Credit price</Label><Input value={giftPrice} disabled={busy} inputMode="numeric" onChange={(event) => setGiftPrice(event.target.value)} /></div>
          <div><Label>Sort order</Label><Input value={giftSortOrder} disabled={busy} inputMode="numeric" onChange={(event) => setGiftSortOrder(event.target.value)} /></div>
          <div className="flex items-end">
            <input ref={inputRef} type="file" accept=".webp,.png,.jpg,.jpeg" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
            <Button className="w-full" disabled={busy || !selectedCollectionId} onClick={() => inputRef.current?.click()}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              Upload Gift
            </Button>
          </div>
          <p className="text-sm text-muted-foreground md:col-span-5">WebP, PNG, or JPEG up to 10 MB. The browser prepares a private render-ready image.</p>
        </CardContent>
      </Card>

      {catalog.isError && <p className="text-destructive">Gift catalog could not be loaded.</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(catalog.data ?? []).map((gift) => <GiftCard key={gift.id} gift={gift} busy={busy} onRefresh={refresh} onDelete={setDeleteTarget} />)}
      </div>
      {!catalog.isLoading && (catalog.data?.length ?? 0) === 0 && (
        <div className="py-12 text-center text-muted-foreground"><Gift className="mx-auto mb-2" />No QA gifts yet.</div>
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete gift permanently?</AlertDialogTitle>
            <AlertDialogDescription>This removes the Gift record and its private render. Gifts already used in messages cannot be deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void remove()}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
