import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Upload, X } from "lucide-react";

type Props = {
  bucket: "character-avatars" | "user-avatars";
  folder?: string; // for user-avatars must be the user_id
  value: string | null;
  onChange: (url: string | null) => void;
  label?: string;
};

export function AvatarUpload({ bucket, folder, value, onChange, label = "תמונה" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast.error("הקובץ גדול מדי (מקסימום 5MB)");
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("יש לבחור קובץ תמונה");
      return;
    }
    setBusy(true);
    const ext = file.name.split(".").pop() ?? "jpg";
    const path = `${folder ? folder + "/" : ""}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, {
      upsert: false,
      cacheControl: "3600",
    });
    if (error) {
      toast.error("העלאה נכשלה: " + error.message);
      setBusy(false);
      return;
    }
    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    onChange(pub.publicUrl);
    setBusy(false);
    toast.success("התמונה הועלתה");
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-3">
        <div className="h-20 w-20 rounded-full bg-muted overflow-hidden shrink-0 border">
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              <Upload className="h-6 w-6" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 flex-1">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <Upload className="h-4 w-4 ml-1" />
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
                <X className="h-4 w-4 ml-1" />
                הסר
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG/JPG, עד 5MB</p>
        </div>
      </div>
    </div>
  );
}
