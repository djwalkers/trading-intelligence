import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHermesExecutionConfigCacheForTests } from "@/lib/hermes-execution/config";
import type { Candle } from "@/lib/hermes-execution/types";

// Mocks BrokerFactory.create itself (not the concrete EtoroDemoBroker/EtoroClient chain) — matches
// runtime-dependency-factory-etoro.test.ts's own convention. No real network call happens anywhere
// in this file, live or mock: the mock branch uses the real, deterministic MockMarketDataProvider
// (no broker involved at all), and the live branch only ever talks to a fake broker object.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

const { getMarketDiagnostics, MarketDiagnosticsError } = await import("@/lib/hermes-execution/market-diagnostics-service");

const HOUR_MS = 3_600_000;

function makeValidCandles(count = 60, endTimestamp = new Date()): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(endTimestamp.getTime() - (count - 1 - i) * HOUR_MS).toISOString();
    const price = 50_000 + i * 10;
    candles.push({ symbol: "BTC", timestamp, open: price, high: price + 50, low: price - 50, close: price, volume: 100 + i });
  }
  return candles;
}

function makeFakeEtoroBroker(overrides: {
  resolveInstrument?: ReturnType<typeof vi.fn>;
  getRate?: ReturnType<typeof vi.fn>;
  getHistoricalCandles?: ReturnType<typeof vi.fn>;
}) {
  return {
    resolveInstrument: overrides.resolveInstrument ?? vi.fn().mockResolvedValue({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC" }),
    getRate: overrides.getRate ?? vi.fn().mockResolvedValue({ bid: 50_500, ask: 50_510 }),
    getHistoricalCandles: overrides.getHistoricalCandles ?? vi.fn().mockResolvedValue(makeValidCandles()),
  };
}

const ENV_VARS = [
  "BROKER_PROVIDER",
  "HERMES_MARKET_DATA_PROVIDER",
  "HERMES_MARKET_TIMEFRAME",
  "HERMES_MARKET_CANDLE_COUNT",
  "HERMES_MARKET_MAX_CANDLE_AGE_SECONDS",
  "HERMES_TRADING_SYMBOL",
  "ETORO_ENV",
  "ETORO_API_KEY",
  "ETORO_USER_KEY",
  "ETORO_HTTP_TIMEOUT_MS",
  "ETORO_DEMO_TEST_AMOUNT",
] as const;

const originalEnv: Record<string, string | undefined> = {};

function setEnv(vars: Partial<Record<(typeof ENV_VARS)[number], string>>) {
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  resetHermesExecutionConfigCacheForTests();
}

beforeEach(() => {
  for (const key of ENV_VARS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  createMock.mockReset();
  resetHermesExecutionConfigCacheForTests();
});

afterEach(() => {
  for (const key of ENV_VARS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  resetHermesExecutionConfigCacheForTests();
});

describe("getMarketDiagnostics — mock provider (default config)", () => {
  it("returns a well-formed result using the real, deterministic MockMarketDataProvider", async () => {
    const result = await getMarketDiagnostics();

    expect(result.provider).toBe("mock");
    expect(result.instrument).toBe("BTC"); // default HERMES_TRADING_SYMBOL
    expect(result.timeframe).toBe("1h"); // default HERMES_MARKET_TIMEFRAME
    expect(result.requestedCandleCount).toBe(200); // default HERMES_MARKET_CANDLE_COUNT
    expect(result.receivedCandleCount).toBe(200);
    expect(result.candles).toHaveLength(200);
    expect(createMock).not.toHaveBeenCalled(); // mock path never touches BrokerFactory at all
  });

  it("never sets fallbackOccurred to true — no fallback path exists in this pipeline", async () => {
    const result = await getMarketDiagnostics();
    expect(result.validation.fallbackOccurred).toBe(false);
  });

  it("the series' last point exactly matches the single 'current' indicator values", async () => {
    const result = await getMarketDiagnostics();
    const lastIndex = result.series.ema20.length - 1;
    expect(result.series.ema20[lastIndex]).toBe(result.indicators.ema20);
    expect(result.series.ema50[lastIndex]).toBe(result.indicators.ema50);
    expect(result.series.rsi14[lastIndex]).toBe(result.indicators.rsi14);
  });

  it("honours a custom instrument override", async () => {
    const result = await getMarketDiagnostics({ instrument: "ETH" });
    expect(result.instrument).toBe("ETH");
  });

  it("truncates candles/series to CHART_CANDLE_LIMIT (200) while receivedCandleCount reflects the full fetch", async () => {
    setEnv({ HERMES_MARKET_CANDLE_COUNT: "250" });
    const result = await getMarketDiagnostics();
    expect(result.receivedCandleCount).toBe(250);
    expect(result.candles).toHaveLength(200);
    expect(result.series.timestamps).toHaveLength(200);
    // Even truncated, the series' own last point still matches the current indicator values —
    // proven by computing the series over the FULL set before truncating (see the service's own
    // buildResult doc comment).
    const lastIndex = result.series.ema20.length - 1;
    expect(result.series.ema20[lastIndex]).toBe(result.indicators.ema20);
  });

  it("reports CONFIG_ERROR (never a raw crash) when the underlying config is invalid", async () => {
    setEnv({ HERMES_MARKET_TIMEFRAME: "2h" }); // not a supported timeframe
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CONFIG_ERROR" });
  });
});

describe("getMarketDiagnostics — live provider, misconfiguration (no network call)", () => {
  it("rejects with UNSUPPORTED_BROKER when live is requested with a non-etoro broker", async () => {
    setEnv({ HERMES_MARKET_DATA_PROVIDER: "live", BROKER_PROVIDER: "local" });
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "UNSUPPORTED_BROKER" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects (as CONFIG_ERROR, via config.ts's own unconditional etoro-demo credential requirement) when eToro credentials are incomplete", async () => {
    // config.ts itself already requires ETORO_API_KEY/ETORO_USER_KEY whenever
    // BROKER_PROVIDER=etoro-demo, regardless of HERMES_MARKET_DATA_PROVIDER — config-building
    // fails closed before this service's own (defense-in-depth, but here unreachable)
    // BROKER_NOT_CONFIGURED check would otherwise run. Either way: no network call happens.
    setEnv({ HERMES_MARKET_DATA_PROVIDER: "live", BROKER_PROVIDER: "etoro-demo", ETORO_ENV: "demo" });
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CONFIG_ERROR" });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("getMarketDiagnostics — live provider, broker interaction (BrokerFactory mocked)", () => {
  beforeEach(() => {
    setEnv({
      HERMES_MARKET_DATA_PROVIDER: "live",
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
  });

  it("rejects with BROKER_CONNECTION_FAILED when BrokerFactory.create throws", async () => {
    createMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "BROKER_CONNECTION_FAILED" });
  });

  it("rejects with INSTRUMENT_RESOLUTION_FAILED when resolveInstrument rejects", async () => {
    createMock.mockResolvedValueOnce(
      makeFakeEtoroBroker({ resolveInstrument: vi.fn().mockRejectedValue(new Error("no match")) }),
    );
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "INSTRUMENT_RESOLUTION_FAILED" });
  });

  it("rejects with CANDLE_FETCH_FAILED when getRate rejects", async () => {
    createMock.mockResolvedValueOnce(makeFakeEtoroBroker({ getRate: vi.fn().mockRejectedValue(new Error("timeout")) }));
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CANDLE_FETCH_FAILED" });
  });

  it("rejects with CANDLE_FETCH_FAILED when getHistoricalCandles rejects", async () => {
    createMock.mockResolvedValueOnce(
      makeFakeEtoroBroker({ getHistoricalCandles: vi.fn().mockRejectedValue(new Error("upstream 500")) }),
    );
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CANDLE_FETCH_FAILED" });
  });

  it("rejects with CANDLE_VALIDATION_FAILED when the returned candle history is insufficient", async () => {
    createMock.mockResolvedValueOnce(
      makeFakeEtoroBroker({ getHistoricalCandles: vi.fn().mockResolvedValue(makeValidCandles(5)) }),
    );
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CANDLE_VALIDATION_FAILED" });
  });

  it("rejects with CANDLE_VALIDATION_FAILED (never silently substitutes) on malformed OHLC", async () => {
    const malformed = makeValidCandles();
    malformed[10] = { ...malformed[10]!, high: 1, low: 100 }; // high below low
    createMock.mockResolvedValueOnce(makeFakeEtoroBroker({ getHistoricalCandles: vi.fn().mockResolvedValue(malformed) }));
    await expect(getMarketDiagnostics()).rejects.toMatchObject({ name: "MarketDiagnosticsError", code: "CANDLE_VALIDATION_FAILED" });
  });

  it("never falls back to mock data when the live fetch fails — the error propagates as-is", async () => {
    createMock.mockRejectedValueOnce(new Error("connection refused"));
    const error = await getMarketDiagnostics().catch((e) => e);
    expect(error).toBeInstanceOf(MarketDiagnosticsError);
    expect(createMock).toHaveBeenCalledTimes(1); // exactly one attempt — no silent retry into a different provider
  });

  it("succeeds end-to-end with a valid fake broker, reporting provider 'live' and brokerProvider 'etoro-demo'", async () => {
    createMock.mockResolvedValueOnce(makeFakeEtoroBroker({}));
    const result = await getMarketDiagnostics();

    expect(result.provider).toBe("live");
    expect(result.brokerProvider).toBe("etoro-demo");
    expect(result.currentQuote).toEqual({ bid: 50_500, ask: 50_510, mid: 50_505 });
  });
});

describe("getMarketDiagnostics — volume reporting (Phase 2A follow-up carried through)", () => {
  beforeEach(() => {
    setEnv({
      HERMES_MARKET_DATA_PROVIDER: "live",
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
  });

  it("volumeAvailable is true and lastClosedCandle.volume is defined when eToro reports a real volume", async () => {
    createMock.mockResolvedValueOnce(makeFakeEtoroBroker({}));
    const result = await getMarketDiagnostics();
    expect(result.validation.volumeAvailable).toBe(true);
    expect(result.lastClosedCandle.volume).toBeDefined();
  });

  it("volumeAvailable is false and lastClosedCandle.volume is undefined (never fabricated) when volume is unknown", async () => {
    const candles = makeValidCandles();
    const { volume: _volume, ...withoutVolume } = candles[candles.length - 1]!;
    candles[candles.length - 1] = withoutVolume as Candle;
    createMock.mockResolvedValueOnce(makeFakeEtoroBroker({ getHistoricalCandles: vi.fn().mockResolvedValue(candles) }));

    const result = await getMarketDiagnostics();
    expect(result.validation.volumeAvailable).toBe(false);
    expect(result.lastClosedCandle.volume).toBeUndefined();
  });
});
