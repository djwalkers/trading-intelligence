import { describe, expect, it } from "vitest";
import { MarketHoursPolicyFactory } from "@/lib/hermes-execution/runtime/market-hours-policy-factory";
import { AlwaysOpenMarketHoursPolicy, WeekdaySessionMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import type { TradingSchedulerConfig } from "@/lib/hermes-execution/config";

const BASE_CONFIG: TradingSchedulerConfig = {
  enabled: false,
  intervalMs: 60_000,
  immediateFirstRun: true,
  marketHoursPolicy: "always-open",
  sessionTimezone: "America/New_York",
  sessionStart: "09:30",
  sessionEnd: "16:00",
};

describe("MarketHoursPolicyFactory.create", () => {
  it("builds AlwaysOpenMarketHoursPolicy for 'always-open'", () => {
    const policy = MarketHoursPolicyFactory.create("always-open", BASE_CONFIG);
    expect(policy).toBeInstanceOf(AlwaysOpenMarketHoursPolicy);
  });

  it("builds WeekdaySessionMarketHoursPolicy for 'weekday-session', wired from the config's session fields", () => {
    const policy = MarketHoursPolicyFactory.create("weekday-session", { ...BASE_CONFIG, marketHoursPolicy: "weekday-session" });
    expect(policy).toBeInstanceOf(WeekdaySessionMarketHoursPolicy);
    // 2026-01-05 (Mon) 14:30 UTC = 09:30 ET -> open, proving the factory actually threaded
    // sessionTimezone/sessionStart/sessionEnd through, not just constructing defaults.
    expect(policy.isMarketOpen(new Date("2026-01-05T14:30:00.000Z"))).toBe(true);
  });

  it("throws a descriptive error for an unsupported policy type", () => {
    expect(() => MarketHoursPolicyFactory.create("holiday-aware" as never, BASE_CONFIG)).toThrow(
      /Unsupported market hours policy "holiday-aware"/,
    );
  });
});
