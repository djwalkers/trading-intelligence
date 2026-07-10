import type { HistoricalDataStatus } from "@/lib/types";
import type { OHLCVCandle } from "@/lib/types";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";

type StatusListener = (status: HistoricalDataStatus) => void;

function countSymbols(candles: OHLCVCandle[]): number {
  return new Set(candles.map((candle) => candle.symbol)).size;
}

// The historical sibling of ResilientMarketDataProvider — wraps a primary provider (external, when
// configured) with a mock fallback. If the primary ever throws, this falls back to mock for that
// call AND every call after it in the session; it does not keep retrying a connection already
// known to be broken, same "do not fetch repeatedly" rule as the live-quote resilient wrapper.
export class ResilientHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  private active: HistoricalMarketDataProvider;
  private readonly fallback: HistoricalMarketDataProvider;
  private readonly usingExternal: boolean;
  private fallenBack = false;
  private readonly listeners = new Set<StatusListener>();
  private status: HistoricalDataStatus;

  constructor(
    primary: HistoricalMarketDataProvider | null,
    fallback: HistoricalMarketDataProvider,
    providerName: string,
  ) {
    this.fallback = fallback;
    this.usingExternal = primary !== null;
    this.active = primary ?? fallback;
    this.status = {
      provider: this.usingExternal ? providerName : "Mock",
      source: this.usingExternal ? "External" : "Mock",
      mode: this.usingExternal ? "Connected" : "Mocked",
      lastUpdated: null,
      instrumentsLoaded: 0,
      fallbackActive: false,
      failureReason: null,
      cacheAgeMinutes: null,
    };
  }

  // Only non-null when the currently active provider implements it (Maintenance 1.11.2's Alpha
  // Vantage provider) — Mock and a provider that's never been called both correctly report null.
  private currentCacheAgeMinutes(): number | null {
    return this.active.getCacheAgeMinutes?.() ?? null;
  }

  getStatus(): HistoricalDataStatus {
    return this.status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(patch: Partial<HistoricalDataStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  async getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]> {
    if (symbols.length === 0) return [];

    if (this.fallenBack || !this.usingExternal) {
      const candles = await this.active.getHistoricalCandles(symbols, days);
      this.setStatus({
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: this.currentCacheAgeMinutes(),
      });
      return candles;
    }

    try {
      const candles = await this.active.getHistoricalCandles(symbols, days);
      this.setStatus({
        mode: "Connected",
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: this.currentCacheAgeMinutes(),
      });
      return candles;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown historical data error";
      console.error("[historical-market-data] External provider unavailable, falling back to mock:", error);

      this.fallenBack = true;
      this.active = this.fallback;
      const candles = await this.fallback.getHistoricalCandles(symbols, days);
      this.setStatus({
        provider: "Mock",
        source: "Mock",
        mode: "Fallback",
        fallbackActive: true,
        failureReason: reason,
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: null,
      });
      return candles;
    }
  }
}
