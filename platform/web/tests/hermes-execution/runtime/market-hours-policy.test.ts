import { describe, expect, it } from "vitest";
import { AlwaysOpenMarketHoursPolicy, WeekdaySessionMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";

describe("AlwaysOpenMarketHoursPolicy", () => {
  it("is always open regardless of the timestamp", () => {
    const policy = new AlwaysOpenMarketHoursPolicy();
    expect(policy.isMarketOpen(new Date("2026-01-01T00:00:00Z"))).toBe(true); // a Thursday, midnight
    expect(policy.isMarketOpen(new Date("2026-01-03T12:00:00Z"))).toBe(true); // a Saturday, midday
    expect(policy.isMarketOpen(new Date("2000-06-15T03:17:00Z"))).toBe(true);
  });
});

describe("WeekdaySessionMarketHoursPolicy — basic window", () => {
  // 2026-01-05 is a Monday. Session 09:30-16:00 America/New_York (UTC-5 in January, standard time).
  const policy = new WeekdaySessionMarketHoursPolicy({
    timezone: "America/New_York",
    sessionStart: "09:30",
    sessionEnd: "16:00",
  });

  it("is open at the session start boundary (inclusive)", () => {
    expect(policy.isMarketOpen(new Date("2026-01-05T14:30:00.000Z"))).toBe(true); // 09:30 ET
  });

  it("is closed at the session end boundary (exclusive)", () => {
    expect(policy.isMarketOpen(new Date("2026-01-05T21:00:00.000Z"))).toBe(false); // 16:00 ET
  });

  it("is open in the middle of the session", () => {
    expect(policy.isMarketOpen(new Date("2026-01-05T17:00:00.000Z"))).toBe(true); // 12:00 ET
  });

  it("is closed before the session starts", () => {
    expect(policy.isMarketOpen(new Date("2026-01-05T14:00:00.000Z"))).toBe(false); // 09:00 ET
  });

  it("is closed after the session ends", () => {
    expect(policy.isMarketOpen(new Date("2026-01-05T22:00:00.000Z"))).toBe(false); // 17:00 ET
  });

  it("is closed on a weekend even during session hours", () => {
    // 2026-01-03 is a Saturday.
    expect(policy.isMarketOpen(new Date("2026-01-03T17:00:00.000Z"))).toBe(false); // 12:00 ET Saturday
  });
});

describe("WeekdaySessionMarketHoursPolicy — timezone handling (explicit)", () => {
  it("interprets sessionStart/sessionEnd as local time in the configured IANA zone, not UTC", () => {
    // Same 09:30-16:00 session window, two different timezones. 2026-01-05T10:00:00Z is 10:00 UTC
    // (within the UTC policy's own 09:30-16:00 window) but only 05:00 ET in January (EST, UTC-5 —
    // before the ET policy's 09:30 start) — the same instant is open under one configured timezone
    // and closed under the other, purely because of which zone sessionStart/sessionEnd are
    // interpreted in.
    const etPolicy = new WeekdaySessionMarketHoursPolicy({ timezone: "America/New_York", sessionStart: "09:30", sessionEnd: "16:00" });
    const utcPolicy = new WeekdaySessionMarketHoursPolicy({ timezone: "UTC", sessionStart: "09:30", sessionEnd: "16:00" });
    const instant = new Date("2026-01-05T10:00:00.000Z");

    expect(etPolicy.isMarketOpen(instant)).toBe(false); // 05:00 ET
    expect(utcPolicy.isMarketOpen(instant)).toBe(true); // 10:00 UTC
  });

  it("automatically follows DST — the same UTC hour maps to a different local hour across the DST boundary", () => {
    const policy = new WeekdaySessionMarketHoursPolicy({ timezone: "America/New_York", sessionStart: "09:30", sessionEnd: "16:00" });
    // 2026-01-05 (EST, UTC-5): 14:29 UTC = 09:29 ET -> closed (before 09:30).
    expect(policy.isMarketOpen(new Date("2026-01-05T14:29:00.000Z"))).toBe(false);
    // 2026-06-01 (EDT, UTC-4): 14:29 UTC = 10:29 ET -> open (Monday, within session).
    expect(policy.isMarketOpen(new Date("2026-06-01T14:29:00.000Z"))).toBe(true);
  });
});

describe("WeekdaySessionMarketHoursPolicy — configurable weekdays", () => {
  it("honours an explicit weekdays override (e.g. Sunday-Thursday)", () => {
    const policy = new WeekdaySessionMarketHoursPolicy({
      timezone: "UTC",
      weekdays: [0, 1, 2, 3, 4], // Sun-Thu
      sessionStart: "09:00",
      sessionEnd: "17:00",
    });
    // 2026-01-04 is a Sunday.
    expect(policy.isMarketOpen(new Date("2026-01-04T12:00:00.000Z"))).toBe(true);
    // 2026-01-03 is a Saturday.
    expect(policy.isMarketOpen(new Date("2026-01-03T12:00:00.000Z"))).toBe(false);
  });
});

describe("WeekdaySessionMarketHoursPolicy — construction-time validation", () => {
  it("throws for a malformed sessionStart", () => {
    expect(() => new WeekdaySessionMarketHoursPolicy({ timezone: "UTC", sessionStart: "9:30", sessionEnd: "16:00" })).toThrow(
      /sessionStart/,
    );
  });

  it("throws for a malformed sessionEnd", () => {
    expect(() => new WeekdaySessionMarketHoursPolicy({ timezone: "UTC", sessionStart: "09:30", sessionEnd: "25:00" })).toThrow(
      /sessionEnd/,
    );
  });

  it("throws when sessionStart is not strictly before sessionEnd", () => {
    expect(() => new WeekdaySessionMarketHoursPolicy({ timezone: "UTC", sessionStart: "16:00", sessionEnd: "09:30" })).toThrow(
      /strictly before/,
    );
    expect(() => new WeekdaySessionMarketHoursPolicy({ timezone: "UTC", sessionStart: "09:30", sessionEnd: "09:30" })).toThrow(
      /strictly before/,
    );
  });

  it("throws for an invalid IANA timezone name", () => {
    expect(
      () => new WeekdaySessionMarketHoursPolicy({ timezone: "Not/A_Zone", sessionStart: "09:30", sessionEnd: "16:00" }),
    ).toThrow(/Invalid IANA timezone/);
  });
});
