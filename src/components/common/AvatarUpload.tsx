import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Upload, X } from "lucide-react";

type Props = {
  bucket: "character-avatars" | "user-avatars";
  folder?: string; // for user-avatars must be the user_id
  value: string | null;
  onChange: (url: string | null) => void;
  label?: string;
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const OUTPUT_SIZE = 512;

export function AvatarUpload({ bucket, folder, value, onChange, label = "תמונה" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [busy, setBusy] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const clearSelection = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    setZoom(1);
    setCropOpen(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFile = (file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error("אפשר להעלות רק קובץ JPG, PNG או WebP");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      toast.error("הקובץ גדול מדי. ניתן להעלות תמונה עד 5MB");
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setZoom(1);
    setCropOpen(true);
  };

  const buildCroppedBlob = async () => {
    const image = imageRef.current;
    if (!image) throw new Error("image_not_loaded");

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas_not_supported");

    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    const baseSize = Math.min(naturalWidth, naturalHeight);
    const sourceSize = Math.max(1, baseSize / zoom);
    const sx = Math.max(0, (naturalWidth - sourceSize) / 2);
    const sy = Math.max(0, (naturalHeight - sourceSize) / 2);

    ctx.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) reject(new Error("crop_failed"));
          else resolve(blob);
        },
        "image/webp",
        0.9,
      );
    });
  };

  const uploadCroppedImage = async () => {
    if (!selectedFile || !previewUrl) return;
    setBusy(true);
    try {
      const blob = await buildCroppedBlob();
      const path = `${folder ? `${folder}/` : ""}avatar-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.webp`;

      const { error } = await supabase.storage.from(bucket).upload(path, blob, {
        upsert: false,
        cacheControl: "3600",
        contentType: "image/webp",
      });
      if (error) throw error;

      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      onChange(pub.publicUrl);
      toast.success("התמונה הועלתה");
      clearSelection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      toast.error(`העלאת התמונה נכשלה: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border bg-muted">
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Upload className="h-6 w-6" />
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <Upload className="ml-1 h-4 w-4" />
              {busy ? "מעלה..." : "העלה תמונה"}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(null)}
                disabled={busy}
              >
                <X className="ml-1 h-4 w-4" />
                הסר
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">JPG, PNG או WebP עד 5MB. התמונה תיחתך ביחס 1:1.</p>
        </div>
      </div>

      <Dialog open={cropOpen} onOpenChange={(open) => (open ? setCropOpen(true) : clearSelection())}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>חיתוך תמונת פרופיל</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-full border bg-muted shadow-inner">
              {previewUrl && (
                <img
                  ref={imageRef}
                  src={previewUrl}
                  alt="תצוגה מקדימה"
                  className="h-full w-full object-cover"
                  style={{ transform: `scale(${zoom})` }}
                />
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>זום</span>
                <span>{Math.round(zoom * 100)}%</span>
              </div>
              <input
                type="range"
                min="1"
                max="3"
                step="0.05"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="w-full accent-primary"
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              התמונה תישמר כ־avatar מרובע/עגול ותוצג בפרופיל ובצ׳אט לאחר שמירת הפרופיל.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" variant="outline" onClick={clearSelection} disabled={busy}>
              ביטול
            </Button>
            <Button type="button" onClick={uploadCroppedImage} disabled={busy}>
              {busy ? "שומר..." : "שמור תמונה"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
