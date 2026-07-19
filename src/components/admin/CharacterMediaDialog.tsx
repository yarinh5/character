import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle, LockKeyhole, RefreshCw, RotateCcw, ShieldOff } from "lucide-react";
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

type MediaAsset = Database["public"]["Functions"]["get_admin_character_media_assets"]["Returns"][number];

type UploadIntentResponse = {
  asset_id?: unknown;
  upload_url?: unknown;
  expires_at?: unknown;
};

const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

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
}: {
  asset: MediaAsset;
  busy: boolean;
  onDisable: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onPrepareLocked: () => void;
  onConfigureLocked: (priceCredits: number | null) => void;
}) {
  const [price, setPrice] = useState(asset.locked_price_credits?.toString() ?? "");
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
  const queryKey = ["admin-character-media", character.id] as const;
  const { data: assets = [], isLoading, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_character_media_assets", { _character_id: character.id });
      if (error) throw error;
      return data;
    },
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
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

        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && <div className="py-10 text-center text-sm text-muted-foreground">טעינת המדיה נכשלה</div>}
        {!isLoading && !isError && assets.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">אין מדיה לדמות זו</div>
        )}
        {!isLoading && assets.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                busy={busyAssetId === asset.id}
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
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
