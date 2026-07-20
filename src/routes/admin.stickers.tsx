import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Power, RefreshCw, Sticker, Trash2 } from "lucide-react";
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

export const Route = createFileRoute("/admin/stickers")({
  component: AdminStickersPage,
});

type StickerRow = Database["public"]["Functions"]["get_admin_sticker_catalog"]["Returns"][number];
type UploadIntent = { sticker_id?: unknown; upload_url?: unknown };

const SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;
const MAX_RENDER_BYTES = 512 * 1024;
const MAX_RENDER_SIDE = 768;

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isSupportedStickerSource(file: File) {
  if (file.type === "image/webp" || file.type === "image/png" || file.type === "image/jpeg") {
    return true;
  }

  const name = file.name.toLowerCase();
  return name.endsWith(".webp") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

function canvasToWebp(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("render_conversion_failed"));
    }, "image/webp", quality);
  });
}

async function createRenderReadySticker(file: File) {
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
      const render = await canvasToWebp(canvas, quality);
      if (render.size <= MAX_RENDER_BYTES) {
        return new File([render], "sticker-render.webp", { type: "image/webp" });
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

function StickerPreview({ sticker }: { sticker: StickerRow }) {
  const preview = useMediaViewUrl(
    "admin_sticker_preview",
    sticker.ingest_status === "ready" ? sticker.id : undefined,
  );

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

function AdminStickersPage() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StickerRow | null>(null);
  const [collectionName, setCollectionName] = useState("");
  const [stickerName, setStickerName] = useState("");
  const [characterId, setCharacterId] = useState("global");

  const catalog = useQuery({
    queryKey: ["admin-stickers"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_sticker_catalog");
      if (error) throw error;
      return data as StickerRow[];
    },
  });
  const characters = useQuery({
    queryKey: ["admin-sticker-characters"],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("id, name").order("name");
      if (error) throw error;
      return data;
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-stickers"] });

  const upload = async (file: File) => {
    if (
      !isSupportedStickerSource(file) ||
      file.size < 1 ||
      file.size > SOURCE_LIMIT_BYTES ||
      !collectionName.trim() ||
      !stickerName.trim()
    ) {
      toast.error("Choose WebP, PNG, or JPEG up to 10 MB and enter names.");
      return;
    }

    setBusy(true);
    try {
      const render = await createRenderReadySticker(file);
      const { data, error } = await supabase.functions.invoke("admin-sticker-upload-intent", {
        body: {
          collection_slug: slug(collectionName),
          collection_name: collectionName.trim(),
          character_id: characterId === "global" ? null : characterId,
          sticker_slug: slug(stickerName),
          sticker_name: stickerName.trim(),
          content_type: "image/webp",
        },
      });
      const intent = (data ?? {}) as UploadIntent;
      if (error || typeof intent.sticker_id !== "string" || typeof intent.upload_url !== "string") {
        throw error ?? new Error("invalid_upload_intent");
      }

      const put = await fetch(intent.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", "x-upsert": "false" },
        body: render,
      });
      if (!put.ok) throw new Error("sticker_upload_failed");

      const { error: processError } = await supabase.functions.invoke("process-sticker-media", {
        body: { sticker_id: intent.sticker_id },
      });
      if (processError) throw processError;

      toast.success("Sticker is ready for activation.");
      setStickerName("");
    } catch (error) {
      toast.error("Sticker upload or processing failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      await refresh();
    }
  };

  const toggle = async (row: StickerRow) => {
    setBusy(true);
    const { error } = await supabase.rpc("set_sticker_active", {
      _sticker_id: row.id,
      _is_active: !row.is_active,
    });
    setBusy(false);

    if (error) {
      toast.error("Sticker state could not be updated.");
      return;
    }

    await refresh();
    toast.success("Sticker state updated.");
  };

  const retry = async (row: StickerRow) => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("process-sticker-media", {
        body: { sticker_id: row.id },
      });
      if (error) {
        const code = await functionErrorCode(error);
        throw new Error(code ?? "sticker_processing_failed");
      }
      toast.success("Sticker processing restarted.");
    } catch (error) {
      toast.error(error instanceof Error && error.message === "sticker_processing_in_progress" ? "Sticker is still processing." : "Sticker retry failed.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("delete-sticker-media", {
        body: { sticker_id: deleteTarget.id },
      });
      if (error) {
        const code = await functionErrorCode(error);
        throw new Error(code ?? "sticker_delete_not_available");
      }
      toast.success("Sticker deleted.");
      setDeleteTarget(null);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === "sticker_in_use"
          ? "Sticker is already in use and cannot be deleted."
          : error instanceof Error && error.message === "sticker_delete_not_available"
            ? "Sticker delete is not available until its secure backend is deployed."
            : "Sticker delete failed. Try again.",
      );
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8" dir="rtl">
      <PageHeader
        title="Sticker catalog"
        description="Admin-only QA ingest. Conversation stickers remain disabled."
      />
      <Card className="mb-6">
        <CardContent className="grid gap-3 p-4 md:grid-cols-4">
          <div>
            <Label>Collection</Label>
            <Input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} />
          </div>
          <div>
            <Label>Sticker</Label>
            <Input value={stickerName} onChange={(event) => setStickerName(event.target.value)} />
          </div>
          <div>
            <Label>Scope</Label>
            <Select value={characterId} onValueChange={setCharacterId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                {(characters.data ?? []).map((character) => (
                  <SelectItem key={character.id} value={character.id}>
                    {character.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <input
              ref={inputRef}
              type="file"
              accept=".webp,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button className="w-full" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              Upload Sticker
            </Button>
          </div>
          <p className="text-sm text-muted-foreground md:col-span-4">
            WebP, PNG, or JPEG up to 10 MB. Recommended: square image, 512×512 px or 768×768 px.
          </p>
        </CardContent>
      </Card>

      {catalog.isError && <p className="text-destructive">Catalog could not be loaded.</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(catalog.data ?? []).map((row) => (
          <Card key={row.id}>
            <StickerPreview sticker={row} />
            <CardContent className="space-y-2 p-3">
              <div className="font-medium truncate">{row.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {row.collection_name} - {row.character_id ? "Character" : "Global"}
              </div>
              <div className="text-xs">
                {row.ingest_status}
                {row.is_active ? " - active" : " - inactive"}
              </div>
              {row.is_processing_stuck && <div className="text-xs text-destructive">Processing stuck</div>}
              {row.deletion_started_at && <div className="text-xs text-destructive">Delete cleanup pending</div>}
              {row.failure_code && <div className="text-xs text-destructive">{row.failure_code}</div>}
              {(row.ingest_status === "failed" || row.is_processing_stuck) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={busy || Boolean(row.deletion_started_at)}
                  onClick={() => void retry(row)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={busy || row.ingest_status !== "ready" || Boolean(row.deletion_started_at)}
                onClick={() => void toggle(row)}
              >
                <Power className="h-3.5 w-3.5" />
                {row.is_active ? "Deactivate" : "Activate"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="w-full"
                disabled={busy}
                onClick={() => setDeleteTarget(row)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {!catalog.isLoading && (catalog.data?.length ?? 0) === 0 && (
        <div className="py-12 text-center text-muted-foreground">
          <Sticker className="mx-auto mb-2" />
          No QA stickers yet.
        </div>
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete sticker permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the sticker record and its private source and render files. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void remove()}
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
