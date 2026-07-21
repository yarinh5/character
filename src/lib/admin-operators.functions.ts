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

async function syncAssignments(operatorId: string, characterIds: string[]) {
  const { data: currentRows, error: currentError } = await supabaseAdmin
    .from("character_operator_assignments")
    .select("character_id")
    .eq("operator_id", operatorId);
  if (currentError) throw new Error(currentError.message);

  const current = new Set((currentRows ?? []).map((row) => row.character_id));
  const next = new Set(characterIds);
  const toRemove = [...current].filter((id) => !next.has(id));
  const toAdd = [...next].filter((id) => !current.has(id));

  if (toRemove.length) {
    const { error } = await supabaseAdmin
      .from("character_operator_assignments")
      .delete()
      .eq("operator_id", operatorId)
      .in("character_id", toRemove);
    if (error) throw new Error(error.message);
  }

  if (toAdd.length) {
    const { error } = await supabaseAdmin
      .from("character_operator_assignments")
      .insert(toAdd.map((character_id) => ({ operator_id: operatorId, character_id })));
    if (error) throw new Error(error.message);
  }
}

async function getOperatorAdminContext(operatorId: string) {
  const { data: operator, error } = await supabaseAdmin
    .from("operators")
    .select("id, user_id")
    .eq("id", operatorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!operator) throw new Error("עובד לא נמצא");

  const { data: roles, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", operator.user_id);
  if (rolesError) throw new Error(rolesError.message);

  return {
    operator,
    isAdminUser: (roles ?? []).some((row) => row.role === "admin"),
  };
}

export const adminListOperators = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        show_archived_only: z.boolean().default(false),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    let query = supabaseAdmin
      .from("operators")
      .select("id, user_id, full_name, is_active, availability_status, created_at, deleted_at")
      .order("created_at", { ascending: false });

    if (data.show_archived_only) {
      query = query.not("deleted_at", "is", null);
    } else {
      query = query.is("deleted_at", null);
    }

    const { data: ops, error } = await query;
    if (error) throw new Error(error.message);

    const opsList = ops ?? [];
    const ids = opsList.map((operator) => operator.id);
    const userIds = opsList.map((operator) => operator.user_id);

    const [{ data: roles }, { data: assigns }, { data: convs }, { data: profs }, { data: wallets }] = await Promise.all([
      userIds.length
        ? supabaseAdmin.from("user_roles").select("user_id, role").in("user_id", userIds)
        : Promise.resolve({ data: [] as { user_id: string; role: AppRole }[] }),
      ids.length
        ? supabaseAdmin.from("character_operator_assignments").select("operator_id").in("operator_id", ids)
        : Promise.resolve({ data: [] as { operator_id: string }[] }),
      ids.length
        ? supabaseAdmin.from("conversations").select("assigned_operator_id, status").in("assigned_operator_id", ids)
        : Promise.resolve({ data: [] as { assigned_operator_id: string | null; status: string }[] }),
      userIds.length
        ? supabaseAdmin.from("profiles").select("user_id, email").in("user_id", userIds)
        : Promise.resolve({ data: [] as { user_id: string; email: string | null }[] }),
      userIds.length
        ? supabaseAdmin.from("credit_wallets").select("user_id, balance").in("user_id", userIds)
        : Promise.resolve({ data: [] as { user_id: string; balance: number }[] }),
    ]);

    const rolesByUser = new Map<string, Set<AppRole>>();
    (roles ?? []).forEach((row) => {
      const set = rolesByUser.get(row.user_id) ?? new Set<AppRole>();
      set.add(row.role as AppRole);
      rolesByUser.set(row.user_id, set);
    });

    const charsCount = new Map<string, number>();
    (assigns ?? []).forEach((row) => charsCount.set(row.operator_id, (charsCount.get(row.operator_id) ?? 0) + 1));

    const activeCount = new Map<string, number>();
    (convs ?? []).forEach((row) => {
      if (row.status !== "closed" && row.assigned_operator_id) {
        activeCount.set(row.assigned_operator_id, (activeCount.get(row.assigned_operator_id) ?? 0) + 1);
      }
    });

    const emailMap = new Map<string, string | null>();
    (profs ?? []).forEach((row) => emailMap.set(row.user_id, row.email));
    const walletMap = new Map<string, number>();
    (wallets ?? []).forEach((row) => walletMap.set(row.user_id, row.balance));

    return opsList
      .filter((operator) => {
        const roles = rolesByUser.get(operator.user_id);
        return roles?.has("operator") || roles?.has("admin");
      })
      .map((operator) => ({
        ...operator,
        email: emailMap.get(operator.user_id) ?? null,
        role: rolesByUser.get(operator.user_id)?.has("admin") ? "admin" : "operator",
        chars: charsCount.get(operator.id) ?? 0,
        active: activeCount.get(operator.id) ?? 0,
        credit_balance: walletMap.get(operator.user_id) ?? 0,
      }));
  });

export const adminCreateOperatorUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(128),
        full_name: z.string().trim().min(1).max(120),
        is_active: z.boolean().default(true),
        character_ids: z.array(z.string().uuid()).max(50).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email.toLowerCase(),
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.full_name },
    });
    if (error || !created.user) throw new Error(error?.message ?? "יצירת משתמש נכשלה");

    const userId = created.user.id;
    await supabaseAdmin.from("profiles").update({ display_name: data.full_name }).eq("user_id", userId);
    await setSingleRole(userId, "operator");

    const { data: operator, error: opError } = await supabaseAdmin
      .from("operators")
      .insert({
        user_id: userId,
        full_name: data.full_name,
        is_active: data.is_active,
        availability_status: data.is_active ? "available" : "offline",
      })
      .select("id")
      .single();
    if (opError) throw new Error(opError.message);

    await syncAssignments(operator.id, data.character_ids);
    await logAudit(context.userId, "operator.created", "operator", operator.id, {
      user_id: userId,
      email: data.email,
      character_count: data.character_ids.length,
    });

    return { user_id: userId, operator_id: operator.id };
  });

export const adminPromoteClientToOperator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email().max(255),
        full_name: z.string().trim().min(1).max(120),
        is_active: z.boolean().default(true),
        character_ids: z.array(z.string().uuid()).max(50).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .eq("email", data.email.toLowerCase())
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile) throw new Error("לא נמצא משתמש רשום עם האימייל הזה");
    if (profile.user_id === context.userId) throw new Error("לא ניתן לשנות את התפקיד של עצמך מכאן");

    await supabaseAdmin.from("profiles").update({ display_name: data.full_name }).eq("user_id", profile.user_id);
    await setSingleRole(profile.user_id, "operator");

    const { data: existing } = await supabaseAdmin
      .from("operators")
      .select("id")
      .eq("user_id", profile.user_id)
      .maybeSingle();

    let operatorId = existing?.id;
    if (operatorId) {
      const { error } = await supabaseAdmin
        .from("operators")
        .update({
          full_name: data.full_name,
          is_active: data.is_active,
          availability_status: data.is_active ? "available" : "offline",
          deleted_at: null,
        })
        .eq("id", operatorId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await supabaseAdmin
        .from("operators")
        .insert({
          user_id: profile.user_id,
          full_name: data.full_name,
          is_active: data.is_active,
          availability_status: data.is_active ? "available" : "offline",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      operatorId = created.id;
    }

    await syncAssignments(operatorId!, data.character_ids);
    await logAudit(context.userId, "user.promoted_to_operator", "user", profile.user_id, {
      operator_id: operatorId,
      email: data.email,
      character_count: data.character_ids.length,
    });

    return { user_id: profile.user_id, operator_id: operatorId };
  });

export const adminUpdateOperator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        operator_id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(120),
        is_active: z.boolean(),
        availability_status: z.enum(["available", "busy", "offline"]),
        character_ids: z.array(z.string().uuid()).max(50).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { operator, isAdminUser } = await getOperatorAdminContext(data.operator_id);
    if (!data.is_active && (operator.user_id === context.userId || isAdminUser)) {
      throw new Error("לא ניתן להשבית חשבון אדמין");
    }

    const { error } = await supabaseAdmin
      .from("operators")
      .update({
        full_name: data.full_name,
        is_active: data.is_active,
        availability_status: data.is_active ? data.availability_status : "offline",
      })
      .eq("id", data.operator_id);
    if (error) throw new Error(error.message);

    if (data.character_ids) {
      await syncAssignments(data.operator_id, data.character_ids);
    }

    await logAudit(context.userId, "operator.updated", "operator", data.operator_id, {
      is_active: data.is_active,
      availability_status: data.availability_status,
      character_count: data.character_ids?.length,
    });

    return { ok: true };
  });

export const adminConvertOperatorToClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ operator_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { operator, isAdminUser } = await getOperatorAdminContext(data.operator_id);
    if (operator.user_id === context.userId) throw new Error("לא ניתן לשנות את התפקיד של עצמך מכאן");
    if (isAdminUser) throw new Error("לא ניתן להפוך אדמין ללקוח מעמוד העובדים");

    await setSingleRole(operator.user_id, "client");
    await supabaseAdmin
      .from("operators")
      .update({ is_active: false, availability_status: "offline" })
      .eq("id", operator.id);

    const { data: clientProfile } = await supabaseAdmin
      .from("client_profiles")
      .select("id")
      .eq("user_id", operator.user_id)
      .maybeSingle();
    if (!clientProfile) {
      await supabaseAdmin.from("client_profiles").insert({ user_id: operator.user_id });
    }

    await logAudit(context.userId, "user.converted_to_client", "user", operator.user_id, {
      operator_id: operator.id,
    });

    return { ok: true };
  });

export const adminArchiveOperator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ operator_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { operator, isAdminUser } = await getOperatorAdminContext(data.operator_id);
    if (operator.user_id === context.userId) throw new Error("לא ניתן למחוק את רשומת העובד של עצמך מכאן");
    if (isAdminUser) throw new Error("לא ניתן למחוק או לארכב חשבון אדמין");

    const { error } = await supabaseAdmin
      .from("operators")
      .update({
        is_active: false,
        availability_status: "offline",
        deleted_at: new Date().toISOString(),
      })
      .eq("id", operator.id);
    if (error) throw new Error(error.message);

    await logAudit(context.userId, "operator.archived", "operator", operator.id, {
      user_id: operator.user_id,
    });

    return { ok: true };
  });

export const adminRestoreOperator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ operator_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { operator } = await getOperatorAdminContext(data.operator_id);

    const { error } = await supabaseAdmin
      .from("operators")
      .update({
        deleted_at: null,
        is_active: false,
        availability_status: "offline",
      })
      .eq("id", operator.id);
    if (error) throw new Error(error.message);

    await logAudit(context.userId, "operator.restored", "operator", operator.id, {
      user_id: operator.user_id,
      restored_as_active: false,
    });

    return { ok: true };
  });
