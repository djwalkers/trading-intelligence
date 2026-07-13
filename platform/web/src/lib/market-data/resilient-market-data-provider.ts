import type { MarketDataStatus, QuoteFetchResult } from "@/lib/types";
import type { MarketQuote } from "@/lib/types";
import type { MarketDataProvider } from "./market-data-provider";
import { logger } from "@/lib/logger/logger";

type StatusListener = (status: MarketDataStatus) => void;

// Wraps a primary provider (external, when configured) with a mock fallback — same shape as
// ResilientPaperTradeStore. If the primary provider ever throws, this falls back to mock for that
// call AND every call after it in the session; it does not keep retrying a connection already
// known to be broken ("do not fetch repeatedly").
export class ResilientMarketDataProvider implements MarketDataProvider {
  private active: MarketDataProvider;
  private readonly fallback: MarketDataProvider;
  private readonly usingExternal: boolean;
  private fallenBack = false;
  private readonly listeners = new Set<StatusListener>();
  private status: MarketDataStatus;

  constructor(primary: MarketDataProvider | null, fallback: MarketDataProvider, providerName: string) {
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
    };
  }

  getStatus(): MarketDataStatus {
    return this.status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(patch: Partial<MarketDataStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (symbols.length === 0) return [];

    if (this.fallenBack || !this.usingExternal) {
      const quotes = await this.active.getQuotes(symbols);
      this.setStatus({ lastUpdated: new Date().toISOString(), instrumentsLoaded: quotes.length });
      return quotes;
    }

    try {
      const quotes = await this.active.getQuotes(symbols);
      this.setStatus({
        mode: "Connected",
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: quotes.length,
      });
      return quotes;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown market data error";
      logger.error("External provider unavailable, falling back to mock", {
        component: "market-data",
        errorCode: "MARKET_DATA_ERROR",
        reason,
      });

      this.fallenBack = true;
      this.active = this.fallback;
      const quotes = await this.fallback.getQuotes(symbols);
      this.setStatus({
        provider: "Sample data",
        source: "Mock",
        mode: "Fallback",
        fallbackActive: true,
        failureReason: reason,
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: quotes.length,
      });
      return quotes;
    }
  }

  // Sprint 290 — mirrors getQuotes's exact branch decisions and existing setStatus() calls
  // (untouched), but additionally constructs and returns a FRESH telemetry object inline in each
  // branch — never read back from `this.status` afterward. See the identical rationale on
  // ResilientHistoricalMarketDataProvider.getHistoricalCandlesWithTelemetry.
  async getQuotesWithTelemetry(symbols: string[]): Promise<QuoteFetchResult> {
    if (symbols.length === 0) {
      return {
        quotes: [],
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
      const quotes = await this.active.getQuotes(symbols);
      this.setStatus({ lastUpdated: new Date().toISOString(), instrumentsLoaded: quotes.length });
      return {
        quotes,
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
      const quotes = await this.active.getQuotes(symbols);
      this.setStatus({
        mode: "Connected",
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: quotes.length,
      });
      return {
        quotes,
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
      const reason = error instanceof Error ? error.message : "Unknown market data error";
      logger.error("External provider unavailable, falling back to mock", {
        component: "market-data",
        errorCode: "MARKET_DATA_ERROR",
        reason,
      });

      this.fallenBack = true;
      this.active = this.fallback;
      const quotes = await this.fallback.getQuotes(symbols);
      this.setStatus({
        provider: "Sample data",
        source: "Mock",
        mode: "Fallback",
        fallbackActive: true,
        failureReason: reason,
        lastUpdated: new Date().toISOString(),
        instrumentsLoaded: quotes.length,
      });
      return {
        quotes,
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
