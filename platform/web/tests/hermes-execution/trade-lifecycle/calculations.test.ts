import { describe, expect, it } from "vitest";
import {
  calculateHoldingDurationMs,
  calculateRealisedPnl,
  calculateRealisedPnlPercent,
  calculateUnrealizedPnl,
  updateExcursionValues,
} from "@/lib/hermes-execution/trade-lifecycle/calculations";

describe("calculateRealisedPnl — long (BUY)", () => {
  it("is positive when exitPrice is above entryPrice", () => {
    expect(calculateRealisedPnl("UNITS", "BUY", 100, 110, 10)).toBeCloseTo(100, 10);
  });

  it("is negative when exitPrice is below entryPrice", () => {
    expect(calculateRealisedPnl("UNITS", "BUY", 100, 90, 10)).toBeCloseTo(-100, 10);
  });

  it("is zero when exitPrice equals entryPrice", () => {
    expect(calculateRealisedPnl("UNITS", "BUY", 100, 100, 10)).toBe(0);
  });
});

describe("calculateRealisedPnl — short (SELL)", () => {
  it("is positive when exitPrice is below entryPrice", () => {
    expect(calculateRealisedPnl("UNITS", "SELL", 100, 90, 10)).toBeCloseTo(100, 10);
  });

  it("is negative when exitPrice is above entryPrice", () => {
    expect(calculateRealisedPnl("UNITS", "SELL", 100, 110, 10)).toBeCloseTo(-100, 10);
  });

  it("is the exact negation of the equivalent long trade", () => {
    const long = calculateRealisedPnl("UNITS", "BUY", 50, 55, 20);
    const short = calculateRealisedPnl("UNITS", "SELL", 50, 55, 20);
    expect(short).toBeCloseTo(-long, 10);
  });
});

describe("calculateRealisedPnl — invalid input handling", () => {
  it.each([
    ["entryPrice", () => calculateRealisedPnl("UNITS", "BUY", 0, 100, 10)],
    ["entryPrice", () => calculateRealisedPnl("UNITS", "BUY", -5, 100, 10)],
    ["entryPrice", () => calculateRealisedPnl("UNITS", "BUY", Number.NaN, 100, 10)],
    ["exitPrice", () => calculateRealisedPnl("UNITS", "BUY", 100, 0, 10)],
    ["exitPrice", () => calculateRealisedPnl("UNITS", "BUY", 100, Number.POSITIVE_INFINITY, 10)],
    ["quantity", () => calculateRealisedPnl("UNITS", "BUY", 100, 110, 0)],
    ["quantity", () => calculateRealisedPnl("UNITS", "BUY", 100, 110, -1)],
  ])("throws for an invalid %s", (_label, run) => {
    expect(run).toThrow();
  });
});

describe("calculateRealisedPnlPercent", () => {
  it("computes P/L against the absolute entry notional for a long trade", () => {
    // entryNotional = 100 * 10 = 1000; pnl = (110-100)*10 = 100 -> 10%
    expect(calculateRealisedPnlPercent("UNITS", "BUY", 100, 110, 10)).toBeCloseTo(10, 10);
  });

  it("computes P/L against the absolute entry notional for a short trade", () => {
    // entryNotional = 100 * 10 = 1000; pnl = (100-90)*10 = 100 -> 10%
    expect(calculateRealisedPnlPercent("UNITS", "SELL", 100, 90, 10)).toBeCloseTo(10, 10);
  });

  it("is negative for a losing trade", () => {
    expect(calculateRealisedPnlPercent("UNITS", "BUY", 100, 90, 10)).toBeCloseTo(-10, 10);
  });

  it("throws rather than dividing by a zero/invalid notional", () => {
    expect(() => calculateRealisedPnlPercent("UNITS", "BUY", 0, 100, 10)).toThrow();
    expect(() => calculateRealisedPnlPercent("UNITS", "BUY", 100, 110, 0)).toThrow();
  });
});

describe("calculateHoldingDurationMs", () => {
  it("returns the millisecond difference between two ISO timestamps", () => {
    expect(calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z")).toBe(5 * 60 * 1000);
  });

  it("returns zero for identical timestamps", () => {
    expect(calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
  });

  it("throws for an unparseable openedAt", () => {
    expect(() => calculateHoldingDurationMs("not-a-date", "2026-01-01T00:00:00.000Z")).toThrow(/openedAt/);
  });

  it("throws for an unparseable closedAt", () => {
    expect(() => calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "not-a-date")).toThrow(/closedAt/);
  });

  it("throws when closedAt is before openedAt", () => {
    expect(() => calculateHoldingDurationMs("2026-01-01T00:05:00.000Z", "2026-01-01T00:00:00.000Z")).toThrow(
      /negative holding duration/,
    );
  });
});

describe("calculateUnrealizedPnl", () => {
  it("matches calculateRealisedPnl when the current price is treated as the exit price", () => {
    expect(calculateUnrealizedPnl("UNITS", "BUY", 100, 105, 10)).toBe(calculateRealisedPnl("UNITS", "BUY", 100, 105, 10));
    expect(calculateUnrealizedPnl("UNITS", "SELL", 100, 95, 10)).toBe(calculateRealisedPnl("UNITS", "SELL", 100, 95, 10));
  });
});

describe("updateExcursionValues — long trade", () => {
  const zero = { maximumFavourableExcursion: 0, maximumAdverseExcursion: 0 };

  it("favourable movement (price above entry) grows MFE and leaves MAE at zero", () => {
    const next = updateExcursionValues("UNITS", "BUY", 100, 110, 10, zero);
    expect(next.maximumFavourableExcursion).toBeCloseTo(100, 10); // (110-100)*10
    expect(next.maximumAdverseExcursion).toBe(0);
  });

  it("adverse movement (price below entry) grows MAE (more negative) and leaves MFE at zero", () => {
    const next = updateExcursionValues("UNITS", "BUY", 100, 90, 10, zero);
    expect(next.maximumFavourableExcursion).toBe(0);
    expect(next.maximumAdverseExcursion).toBeCloseTo(-100, 10); // (90-100)*10
  });

  it("is monotonic — a retracement never shrinks a previously recorded MFE", () => {
    const afterRun = updateExcursionValues("UNITS", "BUY", 100, 120, 10, zero); // MFE=200
    const afterPullback = updateExcursionValues("UNITS", "BUY", 100, 105, 10, afterRun); // unrealized only 50 now
    expect(afterPullback.maximumFavourableExcursion).toBeCloseTo(200, 10);
    expect(afterPullback.maximumAdverseExcursion).toBe(0);
  });

  it("is monotonic — a bounce never shrinks a previously recorded MAE", () => {
    const afterDrop = updateExcursionValues("UNITS", "BUY", 100, 80, 10, zero); // MAE=-200
    const afterBounce = updateExcursionValues("UNITS", "BUY", 100, 95, 10, afterDrop); // unrealized only -50 now
    expect(afterBounce.maximumAdverseExcursion).toBeCloseTo(-200, 10);
    expect(afterBounce.maximumFavourableExcursion).toBe(0);
  });

  it("tracks both MFE and MAE across a price path that visits both extremes", () => {
    let excursion = zero;
    for (const price of [100, 115, 90, 105]) {
      excursion = updateExcursionValues("UNITS", "BUY", 100, price, 10, excursion);
    }
    expect(excursion.maximumFavourableExcursion).toBeCloseTo(150, 10); // best: (115-100)*10
    expect(excursion.maximumAdverseExcursion).toBeCloseTo(-100, 10); // worst: (90-100)*10
  });
});

describe("updateExcursionValues — short trade", () => {
  const zero = { maximumFavourableExcursion: 0, maximumAdverseExcursion: 0 };

  it("favourable movement for a short is a price DROP below entry", () => {
    const next = updateExcursionValues("UNITS", "SELL", 100, 90, 10, zero);
    expect(next.maximumFavourableExcursion).toBeCloseTo(100, 10); // (100-90)*10
    expect(next.maximumAdverseExcursion).toBe(0);
  });

  it("adverse movement for a short is a price RISE above entry", () => {
    const next = updateExcursionValues("UNITS", "SELL", 100, 110, 10, zero);
    expect(next.maximumFavourableExcursion).toBe(0);
    expect(next.maximumAdverseExcursion).toBeCloseTo(-100, 10); // (100-110)*10
  });

  it("tracks both MFE and MAE across a price path that visits both extremes", () => {
    let excursion = zero;
    for (const price of [100, 85, 120, 95]) {
      excursion = updateExcursionValues("UNITS", "SELL", 100, price, 10, excursion);
    }
    expect(excursion.maximumFavourableExcursion).toBeCloseTo(150, 10); // best: (100-85)*10
    expect(excursion.maximumAdverseExcursion).toBeCloseTo(-200, 10); // worst: (100-120)*10
  });
});

// Broker Sizing Semantic Fix — "NOTIONAL" is eToro's CFD "amount" semantics: `quantity` IS the
// invested notional, never a BTC/asset unit count, so P/L must be the notional's percentage return,
// not price-delta-times-units (the UNITS formula above). These match EtoroDemoBroker.closePosition's
// own inline formula exactly (percentReturn x quantity) — proving the generalised, shared formula
// here never treats eToro notional as asset units.
describe("calculateRealisedPnl — NOTIONAL sizing mode (eToro-style CFD amount)", () => {
  it("is quantity x percentReturn for a long trade, not price-delta x quantity", () => {
    // BTC entry 65,000 -> exit 71,500 is a +10% move; on a NOTIONAL amount of 10, pnl = 1, not
    // (71500-65000)*10 = 65000 (what the UNITS formula would wrongly produce).
    const pnl = calculateRealisedPnl("NOTIONAL", "BUY", 65_000, 71_500, 10);
    expect(pnl).toBeCloseTo(1, 10);
  });

  it("is negative for an adverse move on a long trade", () => {
    const pnl = calculateRealisedPnl("NOTIONAL", "BUY", 65_000, 58_500, 10); // -10% move
    expect(pnl).toBeCloseTo(-1, 10);
  });

  it("matches EtoroDemoBroker.closePosition's own inline percent-return formula exactly", () => {
    const entryPrice = 65_114.2;
    const exitPrice = 66_000;
    const quantity = 10;
    const direction = 1; // BUY
    const percentReturn = ((exitPrice - entryPrice) / entryPrice) * direction;
    const brokerFormula = quantity * percentReturn;
    expect(calculateRealisedPnl("NOTIONAL", "BUY", entryPrice, exitPrice, quantity)).toBeCloseTo(brokerFormula, 10);
  });

  it("computes realisedPnlPercent against `quantity` itself as the entry notional, not quantity x entryPrice", () => {
    // entryNotional for NOTIONAL mode is exactly quantity (10), so a $1 pnl is 10%.
    const pnl = calculateRealisedPnl("NOTIONAL", "BUY", 65_000, 71_500, 10);
    const pnlPercent = calculateRealisedPnlPercent("NOTIONAL", "BUY", 65_000, 71_500, 10);
    expect(pnl).toBeCloseTo(1, 10);
    expect(pnlPercent).toBeCloseTo(10, 10);
  });
});

describe("updateExcursionValues — NOTIONAL sizing mode", () => {
  it("tracks MFE/MAE as the notional's own percentage-return P/L, not price-delta x quantity", () => {
    const zero = { maximumFavourableExcursion: 0, maximumAdverseExcursion: 0 };
    const next = updateExcursionValues("NOTIONAL", "BUY", 65_000, 71_500, 10, zero); // +10% move
    expect(next.maximumFavourableExcursion).toBeCloseTo(1, 10);
    expect(next.maximumAdverseExcursion).toBe(0);
  });
});
