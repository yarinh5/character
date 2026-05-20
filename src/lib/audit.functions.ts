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
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    let q = supabaseAdmin
      .from("audit_logs")
      .select("id, actor_user_id, action, entity_type, entity_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.action) q = q.eq("action", data.action);
    const { data: logs, error } = await q;
    if (error) throw new Error(error.message);

    const ids = Array.from(new Set((logs ?? []).map((l) => l.actor_user_id).filter(Boolean))) as string[];
    const { data: profiles } = ids.length
      ? await supabaseAdmin.from("profiles").select("user_id, email, display_name").in("user_id", ids)
      : { data: [] as { user_id: string; email: string | null; display_name: string | null }[] };
    const byUser = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);

    return (logs ?? []).map((l) => ({
      ...l,
      actor: l.actor_user_id ? byUser.get(l.actor_user_id) ?? null : null,
    }));
  });
