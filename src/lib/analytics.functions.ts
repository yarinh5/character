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

const dashboardCount = z.number().int().nonnegative();
const dashboardMetric = z.number().finite().nonnegative();
const dashboardRank = z.object({ name: z.string(), count: dashboardCount });
const AdminDashboardAnalyticsSchema = z.object({
  days: z
    .array(
      z.object({
        date: z.string(),
        conversations: dashboardCount,
        users: dashboardCount,
        messages: dashboardCount,
      }),
    )
    .length(14),
  avgResponseSec: dashboardCount,
  topOperators: z.array(dashboardRank).max(5),
  topCharacters: z.array(dashboardRank).max(5),
  totalCreditsSpent: dashboardMetric,
  manualCreditsAdded: dashboardMetric,
  clientMessages: dashboardCount,
  operatorMessages: dashboardCount,
  topOperatorsByAvailablePoints: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        availablePoints: dashboardMetric,
        monthlyPayouts: dashboardMetric,
        messages: dashboardCount,
        status: z.string(),
        isActive: z.boolean(),
      }),
    )
    .max(8),
  lowBalanceUsers: z
    .array(
      z.object({
        userId: z.string(),
        name: z.string(),
        email: z.string().nullable(),
        balance: z.number().finite(),
      }),
    )
    .max(12),
});

export const adminAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const now = new Date();
    const since = new Date(now);
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const currentMonth = new Date(now);
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);

    // Keep the local cutoffs and UTC chart keys used by the existing dashboard.
    const dayKeys = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(since);
      date.setDate(date.getDate() + i);
      return date.toISOString().slice(0, 10);
    });

    const { data, error } = await supabaseAdmin.rpc("get_admin_dashboard_analytics_for_server", {
      _since: since.toISOString(),
      _month_start: currentMonth.toISOString(),
      _day_keys: dayKeys,
    });
    if (error) throw new Error("admin_dashboard_analytics_unavailable");

    const analytics = AdminDashboardAnalyticsSchema.safeParse(data);
    if (!analytics.success || analytics.data.days.some((day, i) => day.date !== dayKeys[i])) {
      throw new Error("admin_dashboard_analytics_malformed");
    }
    return analytics.data;
  });

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function calendarDateToEpochDay(value: string) {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0) return null;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
}

const CalendarDateSchema = z
  .string()
  .regex(CALENDAR_DATE_PATTERN, "Expected YYYY-MM-DD")
  .refine((value) => calendarDateToEpochDay(value) !== null, "Invalid calendar date");

const DateRangeSchema = z.object({
  startDate: CalendarDateSchema.optional(),
  endDate: CalendarDateSchema.optional(),
});

const FUNNEL_EVENTS = [
  "signup_completed",
  "onboarding_completed",
  "character_viewed",
  "conversation_started",
  "first_message_sent",
  "packages_viewed",
] as const;

const nonNegativeNumber = z.number().finite().nonnegative();
const AdminAdvancedAnalyticsSchema = z.object({
  range: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  kpis: z.object({
    newUsers: nonNegativeNumber,
    conversationsStarted: nonNegativeNumber,
    clientMessages: nonNegativeNumber,
    operatorMessages: nonNegativeNumber,
    characterViews: nonNegativeNumber,
    packagesViewed: nonNegativeNumber,
    insufficientCredits: nonNegativeNumber,
    creditsBurn: nonNegativeNumber,
  }),
  funnel: z.array(
    z.object({
      eventName: z.enum(FUNNEL_EVENTS),
      count: nonNegativeNumber,
    }),
  ),
  days: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      signups: nonNegativeNumber,
      conversations: nonNegativeNumber,
      clientMessages: nonNegativeNumber,
      operatorMessages: nonNegativeNumber,
      events: nonNegativeNumber,
    }),
  ),
  topCharacters: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      conversations: nonNegativeNumber,
      views: nonNegativeNumber,
    }),
  ),
  topOperators: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      messages: nonNegativeNumber,
      points: nonNegativeNumber,
      status: z.string(),
    }),
  ),
});

function calendarDateFromEpochDay(epochDay: number) {
  return new Date(epochDay * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

function parseDateRange(input: z.infer<typeof DateRangeSchema>) {
  const hasStart = input.startDate !== undefined;
  const hasEnd = input.endDate !== undefined;
  if (hasStart !== hasEnd) {
    throw new Error("Both startDate and endDate are required");
  }

  let startDay: number;
  let endDay: number;
  if (!hasStart) {
    const now = new Date();
    endDay = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / MILLISECONDS_PER_DAY,
    );
    startDay = endDay - 29;
  } else {
    startDay = calendarDateToEpochDay(input.startDate!)!;
    endDay = calendarDateToEpochDay(input.endDate!)!;
  }

  if (startDay > endDay) {
    throw new Error("Start date must be before end date");
  }
  if (endDay - startDay + 1 > 180) {
    throw new Error("Date range cannot exceed 180 days");
  }

  return {
    startDate: calendarDateFromEpochDay(startDay),
    endDate: calendarDateFromEpochDay(endDay),
  };
}

export const adminAdvancedAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DateRangeSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const range = parseDateRange(data);
    const { data: analytics, error } = await supabaseAdmin.rpc(
      "get_admin_advanced_analytics_for_server",
      {
        _start_date: range.startDate,
        _end_date: range.endDate,
      },
    );
    if (error) throw new Error(error.message);
    return AdminAdvancedAnalyticsSchema.parse(analytics);
  });
