import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mocks BrokerFactory.create itself (not the concrete EtoroDemoBroker/EtoroClient chain) — this
// suite is testing runtime-dependency-factory.ts's own reaction to whatever BrokerFactory.create
// returns (a resolveInstrument/getRate-shaped object), not eToro's real HTTP behaviour, which
// broker-factory.test.ts and etoro-demo-broker.test.ts already cover independently. No real network
// call happens anywhere in this file.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

const { buildRuntimeDependencies } = await import("@/lib/hermes-execution/runtime-config/runtime-dependency-factory");
const { buildHermesExecutionConfig } = await import("@/lib/hermes-execution/config");
const { InMemoryAuditTrail } = await import("@/lib/hermes-execution/audit-trail");
const { LiveMarketDataProvider } = await import("@/lib/hermes-execution/market-data/live-market-data-provider");

const FIXTURES_DIR = path.join(process.cwd(), "tests", "hermes-execution", "fixtures");
const VALID_REGISTRY = path.join(FIXTURES_DIR, "registry-valid");

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
  ETORO_ENV: "demo" as const,
  ETORO_API_KEY: "test-key",
  ETORO_USER_KEY: "test-user-key",
  ETORO_DEMO_TEST_INSTRUMENT: undefined,
  ETORO_DEMO_TEST_AMOUNT: "50",
  ETORO_HTTP_TIMEOUT_MS: undefined,
};

const PORTFOLIO_RISK_CONFIG = { portfolioMaxOpenPositions: 5, maxDailyTrades: 10, maxPortfolioExposure: 10_000 };

const FAKE_CANDLES = [
  { symbol: "BTC", timestamp: "2026-01-01T00:00:00.000Z", open: 100, high: 100.5, low: 99.5, close: 100, volume: 10 },
];

function makeFakeEtoroBroker(
  overrides: { resolveInstrument?: ReturnType<typeof vi.fn>; getHistoricalCandles?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    getAccount: () => ({ cashBalance: 1000, startingCashBalance: 1000 }),
    getOpenPositions: () => [],
    getCompletedTrades: () => [],
    placeMarketOrder: vi.fn(),
    closePosition: vi.fn(),
    resolveInstrument: overrides.resolveInstrument ?? vi.fn().mockResolvedValue({ instrumentId: 1, displayName: "Bitcoin", symbol: "BTC" }),
    getRate: vi.fn().mockResolvedValue({ bid: 100, ask: 100.1 }),
    getHistoricalCandles: overrides.getHistoricalCandles ?? vi.fn().mockResolvedValue(FAKE_CANDLES),
  };
}

describe("buildRuntimeDependencies — etoro-demo construction", () => {
  it("succeeds, calling resolveInstrument for the configured symbol", async () => {
    const fakeBroker = makeFakeEtoroBroker();
    createMock.mockResolvedValueOnce(fakeBroker);

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "etoro-demo",
      HERMES_RUNTIME_MODE: "demo",
      HERMES_TRADING_SYMBOL: "BTC",
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(true);
    expect(fakeBroker.resolveInstrument).toHaveBeenCalledWith("BTC");
  });

  it("constructs a LiveMarketDataProvider wired to the broker's own getRate when marketDataProvider=live", async () => {
    const fakeBroker = makeFakeEtoroBroker();
    createMock.mockResolvedValueOnce(fakeBroker);

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "etoro-demo",
      HERMES_RUNTIME_MODE: "demo",
      HERMES_MARKET_DATA_PROVIDER: "live",
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dependencies.marketDataProvider).toBeInstanceOf(LiveMarketDataProvider);
  });

  it("wires config.marketData's timeframe/candleCount through to the constructed LiveMarketDataProvider", async () => {
    const getHistoricalCandles = vi.fn().mockResolvedValue(FAKE_CANDLES);
    const fakeBroker = makeFakeEtoroBroker({ getHistoricalCandles });
    createMock.mockResolvedValueOnce(fakeBroker);

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "etoro-demo",
      HERMES_RUNTIME_MODE: "demo",
      HERMES_MARKET_DATA_PROVIDER: "live",
      HERMES_MARKET_TIMEFRAME: "4h",
      HERMES_MARKET_CANDLE_COUNT: "60",
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // FAKE_CANDLES is deliberately too short to pass candle-validation.ts's own MIN_REQUIRED_CANDLES
    // floor — irrelevant here, this test only checks that config.marketData's values reached the
    // candle source call, not that the resulting snapshot is valid (candle-validation.test.ts and
    // live-market-data-provider.test.ts already cover validation itself).
    await result.dependencies.marketDataProvider.getMarketData("BTC").catch(() => {});
    expect(getHistoricalCandles).toHaveBeenCalledWith("BTC", "4h", 60);
  });

  it("fails with field 'symbol' when resolveInstrument rejects", async () => {
    const fakeBroker = makeFakeEtoroBroker({
      resolveInstrument: vi.fn().mockRejectedValue(new Error("No eToro instrument matched search term \"NOPE\".")),
    });
    createMock.mockResolvedValueOnce(fakeBroker);

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "etoro-demo",
      HERMES_RUNTIME_MODE: "demo",
      HERMES_TRADING_SYMBOL: "NOPE",
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatchObject({ field: "symbol" });
      expect(result.problems[0]?.message).toMatch(/NOPE/);
    }
  });

  it("fails with field 'broker' when broker construction itself throws", async () => {
    createMock.mockRejectedValueOnce(new Error("connection refused"));

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "etoro-demo",
      HERMES_RUNTIME_MODE: "demo",
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatchObject({ field: "broker" });
      expect(result.problems[0]?.message).toMatch(/connection refused/);
    }
  });

  it("market-decide.ts's override pattern selects etoro-demo/demo even when config says otherwise", async () => {
    const fakeBroker = makeFakeEtoroBroker();
    createMock.mockResolvedValueOnce(fakeBroker);

    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "local", // deliberately NOT etoro-demo
    });

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      brokerOverride: "etoro-demo",
      runtimeModeOverride: "demo",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.anything(),
      "test-run",
      expect.objectContaining({ provider: "etoro-demo" }),
    );
  });
});
