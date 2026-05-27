type ChatAvatarProps = {
  src?: string | null;
  name?: string | null;
  className?: string;
};

export function ChatAvatar({ src, name, className = "" }: ChatAvatarProps) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();

  return (
    <div
      className={`h-8 w-8 shrink-0 overflow-hidden rounded-full border bg-muted text-xs font-semibold text-muted-foreground ${className}`}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">{initial}</div>
      )}
    </div>
  );
}
