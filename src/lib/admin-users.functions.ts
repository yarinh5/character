import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
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

async function ensureNotAdminTarget(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) throw new Error("admin_account_requires_separate_deprovisioning");
}

async function setSingleRole(supabase: SupabaseClient<Database>, userId: string, role: AppRole) {
  const { data, error } = await supabase.rpc("admin_set_user_role", {
    _user_id: userId,
    _new_role: role,
  });
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("role_change_not_confirmed");
}

async function setAuthBan(userId: string, blocked: boolean) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: blocked ? "876000h" : "none",
  });
  if (error) throw new Error(error.message);
}

async function ensureReactivatable(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("deleted_at, pii_archived_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("משתמש לא נמצא");
  if (data.deleted_at || data.pii_archived_at)
    throw new Error("archived_user_cannot_be_reactivated");
  const { data: deletion, error: deletionError } = await supabaseAdmin
    .from("account_deletion_requests")
    .select("id")
    .eq("user_id", userId)
    .not("confirmed_at", "is", null)
    .is("cancelled_at", null)
    .limit(1)
    .maybeSingle();
  if (deletionError) throw new Error(deletionError.message);
  if (deletion) throw new Error("confirmed_deletion_cannot_be_reactivated");
}

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        search: z.string().trim().max(120).default(""),
        role: z.enum(["all", "admin", "operator", "client"]).default("all"),
        status: z.enum(["all", "active", "blocked"]).default("all"),
        before_created_at: z.string().datetime({ offset: true }).nullable().default(null),
        before_user_id: z.string().uuid().nullable().default(null),
        page_size: z.number().int().min(1).max(101).default(101),
      })
      .refine((value) => (value.before_created_at === null) === (value.before_user_id === null), {
        message: "invalid_user_cursor",
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: rows, error } = await context.supabase.rpc("admin_list_users_page", {
      _search: data.search,
      _role: data.role,
      _status: data.status,
      _before_created_at: data.before_created_at,
      _before_user_id: data.before_user_id,
      _page_size: data.page_size,
    });
    if (error) throw new Error(error.message);
    if (!Array.isArray(rows) || rows.length > data.page_size) {
      throw new Error("invalid_user_directory_page");
    }
    return rows;
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
      app_metadata: { registration_origin: "admin_provisioned" },
    });
    if (error || !created.user) throw new Error(error?.message ?? "יצירת משתמש נכשלה");

    const userId = created.user.id;

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ display_name: data.full_name })
      .eq("user_id", userId);
    if (profileError) throw new Error(profileError.message);

    await setSingleRole(context.supabase, userId, data.role);

    await logAudit(context.userId, "user.created", "user", userId, {
      role: data.role,
      email: data.email,
    });

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

    if (data.role && data.user_id === context.userId) {
      throw new Error("לא ניתן לשנות את התפקיד של עצמך מכאן");
    }
    if (data.status && data.user_id === context.userId) {
      throw new Error("לא ניתן לשנות את הסטטוס של עצמך מכאן");
    }
    if (data.status) await ensureNotAdminTarget(data.user_id);
    if (data.status === "active") await ensureReactivatable(data.user_id);

    if (data.status === "blocked") await setAuthBan(data.user_id, true);

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
      await setSingleRole(context.supabase, data.user_id, data.role);
    }
    if (data.status === "active") await setAuthBan(data.user_id, false);

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
    if (data.user_id === context.userId) {
      throw new Error("לא ניתן לשנות את הסטטוס של עצמך מכאן");
    }
    await ensureNotAdminTarget(data.user_id);
    if (data.status === "active") await ensureReactivatable(data.user_id);
    if (data.status === "blocked") await setAuthBan(data.user_id, true);
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ status: data.status })
      .eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    if (data.status === "active") await setAuthBan(data.user_id, false);
    await logAudit(context.userId, "user.status_changed", "user", data.user_id, {
      status: data.status,
    });
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
    await ensureNotAdminTarget(data.user_id);
    const { data: profile, error: lookupError } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("user_id", data.user_id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (!profile) throw new Error("משתמש לא נמצא");
    await setAuthBan(data.user_id, true);
    const deletedAt = new Date().toISOString();
    const tag = `deleted+${Date.now()}@deleted.local`;
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        status: "blocked",
        deleted_at: deletedAt,
        display_name: "משתמש מחוק",
        email: tag,
      })
      .eq("user_id", data.user_id);
    if (profileError) throw new Error(profileError.message);
    const { error: operatorError } = await supabaseAdmin
      .from("operators")
      .update({ is_active: false, availability_status: "offline", deleted_at: deletedAt })
      .eq("user_id", data.user_id);
    if (operatorError) throw new Error(operatorError.message);
    await logAudit(context.userId, "user.soft_deleted", "user", data.user_id);
    return { ok: true };
  });
