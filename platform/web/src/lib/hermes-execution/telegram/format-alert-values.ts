import type { BrokerProvider } from "../config";

// Telegram alert refinement — shared value formatting for the three curated alert templates
// (TRADE OPENED, TRADE CLOSED, DAILY TRADING SUMMARY). Deliberately its own small, pure module —
// no clock, no I/O — so every formatting rule is unit-testable in isolation from the two files that
// use it (telegram-alerting-audit-trail.ts, daily-account-summary-service.ts).
//
// Every timestamp is rendered in Europe/London (explicit `timeZone`, never the host process's own
// local timezone — a VPS may run in any timezone) with a short zone abbreviation (GMT/BST,
// DST-aware) exactly matching this feature's own required examples ("29 Jul 2026, 15:18 BST").

const LONDON_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

// en-CA gives an unambiguous YYYY-MM-DD grouping — used only as a comparable calendar-day key
// (daily-account-summary-service.ts's own restart-safe "already sent today" check), never displayed.
const LONDON_CALENDAR_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

const LONDON_HOUR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  hour12: false,
});

export function formatLondonTimestamp(iso: string): string {
  return LONDON_TIMESTAMP_FORMATTER.format(new Date(iso));
}

/** "2026-07-29" — the Europe/London calendar date `date` falls on, used only as a comparison key. */
export function formatLondonCalendarDate(date: Date): string {
  return LONDON_CALENDAR_DATE_FORMATTER.format(date);
}

/** The daily summary is sent once the LOCAL Europe/London clock hour reaches 21:00 — checked every
 * cycle (cheap), never scheduled via a separate timer, so it naturally survives a scheduler interval
 * that doesn't divide evenly into a day and never drifts against DST. */
export function isLondonTimeAtOrAfter21(date: Date): boolean {
  const hourPart = LONDON_HOUR_FORMATTER.formatToParts(date).find((part) => part.type === "hour");
  const hour = hourPart ? Number(hourPart.value) : NaN;
  return Number.isFinite(hour) && hour >= 21;
}

/** Plain price-level formatting (entry/exit/stop-loss/take-profit) — comma-thousands, always 2
 * decimal places, no currency symbol (an instrument's quote currency is not always GBP). */
export function formatPriceLevel(value: number): string {
  return value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A plain GBP amount, e.g. "£9.95" — never a forced sign (see formatSignedGbp for P/L figures,
 * which must show a leading "-" for a loss). */
export function formatGbp(value: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
}

/** A GBP P/L amount — "-£0.06" for a loss, "£9.95" for a gain (never a forced "+", matching the
 * feature's own required examples exactly: a positive figure carries no leading sign). */
export function formatSignedGbp(value: number): string {
  return value < 0 ? `-${formatGbp(Math.abs(value))}` : formatGbp(value);
}

/** "-0.56%" / "8.5%" — one decimal place is NOT enough to distinguish a small demo-account move
 * from zero (e.g. -£0.06 on a >£77k balance is a tiny percentage) — two decimal places, matching
 * the feature's own required example ("-0.56%"). */
export function formatSignedPercent(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** "1h 5m" / "3d 2h" / "42m" / "<1m" — never rounds a genuine multi-hour hold down to "0m", and
 * never shows more than two units (matches the feature's own required example exactly). */
export function formatHoldingDuration(ms: number): string {
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Maps every closeReason string this codebase actually produces (exit-monitor.ts's
 * `automatic-exit-${trigger}`, market-decision-runner.ts's `market-decision-sell`) to one of the
 * feature's own required clear labels — never the raw internal string. An unrecognised value still
 * gets a clear, honest label ("Other risk exit") rather than being surfaced verbatim or omitted. */
export function formatExitReasonLabel(exitReason: string): string {
  const normalized = exitReason.toLowerCase();
  if (normalized.includes("stop_loss") || normalized.includes("stop-loss")) return "Stop-loss";
  if (normalized.includes("take_profit") || normalized.includes("take-profit")) return "Take-profit";
  if (normalized.includes("kill_switch") || normalized.includes("kill-switch")) return "Kill switch";
  if (normalized.includes("max_holding") || normalized.includes("max-holding")) return "Maximum holding time";
  if (normalized.includes("manual")) return "Manual broker closure";
  // "market-decision-sell" (an approved SELL trade candidate's own execution — human or AUTO_DEMO
  // reviewed a fresh opposing decision) and "automatic-exit-opposing_signal" (the exit monitor's own
  // gated opposing-signal exit) both mean the same underlying thing: Hermes' own signal flipped to
  // SELL — only WHICH gate let it through differs, never the label a reader sees.
  if (normalized.includes("opposing_signal") || normalized.includes("opposing-signal") || normalized === "market-decision-sell") {
    return "Opposing signal";
  }
  return "Other risk exit";
}

/** A human-readable provider label for the daily summary's "Provider:" line — never the raw
 * machine value (e.g. "etoro-demo") a reader would have to decode. */
export function formatBrokerProviderLabel(provider: BrokerProvider): string {
  switch (provider) {
    case "local":
      return "Local Paper";
    case "hyperliquid-testnet":
      return "Hyperliquid Testnet";
    case "trading212-demo":
      return "Trading 212 Demo";
    case "etoro-demo":
      return "eToro Demo";
    default: {
      const exhaustive: never = provider;
      return String(exhaustive);
    }
  }
}
