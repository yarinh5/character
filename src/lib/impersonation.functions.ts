import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";

async function ensureAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("אין הרשאת מנהל");
}

export const adminImpersonate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("לא ניתן להתחזות לעצמך");
    }
    const { data: target } = await supabaseAdmin
      .from("profiles")
      .select("email, display_name")
      .eq("user_id", data.user_id)
      .maybeSingle();
    if (!target?.email) throw new Error("המשתמש לא נמצא");

    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: target.email,
    });
    if (error || !link?.properties?.action_link) {
      throw new Error(error?.message ?? "יצירת קישור נכשלה");
    }

    await logAudit(context.userId, "user.impersonated", "user", data.user_id, {
      email: target.email,
    });

    return {
      action_link: link.properties.action_link,
      email: target.email,
      display_name: target.display_name,
    };
  });

export const adminSendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: target } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("user_id", data.user_id)
      .maybeSingle();
    if (!target?.email) throw new Error("המשתמש לא נמצא");

    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: target.email,
    });
    if (error) throw new Error(error.message);

    await logAudit(context.userId, "user.password_reset_sent", "user", data.user_id, {
      email: target.email,
    });

    return {
      ok: true,
      email: target.email,
      action_link: link?.properties?.action_link ?? null,
    };
  });
