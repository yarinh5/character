import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AppRole = "admin" | "operator" | "client";

async function ensureAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error("בדיקת הרשאה נכשלה");
  if (!data) throw new Error("אין הרשאת מנהל");
}

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);

    const { data: profiles, error } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email, display_name, avatar_url, status, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = (profiles ?? []).map((p) => p.user_id);
    const { data: roles } = ids.length
      ? await supabaseAdmin.from("user_roles").select("user_id, role").in("user_id", ids)
      : { data: [] as { user_id: string; role: AppRole }[] };

    const order: Record<AppRole, number> = { admin: 1, operator: 2, client: 3 };
    const roleByUser = new Map<string, AppRole>();
    for (const r of roles ?? []) {
      const cur = roleByUser.get(r.user_id);
      if (!cur || order[r.role as AppRole] < order[cur]) {
        roleByUser.set(r.user_id, r.role as AppRole);
      }
    }

    return (profiles ?? []).map((p) => ({
      user_id: p.user_id,
      email: p.email,
      display_name: p.display_name,
      avatar_url: p.avatar_url,
      status: p.status,
      created_at: p.created_at,
      role: (roleByUser.get(p.user_id) ?? "client") as AppRole,
    }));
  });

const RoleEnum = z.enum(["admin", "operator", "client"]);

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(128),
        full_name: z.string().trim().min(1).max(120),
        role: RoleEnum,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.full_name },
    });
    if (error || !created.user) throw new Error(error?.message ?? "יצירה נכשלה");

    const uid = created.user.id;

    await supabaseAdmin
      .from("profiles")
      .update({ display_name: data.full_name })
      .eq("user_id", uid);

    if (data.role !== "client") {
      await supabaseAdmin.from("user_roles").delete().eq("user_id", uid).eq("role", "client");
      await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: uid, role: data.role }, { onConflict: "user_id,role" });
    }

    if (data.role === "operator") {
      const { data: existing } = await supabaseAdmin
        .from("operators")
        .select("id")
        .eq("user_id", uid)
        .maybeSingle();
      if (!existing) {
        await supabaseAdmin.from("operators").insert({ user_id: uid, full_name: data.full_name });
      }
    }

    return { user_id: uid };
  });

export const adminUpdateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        user_id: z.string().uuid(),
        display_name: z.string().trim().min(1).max(120).optional(),
        email: z.string().email().max(255).optional(),
        status: z.enum(["active", "blocked"]).optional(),
        role: RoleEnum.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    if (data.email) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
        email: data.email,
      });
      if (error) throw new Error(error.message);
    }

    const profileUpdate: {
      display_name?: string;
      email?: string;
      status?: string;
    } = {};
    if (data.display_name !== undefined) profileUpdate.display_name = data.display_name;
    if (data.email !== undefined) profileUpdate.email = data.email;
    if (data.status !== undefined) profileUpdate.status = data.status;
    if (Object.keys(profileUpdate).length) {
      const { error } = await supabaseAdmin
        .from("profiles")
        .update(profileUpdate)
        .eq("user_id", data.user_id);
      if (error) throw new Error(error.message);
    }

    if (data.role) {
      await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
      await supabaseAdmin.from("user_roles").insert({ user_id: data.user_id, role: data.role });

      if (data.role === "operator") {
        const { data: existing } = await supabaseAdmin
          .from("operators")
          .select("id")
          .eq("user_id", data.user_id)
          .maybeSingle();
        if (!existing) {
          const { data: prof } = await supabaseAdmin
            .from("profiles")
            .select("display_name, email")
            .eq("user_id", data.user_id)
            .maybeSingle();
          await supabaseAdmin.from("operators").insert({
            user_id: data.user_id,
            full_name: prof?.display_name ?? prof?.email ?? "עובד",
          });
        }
      }

      if (data.role === "client") {
        const { data: existing } = await supabaseAdmin
          .from("client_profiles")
          .select("id")
          .eq("user_id", data.user_id)
          .maybeSingle();
        if (!existing) {
          await supabaseAdmin.from("client_profiles").insert({ user_id: data.user_id });
        }
      }
    }

    return { ok: true };
  });

export const adminResetPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ user_id: z.string().uuid(), password: z.string().min(8).max(128) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminSetStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ user_id: z.string().uuid(), status: z.enum(["active", "blocked"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ status: data.status })
      .eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminSoftDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("לא ניתן למחוק את עצמך");
    }
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("user_id", data.user_id)
      .maybeSingle();
    const tag = `deleted+${Date.now()}@deleted.local`;
    await supabaseAdmin
      .from("profiles")
      .update({
        status: "blocked",
        display_name: "משתמש מחוק",
        email: prof?.email ? `${tag}` : tag,
      })
      .eq("user_id", data.user_id);
    await supabaseAdmin
      .from("operators")
      .update({ is_active: false, availability_status: "offline" })
      .eq("user_id", data.user_id);
    return { ok: true };
  });
