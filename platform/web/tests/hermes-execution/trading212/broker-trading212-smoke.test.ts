import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

// brokerProvider is deliberately set to a DIFFERENT provider — proves this command never reads it.
vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => ({
    brokerProvider: "etoro-demo",
    trading212: {
      apiKey: "test-key",
      apiSecret: "test-secret",
      executionEnabled: true,
      testInstrument: "AAPL_US_EQ",
      testOrderQuantity: 1,
    },
  }),
}));

import { main } from "@/hermes-execution/broker-trading212-smoke";

describe("broker-trading212-smoke — provider independence", () => {
  beforeEach(() => {
    createMock.mockReset();
    // Rejecting immediately after the first call is enough to end main() early (it's caught by
    // the existing "Step 2: connect" try/catch) — no need to simulate the rest of the lifecycle.
    createMock.mockRejectedValue(new Error("stop-after-broker-factory-call"));
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await fs.rm(path.join(process.cwd(), ".data", "hermes-execution"), { recursive: true, force: true });
  });

  it("always requests the trading212-demo provider from BrokerFactory, even though config.brokerProvider is etoro-demo", async () => {
    await main();
    expect(createMock).toHaveBeenCalledTimes(1);
    const options = createMock.mock.calls[0]?.[3];
    expect(options).toEqual({ provider: "trading212-demo" });
  });
});
