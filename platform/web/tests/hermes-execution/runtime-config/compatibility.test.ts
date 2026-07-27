import { describe, expect, it } from "vitest";
import {
  checkApprovalModeCompatibility,
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

// Restart-Resilient Autonomy Phase — AUTO_DEMO startup gate (safety-review hardening pass). Covers
// required scenario: "AUTO_DEMO is rejected for a live-capable or unknown broker," wired at the
// real config/dependency boundary (validateStartup -> buildRuntimeDependencies, called from
// market-runtime.ts before the scheduler ever starts).
describe("checkApprovalModeCompatibility — AUTO_DEMO startup gate", () => {
  it("MANUAL is always compatible, regardless of broker", () => {
    for (const provider of SUPPORTED_BROKER_PROVIDERS) {
      expect(checkApprovalModeCompatibility(provider, "MANUAL")).toBeUndefined();
    }
  });

  it("AUTO_DEMO is accepted for every currently declared broker (none support a live mode)", () => {
    for (const provider of SUPPORTED_BROKER_PROVIDERS) {
      expect(checkApprovalModeCompatibility(provider, "AUTO_DEMO")).toBeUndefined();
    }
  });

  it("AUTO_DEMO is rejected for an unrecognised brokerProvider — fails closed, never silently eligible", () => {
    const problem = checkApprovalModeCompatibility("not-a-real-broker" as BrokerProvider, "AUTO_DEMO");
    expect(problem).toBeDefined();
    expect(problem?.field).toBe("approvalMode");
    expect(problem?.message).toMatch(/no declared BROKER_CAPABILITIES entry/);
  });

  it("never inspects the broker's own name/string (no suffix parsing) — decided purely from BROKER_CAPABILITIES", () => {
    // A provider name that superficially looks demo-like ("-demo" suffix) but is not a real,
    // registered BrokerProvider must still fail closed — proof this check never does
    // brokerProvider.endsWith("-demo")-style string matching.
    const problem = checkApprovalModeCompatibility("looks-like-demo" as BrokerProvider, "AUTO_DEMO");
    expect(problem).toBeDefined();
  });
});
