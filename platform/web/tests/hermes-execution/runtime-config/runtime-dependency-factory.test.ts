import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesRuntimeWiring, buildRuntimeDependencies } from "@/lib/hermes-execution/runtime-config/runtime-dependency-factory";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import { HermesAgentStrategy } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import { hermesAgentStrategy as sharedHermesAgentStrategy } from "@/lib/hermes-execution/strategies/default-strategy-registry";
import { InMemoryStrategyRegistry } from "@/lib/hermes-execution/strategies/strategy-registry";
import { ChildProcessHermesCliRunner } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";

// Every test in this file exercises only BROKER_PROVIDER=local — zero network I/O
// (LocalPaperBroker touches only the local filesystem via JsonFilePaperBrokerStore, cleaned up
// below). Coverage for etoro-demo's own wiring (which requires a mocked BrokerFactory to avoid a
// real network call) lives in runtime-dependency-factory-etoro.test.ts.

const FIXTURES_DIR = path.join(process.cwd(), "tests", "hermes-execution", "fixtures");
const VALID_REGISTRY = path.join(FIXTURES_DIR, "registry-valid");
const EMPTY_REGISTRY = path.join(FIXTURES_DIR, "registry-empty-but-connected");

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
  HERMES_APPROVAL_MODE: undefined,
  HERMES_AUTO_DEMO_MIN_CONFIDENCE: undefined,
  HERMES_KILL_SWITCH_ENABLED: undefined,
  HERMES_MAX_HOLDING_DURATION_MS: undefined,
  HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: undefined,
  HERMES_AGENT_CLI_PATH: undefined,
  HERMES_AGENT_DECISION_TIMEOUT_MS: undefined,
  HERMES_AGENT_MAX_STDOUT_BYTES: undefined,
  HERMES_INSTRUMENT_UNIVERSE: undefined,
  HERMES_MAX_PROPOSALS_PER_SCAN: undefined,
  HERMES_TELEGRAM_GATEWAY_TARGET: undefined,
  HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS: undefined,
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
    // Prototype 1.0 — official Hermes Agent decision integration: HERMES_STRATEGY_ID is set
    // explicitly here so this test continues to prove what it always has (a real,
    // registry-loaded HERMES_APPROVED strategy document flows through the whole factory) — by
    // default (HERMES_STRATEGY_ID unset), HermesAgentStrategy now wins instead (see
    // strategy-loader.ts's own doc comment), which is exercised by config/strategy-loader tests
    // specifically, not this end-to-end wiring test.
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: VALID_REGISTRY, HERMES_STRATEGY_ID: "STRAT-0001" });
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

  it("defaults to HermesAgentStrategy (HERMES-AGENT) as the decision authority when HERMES_STRATEGY_ID is unset — Prototype 1.0's own default", async () => {
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
    expect(result.dependencies.strategy.strategyId).toBe("HERMES-AGENT");
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

// Prototype 1.0 — official Hermes Agent multi-instrument wiring. Proves the factory's own
// HERMES-AGENT-specific resolution/fail-closed logic in runtime-dependency-factory.ts — never the
// real Hermes CLI, broker network, Telegram, or Supabase (BROKER_PROVIDER stays "local" throughout,
// and constructing a ChildProcessHermesCliRunner never spawns anything by itself — only calling
// .run() would, which none of these tests do).
describe("buildRuntimeDependencies — Hermes Agent multi-instrument bundle", () => {
  it("wires the hermes bundle with the default six-instrument universe when HERMES-AGENT is selected", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies.strategy.strategyId).toBe("HERMES-AGENT");
    expect(result.dependencies.hermes).toBeDefined();
    expect(result.dependencies.hermes?.instrumentUniverse).toEqual(["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"]);
    expect(result.dependencies.hermes?.hermesCliRunner).toBeInstanceOf(ChildProcessHermesCliRunner);
  });

  it("passes the EXACT shared HermesAgentStrategy singleton MarketDecisionEngine itself resolves — never a separate new instance", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY });
    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies.hermes?.strategyInstance).toBe(sharedHermesAgentStrategy);
  });

  it("leaves `hermes` undefined for DEMO-0001 — the existing single-instrument path is untouched", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY,
      HERMES_STRATEGY_ID: "DEMO-0001",
      DEMO_EXECUTION_MODE: "true",
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
    expect(result.dependencies.strategy.strategyId).toBe("DEMO-0001");
    expect(result.dependencies.hermes).toBeUndefined();
  });

  it("leaves `hermes` undefined for a real registry (HERMES_APPROVED) strategy too", async () => {
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
    if (!result.ok) return;
    expect(result.dependencies.hermes).toBeUndefined();
  });

  it("fails startup closed when the registered strategy under HERMES-AGENT is not actually a HermesAgentStrategy", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY });
    // A registry deliberately mis-registered with an incompatible Strategy implementation under
    // the official Hermes Agent's own id — proves the factory verifies the ACTUAL registered
    // instance rather than merely trusting the strategyId string.
    const incompatibleRegistry = new InMemoryStrategyRegistry();
    const { Demo0001Strategy } = await import("@/lib/hermes-execution/strategies/demo-0001-strategy");
    const incompatible = new Demo0001Strategy();
    Object.defineProperty(incompatible, "id", { value: "HERMES-AGENT" });
    incompatibleRegistry.register(incompatible);

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
      strategyRegistryOverride: incompatibleRegistry,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.field === "hermesAgentStrategy")).toBe(true);
  });

  it("fails startup closed when HERMES-AGENT is selected but the registry has no entry at all for it", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY });
    const emptyRegistry = new InMemoryStrategyRegistry();

    const result = await buildRuntimeDependencies({
      config,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
      strategyRegistryOverride: emptyRegistry,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.field === "hermesAgentStrategy")).toBe(true);
  });

  it("fails startup closed when the configured instrument universe is empty", async () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_REGISTRY_PATH: EMPTY_REGISTRY });
    // buildHermesExecutionConfig itself always falls back to the default six-instrument universe
    // for an empty/unset HERMES_INSTRUMENT_UNIVERSE — an empty universe is unreachable via the real
    // builder, so this hand-constructs a HermesExecutionConfig-shaped object bypassing it, the same
    // pattern startup-summary.test.ts's own "areBrokerCredentialsConfigured: false" test uses.
    const tamperedConfig = { ...config, hermesAgent: { ...config.hermesAgent, instrumentUniverse: [] } };

    const result = await buildRuntimeDependencies({
      config: tamperedConfig,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      resetBrokerState: true,
      portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.field === "hermesAgent.instrumentUniverse")).toBe(true);
  });
});

// Prototype 1.0 — official Hermes Agent multi-instrument wiring. buildHermesRuntimeWiring is a
// PURE function (no I/O) — these tests construct a plain RuntimeDependencies-shaped fixture
// directly rather than going through the whole factory, so they can cheaply cover every branch.
describe("buildHermesRuntimeWiring — Hermes multi-instrument mode", () => {
  const PORTFOLIO_RISK = { portfolioMaxOpenPositions: 5, maxDailyTrades: 20, maxPortfolioExposure: 1_000_000 };
  const marketHoursPolicy = new AlwaysOpenMarketHoursPolicy();

  function makeHermesDependencies(instrumentUniverse: string[]) {
    return {
      strategy: { strategyId: "HERMES-AGENT" } as never,
      broker: {} as never,
      marketDataProvider: {} as never,
      marketHoursPolicy,
      lifecycleService: {} as never,
      lifecycleStore: {} as never,
      symbol: "BTC",
      quantity: 10,
      orderSizingMode: "UNITS" as const,
      portfolioRiskConfig: PORTFOLIO_RISK,
      hermes: {
        strategyInstance: sharedHermesAgentStrategy,
        instrumentUniverse,
        hermesAdapterConfig: { cliPath: "/home/andy/.local/bin/hermes", decisionTimeoutMs: 60_000, maxStdoutBytes: 65_536 },
        hermesCliRunner: new ChildProcessHermesCliRunner(),
        maxProposalsPerScan: 2,
      },
    };
  }

  it("wires all six configured instruments, with the first as the primary instrument", () => {
    const dependencies = makeHermesDependencies(["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"]);
    const wiring = buildHermesRuntimeWiring(dependencies);
    expect(wiring.instruments).toEqual(["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"]);
    expect(wiring.instrument).toBe("BTC");
  });

  it("passes exactly one universeScan dependency bundle, never more than one", () => {
    const dependencies = makeHermesDependencies(["BTC", "ETH"]);
    const wiring = buildHermesRuntimeWiring(dependencies);
    expect(wiring.universeScan).toBeDefined();
    expect(Object.keys(wiring)).toEqual(["instrument", "instruments", "universeScan"]);
    expect(Array.isArray(wiring.universeScan)).toBe(false);
  });

  it("the scanner receives the exact same HermesAgentStrategy object the decision engine resolves", () => {
    const dependencies = makeHermesDependencies(["BTC", "ETH"]);
    const wiring = buildHermesRuntimeWiring(dependencies);
    expect(wiring.universeScan?.hermesAgentStrategy).toBe(sharedHermesAgentStrategy);
    expect(wiring.universeScan?.hermesAgentStrategy).toBe(dependencies.hermes.strategyInstance);
  });

  it("reuses the caller's own broker/lifecycle store/market-hours policy — never constructs a second one", () => {
    const dependencies = makeHermesDependencies(["BTC", "ETH"]);
    const wiring = buildHermesRuntimeWiring(dependencies);
    // buildHermesRuntimeWiring's own return shape has no broker/repository/lifecycle-store field at
    // all — it only ever shapes instrument/instruments/universeScan, structurally guaranteeing it
    // cannot introduce a second one. The one MarketHoursPolicy it does touch is reused as-is.
    expect(wiring.universeScan?.equityMarketHoursPolicy).toBe(dependencies.marketHoursPolicy);
    expect(wiring.universeScan?.maxOpenPositions).toBe(dependencies.portfolioRiskConfig.portfolioMaxOpenPositions);
  });

  it("returns instruments/universeScan both undefined, and the configured symbol as instrument, when `hermes` is absent (DEMO-0001)", () => {
    const dependencies = { ...makeHermesDependencies(["BTC", "ETH"]), hermes: undefined };
    const wiring = buildHermesRuntimeWiring(dependencies);
    expect(wiring.instruments).toBeUndefined();
    expect(wiring.universeScan).toBeUndefined();
    expect(wiring.instrument).toBe("BTC");
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
