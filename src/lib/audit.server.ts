import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function logAudit(
  actorUserId: string,
  action: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      actor_user_id: actorUserId,
      action,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      metadata: (metadata as never) ?? {},
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}
