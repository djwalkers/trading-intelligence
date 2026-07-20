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
    brokerProvider: "trading212-demo",
    etoro: {
      env: "demo",
      apiKey: "test-key",
      userKey: "test-user-key",
      testInstrument: "BTC",
      testAmount: 50,
    },
  }),
}));

import { main } from "@/hermes-execution/broker-etoro-smoke";

describe("broker-etoro-smoke — provider independence", () => {
  beforeEach(() => {
    createMock.mockReset();
    // Rejecting immediately after the first call is enough to end main() early (it's caught by
    // the existing "Stage 2+3: authenticate" try/catch) — no need to simulate the rest of the
    // lifecycle.
    createMock.mockRejectedValue(new Error("stop-after-broker-factory-call"));
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await fs.rm(path.join(process.cwd(), ".data", "hermes-execution"), { recursive: true, force: true });
  });

  it("always requests the etoro-demo provider from BrokerFactory, even though config.brokerProvider is trading212-demo", async () => {
    await main();
    expect(createMock).toHaveBeenCalledTimes(1);
    const options = createMock.mock.calls[0]?.[3];
    expect(options).toEqual({ provider: "etoro-demo" });
  });
});
