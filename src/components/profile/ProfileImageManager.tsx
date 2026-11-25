import { ArrowDown, ArrowUp, Check, Star, Trash2 } from "lucide-react";
import { AvatarUpload } from "@/components/common/AvatarUpload";
import { Button } from "@/components/ui/button";

const PROFILE_IMAGE_LIMIT = 6;

type Props = {
  userId: string;
  images: string[];
  primary: string | null;
  onChange: (images: string[], primary: string | null) => void;
  disabled?: boolean;
};

export function ProfileImageManager({
  userId,
  images,
  primary,
  onChange,
  disabled = false,
}: Props) {
  const addImage = (url: string | null) => {
    if (!url || disabled || images.length >= PROFILE_IMAGE_LIMIT || images.includes(url)) return;
    const next = [...images, url];
    onChange(next, primary ?? url);
  };

  const removeImage = (index: number) => {
    if (disabled) return;
    const removed = images[index];
    const next = images.filter((_, imageIndex) => imageIndex !== index);
    const nextPrimary = removed === primary ? (next[index] ?? next[index - 1] ?? null) : primary;
    onChange(next, nextPrimary);
  };

  const moveImage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (disabled || target < 0 || target >= images.length) return;
    const next = [...images];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next, primary);
  };

  const atLimit = images.length >= PROFILE_IMAGE_LIMIT;

  return (
    <section className="space-y-4" aria-labelledby="profile-images-heading">
      <div>
        <h3 id="profile-images-heading" className="text-sm font-medium">
          תמונות פרופיל
        </h3>
        <p className="text-xs text-muted-foreground">
          עד {PROFILE_IMAGE_LIMIT} תמונות. ניתן לבחור ראשית ולשנות סדר גם באמצעות המקלדת.
        </p>
      </div>

      {images.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          עדיין לא נוספו תמונות פרופיל.
        </p>
      ) : (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image, index) => {
            const isPrimary = image === primary;
            return (
              <li key={image} className="space-y-2 rounded-lg border p-2">
                <div className="relative aspect-square overflow-hidden rounded-md bg-muted">
                  <img
                    src={image}
                    alt={`תמונת פרופיל ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                  {isPrimary && (
                    <span className="absolute end-1 top-1 inline-flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-xs">
                      <Star className="h-3 w-3" aria-hidden="true" /> ראשית
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`הזז תמונה ${index + 1} למעלה`}
                    onClick={() => moveImage(index, -1)}
                    disabled={disabled || index === 0}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`הזז תמונה ${index + 1} למטה`}
                    onClick={() => moveImage(index, 1)}
                    disabled={disabled || index === images.length - 1}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`הגדר תמונה ${index + 1} כראשית`}
                    onClick={() => onChange(images, image)}
                    disabled={disabled || isPrimary}
                  >
                    {isPrimary ? (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Star className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`הסר תמונה ${index + 1}`}
                    onClick={() => removeImage(index)}
                    disabled={disabled}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <AvatarUpload
        bucket="user-avatars"
        folder={userId}
        value={null}
        onChange={addImage}
        label={atLimit ? "הגעת למגבלת התמונות" : "הוספת תמונה"}
        disabled={disabled || atLimit}
      />
      {images.length > PROFILE_IMAGE_LIMIT && (
        <p role="status" className="text-xs text-muted-foreground">
          זהו פרופיל legacy עם יותר משש תמונות. אפשר לסדר או להסיר תמונות, אך לא להוסיף חדשות.
        </p>
      )}
    </section>
  );
}

export { PROFILE_IMAGE_LIMIT };
