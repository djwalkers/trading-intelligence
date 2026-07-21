// Milestone 7 — 24/7 Scheduler & Runtime Control. Deliberately NOT a reuse/extension of
// market-session.ts's `resolveMarketSession` — that function answers "which display label" (Asia/
// Europe/US/Crypto) for context shown to a user, always returning a label even outside real trading
// hours; this answers a plain boolean "should a cycle run right now at all," which is what
// TradingRuntime needs to decide whether to skip a tick. Different question, different callers —
// not the same abstraction wearing two names.

export interface MarketHoursPolicy {
  isMarketOpen(at: Date): boolean;
}

/** Always returns true — the correct policy for 24/7 markets (crypto, matching this pipeline's own
 * BTC-via-eToro default) and the default for deterministic tests that have no reason to care about
 * market hours at all. */
export class AlwaysOpenMarketHoursPolicy implements MarketHoursPolicy {
  isMarketOpen(_at: Date): boolean {
    return true;
  }
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]; // Monday-Friday

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseMinutesOfDay(hhmm: string, label: string): number {
  const match = HHMM_PATTERN.exec(hhmm);
  if (!match) {
    throw new Error(`${label} must be a 24-hour "HH:MM" time, received "${hhmm}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface WeekdaySessionMarketHoursPolicyOptions {
  /** IANA timezone name (e.g. "America/New_York") — sessionStart/sessionEnd are interpreted as
   * local wall-clock time in this zone. DST transitions are handled automatically by
   * `Intl.DateTimeFormat` (the actual UTC instant a given local HH:MM falls on shifts with DST,
   * exactly as a real exchange's posted hours do) — no manual offset arithmetic here. */
  timezone: string;
  /** 0 (Sunday) through 6 (Saturday). Defaults to Monday-Friday. */
  weekdays?: number[];
  /** 24-hour "HH:MM", local to `timezone`. Must be strictly before sessionEnd — this policy does
   * not support an overnight session that wraps past midnight. */
  sessionStart: string;
  sessionEnd: string;
}

/**
 * A simple, configurable single-session-per-day policy — "suitable for equities," per this
 * milestone's own scope, not a full exchange-holiday calendar (no holiday awareness, no early
 * closes, no pre/post-market session). Good enough to stop a scheduler from firing trading cycles
 * outside a configured window; not a substitute for a real market-hours data feed.
 */
export class WeekdaySessionMarketHoursPolicy implements MarketHoursPolicy {
  private readonly weekdays: Set<number>;
  private readonly startMinutes: number;
  private readonly endMinutes: number;
  private readonly formatter: Intl.DateTimeFormat;

  constructor(private readonly options: WeekdaySessionMarketHoursPolicyOptions) {
    this.weekdays = new Set(options.weekdays ?? DEFAULT_WEEKDAYS);
    this.startMinutes = parseMinutesOfDay(options.sessionStart, "sessionStart");
    this.endMinutes = parseMinutesOfDay(options.sessionEnd, "sessionEnd");
    if (this.startMinutes >= this.endMinutes) {
      throw new Error(
        `sessionStart ("${options.sessionStart}") must be strictly before sessionEnd ("${options.sessionEnd}").`,
      );
    }
    // Constructing here (not per isMarketOpen() call) both fails fast on an invalid IANA zone name
    // and avoids rebuilding an Intl.DateTimeFormat on every single check.
    try {
      this.formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: options.timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch (error) {
      throw new Error(
        `Invalid IANA timezone "${options.timezone}": ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  isMarketOpen(at: Date): boolean {
    const parts = this.formatter.formatToParts(at);
    const weekdayLabel = parts.find((p) => p.type === "weekday")?.value;
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    const weekdayIndex = weekdayLabel ? WEEKDAY_INDEX[weekdayLabel] : undefined;

    if (weekdayIndex === undefined || !this.weekdays.has(weekdayIndex)) return false;
    const minutesOfDay = hour * 60 + minute;
    return minutesOfDay >= this.startMinutes && minutesOfDay < this.endMinutes;
  }
}
