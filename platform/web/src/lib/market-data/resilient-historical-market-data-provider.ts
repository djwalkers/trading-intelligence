import type { HistoricalDataStatus, HistoricalFetchResult } from "@/lib/types";
import type { OHLCVCandle } from "@/lib/types";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";
import { logger } from "@/lib/logger/logger";

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
      provider: this.usingExternal ? providerName : "Sample data",
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
      logger.error("External provider unavailable, falling back to mock", {
        component: "historical-market-data",
        errorCode: "MARKET_DATA_ERROR",
        reason,
      });

      this.fallenBack = true;
      this.active = this.fallback;
      const candles = await this.fallback.getHistoricalCandles(symbols, days);
      this.setStatus({
        provider: "Sample data",
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

  // Sprint 290 — mirrors getHistoricalCandles's exact branch decisions and existing setStatus()
  // calls (untouched, so getStatus()'s existing consumers, e.g. the Operations Centre panel, see no
  // change), but additionally constructs and returns a FRESH telemetry object inline in each
  // branch — never read back from `this.status` afterward. This is what makes the result genuinely
  // per-invocation: a caller acting on the returned telemetry learns exactly what happened during
  // THIS call, never a stale flag left over from an earlier, unrelated one.
  async getHistoricalCandlesWithTelemetry(symbols: string[], days: number): Promise<HistoricalFetchResult> {
    if (symbols.length === 0) {
      return {
        candles: [],
        telemetry: {
          symbolsRequested: [],
          symbolsServedExternally: [],
          symbolsServedFromFallback: [],
          symbolsFailed: [],
          usedFallback: false,
          source: this.status.source,
          provider: this.status.provider,
        },
      };
    }

    if (this.fallenBack || !this.usingExternal) {
      const candles = await this.active.getHistoricalCandles(symbols, days);
      this.setStatus({
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: this.currentCacheAgeMinutes(),
      });
      // this.fallenBack (true only if a real primary genuinely failed earlier in this instance's
      // life) distinguishes "recovered from a real fallback" from "never had a primary configured
      // at all" (the browser's permanent case) — only the former should ever read as
      // fallback_sample_data; the latter reads as plain sample_data (usedFallback: false, source:
      // Mock) via combineDataSourceResults.
      return {
        candles,
        telemetry: {
          symbolsRequested: symbols,
          symbolsServedExternally: [],
          symbolsServedFromFallback: symbols,
          symbolsFailed: [],
          usedFallback: this.fallenBack,
          source: "Mock",
          provider: "Sample data",
        },
      };
    }

    try {
      const candles = await this.active.getHistoricalCandles(symbols, days);
      this.setStatus({
        mode: "Connected",
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: this.currentCacheAgeMinutes(),
      });
      return {
        candles,
        telemetry: {
          symbolsRequested: symbols,
          symbolsServedExternally: symbols,
          symbolsServedFromFallback: [],
          symbolsFailed: [],
          usedFallback: false,
          source: "External",
          provider: this.status.provider,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown historical data error";
      logger.error("External provider unavailable, falling back to mock", {
        component: "historical-market-data",
        errorCode: "MARKET_DATA_ERROR",
        reason,
      });

      this.fallenBack = true;
      this.active = this.fallback;
      const candles = await this.fallback.getHistoricalCandles(symbols, days);
      this.setStatus({
        provider: "Sample data",
        source: "Mock",
        mode: "Fallback",
        fallbackActive: true,
        failureReason: reason,
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: countSymbols(candles),
        cacheAgeMinutes: null,
      });
      return {
        candles,
        telemetry: {
          symbolsRequested: symbols,
          symbolsServedExternally: [],
          symbolsServedFromFallback: symbols,
          symbolsFailed: [],
          usedFallback: true,
          source: "Mock",
          provider: "Sample data",
        },
      };
    }
  }
}
