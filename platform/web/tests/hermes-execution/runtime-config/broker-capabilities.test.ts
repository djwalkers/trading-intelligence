import { describe, expect, it } from "vitest";
import {
  BROKER_CAPABILITIES,
  brokersWithLiveRateSupport,
  isAutoDemoEligible,
  type BrokerCapabilities,
} from "@/lib/hermes-execution/runtime-config/broker-capabilities";
import { SUPPORTED_BROKER_PROVIDERS } from "@/lib/hermes-execution/config";

describe("BROKER_CAPABILITIES", () => {
  it("declares an entry for every supported broker provider", () => {
    expect(Object.keys(BROKER_CAPABILITIES).sort()).toEqual([...SUPPORTED_BROKER_PROVIDERS].sort());
  });

  it("local supports only paper mode, needs no symbol resolution, and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES.local).toMatchObject({
      supportedRuntimeModes: ["paper"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
      requiredCredentialEnvVars: [],
    });
  });

  it("hyperliquid-testnet supports only testnet mode and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES["hyperliquid-testnet"]).toMatchObject({
      supportedRuntimeModes: ["testnet"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
    });
    expect(BROKER_CAPABILITIES["hyperliquid-testnet"].requiredCredentialEnvVars).toContain("HYPERLIQUID_TESTNET_PRIVATE_KEY");
  });

  it("trading212-demo supports only demo mode and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES["trading212-demo"]).toMatchObject({
      supportedRuntimeModes: ["demo"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
    });
  });

  it("etoro-demo supports only demo mode, requires symbol resolution, and can supply live rates", () => {
    expect(BROKER_CAPABILITIES["etoro-demo"]).toMatchObject({
      supportedRuntimeModes: ["demo"],
      requiresSymbolResolution: true,
      canSupplyLiveRates: true,
    });
    expect(BROKER_CAPABILITIES["etoro-demo"].requiredCredentialEnvVars).toEqual(
      expect.arrayContaining(["ETORO_API_KEY", "ETORO_USER_KEY"]),
    );
  });
});

describe("brokersWithLiveRateSupport", () => {
  it("returns exactly the brokers whose capabilities declare canSupplyLiveRates", () => {
    expect(brokersWithLiveRateSupport()).toEqual(["etoro-demo"]);
  });
});

// Restart-Resilient Autonomy Phase — Phase 5 (AUTO_DEMO). Covers required scenario 13: "AUTO_DEMO
// is rejected for a live-capable or unknown broker."
describe("isAutoDemoEligible", () => {
  it("every currently declared broker capability is AUTO_DEMO-eligible (none support a live mode)", () => {
    for (const capabilities of Object.values(BROKER_CAPABILITIES)) {
      expect(isAutoDemoEligible(capabilities)).toBe(true);
    }
  });

  it("rejects a synthetic broker capability that declares a live-capable runtime mode", () => {
    const liveCapableBroker: BrokerCapabilities = {
      provider: "etoro-demo",
      supportedRuntimeModes: ["live" as never],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
      requiredCredentialEnvVars: [],
      orderSizingMode: "NOTIONAL",
    };
    expect(isAutoDemoEligible(liveCapableBroker)).toBe(false);
  });

  it("rejects a broker capability declaring no runtime modes at all (unknown/unconfigured)", () => {
    const unknownBroker: BrokerCapabilities = {
      provider: "local",
      supportedRuntimeModes: [],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
      requiredCredentialEnvVars: [],
      orderSizingMode: "UNITS",
    };
    expect(isAutoDemoEligible(unknownBroker)).toBe(false);
  });

  it("rejects when even one of several supported modes is live-capable", () => {
    const mixedBroker: BrokerCapabilities = {
      provider: "local",
      supportedRuntimeModes: ["paper", "live" as never],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
      requiredCredentialEnvVars: [],
      orderSizingMode: "UNITS",
    };
    expect(isAutoDemoEligible(mixedBroker)).toBe(false);
  });
});
