import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
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

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export const adminListInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("invites")
      .select("id, email, full_name, character_ids, status, expires_at, accepted_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const adminCreateInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email().max(255),
        full_name: z.string().trim().min(1).max(120),
        character_ids: z.array(z.string().uuid()).max(50).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const token = randomBytes(24).toString("hex");
    const token_hash = hash(token);

    const { data: row, error } = await supabaseAdmin
      .from("invites")
      .insert({
        email: data.email.toLowerCase(),
        full_name: data.full_name,
        character_ids: data.character_ids,
        token_hash,
        invited_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await logAudit(context.userId, "invite.created", "invite", row.id, {
      email: data.email,
      character_count: data.character_ids.length,
    });

    return { id: row.id, token };
  });

export const adminRevokeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("invites")
      .update({ status: "revoked" })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    await logAudit(context.userId, "invite.revoked", "invite", data.id);
    return { ok: true };
  });

// Public: get invite info by token (for accept page)
export const getInviteByToken = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(10).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const token_hash = hash(data.token);
    const { data: row, error } = await supabaseAdmin
      .from("invites")
      .select("id, email, full_name, status, expires_at")
      .eq("token_hash", token_hash)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("הזמנה לא נמצאה");
    if (row.status !== "pending") throw new Error("הזמנה לא תקפה");
    if (new Date(row.expires_at) < new Date()) throw new Error("הזמנה פגה");
    return { email: row.email, full_name: row.full_name };
  });

// Public: accept invite (creates user + operator + assignments)
export const acceptInvite = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().min(10).max(200),
        password: z.string().min(8).max(128),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const token_hash = hash(data.token);
    const { data: invite, error } = await supabaseAdmin
      .from("invites")
      .select("*")
      .eq("token_hash", token_hash)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!invite) throw new Error("הזמנה לא נמצאה");
    if (invite.status !== "pending") throw new Error("הזמנה לא תקפה");
    if (new Date(invite.expires_at) < new Date()) {
      await supabaseAdmin.from("invites").update({ status: "expired" }).eq("id", invite.id);
      throw new Error("הזמנה פגה");
    }

    // Check existing user by email
    let userId: string | null = null;
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const existing = list?.users?.find((u) => u.email?.toLowerCase() === invite.email.toLowerCase());

    if (existing) {
      userId = existing.id;
      // Update password
      await supabaseAdmin.auth.admin.updateUserById(existing.id, { password: data.password });
    } else {
      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email: invite.email,
        password: data.password,
        email_confirm: true,
        user_metadata: { display_name: invite.full_name },
      });
      if (cErr || !created.user) throw new Error(cErr?.message ?? "יצירה נכשלה");
      userId = created.user.id;
      await supabaseAdmin
        .from("profiles")
        .update({ display_name: invite.full_name })
        .eq("user_id", userId);
    }

    // Ensure operator role
    await supabaseAdmin.from("user_roles").delete().eq("user_id", userId).eq("role", "client");
    await supabaseAdmin
      .from("user_roles")
      .upsert({ user_id: userId, role: "operator" }, { onConflict: "user_id,role" });

    // Ensure operator record
    const { data: opExist } = await supabaseAdmin
      .from("operators")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    let operatorId = opExist?.id;
    if (!operatorId) {
      const { data: opCreated, error: opErr } = await supabaseAdmin
        .from("operators")
        .insert({ user_id: userId, full_name: invite.full_name })
        .select("id")
        .single();
      if (opErr) throw new Error(opErr.message);
      operatorId = opCreated.id;
    }

    // Assign characters
    if (invite.character_ids && invite.character_ids.length > 0 && operatorId) {
      const rows = (invite.character_ids as string[]).map((cid) => ({
        operator_id: operatorId!,
        character_id: cid,
      }));
      await supabaseAdmin.from("character_operator_assignments").insert(rows);
    }

    await supabaseAdmin
      .from("invites")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invite.id);

    await logAudit(userId, "invite.accepted", "invite", invite.id);

    return { ok: true, email: invite.email };
  });
