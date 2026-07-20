import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, trading212ConnectMock, etoroConnectMock } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  trading212ConnectMock: vi.fn().mockResolvedValue(undefined),
  etoroConnectMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/hermes-execution/hyperliquid/hyperliquid-testnet-broker", () => ({
  HyperliquidTestnetBroker: class MockHyperliquidTestnetBroker {
    connect = connectMock;
  },
}));

vi.mock("@/lib/hermes-execution/trading212/trading212-demo-broker", () => ({
  Trading212DemoBroker: class MockTrading212DemoBroker {
    connect = trading212ConnectMock;
  },
}));

vi.mock("@/lib/hermes-execution/etoro/etoro-demo-broker", () => ({
  EtoroDemoBroker: class MockEtoroDemoBroker {
    connect = etoroConnectMock;
  },
}));

import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";

const EMPTY = {
  HERMES_STRATEGY_REGISTRY_PATH: undefined,
  EXECUTION_MODE: undefined,
  DEMO_EXECUTION_MODE: undefined,
  HERMES_PAPER_STARTING_CASH: undefined,
  HERMES_MAX_OPEN_POSITIONS: undefined,
  BROKER_PROVIDER: undefined,
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

const VALID_KEY = `0x${"1".repeat(64)}`;
const VALID_ADDRESS = `0x${"2".repeat(40)}`;

// LocalPaperBroker's default path in the factory is the real JsonFilePaperBrokerStore (the same
// one the CLI uses) — a genuine, gitignored, harmless local write, cleaned up after each test so
// it never lingers in the repo.
beforeEach(() => {
  connectMock.mockClear();
  trading212ConnectMock.mockClear();
  etoroConnectMock.mockClear();
});

afterEach(async () => {
  await fs.rm(path.join(process.cwd(), ".data", "hermes-execution"), { recursive: true, force: true });
});

describe("BrokerFactory.create — default provider (no explicit override)", () => {
  it("selects LocalPaperBroker when config.brokerProvider is local (the default)", async () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.brokerProvider).toBe("local");

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true });
    expect(broker).toBeInstanceOf(LocalPaperBroker);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("selects HyperliquidTestnetBroker and calls connect() when fully configured via the environment", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_EXECUTION_ENABLED: "true",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
    });

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true });

    expect(broker).not.toBeInstanceOf(LocalPaperBroker);
    expect(connectMock).toHaveBeenCalledOnce();
  });

  it("refuses to build the Hyperliquid broker without the execution-enabled flag, without falling back to local", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_EXECUTION_ENABLED: "false",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
    });

    await expect(
      BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true }),
    ).rejects.toThrow(/HYPERLIQUID_TESTNET_EXECUTION_ENABLED/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("selects Trading212DemoBroker and calls connect() when fully configured via the environment", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "test-key",
      TRADING212_API_SECRET: "test-secret",
      TRADING212_DEMO_EXECUTION_ENABLED: "true",
    });

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true });

    expect(broker).not.toBeInstanceOf(LocalPaperBroker);
    expect(trading212ConnectMock).toHaveBeenCalledOnce();
  });

  it("refuses to build the Trading212 broker without the execution-enabled flag, without falling back to local", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "test-key",
      TRADING212_API_SECRET: "test-secret",
      TRADING212_DEMO_EXECUTION_ENABLED: "false",
    });

    await expect(
      BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true }),
    ).rejects.toThrow(/TRADING212_DEMO_EXECUTION_ENABLED/);
    expect(trading212ConnectMock).not.toHaveBeenCalled();
  });

  it("selects EtoroDemoBroker and calls connect() when fully configured via the environment", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { resetState: true });

    expect(broker).not.toBeInstanceOf(LocalPaperBroker);
    expect(etoroConnectMock).toHaveBeenCalledOnce();
  });

  it("refuses to build the eToro broker without ETORO_ENV=demo, without falling back to local", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    const tampered = { ...config, etoro: { ...config.etoro, env: undefined } };

    await expect(
      BrokerFactory.create(tampered, new InMemoryAuditTrail(), "test-run", { resetState: true }),
    ).rejects.toThrow(/ETORO_ENV=demo/);
    expect(etoroConnectMock).not.toHaveBeenCalled();
  });

  it("refuses to build the eToro broker without both keys, without falling back to local", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    const tampered = { ...config, etoro: { ...config.etoro, userKey: undefined } };

    await expect(
      BrokerFactory.create(tampered, new InMemoryAuditTrail(), "test-run", { resetState: true }),
    ).rejects.toThrow(/ETORO_API_KEY and ETORO_USER_KEY/);
    expect(etoroConnectMock).not.toHaveBeenCalled();
  });
});

describe("BrokerFactory.create — explicit provider override", () => {
  // The core of this refactor: an explicitly supplied provider always wins over
  // config.brokerProvider (the BROKER_PROVIDER environment default), regardless of what the
  // environment says — this is what lets every broker's credentials live in .env.local
  // permanently while each smoke test pins its own broker.

  it("builds the explicitly requested provider even when config.brokerProvider says something else", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "local", // the environment default — deliberately NOT trading212-demo
      TRADING212_API_KEY: "test-key",
      TRADING212_API_SECRET: "test-secret",
      TRADING212_DEMO_EXECUTION_ENABLED: "true",
    });
    expect(config.brokerProvider).toBe("local");

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", {
      provider: "trading212-demo",
    });

    expect(broker).not.toBeInstanceOf(LocalPaperBroker);
    expect(trading212ConnectMock).toHaveBeenCalledOnce();
    expect(etoroConnectMock).not.toHaveBeenCalled();
  });

  it("builds eToro explicitly even when config.brokerProvider says trading212-demo", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "test-key",
      TRADING212_API_SECRET: "test-secret",
      TRADING212_DEMO_EXECUTION_ENABLED: "true",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "test-key",
      ETORO_USER_KEY: "test-user-key",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    expect(config.brokerProvider).toBe("trading212-demo");

    const broker = await BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", {
      provider: "etoro-demo",
    });

    expect(broker).not.toBeInstanceOf(LocalPaperBroker);
    expect(etoroConnectMock).toHaveBeenCalledOnce();
    expect(trading212ConnectMock).not.toHaveBeenCalled();
  });

  it("still enforces the requested provider's own credential requirements even when overridden explicitly", async () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "local",
      TRADING212_DEMO_EXECUTION_ENABLED: "true", // isolates this test to the credential check specifically
    });

    await expect(
      BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", { provider: "trading212-demo" }),
    ).rejects.toThrow(/TRADING212_API_KEY and TRADING212_API_SECRET/);
  });
});

describe("BrokerFactory.create — unsupported provider", () => {
  it("throws a descriptive error listing every supported provider", async () => {
    const config = buildHermesExecutionConfig(EMPTY);

    await expect(
      BrokerFactory.create(config, new InMemoryAuditTrail(), "test-run", {
        provider: "not-a-real-provider" as never,
      }),
    ).rejects.toThrow(/Unsupported broker provider "not-a-real-provider".*local.*hyperliquid-testnet.*trading212-demo.*etoro-demo/);
  });
});
