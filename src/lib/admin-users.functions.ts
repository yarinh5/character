import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";

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

async function setSingleRole(userId: string, role: AppRole) {
  await supabaseAdmin.from("user_roles").delete().eq("user_id", userId);
  const { error } = await supabaseAdmin.from("user_roles").insert({ user_id: userId, role });
  if (error) throw new Error(error.message);
}

async function ensureClientProfile(userId: string) {
  const { data } = await supabaseAdmin
    .from("client_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    const { error } = await supabaseAdmin.from("client_profiles").insert({ user_id: userId });
    if (error) throw new Error(error.message);
  }
}

async function ensureOperatorRecord(userId: string, fallbackName: string) {
  const { data: existing } = await supabaseAdmin
    .from("operators")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) {
    const { error } = await supabaseAdmin.from("operators").insert({
      user_id: userId,
      full_name: fallbackName,
      is_active: true,
      availability_status: "available",
    });
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabaseAdmin
    .from("operators")
    .update({ is_active: true, availability_status: "available" })
    .eq("id", existing.id);
  if (error) throw new Error(error.message);
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

    const ids = (profiles ?? []).map((profile) => profile.user_id);
    const { data: roles } = ids.length
      ? await supabaseAdmin.from("user_roles").select("user_id, role").in("user_id", ids)
      : { data: [] as { user_id: string; role: AppRole }[] };

    const order: Record<AppRole, number> = { admin: 1, operator: 2, client: 3 };
    const roleByUser = new Map<string, AppRole>();
    for (const row of roles ?? []) {
      const current = roleByUser.get(row.user_id);
      if (!current || order[row.role as AppRole] < order[current]) {
        roleByUser.set(row.user_id, row.role as AppRole);
      }
    }

    return (profiles ?? []).map((profile) => ({
      user_id: profile.user_id,
      email: profile.email,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      status: profile.status,
      created_at: profile.created_at,
      role: (roleByUser.get(profile.user_id) ?? "client") as AppRole,
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
    if (error || !created.user) throw new Error(error?.message ?? "יצירת משתמש נכשלה");

    const userId = created.user.id;

    await supabaseAdmin
      .from("profiles")
      .update({ display_name: data.full_name })
      .eq("user_id", userId);

    await setSingleRole(userId, data.role);

    if (data.role === "operator") {
      await ensureOperatorRecord(userId, data.full_name);
    }
    if (data.role === "client") {
      await ensureClientProfile(userId);
    }

    await logAudit(context.userId, "user.created", "user", userId, { role: data.role, email: data.email });

    return { user_id: userId };
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
      if (data.user_id === context.userId) {
        throw new Error("לא ניתן לשנות את התפקיד של עצמך מכאן");
      }

      await setSingleRole(data.user_id, data.role);

      if (data.role === "operator") {
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("display_name, email")
          .eq("user_id", data.user_id)
          .maybeSingle();
        await ensureOperatorRecord(data.user_id, profile?.display_name ?? profile?.email ?? "עובד");
      }

      if (data.role === "client") {
        const { error } = await supabaseAdmin
          .from("operators")
          .update({ is_active: false, availability_status: "offline" })
          .eq("user_id", data.user_id);
        if (error) throw new Error(error.message);
        await ensureClientProfile(data.user_id);
      }

      await logAudit(context.userId, "user.role_changed", "user", data.user_id, { role: data.role });
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
    await logAudit(context.userId, "user.password_reset", "user", data.user_id);
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
    await logAudit(context.userId, "user.status_changed", "user", data.user_id, { status: data.status });
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
    const { data: profile } = await supabaseAdmin
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
        email: profile?.email ? `${tag}` : tag,
      })
      .eq("user_id", data.user_id);
    await supabaseAdmin
      .from("operators")
      .update({ is_active: false, availability_status: "offline" })
      .eq("user_id", data.user_id);
    await logAudit(context.userId, "user.soft_deleted", "user", data.user_id);
    return { ok: true };
  });
