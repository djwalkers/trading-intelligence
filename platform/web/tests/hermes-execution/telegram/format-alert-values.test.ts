import { describe, expect, it } from "vitest";
import {
  formatBrokerProviderLabel,
  formatExitReasonLabel,
  formatGbp,
  formatHoldingDuration,
  formatLondonCalendarDate,
  formatLondonTimestamp,
  formatPriceLevel,
  formatSignedGbp,
  formatSignedPercent,
  isLondonTimeAtOrAfter21,
} from "@/lib/hermes-execution/telegram/format-alert-values";

describe("formatLondonTimestamp", () => {
  it("renders in Europe/London local time with a short zone abbreviation, matching the feature's own required example", () => {
    // 2026-07-29T14:18:00Z is British Summer Time (UTC+1) -> 15:18 BST.
    expect(formatLondonTimestamp("2026-07-29T14:18:00.000Z")).toBe("29 Jul 2026, 15:18 BST");
  });

  it("renders GMT (not BST) outside daylight saving", () => {
    expect(formatLondonTimestamp("2026-01-15T14:18:00.000Z")).toBe("15 Jan 2026, 14:18 GMT");
  });
});

describe("formatLondonCalendarDate", () => {
  it("returns the Europe/London calendar date, which can differ from the UTC date near midnight", () => {
    // 2026-07-29T23:30:00Z is 2026-07-30T00:30 BST — the NEXT London calendar day.
    expect(formatLondonCalendarDate(new Date("2026-07-29T23:30:00.000Z"))).toBe("2026-07-30");
  });
});

describe("isLondonTimeAtOrAfter21", () => {
  it("is false before 21:00 London time", () => {
    // 19:00 BST
    expect(isLondonTimeAtOrAfter21(new Date("2026-07-29T18:00:00.000Z"))).toBe(false);
  });

  it("is true at exactly 21:00 London time", () => {
    // 21:00 BST == 20:00 UTC
    expect(isLondonTimeAtOrAfter21(new Date("2026-07-29T20:00:00.000Z"))).toBe(true);
  });

  it("stays true later in the evening", () => {
    // 22:00 BST == 21:00 UTC
    expect(isLondonTimeAtOrAfter21(new Date("2026-07-29T21:00:00.000Z"))).toBe(true);
  });
});

describe("formatPriceLevel", () => {
  it("comma-thousands, always 2 decimal places, no currency symbol", () => {
    expect(formatPriceLevel(64_208.29)).toBe("64,208.29");
    expect(formatPriceLevel(1_898.6)).toBe("1,898.60");
  });
});

describe("formatGbp / formatSignedGbp", () => {
  it("formatGbp never forces a sign", () => {
    expect(formatGbp(9.95)).toBe("£9.95");
  });

  it("formatSignedGbp shows a leading '-' for a loss, no forced '+' for a gain", () => {
    expect(formatSignedGbp(-0.06)).toBe("-£0.06");
    expect(formatSignedGbp(12.5)).toBe("£12.50");
  });
});

describe("formatSignedPercent", () => {
  it("matches the feature's own required example exactly", () => {
    expect(formatSignedPercent(-0.56)).toBe("-0.56%");
    expect(formatSignedPercent(8.5)).toBe("8.50%");
  });
});

describe("formatHoldingDuration", () => {
  it("matches the feature's own required example exactly (1h 5m)", () => {
    expect(formatHoldingDuration(65 * 60_000)).toBe("1h 5m");
  });

  it("shows minutes only under an hour", () => {
    expect(formatHoldingDuration(42 * 60_000)).toBe("42m");
  });

  it("shows days + hours for a multi-day hold, never more than two units", () => {
    expect(formatHoldingDuration((2 * 24 + 3) * 60 * 60_000)).toBe("2d 3h");
  });

  it("shows '<1m' for a sub-minute hold, never '0m'", () => {
    expect(formatHoldingDuration(30_000)).toBe("<1m");
  });
});

describe("formatExitReasonLabel", () => {
  it.each([
    ["automatic-exit-stop_loss", "Stop-loss"],
    ["automatic-exit-take_profit", "Take-profit"],
    ["automatic-exit-opposing_signal", "Opposing signal"],
    ["market-decision-sell", "Opposing signal"],
    ["automatic-exit-max_holding_duration", "Maximum holding time"],
    ["automatic-exit-kill_switch", "Kill switch"],
    ["automatic-exit-strategy_disabled", "Other risk exit"],
    ["manual-broker-closure", "Manual broker closure"],
    ["something-entirely-unrecognised", "Other risk exit"],
  ])("%s -> %s", (raw, expected) => {
    expect(formatExitReasonLabel(raw)).toBe(expected);
  });
});

describe("formatBrokerProviderLabel", () => {
  it.each([
    ["etoro-demo", "eToro Demo"],
    ["local", "Local Paper"],
    ["hyperliquid-testnet", "Hyperliquid Testnet"],
    ["trading212-demo", "Trading 212 Demo"],
  ] as const)("%s -> %s", (provider, expected) => {
    expect(formatBrokerProviderLabel(provider)).toBe(expected);
  });
});
