import "server-only";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { HistoricalFetchResult, OHLCVCandle } from "@/lib/types";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";
import { logger } from "@/lib/logger/logger";

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

// Maintenance 1.11.2 — how long a symbol's fetched series is trusted before it's fetched again.
// This is what keeps a worker polling every 15/30/60 minutes down to at most one real Alpha
// Vantage request per symbol per day, per the mission's explicit cap.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Alpha Vantage's free tier rejects bursts well short of any per-minute figure in practice — live
// testing during this maintenance tripped its limiter at ~1.2s spacing ("please consider spreading
// out your free API requests more sparingly (1 request per second)"), so this is deliberately much
// more conservative than that message alone would suggest. This only matters on a cold cache (a
// fresh worker process with nothing on disk yet) fetching all 5 symbols in one batch — spacing
// requests out avoids tripping the limiter. Cache hits never wait on this, and steady-state
// operation (one symbol expiring at a time, a day apart) never approaches this spacing anyway.
const REQUEST_SPACING_MS = 15_000;

// Cache lives on disk, not just in memory, so a restarted worker process (a VPS reboot, a deploy,
// a crash) doesn't immediately re-fetch every symbol — "retain or reload cached data after
// restarts where practical" (mission requirement 3). A plain JSON file is practical here: this
// process already has an unrestricted, persistent filesystem (a VPS), unlike a serverless
// function, and the alternative (a new Supabase table) would violate the mission's explicit
// "do not change Supabase schema" lock.
const CACHE_FILE_PATH = path.join(process.cwd(), ".data", "alpha-vantage-historical-cache.json");

interface CacheEntry {
  candles: OHLCVCandle[];
  fetchedAt: string;
}

type CacheFile = Record<string, CacheEntry>;

type AlphaVantageFailureReason =
  | "invalid_api_key"
  | "rate_limited"
  | "missing_symbol"
  | "malformed_response"
  | "http_failure";

export class AlphaVantageError extends Error {
  constructor(
    message: string,
    public readonly reason: AlphaVantageFailureReason,
  ) {
    super(message);
    this.name = "AlphaVantageError";
  }
}

interface AlphaVantageDailySeriesEntry {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. volume": string;
}

interface AlphaVantageDailyResponse {
  "Time Series (Daily)"?: Record<string, AlphaVantageDailySeriesEntry>;
  "Error Message"?: string;
  "Note"?: string; // legacy throttle message shape
  "Information"?: string; // current throttle/invalid-key message shape
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real daily OHLCV candles from Alpha Vantage's TIME_SERIES_DAILY endpoint (compact = last ~100
// trading days, comfortably covering the 90-day lookback the Strategy Engine requests), the
// server-only sibling of ExternalHistoricalMarketDataProvider (Finnhub) that mission removed from
// selection. Never imported by anything the browser bundle can reach — see
// get-server-historical-market-data-provider.ts, the only file that constructs this class, itself
// only ever imported from src/worker/process-schedule.ts (a non-Next.js entrypoint run via `tsx`,
// never bundled for the browser). ALPHA_VANTAGE_API_KEY is read by the caller and passed in here,
// never inlined into client code, matching this codebase's SUPABASE_SERVICE_ROLE_KEY convention.
export class AlphaVantageHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  private cache = new Map<string, CacheEntry>();
  private cacheLoaded = false;
  private lastRequestAt = 0;

  constructor(private readonly apiKey: string) {}

  async getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]> {
    await this.ensureCacheLoaded();

    const results: OHLCVCandle[] = [];
    for (const symbol of symbols) {
      const candles = await this.getSymbolCandles(symbol);
      results.push(...candles.slice(-days));
    }
    return results;
  }

  // Sprint 290 — a thin, additive wrapper: getHistoricalCandles above loops sequentially and
  // throws for the WHOLE call the instant any single symbol's fetch fails (a mid-loop exception
  // aborts before any partial results are ever returned), so today's real behaviour is honestly
  // all-or-nothing — either every requested symbol was served externally, or this call throws
  // (propagated unchanged, exactly like getHistoricalCandles) and never returns at all. The
  // telemetry shape supports per-symbol granularity for a future provider that could report a
  // genuinely mixed result; this one cannot, so it never fabricates one.
  async getHistoricalCandlesWithTelemetry(symbols: string[], days: number): Promise<HistoricalFetchResult> {
    const candles = await this.getHistoricalCandles(symbols, days);
    return {
      candles,
      telemetry: {
        symbolsRequested: symbols,
        symbolsServedExternally: symbols,
        symbolsServedFromFallback: [],
        symbolsFailed: [],
        usedFallback: false,
        source: "External",
        provider: "Alpha Vantage",
      },
    };
  }

  // Minutes since the oldest still-cached symbol was fetched, or null if the cache is empty —
  // read by ResilientHistoricalMarketDataProvider for the System Health "cache age" figure
  // (mission requirement 6). Oldest, not newest, so the figure reflects "how stale could this get
  // before anything refreshes," not just the most recently touched symbol.
  getCacheAgeMinutes(): number | null {
    if (this.cache.size === 0) return null;
    let oldest = Infinity;
    for (const entry of this.cache.values()) {
      oldest = Math.min(oldest, new Date(entry.fetchedAt).getTime());
    }
    return Math.round((Date.now() - oldest) / 60_000);
  }

  private async getSymbolCandles(symbol: string): Promise<OHLCVCandle[]> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
      return cached.candles;
    }

    const candles = await this.fetchFromAlphaVantage(symbol);
    this.cache.set(symbol, { candles, fetchedAt: new Date().toISOString() });
    await this.persistCache();
    return candles;
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;

    try {
      const raw = await fs.readFile(CACHE_FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as CacheFile;
      for (const [symbol, entry] of Object.entries(parsed)) {
        this.cache.set(symbol, entry);
      }
    } catch {
      // No cache file yet (first run), or it's unreadable/corrupt — start empty rather than
      // failing the scan. A fresh fetch will recreate it.
    }
  }

  private async persistCache(): Promise<void> {
    const asObject: CacheFile = Object.fromEntries(this.cache.entries());
    try {
      await fs.mkdir(path.dirname(CACHE_FILE_PATH), { recursive: true });
      await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(asObject, null, 2), "utf-8");
    } catch (error) {
      // Persistence failing (read-only filesystem, permissions) shouldn't fail the scan — the
      // in-memory cache still works for the rest of this process's lifetime, it just won't
      // survive a restart this time.
      logger.error("Failed to persist historical data cache to disk", {
        component: "alpha-vantage",
        errorCode: "PERSISTENCE_ERROR",
        reason: error instanceof Error ? error.message : "Unknown cache write error",
      });
    }
  }

  private async fetchFromAlphaVantage(symbol: string): Promise<OHLCVCandle[]> {
    const waitMs = REQUEST_SPACING_MS - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) await sleep(waitMs);
    this.lastRequestAt = Date.now();

    const url = `${ALPHA_VANTAGE_BASE_URL}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(this.apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new AlphaVantageError(
        `Alpha Vantage request failed for ${symbol}: ${error instanceof Error ? error.message : "network error"}`,
        "http_failure",
      );
    }

    if (!response.ok) {
      throw new AlphaVantageError(
        `Alpha Vantage request failed for ${symbol}: HTTP ${response.status}`,
        "http_failure",
      );
    }

    let data: AlphaVantageDailyResponse;
    try {
      data = (await response.json()) as AlphaVantageDailyResponse;
    } catch {
      throw new AlphaVantageError(`Alpha Vantage returned a non-JSON response for ${symbol}`, "malformed_response");
    }

    if (data["Error Message"]) {
      const message = data["Error Message"];
      const reason: AlphaVantageFailureReason = /apikey/i.test(message) ? "invalid_api_key" : "missing_symbol";
      throw new AlphaVantageError(`Alpha Vantage error for ${symbol}: ${message}`, reason);
    }

    if (data["Note"] || data["Information"]) {
      const message = data["Note"] ?? data["Information"] ?? "Alpha Vantage rate limit reached";
      const reason: AlphaVantageFailureReason = /apikey/i.test(message) ? "invalid_api_key" : "rate_limited";
      throw new AlphaVantageError(`Alpha Vantage rate limit for ${symbol}: ${message}`, reason);
    }

    const series = data["Time Series (Daily)"];
    if (!series) {
      throw new AlphaVantageError(`Alpha Vantage returned an unrecognised response shape for ${symbol}`, "malformed_response");
    }
    if (Object.keys(series).length === 0) {
      throw new AlphaVantageError(`Alpha Vantage returned no daily series for ${symbol}`, "missing_symbol");
    }

    const candles: OHLCVCandle[] = Object.entries(series)
      .map(([date, entry]) => {
        const open = Number(entry["1. open"]);
        const high = Number(entry["2. high"]);
        const low = Number(entry["3. low"]);
        const close = Number(entry["4. close"]);
        const volume = Number(entry["5. volume"]);
        if ([open, high, low, close, volume].some((value) => Number.isNaN(value))) return null;

        return {
          symbol,
          timestamp: new Date(`${date}T00:00:00.000Z`).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        };
      })
      .filter((candle): candle is OHLCVCandle => candle !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (candles.length === 0) {
      throw new AlphaVantageError(`Alpha Vantage daily series for ${symbol} contained no usable candles`, "malformed_response");
    }

    return candles;
  }
}
