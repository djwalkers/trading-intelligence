import type { Candle } from "./types";

/**
 * The minimal market-data interface the signal engine actually needs. A live provider (added in a
 * later phase, per docs/execution-mvp-phase-1.md's "next step") only has to implement this same
 * shape — nothing in the signal engine, risk engine, or execution runner is aware that this
 * implementation happens to be a fixture replay rather than a live feed.
 */
export interface MarketDataProvider {
  /** Every known candle for a symbol, in chronological order (oldest first). */
  getCandles(symbol: string): Candle[];
  getKnownSymbols(): string[];
}

/**
 * Deterministic, network-free candle replay. Candles are supplied once, at construction, and
 * simply returned in sorted order — no fs access, no randomness, so this class alone is trivially
 * unit-testable without touching disk (see load-fixture-candles.ts for the file-reading half).
 */
export class FixtureMarketDataProvider implements MarketDataProvider {
  private readonly bySymbol: Map<string, Candle[]>;

  constructor(candles: Candle[]) {
    const bySymbol = new Map<string, Candle[]>();
    for (const candle of candles) {
      const list = bySymbol.get(candle.symbol) ?? [];
      list.push(candle);
      bySymbol.set(candle.symbol, list);
    }
    for (const list of bySymbol.values()) {
      list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    }
    this.bySymbol = bySymbol;
  }

  getCandles(symbol: string): Candle[] {
    return this.bySymbol.get(symbol) ?? [];
  }

  getKnownSymbols(): string[] {
    return [...this.bySymbol.keys()];
  }
}
