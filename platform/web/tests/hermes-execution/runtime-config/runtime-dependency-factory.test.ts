import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeDependencies } from "@/lib/hermes-execution/runtime-config/runtime-dependency-factory";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";

// Every test in this file exercises only BROKER_PROVIDER=local — zero network I/O
// (LocalPaperBroker touches only the local filesystem via JsonFilePaperBrokerStore, cleaned up
// below). Coverage for etoro-demo's own wiring (which requires a mocked BrokerFactory to avoid a
// real network call) lives in runtime-dependency-factory-etoro.test.ts.

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
};

const PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 10,
  maxPortfolioExposure: 10_000,
};

afterEach(async () => {
  await fs.rm(path.join(process.cwd(), ".data", "hermes-execution"), { recursive: true, force: true });
});

describe("buildRuntimeDependencies — valid local/paper/mock construction", () => {
  it("wires real dependencies end to end with no network I/O", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY });
    const auditTrail = new InMemoryAuditTrail();

    const result = await buildRuntimeDependencies({
      config,
      auditTrail,
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies.broker).toBeInstanceOf(LocalPaperBroker);
    expect(result.dependencies.marketDataProvider).toBeInstanceOf(MockMarketDataProvider);
    expect(result.dependencies.marketHoursPolicy).toBeInstanceOf(AlwaysOpenMarketHoursPolicy);
    expect(result.dependencies.strategy.strategyId).toBe("STRAT-0001");
    expect(result.dependencies.symbol).toBe("BTC");
    expect(result.dependencies.quantity).toBe(10);
  });

  it("honours a configured symbol/quantity", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      HERMES_TRADING_SYMBOL: "eth",
      HERMES_TRADE_QUANTITY: "3.5",
    });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies.symbol).toBe("ETH");
    expect(result.dependencies.quantity).toBe(3.5);
  });

  it("selects a strategy by HERMES_STRATEGY_ID", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      HERMES_STRATEGY_ID: "STRAT-0001",
    });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dependencies.strategy.strategyId).toBe("STRAT-0001");
  });
});

describe("buildRuntimeDependencies — missing registry path", () => {
  it("fails with a registryPath problem, before loading anything", async () => {
    const config = buildHermesExecutionConfig(EMPTY); // registryPath left unset
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.field === "registryPath")).toBe(true);
  });
});

describe("buildRuntimeDependencies — unsupported broker/mode combination", () => {
  it("fails before ever constructing a broker", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      HERMES_RUNTIME_MODE: "demo", // "local" only supports "paper"
    });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.field === "runtimeMode")).toBe(true);

    // No broker was ever constructed, so no .data/hermes-execution state should exist.
    const exists = await fs
      .stat(path.join(process.cwd(), ".data", "hermes-execution"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("buildRuntimeDependencies — unknown strategy", () => {
  it("fails with a strategyId problem", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      HERMES_STRATEGY_ID: "STRAT-9999",
    });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.field === "strategyId")).toBe(true);
  });
});

describe("buildRuntimeDependencies — live provider missing RateSource", () => {
  it("fails with a marketDataProvider problem for local + live, before constructing a broker", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      HERMES_MARKET_DATA_PROVIDER: "live",
    });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.field === "marketDataProvider")).toBe(true);
  });
});

describe("buildRuntimeDependencies — overrides (market-decide.ts's escape hatch)", () => {
  it("brokerOverride/runtimeModeOverride take precedence over config values", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY,
      BROKER_PROVIDER: "local",
    });
    // Overridden to a combination that would otherwise be rejected against a *different* broker,
    // proving the override — not config.brokerProvider — is what gets validated/constructed.
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      brokerOverride: "local",
      runtimeModeOverride: "paper",
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dependencies.broker).toBeInstanceOf(LocalPaperBroker);
  });
});
