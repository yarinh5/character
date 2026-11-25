import { describe, expect, it } from "vitest";

import {
  formatSupportTarget,
  getSupportFirstResponseState,
  parseSupportClosureDates,
  parseSupportScheduleWindows,
} from "@/lib/supportSla";

const targetAt = "2026-11-16T15:00:00.000Z";

describe("support first-response presentation", () => {
  it("does not invent a target when the server did not calculate one", () => {
    expect(
      getSupportFirstResponseState(
        {
          firstResponseTargetAt: null,
          firstHumanResponseAt: null,
          firstResponseWithinTarget: null,
        },
        new Date("2026-11-16T16:00:00.000Z"),
      ),
    ).toBe("not_set");
  });

  it("keeps the exact deadline pending and marks only a later instant overdue", () => {
    const ticket = {
      firstResponseTargetAt: targetAt,
      firstHumanResponseAt: null,
      firstResponseWithinTarget: null,
    };
    expect(getSupportFirstResponseState(ticket, new Date(targetAt))).toBe("pending");
    expect(getSupportFirstResponseState(ticket, new Date("2026-11-16T15:00:00.001Z"))).toBe(
      "overdue",
    );
  });

  it("uses the authoritative stored outcome after the first human reply", () => {
    expect(
      getSupportFirstResponseState({
        firstResponseTargetAt: null,
        firstHumanResponseAt: "2026-11-16T14:00:00.000Z",
        firstResponseWithinTarget: null,
      }),
    ).toBe("not_set");
    expect(
      getSupportFirstResponseState({
        firstResponseTargetAt: targetAt,
        firstHumanResponseAt: "2026-11-16T14:59:59.000Z",
        firstResponseWithinTarget: true,
      }),
    ).toBe("answered_on_time");
    expect(
      getSupportFirstResponseState({
        firstResponseTargetAt: targetAt,
        firstHumanResponseAt: "2026-11-16T15:00:01.000Z",
        firstResponseWithinTarget: false,
      }),
    ).toBe("answered_late");
  });

  it("renders the absolute timestamp in the schedule timezone", () => {
    expect(formatSupportTarget("2026-03-08T08:00:00.000Z", "America/New_York", "en-GB")).toContain(
      "04:00",
    );
    expect(formatSupportTarget(null, "America/New_York", "en-GB")).toBeNull();
  });

  it("parses multiple and cross-midnight windows without inventing a calendar", () => {
    expect(parseSupportScheduleWindows("1 09:00-12:00\n1 13:00-17:00\n2 22:00-02:00")).toEqual([
      { weekday: 1, start: "09:00", end: "12:00" },
      { weekday: 1, start: "13:00", end: "17:00" },
      { weekday: 2, start: "22:00", end: "02:00" },
    ]);
    expect(() => parseSupportScheduleWindows("1 09:00-09:00")).toThrow(
      "support_window_zero_length",
    );
    expect(() => parseSupportScheduleWindows("7 09:00-17:00")).toThrow("support_window_invalid");
  });

  it("normalizes explicit closure dates and rejects non-calendar input", () => {
    expect(parseSupportClosureDates("2026-11-20\n2026-11-19\n2026-11-20")).toEqual([
      "2026-11-19",
      "2026-11-20",
    ]);
    expect(() => parseSupportClosureDates("20/11/2026")).toThrow("support_closure_date_invalid");
    expect(() => parseSupportClosureDates("2026-02-31")).toThrow("support_closure_date_invalid");
  });
});
