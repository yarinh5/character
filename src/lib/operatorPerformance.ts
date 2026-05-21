import { supabase } from "@/integrations/supabase/client";

type CharacterAssignment = {
  character_id: string;
  characters: {
    id: string;
    name: string;
    avatar_url: string | null;
    availability_status: string;
  } | null;
};

type ScoreRow = {
  operator_id: string;
  period_month: string;
  points: number;
  message_count: number;
};

type PerformanceMessage = {
  conversation_id: string;
  sender_type: string;
  operator_id: string | null;
  created_at: string;
};

export type OperatorPerformanceSummary = {
  operator: {
    id: string;
    full_name: string;
    availability_status: "available" | "busy" | "offline";
    is_active: boolean;
  } | null;
  currentMonthKey: string;
  currentPoints: number;
  currentScoredMessages: number;
  previousMonthPoints: number;
  monthlyPointChange: number;
  monthlyMessageChange: number;
  avgResponseSec: number;
  assignedCharacters: CharacterAssignment[];
  monthlyHistory: Array<{
    month: string;
    monthLabel: string;
    points: number;
    scoredMessages: number;
  }>;
  chartData: Array<{
    month: string;
    points: number;
    scoredMessages: number;
  }>;
};

export async function fetchOperatorPerformance(operatorId: string): Promise<OperatorPerformanceSummary> {
  const currentMonth = getMonthStart(new Date());
  const previousMonth = addMonths(currentMonth, -1);
  const currentMonthKey = toMonthKey(currentMonth);
  const previousMonthKey = toMonthKey(previousMonth);
  const currentMonthIso = currentMonth.toISOString();

  const [operatorResult, scoresResult, assignmentsResult] = await Promise.all([
    supabase
      .from("operators")
      .select("id, full_name, availability_status, is_active")
      .eq("id", operatorId)
      .maybeSingle(),
    (supabase
      .from("operator_monthly_scores" as any)
      .select("operator_id, period_month, points, message_count")
      .eq("operator_id", operatorId)
      .order("period_month", { ascending: false })
      .limit(12) as any),
    supabase
      .from("character_operator_assignments")
      .select("character_id, characters(id, name, avatar_url, availability_status)")
      .eq("operator_id", operatorId),
  ]);

  if (operatorResult.error) throw operatorResult.error;
  if (scoresResult.error) throw scoresResult.error;
  if (assignmentsResult.error) throw assignmentsResult.error;

  const scoreRows = ((scoresResult.data ?? []) as ScoreRow[]).map((row) => ({
    ...row,
    points: Number(row.points ?? 0),
    message_count: Number(row.message_count ?? 0),
  }));
  const assignedCharacters = (assignmentsResult.data ?? []) as CharacterAssignment[];

  const currentScore = scoreRows.find((row) => normalizeMonthKey(row.period_month) === currentMonthKey);
  const previousScore = scoreRows.find((row) => normalizeMonthKey(row.period_month) === previousMonthKey);
  const chartRows = [...scoreRows]
    .sort((a, b) => normalizeMonthKey(a.period_month).localeCompare(normalizeMonthKey(b.period_month)))
    .map((row) => ({
      month: formatMonthLabel(row.period_month),
      points: row.points,
      scoredMessages: row.message_count,
    }));

  return {
    operator: operatorResult.data
      ? {
          id: operatorResult.data.id,
          full_name: operatorResult.data.full_name,
          availability_status: operatorResult.data.availability_status,
          is_active: operatorResult.data.is_active,
        }
      : null,
    currentMonthKey,
    currentPoints: currentScore?.points ?? 0,
    currentScoredMessages: currentScore?.message_count ?? 0,
    previousMonthPoints: previousScore?.points ?? 0,
    monthlyPointChange: (currentScore?.points ?? 0) - (previousScore?.points ?? 0),
    monthlyMessageChange: (currentScore?.message_count ?? 0) - (previousScore?.message_count ?? 0),
    avgResponseSec: await fetchAverageResponseSeconds(operatorId, assignedCharacters, currentMonthIso),
    assignedCharacters,
    monthlyHistory: scoreRows.map((row) => ({
      month: normalizeMonthKey(row.period_month),
      monthLabel: formatMonthLabel(row.period_month),
      points: row.points,
      scoredMessages: row.message_count,
    })),
    chartData: chartRows,
  };
}

async function fetchAverageResponseSeconds(
  operatorId: string,
  assignedCharacters: CharacterAssignment[],
  sinceIso: string,
) {
  const characterIds = assignedCharacters.map((assignment) => assignment.character_id);
  if (characterIds.length === 0) return 0;

  const { data: conversations, error: conversationsError } = await supabase
    .from("conversations")
    .select("id")
    .in("character_id", characterIds);
  if (conversationsError) throw conversationsError;

  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  if (conversationIds.length === 0) return 0;

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("conversation_id, sender_type, operator_id, created_at")
    .in("conversation_id", conversationIds)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(1500);
  if (messagesError) throw messagesError;

  return calculateAverageResponseSeconds((messages ?? []) as PerformanceMessage[], operatorId);
}

export function calculateAverageResponseSeconds(messages: PerformanceMessage[], operatorId: string) {
  const byConversation = new Map<string, PerformanceMessage[]>();
  messages.forEach((message) => {
    const list = byConversation.get(message.conversation_id) ?? [];
    list.push(message);
    byConversation.set(message.conversation_id, list);
  });

  let totalMs = 0;
  let pairs = 0;
  byConversation.forEach((list) => {
    let pendingClientAt: number | null = null;
    list.forEach((message) => {
      if (message.sender_type === "client") {
        pendingClientAt = +new Date(message.created_at);
      } else if (
        message.sender_type === "operator" &&
        message.operator_id === operatorId &&
        pendingClientAt !== null
      ) {
        totalMs += +new Date(message.created_at) - pendingClientAt;
        pairs += 1;
        pendingClientAt = null;
      }
    });
  });

  return pairs > 0 ? Math.round(totalMs / pairs / 1000) : 0;
}

export function formatResponseTime(seconds: number) {
  if (!seconds) return "אין נתונים";
  if (seconds < 60) return `${seconds} שניות`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  return `${hours} שעות`;
}

export function formatChange(value: number) {
  if (value > 0) return `+${value}`;
  return `${value}`;
}

function getMonthStart(date: Date) {
  const next = new Date(date);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addMonths(date: Date, amount: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + amount);
  return next;
}

function toMonthKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function normalizeMonthKey(value: string) {
  return value.slice(0, 10);
}

function formatMonthLabel(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    month: "short",
    year: "2-digit",
  }).format(new Date(normalizeMonthKey(value)));
}
