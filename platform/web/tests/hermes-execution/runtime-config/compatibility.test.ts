import { describe, expect, it } from "vitest";
import {
  checkMarketDataCompatibility,
  checkModeCompatibility,
  checkPrototypeV1BrokerSupport,
} from "@/lib/hermes-execution/runtime-config/compatibility";
import { SUPPORTED_BROKER_PROVIDERS, SUPPORTED_RUNTIME_MODES, type BrokerProvider, type RuntimeMode } from "@/lib/hermes-execution/config";
import { BROKER_CAPABILITIES } from "@/lib/hermes-execution/runtime-config/broker-capabilities";

describe("checkModeCompatibility — supported combinations", () => {
  for (const provider of SUPPORTED_BROKER_PROVIDERS) {
    for (const mode of BROKER_CAPABILITIES[provider].supportedRuntimeModes) {
      it(`allows ${provider} + ${mode}`, () => {
        expect(checkModeCompatibility(provider, mode)).toBeUndefined();
      });
    }
  }
});

describe("checkModeCompatibility — unsupported combinations", () => {
  const allPairs: Array<[BrokerProvider, RuntimeMode]> = SUPPORTED_BROKER_PROVIDERS.flatMap((provider) =>
    SUPPORTED_RUNTIME_MODES.map((mode) => [provider, mode] as [BrokerProvider, RuntimeMode]),
  );

  for (const [provider, mode] of allPairs) {
    const supported = (BROKER_CAPABILITIES[provider].supportedRuntimeModes as readonly RuntimeMode[]).includes(mode);
    if (supported) continue;
    it(`rejects ${provider} + ${mode}`, () => {
      const problem = checkModeCompatibility(provider, mode);
      expect(problem).toBeDefined();
      expect(problem?.field).toBe("runtimeMode");
      expect(problem?.message).toMatch(new RegExp(provider));
    });
  }

  it("rejects local + demo specifically (an easy real-world misconfiguration)", () => {
    const problem = checkModeCompatibility("local", "demo");
    expect(problem?.message).toMatch(/does not support runtime mode "demo"/);
  });
});

describe("checkMarketDataCompatibility", () => {
  it("mock is always compatible, regardless of broker", () => {
    for (const provider of SUPPORTED_BROKER_PROVIDERS) {
      expect(checkMarketDataCompatibility(provider, "mock")).toBeUndefined();
    }
  });

  it("live is compatible only with etoro-demo", () => {
    expect(checkMarketDataCompatibility("etoro-demo", "live")).toBeUndefined();
  });

  it("live is rejected for every broker that cannot supply live rates", () => {
    for (const provider of ["local", "hyperliquid-testnet", "trading212-demo"] as const) {
      const problem = checkMarketDataCompatibility(provider, "live");
      expect(problem).toBeDefined();
      expect(problem?.field).toBe("marketDataProvider");
      expect(problem?.message).toMatch(/live rates/);
    }
  });
});

describe("checkPrototypeV1BrokerSupport — Trading212 excluded for Prototype V1", () => {
  it("rejects trading212-demo, citing the confirmed order-fill-polling failure", () => {
    const problem = checkPrototypeV1BrokerSupport("trading212-demo");
    expect(problem).toBeDefined();
    expect(problem?.field).toBe("brokerProvider");
    expect(problem?.message).toMatch(/not supported for Prototype V1/);
    expect(problem?.message).toMatch(/404/);
  });

  it("does not affect any other broker", () => {
    for (const provider of ["local", "hyperliquid-testnet", "etoro-demo"] as const) {
      expect(checkPrototypeV1BrokerSupport(provider)).toBeUndefined();
    }
  });
});
