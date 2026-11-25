import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function ensureAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("אין הרשאת מנהל");
}

export const adminListAuditLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        limit: z.number().min(1).max(500).default(200),
        action: z.string().optional(),
        cursor: z
          .object({
            createdAt: z.string().datetime({ offset: true }),
            id: z.string().uuid(),
          })
          .optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    let q = supabaseAdmin
      .from("audit_logs")
      .select("id, actor_user_id, action, entity_type, entity_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(data.limit + 1);
    if (data.action) q = q.eq("action", data.action);
    if (data.cursor) {
      q = q.or(
        `created_at.lt.${data.cursor.createdAt},and(created_at.eq.${data.cursor.createdAt},id.lt.${data.cursor.id})`,
      );
    }
    const { data: logs, error } = await q;
    if (error) throw new Error(error.message);

    const page = (logs ?? []).slice(0, data.limit);
    const ids = Array.from(new Set(page.map((l) => l.actor_user_id).filter(Boolean))) as string[];
    const { data: profiles, error: profileError } = ids.length
      ? await supabaseAdmin
          .from("profiles")
          .select("user_id, email, display_name")
          .in("user_id", ids)
      : {
          data: [] as { user_id: string; email: string | null; display_name: string | null }[],
          error: null,
        };
    if (profileError) throw new Error(profileError.message);
    const byUser = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);

    const items = page.map((l) => ({
      ...l,
      actor: l.actor_user_id ? (byUser.get(l.actor_user_id) ?? null) : null,
    }));
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        logs !== null && logs.length > data.limit && last
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  });
