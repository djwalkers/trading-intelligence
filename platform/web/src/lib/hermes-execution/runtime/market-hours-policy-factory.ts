import type { MarketHoursPolicyType, TradingSchedulerConfig } from "../config";
import { AlwaysOpenMarketHoursPolicy, WeekdaySessionMarketHoursPolicy, type MarketHoursPolicy } from "./market-hours-policy";

// Milestone 7 — 24/7 Scheduler & Runtime Control. Same "one place a config value maps to a
// concrete implementation" pattern as BrokerFactory/MarketDataProviderFactory — config.ts holds
// only raw, primitive scheduler config; this is the one place that config becomes a live
// MarketHoursPolicy object.

export const MarketHoursPolicyFactory = {
  create(policyType: MarketHoursPolicyType, config: TradingSchedulerConfig): MarketHoursPolicy {
    if (policyType === "always-open") {
      return new AlwaysOpenMarketHoursPolicy();
    }
    if (policyType === "weekday-session") {
      return new WeekdaySessionMarketHoursPolicy({
        timezone: config.sessionTimezone,
        sessionStart: config.sessionStart,
        sessionEnd: config.sessionEnd,
      });
    }
    throw new Error(`Unsupported market hours policy "${policyType as string}" — supported: always-open, weekday-session.`);
  },
};
