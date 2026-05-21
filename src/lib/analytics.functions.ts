import { createServerFn } from "@tanstack/react-start";
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
        .from("operator_monthly_scores" as any)
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
