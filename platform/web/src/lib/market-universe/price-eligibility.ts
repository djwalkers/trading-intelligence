import "server-only";
import { getServerConfig } from "@/lib/config/server-config";

// How many symbols one refresh run price-checks — a capped, incremental batch, not the whole
// universe at once. Requested at 1,750 in an earlier revision, but live verification against the
// real Supabase project found PostgREST silently caps any single response (including the
// `.range()`-paginated batch-selection query) at 1,000 rows regardless of the requested limit — so
// 1,000 is the real, demonstrated ceiling per run, not a value this code chooses freely. Real math:
// ~8,805 real symbols / 1,000 per run ≈ 9 refresh runs for one full first pass at a daily cadence
// (~18 minutes/run at REQUEST_SPACING_MS below, confirmed live: 1,000 checks took ~21 minutes
// including overhead). See docs/product/PHASE-2A-MARKET-UNIVERSE.md, "Price-check convergence".
export const PRICE_CHECK_BATCH_SIZE = 1000;

// A checked symbol becomes eligible for re-checking again once this many days have passed —
// deliberately set well after the ~9-day first-pass duration above, so re-checks only become
// relevant once initial coverage is genuinely done, not before (an earlier 7-day window was shorter
// than the first pass it was based on, an internal contradiction this value fixes).
export const STALE_PRICE_CHECK_DAYS = 30;

// Conservative spacing, safely under Finnhub's free-tier rate limit (documented at 60 calls/
// minute) — leaves headroom rather than running right at the edge.
const REQUEST_SPACING_MS = 1100;

const PRICE_PROVIDER_NAME = "Finnhub";

export interface PriceCheckResult {
  symbol: string;
  price: number | null;
  // Real, from the same Finnhub response as price, at no extra API cost — never fabricated as 0
  // when a check fails or a field is genuinely absent (see FinnhubQuoteResponse below).
  changeAbsolute: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  checkedAt: string;
  failed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A raw Finnhub /quote response has more fields than the shared ExternalMarketDataProvider maps
// into MarketQuote (which only exposes symbol/price/changeAbsolute/changePercent/lastUpdated) — h
// (day high) and l (day low) are real fields Finnhub already returns but MarketQuote doesn't carry.
// Rather than widening that shared, live-quote-path class (out of scope — "no existing trading
// logic should require modification"), this module fetches directly, once per symbol, capturing
// everything genuinely available from that one response. Never invents a value: any field absent
// from the response stays null, not 0.
interface FinnhubQuoteResponse {
  c: number; // current price
  d: number | null; // change
  dp: number | null; // percent change
  h: number | null; // day high
  l: number | null; // day low
  t: number; // unix seconds
}

function getFinnhubApiKey(): string {
  const config = getServerConfig();
  if (!config.isFinnhubConfigured || !config.finnhubApiKey) {
    throw new Error(
      "Market Universe price checking requires NEXT_PUBLIC_MARKET_DATA_PROVIDER and NEXT_PUBLIC_MARKET_DATA_API_KEY to be configured.",
    );
  }
  return config.finnhubApiKey;
}

async function fetchOneQuote(apiKey: string, symbol: string): Promise<FinnhubQuoteResponse | null> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = (await response.json()) as FinnhubQuoteResponse;
  if (!data || typeof data.c !== "number" || data.c === 0) return null;
  return data;
}

// Calls Finnhub ONE symbol at a time, each independently caught — not a single batched call over
// every symbol. This avoids the exact risk ExternalMarketDataProvider.getQuotes() has internally
// (a Promise.all() over every symbol, where one bad/delisted/rate-limited symbol throws and
// discards every other quote from that same call): here, one failure only skips that one symbol
// (it stays awaiting_check and is retried on a later run) rather than silently losing the whole
// batch's results. Proven live against a deliberately-invalid symbol mixed into a real batch.
export async function checkPrices(symbols: string[]): Promise<PriceCheckResult[]> {
  const apiKey = getFinnhubApiKey();
  const results: PriceCheckResult[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (!symbol) continue;
    const checkedAt = new Date().toISOString();
    try {
      const quote = await fetchOneQuote(apiKey, symbol);
      results.push({
        symbol,
        price: quote?.c ?? null,
        changeAbsolute: quote?.d ?? null,
        changePercent: quote?.dp ?? null,
        dayHigh: quote?.h ?? null,
        dayLow: quote?.l ?? null,
        checkedAt,
        failed: !quote,
      });
    } catch {
      results.push({
        symbol,
        price: null,
        changeAbsolute: null,
        changePercent: null,
        dayHigh: null,
        dayLow: null,
        checkedAt,
        failed: true,
      });
    }
    if (i < symbols.length - 1) await sleep(REQUEST_SPACING_MS);
  }

  return results;
}

export function getPriceProviderName(): string {
  return PRICE_PROVIDER_NAME;
}
