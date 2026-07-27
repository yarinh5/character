import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";

type AppRole = "admin" | "operator" | "client";

type ClientTimelineEvent = {
  id: string;
  type: "signup" | "chat" | "credit" | "admin" | "report" | "analytics";
  title: string;
  description: string | null;
  created_at: string;
  conversation_id?: string | null;
};

function previewText(value: unknown, max = 90) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function metadataValue(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

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

async function getClientContext(userId: string) {
  const [
    { data: roles, error: rolesError },
    { data: profile, error: profileError },
    { data: clientProfile, error: clientProfileError },
  ] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
    supabaseAdmin
      .from("profiles")
      .select("user_id, email, display_name, status, deleted_at, pii_archived_at")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin.from("client_profiles").select("id").eq("user_id", userId).maybeSingle(),
  ]);
  if (rolesError) throw new Error(rolesError.message);
  if (profileError) throw new Error(profileError.message);
  if (clientProfileError) throw new Error(clientProfileError.message);
  if (!profile) throw new Error("לקוח לא נמצא");

  const roleSet = new Set((roles ?? []).map((row) => row.role as AppRole));
  if (roleSet.has("admin") || roleSet.has("operator") || (!roleSet.has("client") && !clientProfile)) {
    throw new Error("המשתמש אינו לקוח פעיל לניהול במסך הלקוחות");
  }

  return { profile, roles: roleSet };
}

async function setAuthBan(userId: string, blocked: boolean) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: blocked ? "876000h" : "none",
  });
  if (error) throw new Error(error.message);
}

async function deleteUserAvatarPrefix(userId: string) {
  const bucket = supabaseAdmin.storage.from("user-avatars");
  const paths: string[] = [];

  const collect = async (prefix: string) => {
    const { data, error } = await bucket.list(prefix, { limit: 100 });
    if (error) throw new Error("ניקוי תמונת הפרופיל נכשל");

    for (const entry of data ?? []) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id) {
        paths.push(path);
      } else {
        await collect(path);
      }
    }
  };

  await collect(userId);
  if (!paths.length) return 0;

  const { error } = await bucket.remove(paths);
  if (error) throw new Error("ניקוי תמונת הפרופיל נכשל");
  return paths.length;
}

export const adminListClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        include_archived: z.boolean().default(false),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const [{ data: roles, error: rolesError }, { data: clientProfiles, error: clientsError }] = await Promise.all([
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin.from("client_profiles").select("user_id"),
    ]);
    if (rolesError) throw new Error(rolesError.message);
    if (clientsError) throw new Error(clientsError.message);

    const clientCandidates = new Set<string>();
    const elevatedUsers = new Set<string>();
    (roles ?? []).forEach((role) => {
      if (role.role === "client") clientCandidates.add(role.user_id);
      if (role.role === "operator" || role.role === "admin") elevatedUsers.add(role.user_id);
    });
    (clientProfiles ?? []).forEach((profile) => clientCandidates.add(profile.user_id));

    const ids = [...clientCandidates].filter((userId) => !elevatedUsers.has(userId));
    if (!ids.length) return [];

    let profileQuery = supabaseAdmin
      .from("profiles")
      .select("user_id, email, display_name, avatar_url, status, created_at, deleted_at, pii_archived_at")
      .in("user_id", ids)
      .order("created_at", { ascending: false });

    profileQuery = data.include_archived
      ? profileQuery.not("deleted_at", "is", null)
      : profileQuery.is("deleted_at", null);

    const { data: profiles, error } = await profileQuery;
    if (error) throw new Error(error.message);

    const profileIds = (profiles ?? []).map((profile) => profile.user_id);
    const [{ data: wallets }, { data: conversations }] = await Promise.all([
      profileIds.length
        ? supabaseAdmin.from("credit_wallets").select("user_id, balance").in("user_id", profileIds)
        : Promise.resolve({ data: [] as { user_id: string; balance: number }[] }),
      profileIds.length
        ? supabaseAdmin
            .from("conversations")
            .select("client_id, status, last_message_at")
            .in("client_id", profileIds)
        : Promise.resolve({ data: [] as { client_id: string; status: string; last_message_at: string | null }[] }),
    ]);

    const walletMap = new Map((wallets ?? []).map((wallet) => [wallet.user_id, wallet.balance]));
    const statsMap = new Map<string, { conversations: number; active: number; last_message_at: string | null }>();
    (conversations ?? []).forEach((conversation) => {
      const current = statsMap.get(conversation.client_id) ?? {
        conversations: 0,
        active: 0,
        last_message_at: null,
      };
      current.conversations += 1;
      if (conversation.status !== "closed") current.active += 1;
      if (
        conversation.last_message_at &&
        (!current.last_message_at || new Date(conversation.last_message_at) > new Date(current.last_message_at))
      ) {
        current.last_message_at = conversation.last_message_at;
      }
      statsMap.set(conversation.client_id, current);
    });

    return (profiles ?? []).map((profile) => {
      const stats = statsMap.get(profile.user_id);
      return {
        user_id: profile.user_id,
        email: profile.email,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        status: profile.deleted_at ? "archived" : profile.status,
        created_at: profile.created_at,
        deleted_at: profile.deleted_at,
        pii_archived_at: profile.pii_archived_at,
        credits_balance: walletMap.get(profile.user_id) ?? 0,
        conversations_count: stats?.conversations ?? 0,
        active_conversations_count: stats?.active ?? 0,
        last_message_at: stats?.last_message_at ?? null,
      };
    });
  });

export const adminGetClientDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    await getClientContext(data.user_id);

    const [profile, clientProfile, wallet, conversations, transactions, messageCounts] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("user_id, email, display_name, avatar_url, status, created_at, deleted_at, pii_archived_at")
        .eq("user_id", data.user_id)
        .maybeSingle(),
      supabaseAdmin
        .from("client_profiles")
        .select("age, gender, interests, conversation_preferences, created_at, updated_at")
        .eq("user_id", data.user_id)
        .maybeSingle(),
      supabaseAdmin
        .from("credit_wallets")
        .select("balance, lifetime_earned, lifetime_spent, updated_at")
        .eq("user_id", data.user_id)
        .maybeSingle(),
      supabaseAdmin
        .from("conversations")
        .select("id, status, last_message_at, last_message_preview, created_at, characters(id, name, avatar_url)")
        .eq("client_id", data.user_id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(12),
      supabaseAdmin
        .from("credit_transactions")
        .select("id, amount, balance_after, type, reason, created_at, created_by")
        .eq("user_id", data.user_id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("messages")
        .select("sender_type")
        .eq("sender_id", data.user_id)
        .limit(1000),
    ]);

    if (profile.error) throw new Error(profile.error.message);
    if (clientProfile.error) throw new Error(clientProfile.error.message);
    if (wallet.error) throw new Error(wallet.error.message);
    if (conversations.error) throw new Error(conversations.error.message);
    if (transactions.error) throw new Error(transactions.error.message);
    if (messageCounts.error) throw new Error(messageCounts.error.message);

    const conversationRows = conversations.data ?? [];
    const conversationIds = conversationRows.map((conversation) => conversation.id);
    const conversationMap = new Map(conversationRows.map((conversation: any) => [conversation.id, conversation]));

    const [messages, deletedConversations, reports, auditLogs, analyticsEvents] = await Promise.all([
      conversationIds.length
        ? supabaseAdmin
            .from("messages")
            .select("id, conversation_id, sender_type, content, created_at, operator_id, operators(full_name)")
            .in("conversation_id", conversationIds)
            .order("created_at", { ascending: false })
            .limit(60)
        : Promise.resolve({ data: [] as any[], error: null }),
      conversationIds.length
        ? supabaseAdmin
            .from("client_conversation_deletions")
            .select("conversation_id, deleted_at")
            .eq("client_id", data.user_id)
            .in("conversation_id", conversationIds)
            .order("deleted_at", { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [] as any[], error: null }),
      supabaseAdmin
        .from("reports")
        .select("id, conversation_id, reason, status, details, created_at")
        .eq("reporter_id", data.user_id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("audit_logs")
        .select("id, action, actor_user_id, metadata, created_at")
        .eq("entity_type", "user")
        .eq("entity_id", data.user_id)
        .order("created_at", { ascending: false })
        .limit(40),
      (supabaseAdmin as any)
        .from("analytics_events")
        .select("id, event_name, metadata, conversation_id, character_id, created_at")
        .eq("actor_user_id", data.user_id)
        .in("event_name", [
          "signup_completed",
          "onboarding_completed",
          "character_viewed",
          "conversation_started",
          "first_message_sent",
          "insufficient_credits_shown",
          "packages_viewed",
          "low_credits_reached",
          "report_created",
        ])
        .order("created_at", { ascending: false })
        .limit(40),
    ]);

    const actorIds = [
      ...(transactions.data ?? []).map((transaction) => transaction.created_by).filter(Boolean),
      ...(auditLogs.data ?? []).map((log) => log.actor_user_id).filter(Boolean),
    ] as string[];
    const { data: actorProfiles } = actorIds.length
      ? await supabaseAdmin.from("profiles").select("user_id, display_name, email").in("user_id", [...new Set(actorIds)])
      : { data: [] as { user_id: string; display_name: string | null; email: string | null }[] };
    const actorMap = new Map(
      (actorProfiles ?? []).map((actor) => [actor.user_id, actor.display_name || actor.email || actor.user_id.slice(0, 8)]),
    );

    const timeline: ClientTimelineEvent[] = [];

    if (profile.data?.created_at) {
      timeline.push({
        id: `signup-${profile.data.user_id}`,
        type: "signup",
        title: "הרשמה / יצירת משתמש",
        description: profile.data.email ?? profile.data.display_name ?? null,
        created_at: profile.data.created_at,
      });
    }

    conversationRows.forEach((conversation: any) => {
      timeline.push({
        id: `conversation-${conversation.id}`,
        type: "chat",
        title: "שיחה נפתחה",
        description: conversation.characters?.name ? `דמות: ${conversation.characters.name}` : null,
        created_at: conversation.created_at,
        conversation_id: conversation.id,
      });
    });

    (messages.data ?? []).forEach((message: any) => {
      const conversation = conversationMap.get(message.conversation_id) as any;
      const characterName = conversation?.characters?.name ? ` · ${conversation.characters.name}` : "";
      const content = previewText(message.content);
      timeline.push({
        id: `message-${message.id}`,
        type: "chat",
        title: message.sender_type === "client" ? "הודעת לקוח נשלחה" : "הודעת עובד נשלחה ללקוח",
        description:
          message.sender_type === "client"
            ? [content, characterName.trim()].filter(Boolean).join(" · ") || null
            : [`${message.operators?.full_name ?? "עובד"}`, content, characterName.trim()].filter(Boolean).join(" · "),
        created_at: message.created_at,
        conversation_id: message.conversation_id,
      });
    });

    (deletedConversations.data ?? []).forEach((deletion: any) => {
      const conversation = conversationMap.get(deletion.conversation_id) as any;
      timeline.push({
        id: `client-delete-${deletion.conversation_id}-${deletion.deleted_at}`,
        type: "chat",
        title: "שיחה הוסתרה מצד הלקוח",
        description: conversation?.characters?.name ? `דמות: ${conversation.characters.name}` : null,
        created_at: deletion.deleted_at,
        conversation_id: deletion.conversation_id,
      });
    });

    (transactions.data ?? []).forEach((transaction) => {
      const actor = transaction.created_by ? actorMap.get(transaction.created_by) : null;
      timeline.push({
        id: `credit-${transaction.id}`,
        type: "credit",
        title: transaction.amount >= 0 ? "קרדיטים נוספו" : "קרדיטים ירדו",
        description: [
          `${transaction.amount > 0 ? "+" : ""}${transaction.amount} קרדיטים`,
          `יתרה: ${transaction.balance_after}`,
          transaction.reason ?? transaction.type,
          actor ? `בוצע על ידי: ${actor}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        created_at: transaction.created_at,
      });
    });

    (auditLogs.data ?? []).forEach((log) => {
      const actor = log.actor_user_id ? actorMap.get(log.actor_user_id) : null;
      const status = metadataValue(log.metadata, "status") ?? metadataValue(log.metadata, "role");
      const labels: Record<string, string> = {
        "user.password_reset_sent": "איפוס סיסמה נשלח",
        "user.password_reset": "איפוס סיסמה נשלח",
        "client.status_changed": "סטטוס לקוח השתנה",
        "user.status_changed": "סטטוס משתמש השתנה",
        "client.archived": "לקוח אורכב",
        "client.restored": "לקוח שוחזר",
        "client.updated": "פרטי לקוח עודכנו",
        "client.credits_adjusted": "קרדיטים עודכנו ידנית",
        "user.promoted_to_operator": "לקוח הפך לעובד",
        "user.role_changed": "תפקיד משתמש השתנה",
        "user.soft_deleted": "משתמש אורכב",
      };
      timeline.push({
        id: `audit-${log.id}`,
        type: "admin",
        title: labels[log.action] ?? log.action,
        description: [status ? `ערך: ${status}` : null, actor ? `בוצע על ידי: ${actor}` : null].filter(Boolean).join(" · ") || null,
        created_at: log.created_at,
      });
    });

    (reports.data ?? []).forEach((report: any) => {
      timeline.push({
        id: `report-${report.id}`,
        type: "report",
        title: "דיווח נוצר",
        description: [`סיבה: ${report.reason}`, `סטטוס: ${report.status}`, previewText(report.details)].filter(Boolean).join(" · "),
        created_at: report.created_at,
        conversation_id: report.conversation_id,
      });
    });

    const analyticsLabels: Record<string, string> = {
      signup_completed: "הרשמה הושלמה",
      onboarding_completed: "אונבורדינג הושלם",
      character_viewed: "צפייה בדמות",
      conversation_started: "שיחה התחילה",
      first_message_sent: "הודעה ראשונה נשלחה",
      insufficient_credits_shown: "הוצגה הודעת חוסר קרדיטים",
      packages_viewed: "צפייה במסך חבילות",
      low_credits_reached: "יתרת קרדיטים נמוכה",
      report_created: "דיווח נוצר",
    };
    ((analyticsEvents as any).data ?? []).forEach((event: any) => {
      timeline.push({
        id: `analytics-${event.id}`,
        type: "analytics",
        title: analyticsLabels[event.event_name] ?? event.event_name,
        description: metadataValue(event.metadata, "source"),
        created_at: event.created_at,
        conversation_id: event.conversation_id,
      });
    });

    return {
      profile: profile.data,
      client_profile: clientProfile.data,
      wallet: wallet.data ?? { balance: 0, lifetime_earned: 0, lifetime_spent: 0, updated_at: null },
      conversations: conversations.data ?? [],
      transactions: transactions.data ?? [],
      timeline: timeline
        .filter((event) => Boolean(event.created_at))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 80),
      activity: {
        conversations_count: conversations.count ?? (conversations.data ?? []).length,
        client_messages_count: (messageCounts.data ?? []).filter((message) => message.sender_type === "client").length,
      },
    };
  });

export const adminUpdateClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        user_id: z.string().uuid(),
        display_name: z.string().trim().min(1).max(120).optional(),
        status: z.enum(["active", "blocked"]).optional(),
        age: z.number().int().min(18).max(120).nullable().optional(),
        gender: z.string().trim().max(80).nullable().optional(),
        interests: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
        conversation_preferences: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { profile } = await getClientContext(data.user_id);
    if (profile.deleted_at) throw new Error("לא ניתן לערוך לקוח מאורכב");

    const profileUpdate: { display_name?: string; status?: string } = {};
    if (data.display_name !== undefined) profileUpdate.display_name = data.display_name;
    if (data.status !== undefined) profileUpdate.status = data.status;
    if (Object.keys(profileUpdate).length) {
      const { error } = await supabaseAdmin.from("profiles").update(profileUpdate).eq("user_id", data.user_id);
      if (error) throw new Error(error.message);
    }

    if (data.status) {
      await setAuthBan(data.user_id, data.status !== "active");
    }

    const clientUpdate: {
      age?: number | null;
      gender?: string | null;
      interests?: string[];
      conversation_preferences?: string | null;
    } = {};
    if (data.age !== undefined) clientUpdate.age = data.age;
    if (data.gender !== undefined) clientUpdate.gender = data.gender || null;
    if (data.interests !== undefined) clientUpdate.interests = data.interests;
    if (data.conversation_preferences !== undefined) {
      clientUpdate.conversation_preferences = data.conversation_preferences || null;
    }
    if (Object.keys(clientUpdate).length) {
      const { error } = await supabaseAdmin
        .from("client_profiles")
        .update(clientUpdate)
        .eq("user_id", data.user_id);
      if (error) throw new Error(error.message);
    }

    await logAudit(context.userId, "client.updated", "user", data.user_id, {
      status: data.status,
      display_name_changed: data.display_name !== undefined,
    });

    return { ok: true };
  });

export const adminSetClientStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ user_id: z.string().uuid(), is_active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { profile } = await getClientContext(data.user_id);
    if (profile.deleted_at) throw new Error("לקוח מאורכב לא ניתן להפעלה מהירה");

    const status = data.is_active ? "active" : "blocked";
    const { error } = await supabaseAdmin.from("profiles").update({ status }).eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    await setAuthBan(data.user_id, !data.is_active);
    await logAudit(context.userId, "client.status_changed", "user", data.user_id, { status });
    return { ok: true };
  });

export const adminArchiveClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    if (data.user_id === context.userId) throw new Error("לא ניתן לארכב את החשבון שלך מכאן");
    const { profile } = await getClientContext(data.user_id);
    if (profile.pii_archived_at) throw new Error("לקוח שעבר אנונימיזציית PII לא ניתן לארכוב רגיל");
    if (profile.deleted_at) return { ok: true };

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ status: "archived", deleted_at: new Date().toISOString() })
      .eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    await setAuthBan(data.user_id, true);
    await logAudit(context.userId, "client.archived", "user", data.user_id);
    return { ok: true };
  });

export const adminRestoreClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { profile } = await getClientContext(data.user_id);
    if (profile.pii_archived_at) throw new Error("לקוח שעבר אנונימיזציית PII לא ניתן לשחזור");
    if (!profile.deleted_at) return { ok: true };

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ status: "blocked", deleted_at: null })
      .eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    await setAuthBan(data.user_id, true);
    await logAudit(context.userId, "client.restored", "user", data.user_id, { status: "blocked" });
    return { ok: true };
  });

export const adminArchiveClientPii = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        user_id: z.string().uuid(),
        reason: z.string().trim().min(3).max(500),
        confirm: z.literal("ARCHIVE_CLIENT_PII"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    if (data.user_id === context.userId) throw new Error("לא ניתן לבצע אנונימיזציית PII לחשבון שלך");
    await getClientContext(data.user_id);

    const { data: result, error } = await context.supabase.rpc("archive_client_pii", {
      _client_id: data.user_id,
      _reason: data.reason,
      _confirm: data.confirm,
    });
    if (error) throw new Error(error.message);

    await setAuthBan(data.user_id, true);
    const avatarObjectsDeleted = await deleteUserAvatarPrefix(data.user_id);

    return {
      ...(result as Record<string, unknown>),
      avatar_objects_deleted: avatarObjectsDeleted,
    };
  });

export const adminAdjustClientCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        user_id: z.string().uuid(),
        amount: z.number().int().refine((value) => value !== 0, "amount_must_be_non_zero"),
        reason: z.string().trim().min(3).max(300),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    await getClientContext(data.user_id);

    const { data: result, error } = await context.supabase.rpc("admin_adjust_client_credits", {
      _user_id: data.user_id,
      _amount: data.amount,
      _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    await logAudit(context.userId, "client.credits_adjusted", "user", data.user_id, {
      amount: data.amount,
    });
    return result;
  });
