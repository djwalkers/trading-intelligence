import type { Candle } from "../types";
import { MarketDataProviderError, type MarketDataFailureDetail } from "./market-data-provider";
import { resolveMarketSession } from "../market-session";
import { WeekdaySessionMarketHoursPolicy, type MarketHoursPolicy } from "../runtime/market-hours-policy";
import {
  DEFAULT_EQUITY_SESSION_TIMEZONE,
  DEFAULT_EQUITY_SESSION_START,
  DEFAULT_EQUITY_SESSION_END,
} from "../market-session-defaults";

// Phase 2A — Real Historical Candles for Live Market Data. The single source of truth for "what
// timeframes does this pipeline's one historical-candle source (eToro) support" and "is a candle
// history returned by that source trustworthy enough to feed indicators." Deliberately provider-
// agnostic in *name* (nothing here mentions eToro) even though the granularity list is chosen to
// match eToro's own documented interval enum today — a future second historical-candle provider
// would need this list to grow, not a parallel one to appear.

export const SUPPORTED_MARKET_TIMEFRAMES = ["1m", "5m", "10m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type MarketTimeframe = (typeof SUPPORTED_MARKET_TIMEFRAMES)[number];

export const TIMEFRAME_DURATIONS_MS: Record<MarketTimeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 24 * 3_600_000,
  "1w": 7 * 24 * 3_600_000,
};

// The longest period any indicator in technical-indicators.ts computes today is EMA50
// (market-intelligence-builder.ts's EMA_LONG_PERIOD) — this floor is set to match it so a candle
// history that validation lets through is always at least long enough to seed a genuine EMA50
// (calculateEma's own documented fallback — a plain average of everything given — only kicks in
// below the requested period). Deliberately not imported from market-intelligence-builder.ts: a
// hard-coded, documented number here is simpler and avoids a coupling this module doesn't
// otherwise need. Also enforced at config-build time (config.ts's own HERMES_MARKET_CANDLE_COUNT
// minimum), so a misconfiguration fails at startup, not on the first live trading cycle.
export const MIN_REQUIRED_CANDLES = 50;

// A real feed's candle boundaries are never exact to the millisecond — this tolerance absorbs
// that jitter before a gap is called a genuine missing candle, without being so loose it would
// miss an actually-missing bar (e.g. a whole skipped hourly candle is still >150% of its own
// expected interval).
const GAP_TOLERANCE_RATIO = 1.5;

// Remediation pass (senior review finding C3) — no legitimate market closure (a weekend, even a
// cluster of consecutive holidays) plausibly lasts longer than this — a gap wider than it is
// presumptively a genuine data problem (a corrupted/malformed timestamp, a real multi-day outage),
// never something isGapExplainedByMarketClosure should attempt to verify interval-by-interval at
// all. Checked BEFORE any interval-stepping work happens, so a pathological gap (e.g. a corrupted
// timestamp producing a multi-year span) is rejected immediately, in O(1), rather than iterating.
const MAX_EXPLAINABLE_GAP_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

// Remediation pass (finding C3) — defence in depth beyond MAX_EXPLAINABLE_GAP_MS above: an
// absolute ceiling on how many expected-interval boundaries isGapExplainedByMarketClosure will
// ever check before giving up. Never silently treated as "explained" when this cap is hit — see
// that function's own doc comment; hitting it means REJECT, not accept.
const MAX_BOUNDARY_CHECKS = 20_000;

// Hardening pass — equity candle validation backlog fix. Weekend/market-closed gaps (e.g. a
// Friday-16:00-close to Monday-09:30-open gap for AAPL/MSFT/NVDA) were previously rejected as
// "missing candles" — genuinely wrong, since no candle was ever expected during a closed session.
// Crypto is unaffected: resolveMarketSession's own crypto check (market-session.ts) is consulted
// first and always wins, so BTC/ETH/etc. continue to require perfectly continuous candles with no
// leniency of any kind, exactly as before this change.
//
// A standard US equities regular session — the sensible default for "an equity, session hours
// unspecified," overridable per call via ValidateHistoricalCandlesOptions.equityMarketHoursPolicy
// below. Deliberately reuses runtime/market-hours-policy.ts's own WeekdaySessionMarketHoursPolicy
// rather than a second, parallel session-hours implementation, and (remediation pass, finding M5)
// the shared ../market-session-defaults.ts constants rather than its own hard-coded literals — the
// same defaults config.ts's own HERMES_MARKET_HOURS_* env vars fall back to.
//
// Known limitation, inherited from WeekdaySessionMarketHoursPolicy itself (not new here): no
// exchange-holiday calendar. A gap spanning a real market holiday (e.g. Thanksgiving, a day the
// market is closed but this policy's own Mon-Fri/09:30-16:00 rule would otherwise expect it open) is
// NOT currently distinguished from a genuine missing candle and would still be rejected. Closing
// this gap only requires passing a holiday-aware MarketHoursPolicy via
// `equityMarketHoursPolicy` — this function's own gap-checking logic never needs to change for that.
const DEFAULT_EQUITY_MARKET_HOURS_POLICY: MarketHoursPolicy = new WeekdaySessionMarketHoursPolicy({
  timezone: DEFAULT_EQUITY_SESSION_TIMEZONE,
  sessionStart: DEFAULT_EQUITY_SESSION_START,
  sessionEnd: DEFAULT_EQUITY_SESSION_END,
});

export interface ValidateHistoricalCandlesOptions {
  timeframe: MarketTimeframe;
  /** Upper bound (seconds) on how old the latest candle may be — see config.ts's own
   * LiveMarketDataConfig.maxCandleAgeSeconds doc comment for how this is derived/defaulted. */
  maxCandleAgeSeconds: number;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
  /** Hardening pass — equity candle validation backlog fix. Consulted ONLY for non-crypto
   * instruments (resolveMarketSession's own crypto check always wins first) to decide whether a
   * gap between two consecutive candles is fully explained by ordinary market-closed time (a
   * weekend, an overnight close) rather than a genuine missing candle — see
   * isGapExplainedByMarketClosure's own doc comment. Defaults to a standard US equities session
   * (Mon-Fri, 09:30-16:00 America/New_York) when omitted. */
  equityMarketHoursPolicy?: MarketHoursPolicy;
}

export type GapClosureCheckResult =
  | { explained: true }
  | {
      explained: false;
      /** "malformed-timestamp": prevMs/currMs did not parse to a finite instant at all — never
       * treated as "explained", regardless of how small the nominal gap looks.
       * "exceeds-maximum-explainable-gap": wider than MAX_EXPLAINABLE_GAP_MS — rejected in O(1),
       * before any interval-stepping work is attempted.
       * "exceeds-boundary-check-limit": within the gap ceiling, but would need more than
       * MAX_BOUNDARY_CHECKS interval boundaries to verify — rejected rather than silently accepted
       * once the cap is hit (defence in depth beyond the gap-duration ceiling above).
       * "in-session-gap": every check ran to completion and found at least one expected boundary
       * within market-open hours — a genuine missing candle. */
      reason: "malformed-timestamp" | "exceeds-maximum-explainable-gap" | "exceeds-boundary-check-limit" | "in-session-gap";
    };

/**
 * True when EVERY expected candle boundary strictly between `prevMs` and `currMs` (stepped by
 * `expectedIntervalMs`) falls outside market-open hours — meaning the entire gap is accounted for
 * by ordinary non-trading time, never a genuine missing candle. False the moment even ONE expected
 * boundary falls inside market hours (a real candle should have existed then, and didn't). Pure —
 * takes the policy as a parameter, never constructs one itself.
 *
 * Remediation pass (senior review finding C3) — bounded, deterministic work in every case: a
 * malformed timestamp or a gap wider than MAX_EXPLAINABLE_GAP_MS is rejected in O(1), before any
 * interval-stepping loop ever runs; a gap within that ceiling is still capped at
 * MAX_BOUNDARY_CHECKS iterations, rejected (never silently accepted) if that cap would be
 * exceeded. The prior implementation stepped by `expectedIntervalMs` with no cap at all — for a
 * fine timeframe (e.g. "1m") and a large enough gap (a realistic consequence of a single
 * corrupted/malformed upstream timestamp, not a contrived attack), that loop could run for
 * millions of iterations, each calling Intl.DateTimeFormat.formatToParts(), synchronously
 * blocking the event loop. This function now does bounded work regardless of its inputs.
 */
function isGapExplainedByMarketClosure(
  prevMs: number,
  currMs: number,
  expectedIntervalMs: number,
  marketHoursPolicy: MarketHoursPolicy,
): GapClosureCheckResult {
  if (!Number.isFinite(prevMs) || !Number.isFinite(currMs)) {
    return { explained: false, reason: "malformed-timestamp" };
  }

  const gapMs = currMs - prevMs;
  if (gapMs > MAX_EXPLAINABLE_GAP_MS) {
    return { explained: false, reason: "exceeds-maximum-explainable-gap" };
  }

  const boundaryCount = Math.ceil(gapMs / expectedIntervalMs);
  if (boundaryCount > MAX_BOUNDARY_CHECKS) {
    return { explained: false, reason: "exceeds-boundary-check-limit" };
  }

  for (let boundaryMs = prevMs + expectedIntervalMs; boundaryMs < currMs; boundaryMs += expectedIntervalMs) {
    if (marketHoursPolicy.isMarketOpen(new Date(boundaryMs))) {
      return { explained: false, reason: "in-session-gap" };
    }
  }
  return { explained: true };
}

/**
 * Repeated-Telegram-alert fix. `structuredDetail` carries the same canonical facts
 * (category/timeframe/gap boundaries) the message text below describes in prose — the ONE place
 * every validation failure attaches identity data an incident tracker can fingerprint on, without
 * ever having to parse this function's own free-text message back apart.
 */
function fail(instrument: string, detail: string, structuredDetail?: MarketDataFailureDetail): never {
  throw new MarketDataProviderError(`Invalid historical candle history for "${instrument}": ${detail}`, "malformed-data", { detail: structuredDetail });
}

/** One detected gap between two consecutive (sorted) candles, wider than the timeframe's own
 * tolerance — whether or not it turned out to be explained by a market closure. Diagnostic only;
 * never thrown or used to reject anything itself (see diagnoseCandleGaps's own doc comment). */
export interface CandleGapDiagnostic {
  prevTimestamp: string;
  currTimestamp: string;
  gapMs: number;
  expectedIntervalMs: number;
}

export interface CandleGapDiagnosticReport {
  requestedInstrument: string;
  requestedTimeframe: MarketTimeframe;
  rawCandleCount: number;
  rawTimestamps: string[];
  normalisedTimestamps: string[];
  duplicateTimestamps: string[];
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  gaps: CandleGapDiagnostic[];
}

/**
 * Candle-gap production incident fix. A pure, side-effect-free diagnostic pass over a raw candle
 * array — deliberately NEVER thrown from, NEVER used to reject anything (that remains
 * validateHistoricalCandles's own, unmodified job) — so callers (LiveMarketDataProvider) can log a
 * full, structured picture of exactly what was received and where every gap sits, whether or not
 * the array as a whole ends up passing validation. Reports ALL gaps found, not just the first one
 * validateHistoricalCandles itself would throw on — deliberately more complete than the thrown
 * error's own single-gap message, so a genuine multi-gap incident is never under-reported.
 *
 * `rawTimestamps` preserves whatever order the candles were supplied in (the provider's own raw
 * response order); `normalisedTimestamps` is the same set, chronologically sorted — comparing the
 * two directly shows whether the provider itself returned candles out of order, independent of
 * whether any candle is missing. Never logs OHLCV values, credentials, or request headers — only
 * timestamps and counts.
 */
export function diagnoseCandleGaps(
  candles: readonly Candle[],
  instrument: string,
  timeframe: MarketTimeframe,
): CandleGapDiagnosticReport {
  const rawTimestamps = candles.map((c) => c.timestamp);

  const seen = new Set<string>();
  const duplicateTimestamps: string[] = [];
  for (const timestamp of rawTimestamps) {
    if (seen.has(timestamp)) duplicateTimestamps.push(timestamp);
    seen.add(timestamp);
  }

  const normalisedTimestamps = [...rawTimestamps].sort((a, b) => a.localeCompare(b));
  const expectedIntervalMs = TIMEFRAME_DURATIONS_MS[timeframe];

  const gaps: CandleGapDiagnostic[] = [];
  for (let i = 1; i < normalisedTimestamps.length; i++) {
    const prevTimestamp = normalisedTimestamps[i - 1]!;
    const currTimestamp = normalisedTimestamps[i]!;
    const prevMs = Date.parse(prevTimestamp);
    const currMs = Date.parse(currTimestamp);
    if (!Number.isFinite(prevMs) || !Number.isFinite(currMs)) continue; // malformed timestamps reported by validateHistoricalCandles itself, not duplicated here
    const gapMs = currMs - prevMs;
    if (gapMs > expectedIntervalMs * GAP_TOLERANCE_RATIO) {
      gaps.push({ prevTimestamp, currTimestamp, gapMs, expectedIntervalMs });
    }
  }

  return {
    requestedInstrument: instrument,
    requestedTimeframe: timeframe,
    rawCandleCount: candles.length,
    rawTimestamps,
    normalisedTimestamps,
    duplicateTimestamps,
    firstTimestamp: normalisedTimestamps[0],
    lastTimestamp: normalisedTimestamps[normalisedTimestamps.length - 1],
    gaps,
  };
}

/**
 * Rejects (throws MarketDataProviderError) rather than silently dropping, trimming, or repairing
 * anything — a caller (LiveMarketDataProvider) that receives no error back may trust the candles
 * completely. Checks, in order: minimum count, per-candle NaN/non-finite/non-positive OHLC,
 * malformed OHLC (high < low, or open/close outside [low, high]), per-candle volume (only when
 * present — see below), duplicate timestamps, missing candles (a gap between consecutive candles
 * wider than the selected timeframe tolerates), and staleness (the latest candle older than
 * maxCandleAgeSeconds).
 *
 * Volume is deliberately NOT in the same always-required bucket as OHLC/timestamp (Phase 2A
 * follow-up — Volume Nullability): CONFIRMED live that eToro's historical-candle endpoint can
 * return a null volume despite its own documented schema declaring the field required/numeric.
 * Candle.volume is `undefined` for "genuinely unknown" (see its own doc comment) — this function
 * validates it only when present (finite, non-negative), and never rejects a candle for volume
 * being absent, and never substitutes a value for it.
 */
export function validateHistoricalCandles(candles: Candle[], instrument: string, options: ValidateHistoricalCandlesOptions): void {
  const now = options.now ?? new Date();

  if (candles.length < MIN_REQUIRED_CANDLES) {
    fail(instrument, `received ${candles.length} candle(s), need at least ${MIN_REQUIRED_CANDLES}.`, {
      category: "insufficient-candle-count",
      timeframe: options.timeframe,
    });
  }

  const seenTimestamps = new Set<string>();
  for (const candle of candles) {
    const { timestamp, open, high, low, close, volume } = candle;

    if (seenTimestamps.has(timestamp)) {
      fail(instrument, `duplicate candle timestamp "${timestamp}".`, { category: "duplicate-timestamp", timeframe: options.timeframe });
    }
    seenTimestamps.add(timestamp);

    // Remediation pass (finding C3) — "reject unreasonable or malformed spans early": a timestamp
    // that doesn't even parse to a finite instant must never reach the gap-check below at all
    // (where, pre-fix, an unparseable pair could be silently treated as "explained by closure" —
    // see isGapExplainedByMarketClosure's own malformed-timestamp guard, kept as defence in depth,
    // never the only check).
    if (!Number.isFinite(Date.parse(timestamp))) {
      fail(instrument, `unparseable timestamp "${timestamp}".`, { category: "malformed-candle", timeframe: options.timeframe });
    }

    // OHLC — always mandatory and finite, unlike volume below.
    for (const [name, value] of [
      ["open", open],
      ["high", high],
      ["low", low],
      ["close", close],
    ] as const) {
      if (!Number.isFinite(value)) {
        fail(instrument, `non-finite ${name} (${value}) at ${timestamp}.`, { category: "malformed-candle", timeframe: options.timeframe });
      }
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      fail(instrument, `non-positive OHLC price at ${timestamp} (open=${open}, high=${high}, low=${low}, close=${close}).`, {
        category: "malformed-candle",
        timeframe: options.timeframe,
      });
    }
    if (high < low) {
      fail(instrument, `high (${high}) below low (${low}) at ${timestamp}.`, { category: "malformed-candle", timeframe: options.timeframe });
    }
    if (open > high || open < low || close > high || close < low) {
      fail(instrument, `open/close outside the [low, high] range at ${timestamp} (open=${open}, close=${close}, low=${low}, high=${high}).`, {
        category: "malformed-candle",
        timeframe: options.timeframe,
      });
    }

    // Volume — optional. Only validated when present; absence is never an error and is never
    // filled in with a substitute value (see this function's own doc comment above).
    if (volume !== undefined) {
      if (!Number.isFinite(volume)) {
        fail(instrument, `non-finite volume (${volume}) at ${timestamp}.`, { category: "malformed-candle", timeframe: options.timeframe });
      }
      if (volume < 0) {
        fail(instrument, `negative volume (${volume}) at ${timestamp}.`, { category: "malformed-candle", timeframe: options.timeframe });
      }
    }
  }

  // Everything below reads the candles in chronological order regardless of what order the source
  // returned them in — sorting here never repairs the data itself (an out-of-order response with
  // otherwise-valid candles is not an error condition this function flags), it only makes the gap/
  // staleness checks meaningful.
  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const expectedIntervalMs = TIMEFRAME_DURATIONS_MS[options.timeframe];
  // Hardening pass — equity candle validation backlog fix. Crypto's own "Crypto Always Open"
  // session (market-session.ts) always wins first — determined once per call, from the instrument
  // name alone, never affected by `now`. Crypto therefore gets ZERO leniency below, exactly as
  // before this change: every gap for BTC/ETH/etc. is still judged purely against
  // GAP_TOLERANCE_RATIO.
  const isCrypto = resolveMarketSession(instrument, now) === "Crypto Always Open";
  const equityMarketHoursPolicy = options.equityMarketHoursPolicy ?? DEFAULT_EQUITY_MARKET_HOURS_POLICY;

  for (let i = 1; i < sorted.length; i++) {
    const prevTimestamp = sorted[i - 1]!.timestamp;
    const currTimestamp = sorted[i]!.timestamp;
    const prevMs = Date.parse(prevTimestamp);
    const currMs = Date.parse(currTimestamp);
    const gapMs = currMs - prevMs;
    if (gapMs <= expectedIntervalMs * GAP_TOLERANCE_RATIO) continue;

    if (!isCrypto) {
      const closureCheck = isGapExplainedByMarketClosure(prevMs, currMs, expectedIntervalMs, equityMarketHoursPolicy);
      if (closureCheck.explained) {
        // Every expected candle boundary this gap skips over falls outside market hours (a
        // weekend, an overnight close, ...) — no candle was ever expected during that time, so
        // this is not a genuine missing-candle condition. Never applies to crypto (isCrypto is
        // false-gated above).
        continue;
      }
      if (closureCheck.reason === "exceeds-maximum-explainable-gap" || closureCheck.reason === "exceeds-boundary-check-limit") {
        fail(
          instrument,
          `gap too large to validate as an ordinary market closure — a ${gapMs}ms gap between ${prevTimestamp} and ` +
            `${currTimestamp} (${closureCheck.reason}). Treating this as a likely data-quality problem rather than ` +
            `attempting to verify it interval-by-interval.`,
          { category: "missing-candles", timeframe: options.timeframe, missingIntervalStartMs: prevMs, missingIntervalEndMs: currMs },
        );
      }
    }

    fail(
      instrument,
      `missing candle(s) — a ${gapMs}ms gap between ${prevTimestamp} and ${currTimestamp} exceeds the expected ${options.timeframe} interval (${expectedIntervalMs}ms).`,
      { category: "missing-candles", timeframe: options.timeframe, missingIntervalStartMs: prevMs, missingIntervalEndMs: currMs },
    );
  }

  const latest = sorted[sorted.length - 1]!;
  const ageSeconds = (now.getTime() - Date.parse(latest.timestamp)) / 1000;
  if (ageSeconds > options.maxCandleAgeSeconds) {
    // Deliberately does NOT include `ageSeconds`/`now` in the structured detail — age grows every
    // cycle even while the underlying cause (a stalled feed) is completely unchanged, which would
    // otherwise make every cycle's fingerprint different and defeat incident deduplication entirely.
    fail(
      instrument,
      `stale data — the latest candle (${latest.timestamp}) is ${Math.round(ageSeconds)}s old, exceeding the configured max age of ${options.maxCandleAgeSeconds}s.`,
      { category: "stale-data", timeframe: options.timeframe },
    );
  }
}
