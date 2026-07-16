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

export const adminAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();

    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);
    const currentMonthKey = currentMonth.toISOString().slice(0, 10);

    const [
      convs,
      users,
      msgs,
      opMsgs,
      charMsgs,
      creditTransactions,
      monthlyScores,
      operators,
      wallets,
      profiles,
      clientMessagesTotal,
      operatorMessagesTotal,
    ] = await Promise.all([
      supabaseAdmin
        .from("conversations")
        .select("id, created_at")
        .gte("created_at", sinceIso),
      supabaseAdmin
        .from("profiles")
        .select("user_id, created_at")
        .gte("created_at", sinceIso),
      supabaseAdmin
        .from("messages")
        .select("id, conversation_id, sender_id, sender_type, created_at")
        .gte("created_at", sinceIso),
      supabaseAdmin
        .from("messages")
        .select("sender_id")
        .eq("sender_type", "operator")
        .gte("created_at", sinceIso),
      supabaseAdmin
        .from("conversations")
        .select("character_id, characters(name)"),
      supabaseAdmin
        .from("credit_transactions")
        .select("amount, type"),
      supabaseAdmin
        .from("operator_monthly_scores")
        .select("operator_id, points, message_count, period_month")
        .eq("period_month", currentMonthKey)
        .order("points", { ascending: false }),
      supabaseAdmin
        .from("operators")
        .select("id, full_name, availability_status, is_active"),
      supabaseAdmin
        .from("credit_wallets")
        .select("user_id, balance")
        .lte("balance", 2)
        .order("balance", { ascending: true })
        .limit(12),
      supabaseAdmin
        .from("profiles")
        .select("user_id, display_name, email"),
      supabaseAdmin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("sender_type", "client"),
      supabaseAdmin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("sender_type", "operator"),
    ]);

    // Build 14-day series
    const days: { date: string; conversations: number; users: number; messages: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      days.push({
        date: d.toISOString().slice(0, 10),
        conversations: 0,
        users: 0,
        messages: 0,
      });
    }
    const idx = (iso: string) => days.findIndex((d) => d.date === iso.slice(0, 10));

    (convs.data ?? []).forEach((c) => {
      const i = idx(c.created_at);
      if (i >= 0) days[i].conversations++;
    });
    (users.data ?? []).forEach((u) => {
      const i = idx(u.created_at);
      if (i >= 0) days[i].users++;
    });
    (msgs.data ?? []).forEach((m) => {
      const i = idx(m.created_at);
      if (i >= 0) days[i].messages++;
    });

    // Average response time: per conversation, time from each client msg until next operator msg
    const byConv = new Map<string, { sender_type: string; created_at: string }[]>();
    (msgs.data ?? []).forEach((m) => {
      const arr = byConv.get(m.conversation_id) ?? [];
      arr.push({ sender_type: m.sender_type, created_at: m.created_at });
      byConv.set(m.conversation_id, arr);
    });
    let totalMs = 0;
    let pairs = 0;
    byConv.forEach((arr) => {
      arr.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
      let pendingClient: number | null = null;
      for (const m of arr) {
        if (m.sender_type === "client") {
          pendingClient = +new Date(m.created_at);
        } else if (m.sender_type === "operator" && pendingClient !== null) {
          totalMs += +new Date(m.created_at) - pendingClient;
          pairs++;
          pendingClient = null;
        }
      }
    });
    const avgResponseSec = pairs > 0 ? Math.round(totalMs / pairs / 1000) : 0;

    // Top operators
    const opCount = new Map<string, number>();
    (opMsgs.data ?? []).forEach((m) => {
      if (m.sender_id) opCount.set(m.sender_id, (opCount.get(m.sender_id) ?? 0) + 1);
    });
    const opIds = Array.from(opCount.keys());
    const { data: opProfiles } = opIds.length
      ? await supabaseAdmin.from("profiles").select("user_id, display_name").in("user_id", opIds)
      : { data: [] as { user_id: string; display_name: string | null }[] };
    const opNameById = new Map((opProfiles ?? []).map((p) => [p.user_id, p.display_name]));
    const topOperators = Array.from(opCount.entries())
      .map(([uid, count]) => ({ name: opNameById.get(uid) ?? "—", count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Top characters by total conversations
    const charCount = new Map<string, { name: string; count: number }>();
    (charMsgs.data ?? []).forEach((c) => {
      const name = (c as { characters: { name: string } | null }).characters?.name ?? "—";
      const cur = charCount.get(c.character_id) ?? { name, count: 0 };
      cur.count++;
      charCount.set(c.character_id, cur);
    });
    const topCharacters = Array.from(charCount.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const creditRows = (creditTransactions.data ?? []) as Array<{ amount: number; type: string }>;
    const totalCreditsSpent = creditRows
      .filter((tx) => tx.amount < 0)
      .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const manualCreditsAdded = creditRows
      .filter((tx) => tx.type === "admin_adjustment" && tx.amount > 0)
      .reduce((sum, tx) => sum + tx.amount, 0);

    const operatorById = new Map((operators.data ?? []).map((op) => [op.id, op]));
    const topMonthlyOperators = ((monthlyScores.data ?? []) as Array<{
      operator_id: string;
      points: number;
      message_count: number;
      period_month: string;
    }>)
      .map((score) => {
        const op = operatorById.get(score.operator_id);
        return {
          id: score.operator_id,
          name: op?.full_name ?? "—",
          points: score.points,
          messages: score.message_count,
          status: op?.availability_status ?? "offline",
          isActive: op?.is_active ?? false,
        };
      })
      .slice(0, 8);

    const profileByUser = new Map((profiles.data ?? []).map((profile) => [profile.user_id, profile]));
    const lowBalanceUsers = ((wallets.data ?? []) as Array<{ user_id: string; balance: number }>)
      .map((wallet) => {
        const profile = profileByUser.get(wallet.user_id);
        return {
          userId: wallet.user_id,
          name: profile?.display_name ?? profile?.email ?? "—",
          email: profile?.email ?? null,
          balance: wallet.balance,
        };
      });

    return {
      days,
      avgResponseSec,
      topOperators,
      topCharacters,
      totalCreditsSpent,
      manualCreditsAdded,
      clientMessages: clientMessagesTotal.count ?? 0,
      operatorMessages: operatorMessagesTotal.count ?? 0,
      topMonthlyOperators,
      lowBalanceUsers,
    };
  });

const DateRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const FUNNEL_EVENTS = [
  "signup_completed",
  "onboarding_completed",
  "character_viewed",
  "conversation_started",
  "first_message_sent",
  "packages_viewed",
] as const;

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDateRange(input: z.infer<typeof DateRangeSchema>) {
  const today = new Date();
  const defaultStart = new Date(today);
  defaultStart.setDate(defaultStart.getDate() - 29);

  const start = input.startDate ? new Date(`${input.startDate}T00:00:00`) : defaultStart;
  const end = input.endDate ? new Date(`${input.endDate}T23:59:59.999`) : today;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date range");
  }
  if (start > end) {
    throw new Error("Start date must be before end date");
  }

  const maxStart = new Date(end);
  maxStart.setDate(maxStart.getDate() - 180);
  const safeStart = start < maxStart ? maxStart : start;

  safeStart.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  return {
    start,
    safeStart,
    end,
    startIso: safeStart.toISOString(),
    endIso: end.toISOString(),
    startDate: dateOnly(safeStart),
    endDate: dateOnly(end),
  };
}

function buildDays(start: Date, end: Date) {
  const days: Array<{
    date: string;
    signups: number;
    conversations: number;
    clientMessages: number;
    operatorMessages: number;
    events: number;
  }> = [];

  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);

  while (cursor <= last) {
    days.push({
      date: dateOnly(cursor),
      signups: 0,
      conversations: 0,
      clientMessages: 0,
      operatorMessages: 0,
      events: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function incrementDay<T extends { date: string }>(days: T[], iso: string | null | undefined, key: keyof T) {
  if (!iso) return;
  const date = iso.slice(0, 10);
  const day = days.find((item) => item.date === date);
  if (!day || typeof day[key] !== "number") return;
  (day[key] as number) += 1;
}

export const adminAdvancedAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DateRangeSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const range = parseDateRange(data);

    const [
      profiles,
      conversations,
      messages,
      events,
      creditTransactions,
      scoreEvents,
      characters,
      operators,
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("user_id, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin
        .from("conversations")
        .select("id, character_id, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin
        .from("messages")
        .select("id, conversation_id, sender_type, operator_id, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin
        .from("analytics_events")
        .select("event_name, actor_user_id, role, conversation_id, character_id, operator_id, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin
        .from("credit_transactions")
        .select("amount, type, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin
        .from("operator_score_events")
        .select("operator_id, points, created_at")
        .gte("created_at", range.startIso)
        .lte("created_at", range.endIso)
        .limit(10000),
      supabaseAdmin.from("characters").select("id, name").limit(10000),
      supabaseAdmin.from("operators").select("id, full_name, is_active, availability_status").limit(10000),
    ]);

    const errors = [
      profiles.error,
      conversations.error,
      messages.error,
      events.error,
      creditTransactions.error,
      scoreEvents.error,
      characters.error,
      operators.error,
    ].filter(Boolean);
    if (errors[0]) throw new Error(errors[0].message);

    const profileRows = profiles.data ?? [];
    const conversationRows = conversations.data ?? [];
    const messageRows = messages.data ?? [];
    const eventRows = (events.data ?? []) as Array<{
      event_name: string;
      actor_user_id: string | null;
      role: string | null;
      conversation_id: string | null;
      character_id: string | null;
      operator_id: string | null;
      created_at: string;
    }>;
    const creditRows = creditTransactions.data ?? [];
    const scoreRows = (scoreEvents.data ?? []) as Array<{ operator_id: string | null; points: number; created_at: string }>;

    const days = buildDays(range.safeStart, range.end);
    profileRows.forEach((row) => incrementDay(days, row.created_at, "signups"));
    conversationRows.forEach((row) => incrementDay(days, row.created_at, "conversations"));
    messageRows.forEach((row) => {
      if (row.sender_type === "client") incrementDay(days, row.created_at, "clientMessages");
      if (row.sender_type === "operator") incrementDay(days, row.created_at, "operatorMessages");
    });
    eventRows.forEach((row) => incrementDay(days, row.created_at, "events"));

    const eventsByName = new Map<string, number>();
    for (const event of eventRows) {
      eventsByName.set(event.event_name, (eventsByName.get(event.event_name) ?? 0) + 1);
    }

    const messageClientCount = messageRows.filter((message) => message.sender_type === "client").length;
    const messageOperatorCount = messageRows.filter((message) => message.sender_type === "operator").length;
    const creditsBurn = creditRows
      .filter((tx) => tx.amount < 0)
      .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    const characterNameById = new Map((characters.data ?? []).map((character) => [character.id, character.name]));
    const characterCounts = new Map<string, { id: string; name: string; conversations: number; views: number }>();
    for (const conversation of conversationRows) {
      const current = characterCounts.get(conversation.character_id) ?? {
        id: conversation.character_id,
        name: characterNameById.get(conversation.character_id) ?? "ללא שם",
        conversations: 0,
        views: 0,
      };
      current.conversations += 1;
      characterCounts.set(conversation.character_id, current);
    }
    for (const event of eventRows) {
      if (event.event_name !== "character_viewed" || !event.character_id) continue;
      const current = characterCounts.get(event.character_id) ?? {
        id: event.character_id,
        name: characterNameById.get(event.character_id) ?? "ללא שם",
        conversations: 0,
        views: 0,
      };
      current.views += 1;
      characterCounts.set(event.character_id, current);
    }
    const topCharacters = Array.from(characterCounts.values())
      .sort((a, b) => b.conversations + b.views - (a.conversations + a.views))
      .slice(0, 8);

    const operatorById = new Map((operators.data ?? []).map((operator) => [operator.id, operator]));
    const operatorCounts = new Map<string, { id: string; name: string; messages: number; points: number; status: string }>();
    for (const message of messageRows) {
      if (message.sender_type !== "operator" || !message.operator_id) continue;
      const operator = operatorById.get(message.operator_id);
      const current = operatorCounts.get(message.operator_id) ?? {
        id: message.operator_id,
        name: operator?.full_name ?? "ללא שם",
        messages: 0,
        points: 0,
        status: operator?.availability_status ?? "offline",
      };
      current.messages += 1;
      operatorCounts.set(message.operator_id, current);
    }
    for (const score of scoreRows) {
      if (!score.operator_id) continue;
      const operator = operatorById.get(score.operator_id);
      const current = operatorCounts.get(score.operator_id) ?? {
        id: score.operator_id,
        name: operator?.full_name ?? "ללא שם",
        messages: 0,
        points: 0,
        status: operator?.availability_status ?? "offline",
      };
      current.points += score.points ?? 0;
      operatorCounts.set(score.operator_id, current);
    }
    const topOperators = Array.from(operatorCounts.values())
      .sort((a, b) => b.points + b.messages - (a.points + a.messages))
      .slice(0, 8);

    return {
      range: {
        startDate: range.startDate,
        endDate: range.endDate,
      },
      kpis: {
        newUsers: profileRows.length,
        conversationsStarted: conversationRows.length,
        clientMessages: messageClientCount,
        operatorMessages: messageOperatorCount,
        characterViews: eventsByName.get("character_viewed") ?? 0,
        packagesViewed: eventsByName.get("packages_viewed") ?? 0,
        insufficientCredits: eventsByName.get("insufficient_credits_shown") ?? 0,
        creditsBurn,
      },
      funnel: FUNNEL_EVENTS.map((eventName) => ({
        eventName,
        count: eventsByName.get(eventName) ?? 0,
      })),
      days,
      topCharacters,
      topOperators,
    };
  });
