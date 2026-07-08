import type { MarketDataStatus } from "@/lib/types";
import type { MarketQuote } from "@/lib/types";
import type { MarketDataProvider } from "./market-data-provider";

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
      provider: this.usingExternal ? providerName : "Mock",
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
      console.error("[market-data] External provider unavailable, falling back to mock:", error);

      this.fallenBack = true;
      this.active = this.fallback;
      const quotes = await this.fallback.getQuotes(symbols);
      this.setStatus({
        provider: "Mock",
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
}
