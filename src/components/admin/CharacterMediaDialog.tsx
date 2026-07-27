import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, LoaderCircle, LockKeyhole, Plus, RefreshCw, RotateCcw, ShieldOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type MediaAsset = Database["public"]["Functions"]["get_admin_character_media_assets"]["Returns"][number];
type MediaTag = Database["public"]["Functions"]["get_admin_media_tags"]["Returns"][number];

type UploadIntentResponse = {
  asset_id?: unknown;
  upload_url?: unknown;
  expires_at?: unknown;
};

const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

async function functionErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("context" in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) return null;
  const body = await context.clone().json().catch(() => null);
  return body && typeof body.code === "string" ? body.code : null;
}

function formatBytes(value: number | null) {
  if (!value) return null;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function AssetPreview({ asset }: { asset: MediaAsset }) {
  const preview = useMediaViewUrl("admin_asset_preview", asset.preview_available ? asset.id : undefined);

  if (!asset.preview_available) {
    return <div className="aspect-square bg-muted text-xs text-muted-foreground flex items-center justify-center">ממתין לעיבוד</div>;
  }
  if (preview.status === "ready" && preview.url) {
    return (
      <img
        src={preview.url}
        alt=""
        className="aspect-square w-full object-cover bg-muted"
        onError={preview.retryAfterImageError}
      />
    );
  }
  if (preview.status === "error") {
    return <div className="aspect-square bg-muted text-xs text-muted-foreground flex items-center justify-center">תצוגה מקדימה אינה זמינה</div>;
  }
  return <Skeleton className="aspect-square w-full" />;
}

function LockedAssetPreview({ asset }: { asset: MediaAsset }) {
  const preview = useMediaViewUrl(
    "admin_locked_teaser_preview",
    asset.locked_preview_available ? asset.id : undefined,
  );

  if (!asset.locked_preview_available) return null;
  if (preview.status === "ready" && preview.url) {
    return (
      <img
        src={preview.url}
        alt=""
        className="aspect-square w-full object-cover bg-muted"
        onError={preview.retryAfterImageError}
      />
    );
  }
  return <Skeleton className="aspect-square w-full" />;
}

function AssetCard({
  asset,
  busy,
  onDisable,
  onRestore,
  onRetry,
  onPrepareLocked,
  onConfigureLocked,
  onConfigurePaidOpen,
  onHardDelete,
  tags,
  onAssignTag,
}: {
  asset: MediaAsset;
  busy: boolean;
  onDisable: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onPrepareLocked: () => void;
  onConfigureLocked: (priceCredits: number | null) => void;
  onConfigurePaidOpen: (priceCredits: number | null) => void;
  onHardDelete: () => void;
  tags: MediaTag[];
  onAssignTag: (tagId: string) => void;
}) {
  const [price, setPrice] = useState(asset.locked_price_credits?.toString() ?? "");
  const [paidOpenPrice, setPaidOpenPrice] = useState(asset.paid_open_price_credits?.toString() ?? "");
  const details = [asset.content_type.replace("image/", ""), formatBytes(asset.byte_size), asset.width && asset.height ? `${asset.width} x ${asset.height}` : null]
    .filter(Boolean)
    .join(" · ");
  const disabled = asset.status === "disabled";

  return (
    <div className="border rounded-md overflow-hidden bg-background">
      <AssetPreview asset={asset} />
      <div className="p-2 space-y-1.5">
        <div className="text-sm font-medium truncate">{asset.display_name || "תמונה"}</div>
        <div className="text-xs text-muted-foreground">{details}</div>
        <div className="flex items-center gap-1 text-xs">
          <span className="capitalize">{asset.ingest_status}</span>
          <span className="text-muted-foreground">·</span>
          <span className="capitalize">{asset.status}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5" />
          <span>
            נעול: {asset.locked_derivative_status}
            {asset.locked_price_credits ? ` · ${asset.locked_price_credits} קרדיטים` : ""}
          </span>
        </div>
        <div className="space-y-1 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">תגית מדיה</span>
          <Select value={asset.media_tag_id} onValueChange={onAssignTag} disabled={busy || tags.length === 0}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {asset.processing_error_code && <div className="text-xs text-destructive">העיבוד נכשל</div>}
        {asset.locked_derivative_error_code && <div className="text-xs text-destructive">יצירת נגזרות נעולות נכשלה</div>}
        {asset.locked_preview_available && (
          <div className="overflow-hidden rounded-md border border-border">
            <LockedAssetPreview asset={asset} />
          </div>
        )}
        <div className="flex gap-1 pt-1">
          {disabled ? (
            <Button size="sm" variant="outline" className="flex-1" onClick={onRestore} disabled={busy}>
              <RotateCcw className="h-3.5 w-3.5 ml-1" /> שחזור
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="flex-1" onClick={onDisable} disabled={busy}>
              <ShieldOff className="h-3.5 w-3.5 ml-1" /> השבתה
            </Button>
          )}
          {asset.ingest_status === "failed" && !disabled && (
            <Button size="sm" variant="ghost" onClick={onRetry} disabled={busy} title="נסה לעבד מחדש">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onHardDelete} disabled={busy} title="מחיקה מוחלטת">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
        {!disabled && asset.ingest_status === "ready" && (
          <div className="space-y-2 border-t border-border pt-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onPrepareLocked}
              disabled={busy || asset.locked_derivative_status === "processing"}
            >
              {asset.locked_derivative_status === "ready" ? "נגזרות נעולות מוכנות" : "הכן נגזרות נעולות"}
            </Button>
            <div className="flex gap-1">
              <Input
                type="number"
                min={1}
                inputMode="numeric"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="מחיר בקרדיטים"
                disabled={busy || asset.locked_derivative_status !== "ready"}
              />
              <Button
                size="sm"
                onClick={() => {
                  const parsed = price.trim() === "" ? null : Number(price);
                  if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
                    toast.error("יש להזין מחיר חיובי במספר שלם");
                    return;
                  }
                  onConfigureLocked(parsed);
                }}
                disabled={busy || asset.locked_derivative_status !== "ready"}
              >
                שמור
              </Button>
            </div>
          </div>
        )}
        {!disabled && asset.ingest_status === "ready" && (
          <div className="space-y-2 border-t border-border pt-2">
            <p className="text-xs font-medium">פתיחה בתשלום</p>
            <div className="flex gap-1">
              <Input
                type="number"
                min={1}
                inputMode="numeric"
                value={paidOpenPrice}
                onChange={(event) => setPaidOpenPrice(event.target.value)}
                placeholder="מחיר בקרדיטים"
                disabled={busy}
              />
              <Button
                size="sm"
                onClick={() => {
                  const parsed = paidOpenPrice.trim() === "" ? null : Number(paidOpenPrice);
                  if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
                    toast.error("יש להזין מחיר חיובי במספר שלם");
                    return;
                  }
                  onConfigurePaidOpen(parsed);
                }}
                disabled={busy}
              >
                שמור
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">השאר ריק כדי לבטל פתיחה בתשלום עבור נכס זה.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function CharacterMediaDialog({
  character,
  onClose,
}: {
  character: { id: string; name: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [busyTagId, setBusyTagId] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, { name: string; sortOrder: string }>>({});
  const [selectedTagId, setSelectedTagId] = useState("all");
  const [tagToDelete, setTagToDelete] = useState<MediaTag | null>(null);
  const [assetToHardDelete, setAssetToHardDelete] = useState<MediaAsset | null>(null);
  const queryKey = ["admin-character-media", character.id] as const;
  const tagQueryKey = ["admin-character-media-tags", character.id] as const;
  const { data: assets = [], isLoading, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_character_media_assets", { _character_id: character.id });
      if (error) throw error;
      return data;
    },
  });
  const { data: tags = [], isLoading: tagsLoading, isError: tagsError } = useQuery({
    queryKey: tagQueryKey,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_media_tags", { _character_id: character.id });
      if (error) throw error;
      return data;
    },
  });

  const filteredAssets = useMemo(
    () => assets.filter((asset) => selectedTagId === "all" || asset.media_tag_id === selectedTagId),
    [assets, selectedTagId],
  );

  useEffect(() => {
    const tagIds = new Set(tags.map((tag) => tag.id));
    setTagDrafts((drafts) => {
      const retainedEntries = Object.entries(drafts).filter(([tagId]) => tagIds.has(tagId));
      return retainedEntries.length === Object.keys(drafts).length
        ? drafts
        : Object.fromEntries(retainedEntries);
    });
    if (selectedTagId !== "all" && !tagIds.has(selectedTagId)) setSelectedTagId("all");
    if (tagToDelete && !tagIds.has(tagToDelete.id)) setTagToDelete(null);
  }, [selectedTagId, tagToDelete, tags]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: tagQueryKey }),
    ]);
  };

  const getTagErrorMessage = (error: unknown) => {
    const message = typeof error === "object" && error && "message" in error ? String(error.message) : "";
    if (message.includes("media_tag_in_use")) return "אי אפשר למחוק תגית שיש לה מדיה. העבר את המדיה לתגית אחרת קודם.";
    if (message.includes("default_media_tag_cannot_be_deleted")) return "לא ניתן למחוק תגית ברירת מחדל.";
    if (message.includes("media_tag_name_invalid") || message.includes("media_tags_name_check")) return "יש להזין שם תגית תקין.";
    if (message.includes("media_tag_name_conflict") || message.includes("media_tags_character_name_idx")) return "כבר קיימת תגית בשם זה לדמות.";
    if (message.includes("media_tag_character_mismatch")) return "אפשר לשייך נכס רק לתגית של אותה דמות.";
    return "לא ניתן לשמור את תגית המדיה כרגע.";
  };

  const createTag = async () => {
    const name = newTagName.trim();
    if (!name) {
      toast.error("יש להזין שם לתגית.");
      return;
    }
    setBusyTagId("create");
    try {
      const { error } = await supabase.rpc("create_admin_media_tag", {
        _character_id: character.id,
        _name: name,
      });
      if (error) throw error;
      setNewTagName("");
      await refresh();
      toast.success("תגית המדיה נוצרה");
    } catch (error) {
      toast.error(getTagErrorMessage(error));
    } finally {
      setBusyTagId(null);
    }
  };

  const updateTag = async (tag: MediaTag) => {
    const draft = tagDrafts[tag.id];
    const name = (draft?.name ?? tag.name).trim();
    const sortOrder = Number(draft?.sortOrder ?? tag.sort_order);
    if (!name || !Number.isInteger(sortOrder) || sortOrder < 0) {
      toast.error("יש להזין שם וסדר תקינים לתגית.");
      return;
    }
    setBusyTagId(tag.id);
    try {
      const { error } = await supabase.rpc("update_admin_media_tag", {
        _tag_id: tag.id,
        _name: name,
        _sort_order: sortOrder,
      });
      if (error) throw error;
      setTagDrafts((drafts) => {
        const next = { ...drafts };
        delete next[tag.id];
        return next;
      });
      await refresh();
      toast.success("תגית המדיה נשמרה");
    } catch (error) {
      toast.error(getTagErrorMessage(error));
    } finally {
      setBusyTagId(null);
    }
  };

  const deleteTag = async () => {
    if (!tagToDelete) return;
    const tag = tagToDelete;
    setBusyTagId(tag.id);
    try {
      const { error } = await supabase.rpc("delete_admin_media_tag", { _tag_id: tag.id });
      if (error) throw error;
      if (selectedTagId === tag.id) setSelectedTagId("all");
      await refresh();
      toast.success("תגית המדיה נמחקה");
    } catch (error) {
      toast.error(getTagErrorMessage(error));
    } finally {
      setTagToDelete(null);
      setBusyTagId(null);
    }
  };

  const assignAssetTag = async (asset: MediaAsset, tagId: string) => {
    if (tagId === asset.media_tag_id) return;
    setBusyAssetId(asset.id);
    try {
      const { error } = await supabase.rpc("assign_admin_media_asset_tag", {
        _asset_id: asset.id,
        _media_tag_id: tagId,
      });
      if (error) throw error;
      await refresh();
      toast.success("תגית הנכס עודכנה");
    } catch (error) {
      toast.error(getTagErrorMessage(error));
    } finally {
      setBusyAssetId(null);
    }
  };

  const processAsset = async (assetId: string, mode: "standard" | "locked" = "standard") => {
    const { error } = await supabase.functions.invoke("process-character-media", { body: { asset_id: assetId, mode } });
    if (error) throw error;
  };

  const configureLocked = async (assetId: string, priceCredits: number | null) => {
    setBusyAssetId(assetId);
    try {
      const { error } = await supabase.rpc("configure_character_media_asset_locked", {
        _asset_id: assetId,
        _price_credits: priceCredits ?? undefined,
      });
      if (error) throw error;
      await refresh();
      toast.success(priceCredits === null ? "הגדרת המדיה הנעולה הוסרה" : "מחיר המדיה הנעולה נשמר");
    } catch {
      toast.error("לא ניתן לשמור את הגדרת המדיה הנעולה");
    } finally {
      setBusyAssetId(null);
    }
  };

  const configurePaidOpen = async (assetId: string, priceCredits: number | null) => {
    setBusyAssetId(assetId);
    try {
      const { error } = await supabase.rpc("configure_character_media_asset_paid_open", {
        _asset_id: assetId,
        _price_credits: priceCredits ?? undefined,
      });
      if (error) throw error;
      await refresh();
      toast.success(priceCredits === null ? "פתיחה בתשלום בוטלה" : "מחיר הפתיחה בתשלום נשמר");
    } catch {
      toast.error("לא ניתן לשמור את הגדרת הפתיחה בתשלום");
    } finally {
      setBusyAssetId(null);
    }
  };

  const hardDeleteAsset = async () => {
    if (!assetToHardDelete) return;
    const asset = assetToHardDelete;
    setBusyAssetId(asset.id);
    try {
      const { data, error } = await supabase.functions.invoke("delete-character-media", {
        body: { asset_id: asset.id },
      });
      if (error) throw new Error((await functionErrorCode(error)) ?? "media_delete_failed");
      if (!data || data.deleted !== true) throw new Error("media_delete_failed");
      await refresh();
      toast.success("המדיה נמחקה לצמיתות");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message.includes("media_asset_in_use")
          ? "אי אפשר למחוק מדיה שכבר נשלחה או נמצאת בשימוש."
          : "לא ניתן למחוק את המדיה כרגע. אפשר לנסות שוב.",
      );
    } finally {
      setAssetToHardDelete(null);
      setBusyAssetId(null);
    }
  };

  const uploadFile = async (file: File) => {
    if (!ACCEPTED_MEDIA_TYPES.has(file.type) || file.size > MAX_SOURCE_BYTES) {
      toast.error("יש לבחור JPEG, PNG או WebP עד 5MB");
      return;
    }

    setUploading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-media-upload-intent", {
        body: { character_id: character.id, content_type: file.type, display_name: file.name },
      });
      const intent = (data ?? {}) as UploadIntentResponse;
      if (error || typeof intent.asset_id !== "string" || typeof intent.upload_url !== "string") {
        throw error ?? new Error("upload_intent_invalid");
      }

      const upload = await fetch(intent.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type, "x-upsert": "false" },
        body: file,
      });
      if (!upload.ok) throw new Error("source_upload_failed");

      await processAsset(intent.asset_id);
      await refresh();
      toast.success("התמונה עובדה ומוכנה לשימוש");
    } catch {
      await refresh();
      toast.error("העלאה או עיבוד של התמונה נכשלו");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const runAssetAction = async (asset: MediaAsset, action: "disable" | "restore" | "retry") => {
    setBusyAssetId(asset.id);
    try {
      if (action === "retry") {
        await processAsset(asset.id);
      } else {
        const { error } = await supabase.rpc(
          action === "disable" ? "disable_character_media_asset" : "restore_character_media_asset",
          { _asset_id: asset.id },
        );
        if (error) throw error;
      }
      await refresh();
      toast.success(action === "disable" ? "המדיה הושבתה" : action === "restore" ? "המדיה שוחזרה" : "העיבוד הופעל מחדש");
    } catch {
      toast.error(action === "disable" ? "לא ניתן להשבית את המדיה" : action === "restore" ? "לא ניתן לשחזר את המדיה" : "לא ניתן לעבד מחדש כרגע");
    } finally {
      setBusyAssetId(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>מדיה עבור {character.name}</DialogTitle>
          <DialogDescription className="sr-only">
            העלאה וניהול תמונות לדמות זו.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
            }}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="h-4 w-4 ml-1 animate-spin" /> : <ImagePlus className="h-4 w-4 ml-1" />}
            העלאת תמונה
          </Button>
          <span className="text-xs text-muted-foreground">JPEG, PNG או WebP עד 5MB</span>
        </div>

        <section className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">תגיות מדיה</h3>
              <p className="text-xs text-muted-foreground">מיון וניהול מלאי המדיה של הדמות.</p>
            </div>
            <Select value={selectedTagId} onValueChange={setSelectedTagId} disabled={tagsLoading || tags.length === 0}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="סינון לפי תגית" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל התגיות</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            <Input
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createTag();
                }
              }}
              placeholder="שם תגית חדשה"
              maxLength={120}
              disabled={busyTagId !== null}
            />
            <Button size="sm" className="shrink-0" onClick={() => void createTag()} disabled={!newTagName.trim() || busyTagId !== null}>
              {busyTagId === "create" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 ml-1" />}
              הוסף תגית
            </Button>
          </div>

          {tagsLoading && <Skeleton className="h-16 w-full" />}
          {tagsError && <p className="text-sm text-destructive">טעינת תגיות המדיה נכשלה.</p>}
          {!tagsLoading && !tagsError && (
            <div className="space-y-2">
              {tags.map((tag) => {
                const draft = tagDrafts[tag.id];
                const busy = busyTagId === tag.id;
                return (
                  <div key={tag.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
                    <Input
                      className="min-w-40 flex-1"
                      value={draft?.name ?? tag.name}
                      onChange={(event) => setTagDrafts((drafts) => ({
                        ...drafts,
                        [tag.id]: { name: event.target.value, sortOrder: drafts[tag.id]?.sortOrder ?? String(tag.sort_order) },
                      }))}
                      maxLength={120}
                      disabled={busy}
                    />
                    <Input
                      className="w-20"
                      type="number"
                      min={0}
                      step={1}
                      value={draft?.sortOrder ?? String(tag.sort_order)}
                      onChange={(event) => setTagDrafts((drafts) => ({
                        ...drafts,
                        [tag.id]: { name: drafts[tag.id]?.name ?? tag.name, sortOrder: event.target.value },
                      }))}
                      aria-label="סדר תגית"
                      disabled={busy}
                    />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{tag.asset_count} נכסים{tag.is_default ? " · ברירת מחדל" : ""}</span>
                    <Button size="icon" variant="outline" title="שמור תגית" onClick={() => void updateTag(tag)} disabled={busy}>
                      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      title={tag.is_default ? "לא ניתן למחוק תגית ברירת מחדל" : tag.asset_count > 0 ? "העבר נכסים לפני מחיקת התגית" : "מחק תגית"}
                      onClick={() => setTagToDelete(tag)}
                      disabled={busy || tag.is_default || tag.asset_count > 0}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && <div className="py-10 text-center text-sm text-muted-foreground">טעינת המדיה נכשלה</div>}
        {!isLoading && !isError && assets.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">אין מדיה לדמות זו</div>
        )}
        {!isLoading && filteredAssets.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredAssets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                busy={busyAssetId === asset.id}
                tags={tags}
                onAssignTag={(tagId) => void assignAssetTag(asset, tagId)}
                onDisable={() => void runAssetAction(asset, "disable")}
                onRestore={() => void runAssetAction(asset, "restore")}
                onRetry={() => void runAssetAction(asset, "retry")}
                onPrepareLocked={() => {
                  setBusyAssetId(asset.id);
                  void processAsset(asset.id, "locked")
                    .then(refresh)
                    .then(() => toast.success("נגזרות נעולות הוכנו"))
                    .catch(() => toast.error("לא ניתן להכין נגזרות נעולות"))
                    .finally(() => setBusyAssetId(null));
                }}
                onConfigureLocked={(priceCredits) => void configureLocked(asset.id, priceCredits)}
                onConfigurePaidOpen={(priceCredits) => void configurePaidOpen(asset.id, priceCredits)}
                onHardDelete={() => setAssetToHardDelete(asset)}
              />
            ))}
          </div>
        )}
        {!isLoading && assets.length > 0 && selectedTagId !== "all" && filteredAssets.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">אין נכסים בתגית שנבחרה.</div>
        )}
      </DialogContent>
      <AlertDialog open={tagToDelete !== null} onOpenChange={(open) => !open && setTagToDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק תגית מדיה?</AlertDialogTitle>
            <AlertDialogDescription>
              התגית "{tagToDelete?.name}" תימחק רק אם אין לה נכסים משויכים.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteTag()}>מחק תגית</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={assetToHardDelete !== null} onOpenChange={(open) => !open && setAssetToHardDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת מדיה מוחלטת</AlertDialogTitle>
            <AlertDialogDescription>
              המדיה וכל הנגזרות שלה יימחקו לצמיתות. הפעולה זמינה רק כאשר המדיה לא נשלחה ולא נמצאת בשימוש, ולא ניתן לשחזר אותה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyAssetId)}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void hardDeleteAsset()}
              disabled={Boolean(busyAssetId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyAssetId ? "מוחק..." : "מחק לצמיתות"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
