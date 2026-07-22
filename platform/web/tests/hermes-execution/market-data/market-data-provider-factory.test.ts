import { describe, expect, it, vi } from "vitest";
import { MarketDataProviderFactory } from "@/lib/hermes-execution/market-data/market-data-provider-factory";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import {
  LiveMarketDataProvider,
  type CandleHistorySource,
  type RateSource,
} from "@/lib/hermes-execution/market-data/live-market-data-provider";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import type { Candle } from "@/lib/hermes-execution/types";

const EMPTY = {
  HERMES_STRATEGY_REGISTRY_PATH: undefined,
  EXECUTION_MODE: undefined,
  DEMO_EXECUTION_MODE: undefined,
  HERMES_PAPER_STARTING_CASH: undefined,
  HERMES_MAX_OPEN_POSITIONS: undefined,
  BROKER_PROVIDER: undefined,
  HERMES_MARKET_DATA_PROVIDER: undefined,
  HERMES_MARKET_TIMEFRAME: undefined,
  HERMES_MARKET_CANDLE_COUNT: undefined,
  HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: undefined,
  HERMES_SCHEDULER_ENABLED: undefined,
  HERMES_SCHEDULER_INTERVAL_MS: undefined,
  HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN: undefined,
  HERMES_MARKET_HOURS_POLICY: undefined,
  HERMES_MARKET_HOURS_TIMEZONE: undefined,
  HERMES_MARKET_HOURS_SESSION_START: undefined,
  HERMES_MARKET_HOURS_SESSION_END: undefined,
  HERMES_TRADING_SYMBOL: undefined,
  HERMES_TRADE_QUANTITY: undefined,
  HERMES_MAX_TRADE_QUANTITY: undefined,
  HERMES_STRATEGY_ID: undefined,
  HERMES_RUNTIME_MODE: undefined,
  HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS: undefined,
  HERMES_TELEGRAM_ENABLED: undefined,
  HERMES_TELEGRAM_BOT_TOKEN: undefined,
  HERMES_TELEGRAM_ALLOWED_CHAT_ID: undefined,
  HYPERLIQUID_TESTNET_PRIVATE_KEY: undefined,
  HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: undefined,
  HYPERLIQUID_TESTNET_EXECUTION_ENABLED: undefined,
  HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD: undefined,
  HYPERLIQUID_TESTNET_INSTRUMENT: undefined,
  TRADING212_API_KEY: undefined,
  TRADING212_API_SECRET: undefined,
  TRADING212_DEMO_EXECUTION_ENABLED: undefined,
  TRADING212_DEMO_INSTRUMENT: undefined,
  TRADING212_DEMO_TEST_QUANTITY: undefined,
  ETORO_ENV: undefined,
  ETORO_API_KEY: undefined,
  ETORO_USER_KEY: undefined,
  ETORO_DEMO_TEST_INSTRUMENT: undefined,
  ETORO_DEMO_TEST_AMOUNT: undefined,
  ETORO_HTTP_TIMEOUT_MS: undefined,
};

const stubCandles: Candle[] = [
  { symbol: "BTC", timestamp: "2026-01-01T00:00:00.000Z", open: 1, high: 1.01, low: 0.99, close: 1, volume: 10 },
];

const stubRateSource: RateSource & CandleHistorySource = {
  getRate: async () => ({ bid: 1, ask: 1.01 }),
  getHistoricalCandles: async () => stubCandles,
};

describe("buildHermesExecutionConfig — marketDataProvider", () => {
  it("defaults to 'mock' when HERMES_MARKET_DATA_PROVIDER is unset — preserves deterministic tests", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.marketDataProvider).toBe("mock");
  });

  it("honours an explicit HERMES_MARKET_DATA_PROVIDER=live", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_DATA_PROVIDER: "live" });
    expect(config.marketDataProvider).toBe("live");
  });

  it("fails closed on an unsupported value rather than silently falling back to mock", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_DATA_PROVIDER: "production" })).toThrow(
      /mock.*live/,
    );
  });
});

describe("MarketDataProviderFactory.create — provider selection", () => {
  it("selects MockMarketDataProvider for 'mock'", () => {
    const provider = MarketDataProviderFactory.create("mock");
    expect(provider).toBeInstanceOf(MockMarketDataProvider);
  });

  it("selects LiveMarketDataProvider for 'live' when a rateSource is supplied", () => {
    const provider = MarketDataProviderFactory.create("live", { live: { rateSource: stubRateSource } });
    expect(provider).toBeInstanceOf(LiveMarketDataProvider);
  });

  it("refuses to build the live provider without a rateSource", () => {
    expect(() => MarketDataProviderFactory.create("live")).toThrow(/rateSource/);
  });

  it("an explicit `type` override always wins over the passed-in provider type", () => {
    const provider = MarketDataProviderFactory.create("mock", {
      type: "live",
      live: { rateSource: stubRateSource },
    });
    expect(provider).toBeInstanceOf(LiveMarketDataProvider);
  });

  it("throws a descriptive error for an unsupported provider type", () => {
    expect(() => MarketDataProviderFactory.create("quantum" as never)).toThrow(
      /Unsupported market data provider "quantum".*mock.*live/,
    );
  });

  it("passes live options (timeframe/candleCount/maxCandleAgeSeconds) straight through to LiveMarketDataProvider", async () => {
    const getHistoricalCandles = vi.fn().mockResolvedValue(stubCandles);
    const source: RateSource & CandleHistorySource = { getRate: async () => ({ bid: 1, ask: 1.01 }), getHistoricalCandles };

    const provider = MarketDataProviderFactory.create("live", {
      live: { rateSource: source, timeframe: "4h", candleCount: 55 },
    });
    // stubCandles is deliberately too short to pass candle-validation.ts's own MIN_REQUIRED_CANDLES
    // floor — irrelevant here, this test only checks that the options reached the candle source
    // call, not that the resulting snapshot is valid.
    await (provider as LiveMarketDataProvider).getMarketData("BTC").catch(() => {});

    expect(getHistoricalCandles).toHaveBeenCalledWith("BTC", "4h", 55);
  });

  it("passes mock options (bias/seed/count) straight through to MockMarketDataProvider", async () => {
    const provider = MarketDataProviderFactory.create("mock", { mock: { seed: 123, count: 15 } });
    const snapshot = await (provider as MockMarketDataProvider).getMarketData("BTC");
    expect(snapshot.candles).toHaveLength(15);
  });
});
